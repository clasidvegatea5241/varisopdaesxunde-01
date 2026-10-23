/**
 * Post-Run Telemetry & Cloud Persistence (Direct MongoDB Mode)
 * 
 * Used by GitHub Actions runners to parse bot run logs and write
 * updated points, run counters, and execution status directly to
 * MongoDB Atlas rewards_accounts and farming_accounts collections.
 */

const { MongoClient } = require('mongodb');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

// Helper for waiting
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper to send Discord webhook embed natively
function sendDiscordEmbed(webhookUrl, payload) {
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
                console.warn('[log-run-mongo] Discord webhook request error:', e.message);
                resolve();
            });

            req.write(data);
            req.end();
        } catch (e) {
            console.warn('[log-run-mongo] Failed to format Discord webhook:', e.message);
            resolve();
        }
    });
}

// Escape special regex characters in email strings
function escapeRegex(str) {
    return String(str).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build anchored case-insensitive regular expression for exact email matching
function buildEmailRegex(email) {
    return new RegExp(`^${escapeRegex(email)}$`, 'i');
}

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

// Cross-Cluster Data Fallback: Scan across all configured MONGODB_URI_1..10 to find previous account stats
async function searchAllDataClustersForReward(email, currentClusterIndex) {
    const cleanEmail = email.trim().toLowerCase();
    const emailRegex = buildEmailRegex(cleanEmail);

    for (let c = 1; c <= 10; c++) {
        if (c === currentClusterIndex) continue;
        const uriKey = `MONGODB_URI_${c}`;
        const uri = process.env[uriKey] || (c === 1 ? process.env.MONGODB_URI : null);
        if (!uri || uri === 'null') continue;

        let otherClient = null;
        try {
            otherClient = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
            await otherClient.connect();
            const otherDb = otherClient.db('test');
            const found = await otherDb.collection('rewards_accounts').findOne({ email: emailRegex });
            if (found) {
                return { doc: found, clusterIndex: c, uri };
            }
        } catch (_) {
            // Ignore offline/unconfigured cluster errors
        } finally {
            if (otherClient) {
                await otherClient.close().catch(() => {});
            }
        }
    }
    return null;
}

// Migrate previous daily ledger records into the current active cluster
async function migratePriorDailyHistoryIfAny(cleanEmail, fromClusterIndex, toClusterDb) {
    const uriKey = `MONGODB_URI_${fromClusterIndex}`;
    const uri = process.env[uriKey] || (fromClusterIndex === 1 ? process.env.MONGODB_URI : null);
    if (!uri || uri === 'null') return;

    let sourceClient = null;
    try {
        sourceClient = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
        await sourceClient.connect();
        const sourceDb = sourceClient.db('test');
        const docs = await sourceDb.collection('rewards_daily_history').find({ email: buildEmailRegex(cleanEmail) }).toArray();
        if (docs && docs.length > 0) {
            for (const d of docs) {
                const { _id, ...cleanDoc } = d;
                await toClusterDb.collection('rewards_daily_history').updateOne(
                    { email: cleanEmail, date: d.date },
                    { $set: cleanDoc },
                    { upsert: true }
                );
            }
            await sourceDb.collection('rewards_daily_history').deleteMany({ email: buildEmailRegex(cleanEmail) });
            console.log(`[log-run-mongo] ✅ Relocated ${docs.length} prior daily history records from Cluster ${fromClusterIndex} -> active cluster.`);
        }
    } catch (e) {
        // Non-fatal
    } finally {
        if (sourceClient) await sourceClient.close().catch(() => {});
    }
}

async function main() {
    const rawSlot = process.argv[2] || '1';
    const groupId = process.env.GROUP_ID || '001';
    const dataCluster = resolveMongoUri(groupId, 'data');
    const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL || null;

    if (!dataCluster || !dataCluster.uri) {
        console.log('[log-run-mongo] Neither MONGODB_URI nor MONGODB_URI_<N> provided. Skipping direct cloud persistence.');
        return;
    }

    const mongoUri = dataCluster.uri;

    // 1. Identify Target Account from .env
    let accountEmail = null;
    if (fs.existsSync('.env')) {
        const envContent = fs.readFileSync('.env', 'utf8');
        const match = envContent.match(/^ACCOUNT_1_EMAIL=(.+)$/m);
        if (match && match[1] && match[1].trim() !== '') {
            accountEmail = match[1].trim();
        }
    }

    if (!accountEmail) {
        console.log('[log-run-mongo] No ACCOUNT_1_EMAIL found in .env (slot may be empty or unassigned). Exiting.');
        return;
    }

    // 2. Read and Parse Container Logs
    const logPath = path.resolve(process.cwd(), 'container.log');
    let logContent = '';
    if (fs.existsSync(logPath)) {
        logContent = fs.readFileSync(logPath, 'utf8');
    }

    let exitCode = 0;
    if (fs.existsSync('container.exitcode')) {
        const rawCode = fs.readFileSync('container.exitcode', 'utf8').trim();
        exitCode = parseInt(rawCode, 10) || 0;
    }

    // Check for Run-End summary line
    // e.g.: Completed all accounts | accountsProcessed=1 | pointsGained=250 | previousBalance=12000 | currentBalance=12250 | runtimeMinutes=12.4
    const summaryMatch = logContent.match(/Completed all accounts \|.*pointsGained=(\d+).*previousBalance=(\d+).*currentBalance=(\d+).*runtimeMinutes=([\d.]+)/i);

    let pointsGained = null;
    let previousBalance = null;
    let currentBalance = null;
    let runtimeMinutes = null;
    let status = 'Finished';

    if (summaryMatch) {
        pointsGained = parseInt(summaryMatch[1], 10);
        previousBalance = parseInt(summaryMatch[2], 10);
        currentBalance = parseInt(summaryMatch[3], 10);
        runtimeMinutes = parseFloat(summaryMatch[4]);
        status = 'Finished';
    } else {
        // Evaluate failure signatures
        if (/suspended/i.test(logContent)) {
            status = 'Suspended';
        } else if (/locked/i.test(logContent)) {
            status = 'Locked';
        } else if (/2FA|two-factor|authenticator/i.test(logContent)) {
            status = '2FA Required';
        } else if (/password|credentials/i.test(logContent) && exitCode !== 0) {
            status = 'Bad Password';
        } else if (/proxy/i.test(logContent) && exitCode !== 0) {
            status = 'Proxy Error';
        } else if (exitCode !== 0) {
            status = 'Failed';
        } else {
            status = 'Incomplete';
        }
    }

    console.log('=====================================================');
    console.log('  Dual-Mode Post-Run Telemetry');
    console.log(`  Account Email     : ${accountEmail}`);
    console.log(`  Cluster Partition : Cluster ${dataCluster.clusterIndex} (via ${dataCluster.source})`);
    console.log(`  Execution Status  : ${status}`);
    if (currentBalance !== null) {
        console.log(`  Points Gained     : +${pointsGained}`);
        console.log(`  Current Balance   : ${currentBalance}`);
        console.log(`  Runtime           : ${runtimeMinutes} minutes`);
    }
    console.log('=====================================================');

    // 3. Connect to MongoDB Atlas and Persist Run State (With Resilient 3-Attempt Retry)
    const maxAttempts = 3;
    let client = null;
    let persistSuccess = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            console.log(`[log-run-mongo] Connecting to MongoDB Atlas (Attempt ${attempt}/${maxAttempts})...`);
            client = new MongoClient(mongoUri, {
                serverSelectionTimeoutMS: 8000,
                connectTimeoutMS: 8000
            });

            await client.connect();

            let dbName = 'test';
            try {
                const urlParsed = new URL(mongoUri.replace(/^mongodb\+srv:\/\//, 'http://'));
                if (urlParsed.pathname && urlParsed.pathname.length > 1) {
                    dbName = urlParsed.pathname.substring(1).split('?')[0];
                }
            } catch (_) {}

            const db = client.db(dbName);

            // Update rewards_accounts collection (matches MSR-Database core dashboard)
            const updateFields = {
                status: status,
                last_updated_at: new Date().toISOString()
            };

            if (currentBalance !== null) {
                updateFields.total_points = currentBalance;
                updateFields.logs = `Points: +${pointsGained} | Balance: ${currentBalance} | Time: ${runtimeMinutes}m`;
            } else {
                updateFields.logs = `Execution finished with status: ${status} (Exit Code: ${exitCode})`;
            }

            const rewardsUpdateOp = {
                $set: updateFields
            };

            // Increment run_days and offline_run_days if run completed or earned points
            if (status === 'Finished' || (pointsGained !== null && pointsGained > 0)) {
                rewardsUpdateOp.$inc = { run_days: 1, offline_run_days: 1, active_streak_days: 1 };
            }

            // Resilient case-insensitive update for rewards_accounts (avoids duplicate casing records)
            const cleanEmail = accountEmail.trim().toLowerCase();
            const emailRegex = buildEmailRegex(cleanEmail);
            let existingReward = await db.collection('rewards_accounts').findOne({ email: emailRegex });

            // No-Web Cross-Cluster Fallback: If not found in active cluster, search across other clusters
            let inheritedClusterIndex = null;
            if (!existingReward) {
                try {
                    const inherited = await searchAllDataClustersForReward(cleanEmail, dataCluster.clusterIndex);
                    if (inherited && inherited.doc) {
                        console.log(`[log-run-mongo] 🔄 Discovered previous account stats in Cluster ${inherited.clusterIndex} (Run Days: ${inherited.doc.run_days}, Points: ${inherited.doc.total_points}). Carrying forward!`);
                        existingReward = inherited.doc;
                        inheritedClusterIndex = inherited.clusterIndex;

                        // Inherit prior run_days, synced_offline_run_days, and active_streak_days
                        updateFields.run_days = (inherited.doc.run_days || 0) + (status === 'Finished' || (pointsGained !== null && pointsGained > 0) ? 1 : 0);
                        updateFields.offline_run_days = (inherited.doc.offline_run_days || 0) + (status === 'Finished' || (pointsGained !== null && pointsGained > 0) ? 1 : 0);
                        updateFields.synced_offline_run_days = inherited.doc.synced_offline_run_days || 0;
                        updateFields.active_streak_days = inherited.doc.active_streak_days || 0;
                        if (inherited.doc.notes) updateFields.notes = inherited.doc.notes;

                        // Remove $inc since we already carried forward and added today's increment directly
                        delete rewardsUpdateOp.$inc;

                        // Purge old record from source cluster to eliminate ghost duplicate
                        try {
                            const delClient = new MongoClient(inherited.uri, { serverSelectionTimeoutMS: 5000 });
                            await delClient.connect();
                            await delClient.db('test').collection('rewards_accounts').deleteOne({ _id: inherited.doc._id });
                            await delClient.close().catch(() => {});
                            console.log(`[log-run-mongo] ✅ Successfully purged stale ghost record from Cluster ${inherited.clusterIndex}.`);
                        } catch (delErr) {
                            console.warn(`[log-run-mongo] Notice: Could not purge stale record from Cluster ${inherited.clusterIndex}:`, delErr.message);
                        }
                    }
                } catch (inhErr) {
                    console.warn('[log-run-mongo] Cross-cluster rewards fallback notice:', inhErr.message);
                }
            }

            if (existingReward) {
                await db.collection('rewards_accounts').updateOne(
                    { email: emailRegex },
                    rewardsUpdateOp,
                    { upsert: true }
                );
            } else {
                rewardsUpdateOp.$setOnInsert = { synced_offline_run_days: 0 };
                await db.collection('rewards_accounts').updateOne(
                    { email: cleanEmail },
                    rewardsUpdateOp,
                    { upsert: true }
                );
            }
            console.log(`[log-run-mongo] ✅ Successfully updated rewards_accounts in MongoDB.`);

            // Relocate prior daily ledger records if account moved across clusters
            if (inheritedClusterIndex) {
                await migratePriorDailyHistoryIfAny(cleanEmail, inheritedClusterIndex, db);
            }

            // 2b. Write/Upsert to rewards_daily_history (Daily Points History Ledger)
            try {
                const todayDateStr = new Date().toISOString().split('T')[0];
                const numericDuration = parseFloat(runtimeMinutes) || 0;
                const numericEarned = pointsGained !== null ? pointsGained : 0;
                const numericBalance = currentBalance !== null ? currentBalance : (existingReward?.total_points || 0);

                const historyDoc = {
                    email: cleanEmail,
                    date: todayDateStr,
                    points_earned: numericEarned,
                    total_points: numericBalance,
                    status: status,
                    duration_minutes: numericDuration,
                    group_id: String(groupId).padStart(3, '0'),
                    slot: parseInt(rawSlot, 10) || 1,
                    cluster_index: dataCluster.clusterIndex || 1,
                    timestamp: new Date().toISOString(),
                    created_at: Date.now()
                };

                await db.collection('rewards_daily_history').updateOne(
                    { email: cleanEmail, date: todayDateStr },
                    { $set: historyDoc },
                    { upsert: true }
                );

                // Auto-ensure compound unique index on first write
                db.collection('rewards_daily_history').createIndex(
                    { email: 1, date: 1 },
                    { unique: true }
                ).catch(() => {});

                console.log(`[log-run-mongo] ✅ Successfully recorded daily history entry in rewards_daily_history for ${todayDateStr} (+${numericEarned} pts).`);
            } catch (histErr) {
                console.warn('[log-run-mongo] Notice: Could not record in rewards_daily_history:', histErr.message);
            }

            // Also update farming_accounts collection
            const farmingUpdate = {
                last_status: status,
                last_run: new Date().toISOString()
            };
            if (currentBalance !== null) {
                farmingUpdate.total_points = currentBalance;
            }

            const farmingUpdateOp = {
                $set: farmingUpdate
            };
            if (status === 'Finished' || (pointsGained !== null && pointsGained > 0)) {
                farmingUpdateOp.$inc = { active_streak_days: 1 };
            }

            const existingFarming = await db.collection('farming_accounts').findOne({ email: emailRegex });
            if (existingFarming) {
                await db.collection('farming_accounts').updateOne(
                    { _id: existingFarming._id },
                    farmingUpdateOp
                );
            } else {
                await db.collection('farming_accounts').updateOne(
                    { email: accountEmail },
                    farmingUpdateOp
                );
            }
            console.log(`[log-run-mongo] ✅ Successfully updated farming_accounts in MongoDB.`);

            // Instant socket disconnect
            await client.close();
            client = null;
            persistSuccess = true;
            break;
        } catch (err) {
            console.warn(`[log-run-mongo] Warning: Attempt ${attempt} failed: ${err.message}`);
            if (client) {
                try { await client.close(); } catch (_) {}
                client = null;
            }

            if (attempt === maxAttempts) {
                console.error('[log-run-mongo] Failed to persist run state to MongoDB after exhausting all attempts.');
            } else {
                const backoffMs = attempt * 3000;
                console.log(`[log-run-mongo] Retrying in ${backoffMs / 1000}s...`);
                await sleep(backoffMs);
            }
        }
    }

    // 4. Send Fallback Discord Notification If Bot Exited Non-Zero
    if (discordWebhookUrl && status !== 'Finished') {
        const color = status === 'Suspended' || status === 'Locked' ? 0xff0000 : 0xffaa00;
        const embedPayload = {
            embeds: [
                {
                    title: `⚠️ Account Alert: ${accountEmail}`,
                    description: `Farming completed with status **${status}** (Slot ${rawSlot})`,
                    color: color,
                    fields: [
                        { name: 'Status', value: status, inline: true },
                        { name: 'Exit Code', value: String(exitCode), inline: true },
                        { name: 'Timestamp', value: new Date().toUTCString(), inline: false }
                    ],
                    footer: { text: 'MSR Dual-Mode Autonomous Runner' }
                }
            ]
        };

        await sendDiscordEmbed(discordWebhookUrl, embedPayload);
    }
}

main().catch((err) => {
    console.error('[log-run-mongo] Uncaught Exception:', err);
    process.exit(0); // Non-fatal so workflow doesn't fail on reporting
});
