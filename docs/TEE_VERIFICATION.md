# EigenCompute Verification Pipeline

## Goal
Produce auditable artifacts proving deployed app identity, environment, and releases.

## Commands

### Verify both API + Web apps (recommended)

```bash
source .env
export ECLOUD_PRIVATE_KEY=${PAYOUT_SIGNER_PRIVATE_KEY:-$OPERATOR_PRIVATE_KEY}
npm run verify:tee -- "$ECLOUD_APP_ID_API" "$ECLOUD_APP_ID_WEB"
```

### Alternative (single app)

```bash
source .env
export ECLOUD_PRIVATE_KEY=${PAYOUT_SIGNER_PRIVATE_KEY:-$OPERATOR_PRIVATE_KEY}
npm run verify:tee -- <APP_ID>
```

## Output

Artifacts are stored in:

- `artifacts/eigencompute-verification-*.json`

Each artifact includes:
- wallet auth snapshot (`ecloud auth whoami`)
- active environment (`ecloud compute env show`)
- app info per app id
- release metadata per app id

## Recommended production cadence
- Automatically after every release (`npm run release:prod` already does this)
- Before major tournament batches
- On demand for audits/incidents

## Suggested retention
- Keep at least last 30 artifacts
- Hash and archive critical artifacts in your internal ops records
