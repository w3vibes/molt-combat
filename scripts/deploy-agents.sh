#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "❌ Missing .env at project root"
  exit 1
fi

set -a
source .env
set +a

export ECLOUD_PRIVATE_KEY="${PAYOUT_SIGNER_PRIVATE_KEY:-${OPERATOR_PRIVATE_KEY:-}}"
if [[ -z "${ECLOUD_PRIVATE_KEY:-}" ]]; then
  echo "❌ Missing PAYOUT_SIGNER_PRIVATE_KEY/OPERATOR_PRIVATE_KEY in .env"
  exit 1
fi

ENVIRONMENT="${ECLOUD_ENV:-sepolia}"
INSTANCE_TYPE="${ECLOUD_INSTANCE_TYPE:-g1-standard-4t}"
LOG_VISIBILITY="${ECLOUD_LOG_VISIBILITY:-private}"
RESOURCE_MON="${ECLOUD_RESOURCE_USAGE_MONITORING:-enable}"

AGENT_A_APP_NAME="${ECLOUD_AGENT_NAME_A:-moltcombat-agent-a}"
AGENT_B_APP_NAME="${ECLOUD_AGENT_NAME_B:-moltcombat-agent-b}"

AGENT_A_IMAGE_REF="${ECLOUD_IMAGE_REF_AGENT_A:-khairallah1/moltcombat-agent-a:latest}"
AGENT_B_IMAGE_REF="${ECLOUD_IMAGE_REF_AGENT_B:-khairallah1/moltcombat-agent-b:latest}"

AGENT_A_APP_ID="${ECLOUD_APP_ID_AGENT_A:-}"
AGENT_B_APP_ID="${ECLOUD_APP_ID_AGENT_B:-}"

update_env() {
  local key="$1"
  local value="$2"

  if grep -q "^${key}=" .env; then
    sed -i '' "s#^${key}=.*#${key}=${value}#" .env
  else
    echo "${key}=${value}" >> .env
  fi
}

run_retry() {
  local cmd="$1"
  local max=3
  local n=1

  while true; do
    echo "→ [$n/$max] $cmd" >&2
    if bash -c "$cmd"; then
      return 0
    fi

    if [[ $n -ge $max ]]; then
      echo "❌ Failed after $max attempts" >&2
      return 1
    fi

    n=$((n + 1))
    sleep 5
  done
}

run_capture_retry() {
  local cmd="$1"
  local max=3
  local n=1
  local out=""

  while true; do
    echo "→ [$n/$max] $cmd" >&2
    set +e
    out=$(bash -c "$cmd" 2>&1)
    code=$?
    set -e
    echo "$out" >&2

    if [[ $code -eq 0 ]]; then
      printf "%s" "$out"
      return 0
    fi

    if echo "$out" | grep -qE "GlobalMaxActiveAppsExceeded\(\)|0x42ca568f"; then
      echo "❌ EigenCompute global app cap reached (GlobalMaxActiveAppsExceeded)." >&2
      echo "   New app creation is currently blocked on ${ENVIRONMENT}." >&2
      echo "   Use existing app IDs for upgrade, switch to ECLOUD_ENV=sepolia-dev, or wait for capacity." >&2
      return 1
    fi

    if echo "$out" | grep -qE "ONCHAIN EXECUTION COMPLETE|App upgraded successfully|App is now running"; then
      printf "%s" "$out"
      return 0
    fi

    if [[ $n -ge $max ]]; then
      echo "❌ Failed after $max attempts" >&2
      return 1
    fi

    n=$((n + 1))
    sleep 5
  done
}

app_owned_by_signer() {
  local app_id="$1"

  set +e
  local list
  list=$(ecloud compute app list --environment "$ENVIRONMENT" 2>/dev/null)
  local status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    return 1
  fi

  echo "$list" | grep -qi "$app_id"
}

app_controller_for_env() {
  case "$ENVIRONMENT" in
    sepolia)
      echo "0x0dd810a6ffba6a9820a10d97b659f07d8d23d4E2"
      ;;
    sepolia-dev)
      echo "0xa86DC1C47cb2518327fB4f9A1627F51966c83B92"
      ;;
    mainnet-alpha)
      echo "0xc38d35Fc995e75342A21CBd6D770305b142Fbe67"
      ;;
    *)
      echo ""
      ;;
  esac
}

