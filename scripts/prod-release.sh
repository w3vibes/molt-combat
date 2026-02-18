#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

set -a
source .env
set +a

export ECLOUD_PRIVATE_KEY="${PAYOUT_SIGNER_PRIVATE_KEY:-${OPERATOR_PRIVATE_KEY:-}}"
if [[ -z "${ECLOUD_PRIVATE_KEY}" ]]; then
  echo "❌ Missing PAYOUT_SIGNER_PRIVATE_KEY/OPERATOR_PRIVATE_KEY in .env"
  exit 1
fi

: "${ECLOUD_APP_ID_API:?Set ECLOUD_APP_ID_API in .env}"
: "${ECLOUD_APP_ID_WEB:?Set ECLOUD_APP_ID_WEB in .env}"

ENVIRONMENT="${ECLOUD_ENV:-sepolia}"
API_IMAGE_REF="${ECLOUD_IMAGE_REF_API:-khairallah1/moltcombat-api:latest}"
WEB_IMAGE_REF="${ECLOUD_IMAGE_REF_WEB:-khairallah1/moltcombat-web:latest}"
INSTANCE_TYPE="${ECLOUD_INSTANCE_TYPE:-g1-standard-4t}"
LOG_VISIBILITY="${ECLOUD_LOG_VISIBILITY:-private}"
RESOURCE_MON="${ECLOUD_RESOURCE_USAGE_MONITORING:-enable}"

run_retry() {
  local cmd="$1"
  local max=3
  local n=1
  while true; do
    echo "→ [$n/$max] $cmd"
    if bash -lc "$cmd"; then
      return 0
    fi
    if [[ $n -ge $max ]]; then
      echo "❌ Failed after $max attempts"
      return 1
    fi
    n=$((n+1))
    sleep 5
  done
}

echo "\n=== 1) Build + Test ==="
npm install
npm --workspace apps/api run build
npm --workspace apps/api run test
npm --workspace apps/web run build
(cd contracts && forge build && forge test -vv)

echo "\n=== 2) Set Eigen environment ==="
run_retry "ecloud compute env set --yes ${ENVIRONMENT}"

echo "\n=== 3) Upgrade API ==="
run_retry "ecloud compute app upgrade ${ECLOUD_APP_ID_API} --dockerfile Dockerfile.api --image-ref ${API_IMAGE_REF} --env-file .env --log-visibility ${LOG_VISIBILITY} --resource-usage-monitoring ${RESOURCE_MON} --instance-type ${INSTANCE_TYPE}"

echo "\n=== 4) Upgrade Web ==="
run_retry "ecloud compute app upgrade ${ECLOUD_APP_ID_WEB} --dockerfile Dockerfile.web --image-ref ${WEB_IMAGE_REF} --env-file .env --log-visibility ${LOG_VISIBILITY} --resource-usage-monitoring ${RESOURCE_MON} --instance-type ${INSTANCE_TYPE}"

echo "\n=== 5) Generate TEE verification artifact ==="
npm run verify:tee -- "${ECLOUD_APP_ID_API}" "${ECLOUD_APP_ID_WEB}"

echo "\n✅ Production release completed"
