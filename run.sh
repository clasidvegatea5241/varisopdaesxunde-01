#!/usr/bin/env bash
set -e

# Capture starting directory
START_DIR=$(pwd)

SLOT=$1
if [ -z "$SLOT" ]; then
  SLOT=1
fi

echo "========================================="
echo " Starting V4 Runner for Slot $SLOT "
echo "========================================="

# =========================================================
# Execution Gate: Guard against inactive or unconfigured slots
# =========================================================
if [ -f runner_env.json ]; then
    IS_INACTIVE=$(jq -r '.inactive' runner_env.json 2>/dev/null || echo "")
    IS_EMPTY=$(jq -r '.empty' runner_env.json 2>/dev/null || echo "")
    IS_SLOT_ACTIVE=$(jq -r ".is_active_$SLOT" runner_env.json 2>/dev/null || echo "")
    GROUP_ACTIVE=$(jq -r '.group_is_active' runner_env.json 2>/dev/null || echo "")

    if [ "$IS_INACTIVE" = "true" ] || [ "$IS_EMPTY" = "true" ] || [ "$IS_SLOT_ACTIVE" = "false" ] || [ "$GROUP_ACTIVE" = "false" ]; then
        echo "========================================================="
        echo " [-] Slot $SLOT is turned OFF or inactive in MSR-Database."
        echo "     Gracefully exiting with exit code 0 to save quota."
        echo "========================================================="
        exit 0
    fi
fi

if [ ! -f .env ]; then
    echo "[-] No .env file found for Slot $SLOT. Gracefully skipping execution."
    exit 0
fi

# Verify ACCOUNT_1_EMAIL is defined and not empty
ACCOUNT_EMAIL=$(grep -E '^ACCOUNT_1_EMAIL=' .env 2>/dev/null | cut -d '=' -f2- | tr -d '[:space:]' || echo "")
if [ -z "$ACCOUNT_EMAIL" ] || [ "$ACCOUNT_EMAIL" = "null" ]; then
    echo "========================================================="
    echo " [-] No valid account email found in .env for Slot $SLOT."
    echo "     Slot is disabled or unassigned. Skipping execution."
    echo "========================================================="
    exit 0
fi