global_capacity_blocked() {
  if ! command -v cast >/dev/null 2>&1; then
    return 1
  fi

  local app_controller
  app_controller=$(app_controller_for_env)
  if [[ -z "$app_controller" ]]; then
    return 1
  fi

  local rpc_url="${ECLOUD_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"

  set +e
  local active_count
  local max_count
  active_count=$(cast call "$app_controller" "globalActiveAppCount()(uint32)" --rpc-url "$rpc_url" 2>/dev/null | tr -d '\r')
  local s1=$?
  max_count=$(cast call "$app_controller" "maxGlobalActiveApps()(uint32)" --rpc-url "$rpc_url" 2>/dev/null | tr -d '\r')
  local s2=$?
  set -e

  if [[ $s1 -ne 0 || $s2 -ne 0 ]]; then
    return 1
  fi

  if [[ "$active_count" =~ ^[0-9]+$ && "$max_count" =~ ^[0-9]+$ && "$active_count" -ge "$max_count" ]]; then
    echo "❌ EigenCompute global capacity is full on ${ENVIRONMENT}: ${active_count}/${max_count} active apps." >&2
    echo "   New app creation will revert with GlobalMaxActiveAppsExceeded()." >&2
    echo "   Use existing app IDs for upgrade, switch to ECLOUD_ENV=sepolia-dev, or wait for capacity." >&2
    return 0
  fi

  return 1
}

latest_image_digest() {
  local app_id="$1"

  set +e
  local json
  json=$(ecloud compute app releases "$app_id" --environment "$ENVIRONMENT" --json 2>/dev/null)
  local status=$?
  set -e

  if [[ $status -ne 0 ]] || [[ -z "$json" ]]; then
    echo ""
    return 0
  fi

  printf "%s" "$json" | node -e '
let data = "";
process.stdin.on("data", (d) => data += d);
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(data);
    const releases = Array.isArray(parsed.releases) ? parsed.releases : [];
    releases.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    const latest = releases[releases.length - 1];
    process.stdout.write((latest && latest.imageDigest) ? String(latest.imageDigest) : "");
  } catch {
    process.stdout.write("");
  }
});
'
}

endpoint_for_app() {
  local app_id="$1"
  local info
  info=$(ecloud compute app info "$app_id" --environment "$ENVIRONMENT")
  local ip
  ip=$(echo "$info" | sed -n 's/^  IP:[[:space:]]*//p' | head -n1 | tr -d '\r')

  if [[ -z "$ip" ]]; then
    echo ""
  else
    echo "http://${ip}:3000"
  fi
}

deploy_or_upgrade_agent() {
  local label="$1"
  local app_id="$2"
  local app_name="$3"
  local dockerfile="$4"
  local image_ref="$5"
  local env_file="$6"

  if [[ -n "$app_id" ]]; then
    if app_owned_by_signer "$app_id"; then
      echo "\n=== ${label}: upgrade existing app (${app_id}) ===" >&2
      run_retry "ecloud compute app upgrade ${app_id} --dockerfile ${dockerfile} --image-ref ${image_ref} --env-file ${env_file} --log-visibility ${LOG_VISIBILITY} --resource-usage-monitoring ${RESOURCE_MON} --instance-type ${INSTANCE_TYPE}"
      echo "$app_id"
      return 0
    fi

    echo "⚠️ ${label}: ignoring stale app ID ${app_id} (not found for current signer on ${ENVIRONMENT})." >&2
    app_id=""
  fi

  if global_capacity_blocked; then
    exit 1
  fi

  echo "\n=== ${label}: first deploy (${app_name}) ===" >&2
  local deploy_out
  deploy_out=$(run_capture_retry "ecloud compute app deploy --name ${app_name} --dockerfile ${dockerfile} --image-ref ${image_ref} --env-file ${env_file} --log-visibility ${LOG_VISIBILITY} --resource-usage-monitoring ${RESOURCE_MON} --instance-type ${INSTANCE_TYPE} --skip-profile")

  local parsed_id
  parsed_id=$(echo "$deploy_out" | sed -n 's/^App ID: //p' | tail -n1 | tr -d '\r')

  if [[ -z "$parsed_id" ]]; then
    echo "❌ Could not parse App ID for ${label}" >&2
    exit 1
  fi

  if ! app_owned_by_signer "$parsed_id"; then
    echo "❌ ${label}: parsed App ID ${parsed_id} is not active for current signer on ${ENVIRONMENT}." >&2
    echo "   Most likely createApp reverted before on-chain execution completed." >&2
    exit 1
  fi

  echo "$parsed_id"
}

