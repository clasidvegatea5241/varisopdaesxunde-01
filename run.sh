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
# Execution Gate: Region Guard (US IP Verification)
# =========================================================
ACCOUNT_PROXY_URL=$(grep -E '^ACCOUNT_1_PROXY_URL=' .env 2>/dev/null | cut -d '=' -f2- | tr -d '[:space:]' || echo "")
ACCOUNT_PROXY_HTTP=$(grep -E '^ACCOUNT_1_PROXY_HTTP=' .env 2>/dev/null | cut -d '=' -f2- | tr -d '[:space:]' || echo "")

if [ -n "$ACCOUNT_PROXY_URL" ] && [ "$ACCOUNT_PROXY_URL" != "null" ]; then
    echo "========================================================="
    echo " [Region Guard] Account configured with dedicated proxy:"
    echo "                 URL: $ACCOUNT_PROXY_URL"
    echo "                 Browser traffic will route through proxy."
    echo "                 Host runner IP check bypassed."
    echo "========================================================="
elif [ -n "$ACCOUNT_PROXY_HTTP" ] && [ "$ACCOUNT_PROXY_HTTP" != "null" ]; then
    echo "========================================================="
    echo " [Region Guard] Account configured with dedicated proxy:"
    echo "                 HTTP: $ACCOUNT_PROXY_HTTP"
    echo "                 Browser traffic will route through proxy."
    echo "                 Host runner IP check bypassed."
    echo "========================================================="
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
        echo "=========================================================================="
        echo "🚨 REGION GUARD: NON-US RUNNER DETECTED!"
        echo "   Country:          $RUNNER_COUNTRY"
        echo "   Location:         $RUNNER_CITY, $RUNNER_REGION"
        echo "   Runner Public IP: $RUNNER_IP"
        echo "   ISP / Org:        $RUNNER_ORG"
        echo "--------------------------------------------------------------------------"
        echo "⛔ Policy requires US IP only. Aborting run to protect account: $ACCOUNT_EMAIL"
        echo "💡 TIP: Click 'Re-run failed jobs' on GitHub to acquire a fresh US runner."
        echo "=========================================================================="
        echo "::error title=Region Guard Blocked::Non-US runner IP detected ($RUNNER_COUNTRY - $RUNNER_CITY, $RUNNER_REGION). Stopped slot $SLOT ($ACCOUNT_EMAIL) to protect account. Click 'Re-run failed jobs' to get a US runner."

        # Send Discord Webhook Alert if configured
        DISCORD_URL="${DISCORD_WEBHOOK_URL:-}"
        if [ -z "$DISCORD_URL" ] && [ -f runner_env.json ]; then
            DISCORD_URL=$(jq -r '.discord_webhook_url // empty' runner_env.json 2>/dev/null || echo "")
        fi
        if [ -n "$DISCORD_URL" ] && [ "$DISCORD_URL" != "null" ]; then
            DISCORD_PAYLOAD=$(jq -n \
                --arg email "$ACCOUNT_EMAIL" \
                --arg slot "$SLOT" \
                --arg ip "$RUNNER_IP" \
                --arg country "$RUNNER_COUNTRY" \
                --arg city "$RUNNER_CITY" \
                --arg region "$RUNNER_REGION" \
                '{
                    embeds: [{
                        title: "🚨 Region Guard: Non-US Runner Blocked",
                        description: ("Slot " + $slot + " (" + $email + ") was aborted to protect the account from running on a foreign IP."),
                        color: 16711680,
                        fields: [
                            { name: "Country", value: $country, inline: true },
                            { name: "Location", value: ($city + ", " + $region), inline: true },
                            { name: "Runner IP", value: $ip, inline: true }
                        ],
                        footer: { text: "Action: Click Re-run failed jobs on GitHub to acquire a US runner." },
                        timestamp: (now | todate)
                    }]
                }' 2>/dev/null || echo "")
            if [ -n "$DISCORD_PAYLOAD" ]; then
                curl -s -H "Content-Type: application/json" -X POST -d "$DISCORD_PAYLOAD" "$DISCORD_URL" >/dev/null 2>&1 || true
            fi
        fi

        exit 1
    fi

    echo "✅ [Region Guard] Verified US runner: $RUNNER_IP ($RUNNER_CITY, $RUNNER_REGION - $RUNNER_ORG)."
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
