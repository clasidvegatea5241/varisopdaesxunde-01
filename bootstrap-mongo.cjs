/**
 * Dual-Mode Bootstrapper (Direct MongoDB Atlas Fallback)
 * 
 * Used by GitHub Actions runners when MSR-Database web host (neonlite.cc)
 * is unreachable, offline, or expired.
 * 
 * Performs:
 * 1. Concurrency jitter (0-20s random stagger)
 * 2. Daily slot rotation computation (11:30 AM IST / 6:00 AM UTC reset)
 * 3. Ephemeral MongoDB Atlas query with automatic retries
 * 4. Immediate connection termination (< 100ms active socket)
 * 5. Generation of .env and runner_env.json for run.sh
 */

const { MongoClient } = require('mongodb');
const fs = require('node:fs');
const path = require('node:path');

// Helper for waiting
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Smart Multi-Cluster Auto-Routing Resolver
 * Determines target MongoDB URI based on Group ID range:
 * - Groups 001 - 100 -> Cluster 1 (MONGODB_URI_1)
 * - Groups 101 - 200 -> Cluster 2 (MONGODB_URI_2)
 * - Groups 201 - 300 -> Cluster 3 (MONGODB_URI_3)
 * Falls back to generic MONGODB_URI if numbered secret is unset.
 */
function resolveMongoUri(groupId, type = 'data') {
    const rawNumber = String(groupId || '001').replace(/\D/g, '');
    const groupNum = parseInt(rawNumber, 10) || 1;
    const prefix = type === 'session' ? 'SESSION_MONGODB_URI' : 'MONGODB_URI';

    // 100 groups per cluster (600 accounts)
    const clusterIndex = Math.floor((groupNum - 1) / 100) + 1;
    const clusterKey = `${prefix}_${clusterIndex}`;

    // 1. Check for specific numbered cluster secret (e.g. MONGODB_URI_1)
    if (process.env[clusterKey] && process.env[clusterKey] !== 'null') {
        return { uri: process.env[clusterKey], clusterIndex, source: clusterKey };
    }

    // 2. Check for general fallback secret (e.g. MONGODB_URI)
    if (process.env[prefix] && process.env[prefix] !== 'null') {
        return { uri: process.env[prefix], clusterIndex, source: prefix };
    }

    // 3. For session type, fallback to data URI if session URI is absent
    if (type === 'session') {
        return resolveMongoUri(groupId, 'data');
    }

    return null;
}

