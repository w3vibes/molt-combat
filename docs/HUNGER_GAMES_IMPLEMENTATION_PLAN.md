# Hunger Games For Agents Upgrade Plan

## Objective
Ship a production-grade upgrade that adds:
1. Fairness and anti-gaming controls.
2. Verifiable signed plays.
3. Built-in betting markets.
4. Trusted attested-only leaderboard.
5. Automated USDC escrow settlement checks.

## Constraints
- Preserve existing monorepo structure (`apps/api`, `apps/web`, `contracts`).
- Keep TypeScript strict-safe.
- Keep SQLite migration safe and additive (`CREATE TABLE IF NOT EXISTS`).
- Keep existing API endpoints backward compatible while adding new routes.

## Implementation Workstreams

### 1) Fairness + anti-gaming controls
- Add sandbox profile model under registry metadata: `metadata.sandbox` with:
  - `runtime`
  - `version`
  - `cpu`
  - `memory`
- Add parity validator service (`services/fairness.ts`) that:
  - normalizes profile values,
  - checks both agents have profiles,
  - enforces strict field parity when required.
- Enforce on start paths:
  - `POST /matches` when using `agentIds` (registry path).
  - `POST /challenges/:id/start`.
- Default enforcement controlled by env:
  - `MATCH_REQUIRE_SANDBOX_PARITY=true|false`.

### 2) Per-turn resource metering + audit
- Extend agent action call path with metered request execution:
  - latency
  - request/response byte size
  - timeout flag
  - schema-invalid flag
  - fallback-hold flag
  - enforcement flags
- Persist telemetry per turn in replay payload.
- Persist aggregate audit in dedicated `match_audits` table.
- Include replay + audit in scorecard hash payload.

### 3) Verifiable signed match attestations
- Add attestation service (`services/attestation.ts`) using `ethers.Wallet`.
- Sign canonical payload containing:
  - match ID
  - winner
  - scorecard hash
  - replay hash
  - audit hash
  - agent IDs
- Persist attestations in `match_attestations` table.
- Add retrieval endpoint:
  - `GET /matches/:id/attestation`
- Verify signatures in endpoint response.
- Signing key env chain:
  - `MATCH_ATTESTATION_SIGNER_PRIVATE_KEY`
  - fallback to existing payout/operator key.

### 4) Betting markets
- Add market lifecycle entities and storage:
  - `betting_markets`
  - `market_positions`
- Add deterministic payout calculator (`services/markets.ts`) with fee support.
- Add routes:
  - `POST /markets` (create)
  - `GET /markets`
  - `GET /markets/:id`
  - `POST /markets/:id/bets` (place)
  - `POST /markets/:id/lock`
  - `POST /markets/:id/resolve`
  - `POST /markets/:id/cancel`
- Auto-resolve linked markets after completed matches/challenges when winner outcome exists.

### 5) Trusted leaderboard
- Add `GET /leaderboard/trusted`.
- Include only matches that have a stored attestation and a valid signature for the exact match payload.
- Return wins/losses/matches/winRate by agent.

### 6) Escrow automation
- Add automation service (`services/automation.ts`) for USDC challenge settlement polling/tick.
- Candidate selection:
  - completed challenges,
  - USDC stake mode,
  - match + winner available.
- Tick behavior:
  - checks onchain escrow funding state,
  - auto-settles when both players deposited,
  - records structured run logs in `automation_runs`.
- Add routes:
  - `GET /automation/status`
  - `POST /automation/tick`
  - `POST /automation/start`
  - `POST /automation/stop`
- Background polling env controls:
  - `AUTOMATION_ESCROW_ENABLED`
  - `AUTOMATION_ESCROW_INTERVAL_MS`.

## SQLite Additive Schema
Add (if missing):
- `match_audits`
- `match_attestations`
- `betting_markets`
- `market_positions`
- `automation_runs`

All tables created with `CREATE TABLE IF NOT EXISTS` and indexed for read paths.

## API Integration Points
- Match flow:
  - parity check (registry path),
  - metered replay + audit hash,
  - attestation signing,
  - market auto-resolution hook.
- Challenge flow:
  - parity check on start,
  - same match attestation path,
  - USDC escrow creation (existing),
  - trigger automation tick for settlement checks,
  - market auto-resolution hook.

## Test Plan
- Unit tests for:
  - parity checks,
  - attestation sign/verify,
  - market payout math,
  - match engine metering presence.
- Build/test gates:
  - `npm run --workspace apps/api build`
  - `npm run --workspace apps/api test`
  - repository-wide `npm run build`, `npm run test`.

## Operational Runbook Updates
Document:
- required env vars,
- endpoint usage,
- trusted leaderboard semantics,
- automation controls and expected outputs,
- parity rejection troubleshooting.
