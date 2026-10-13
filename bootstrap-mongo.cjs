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

    if (isNaN(slot) || slot < 1 || slot > 6) {
        console.error(`[bootstrap-mongo] ERROR: Invalid slot "${rawSlot}". Must be between 1 and 6.`);
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

    // 2. Mathematical Slot Rotation (Matches MSR-Database runner-env logic exactly)
    // Daily cutoff occurs at 11:30 AM IST (6:00 AM UTC).
    // Subtract 6 hours so morning UTC runs don't prematurely advance to tomorrow.
    const OFFSET_MILLIS = 6 * 60 * 60 * 1000;
    const currentDay = Math.floor((Date.now() - OFFSET_MILLIS) / 86400000);
    const numSlots = 6;
    const currentOffset = currentDay % numSlots;
    const targetSlot = ((slot - 1 + currentOffset) % numSlots) + 1;

    console.log('=====================================================');
    console.log('  Dual-Mode Bootstrapper (Direct MongoDB Mode)');
    console.log(`  Group ID             : ${groupId}`);
    console.log(`  Cluster Partition    : Cluster ${dataCluster.clusterIndex} (via ${dataCluster.source})`);
    if (sessionCluster && sessionCluster.source !== dataCluster.source) {
        console.log(`  Session Partition    : Cluster ${sessionCluster.clusterIndex} (via ${sessionCluster.source})`);
    }
    console.log(`  Runner Assigned Slot : SLOT ${slot}`);
    console.log(`  Daily Rotation Offset: +${currentOffset}`);
    console.log(`  Actual Target Slot   : SLOT ${targetSlot}`);
    console.log('=====================================================');

    // 3. Resilient MongoDB Connection with Retry Loop
    const maxAttempts = 3;
    let client = null;
    let account = null;
    let group = null;

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

            // Query farming_accounts for this group and rotated slot
            account = await db.collection('farming_accounts').findOne({
                group_id: groupId,
                slot: targetSlot
            });

            // Query farming_groups for group-level settings
            group = await db.collection('farming_groups').findOne({
                group_id: groupId
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
