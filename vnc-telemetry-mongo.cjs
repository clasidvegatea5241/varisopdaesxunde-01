/**
 * VNC Telemetry & Multi-Cluster MongoDB Synchronizer
 * 
 * Reports live trycloudflare.com Web-VNC URLs to MongoDB Atlas
 * and notifies Discord webhooks so operators can watch headed runs live.
 */

const { MongoClient } = require('mongodb');
const https = require('node:https');

// Escape regex special chars for exact email matching
function escapeRegex(str) {
    return String(str).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildEmailRegex(email) {
    return new RegExp(`^${escapeRegex(email)}$`, 'i');
}

// Multi-cluster resolver matching log-run-mongo.cjs
function resolveMongoUri(groupId) {
    const rawNumber = String(groupId || '001').replace(/\D/g, '');
    const groupNum = parseInt(rawNumber, 10) || 1;
    const clusterIndex = Math.floor((groupNum - 1) / 100) + 1;
    const clusterKey = `MONGODB_URI_${clusterIndex}`;

    if (process.env[clusterKey] && process.env[clusterKey] !== 'null') {
        return { uri: process.env[clusterKey], clusterIndex, source: clusterKey };
    }
    if (process.env.MONGODB_URI && process.env.MONGODB_URI !== 'null') {
        return { uri: process.env.MONGODB_URI, clusterIndex, source: 'MONGODB_URI' };
    }
    return null;
}

// Send native Discord Webhook Embed
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

            req.on('error', () => resolve());
            req.write(data);
            req.end();
        } catch (_) {
            resolve();
        }
    });
}

// Parse command line arguments
function parseArgs() {
    const args = process.argv.slice(2);
    const action = args[0] || 'start'; // 'start' or 'stop'
    const params = { action };

    for (let i = 1; i < args.length; i++) {
        if (args[i] === '--email') params.email = args[++i];
        else if (args[i] === '--url') params.url = args[++i];
        else if (args[i] === '--slot') params.slot = args[++i];
        else if (args[i] === '--group') params.group = args[++i];
    }
    return params;
}

async function main() {
    const { action, email, url, slot, group } = parseArgs();
    if (!email) {
        console.log('[vnc-telemetry] No account email specified, skipping.');
        return;
    }

    const targetGroup = group || process.env.GROUP_ID || '001';
    const targetSlot = slot || process.env.SLOT || '1';
    const resolved = resolveMongoUri(targetGroup);

    let client = null;
    try {
        if (resolved && resolved.uri) {
            client = new MongoClient(resolved.uri, {
                serverSelectionTimeoutMS: 5000,
                connectTimeoutMS: 5000
            });
            await client.connect();
            const db = client.db('test');
            const collection = db.collection('farming_accounts');

            if (action === 'start') {
                await collection.updateOne(
                    { email: buildEmailRegex(email) },
                    {
                        $set: {
                            'telemetry.vnc_url': url,
                            'telemetry.vnc_active': true,
                            'telemetry.vnc_started_at': new Date()
                        }
                    }
                );
                console.log(`[vnc-telemetry] ✅ Recorded active VNC stream to MongoDB for ${email}`);
            } else if (action === 'stop') {
                await collection.updateOne(
                    { email: buildEmailRegex(email) },
                    {
                        $set: {
                            'telemetry.vnc_active': false,
                            'telemetry.vnc_url': null,
                            'telemetry.vnc_ended_at': new Date()
                        }
                    }
                );
                console.log(`[vnc-telemetry] ✅ Marked VNC stream inactive in MongoDB for ${email}`);
            }
        } else {
            console.log('[vnc-telemetry] No MongoDB URI configured, skipping database update.');
        }
    } catch (err) {
        console.warn('[vnc-telemetry] MongoDB telemetry update non-fatal error:', err.message);
    } finally {
        if (client) {
            await client.close().catch(() => {});
        }
    }

    // Discord Webhook Notification on Start
    if (action === 'start' && url) {
        const discordUrl = process.env.DISCORD_WEBHOOK_URL || process.env.CONFIG_DISCORD_URL;
        if (discordUrl && discordUrl !== 'null' && discordUrl.startsWith('http')) {
            const embed = {
                embeds: [{
                    title: '🖥️ Live Web-VNC Observation Online',
                    description: `Live desktop stream is now active via Cloudflare Quick Tunnel.\n\n[👉 **Click Here to Watch Bot Live**](${url})\n\n*(Opens instant HTML5 stream in your mobile or PC browser)*`,
                    color: 3066993, // Green
                    fields: [
                        { name: 'Account', value: `\`${email}\``, inline: true },
                        { name: 'Slot', value: `\`${targetSlot}\``, inline: true },
                        { name: 'Group', value: `\`${targetGroup}\``, inline: true }
                    ],
                    footer: { text: 'MSR-Database • Cloudflare Quick Tunnel' },
                    timestamp: new Date().toISOString()
                }]
            };
            await sendDiscordEmbed(discordUrl, embed);
            console.log('[vnc-telemetry] 📡 Sent Discord stream notification.');
        }
    }
}

main().catch((e) => console.warn('[vnc-telemetry] Warning:', e.message));
