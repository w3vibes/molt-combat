#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "❌ Missing required command: $cmd" >&2
    exit 1
  fi
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "❌ Missing required env var: $name" >&2
    exit 1
  fi
}

json_field() {
  local json="$1"
  local expr="$2"
  echo "$json" | jq -r "$expr"
}

ensure_no_error() {
  local label="$1"
  local json="$2"
  local err
  err=$(json_field "$json" '.error // empty')
  if [[ -n "$err" ]]; then
    echo "❌ ${label} failed" >&2
    echo "$json" | jq >&2 || echo "$json" >&2
    exit 1
  fi
}

require_cmd curl
require_cmd jq
require_cmd node
require_cmd npm

# Friendly fallbacks from common repo env names
API_BASE="${API_BASE:-${NEXT_PUBLIC_API_URL:-}}"
A_ENDPOINT="${A_ENDPOINT:-${AGENT_A_ENDPOINT:-}}"
B_ENDPOINT="${B_ENDPOINT:-${AGENT_B_ENDPOINT:-}}"
A_APP_ID="${A_APP_ID:-${ECLOUD_APP_ID_AGENT_A:-}}"
B_APP_ID="${B_APP_ID:-${ECLOUD_APP_ID_AGENT_B:-}}"

# Required inputs
for v in \
  API_BASE \
  OPERATOR_API_KEY \
  A_ENDPOINT \
  B_ENDPOINT \
  A_APP_ID \
  B_APP_ID \
  PLAYER_A_WALLET \
  PLAYER_B_WALLET \
  SEPOLIA_RPC_URL \
  MOLT_USDC_ESCROW_ADDRESS \
  USDC_TOKEN_ADDRESS \
  PLAYER_A_PRIVATE_KEY \
  PLAYER_B_PRIVATE_KEY; do
  require_env "$v"
done

AMOUNT_PER_PLAYER_6DP="${AMOUNT_PER_PLAYER_6DP:-1000000}"
A_SANDBOX_RUNTIME="${A_SANDBOX_RUNTIME:-node}"
A_SANDBOX_VERSION="${A_SANDBOX_VERSION:-20.11}"
A_SANDBOX_CPU="${A_SANDBOX_CPU:-2}"
A_SANDBOX_MEMORY="${A_SANDBOX_MEMORY:-2048}"

B_SANDBOX_RUNTIME="${B_SANDBOX_RUNTIME:-$A_SANDBOX_RUNTIME}"
B_SANDBOX_VERSION="${B_SANDBOX_VERSION:-$A_SANDBOX_VERSION}"
B_SANDBOX_CPU="${B_SANDBOX_CPU:-$A_SANDBOX_CPU}"
B_SANDBOX_MEMORY="${B_SANDBOX_MEMORY:-$A_SANDBOX_MEMORY}"

STAMP="$(date +%s)"
TOPIC="strict-usdc-e2e-${STAMP}"
A_NAME="alpha-strict-${STAMP}"
B_NAME="beta-strict-${STAMP}"

printf "\n== 1) Verify strict mode ==\n"
STRICT=$(curl -s "$API_BASE/verification/eigencompute")
ensure_no_error "strict check" "$STRICT"
echo "$STRICT" | jq '.checks.strictMode'

printf "\n== 2) Register Agent A ==\n"
A_REG=$(curl -s -X POST "$API_BASE/api/agents/register" \
  -H "Content-Type: application/json" \
  -d "{\"agent_name\":\"$A_NAME\",\"endpoint\":\"$A_ENDPOINT\",\"payout_address\":\"$PLAYER_A_WALLET\",\"sandbox\":{\"runtime\":\"$A_SANDBOX_RUNTIME\",\"version\":\"$A_SANDBOX_VERSION\",\"cpu\":$A_SANDBOX_CPU,\"memory\":$A_SANDBOX_MEMORY},\"eigencompute\":{\"appId\":\"$A_APP_ID\",\"environment\":\"sepolia\"}}")
ensure_no_error "register A" "$A_REG"
A_ID=$(json_field "$A_REG" '.agent_id')
A_KEY=$(json_field "$A_REG" '.api_key')
echo "$A_REG" | jq '{agent_id, api_key}'

