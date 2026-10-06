# LIVE GATES — dry-run harness preparation (2026-10-06)

- Task: prepare harness scripts to run the live-only gates on the tagged candidate
  `candidate-portal-swagger-20261006-r4.1` (Claude review §10.7-5 / §11.4-5).
- Owner: OpenCode (oc_2)
- Constraints honored: **no product code edited, no commit, no push.** New files live only under
  `du-rework/tools/live-gates/` and the evidence directory.
- Status: **READY** — harness drafted, syntax-checked, dependency-resolved, self-tested end-to-end,
  and rehearsed against the running local live infra (read-only; one disposable Vault probe).
  The candidate live run itself is pending a stack started from the tagged r4.1 images.

## 1. Deliverables

| File | SHA-256 | Purpose |
|---|---|---|
| `tools/live-gates/README.md` | `C3C2A7E9CF62B21920CED63139774DCA11FFD7243F88F7D5AE68911326C68754` | usage, prerequisites, evidence layout |
| `tools/live-gates/lib/live-common.cjs` | `1C5C490FE399005FC302C099C957CE40E96F0CACD7E40EB247C0471BB39D400B` | args/env/compose/report helpers |
| `tools/live-gates/lib/certs.cjs` | `CD823C61A7A133FEE31EC627AB86B0711EBAB6A48DFBD9EA77FA6223C8E42BE2` | private CA + server cert (openssl auto-detect) |
| `tools/live-gates/check-migrations.cjs` | `9861C50B2449DEB6E9AC978B1389DEE59B39E347480DEB0B8CBD7A3E81A2F18E` | gate 2: 0035/0036 + columns + `--via-container` pending=0 |
| `tools/live-gates/webhook-live-idp.cjs` | `BDA2F9ED39DE12D857B43B3CFD4DD364BC567AEF5311521BE85A02166B3F8BA1` | gate 3: live HTTPS IdP + receiver (+ self-test/serve) |
| `tools/live-gates/inside/run-dispatcher-inside.cjs` | `F92F0B4C1350E06460BFC035F78D95897B408EF7395C783A8B27E899E627CC73` | runs in the candidate container; image's own `deliverWebhooks` |
| `tools/live-gates/scan-plaintext-sentinels.cjs` | `CAFE472E1CA996550DE6186394D418F86B14A0A7D1815245AFD6AA2AE4174910` | gate 1: PG/S3/Vault byte-scan |
| `tools/live-gates/compose/live-gates.override.yml` | `79E5F9046B7B3FBB6C915F089B86A73EE6A5D9AD3ABCDCBD0BBE020E8A7A5863` | harness-only compose overlay (extra_hosts + CA trust + mounts) |
| `tools/live-gates/run-live-gates.ps1` | `15DA81685F686F53471F441593709E21C104F5ACE1B796C736B1E1CBB7FA7E2C` | runs 1→2→3, aggregates exit codes |
| `tools/live-gates/.gitignore` | `7AB14A3CC99EE70876B5EAF737F5316B0A6402525DD0CD866D18440B806C0994` | keeps generated certs/evidence out of the tree |

Full hash list: `coordination/reports/raw/live-gates-prep-2026-10-06/harness-SHA256SUMS.txt`.

## 2. Gate coverage (reviewer mapping)

