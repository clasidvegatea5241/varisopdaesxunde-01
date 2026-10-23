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
const https = require('node:https');

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

// Extract database name from URI if present, otherwise default to 'test'
function extractDbName(uri) {
    try {
        const urlParsed = new URL(uri.replace(/^mongodb\+srv:\/\//, 'http://'));
        if (urlParsed.pathname && urlParsed.pathname.length > 1) {
            return urlParsed.pathname.substring(1).split('?')[0];
        }
    } catch (_) {}
    return 'test';
}

// Escape special regex characters in email strings
function escapeRegex(str) {
    return String(str).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Helper to send Discord webhook embed natively
function sendDiscordEmbed(webhookUrl, payload) {
    if (!webhookUrl || webhookUrl === 'null' || typeof webhookUrl !== 'string') return Promise.resolve();
    return new Promise((resolve) => {
        try {
            const url = new URL(webhookUrl);
            const data = JSON.stringify(payload);
            const req = https.request({
                hostname: url.hostname,
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                }
            }, (res) => {
                res.resume();
                resolve();
            });

            req.on('error', (e) => {
                console.warn('[bootstrap-mongo] Discord webhook request error:', e.message);
                resolve();
            });

            req.write(data);
            req.end();
        } catch (e) {
            console.warn('[bootstrap-mongo] Failed to format Discord webhook:', e.message);
            resolve();
        }
    });
}

// Fetch dynamic streak guard settings from farming_settings in Atlas
async function getStreakSettings(db) {
    const settings = {
        maxStreakDays: 12,
        minRestHours: 48,
        autoSubstitutionEnabled: true,
        allowEmptySlotsOnFatigue: false
    };

    try {
        const col = db.collection('farming_settings');
        const maxDoc = await col.findOne({ key: 'STREAK_MAX_DAYS' });
        if (maxDoc && maxDoc.value) {
            const val = parseInt(maxDoc.value, 10);
            if (!isNaN(val) && val >= 6) settings.maxStreakDays = val;
        }

        const restDoc = await col.findOne({ key: 'STREAK_REST_HOURS' });
        if (restDoc && restDoc.value) {
            const val = parseInt(restDoc.value, 10);
            if (!isNaN(val) && val >= 12) settings.minRestHours = val;
        }

        const autoDoc = await col.findOne({ key: 'STREAK_AUTO_SUBSTITUTION' });
        if (autoDoc && (autoDoc.value === 'false' || autoDoc.value === false)) {
            settings.autoSubstitutionEnabled = false;
        }

        const emptyDoc = await col.findOne({ key: 'STREAK_ALLOW_EMPTY_SLOTS' });
        if (emptyDoc && (emptyDoc.value === 'true' || emptyDoc.value === true)) {
            settings.allowEmptySlotsOnFatigue = true;
        }
    } catch (err) {
        console.warn('[bootstrap-mongo] Note: Unable to read streak settings from Atlas, using defaults:', err.message);
    }

    return settings;
}

// Calculate active consecutive streak days from runner_ip_logs across IP clusters
async function calculateStreakForAccount(email) {
    const cleanEmail = (email || '').trim().toLowerCase();
    if (!cleanEmail) return 0;

    try {
        const dateSet = new Set();
        // Query IP clusters (1 to 10)
        for (let c = 1; c <= 10; c++) {
            const ipKey = `IP_MONGODB_URI_${c}`;
            const dataKey = `MONGODB_URI_${c}`;
            const uri = process.env[ipKey] || (c === 1 ? process.env.IP_MONGODB_URI : null) || process.env[dataKey] || (c === 1 ? process.env.MONGODB_URI : null);
            if (!uri || uri === 'null') continue;

            let ipClient = null;
            try {
                ipClient = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
                await ipClient.connect();
                const ipDb = ipClient.db(extractDbName(uri));
                const col = ipDb.collection('runner_ip_logs');
                const dates = await col.distinct('rotation_date', {
                    email: { $regex: new RegExp(`^${escapeRegex(cleanEmail)}$`, 'i') }
                });
                if (dates && Array.isArray(dates)) {
                    dates.forEach(d => {
                        if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
                            dateSet.add(d);
                        }
                    });
                }
                await ipClient.close();
            } catch (_) {
                if (ipClient) { try { await ipClient.close(); } catch (_) {} }
            }
        }

        if (dateSet.size === 0) return 0;

        const validDates = Array.from(dateSet).sort((a, b) => b.localeCompare(a));
        if (validDates.length === 0) return 0;

        // If latest run was > 2 days ago, streak has broken and reset to 0
        const latestRunDate = new Date(validDates[0] + 'T00:00:00Z');
        const now = new Date();
        const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const daysSinceLastRun = Math.round((todayUTC.getTime() - latestRunDate.getTime()) / (1000 * 3600 * 24));
        if (daysSinceLastRun > 2) {
            return 0;
        }

        let streak = 0;
        let prevDate = null;
        for (const dateStr of validDates) {
            const currentDate = new Date(dateStr + 'T00:00:00Z');
            if (isNaN(currentDate.getTime())) continue;

            if (prevDate === null) {
                streak = 1;
                prevDate = currentDate;
            } else {
                const diffTime = prevDate.getTime() - currentDate.getTime();
                const diffDays = Math.round(diffTime / (1000 * 3600 * 24));

                if (diffDays === 1) {
                    streak++;
                    prevDate = currentDate;
                } else if (diffDays === 0) {
                    continue;
                } else {
                    break;
                }
            }
        }
        return streak;
    } catch (err) {
        console.warn(`[bootstrap-mongo] Warning: Streak calculation error for ${cleanEmail}:`, err.message);
        return 0;
    }
}

// Atomically update session_registry coordinates across session clusters
async function updateSessionRegistryLocation(email, targetGroupId, targetSlot) {
    if (!email) return false;
    const cleanEmail = email.trim();
    for (let c = 1; c <= 10; c++) {
        const sessionKey = `SESSION_MONGODB_URI_${c}`;
        const dataKey = `MONGODB_URI_${c}`;
        const uri = process.env[sessionKey] || (c === 1 ? process.env.SESSION_MONGODB_URI : null) || process.env[dataKey] || (c === 1 ? process.env.MONGODB_URI : null);
        if (!uri || uri === 'null') continue;

        let sClient = null;
        try {
            sClient = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
            await sClient.connect();
            const sDb = sClient.db(extractDbName(uri));
            const regCol = sDb.collection('session_registry');
            const emailRegex = new RegExp(`^${escapeRegex(cleanEmail)}$`, 'i');

            const existing = await regCol.findOne({ email: emailRegex });
            if (existing) {
                await regCol.updateOne(
                    { _id: existing._id },
                    {
                        $set: {
                            current_group_id: String(targetGroupId).padStart(3, '0'),
                            current_slot: Number(targetSlot),
                            updated_at: new Date().toISOString()
                        }
                    }
                );
                console.log(`[bootstrap-mongo] 🎯 Aligned session_registry for ${cleanEmail} -> Group ${targetGroupId}, Slot ${targetSlot} (Cluster ${c})`);
                await sClient.close();
                return true;
            }
            await sClient.close();
        } catch (_) {
            if (sClient) { try { await sClient.close(); } catch (_) {} }
        }
    }
    return false;
}

// Autonomous Vacant Slot Auto-Fill from Streak Archive
async function autoFillVacantSlot(db, groupId, targetSlot, dataCluster, discordWebhookUrl) {
    try {
        const now = Date.now();
        const archiveCol = db.collection('streak_archive_accounts');

        // Query eligible rested accounts from local cluster
        const eligibleAccounts = await archiveCol.find({
            $or: [
                { ready_at: { $lte: now } },
                { status: 'READY' }
            ]
        }).sort({ archived_at: 1 }).toArray();

        let matchedAccount = null;

        if (eligibleAccounts && eligibleAccounts.length > 0) {
            const local = eligibleAccounts.find(a => (a.cluster_origin || 1) === dataCluster.clusterIndex);
            const target = local || eligibleAccounts[0];
            const claimed = await archiveCol.findOneAndDelete({ _id: target._id });
            matchedAccount = claimed ? (claimed.value || claimed) : null;
        }

        // Cross-cluster search if none found in local database
        if (!matchedAccount) {
            for (let c = 1; c <= 10; c++) {
                if (c === dataCluster.clusterIndex) continue;
                const cKey = `MONGODB_URI_${c}`;
                const cUri = process.env[cKey];
                if (!cUri || cUri === 'null') continue;

                let cClient = null;
                try {
                    cClient = new MongoClient(cUri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
                    await cClient.connect();
                    const cDb = cClient.db(extractDbName(cUri));
                    const cCol = cDb.collection('streak_archive_accounts');
                    const crossEligible = await cCol.find({
                        $or: [
                            { ready_at: { $lte: now } },
                            { status: 'READY' }
                        ]
                    }).sort({ archived_at: 1 }).limit(1).toArray();

                    if (crossEligible && crossEligible.length > 0) {
                        const claimed = await cCol.findOneAndDelete({ _id: crossEligible[0]._id });
                        if (claimed) {
                            matchedAccount = claimed.value || claimed;
                            await cClient.close();
                            break;
                        }
                    }
                    await cClient.close();
                } catch (_) {
                    if (cClient) { try { await cClient.close(); } catch (_) {} }
                }
            }
        }

        if (!matchedAccount || !matchedAccount.email) {
            console.log(`[bootstrap-mongo] No rested bench accounts available to auto-fill Slot ${targetSlot}.`);
            return null;
        }

        console.log(`[bootstrap-mongo] ✨ Claimed rested bench account: ${matchedAccount.email} (Cluster Origin: ${matchedAccount.cluster_origin || 1})`);

        // Format document for farming_accounts
        const newFarmingDoc = {
            group_id: String(groupId),
            slot: Number(targetSlot),
            email: matchedAccount.email,
            password: matchedAccount.password || null,
            totp_secret: matchedAccount.totp_secret || null,
            recovery_email: matchedAccount.recovery_email || null,
            geo_locale: matchedAccount.geo_locale || 'auto',
            lang_code: matchedAccount.lang_code || 'en',
            proxy_http: matchedAccount.proxy_http || 'false',
            proxy_url: matchedAccount.proxy_url || null,
            proxy_port: matchedAccount.proxy_port || null,
            proxy_username: matchedAccount.proxy_username || null,
            proxy_password: matchedAccount.proxy_password || null,
            docker_image: matchedAccount.docker_image || null,
            config_override: matchedAccount.config_override || null,
            dockerfile_override: matchedAccount.dockerfile_override || null,
            script_override: matchedAccount.script_override || null,
            is_active: 1,
            last_run: null,
            last_status: 'Bench Injected',
            total_points: 0,
            updated_at: new Date().toISOString()
        };

        await db.collection('farming_accounts').updateOne(
            { group_id: String(groupId), slot: Number(targetSlot) },
            { $set: newFarmingDoc },
            { upsert: true }
        );

        await updateSessionRegistryLocation(matchedAccount.email, groupId, targetSlot);

        if (discordWebhookUrl) {
            await sendDiscordEmbed(discordWebhookUrl, {
                embeds: [{
                    title: '✨ Autonomous Slot Auto-Fill (Direct Mode)',
                    description: `Successfully filled vacant **Slot ${targetSlot}** in **Group ${groupId}** with rested bench account.`,
                    color: 0x10b981, // Emerald
                    fields: [
                        { name: 'Injected Account', value: `\`${matchedAccount.email}\``, inline: true },
                        { name: 'Target Slot', value: `Group ${groupId} • Slot ${targetSlot}`, inline: true },
                        { name: 'Origin Cluster', value: `Cluster ${matchedAccount.cluster_origin || 1}`, inline: true }
                    ],
                    footer: { text: 'MSR Autonomous Edge Agent' },
                    timestamp: new Date().toISOString()
                }]
            });
        }

        return newFarmingDoc;
    } catch (err) {
        console.error('[bootstrap-mongo] Error during autonomous vacant slot auto-fill:', err.message);
        return null;
    }
}

// Autonomous Streak Fatigue Swap with Rested Substitute
async function executeAutonomousStreakSwap(db, groupId, targetSlot, currentAccount, streak, dataCluster, streakSettings, discordWebhookUrl) {
    try {
        const now = Date.now();
        const restHours = streakSettings.minRestHours || 48;
        const readyAt = now + restHours * 3600000;
        const archiveCol = db.collection('streak_archive_accounts');

        // Check prior lifetime vacations
        let lifetimeVacations = 0;
        try {
            const prev = await archiveCol.findOne({ email: new RegExp(`^${escapeRegex(currentAccount.email)}$`, 'i') });
            if (prev && prev.total_lifetime_vacations) {
                lifetimeVacations = Number(prev.total_lifetime_vacations);
            }
        } catch (_) {}

        // 1. Move fatigued account to streak_archive_accounts
        const archiveDoc = {
            email: currentAccount.email,
            password: currentAccount.password || null,
            totp_secret: currentAccount.totp_secret || null,
            recovery_email: currentAccount.recovery_email || null,
            geo_locale: currentAccount.geo_locale || null,
            lang_code: currentAccount.lang_code || null,
            proxy_http: currentAccount.proxy_http || null,
            proxy_url: currentAccount.proxy_url || null,
            proxy_port: currentAccount.proxy_port || null,
            proxy_username: currentAccount.proxy_username || null,
            proxy_password: currentAccount.proxy_password || null,
            docker_image: currentAccount.docker_image || null,
            config_override: currentAccount.config_override || null,
            dockerfile_override: currentAccount.dockerfile_override || null,
            script_override: currentAccount.script_override || null,
            archived_from_group: String(groupId),
            archived_from_slot: Number(targetSlot),
            cluster_origin: dataCluster.clusterIndex || 1,
            archived_at: now,
            rest_duration_hours_required: restHours,
            ready_at: readyAt,
            status: 'RESTING',
            last_streak_days: streak,
            total_lifetime_vacations: lifetimeVacations + 1,
            notes: `Autonomous Fatigue Vacation from Direct MongoDB Boot (${streak} streak days)`
        };

        await archiveCol.updateOne(
            { email: currentAccount.email },
            { $set: archiveDoc },
            { upsert: true }
        );
        console.log(`[bootstrap-mongo] 🌙 Benched fatigued account ${currentAccount.email} (${streak} streak days) for ${restHours}h mandatory rest.`);

        // 2. Search for an eligible rested substitute
        const eligibleAccounts = await archiveCol.find({
            email: { $ne: currentAccount.email },
            $or: [
                { ready_at: { $lte: now } },
                { status: 'READY' }
            ]
        }).sort({ archived_at: 1 }).toArray();

        let substitute = null;
        if (eligibleAccounts && eligibleAccounts.length > 0) {
            const local = eligibleAccounts.find(a => (a.cluster_origin || 1) === dataCluster.clusterIndex);
            const target = local || eligibleAccounts[0];
            const claimed = await archiveCol.findOneAndDelete({ _id: target._id });
            substitute = claimed ? (claimed.value || claimed) : null;
        }

        // Cross-cluster search if none found in local database
        if (!substitute) {
            for (let c = 1; c <= 10; c++) {
                if (c === dataCluster.clusterIndex) continue;
                const cKey = `MONGODB_URI_${c}`;
                const cUri = process.env[cKey];
                if (!cUri || cUri === 'null') continue;

                let cClient = null;
                try {
                    cClient = new MongoClient(cUri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
                    await cClient.connect();
                    const cDb = cClient.db(extractDbName(cUri));
                    const cCol = cDb.collection('streak_archive_accounts');
                    const crossEligible = await cCol.find({
                        email: { $ne: currentAccount.email },
                        $or: [
                            { ready_at: { $lte: now } },
                            { status: 'READY' }
                        ]
                    }).sort({ archived_at: 1 }).limit(1).toArray();

                    if (crossEligible && crossEligible.length > 0) {
                        const claimed = await cCol.findOneAndDelete({ _id: crossEligible[0]._id });
                        if (claimed) {
                            substitute = claimed.value || claimed;
                            await cClient.close();
                            break;
                        }
                    }
                    await cClient.close();
                } catch (_) {
                    if (cClient) { try { await cClient.close(); } catch (_) {} }
                }
            }
        }

        if (substitute && substitute.email) {
            console.log(`[bootstrap-mongo] 🔄 Found rested bench substitute: ${substitute.email} (Cluster ${substitute.cluster_origin || 1})`);

            const newFarmingDoc = {
                group_id: String(groupId),
                slot: Number(targetSlot),
                email: substitute.email,
                password: substitute.password || null,
                totp_secret: substitute.totp_secret || null,
                recovery_email: substitute.recovery_email || null,
                geo_locale: substitute.geo_locale || 'auto',
                lang_code: substitute.lang_code || 'en',
                proxy_http: substitute.proxy_http || 'false',
                proxy_url: substitute.proxy_url || null,
                proxy_port: substitute.proxy_port || null,
                proxy_username: substitute.proxy_username || null,
                proxy_password: substitute.proxy_password || null,
                docker_image: substitute.docker_image || null,
                config_override: substitute.config_override || null,
                dockerfile_override: substitute.dockerfile_override || null,
                script_override: substitute.script_override || null,
                is_active: 1,
                last_run: null,
                last_status: 'Bench Substituted',
                total_points: 0,
                updated_at: new Date().toISOString()
            };

            await db.collection('farming_accounts').updateOne(
                { group_id: String(groupId), slot: Number(targetSlot) },
                { $set: newFarmingDoc },
                { upsert: true }
            );

            await updateSessionRegistryLocation(substitute.email, groupId, targetSlot);

            if (discordWebhookUrl) {
                await sendDiscordEmbed(discordWebhookUrl, {
                    embeds: [{
                        title: '🔄 Autonomous Streak Swap (Direct Mode)',
                        description: `Fatigued account benched and successfully replaced with rested substitute in **Group ${groupId} • Slot ${targetSlot}**.`,
                        color: 0x8b5cf6, // Purple
                        fields: [
                            { name: 'Benched Account', value: `\`${currentAccount.email}\` (${streak} streak days)`, inline: false },
                            { name: 'Injected Substitute', value: `\`${substitute.email}\``, inline: true },
                            { name: 'Vacation Duration', value: `${restHours} Hours (${Math.round(restHours / 24)} Days)`, inline: true }
                        ],
                        footer: { text: 'MSR Autonomous Edge Agent' },
                        timestamp: new Date().toISOString()
                    }]
                });
            }

            return { substituted: true, account: newFarmingDoc };
        } else {
            console.warn(`[bootstrap-mongo] ⚠️ Bench reserve depleted! 0 rested accounts available for substitution.`);

            if (streakSettings.allowEmptySlotsOnFatigue) {
                console.log(`[bootstrap-mongo] allowEmptySlotsOnFatigue=true. Removing fatigued account and leaving Slot ${targetSlot} vacant.`);
                await db.collection('farming_accounts').updateOne(
                    { group_id: String(groupId), slot: Number(targetSlot) },
                    { $set: { email: '', is_active: 0, last_status: 'Vacation (Bench Exhausted)' } }
                );

                if (discordWebhookUrl) {
                    await sendDiscordEmbed(discordWebhookUrl, {
                        embeds: [{
                            title: '⚠️ Autonomous Streak Vacation (Bench Depleted)',
                            description: `Account \`${currentAccount.email}\` (${streak} days) sent to vacation. **Slot ${targetSlot} left empty** because 0 rested substitutes were ready.`,
                            color: 0xf59e0b, // Amber
                            footer: { text: 'MSR Autonomous Edge Agent' },
                            timestamp: new Date().toISOString()
                        }]
                    });
                }

                return { substituted: false, account: null, empty: true };
            } else {
                console.log(`[bootstrap-mongo] allowEmptySlotsOnFatigue=false. Preserving active account ${currentAccount.email} as fallback.`);
                if (discordWebhookUrl) {
                    await sendDiscordEmbed(discordWebhookUrl, {
                        embeds: [{
                            title: '⚠️ Fatigue Warning: Bench Reserves Depleted',
                            description: `Account \`${currentAccount.email}\` reached **${streak} streak days**, but 0 rested bench accounts are ready. **Preserving account active as fallback.**`,
                            color: 0xf59e0b,
                            footer: { text: 'MSR Autonomous Edge Agent' },
                            timestamp: new Date().toISOString()
                        }]
                    });
                }
                return { substituted: false, account: currentAccount };
            }
        }
    } catch (err) {
        console.error('[bootstrap-mongo] Error during autonomous streak swap:', err.message);
        return { substituted: false, account: currentAccount };
    }
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

            // Query farming_accounts for this group and rotated slot (supporting integer or string slot types)
            account = await db.collection('farming_accounts').findOne({
                group_id: groupId,
                $or: [{ slot: targetSlot }, { slot: String(targetSlot) }]
            });

            // 2c. Autonomous Edge Streak Guard & Bench Auto-Fill Engine (Direct MongoDB Mode)
            const streakSettings = await getStreakSettings(db);

            // Gate A: Vacant Slot Auto-Fill from Streak Archive Bench
            if (!account || !account.email || typeof account.email !== 'string' || account.email.trim() === '') {
                console.log(`[bootstrap-mongo] 🔍 Slot ${targetSlot} in Group ${groupId} is vacant. Searching Streak Archive for rested accounts...`);
                const autoFilled = await autoFillVacantSlot(db, groupId, targetSlot, dataCluster, discordWebhookUrl);
                if (autoFilled) {
                    account = autoFilled;
                    console.log(`[bootstrap-mongo] ✅ Auto-filled Slot ${targetSlot} with rested bench account: ${account.email}`);
                }
            } else if (streakSettings.autoSubstitutionEnabled) {
                // Gate B: Occupied Slot Streak Fatigue Check & Substitution
                const streak = await calculateStreakForAccount(account.email);
                console.log(`[bootstrap-mongo] 📊 Account ${account.email} current streak: ${streak} days (Threshold: ${streakSettings.maxStreakDays} days)`);

                if (streak >= streakSettings.maxStreakDays) {
                    console.log(`[bootstrap-mongo] ⚡ Streak fatigue limit reached (${streak} >= ${streakSettings.maxStreakDays} days)! Executing autonomous bench swap...`);
                    const swapRes = await executeAutonomousStreakSwap(db, groupId, targetSlot, account, streak, dataCluster, streakSettings, discordWebhookUrl);
                    if (swapRes && swapRes.substituted) {
                        account = swapRes.account;
                        console.log(`[bootstrap-mongo] ✅ Successfully substituted fatigued account with rested account: ${account.email}`);
                    } else if (swapRes && swapRes.empty) {
                        account = null;
                    }
                }
            }

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

    if (!account || !account.email || typeof account.email !== 'string' || account.email.trim() === '') {
        console.warn(`[bootstrap-mongo] ⚠️ No active account configured in group "${groupId}" for Slot ${targetSlot} (slot is vacant or resting).`);
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
