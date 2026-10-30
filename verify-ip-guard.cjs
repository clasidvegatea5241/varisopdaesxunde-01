/**
 * Pre-Flight Cross-Cluster IP Collision & Frequency Shield Engine
 * 
 * Invoked by run.sh immediately after US Geolocation verification.
 * 
 * Core Capabilities:
 * 1. Federated Multi-Cluster Mesh Scan:
 *    Queries all active IP clusters (IP_MONGODB_URI_1..10 or central IP_MONGODB_URI)
 *    in parallel using non-blocking Promise.allSettled. Prevents cross-cluster
 *    IP collisions (e.g. Group 025 in Cluster 1 vs Group 125 in Cluster 2).
 * 2. 5.0-Hour Inter-Account Cooldown Gate:
 *    Checks if this exact IP was used by another account in ANY active cluster
 *    within the last 5.0 hours (300 mins). Same-account re-runs are exempted.
 * 3. Fleet-Wide Aggregated Daily Frequency Cap:
 *    Aggregates daily runs across ALL active clusters on today's rotation date
 *    (11:30 AM IST offset rollover). Blocks if fleet-wide usage >= 3 runs.
 * 4. 500 Concurrent Connection Armor (Burst Resilience):
 *    - Strict maxPoolSize: 1 (single socket per runner).
 *    - Microsecond lifespan: opened only during ~50ms pre-flight, closed immediately.
 *    - 3-attempt connection retry with randomized exponential jitter.
 *    - Safe non-fatal fail-open if all database clusters are unreachable.
 */

let MongoClient;
try {
    MongoClient = require('mongodb').MongoClient;
} catch (_) {
    console.log('[verify-ip-guard] mongodb package not installed. Skipping pre-flight IP shield (Fail-Open).');
    console.log(JSON.stringify({ status: 'ALLOWED', gate: 'NO_MONGO', message: 'mongodb package not available' }));
    process.exit(0);
}

const fs = require('node:fs');
const path = require('node:path');

// Safe account email discovery (Environment -> .env -> runner_env.json)
function getAccountEmail(slot = 1) {
    if (process.env.ACCOUNT_1_EMAIL && process.env.ACCOUNT_1_EMAIL.trim() !== '') {
        return process.env.ACCOUNT_1_EMAIL.trim();
    }
    try {
        const envPath = path.resolve(process.cwd(), '.env');
        if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, 'utf8');
            const match = content.match(/^ACCOUNT_1_EMAIL=(.+)$/m);
            if (match && match[1] && match[1].trim() !== '') {
                return match[1].trim();
            }
        }
    } catch (_) {}

    try {
        const jsonPath = path.resolve(process.cwd(), 'runner_env.json');
        if (fs.existsSync(jsonPath)) {
            const runnerEnv = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            const emailKey = `account_${slot}`;
            if (runnerEnv[emailKey] && runnerEnv[emailKey].trim() !== '') {
                return runnerEnv[emailKey].trim();
            }
            if (runnerEnv.account_1 && runnerEnv.account_1.trim() !== '') {
                return runnerEnv.account_1.trim();
            }
        }
    } catch (_) {}

    return null;
}

