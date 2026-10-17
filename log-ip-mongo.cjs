/**
 * Runner IP Intelligence & Telemetry Ingestion Script
 * 
 * Invoked by run.sh immediately after Region Guard / Proxy inspection.
 * Captures the exact runner IP, geolocation, ISP, account, and slot,
 * stamped with the deterministic 11:30 AM IST rotation date.
 * 
 * Safely persists to MongoDB (IP_MONGODB_URI or group cluster MONGODB_URI)
 * with strict connection timeouts and non-fatal fallback.
 */

let MongoClient;
try {
    MongoClient = require('mongodb').MongoClient;
} catch (_) {
    console.log('[log-ip-mongo] mongodb package not installed. Skipping IP telemetry.');
    process.exit(0);
}
const fs = require('node:fs');
const path = require('node:path');

// Safe environment loader from .env
function getAccountEmail() {
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
    return null;
}

// Multi-cluster resolution hierarchy
function resolveMongoUri(groupId) {
    const rawNumber = String(groupId || '001').replace(/\D/g, '');
    const groupNum = parseInt(rawNumber, 10) || 1;
    const clusterIndex = Math.floor((groupNum - 1) / 100) + 1;

    // 1. Dedicated IP Cluster for this Group (e.g. IP_MONGODB_URI_1 for Gr 001-100)
    const ipClusterKey = `IP_MONGODB_URI_${clusterIndex}`;
    if (process.env[ipClusterKey] && process.env[ipClusterKey] !== 'null') {
        return { uri: process.env[ipClusterKey], source: ipClusterKey, clusterIndex };
    }

    // 2. Dedicated Central IP Database
    if (process.env.IP_MONGODB_URI && process.env.IP_MONGODB_URI !== 'null') {
        return { uri: process.env.IP_MONGODB_URI, source: 'IP_MONGODB_URI', clusterIndex };
    }

    // 3. Numbered Group Data Cluster (1..10)
    const clusterKey = `MONGODB_URI_${clusterIndex}`;
    if (process.env[clusterKey] && process.env[clusterKey] !== 'null') {
        return { uri: process.env[clusterKey], source: clusterKey, clusterIndex };
    }

    // 4. General Fallback
    if (process.env.MONGODB_URI && process.env.MONGODB_URI !== 'null') {
        return { uri: process.env.MONGODB_URI, source: 'MONGODB_URI', clusterIndex };
    }

    return null;
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

async function main() {
    const runnerIp = process.argv[2] || '';
    const runnerCountry = process.argv[3] || 'US';
    const runnerRegion = process.argv[4] || 'Unknown';
    const runnerCity = process.argv[5] || 'Unknown';
    const runnerOrg = process.argv[6] || 'Unknown';
    const rawSlot = process.argv[7] || '1';
    const slot = parseInt(rawSlot, 10) || 1;

    if (!runnerIp || runnerIp.trim() === '') {
        console.log('[log-ip-mongo] No IP provided. Skipping IP telemetry.');
        return;
    }

    const accountEmail = getAccountEmail();
    if (!accountEmail) {
        console.log('[log-ip-mongo] No ACCOUNT_1_EMAIL found. Skipping IP telemetry.');
        return;
    }

    const groupId = process.env.GROUP_ID || '001';
    const targetCluster = resolveMongoUri(groupId);

    if (!targetCluster || !targetCluster.uri) {
        console.log('[log-ip-mongo] No MongoDB URI available for IP telemetry. Skipping.');
        return;
    }

    const now = new Date();
    const rotationDate = getRotationDate(now);
    const istTimestamp = getIstTimestamp(now);

    const doc = {
        ip: runnerIp.trim(),
        email: accountEmail.trim(),
        group_id: String(groupId).trim(),
        slot,
        country: String(runnerCountry).trim().toUpperCase(),
        region: String(runnerRegion).trim(),
        city: String(runnerCity).trim(),
        isp: String(runnerOrg).trim(),
        cluster_index: targetCluster.clusterIndex || 1,
        rotation_date: rotationDate,
        timestamp_utc: now,
        timestamp_ist: istTimestamp,
        created_at: now
    };

    let client = null;
    try {
        client = new MongoClient(targetCluster.uri, {
            serverSelectionTimeoutMS: 5000,
            connectTimeoutMS: 5000
        });

        await client.connect();

        let dbName = 'test';
        try {
            const urlParsed = new URL(targetCluster.uri.replace(/^mongodb\+srv:\/\//, 'http://'));
            if (urlParsed.pathname && urlParsed.pathname.length > 1) {
                dbName = urlParsed.pathname.substring(1).split('?')[0];
            }
        } catch (_) {}

        const db = client.db(dbName);
        const col = db.collection('runner_ip_logs');

        // Check if recently logged by verify-ip-guard.cjs within last 5 minutes
        const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
        const alreadyLogged = await col.findOne({
            ip: runnerIp.trim(),
            email: accountEmail.trim(),
            timestamp_utc: { $gte: fiveMinutesAgo }
        });

        if (alreadyLogged) {
            console.log(`[log-ip-mongo] IP ${runnerIp} already registered by Pre-Flight IP Shield. Skipping duplicate.`);
            return;
        }

        await col.insertOne(doc);
        console.log(`[log-ip-mongo] ✅ Logged Runner IP ${runnerIp} (${runnerCity}, ${runnerRegion} • ${runnerOrg}) for ${accountEmail} [Rotation Date: ${rotationDate}] via ${targetCluster.source}`);
    } catch (err) {
        console.warn('[log-ip-mongo] Non-fatal warning: Failed to record IP telemetry:', err.message);
    } finally {
        if (client) {
            await client.close().catch(() => {});
        }
    }
}

main().catch((err) => {
    console.warn('[log-ip-mongo] Non-fatal unhandled error:', err.message);
    process.exit(0);
});