# =========================================================
# Execution Gate: Rollover Safety Guard (Morning Cutoff)
# =========================================================
# The daily rotation day flips at 11:30 AM IST (06:00 UTC = 360 minutes).
# A Microsoft Rewards session takes up to ~1 hour 55 minutes to finish.
# Therefore, the runner MUST START before 11:30 AM IST to lock in today's authentic
# shifted slot credentials. If GitHub Actions delays runner boot past 11:30 AM IST,
# the bootstrapper would fetch TOMORROW's credentials prematurely.
# If Slot 7, 8, or 9 boots at or after 11:30 AM IST, abort immediately and alert Discord.
if [ "$SLOT" = "7" ] || [ "$SLOT" = "8" ] || [ "$SLOT" = "9" ]; then
    CURRENT_UTC_H=$(date -u +%H)
    CURRENT_UTC_M=$(date -u +%M)
    TOTAL_UTC_MINS=$(( 10#$CURRENT_UTC_H * 60 + 10#$CURRENT_UTC_M ))

    # 11:30 AM IST = 06:00 UTC = 360 minutes.
    # Guard the morning slot window up to minute 600 (10:00 UTC / 3:30 PM IST).
    if [ "$TOTAL_UTC_MINS" -ge 360 ] && [ "$TOTAL_UTC_MINS" -lt 600 ]; then
        CURRENT_IST=$(TZ='Asia/Kolkata' date '+%I:%M %p IST' 2>/dev/null || date -u '+%H:%M UTC')
        CURRENT_UTC=$(date -u '+%H:%M UTC')
        GUARD_GROUP_NAME="${GROUP_ID:-}"
        if [ -z "$GUARD_GROUP_NAME" ] && [ -f runner_env.json ]; then
            GUARD_GROUP_NAME=$(jq -r '.group_id // .group // empty' runner_env.json 2>/dev/null || echo "")
        fi
        if [ -z "$GUARD_GROUP_NAME" ]; then
            GUARD_GROUP_NAME="Unknown"
        fi

        echo "=========================================================================="
        echo " ⏰ ROLLOVER GUARD TRIGGERED: Execution Aborted (Start Time Exceeded Cutoff)!"
        echo "    Runner Boot Time : $CURRENT_IST ($CURRENT_UTC)"
        echo "    Allowed Cutoff   : 11:30 AM IST (06:00 UTC)"
        echo "    Group: $GUARD_GROUP_NAME | Slot: $SLOT | Account: $ACCOUNT_EMAIL"
        echo "    Reason: Runner booted after 11:30 AM IST daily rollover boundary."
        echo "            Aborting run to prevent pulling tomorrow's rotated account credentials."
        echo "=========================================================================="

        echo "::warning title=Rollover Guard Aborted::Runner booted past 11:30 AM IST cutoff ($CURRENT_IST). Stopped Group $GUARD_GROUP_NAME Slot $SLOT ($ACCOUNT_EMAIL) to protect rotation integrity."

        # Send Discord Webhook Alert if configured
        DISCORD_URL="${DISCORD_WEBHOOK_URL:-}"
        if [ -z "$DISCORD_URL" ] && [ -f runner_env.json ]; then
            DISCORD_URL=$(jq -r '.discord_webhook_url // empty' runner_env.json 2>/dev/null || echo "")
        fi
        if [ -z "$DISCORD_URL" ] && [ -f .env ]; then
            DISCORD_URL=$(grep -E '^CONFIG_DISCORD_URL=' .env 2>/dev/null | cut -d '=' -f2- | tr -d '[:space:]' || echo "")
        fi

        if [ -n "$DISCORD_URL" ] && [ "$DISCORD_URL" != "null" ]; then
            DISCORD_DESC="Group **${GUARD_GROUP_NAME}** • Slot **${SLOT}** (${ACCOUNT_EMAIL}) was automatically aborted because GitHub Actions delayed the runner boot past the **11:30 AM IST** cutoff.\n\n🛡️ **Cross-Day Protection Active:** The run halted before acquiring credentials to prevent pulling tomorrow's rotated account."
            DISCORD_FOOTER="Autonomous Rollover Guard • Execution halted to ensure streak & rotation integrity."
            ISO_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

            DISCORD_PAYLOAD=$(jq -n \
                --arg group "$GUARD_GROUP_NAME" \
                --arg email "$ACCOUNT_EMAIL" \
                --arg slot "$SLOT" \
                --arg boot_time "$CURRENT_IST" \
                --arg desc "$DISCORD_DESC" \
                --arg footer "$DISCORD_FOOTER" \
                --arg ts "$ISO_TIMESTAMP" \
                '{
                    embeds: [{
                        title: "⏰ Rollover Guard: Morning Run Aborted",
                        description: $desc,
                        color: 16744448,
                        fields: [
                            { name: "Group", value: $group, inline: true },
                            { name: "Slot", value: ("Slot " + $slot), inline: true },
                            { name: "Runner Boot Time", value: $boot_time, inline: true },
                            { name: "Daily Cutoff Limit", value: "11:30 AM IST (06:00 UTC)", inline: true },
                            { name: "Safety Status", value: "Safely Aborted (Quota Preserved)", inline: true }
                        ],
                        footer: {
                            text: $footer
                        },
                        timestamp: $ts
                    }]
                }')

            echo "Sending Rollover Guard notification to Discord..."
            curl -s -X POST -H "Content-Type: application/json" -d "$DISCORD_PAYLOAD" "$DISCORD_URL" > /dev/null || true
        fi

        exit 0
    fi
fi

# =========================================================
# Execution Gate: Unified Pre-Flight Region & IP Shield
# (Supports Direct Connection, Cloudflare WARP, and Custom Proxy)
# =========================================================

# 1. Resolve Group & Slot Metadata
GROUP_NAME="${GROUP_ID:-}"
if [ -z "$GROUP_NAME" ] && [ -f runner_env.json ]; then
    GROUP_NAME=$(jq -r '.group_id // .group // empty' runner_env.json 2>/dev/null || echo "")
fi
[ -z "$GROUP_NAME" ] && GROUP_NAME="Unknown"

# 2. Autonomous Auto-Reroll & Human-like Delay Logic (Unified Engine)
trigger_autonomous_reroll() {
    local GUARD_TYPE="$1"
    local TITLE="$2"
    local REASON_SUMMARY="$3"
    local EMBED_COLOR="$4"
    local DETAIL_LABEL="$5"
    local DETAIL_VALUE="$6"

    RETRY_ATTEMPT="${RETRY_ATTEMPT:-0}"
    if ! [[ "$RETRY_ATTEMPT" =~ ^[0-9]+$ ]]; then
        RETRY_ATTEMPT=0
    fi

    PAT_TOKEN="${GH_PAT:-${AUTO_RERUN_TOKEN:-}}"
    MAX_RETRIES=3
    AUTO_REROLL_TRIGGERED=false
    BUFFER_DELAY=0

    # Determine target workflow file name
    TARGET_WORKFLOW="${WORKFLOW_FILE:-}"
    if [ -z "$TARGET_WORKFLOW" ] && [ -n "$GITHUB_WORKFLOW_REF" ]; then
        TARGET_WORKFLOW=$(basename "${GITHUB_WORKFLOW_REF%%@*}")
    fi

    if [ -n "$PAT_TOKEN" ] && [ "$PAT_TOKEN" != "null" ] && [ "$RETRY_ATTEMPT" -lt "$MAX_RETRIES" ] && [ -n "$TARGET_WORKFLOW" ]; then
        NEXT_ATTEMPT=$((RETRY_ATTEMPT + 1))
        BUFFER_DELAY=$((60 + RANDOM % 61)) # 60 to 120 seconds

        echo "=========================================================================="
        echo "🔄 AUTONOMOUS AUTO-REROLL: Dispatching replacement runner..."
        echo "   Guard Type:       $GUARD_TYPE"
        echo "   Target Workflow:  $TARGET_WORKFLOW"
        echo "   Branch / Ref:     ${GITHUB_REF_NAME:-main}"
        echo "   Attempt:          $NEXT_ATTEMPT of $MAX_RETRIES"
        echo "   Human Buffer:     ${BUFFER_DELAY}s (Queued job starts after current job exits)"
        echo "=========================================================================="

        DISPATCH_SUCCESS=false

        # Method 1: GitHub CLI (if gh binary is present)
        if command -v gh >/dev/null 2>&1; then
            if GH_TOKEN="$PAT_TOKEN" gh workflow run "$TARGET_WORKFLOW" \
                --ref "${GITHUB_REF_NAME:-main}" \
                -f retry_attempt="$NEXT_ATTEMPT" >/dev/null 2>&1; then
                DISPATCH_SUCCESS=true
            fi
        fi

        # Method 2: Fallback to GitHub REST API via curl
        if [ "$DISPATCH_SUCCESS" = "false" ] && [ -n "$GITHUB_REPOSITORY" ]; then
            HTTP_RESP=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
                -H "Authorization: Bearer $PAT_TOKEN" \
                -H "Accept: application/vnd.github+json" \
                "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/${TARGET_WORKFLOW}/dispatches" \
                -d "{\"ref\":\"${GITHUB_REF_NAME:-main}\",\"inputs\":{\"retry_attempt\":\"${NEXT_ATTEMPT}\"}}" 2>/dev/null || echo "000")
            if [ "$HTTP_RESP" = "204" ] || [ "$HTTP_RESP" = "200" ] || [ "$HTTP_RESP" = "201" ]; then
                DISPATCH_SUCCESS=true
            fi
        fi

        if [ "$DISPATCH_SUCCESS" = "true" ]; then
            AUTO_REROLL_TRIGGERED=true
            echo "✅ Replacement run successfully queued in GitHub Actions!"
        else
            echo "⚠️ Failed to dispatch replacement run via API. Proceeding with standard exit."
        fi
    elif [ "$RETRY_ATTEMPT" -ge "$MAX_RETRIES" ]; then
        echo "=========================================================================="
        echo "⛔ MAX AUTO-RETRIES REACHED ($RETRY_ATTEMPT/$MAX_RETRIES)!"
        echo "   Issue persisted across multiple attempts. Manual check required."
        echo "=========================================================================="
    fi

    echo "=========================================================================="
    echo "$TITLE"
    echo "   Group:            $GROUP_NAME"
    echo "   Slot:             Slot $SLOT"
    echo "   Account:          $ACCOUNT_EMAIL"
    echo "   Country:          $RUNNER_COUNTRY"
    echo "   Location:         $RUNNER_CITY, $RUNNER_REGION"
    echo "   Egress IP:        $RUNNER_IP"
    echo "   ISP / Org:        $RUNNER_ORG"
    echo "   Network Mode:     $NETWORK_MODE_LABEL"
    echo "   Reason:           $REASON_SUMMARY"
    if [ -n "$DETAIL_LABEL" ] && [ -n "$DETAIL_VALUE" ]; then
        echo "   $DETAIL_LABEL:    $DETAIL_VALUE"
    fi
    if [ "$AUTO_REROLL_TRIGGERED" = "true" ]; then
        echo "   Auto-Reroll:      Queued (Attempt $NEXT_ATTEMPT/$MAX_RETRIES, buffer: ${BUFFER_DELAY}s)"
    fi
    echo "--------------------------------------------------------------------------"
    echo "⛔ Aborting run to protect account: $ACCOUNT_EMAIL"
    if [ "$AUTO_REROLL_TRIGGERED" = "true" ]; then
        echo "💡 Replacement run is queued and will execute automatically after cooldown."
    else
        echo "💡 TIP: Click 'Re-run failed jobs' on GitHub to acquire a fresh runner."
    fi
    echo "=========================================================================="

    if [ "$AUTO_REROLL_TRIGGERED" = "true" ]; then
        echo "::error title=${GUARD_TYPE} Blocked (Auto-Reroll Queued)::${REASON_SUMMARY}. Stopped Group $GROUP_NAME Slot $SLOT ($ACCOUNT_EMAIL). Queued replacement run will launch in ~${BUFFER_DELAY}s (Attempt $NEXT_ATTEMPT/$MAX_RETRIES)."
    elif [ "$RETRY_ATTEMPT" -ge "$MAX_RETRIES" ]; then
        echo "::error title=${GUARD_TYPE} Blocked (Max Retries Reached)::${REASON_SUMMARY}. Stopped Group $GROUP_NAME Slot $SLOT ($ACCOUNT_EMAIL). Max auto-retries reached ($RETRY_ATTEMPT/$MAX_RETRIES)."
    else
        echo "::error title=${GUARD_TYPE} Blocked::${REASON_SUMMARY}. Stopped Group $GROUP_NAME Slot $SLOT ($ACCOUNT_EMAIL) to protect account."
    fi

    # Send Discord Webhook Alert if configured
    DISCORD_URL="${DISCORD_WEBHOOK_URL:-}"
    if [ -z "$DISCORD_URL" ] && [ -f runner_env.json ]; then
        DISCORD_URL=$(jq -r '.discord_webhook_url // empty' runner_env.json 2>/dev/null || echo "")
    fi
    if [ -z "$DISCORD_URL" ] && [ -f .env ]; then
        DISCORD_URL=$(grep -E '^CONFIG_DISCORD_URL=' .env 2>/dev/null | cut -d '=' -f2- | tr -d '[:space:]' || echo "")
    fi
    if [ -n "$DISCORD_URL" ] && [ "$DISCORD_URL" != "null" ]; then
        if [ "$AUTO_REROLL_TRIGGERED" = "true" ]; then
            DISCORD_DESC="Group **${GROUP_NAME}** • Slot **${SLOT}** (${ACCOUNT_EMAIL}) was stopped.\n**Reason:** ${REASON_SUMMARY}\n🔄 **Auto-Reroll Queued!** Fresh runner will start after ~${BUFFER_DELAY}s buffer (Attempt **${NEXT_ATTEMPT}** of ${MAX_RETRIES})."
            DISCORD_FOOTER="Autonomous Auto-Reroll Active • Queued run executes on fresh VM."
        elif [ "$RETRY_ATTEMPT" -ge "$MAX_RETRIES" ]; then
            DISCORD_DESC="Group **${GROUP_NAME}** • Slot **${SLOT}** (${ACCOUNT_EMAIL}) was stopped.\n**Reason:** ${REASON_SUMMARY}\n⛔ **Max Retries Reached (${RETRY_ATTEMPT}/${MAX_RETRIES})!**"
            DISCORD_FOOTER="Action: Issue persisted across multiple attempts. Manual check required."
        else
            DISCORD_DESC="Group **${GROUP_NAME}** • Slot **${SLOT}** (${ACCOUNT_EMAIL}) was stopped to protect the account.\n**Reason:** ${REASON_SUMMARY}"
            DISCORD_FOOTER="Action: Click Re-run failed jobs on GitHub to acquire a fresh runner."
        fi

        DISCORD_PAYLOAD=$(jq -n \
            --arg title "$TITLE" \
            --arg group "$GROUP_NAME" \
            --arg email "$ACCOUNT_EMAIL" \
            --arg slot "$SLOT" \
            --arg ip "$RUNNER_IP" \
            --arg country "$RUNNER_COUNTRY" \
            --arg city "$RUNNER_CITY" \
            --arg region "$RUNNER_REGION" \
            --arg mode "$NETWORK_MODE_LABEL" \
            --arg desc "$DISCORD_DESC" \
            --arg footer "$DISCORD_FOOTER" \
            --argjson color "$EMBED_COLOR" \
            --arg dlabel "$DETAIL_LABEL" \
            --arg dval "$DETAIL_VALUE" \
            '{
                embeds: [{
                    title: $title,
                    description: $desc,
                    color: $color,
                    fields: ([
                        { name: "Group", value: $group, inline: true },
                        { name: "Slot", value: ("Slot " + $slot), inline: true },
                        { name: "Network Mode", value: $mode, inline: true },
                        { name: "Country", value: $country, inline: true },
                        { name: "Location", value: ($city + ", " + $region), inline: true },
                        { name: "Egress IP", value: $ip, inline: true },
                        { name: "Account", value: $email, inline: false }
                    ] + (if ($dlabel != "" and $dval != "") then [{ name: $dlabel, value: $dval, inline: false }] else [] end)),
                    footer: { text: $footer },
                    timestamp: (now | todate)
                }]
            }' 2>/dev/null || echo "")

        if [ -n "$DISCORD_PAYLOAD" ]; then
            curl -s -H "Content-Type: application/json" -X POST -d "$DISCORD_PAYLOAD" "$DISCORD_URL" >/dev/null 2>&1 || true
        fi
    fi

    # Human-like buffer sleep before exiting so the queued job starts naturally
    if [ "$AUTO_REROLL_TRIGGERED" = "true" ]; then
        echo "⏳ Holding human-like buffer of ${BUFFER_DELAY}s before exiting so the queued job starts naturally..."
        sleep "$BUFFER_DELAY"
    fi

    exit 1
}

# 3. Detect Active Network Mode (WARP vs. Dedicated Custom Proxy vs. Direct)
IS_WARP_MODE=false
if [ -f .env ] && grep -q "USE_CLOUDFLARE_WARP=true" .env 2>/dev/null; then
    IS_WARP_MODE=true
elif [ -f runner_env.json ] && jq -e ".use_cloudflare_warp_${SLOT} == true or .use_cloudflare_warp == true" runner_env.json >/dev/null 2>&1; then
    IS_WARP_MODE=true
fi

IS_CUSTOM_PROXY=false
FULL_PROXY_URL=""
ACCOUNT_PROXY_URL=$(grep -E '^ACCOUNT_1_PROXY_URL=' .env 2>/dev/null | cut -d '=' -f2- | tr -d '[:space:]' || echo "")
ACCOUNT_PROXY_PORT=$(grep -E '^ACCOUNT_1_PROXY_PORT=' .env 2>/dev/null | cut -d '=' -f2- | tr -d '[:space:]' || echo "")

if [ -n "$ACCOUNT_PROXY_URL" ] && [ "$ACCOUNT_PROXY_URL" != "null" ]; then
    # Filter out local SOCKS5 proxy on 127.0.0.1 (which belongs to Cloudflare WARP)
    if ! echo "$ACCOUNT_PROXY_URL" | grep -qE "127\.0\.0\.1|localhost"; then
        IS_CUSTOM_PROXY=true
        FULL_PROXY_URL="$ACCOUNT_PROXY_URL"
        if [ -n "$ACCOUNT_PROXY_PORT" ] && [ "$ACCOUNT_PROXY_PORT" != "null" ] && ! echo "$ACCOUNT_PROXY_URL" | grep -qE ':[0-9]+$'; then
            FULL_PROXY_URL="${ACCOUNT_PROXY_URL}:${ACCOUNT_PROXY_PORT}"
        fi
    fi
fi

# Configure curl arguments for active network mode
GEO_CURL_ARGS=""
if [ "$IS_CUSTOM_PROXY" = "true" ]; then
    GEO_CURL_ARGS="-x $FULL_PROXY_URL"
    NETWORK_MODE_LABEL="Custom Proxy ($FULL_PROXY_URL)"
elif [ "$IS_WARP_MODE" = "true" ]; then
    GEO_CURL_ARGS="--socks5-hostname 127.0.0.1:40000"
    NETWORK_MODE_LABEL="Cloudflare WARP (SOCKS5 127.0.0.1:40000)"
else
    GEO_CURL_ARGS=""
    NETWORK_MODE_LABEL="Direct Connection (Host Runner IP)"
fi

echo "========================================================="
echo " [Pre-Flight IP Shield] Active Network Mode:"
echo "                         $NETWORK_MODE_LABEL"
echo "========================================================="

# 4. Multi-Provider Geolocation Resolver
resolve_active_geo() {
    local curl_opts="$1"
    local data=""
    local ip=""
    local country=""
    local region=""
    local city=""
    local org=""

    # Provider 1: ipinfo.io
    data=$(curl $curl_opts -s --connect-timeout 4 --max-time 8 https://ipinfo.io/json 2>/dev/null || echo "")
    if [ -n "$data" ]; then
        country=$(echo "$data" | jq -r '.country // empty' 2>/dev/null || echo "")
        if [ -n "$country" ] && [ ${#country} -eq 2 ]; then
            ip=$(echo "$data" | jq -r '.ip // empty' 2>/dev/null || echo "")
            region=$(echo "$data" | jq -r '.region // empty' 2>/dev/null || echo "")
            city=$(echo "$data" | jq -r '.city // empty' 2>/dev/null || echo "")
            org=$(echo "$data" | jq -r '.org // empty' 2>/dev/null || echo "")
            echo "$ip|$country|$region|$city|$org"
            return 0
        fi
    fi

    # Provider 2: ip-api.com
    data=$(curl $curl_opts -s --connect-timeout 4 --max-time 8 http://ip-api.com/json 2>/dev/null || echo "")
    if [ -n "$data" ]; then
        country=$(echo "$data" | jq -r '.countryCode // empty' 2>/dev/null || echo "")
        if [ -n "$country" ] && [ ${#country} -eq 2 ]; then
            ip=$(echo "$data" | jq -r '.query // empty' 2>/dev/null || echo "")
            region=$(echo "$data" | jq -r '.regionName // empty' 2>/dev/null || echo "")
            city=$(echo "$data" | jq -r '.city // empty' 2>/dev/null || echo "")
            org=$(echo "$data" | jq -r '.isp // empty' 2>/dev/null || echo "")
            echo "$ip|$country|$region|$city|$org"
            return 0
        fi
    fi

    # Provider 3: ifconfig.co
    data=$(curl $curl_opts -s --connect-timeout 4 --max-time 8 https://ifconfig.co/json 2>/dev/null || echo "")
    if [ -n "$data" ]; then
        country=$(echo "$data" | jq -r '.country_iso // empty' 2>/dev/null || echo "")
        if [ -n "$country" ] && [ ${#country} -eq 2 ]; then
            ip=$(echo "$data" | jq -r '.ip // empty' 2>/dev/null || echo "")
            region=$(echo "$data" | jq -r '.region_name // empty' 2>/dev/null || echo "")
            city=$(echo "$data" | jq -r '.city // empty' 2>/dev/null || echo "")
            org=$(echo "$data" | jq -r '.asn_org // empty' 2>/dev/null || echo "")
            echo "$ip|$country|$region|$city|$org"
            return 0
        fi
    fi

    # Provider 4 (Fallback for country only): ipinfo.io/country
    country=$(curl $curl_opts -s --connect-timeout 4 --max-time 8 https://ipinfo.io/country 2>/dev/null | tr -d '[:space:]' || echo "")
    if [ -n "$country" ] && [ ${#country} -eq 2 ]; then
        ip=$(curl $curl_opts -s --connect-timeout 4 --max-time 8 https://ifconfig.me 2>/dev/null | tr -d '[:space:]' || echo "Unknown")
        echo "$ip|$country|Unknown|Unknown|Unknown"
        return 0
    fi

    return 1
}

# 5. In-Flight WARP Reconnect Engine
rotate_warp_tunnel() {
    local attempt="$1"
    local max_attempts=3
    echo "=========================================================================="
    echo "🔄 [WARP Shield] Attempting in-flight WARP tunnel rotation (Attempt $attempt of $max_attempts)..."
    echo "=========================================================================="

    sudo warp-cli --accept-tos disconnect 2>/dev/null || true
    sleep 2
    sudo warp-cli --accept-tos connect 2>/dev/null || true

    local healthy=false
    for i in 1 2 3 4 5; do
        if curl --socks5-hostname 127.0.0.1:40000 -s --max-time 4 https://cloudflare.com/cdn-cgi/trace 2>/dev/null | grep -q "warp=on"; then
            healthy=true
            break
        fi
        sleep 1
    done

    if [ "$healthy" = "true" ]; then
        echo "✅ [WARP Shield] SOCKS5 tunnel active on 127.0.0.1:40000. Re-auditing fresh egress IP..."
        return 0
    else
        echo "⚠️ [WARP Shield] WARP tunnel failed to reconnect."
        return 1
    fi
}

# 6. Two-Tier Pre-Flight Verification Engine

# ==============================================================================
# Tier 1: Host-Level Region Guard (Direct GitHub Actions Runner VM Audit)
# Audits physical datacenter location for ALL accounts before proxy/WARP steps
# ==============================================================================
echo "========================================================="
echo " [Tier 1 Pre-Flight] Auditing Direct GitHub Host Runner IP..."
echo "========================================================="

HOST_RUNNER_GEO=""
for attempt in 1 2 3; do
    HOST_RUNNER_GEO=$(resolve_active_geo "" || echo "")
    if [ -n "$HOST_RUNNER_GEO" ]; then
        break
    fi
    echo "[-] Host geolocation lookup attempt $attempt/3 failed. Retrying in 2 seconds..."
    sleep 2
done

if [ -z "$HOST_RUNNER_GEO" ]; then
    echo "=========================================================================="
    echo "🚨 ERROR: Unable to verify GitHub host runner IP geolocation after 3 attempts."
    echo "=========================================================================="
    echo "::error title=Host Region Guard::Failed to resolve GitHub host runner IP geolocation after 3 attempts. Aborted for account safety."
    exit 1
fi

IFS="|" read -r HOST_RUNNER_IP HOST_RUNNER_COUNTRY HOST_RUNNER_REGION HOST_RUNNER_CITY HOST_RUNNER_ORG <<< "$HOST_RUNNER_GEO"

# Enforce US-only Physical Runner Datacenter
if [ "$HOST_RUNNER_COUNTRY" != "US" ]; then
    echo "=========================================================================="
    echo "🚨 [Host Region Guard] Foreign GitHub runner detected ($HOST_RUNNER_COUNTRY - $HOST_RUNNER_CITY, $HOST_RUNNER_REGION)."
    echo "   Aborting run immediately to prevent non-US execution."
    echo "=========================================================================="
    RUNNER_IP="$HOST_RUNNER_IP"
    RUNNER_COUNTRY="$HOST_RUNNER_COUNTRY"
    RUNNER_CITY="$HOST_RUNNER_CITY"
    RUNNER_REGION="$HOST_RUNNER_REGION"
    RUNNER_ORG="$HOST_RUNNER_ORG"
    trigger_autonomous_reroll \
        "Host Region Guard" \
        "🚨 REGION GUARD: NON-US GITHUB RUNNER IP DETECTED!" \
        "GitHub Actions runner VM is physically located in a foreign datacenter ($HOST_RUNNER_COUNTRY - $HOST_RUNNER_CITY, $HOST_RUNNER_REGION)" \
        16711680 \
        "Foreign Host Location" \
        "$HOST_RUNNER_CITY, $HOST_RUNNER_REGION ($HOST_RUNNER_COUNTRY) [Host IP: $HOST_RUNNER_IP - $HOST_RUNNER_ORG]"
fi

echo "✅ [Host Region Guard] Verified US GitHub runner: $HOST_RUNNER_IP ($HOST_RUNNER_CITY, $HOST_RUNNER_REGION - $HOST_RUNNER_ORG)."

# ==============================================================================
# Tier 2: Egress-Level Shield (Cloudflare WARP / Custom Proxy / Direct)
# ==============================================================================
echo "========================================================="
echo " [Tier 2 Pre-Flight] Auditing Active Network Egress IP..."
echo "                     Mode: $NETWORK_MODE_LABEL"
echo "========================================================="

MAX_WARP_ROTATIONS=3
[ "$IS_WARP_MODE" != "true" ] && MAX_WARP_ROTATIONS=1

RUNNER_IP=""
RUNNER_COUNTRY=""
RUNNER_REGION=""
RUNNER_CITY=""
RUNNER_ORG=""

for warp_try in $(seq 1 $MAX_WARP_ROTATIONS); do
    RUNNER_GEO=""
    if [ "$IS_WARP_MODE" != "true" ] && [ "$IS_CUSTOM_PROXY" != "true" ]; then
        # Direct Mode: Re-use verified Tier 1 Host Runner IP without redundant network call
        RUNNER_GEO="$HOST_RUNNER_GEO"
    else
        for attempt in 1 2 3; do
            RUNNER_GEO=$(resolve_active_geo "$GEO_CURL_ARGS" || echo "")
            if [ -n "$RUNNER_GEO" ]; then
                break
            fi
            echo "[-] Egress geolocation lookup attempt $attempt/3 failed. Retrying in 2 seconds..."
            sleep 2
        done
    fi

    if [ -z "$RUNNER_GEO" ]; then
        echo "=========================================================================="
        echo "🚨 ERROR: Unable to verify active egress IP geolocation after 3 attempts."
        echo "          Mode: $NETWORK_MODE_LABEL"
        echo "=========================================================================="
        echo "::error title=Region Guard::Failed to resolve active egress IP geolocation after 3 attempts. Aborted for account safety."
        exit 1
    fi

    IFS="|" read -r RUNNER_IP RUNNER_COUNTRY RUNNER_REGION RUNNER_CITY RUNNER_ORG <<< "$RUNNER_GEO"

    # Region Guard: US Egress Verification
    if [ "$RUNNER_COUNTRY" != "US" ]; then
        if [ "$IS_WARP_MODE" = "true" ] && [ "$warp_try" -lt "$MAX_WARP_ROTATIONS" ]; then
            echo "⚠️ [Region Guard] Non-US WARP egress detected ($RUNNER_COUNTRY - $RUNNER_CITY, $RUNNER_REGION)."
            rotate_warp_tunnel "$warp_try"
            continue
        fi
        GUARD_TITLE="🚨 REGION GUARD: NON-US EGRESS IP DETECTED!"
        [ "$IS_WARP_MODE" = "true" ] && GUARD_TITLE="🚨 REGION GUARD: NON-US WARP EGRESS IP DETECTED!"
        [ "$IS_CUSTOM_PROXY" = "true" ] && GUARD_TITLE="🚨 REGION GUARD: NON-US PROXY EGRESS IP DETECTED!"
        trigger_autonomous_reroll \
            "Egress Region Guard" \
            "$GUARD_TITLE" \
            "Non-US egress IP detected ($RUNNER_COUNTRY - $RUNNER_CITY, $RUNNER_REGION) via $NETWORK_MODE_LABEL" \
            16711680 \
            "Foreign Location" \
            "$RUNNER_CITY, $RUNNER_REGION ($RUNNER_COUNTRY)"
    fi

    echo "✅ [Egress Guard] Verified US egress: $RUNNER_IP ($RUNNER_CITY, $RUNNER_REGION - $RUNNER_ORG)."

    # Pre-Flight IP Collision & Frequency Shield (MongoDB Atlas)
    if [ -n "$RUNNER_IP" ] && [ "$RUNNER_IP" != "null" ] && [ -f verify-ip-guard.cjs ]; then
        echo "🛡️ [IP Collision Shield] Auditing IP collision & frequency gates in MongoDB Atlas..."
        IP_GUARD_RAW=$(node verify-ip-guard.cjs "$RUNNER_IP" "$RUNNER_COUNTRY" "$RUNNER_REGION" "$RUNNER_CITY" "$RUNNER_ORG" "$SLOT" 2>&1)
        IP_GUARD_EXIT=$?

        IP_GUARD_JSON=$(echo "$IP_GUARD_RAW" | grep -E '^\{.*\}$' | tail -n 1 || echo "")
        IP_STATUS=$(echo "$IP_GUARD_JSON" | jq -r '.status // empty' 2>/dev/null || echo "")

        if [ "$IP_GUARD_EXIT" -eq 2 ] || [ "$IP_STATUS" = "BLOCKED" ]; then
            GATE=$(echo "$IP_GUARD_JSON" | jq -r '.gate // "COOLDOWN"' 2>/dev/null || echo "COOLDOWN")
            REASON=$(echo "$IP_GUARD_JSON" | jq -r '.reason // "IP collision detected"' 2>/dev/null || echo "IP collision detected")
            DETAIL_STR=$(echo "$IP_GUARD_JSON" | jq -r '.detail_str // empty' 2>/dev/null || echo "")

            if [ "$IS_WARP_MODE" = "true" ] && [ "$warp_try" -lt "$MAX_WARP_ROTATIONS" ]; then
                echo "⚠️ [IP Collision Shield] Blocked ($GATE: $REASON) on WARP IP: $RUNNER_IP."
                rotate_warp_tunnel "$warp_try"
                continue
            fi

            if [ "$GATE" = "DAILY_CAP" ]; then
                trigger_autonomous_reroll \
                    "IP Frequency Guard" \
                    "🛡️ PRE-FLIGHT GUARD: DAILY IP CAP REACHED!" \
                    "$REASON" \
                    15105570 \
                    "Daily Cap Status" \
                    "$DETAIL_STR"
            else
                trigger_autonomous_reroll \
                    "IP Collision Guard" \
                    "🛡️ PRE-FLIGHT GUARD: IP COLLISION AVOIDED!" \
                    "$REASON" \
                    15105570 \
                    "Collision Detail" \
                    "$DETAIL_STR"
            fi
        else
            PASS_MSG=$(echo "$IP_GUARD_JSON" | jq -r '.message // empty' 2>/dev/null || echo "")
            if [ -n "$PASS_MSG" ]; then
                echo "✅ [IP Collision Shield] $PASS_MSG"
            else
                echo "✅ [IP Collision Shield] Egress IP verified clean ($RUNNER_IP)."
            fi
        fi
    elif [ -n "$RUNNER_IP" ] && [ "$RUNNER_IP" != "null" ] && [ -f log-ip-mongo.cjs ]; then
        echo "📡 [IP Telemetry] Recording active egress IP to MongoDB..."
        node log-ip-mongo.cjs "$RUNNER_IP" "$RUNNER_COUNTRY" "$RUNNER_REGION" "$RUNNER_CITY" "$RUNNER_ORG" "$SLOT" || echo "[-] IP logging warning (non-fatal)."
    fi

    # Verified and passed!
    break
done

# Common function to run container (defined FIRST)
run_container() {
    echo -e "\n=== Running Container ==="
    echo "Running with custom flags:"
    echo "  --shm-size=4g"
    echo "  -e MIN_SLEEP_MINUTES=15"
    echo "  -e MAX_SLEEP_MINUTES=50"
    echo "  -e SKIP_RANDOM_SLEEP=true"
    echo "  --env-file .env"

    # Process config.json Override right before running
    # CRITICAL FIX: We MUST always mount the config directory even if there is no override,
    # otherwise the container's entrypoint crashes trying to copy the example file into a missing folder!
    mkdir -p config
    CONFIG_OVERRIDE=$(jq -r ".config_override_$SLOT" runner_env.json)
    if [ "$CONFIG_OVERRIDE" != "null" ] && [ -n "$CONFIG_OVERRIDE" ]; then
        echo "$CONFIG_OVERRIDE" > config/config.json
        echo "[!] Applied custom config.json override from MSR-Database."
    else
        echo "[-] Using default config settings from runner template."
        if [ -f runner_templates/config.json ]; then
            cp runner_templates/config.json config/config.json
        fi
    fi
    VOLUME_MOUNT="-v $(pwd)/config:/usr/src/microsoft-rewards-script/config"

    WARP_NETWORK_ARG=""
    if grep -q "USE_CLOUDFLARE_WARP=true" .env 2>/dev/null; then
        echo "[run.sh] 🌐 Cloudflare WARP is enabled: binding container with --net=host to access host SOCKS5 proxy."
        WARP_NETWORK_ARG="--net=host"
    fi

    # 1. Inspect active config.json for headless preference
    CONFIG_HEADLESS_VAL=""
    if [ -f config/config.json ]; then
        CONFIG_HEADLESS_VAL=$(jq -r 'if .headless != null then .headless else empty end' config/config.json 2>/dev/null || echo "")
    fi

    # 2. Extract account-anchored VNC preference from .env or runner_env.json
    RAW_VNC_PREF=""
    if [ -f .env ]; then
        RAW_VNC_PREF=$(grep -E '^ENABLE_LIVE_VNC=' .env 2>/dev/null | cut -d '=' -f2- | tr -d '[:space:]' || echo "")
    fi
    if [ -z "$RAW_VNC_PREF" ] && [ -f runner_env.json ]; then
        RAW_VNC_PREF=$(jq -r ".enable_live_vnc_${SLOT} // .enable_live_vnc // empty" runner_env.json 2>/dev/null || echo "")
    fi
    [ -z "$RAW_VNC_PREF" ] && RAW_VNC_PREF="auto"

    # 3. Resolve final VNC state
    FINAL_ENABLE_LIVE_VNC="auto"
    if [ "$RAW_VNC_PREF" = "disabled" ] || [ "$RAW_VNC_PREF" = "false" ]; then
        FINAL_ENABLE_LIVE_VNC="disabled"
        if [ "$CONFIG_HEADLESS_VAL" = "false" ]; then
            echo "[run.sh] 🚫 Live Web-VNC is explicitly DISABLED for this account."
            echo "[run.sh] 🖥️ Running in Pure Virtual Headed Mode (XVFB) without VNC tunnel (like v4)."
        else
            echo "[run.sh] 🕶️ Standard Headless Mode active (VNC disabled)."
        fi
    elif [ "$RAW_VNC_PREF" = "enabled" ] || [ "$RAW_VNC_PREF" = "true" ]; then
        FINAL_ENABLE_LIVE_VNC="true"
        echo "[run.sh] 📺 On-Demand Live Web-VNC Observation is FORCED ENABLED for this account."
        sed -i '/^CONFIG_HEADLESS=/d' .env 2>/dev/null || true
        echo "CONFIG_HEADLESS=false" >> .env
    else
        # 'auto' mode: Follow config.json headless setting
        if [ "$CONFIG_HEADLESS_VAL" = "false" ]; then
            FINAL_ENABLE_LIVE_VNC="true"
            echo "[run.sh] 🖥️ 'headless: false' detected in config.json + auto VNC mode -> Live Web-VNC enabled."
        elif [ "$CONFIG_HEADLESS_VAL" = "true" ]; then
            FINAL_ENABLE_LIVE_VNC="false"
            echo "[run.sh] 🕶️ 'headless: true' detected in config.json -> Standard Headless Mode active."
        else
            FINAL_ENABLE_LIVE_VNC="auto"
            echo "[run.sh] ⚙️ Live Web-VNC set to AUTO (will follow container internal headless setting)."
        fi
    fi

    # Sync into .env so container receives clean variable
    sed -i '/^ENABLE_LIVE_VNC=/d' .env 2>/dev/null || true
    echo "ENABLE_LIVE_VNC=${FINAL_ENABLE_LIVE_VNC}" >> .env

    # Run container in detached mode (Passing .env so the container gets the Bootstrapper variables)
    CONTAINER_ID=$(docker run -d \
      --shm-size=4g \
      $WARP_NETWORK_ARG \
      -e MIN_SLEEP_MINUTES=15 \
      -e MAX_SLEEP_MINUTES=50 \
      -e SKIP_RANDOM_SLEEP=true \
      -e GH_PAT="${GH_PAT:-}" \
      -e VAULT_REPO="${VAULT_REPO:-}" \
      -e GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-}" \
      -e GROUP_ID="${GROUP_ID:-}" \
      -e SLOT="${SLOT:-}" \
      -e ENABLE_LIVE_VNC="${FINAL_ENABLE_LIVE_VNC}" \
      --env-file .env \
      $VOLUME_MOUNT \
      $FINAL_IMAGE \
      /bin/bash /usr/src/microsoft-rewards-script/scripts/docker/run_daily.sh)

    echo "Container started with ID: $CONTAINER_ID"

    # Stream logs to console while persisting to container.log for post-run telemetry
    docker logs -f "$CONTAINER_ID" 2>&1 | tee container.log

    # Capture container exit code
    EXIT_CODE=$(docker wait "$CONTAINER_ID" || echo "0")
    echo "$EXIT_CODE" > container.exitcode

    echo "Container execution finished with exit code: $EXIT_CODE"

    # Cleanup
    echo "Cleaning up container..."
    docker rm -f "$CONTAINER_ID" || true
}

# Process Docker Image/Dockerfile Override
DOCKER_OVERRIDE=$(jq -r ".docker_override_$SLOT" runner_env.json)

if [ "$DOCKER_OVERRIDE" != "null" ] && [ -n "$DOCKER_OVERRIDE" ]; then
    # Check if the override looks like a full Dockerfile (starts with FROM or contains FROM)
    if echo "$DOCKER_OVERRIDE" | grep -qE "(^|\n)FROM "; then
        echo "[!] Detected full Dockerfile override. Building custom image locally..."
        echo "$DOCKER_OVERRIDE" > Dockerfile.custom
        
        # Find the FROM line and extract the image name
        BASE_IMAGE=$(grep -m1 '^FROM' Dockerfile.custom | sed 's/^FROM //' | tr -d '[:space:]')
        
        if [ -z "$BASE_IMAGE" ]; then
            echo "ERROR: Could not find base image in custom Dockerfile!"
            exit 1
        fi
        
        echo "Found base image in Dockerfile: $BASE_IMAGE"
        SHOULD_BUILD=true
    else
        echo "[!] Using custom Docker image tag: $DOCKER_OVERRIDE"
        FINAL_IMAGE="$DOCKER_OVERRIDE"
        SHOULD_BUILD=false
    fi
else
    echo "[-] Using default Docker image."
    FINAL_IMAGE="ghcr.io/tvkk0539/netsky-new-v5-custom:latest"
    SHOULD_BUILD=false
fi

if [ "$SHOULD_BUILD" = false ]; then
    echo "Skipping build phase. Proceeding to run..."
    run_container
    exit 0
fi

echo "=== Phase 1: Try normal build first ==="
NORMAL_SUCCESS=false

# Try normal build 3 times
for attempt in {1..3}; do
    echo "Normal build attempt $attempt of 3..."
    if docker build -t myimage:latest -f Dockerfile.custom .; then
        echo "✅ Normal build successful!"
        NORMAL_SUCCESS=true
        break
    else
        if [ $attempt -lt 3 ]; then
            echo "Normal build failed, retrying in 5 seconds..."
            sleep 5
        fi
    fi
done

# If normal build succeeded, skip to run
if [ "$NORMAL_SUCCESS" = true ]; then
    echo "Build successful! Proceeding to run..."
    FINAL_IMAGE="myimage:latest"
    run_container
    exit 0
fi

echo -e "\n=== Phase 2: Normal build failed, trying optimized approach ==="

# 1. Increase Docker timeouts
echo "Increasing Docker timeouts..."
sudo tee /etc/docker/daemon.json << EOF2
{
  "max-concurrent-downloads": 1,
  "max-download-attempts": 5,
  "dns": ["8.8.8.8", "1.1.1.1"]
}
EOF2
sudo systemctl restart docker || sudo service docker restart

# 2. Pre-pull the base image with retry (using extracted image name)
echo "Pre-pulling base image..."
echo "Base image to pull: $BASE_IMAGE"

for attempt in {1..5}; do
    echo "Pull attempt $attempt of 5..."
    if docker pull "$BASE_IMAGE"; then
        echo "Successfully pulled base image"
        break
    else
        if [ $attempt -eq 5 ]; then
            echo "All pull attempts failed. Trying alternative approach..."
            # Continue anyway, build might use cache
        else
            echo "Pull failed, retrying in 15 seconds..."
            sleep 15
        fi
    fi
done

# 3. Build with retry logic
echo "Building Docker image..."
for attempt in {1..3}; do
    echo "Build attempt $attempt of 3..."

    # Enable BuildKit for better caching
    DOCKER_BUILDKIT=1 docker build \
        --progress=plain \
        --no-cache \
        -f Dockerfile.custom \
        -t myimage:latest . && break

    if [ $attempt -lt 3 ]; then
        echo "Build failed, cleaning cache and retrying in 10 seconds..."
        docker builder prune -f
        sleep 10
    else
        echo "All build attempts failed!"
        exit 1
    fi
done

echo "Build successful!"

FINAL_IMAGE="myimage:latest"
# Call the common run function
run_container