// Normalize MongoDB URI to detect identical database instances
function normalizeMongoUri(uri) {
    try {
        const url = new URL(uri.replace(/^mongodb\+srv:\/\//, 'http://'));
        return `${url.host}${url.pathname}`;
    } catch (_) {
        return uri.trim();
    }
}

// Extract database name from URI
function extractDbName(uri, defaultDb = 'test') {
    try {
        const url = new URL(uri.replace(/^mongodb\+srv:\/\//, 'http://'));
        if (url.pathname && url.pathname.length > 1) {
            return url.pathname.substring(1).split('?')[0];
        }
    } catch (_) {}
    return defaultDb;
}

/**
 * Discover all active cluster endpoints and determine home cluster
 */
function discoverClusterEndpoints(groupId) {
    const rawNumber = String(groupId || '001').replace(/\D/g, '');
    const groupNum = parseInt(rawNumber, 10) || 1;
    const homeClusterIndex = Math.floor((groupNum - 1) / 100) + 1;

    let homeCluster = null;
    const allCandidates = [];

    // 1. Resolve Home Cluster (Specific to this group)
    const homeIpKey = `IP_MONGODB_URI_${homeClusterIndex}`;
    const homeDataKey = `MONGODB_URI_${homeClusterIndex}`;

    if (process.env[homeIpKey] && process.env[homeIpKey] !== 'null') {
        homeCluster = { uri: process.env[homeIpKey].trim(), source: homeIpKey, clusterIndex: homeClusterIndex, isHome: true };
    } else if (process.env.IP_MONGODB_URI && process.env.IP_MONGODB_URI !== 'null') {
        homeCluster = { uri: process.env.IP_MONGODB_URI.trim(), source: 'IP_MONGODB_URI', clusterIndex: homeClusterIndex, isHome: true };
    } else if (process.env[homeDataKey] && process.env[homeDataKey] !== 'null') {
        homeCluster = { uri: process.env[homeDataKey].trim(), source: homeDataKey, clusterIndex: homeClusterIndex, isHome: true };
    } else if (process.env.MONGODB_URI && process.env.MONGODB_URI !== 'null') {
        homeCluster = { uri: process.env.MONGODB_URI.trim(), source: 'MONGODB_URI', clusterIndex: homeClusterIndex, isHome: true };
    }

    // 2. Discover all available IP and Data cluster endpoints across 1..10
    // Check if a dedicated central IP radar exists
    if (process.env.IP_MONGODB_URI && process.env.IP_MONGODB_URI !== 'null') {
        allCandidates.push({
            uri: process.env.IP_MONGODB_URI.trim(),
            source: 'IP_MONGODB_URI (Central Radar)',
            clusterIndex: 0
        });
    }

    for (let c = 1; c <= 10; c++) {
        const ipKey = `IP_MONGODB_URI_${c}`;
        if (process.env[ipKey] && process.env[ipKey] !== 'null') {
            allCandidates.push({ uri: process.env[ipKey].trim(), source: ipKey, clusterIndex: c });
        }
    }

    // If no dedicated IP clusters found, gather numbered data clusters
    if (allCandidates.length === 0) {
        for (let c = 1; c <= 10; c++) {
            const dataKey = `MONGODB_URI_${c}`;
            if (process.env[dataKey] && process.env[dataKey] !== 'null') {
                allCandidates.push({ uri: process.env[dataKey].trim(), source: dataKey, clusterIndex: c });
            }
        }
    }

    // Fallback general URI
    if (allCandidates.length === 0 && process.env.MONGODB_URI && process.env.MONGODB_URI !== 'null') {
        allCandidates.push({ uri: process.env.MONGODB_URI.trim(), source: 'MONGODB_URI', clusterIndex: 1 });
    }

    // Deduplicate endpoints by normalized URI
    const seenUris = new Set();
    const clustersToScan = [];
    for (const cand of allCandidates) {
        const norm = normalizeMongoUri(cand.uri);
        if (!seenUris.has(norm)) {
            seenUris.add(norm);
            clustersToScan.push(cand);
        }
    }

    // Ensure homeCluster is assigned
    if (!homeCluster && clustersToScan.length > 0) {
        homeCluster = { ...clustersToScan[0], isHome: true };
    }

    return { homeCluster, clustersToScan };
}

// Calculate the deterministic rotation date (11:30 AM IST / 06:00 UTC rollover)
function getRotationDate(now = new Date()) {
    const offsetMillis = 6 * 60 * 60 * 1000; // -6 hours shift
    const rotated = new Date(now.getTime() - offsetMillis);
    const yyyy = rotated.getUTCFullYear();
    const mm = String(rotated.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(rotated.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

// Format IST timestamp safely
function getIstTimestamp(now = new Date()) {
    try {
        return new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        }).format(now) + ' IST';
    } catch (_) {
        return now.toISOString();
    }
}

// Sleep helper
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute cluster inspection with maxPoolSize: 1 and Progressive Multiplying Backoff
 */
async function queryClusterWithRetry(targetCluster, runnerIp, accountEmail, cooldownCutoff, rotationDate) {
    const maxAttempts = parseInt(process.env.IP_GUARD_MAX_ATTEMPTS || '5', 10);
    const baseBackoffMs = parseInt(process.env.IP_GUARD_BACKOFF_BASE_MS || '5000', 10);
    const jitterMaxMs = parseInt(process.env.IP_GUARD_JITTER_MAX_MS || '1500', 10);
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let client = null;
        try {
            client = new MongoClient(targetCluster.uri, {
                maxPoolSize: 1, // Single-socket armor: reduces driver footprint by 99%
                minPoolSize: 0,
                connectTimeoutMS: 5000,
                serverSelectionTimeoutMS: 5000
            });

            await client.connect();
            const dbName = extractDbName(targetCluster.uri, 'test');
            const db = client.db(dbName);
            const col = db.collection('runner_ip_logs');

            // Compound index guarantee
            col.createIndex({ ip: 1, timestamp_utc: -1 }, { background: true }).catch(() => {});

            // Query 1: Cooldown collision check
            const collisionDoc = await col.findOne({
                ip: runnerIp,
                email: { $ne: accountEmail },
                $or: [
                    { timestamp_utc: { $gte: cooldownCutoff } },
                    { timestamp_utc: { $gte: cooldownCutoff.toISOString() } }
                ]
            }, {
                sort: { timestamp_utc: -1 }
            });

            // Query 2: Daily run count on this cluster
            const dailyCount = await col.countDocuments({
                ip: runnerIp,
                rotation_date: rotationDate
            });

            return {
                cluster: targetCluster.source,
                clusterIndex: targetCluster.clusterIndex,
                collisionDoc,
                dailyCount,
                ok: true
            };

        } catch (err) {
            lastError = err;
            if (attempt < maxAttempts) {
                // Progressive multiplying backoff: (attempt * baseBackoffMs) + 0..jitterMaxMs random jitter
                const jitterDelay = (attempt * baseBackoffMs) + Math.floor(Math.random() * jitterMaxMs);
                console.log(`[verify-ip-guard] Transient connection error on attempt ${attempt}/${maxAttempts} (${targetCluster.source}): ${err.message}. Retrying in ${(jitterDelay / 1000).toFixed(1)}s...`);
                await sleep(jitterDelay);
            }
        } finally {
            if (client) {
                await client.close().catch(() => {});
            }
        }
    }

    return {
        cluster: targetCluster.source,
        clusterIndex: targetCluster.clusterIndex,
        ok: false,
        error: lastError ? lastError.message : 'Unknown connection error'
    };
}

/**
 * Atomically record clean IP to the designated home cluster with Progressive Multiplying Backoff
 */
async function recordRunToHomeCluster(homeCluster, logDoc) {
    const maxAttempts = parseInt(process.env.IP_GUARD_MAX_ATTEMPTS || '5', 10);
    const baseBackoffMs = parseInt(process.env.IP_GUARD_BACKOFF_BASE_MS || '5000', 10);
    const jitterMaxMs = parseInt(process.env.IP_GUARD_JITTER_MAX_MS || '1500', 10);
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let client = null;
        try {
            client = new MongoClient(homeCluster.uri, {
                maxPoolSize: 1,
                connectTimeoutMS: 5000,
                serverSelectionTimeoutMS: 5000
            });

            await client.connect();
            const dbName = extractDbName(homeCluster.uri, 'test');
            const col = client.db(dbName).collection('runner_ip_logs');

            await col.insertOne(logDoc);
            return true;
        } catch (err) {
            lastError = err;
            if (attempt < maxAttempts) {
                const jitterDelay = (attempt * baseBackoffMs) + Math.floor(Math.random() * jitterMaxMs);
                console.log(`[verify-ip-guard] Transient write error on attempt ${attempt}/${maxAttempts} (${homeCluster.source}): ${err.message}. Retrying in ${(jitterDelay / 1000).toFixed(1)}s...`);
                await sleep(jitterDelay);
            }
        } finally {
            if (client) {
                await client.close().catch(() => {});
            }
        }
    }

    console.warn(`[verify-ip-guard] Warning: Failed to insert run log into ${homeCluster.source} after ${maxAttempts} attempts:`, lastError?.message);
    return false;
}

async function main() {
    const runnerIp = (process.argv[2] || '').trim();
    const runnerCountry = (process.argv[3] || 'US').trim();
    const runnerRegion = (process.argv[4] || 'Unknown').trim();
    const runnerCity = (process.argv[5] || 'Unknown').trim();
    const runnerOrg = (process.argv[6] || 'Unknown').trim();
    const rawSlot = process.argv[7] || '1';
    const slot = parseInt(rawSlot, 10) || 1;
    let effectiveSlot = slot;

    // Resolve accurate target slot from runner_env.json in rotated/gap modes
    if (fs.existsSync('runner_env.json')) {
        try {
            const runnerEnv = JSON.parse(fs.readFileSync('runner_env.json', 'utf8'));
            if (runnerEnv.target_slot && !isNaN(parseInt(runnerEnv.target_slot, 10))) {
                effectiveSlot = parseInt(runnerEnv.target_slot, 10);
            }
        } catch (_) {}
    }

    if (!runnerIp) {
        console.warn('[verify-ip-guard] No IP provided to verify. Failing open.');
        console.log(JSON.stringify({ status: 'ALLOWED', gate: 'NO_IP', message: 'No IP supplied' }));
        process.exit(0);
    }

    const accountEmail = getAccountEmail(slot);
    if (!accountEmail) {
        console.warn('[verify-ip-guard] No account email found. Failing open.');
        console.log(JSON.stringify({ status: 'ALLOWED', gate: 'NO_EMAIL', message: 'No account email found' }));
        process.exit(0);
    }

    const groupId = process.env.GROUP_ID || '001';
    const { homeCluster, clustersToScan } = discoverClusterEndpoints(groupId);

    if (clustersToScan.length === 0 || !homeCluster) {
        console.warn('[verify-ip-guard] No MongoDB URI available for IP shield. Failing open.');
        console.log(JSON.stringify({ status: 'ALLOWED', gate: 'NO_MONGO_URI', message: 'No MongoDB URI configured' }));
        process.exit(0);
    }

    // Safety Thresholds
    const cooldownHours = parseFloat(process.env.IP_COOLDOWN_HOURS || '5.0');
    const maxDailyRuns = parseInt(process.env.IP_MAX_DAILY_RUNS || '3', 10);

    const now = new Date();
    const rotationDate = getRotationDate(now);
    const istTimestamp = getIstTimestamp(now);
    const cooldownMs = cooldownHours * 60 * 60 * 1000;
    const cooldownCutoff = new Date(now.getTime() - cooldownMs);

    // -----------------------------------------------------------------
    // PARALLEL CROSS-CLUSTER SCAN (Non-blocking Promise.allSettled)
    // -----------------------------------------------------------------
    const scanPromises = clustersToScan.map(cluster =>
        queryClusterWithRetry(cluster, runnerIp, accountEmail, cooldownCutoff, rotationDate)
    );

    const scanResults = await Promise.allSettled(scanPromises);

    const successfulScans = [];
    let detectedCollision = null;
    let collisionSourceCluster = null;
    let totalFleetDailyRuns = 0;

    for (let i = 0; i < scanResults.length; i++) {
        const result = scanResults[i];
        const clusterInfo = clustersToScan[i];

        if (result.status === 'fulfilled' && result.value && result.value.ok) {
            const data = result.value;
            successfulScans.push(data);

            // Accumulate daily runs across clusters
            totalFleetDailyRuns += (data.dailyCount || 0);

            // Check if this cluster found an active collision
            if (data.collisionDoc && !detectedCollision) {
                detectedCollision = data.collisionDoc;
                collisionSourceCluster = data.cluster;
            }
        } else {
            const errorMsg = result.status === 'fulfilled' ? result.value.error : result.reason?.message;
            console.warn(`[verify-ip-guard] Non-fatal notice: Cluster scan on ${clusterInfo.source} timed out or failed (${errorMsg}). Proceeding with available clusters.`);
        }
    }

    // Fail-open policy if 100% of clusters were completely unreachable
    if (successfulScans.length === 0) {
        console.warn('[verify-ip-guard] All database clusters unreachable after retries. Safe fail-open allowed.');
        console.log(JSON.stringify({
            status: 'ALLOWED',
            gate: 'FALLBACK',
            message: 'All clusters unreachable. Allowed under fail-open policy.'
        }));
        process.exit(0);
    }

    // -----------------------------------------------------------------
    // GATE 1: 5.0-Hour Inter-Account Cooldown Gate (Across Any Cluster)
    // -----------------------------------------------------------------
    if (detectedCollision) {
        const prevTime = new Date(detectedCollision.timestamp_utc).getTime();
        const diffMinutes = Math.max(1, Math.round((now.getTime() - prevTime) / 60000));
        const diffSeconds = Math.max(1, Math.round((now.getTime() - prevTime) / 1000));
        const timeDesc = diffMinutes <= 2 ? `${diffSeconds}s ago` : `${diffMinutes}m ago`;
        const detailStr = `Used ${timeDesc} by ${detectedCollision.email} (Group ${detectedCollision.group_id} Slot ${detectedCollision.slot} in ${collisionSourceCluster})`;

        console.error(`[verify-ip-guard] 🛑 IP COLLISION DETECTED in ${collisionSourceCluster}: IP ${runnerIp} was used ${timeDesc} by ${detectedCollision.email}!`);

        console.log(JSON.stringify({
            status: 'BLOCKED',
            gate: 'COOLDOWN',
            reason: `Active IP Cooldown (${collisionSourceCluster}): Used ${timeDesc} by another account`,
            detail_str: detailStr,
            detail: {
                ip: runnerIp,
                email: accountEmail,
                source_cluster: collisionSourceCluster,
                last_email: detectedCollision.email,
                last_group: detectedCollision.group_id,
                last_slot: detectedCollision.slot,
                minutes_ago: diffMinutes,
                seconds_ago: diffSeconds,
                cooldown_hours: cooldownHours,
                last_timestamp_ist: detectedCollision.timestamp_ist
            }
        }));
        process.exit(2);
    }

    // -----------------------------------------------------------------
    // GATE 2: Fleet-Wide Aggregated Daily Frequency Cap (Max 3 Runs/Day)
    // -----------------------------------------------------------------
    if (totalFleetDailyRuns >= maxDailyRuns) {
        const detailStr = `IP reached fleet-wide daily limit of ${totalFleetDailyRuns}/${maxDailyRuns} runs across ${successfulScans.length} active cluster(s) on rotation date ${rotationDate}`;
        console.error(`[verify-ip-guard] 🛑 FLEET DAILY FREQUENCY CAP REACHED: IP ${runnerIp} already ran ${totalFleetDailyRuns} times today across clusters!`);

        console.log(JSON.stringify({
            status: 'BLOCKED',
            gate: 'DAILY_CAP',
            reason: `Daily Frequency Cap Reached (${totalFleetDailyRuns}/${maxDailyRuns} fleet runs today)`,
            detail_str: detailStr,
            detail: {
                ip: runnerIp,
                email: accountEmail,
                daily_count: totalFleetDailyRuns,
                max_allowed: maxDailyRuns,
                scanned_clusters: successfulScans.length,
                rotation_date: rotationDate
            }
        }));
        process.exit(2);
    }

    // -----------------------------------------------------------------
    // GATE 3: Clean Pass & Atomic Ingestion to Home Cluster
    // -----------------------------------------------------------------
    const newFleetRunCount = totalFleetDailyRuns + 1;
    const logDoc = {
        ip: runnerIp,
        email: accountEmail,
        group_id: String(groupId).trim(),
        slot: effectiveSlot,
        country: String(runnerCountry).trim().toUpperCase(),
        region: String(runnerRegion).trim(),
        city: String(runnerCity).trim(),
        isp: String(runnerOrg).trim(),
        cluster_index: homeCluster.clusterIndex || 1,
        rotation_date: rotationDate,
        timestamp_utc: now,
        timestamp_ist: istTimestamp,
        created_at: now
    };

    await recordRunToHomeCluster(homeCluster, logDoc);

    console.log(`[verify-ip-guard] ✅ Clean IP registered: ${runnerIp} (${runnerCity}, ${runnerRegion} • ${runnerOrg}) for ${accountEmail} [Rotation Date: ${rotationDate} • Fleet Run ${newFleetRunCount}/${maxDailyRuns} across ${successfulScans.length} cluster(s)] via ${homeCluster.source}`);

    console.log(JSON.stringify({
        status: 'ALLOWED',
        gate: 'CLEAN',
        message: `Fresh IP verified clean across ${successfulScans.length} cluster(s) (Fleet Run ${newFleetRunCount}/${maxDailyRuns} today)`,
        detail: {
            ip: runnerIp,
            email: accountEmail,
            group_id: groupId,
            slot: effectiveSlot,
            runner_slot: slot,
            rotation_date: rotationDate,
            fleet_daily_count: newFleetRunCount,
            home_cluster: homeCluster.source,
            scanned_clusters: successfulScans.length
        }
    }));

    process.exit(0);
}

main().catch((err) => {
    console.warn(`[verify-ip-guard] Non-fatal unhandled error (${err.message}). Safe fail-open allowed.`);
    console.log(JSON.stringify({
        status: 'ALLOWED',
        gate: 'FALLBACK',
        message: `Unhandled fail-open: ${err.message}`
    }));
    process.exit(0);
});