printf "\n== 3) Register Agent B ==\n"
B_REG=$(curl -s -X POST "$API_BASE/api/agents/register" \
  -H "Content-Type: application/json" \
  -d "{\"agent_name\":\"$B_NAME\",\"endpoint\":\"$B_ENDPOINT\",\"payout_address\":\"$PLAYER_B_WALLET\",\"sandbox\":{\"runtime\":\"$B_SANDBOX_RUNTIME\",\"version\":\"$B_SANDBOX_VERSION\",\"cpu\":$B_SANDBOX_CPU,\"memory\":$B_SANDBOX_MEMORY},\"eigencompute\":{\"appId\":\"$B_APP_ID\",\"environment\":\"sepolia\"}}")
ensure_no_error "register B" "$B_REG"
B_ID=$(json_field "$B_REG" '.agent_id')
B_KEY=$(json_field "$B_REG" '.api_key')
echo "$B_REG" | jq '{agent_id, api_key}'

printf "\n== 4) Create USDC challenge ==\n"
CH_CREATE=$(curl -s -X POST "$API_BASE/challenges" \
  -H "Authorization: Bearer $A_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"topic\":\"$TOPIC\",\"challengerAgentId\":\"$A_ID\",\"opponentAgentId\":\"$B_ID\",\"stake\":{\"mode\":\"usdc\",\"contractAddress\":\"$MOLT_USDC_ESCROW_ADDRESS\",\"amountPerPlayer\":\"$AMOUNT_PER_PLAYER_6DP\",\"playerA\":\"$PLAYER_A_WALLET\",\"playerB\":\"$PLAYER_B_WALLET\"}}")
ensure_no_error "create challenge" "$CH_CREATE"
CH_ID=$(json_field "$CH_CREATE" '.challenge.id')
echo "$CH_CREATE" | jq '{ok, challenge: {id: .challenge.id, status: .challenge.status, stake: .challenge.stake}}'

printf "\n== 5) Accept challenge ==\n"
ACCEPT=$(curl -s -X POST "$API_BASE/challenges/$CH_ID/accept" \
  -H "Authorization: Bearer $B_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"opponentAgentId\":\"$B_ID\"}")
ensure_no_error "accept challenge" "$ACCEPT"
echo "$ACCEPT" | jq '{ok, challenge: {id: .challenge.id, status: .challenge.status}}'

printf "\n== 6) Prepare escrow (required before start) ==\n"
PREP=$(curl -s -X POST "$API_BASE/challenges/$CH_ID/escrow/prepare" \
  -H "Authorization: Bearer $A_KEY")
ensure_no_error "escrow prepare" "$PREP"
MATCH_ID=$(json_field "$PREP" '.escrow.matchId')
MATCH_ID_HEX=$(json_field "$PREP" '.escrow.matchIdHex')
if [[ -z "$MATCH_ID" || -z "$MATCH_ID_HEX" || "$MATCH_ID" == "null" || "$MATCH_ID_HEX" == "null" ]]; then
  echo "❌ escrow/prepare did not return match ids" >&2
  echo "$PREP" | jq >&2
  exit 1
fi
echo "$PREP" | jq '{ok, escrow: {matchId: .escrow.matchId, matchIdHex: .escrow.matchIdHex, txHash: .escrow.txHash, created: .escrow.created, status: .escrow.status}}'

printf "\n== 7) Deposit Player A ==\n"
SEPOLIA_RPC_URL="$SEPOLIA_RPC_URL" PLAYER_PRIVATE_KEY="$PLAYER_A_PRIVATE_KEY" \
  npm run escrow:player:deposit -- "$USDC_TOKEN_ADDRESS" "$MOLT_USDC_ESCROW_ADDRESS" "$MATCH_ID_HEX" "$AMOUNT_PER_PLAYER_6DP"

printf "\n== 8) Deposit Player B ==\n"
SEPOLIA_RPC_URL="$SEPOLIA_RPC_URL" PLAYER_PRIVATE_KEY="$PLAYER_B_PRIVATE_KEY" \
  npm run escrow:player:deposit -- "$USDC_TOKEN_ADDRESS" "$MOLT_USDC_ESCROW_ADDRESS" "$MATCH_ID_HEX" "$AMOUNT_PER_PLAYER_6DP"

printf "\n== 9) Verify escrow deposits ==\n"
ESCROW_STATUS=$(curl -s "$API_BASE/matches/$MATCH_ID/escrow/status?contractAddress=$MOLT_USDC_ESCROW_ADDRESS" \
  -H "Authorization: Bearer $A_KEY")
ensure_no_error "escrow status" "$ESCROW_STATUS"
A_DEP=$(json_field "$ESCROW_STATUS" '.playerADeposited')
B_DEP=$(json_field "$ESCROW_STATUS" '.playerBDeposited')
echo "$ESCROW_STATUS" | jq '{matchId, matchIdHex, playerADeposited, playerBDeposited, settled}'

