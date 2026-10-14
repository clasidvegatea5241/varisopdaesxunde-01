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
# If Slot 7 boots at or after 11:30 AM IST, abort immediately and alert Discord.
if [ "$SLOT" = "7" ]; then
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
# Execution Gate: Region Guard (US IP Verification)
# =========================================================
ACCOUNT_PROXY_URL=$(grep -E '^ACCOUNT_1_PROXY_URL=' .env 2>/dev/null | cut -d '=' -f2- | tr -d '[:space:]' || echo "")

if [ -n "$ACCOUNT_PROXY_URL" ] && [ "$ACCOUNT_PROXY_URL" != "null" ]; then
    echo "========================================================="
    echo " [Region Guard] Account configured with dedicated proxy:"
    echo "                 URL: $ACCOUNT_PROXY_URL"
    echo "                 Browser traffic will route through proxy."
    echo "                 Host runner IP check bypassed."
    echo "========================================================="
    # Resolve proxy egress IP for telemetry logging
    PROXY_DATA=$(curl -s -x "$ACCOUNT_PROXY_URL" --connect-timeout 4 --max-time 8 https://ipinfo.io/json 2>/dev/null || echo "")
    if [ -n "$PROXY_DATA" ]; then
        RUNNER_IP=$(echo "$PROXY_DATA" | jq -r '.ip // empty' 2>/dev/null || echo "")
        RUNNER_COUNTRY=$(echo "$PROXY_DATA" | jq -r '.country // "US"' 2>/dev/null || echo "US")
        RUNNER_REGION=$(echo "$PROXY_DATA" | jq -r '.region // "Proxy"' 2>/dev/null || echo "Proxy")
        RUNNER_CITY=$(echo "$PROXY_DATA" | jq -r '.city // "Proxy"' 2>/dev/null || echo "Proxy")
        RUNNER_ORG=$(echo "$PROXY_DATA" | jq -r '.org // "Proxy"' 2>/dev/null || echo "Proxy")
    fi
else
    echo "========================================================="
    echo " [Region Guard] Direct connection detected (No proxy)."
    echo "                 Verifying host runner IP is located in the US..."
    echo "========================================================="

    resolve_runner_geo() {
        local data=""
        local ip=""
        local country=""
        local region=""
        local city=""
        local org=""

        # Provider 1: ipinfo.io
        data=$(curl -s --connect-timeout 4 --max-time 8 https://ipinfo.io/json 2>/dev/null || echo "")
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
        data=$(curl -s --connect-timeout 4 --max-time 8 http://ip-api.com/json 2>/dev/null || echo "")
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
        data=$(curl -s --connect-timeout 4 --max-time 8 https://ifconfig.co/json 2>/dev/null || echo "")
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
        country=$(curl -s --connect-timeout 4 --max-time 8 https://ipinfo.io/country 2>/dev/null | tr -d '[:space:]' || echo "")
        if [ -n "$country" ] && [ ${#country} -eq 2 ]; then
            ip=$(curl -s --connect-timeout 4 --max-time 8 https://ifconfig.me 2>/dev/null | tr -d '[:space:]' || echo "Unknown")
            echo "$ip|$country|Unknown|Unknown|Unknown"
            return 0
        fi

        return 1
    }

    RUNNER_GEO=""
    for attempt in 1 2 3; do
        RUNNER_GEO=$(resolve_runner_geo || echo "")
        if [ -n "$RUNNER_GEO" ]; then
            break
        fi
        echo "[-] Geolocation lookup attempt $attempt/3 failed. Retrying in 2 seconds..."
        sleep 2
    done

    if [ -z "$RUNNER_GEO" ]; then
        echo "=========================================================================="
        echo "🚨 ERROR: Unable to verify runner IP geolocation after 3 attempts."
        echo "          Direct-connection mode requires verified US IP for account safety."
        echo "=========================================================================="
        echo "::error title=Region Guard::Failed to resolve runner IP geolocation after 3 attempts. Aborted for account safety."
        exit 1
    fi

    IFS="|" read -r RUNNER_IP RUNNER_COUNTRY RUNNER_REGION RUNNER_CITY RUNNER_ORG <<< "$RUNNER_GEO"

    if [ "$RUNNER_COUNTRY" != "US" ]; then
        # Resolve Group Name/ID
        GROUP_NAME="${GROUP_ID:-}"
        if [ -z "$GROUP_NAME" ] && [ -f runner_env.json ]; then
            GROUP_NAME=$(jq -r '.group_id // .group // empty' runner_env.json 2>/dev/null || echo "")
        fi
        if [ -z "$GROUP_NAME" ]; then
            GROUP_NAME="Unknown"
        fi

        # ------------------------------------------------------------------
        # Autonomous Auto-Reroll & Human-like Delay Logic
        # ------------------------------------------------------------------
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
            echo "   Foreign IP persisted across multiple attempts. Manual check required."
            echo "=========================================================================="
        fi

        echo "=========================================================================="
        echo "🚨 REGION GUARD: NON-US RUNNER DETECTED!"
        echo "   Group:            $GROUP_NAME"
        echo "   Slot:             Slot $SLOT"
        echo "   Account:          $ACCOUNT_EMAIL"
        echo "   Country:          $RUNNER_COUNTRY"
        echo "   Location:         $RUNNER_CITY, $RUNNER_REGION"
        echo "   Runner Public IP: $RUNNER_IP"
        echo "   ISP / Org:        $RUNNER_ORG"
        if [ "$AUTO_REROLL_TRIGGERED" = "true" ]; then
            echo "   Auto-Reroll:      Queued (Attempt $NEXT_ATTEMPT/$MAX_RETRIES, buffer: ${BUFFER_DELAY}s)"
        fi
        echo "--------------------------------------------------------------------------"
        echo "⛔ Policy requires US IP only. Aborting run to protect account: $ACCOUNT_EMAIL"
        if [ "$AUTO_REROLL_TRIGGERED" = "true" ]; then
            echo "💡 Replacement run is queued and will execute automatically after cooldown."
        else
            echo "💡 TIP: Click 'Re-run failed jobs' on GitHub to acquire a fresh US runner."
        fi
        echo "=========================================================================="

        if [ "$AUTO_REROLL_TRIGGERED" = "true" ]; then
            echo "::error title=Region Guard Blocked (Auto-Reroll Queued)::Non-US runner IP detected ($RUNNER_COUNTRY - $RUNNER_CITY, $RUNNER_REGION). Stopped Group $GROUP_NAME Slot $SLOT ($ACCOUNT_EMAIL). Queued replacement run will launch in ~${BUFFER_DELAY}s (Attempt $NEXT_ATTEMPT/$MAX_RETRIES)."
        elif [ "$RETRY_ATTEMPT" -ge "$MAX_RETRIES" ]; then
            echo "::error title=Region Guard Blocked (Max Retries Reached)::Non-US runner IP detected ($RUNNER_COUNTRY - $RUNNER_CITY, $RUNNER_REGION). Stopped Group $GROUP_NAME Slot $SLOT ($ACCOUNT_EMAIL). Max auto-retries reached ($RETRY_ATTEMPT/$MAX_RETRIES)."
        else
            echo "::error title=Region Guard Blocked::Non-US runner IP detected ($RUNNER_COUNTRY - $RUNNER_CITY, $RUNNER_REGION). Stopped Group $GROUP_NAME Slot $SLOT ($ACCOUNT_EMAIL) to protect account. Click 'Re-run failed jobs' to get a US runner."
        fi

        # Send Discord Webhook Alert if configured (Supports Secrets, Matrix DB runner_env.json, and .env)
        DISCORD_URL="${DISCORD_WEBHOOK_URL:-}"
        if [ -z "$DISCORD_URL" ] && [ -f runner_env.json ]; then
            DISCORD_URL=$(jq -r '.discord_webhook_url // empty' runner_env.json 2>/dev/null || echo "")
        fi
        if [ -z "$DISCORD_URL" ] && [ -f .env ]; then
            DISCORD_URL=$(grep -E '^CONFIG_DISCORD_URL=' .env 2>/dev/null | cut -d '=' -f2- | tr -d '[:space:]' || echo "")
        fi
        if [ -n "$DISCORD_URL" ] && [ "$DISCORD_URL" != "null" ]; then
            if [ "$AUTO_REROLL_TRIGGERED" = "true" ]; then
                DISCORD_DESC="Group **${GROUP_NAME}** • Slot **${SLOT}** (${ACCOUNT_EMAIL}) was aborted due to foreign IP.\n🔄 **Auto-Reroll Queued!** Fresh runner will start after ~${BUFFER_DELAY}s buffer (Attempt **${NEXT_ATTEMPT}** of ${MAX_RETRIES})."
                DISCORD_FOOTER="Autonomous Auto-Reroll Active • Queued run executes on fresh VM."
            elif [ "$RETRY_ATTEMPT" -ge "$MAX_RETRIES" ]; then
                DISCORD_DESC="Group **${GROUP_NAME}** • Slot **${SLOT}** (${ACCOUNT_EMAIL}) was aborted due to foreign IP.\n⛔ **Max Retries Reached (${RETRY_ATTEMPT}/${MAX_RETRIES})!** Foreign IP persisted."
                DISCORD_FOOTER="Action: Azure may be experiencing regional congestion. Manual check required."
            else
                DISCORD_DESC="Group **${GROUP_NAME}** • Slot **${SLOT}** (${ACCOUNT_EMAIL}) was aborted to protect the account from running on a foreign IP."
                DISCORD_FOOTER="Action: Click Re-run failed jobs on GitHub to acquire a US runner."
            fi

            DISCORD_PAYLOAD=$(jq -n \
                --arg group "$GROUP_NAME" \
                --arg email "$ACCOUNT_EMAIL" \
                --arg slot "$SLOT" \
                --arg ip "$RUNNER_IP" \
                --arg country "$RUNNER_COUNTRY" \
                --arg city "$RUNNER_CITY" \
                --arg region "$RUNNER_REGION" \
                --arg desc "$DISCORD_DESC" \
                --arg footer "$DISCORD_FOOTER" \
                '{
                    embeds: [{
                        title: "🚨 Region Guard: Non-US Runner Blocked",
                        description: $desc,
                        color: 16711680,
                        fields: [
                            { name: "Group", value: $group, inline: true },
                            { name: "Slot", value: ("Slot " + $slot), inline: true },
                            { name: "Country", value: $country, inline: true },
                            { name: "Location", value: ($city + ", " + $region), inline: true },
                            { name: "Runner IP", value: $ip, inline: true },
                            { name: "Account", value: $email, inline: false }
                        ],
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
    fi

    echo "✅ [Region Guard] Verified US runner: $RUNNER_IP ($RUNNER_CITY, $RUNNER_REGION - $RUNNER_ORG)."
fi

# =========================================================
# IP Telemetry & Intelligence Ingestion
# =========================================================
if [ -n "$RUNNER_IP" ] && [ "$RUNNER_IP" != "null" ] && [ -f log-ip-mongo.cjs ]; then
    echo "📡 [IP Telemetry] Recording runner IP intelligence to MongoDB..."
    node log-ip-mongo.cjs "$RUNNER_IP" "$RUNNER_COUNTRY" "$RUNNER_REGION" "$RUNNER_CITY" "$RUNNER_ORG" "$SLOT" || echo "[-] IP logging warning (non-fatal)."
fi

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
        echo "[-] Using default config settings. (Mounted empty config dir to prevent crash)"
    fi
    VOLUME_MOUNT="-v $(pwd)/config:/usr/src/microsoft-rewards-script/config"

    # Run container in detached mode (Passing .env so the container gets the Bootstrapper variables)
    CONTAINER_ID=$(docker run -d \
      --shm-size=4g \
      -e MIN_SLEEP_MINUTES=15 \
      -e MAX_SLEEP_MINUTES=50 \
      -e SKIP_RANDOM_SLEEP=true \
      -e GH_PAT="${GH_PAT:-}" \
      -e VAULT_REPO="${VAULT_REPO:-}" \
      -e GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-}" \
      -e GROUP_ID="${GROUP_ID:-}" \
      -e SLOT="${SLOT:-}" \
      --env-file .env \
      $VOLUME_MOUNT \
      $FINAL_IMAGE)

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
    FINAL_IMAGE="ghcr.io/thenetsky/microsoft-rewards-script:4"
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