async function main() {
    const rawSlot = process.argv[2] || '1';
    const slot = parseInt(rawSlot, 10);

    if (isNaN(slot) || slot < 1 || slot > 9) {
        console.error(`[bootstrap-mongo] ERROR: Invalid slot "${rawSlot}". Must be between 1 and 9.`);
        process.exit(1);
    }

    const groupId = process.env.GROUP_ID || '001';
    const dataCluster = resolveMongoUri(groupId, 'data');
    const sessionCluster = resolveMongoUri(groupId, 'session');

    if (!dataCluster || !dataCluster.uri) {
        console.error('[bootstrap-mongo] FATAL: Neither MONGODB_URI nor MONGODB_URI_<N> is set.');
        console.error('[bootstrap-mongo] Cannot operate in Direct MongoDB Mode without connection string.');
        process.exit(1);
    }

    const mongoUri = dataCluster.uri;
    const sessionMongoUri = sessionCluster ? sessionCluster.uri : mongoUri;
    const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL || null;

    // 1. High-Concurrency Mitigation: Stagger Jitter (0-20 seconds)
    if (process.env.SKIP_JITTER !== 'true') {
        const jitterMs = Math.floor(Math.random() * 20000);
        console.log(`[bootstrap-mongo] Staggering runner boot by ${(jitterMs / 1000).toFixed(2)}s to protect MongoDB M0 connection pool...`);
        await sleep(jitterMs);
    } else {
        console.log('[bootstrap-mongo] SKIP_JITTER=true detected. Skipping stagger delay.');
    }

    // 2. Resilient MongoDB Connection with Dynamic Rotation Settings Sync
    const maxAttempts = 3;
    let client = null;
    let account = null;
    let group = null;
    let targetSlot = slot;
    let numSlots = parseInt(process.env.ROTATION_SLOTS || '6', 10);
    let currentOffset = 0;
    let isExperimentalSlot = false;
    let experimentalTeam = 'NONE';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            console.log(`[bootstrap-mongo] Connecting to MongoDB Atlas (Attempt ${attempt}/${maxAttempts})...`);
            client = new MongoClient(mongoUri, {
                serverSelectionTimeoutMS: 8000,
                connectTimeoutMS: 8000
            });

            await client.connect();

            // Extract database name from URI if present, otherwise default to 'test'
            let dbName = 'test';
            try {
                const urlParsed = new URL(mongoUri.replace(/^mongodb\+srv:\/\//, 'http://'));
                if (urlParsed.pathname && urlParsed.pathname.length > 1) {
                    dbName = urlParsed.pathname.substring(1).split('?')[0];
                }
            } catch (_) {
                // Keep default 'test'
            }

            const db = client.db(dbName);
            console.log(`[bootstrap-mongo] Connected successfully to database: "${dbName}"`);

            // 2a. Dynamic Fleet-wide Rotation Settings Sync from MongoDB Atlas
            let remoteSlots = null;
            let rotationEnabled = true;
            try {
                const settingDoc = await db.collection('farming_settings').findOne({ key: 'POD_ROTATION_SLOTS' });
                if (settingDoc && settingDoc.value) {
                    remoteSlots = parseInt(settingDoc.value, 10);
                }
                const enabledDoc = await db.collection('farming_settings').findOne({ key: 'POD_ROTATION_ENABLED' });
                if (enabledDoc && (enabledDoc.value === 'false' || enabledDoc.value === false)) {
                    rotationEnabled = false;
                }
            } catch (err) {
                console.warn('[bootstrap-mongo] Note: Unable to read farming_settings from Atlas, using fallback:', err.message);
            }

            if (remoteSlots && !isNaN(remoteSlots)) {
                numSlots = remoteSlots;
            }

            // Query farming_groups for group-level settings and execution_mode
            group = await db.collection('farming_groups').findOne({
                group_id: groupId
            });
            const executionMode = (group && group.execution_mode) || 'DEFAULT';

            // 2b. Mathematical Slot Rotation & Dual Experimental Subsystem
            const OFFSET_MILLIS = 6 * 60 * 60 * 1000;
            const currentDay = Math.floor((Date.now() - OFFSET_MILLIS) / 86400000);

            if (executionMode === '1_DAY_GAP' && slot >= 7 && slot <= 9) {
                // Mode 1: Experimental Circular 1-Day Gap Subsystem (12-Slot Ping-Pong with 48h rest)
                // Team A: Slots 7, 8, 9 (base: 7)
                // Team B: Slots 10, 11, 12 (base: 10)
                // Accounts rotate circularly across repo_7, repo_8, repo_9 every 48h per team
                isExperimentalSlot = true;
                const isTeamBActive = currentDay % 2 === 1;
                experimentalTeam = isTeamBActive ? 'TEAM_B' : 'TEAM_A';
                const cycleShift = Math.floor(currentDay / 2) % 3;
                const runnerIdx = slot - 7;
                const baseSlot = isTeamBActive ? 10 : 7;
                targetSlot = baseSlot + ((runnerIdx + cycleShift) % 3);
                currentOffset = 0; // Decoupled from main sequential cron rotation
            } else if (executionMode === '3_DAY_ROTATION' && slot >= 7 && slot <= 9) {
                // Mode 2: Experimental 3-Day Rotation Subsystem (Slots 7–9 Only)
                // Slots 7, 8, 9 cycle circularly across repo_7, repo_8, repo_9 every 3 days. Slots 10–12 bypassed.
                isExperimentalSlot = true;
                const offset = currentDay % 3;
                const runnerIdx = slot - 7;
                targetSlot = 7 + ((runnerIdx + offset) % 3);
                experimentalTeam = `3-Day Cycle (Offset +${offset})`;
                currentOffset = 0;
            } else if (executionMode === '3_DAY_ROTATION' && slot >= 10) {
                // In 3-Day Rotation mode, Slots 10, 11, 12 are strictly dormant and bypassed
                console.warn(`[bootstrap-mongo] ⚠️ Runner assigned Slot ${slot} is bypassed in 3-Day Rotation mode (only Slots 7–9 are active).`);
                console.warn('[bootstrap-mongo] Slot is dormant/inactive. Creating placeholder and exiting safely.');
                await client.close();
                fs.writeFileSync('.env', '# Slot dormant/inactive in 3-Day Rotation mode\n');
                fs.writeFileSync('runner_env.json', JSON.stringify({ inactive: true, slot, reason: 'slot_bypassed_in_3_day_rotation' }, null, 2));
                process.exit(0);
            } else if (slot > numSlots) {
                // Standard Dormancy Guard for sequentially rotated slots
                console.warn(`[bootstrap-mongo] ⚠️ Runner assigned Slot ${slot} exceeds active rotation slot capacity (${numSlots}).`);
                console.warn('[bootstrap-mongo] Slot is currently dormant/inactive. Creating placeholder and exiting safely.');
                await client.close();
                fs.writeFileSync('.env', '# Slot dormant/inactive\n');
                fs.writeFileSync('runner_env.json', JSON.stringify({ inactive: true, slot, reason: 'slot_dormant' }, null, 2));
                process.exit(0);
            } else {
                // Standard Mathematical Slot Rotation (Anchor: 11:30 AM IST / 6:00 AM UTC)
                currentOffset = rotationEnabled ? (currentDay % numSlots) : 0;
                targetSlot = ((slot - 1 + currentOffset) % numSlots) + 1;
            }

            console.log('=====================================================');
            console.log('  Dual-Mode Bootstrapper (Direct MongoDB Mode)');
            console.log(`  Group ID             : ${groupId}`);
            console.log(`  Cluster Partition    : Cluster ${dataCluster.clusterIndex} (via ${dataCluster.source})`);
            if (sessionCluster && sessionCluster.source !== dataCluster.source) {
                console.log(`  Session Partition    : Cluster ${sessionCluster.clusterIndex} (via ${sessionCluster.source})`);
            }
            console.log(`  Runner Assigned Slot : SLOT ${slot}`);
            console.log(`  Rotation Capacity    : ${numSlots} Slots (${remoteSlots ? 'Atlas Synced' : 'Env Fallback'})`);
            console.log(`  Group Execution Mode : ${executionMode}`);
            if (isExperimentalSlot) {
                if (executionMode === '1_DAY_GAP') {
                    const cycleShift = Math.floor(currentDay / 2) % 3;
                    console.log(`  Subsystem Mode       : 🧪 Experimental 1-Day Gap (${experimentalTeam}, Shift +${cycleShift})`);
                } else if (executionMode === '3_DAY_ROTATION') {
                    const offset = currentDay % 3;
                    console.log(`  Subsystem Mode       : 🧪 Experimental 3-Day Rotation (Offset +${offset})`);
                }
                console.log(`  Target Account Slot  : SLOT ${targetSlot} (Circularly routed from Runner Slot ${slot})`);
            } else {
                console.log(`  Daily Rotation Offset: +${currentOffset} (${rotationEnabled ? 'ENABLED' : 'DISABLED'})`);
                console.log(`  Actual Target Slot   : SLOT ${targetSlot}`);
            }
            console.log('=====================================================');

            // Query farming_accounts for this group and rotated slot
            account = await db.collection('farming_accounts').findOne({
                group_id: groupId,
                slot: targetSlot
            });

            // Instant disconnect to release socket back to M0 pool immediately
            await client.close();
            client = null;
            console.log('[bootstrap-mongo] Successfully fetched data and closed MongoDB connection.');
            break;
        } catch (err) {
            console.error(`[bootstrap-mongo] Warning: Connection attempt ${attempt} failed: ${err.message}`);
            if (client) {
                try { await client.close(); } catch (_) {}
                client = null;
            }

            if (attempt === maxAttempts) {
                console.error('[bootstrap-mongo] FATAL: All MongoDB connection attempts exhausted.');
                process.exit(1);
            }

            const backoffMs = attempt * 3000;
            console.log(`[bootstrap-mongo] Retrying in ${backoffMs / 1000}s...`);
            await sleep(backoffMs);
        }
    }

    // 4. Handle Case When Group or Account is Inactive or Not Configured
    if (group && (group.is_active === 0 || group.is_active === '0' || group.is_active === false)) {
        console.warn(`[bootstrap-mongo] ⚠️ Group "${groupId}" is marked INACTIVE in MSR-Database.`);
        console.warn('[bootstrap-mongo] Creating placeholder files and gracefully skipping execution.');
        fs.writeFileSync('.env', '# Group marked inactive\n');
        fs.writeFileSync('runner_env.json', JSON.stringify({ inactive: true, group_is_active: false, reason: 'group_disabled' }, null, 2));
        process.exit(0);
    }

    if (!account) {
        console.warn(`[bootstrap-mongo] ⚠️ No account found in group "${groupId}" for Slot ${targetSlot}.`);
        console.warn('[bootstrap-mongo] Creating a placeholder .env to prevent workflow failure.');
        fs.writeFileSync('.env', '# No account configured for this slot\n');
        fs.writeFileSync('runner_env.json', JSON.stringify({ empty: true, slot: targetSlot }, null, 2));
        process.exit(0);
    }

    if (account.is_active === 0 || account.is_active === '0' || account.is_active === false) {
        console.warn(`[bootstrap-mongo] ⚠️ Account for Slot ${targetSlot} (${account.email}) is marked INACTIVE.`);
        fs.writeFileSync('.env', '# Account marked inactive\n');
        fs.writeFileSync('runner_env.json', JSON.stringify({ inactive: true, slot: targetSlot, email: account.email }, null, 2));
        process.exit(0);
    }

    // 5. Generate .env File (Formatting as ACCOUNT_1_* so bot treats it as primary)
    const envLines = [];
    envLines.push(`ACCOUNT_1_EMAIL=${account.email || ''}`);
    envLines.push(`ACCOUNT_1_PASSWORD=${account.password || ''}`);
    envLines.push(`ACCOUNT_1_TOTP_SECRET=${account.totp_secret || ''}`);
    envLines.push(`ACCOUNT_1_RECOVERY_EMAIL=${account.recovery_email || ''}`);
    envLines.push(`ACCOUNT_1_GEO_LOCALE=${account.geo_locale || 'auto'}`);
    envLines.push(`ACCOUNT_1_LANG_CODE=${account.lang_code || 'en'}`);
    envLines.push(`ACCOUNT_1_PROXY_HTTP=${account.proxy_http || 'false'}`);
    envLines.push(`ACCOUNT_1_PROXY_URL=${account.proxy_url || ''}`);
    envLines.push(`ACCOUNT_1_PROXY_PORT=${account.proxy_port !== null && account.proxy_port !== undefined ? account.proxy_port : ''}`);
    envLines.push(`ACCOUNT_1_PROXY_USERNAME=${account.proxy_username || ''}`);
    envLines.push(`ACCOUNT_1_PROXY_PASSWORD=${account.proxy_password || ''}`);
    envLines.push(`ACCOUNT_1_SAVE_FINGERPRINT_MOBILE=${account.save_fingerprint_mobile || '0'}`);
    envLines.push(`ACCOUNT_1_SAVE_FINGERPRINT_DESKTOP=${account.save_fingerprint_desktop || '0'}`);

    // Session Wrapper MongoDB URI
    if (sessionMongoUri && sessionMongoUri !== 'null') {
        envLines.push(`SESSION_MONGODB_URI=${sessionMongoUri}`);
    }

    // Discord Webhook
    if (discordWebhookUrl && discordWebhookUrl !== 'null') {
        envLines.push(`CONFIG_DISCORD_ENABLED=true`);
        envLines.push(`CONFIG_DISCORD_URL=${discordWebhookUrl}`);
    }

    fs.writeFileSync('.env', envLines.join('\n') + '\n');
    console.log(`[bootstrap-mongo] ✅ Generated .env for account: ${account.email}`);

    // 6. Generate runner_env.json (Preserves run.sh overrides compatibility)
    const dockerOverride = account.dockerfile_override || account.docker_image || group?.dockerfile_override || group?.docker_image || null;
    const configOverride = account.config_override || group?.config_override || null;

    const runnerEnvPayload = {
        group_mode: group?.execution_mode || 'DEFAULT',
        discord_webhook_url: discordWebhookUrl,
        session_mongodb_uri: sessionMongoUri,
        rotation_slots: numSlots,
        target_slot: targetSlot,
        experimental_mode: isExperimentalSlot,
        experimental_team: experimentalTeam,
        [`account_${slot}`]: account.email,
        [`docker_override_${slot}`]: dockerOverride,
        [`config_override_${slot}`]: configOverride
    };

    fs.writeFileSync('runner_env.json', JSON.stringify(runnerEnvPayload, null, 2));
    console.log('[bootstrap-mongo] ✅ Generated runner_env.json with slot overrides.');

    console.log('=====================================================');
    console.log(`  Successfully loaded Slot ${targetSlot} (${account.email})`);
    console.log('=====================================================');
}

main().catch((err) => {
    console.error('[bootstrap-mongo] Uncaught Exception:', err);
    process.exit(1);
});