AGENT_A_ENV_FILE=".agent-a.deploy.env"
AGENT_B_ENV_FILE=".agent-b.deploy.env"
trap 'rm -f "$AGENT_A_ENV_FILE" "$AGENT_B_ENV_FILE"' EXIT

cat > "$AGENT_A_ENV_FILE" <<EOF
PORT=3000
AGENT_NAME=${AGENT_A_NAME:-Vanguard-A}
LOG_LEVEL=${AGENT_A_LOG_LEVEL:-info}
AGGRESSION=${AGENT_A_AGGRESSION:-0.78}
ECONOMY_BIAS=${AGENT_A_ECONOMY_BIAS:-0.34}
RISK_TOLERANCE=${AGENT_A_RISK_TOLERANCE:-0.66}
EOF

cat > "$AGENT_B_ENV_FILE" <<EOF
PORT=3000
AGENT_NAME=${AGENT_B_NAME:-Sentinel-B}
LOG_LEVEL=${AGENT_B_LOG_LEVEL:-info}
AGGRESSION=${AGENT_B_AGGRESSION:-0.46}
ECONOMY_BIAS=${AGENT_B_ECONOMY_BIAS:-0.88}
RISK_TOLERANCE=${AGENT_B_RISK_TOLERANCE:-0.38}
EOF

echo "\n=== 1) Validate local agent entry scripts ==="
node --check scripts/mockAgentA.mjs
node --check scripts/mockAgentB.mjs

echo "\n=== 2) Set Eigen environment ==="
run_retry "ecloud compute env set --yes ${ENVIRONMENT}"

AGENT_A_APP_ID=$(deploy_or_upgrade_agent "Agent A" "$AGENT_A_APP_ID" "$AGENT_A_APP_NAME" "Dockerfile.agent-a" "$AGENT_A_IMAGE_REF" "$AGENT_A_ENV_FILE")
AGENT_B_APP_ID=$(deploy_or_upgrade_agent "Agent B" "$AGENT_B_APP_ID" "$AGENT_B_APP_NAME" "Dockerfile.agent-b" "$AGENT_B_IMAGE_REF" "$AGENT_B_ENV_FILE")

echo "\n=== 3) Resolve endpoints + image digests ==="
AGENT_A_ENDPOINT=$(endpoint_for_app "$AGENT_A_APP_ID")
AGENT_B_ENDPOINT=$(endpoint_for_app "$AGENT_B_APP_ID")

AGENT_A_IMAGE_DIGEST=$(latest_image_digest "$AGENT_A_APP_ID")
AGENT_B_IMAGE_DIGEST=$(latest_image_digest "$AGENT_B_APP_ID")

echo "\n=== 4) Persist discovered values to .env ==="
update_env "ECLOUD_APP_ID_AGENT_A" "$AGENT_A_APP_ID"
update_env "ECLOUD_APP_ID_AGENT_B" "$AGENT_B_APP_ID"

if [[ -n "$AGENT_A_ENDPOINT" ]]; then update_env "AGENT_A_ENDPOINT" "$AGENT_A_ENDPOINT"; fi
if [[ -n "$AGENT_B_ENDPOINT" ]]; then update_env "AGENT_B_ENDPOINT" "$AGENT_B_ENDPOINT"; fi
if [[ -n "$AGENT_A_IMAGE_DIGEST" ]]; then update_env "AGENT_A_IMAGE_DIGEST" "$AGENT_A_IMAGE_DIGEST"; fi
if [[ -n "$AGENT_B_IMAGE_DIGEST" ]]; then update_env "AGENT_B_IMAGE_DIGEST" "$AGENT_B_IMAGE_DIGEST"; fi

echo "\n✅ Agent deployments ready"
echo "\nAgent A"
echo "  appId:        ${AGENT_A_APP_ID}"
echo "  endpoint:     ${AGENT_A_ENDPOINT:-NOT_FOUND}"
echo "  imageDigest:  ${AGENT_A_IMAGE_DIGEST:-NOT_FOUND}"

echo "\nAgent B"
echo "  appId:        ${AGENT_B_APP_ID}"
echo "  endpoint:     ${AGENT_B_ENDPOINT:-NOT_FOUND}"
echo "  imageDigest:  ${AGENT_B_IMAGE_DIGEST:-NOT_FOUND}"

echo "\nNext: register agents on MoltCombat API using endpoint + sandbox + eigencompute metadata."