if [[ "$A_DEP" != "true" || "$B_DEP" != "true" ]]; then
  echo "❌ Deposits not ready. Aborting before start." >&2
  exit 1
fi

printf "\n== 10) Create market + sample bets ==\n"
MARKET_CREATE=$(curl -s -X POST "$API_BASE/markets" \
  -H "Authorization: Bearer $OPERATOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"subjectType\":\"challenge\",\"subjectId\":\"$CH_ID\",\"outcomes\":[\"$A_ID\",\"$B_ID\"]}")
ensure_no_error "market create" "$MARKET_CREATE"
MARKET_ID=$(json_field "$MARKET_CREATE" '.market.id')
echo "$MARKET_CREATE" | jq '{ok, market: {id: .market.id, status: .market.status, outcomes: .market.outcomes}}'

# Optional sample bets
curl -s -X POST "$API_BASE/markets/$MARKET_ID/bets" \
  -H "Authorization: Bearer $OPERATOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"bettor\":\"alice\",\"outcome\":\"$A_ID\",\"amount\":\"1000000\"}" | jq '.' >/dev/null

curl -s -X POST "$API_BASE/markets/$MARKET_ID/bets" \
  -H "Authorization: Bearer $OPERATOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"bettor\":\"bob\",\"outcome\":\"$B_ID\",\"amount\":\"1000000\"}" | jq '.' >/dev/null

printf "\n== 11) Start challenge ==\n"
START=$(curl -s -X POST "$API_BASE/challenges/$CH_ID/start" \
  -H "Authorization: Bearer $A_KEY" \
  -H "Content-Type: application/json" \
  -d '{}')
ensure_no_error "challenge start" "$START"
echo "$START" | jq '{ok, challenge: {id: .challenge.id, status: .challenge.status, winnerAgentId: .challenge.winnerAgentId, matchId: .challenge.matchId}, escrow: .escrow}'

printf "\n== 12) Verify match + attestation + market + settlement ==\n"
CH_STATE=$(curl -s "$API_BASE/challenges/$CH_ID" -H "Authorization: Bearer $A_KEY")
ensure_no_error "challenge state" "$CH_STATE"
MATCH_ID_FINAL=$(json_field "$CH_STATE" '.challenge.matchId')

MATCH=$(curl -s "$API_BASE/matches/$MATCH_ID_FINAL" -H "Authorization: Bearer $A_KEY")
ensure_no_error "match fetch" "$MATCH"
WINNER=$(json_field "$MATCH" '.winner // empty')

echo "$MATCH" | jq '{id, matchIdHex, status, winner, turnsPlayed, fairness: .audit.fairness, meteringTotals: .audit.meteringTotals}'

ATTEST=$(curl -s "$API_BASE/matches/$MATCH_ID_FINAL/attestation" -H "Authorization: Bearer $A_KEY")
ensure_no_error "attestation fetch" "$ATTEST"
echo "$ATTEST" | jq '.verification'

# Force settlement tick to speed up final state
curl -s -X POST "$API_BASE/automation/tick" \
  -H "Authorization: Bearer $OPERATOR_API_KEY" | jq '.' >/dev/null

MARKET=$(curl -s "$API_BASE/markets/$MARKET_ID" -H "Authorization: Bearer $OPERATOR_API_KEY")
ensure_no_error "market fetch" "$MARKET"
echo "$MARKET" | jq '{id: .market.id, status: .market.status, resultOutcome: .market.resultOutcome, payouts: .market.payouts}'

ESCROW_FINAL=$(curl -s "$API_BASE/matches/$MATCH_ID_FINAL/escrow/status?contractAddress=$MOLT_USDC_ESCROW_ADDRESS" \
  -H "Authorization: Bearer $A_KEY")
ensure_no_error "final escrow status" "$ESCROW_FINAL"
echo "$ESCROW_FINAL" | jq '{matchId, playerADeposited, playerBDeposited, settled}'

LEADERBOARD=$(curl -s "$API_BASE/leaderboard/trusted")
ensure_no_error "leaderboard" "$LEADERBOARD"
echo "$LEADERBOARD" | jq '{strictOnly, entries: (.entries | length)}'

printf "\n✅ E2E complete\n"
printf "Challenge: %s\n" "$CH_ID"
printf "Match:     %s\n" "$MATCH_ID_FINAL"
printf "Market:    %s\n" "$MARKET_ID"
printf "Winner:    %s\n" "${WINNER:-unknown}"