| Reviewer item | Harness |
|---|---|
| §10.7-5 / §11.4-5a — PG/S3/Vault byte-scan, no plaintext credential | `scan-plaintext-sentinels.cjs`: every `public` text/varchar/json/jsonb/bytea cell (ctid-paged; bytea via `encode(...,'escape')`), every S3 object body+key, every Vault KV v2 secret. Writes to other stores/patterns fail: sentinels must exist in the Vault approved prefix (`--vault-must-contain`) so "scanned nothing" can never pass as clean; Bearer/JWT/`hvs.`/`sk-`/AKIA/gh*/xox*/PEM shapes flagged independently. |
| §10.7-5 / §11.4-5b — 0035/0036 applied-state on the candidate DB | `check-migrations.cjs`: exactly one applied row each of `0035_…`/`0036_…`, all four columns (`operations.callback_policy`, `webhook_deliveries.mode`, `webhook_deliveries.callback_policy`, `profile_bindings.callback_policy`), plus `migrate-cli status` pending=0 via `--via-container` (image's own file set). |
| §10.7-5 / §11.4-5c — live HTTPS IdP/receiver | `webhook-live-idp.cjs`: private CA + cert (SANs include `idp.live-gates.test`, `receiver.live-gates.test`, `host.docker.internal`), HTTPS token endpoint (client_credentials, basic or post, validates secret, issues real expiring tokens), HTTPS receiver (independent HMAC `x-du-signature` over `{timestamp}.{body}`, Bearer validation against the IdP, optional first-401), and a one-off dispatch through the **image's own `deliverWebhooks`** against a synthetic `webhook_deliveries` row; asserts durable `DELIVERED` + valid receipts (+ distinct tokens when first-401 proves reacquire). |

## 3. Readiness evidence (all exit codes literal)

Raw bundle: `coordination/reports/raw/live-gates-prep-2026-10-06/`.

| Check | Result | Exit |
|---|---|---|
| `node --check` on all 6 scripts | syntax clean | 0 ×6 |
| `Parser::ParseFile` on `run-live-gates.ps1` | 0 parse errors | 0 |
| dependency resolution (`pg`, `@aws-sdk/client-s3` from the orchestrator package) | resolved | 0 |
| `webhook-live-idp.cjs --mode self-test` | **PASS** — cert generated; IdP token HTTP 200 (`token_type=Bearer`); valid signed callback 200; tampered signature 401; receipts written (`signatureValid/tokenValid` true, `tokenRef` + `bodySha256` only) | 0 |
| `check-migrations.cjs --dry-run` | plan PASS | 0 |
| `scan-plaintext-sentinels.cjs --dry-run` | plan PASS | 0 |
| `webhook-live-idp.cjs --dry-run` | plan PASS | 0 |
| LIVE rehearsal vs local infra (PG 5433, MinIO 9003, Vault dev 8200) | PG: all public tables paged, **0 hits**; S3: 19 objects / 5 141 bytes, **0 hits**; Vault negative with `--vault-must-contain`: **correctly FAILED** when the probe secret did not exist (fail-closed proof) | 1 (expected) |
| LIVE Vault positive path (disposable probe `secret/du/live-gates-prep/probe`, deleted afterwards) | probe detected as expected-store hit under `du/`, `--vault-must-contain` satisfied, **PASS** | 0 |
| Migrations vs the unrelated live-infra fixture DB | correctly **FAIL**: 0035/0036 not applied there — the fixture is not the candidate DB | 1 (expected) |

Note: the locally running stack is `arch-phase-b-20261006` built from `du-*:local` images, not the
tagged r4.1 candidate. The live path is therefore guarded (`--mode live --run-live`) and has not
been pointed at that older stack. `check-migrations.live-infra.*` and
`scan-plaintext-sentinels.live-infra.*` preserve the rehearsal outputs; the plan/dry-run outputs
keep the canonical names.

## 4. How to run on the tagged candidate

```powershell
cd D:\Git\dugate\du-rework
$env:DU_IMAGE_TAG = 'candidate-portal-swagger-20261006-r4.1'
docker compose --env-file .env.docker up -d --wait
powershell -ExecutionPolicy Bypass -File tools/live-gates/run-live-gates.ps1 -First401
```

The wrapper exports `LIVE_GATES_HOST_DIR`/`LIVE_CERTS_HOST_DIR`, adds
`tools/live-gates/compose/live-gates.override.yml` to the compose files, and runs
migrations → webhook live → byte-scan. Evidence lands in
`coordination/reports/raw/live-gates-<date>/` (`run-summary.json`, per-step `*.json`/`*.log`,
receiver `receipts.jsonl`, `sentinels.json`).

## 5. Scope / limits (stated, not hidden)

- The harness dispatcher probe inserts the `webhook_deliveries` row directly (scheduling
  `operation -> delivery` is covered by the offline suites and the separate Portal/result gates);
  it exercises the image's real `deliverWebhooks`, egress, auth, TLS and durable receipt.
- `allowPrivateNetworks: true` is passed only by the harness one-off dispatcher because the
  receiver is a loopback-side fixture; product configuration is untouched, and the SSRF matrices
  remain the fence for real destinations.
- Vault must be a dev/mock instance (probe writes use a dev token and are deleted immediately);
  no production secret is read or written, and evidence stores only hashes/refs of synthetic values.
- SC-01 secrets backend remains descoped for r4.1 per reviewer §11.2; the harness supplies the
  exact synthetic client secret through the dispatcher's resolver seam instead of pretending the
  catalog exists.
- Separate gates not covered here: live boot matrix / `ENCRYPTION_KEY` policy (F-VFY6-01),
  Portal `/admin/web/secrets` roundtrip, full operation→terminal→delivery E2E.
- No commit/push; no task/gate tick. The candidate live run is the independent tester's step on
  the frozen r4.1 artifacts.
