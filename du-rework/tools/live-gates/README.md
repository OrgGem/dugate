# LIVE-GATES harness (candidate-portal-swagger-20261006-r4.1)

Prepared for Claude review §10.7-5 / §11.4-5 (live-only gates). **Harness only:
no product code is modified, and nothing here runs against production.**

| Step | Script | Gate |
|---|---|---|
| 1 | `check-migrations.cjs` | 0035/0036 applied-state + columns on the candidate DB (+ `--via-container` pending=0) |
| 2 | `webhook-live-idp.cjs` | live HTTPS OAuth2 IdP + signed receiver → durable delivery receipt |
| 3 | `scan-plaintext-sentinels.cjs` | no plaintext credential sentinel in PG / S3 / Vault mock |

Run everything in order with the wrapper (PowerShell):

```powershell
# 1) Start the candidate stack (images tagged candidate-portal-swagger-20261006-r4.1)
cd D:\Git\dugate\du-rework
$env:DU_IMAGE_TAG = 'candidate-portal-swagger-20261006-r4.1'
docker compose --env-file .env.docker up -d --wait

# 2) Run the three live gates (starts harness HTTPS servers on 8443/9443)
powershell -ExecutionPolicy Bypass -File tools/live-gates/run-live-gates.ps1
```

The wrapper sets the compose override (`tools/live-gates/compose/live-gates.override.yml`),
which gives the candidate `extra_hosts` aliases for the harness and trusts the
harness CA via `NODE_EXTRA_CA_CERTS`. Evidence lands in
`coordination/reports/raw/live-gates-<date>/` (`*.json` + `*.log` + receipts).

## Candidate-run extras (execution packet)

For an isolated end-to-end run against a fresh candidate DB, three more
harness-only files exist; none of them touch product compose:

- `compose/live-gates.candidate-run.override.yml` — publishes the candidate
  project's PostgreSQL to `127.0.0.1:${LIVE_GATES_PG_PORT:-5443}` so the SQL
  checks connect directly to the candidate database.
- `compose/live-gates.migrate-cap-probe.override.yml` — keeps the real migrate
  command but prints `LIVE_GATES_MEMORY_PEAK_BYTES` from the container's own
  cgroup after the run (reviewer §12.6, 64 MiB cap validation), then exits with
  the migration exit code.
- `seed-terminal-operation.cjs` — creates one synthetic tenant + one
  `SUCCEEDED` operation (labeled `live-gates-synthetic-<uuid>`) so the
  dispatcher probe has an FK target on a fresh DB; it is not a business flow.

The PowerShell wrapper accepts `-ExtraComposeFiles <comma-separated paths>`
(e.g. the two overlays above plus `docker-compose.benchmark.yml`) and
`-OperationId` (use the seed script's `operationId` when no business run
exists).

## Prerequisites

- Candidate stack running from the tagged images (`DU_IMAGE_TAG`); `.env.docker`
  present with `WEBHOOK_SECRET`, DB/S3/Vault settings.
- PostgreSQL/MinIO/Vault reachable for the scan: either the candidate compose
  services or `infra/docker-compose.live.yml` (defaults: PG `127.0.0.1:5433`,
  MinIO `127.0.0.1:9003`, Vault dev `127.0.0.1:8200`). A **Vault dev/mock** is
  required; never a production Vault.
- Node 20+ on the harness host; `openssl` (Git for Windows path is auto-detected)
  for the TLS fixture; host ports 8443/9443 free (override with `-IdpPort`/`-ReceiverPort`).
- At least one terminal operation row for the dispatcher probe (e.g. run the
  ingest E2E once), or pass `-OperationId`.
- Vault CLI tip: the dev container defaults to HTTPS and fails against the dev
  server — use
  `docker exec du-live-vault sh -c "VAULT_ADDR=http://127.0.0.1:8200 VAULT_TOKEN=<dev-token> vault kv ..."`
  for probe writes. The scan itself always talks HTTP to `--vault-addr`.

## Step details

### 1. Migrations (`check-migrations.cjs`)
```powershell
node tools/live-gates/check-migrations.cjs --pg-url <candidate-db> --via-container
```
Checks `schema_migrations` for exactly one applied row each of `0035_…` and
`0036_…`, and the presence of `operations.callback_policy`,
`webhook_deliveries.mode`, `webhook_deliveries.callback_policy`,
`profile_bindings.callback_policy`. `--via-container` additionally runs the
image's `dist/migrate-cli.js status` and fails on any pending migration.

### 2. Live HTTPS webhook (`webhook-live-idp.cjs`)
```powershell
# Local contract proof (no candidate): cert generation + token + signed callback
node tools/live-gates/webhook-live-idp.cjs --mode self-test

# Full live run against the candidate (wrapper does this automatically)
node tools/live-gates/webhook-live-idp.cjs --mode live --run-live \
  --webhook-secret <same as candidate WEBHOOK_SECRET> --expect-first-401
```
- Generates a private CA + server cert (`SAN: idp.live-gates.test,
  receiver.live-gates.test, host.docker.internal, localhost, 127.0.0.1`).
- Starts the HTTPS IdP (`/token`, client_credentials, basic or post) and the
  HTTPS receiver (HMAC `x-du-signature` over `{timestamp}.{body}`, Bearer
  validation, optional first-401 to prove reacquire).
- Executes the image's own `dist/modules/webhooks/webhooks.js`
  `deliverWebhooks` inside the `orchestrator` container against one synthetic
  `webhook_deliveries` row; asserts a durable `DELIVERED` receipt and ≥1 valid
  signed callback (with `--expect-first-401`: two attempts, two distinct token
  references).
- Writes `sentinels.json` (the synthetic client secret + HMAC sentinel) for
  step 3. Secrets printed here are synthetic fixtures, never real credentials.

### 3. Plaintext byte-scan (`scan-plaintext-sentinels.cjs`)
```powershell
node tools/live-gates/scan-plaintext-sentinels.cjs \
  --sentinels-file coordination/reports/raw/live-gates-<date>/sentinels.json \
  --vault-must-contain LIVE-CLIENT-SECRET-...
```
- PG: every text/varchar/json/jsonb/bytea cell in `public` (paged by ctid;
  `bytea` read via `encode(col,'escape')`).
- S3: every object body + key (oversize >64 MiB fails unless
  `--allow-skip-oversize`).
- Vault mock: every KV v2 secret; occurrences are allowed only under
  `--vault-allow-prefix` (default `du/`) and said secret must genuinely exist
  (`--vault-must-contain`) — a scan that finds nothing anywhere is a FAIL, not
  a pass.
- High-confidence credential shapes (Bearer/JWT/`hvs.`/`sk-`/AKIA/gh*/xox*/PEM)
  are flagged even when the exact sentinel is absent.

## Exit codes / evidence

Each script exits `0` PASS, `1` FAIL (leak/mismatch), `2` CONFIG/PREREQ.
`run-live-gates.ps1` runs 1→2→3, writes `run-summary.json` + per-step logs, and
propagates the worst exit code. Keep the raw directory as the review receipt.

## Out of scope here (separate gates)

- Live boot matrix + `ENCRYPTION_KEY` policy (F-VFY6-01 decision, §11.3).
- Portal `/admin/web/secrets` roundtrip and no-readback UI proof
  (SC-01 backend descoped per §11.2).
- Full operation→terminal→`scheduleWebhookDelivery` flow (the dispatcher probe
  inserts the delivery row directly; scheduling is covered by the offline
  suites and the Portal/result gates).
