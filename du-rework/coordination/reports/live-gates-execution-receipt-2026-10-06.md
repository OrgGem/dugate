# LIVE GATES — execution receipt (Packet 7)

- Date: 2026-10-06 (run 22:03–22:16 +07 / 15:03–15:16 UTC).
- Owner: OpenCode (oc_2), executing the Claude Reviewer §12.3 tooling on the tagged candidate
  `candidate-portal-swagger-20261006-r4.1` (reviewer §12.3 acceptance + §12.6 carried-forward flag).
- Verdict: **3/3 gates PASS (literal exit 0) on the tagged candidate; 64 MiB migrate-cap precheck PASS
  with a measured cgroup peak**. Two earlier webhook attempts failed on a HARNESS bug (now fixed and
  documented below); their DB rows are preserved as history. This is not a production cutover and not
  an ACCEPTED claim; no product code was edited, nothing committed or pushed, no gate ticked.
- Raw evidence: [`raw/live-gates-execution-2026-10-06/`](raw/live-gates-execution-2026-10-06/)
  (`SHA256SUMS.txt`, 53 files; harness hashes in `harness-SHA256SUMS.txt`).

## 0. Environment and isolated project

| Item | Value |
|---|---|
| Candidate images | orchestrator `sha256:ce35749edf35…` (matches benchmark migrate image), connector `sha256:d54c29f54daa…`, document-core `sha256:e1b7ce7e5ac8…` |
| Isolated compose project | `du-live-gates-r41-20261006` (fresh PG/valkey volumes; own network) |
| Compose file set | `docker-compose.yml` + `docker-compose.benchmark.yml` + `tools/live-gates/compose/{live-gates, candidate-run, migrate-cap-probe, synthetic-mode}.override.yml` (`compose-file-set.txt`) |
| Host wiring | orchestrator 3400/3401 (avoiding the running phase-b stack on 3300/3301), candidate PostgreSQL `127.0.0.1:5443`, harness HTTPS 8443/9443 |
| Boot posture | r4.1 enforces SEC-ENC-05 ("real-data mode always requires the encryption surface" — it demanded `DU_VAULT_TRANSIT_OPTIONS`). No Vault-transit fixture is in gate scope and all data here is synthetic, so the run declares the same complete synthetic exemption the benchmark packet used; `/health` shows `dataMode: synthetic`, `metadataEncryption:false`, `secretResolver:false` (`orchestrator-health.json`). Real-data-mode boot remains a separate gate (F-VFY6-01 impl pending per §12.7). |
| Cleanup | `down -v --remove-orphans` exit **0**; project containers/volumes/networks removed; phase-b and live-infra projects untouched (`cleanup.log`, `post-cleanup-project-containers.txt`). |

## 1. Precheck — 64 MiB migrate-service cap (§12.6 carried flag)

Method: benchmark overlay limits (`0.05` CPU / `64 MiB`, swap=mem) plus
`live-gates.migrate-cap-probe.override.yml`, which keeps the real `node dist/migrate-cli.js migrate`
and reads the container's OWN cgroup peak afterwards; `docker stats` sampled concurrently.

| Measure | Value | Evidence |
|---|---|---|
| Memory / swap / nanoCpus | `67,108,864` B / `67,108,864` B / `50,000,000` | `migrate-container-inspect.json` |
| Run 1 (fresh DB): exit / OOMKilled | **0** / **false** | `migrate-final-state.json` |
| Migrations applied | **36**, then "migration verification passed" | `migrate-runtime.log` |
| cgroup `memory.peak` | **18,944,000 B ≈ 18.07 MiB (29.5 % of the 64 MiB cap)** | `migrate-runtime.log` (`LIVE_GATES_MEMORY_PEAK_BYTES=18944000`) |
| `docker stats` sampled peak | 17.77 MiB (27.77 % of cap) | `migrate-stats-samples.log` |
| Duration | 15:04:14.770 → 15:04:23.452 UTC incl. 5 s evidence hold (≈3.7 s migration) | `migrate-final-state.json` |

Later `docker compose up` invocations re-ran migrate idempotently (audit: current container log shows
repeated successful runs; the peak above is from the fresh-schema probe run). Cross-reference:
the benchmark execution receipt recorded the same r4.1 digest with exit 0 / OOMKilled false but
**no peak sample**; this precheck adds the measured peak and an independent fresh-DB rerun.
**Conclusion: the cap does not starve migrations at fresh-schema scale (max observed 29.5 %).**

## 2. Live gates 1→2→3

Runner: `run-live-gates.ps1 -Project du-live-gates-r41-20261006 -OperationId 21aa788c-… -First401`
(+ `-ExtraComposeFiles`, comma list; `-PgUrl` explicit). `run-summary.json`:
`check-migrations=0 webhook-live-idp=0 scan-plaintext-sentinels=0`, runner exit **0**.

### Gate 2 — migration applied-state (exit 0)

- `0035_webhook_result_delivery.sql` (sequence 35) and `0036_profile_callback_policy.sql`
  (sequence 36) applied exactly once.
- Columns present: `operations.callback_policy`, `webhook_deliveries.mode`,
  `webhook_deliveries.callback_policy`, `profile_bindings.callback_policy`.
- `--via-container` `dist/migrate-cli.js status`: applied **36/36**; the logger omitted the empty
  `pending` array, which the harness now accepts only when `applied == total` (see §3).

### Gate 3 — live HTTPS webhook IdP/receiver (exit 0)

- Seed: synthetic tenant `ebb5d49b-…` + `SUCCEEDED` operation `21aa788c-…`
  (`correlationId live-gates-synthetic-…`) via `seed-terminal-operation.cjs`; labeled synthetic.
- Container-side preflight: `idp.live-gates.test` → `192.168.65.254`, HTTPS reachable (HTTP 401
  without credentials) — DNS/TLS/route proven before dispatch.
- Dispatch through the image's own `deliverWebhooks`: delivery `d1cca5aa-3776-4d71-9164-ca19cd64dd83`
  → **DELIVERED, attempts 1**.
- Receiver receipts (`webhook-live/receipts.jsonl`): attempt 1 → **401** (injected first-401) with a
  valid HMAC and a valid Bearer (`tokenRef cb7529b0366ff6ca`); attempt 2 → **200** with a NEW token
  (`tokenRef d433d4d17fb566e5`); identical `bodySha256` — 401-reacquire proven. IdP issued 2 tokens.
- Honest history: two earlier deliveries `af77b557-…` and `b5bad793-…` are **FAILED** in the DB
  (`delivery-rows.txt`). They failed on a harness defect, not the candidate — see §3; `max_attempts=1`
  kept them terminal, and the successful row above is a third, independent delivery.

### Gate 1 — plaintext byte-scan (exit 0)

Sentinels: the synthetic OAuth client secret + HMAC sentinel generated by the webhook step.

| Store | Coverage | Result |
|---|---|---|
| PostgreSQL (candidate DB) | 30 tables / 50 cells (all `text/varchar/json/jsonb/bytea` columns, ctid-paged) incl. `webhook_deliveries`, `operations`, `profile_bindings`, `artifacts`, `tasks`, `tenants` | **0 hits**, 0 oversized cells, 0 errors |
| S3 `du-artifacts-live` | 19 objects / 5,141 bytes (bodies + keys) | **0 hits**, 0 skipped |
| Vault dev mount `secret` | 0 secrets present at run time | **0 hits** (leg default) |
| Supplement: Vault positive probe | synthetic sentinel written to `secret/du/live-gates-execution/probe`, scanned, then deleted | **PASS** — 1 expected-store hit, proving the Vault leg can detect (non-vacuous) |
| Supplement: S3 `du-artifacts-live2` | 0 objects | **PASS** (empty store, stated) |

No high-confidence credential shapes (Bearer/JWT/`hvs.`/`sk-`/AKIA/gh*/xox*/PEM) were found.

## 3. Harness defects found and fixed live (tooling only)

1. **Root cause of the two failed deliveries.** `runCompose()` used `spawnSync`, which blocks the
   event loop of the very process hosting the in-process HTTPS IdP/receiver during
   `docker compose exec`. Every container→fixture request therefore timed out
   (`UND_ERR_CONNECT_TIMEOUT` in the run-2 preflight; `TOKEN_ACQUISITION_FAILED` inside).
   Isolation tests: the same container reached a serve-mode fixture (HTTP 401) and token
   acquisition succeeded in isolation both plain and pinned (`oauth-probe` → token length 35), while
   the runner's exec starved its own servers. Fix: `runComposeAsync()` used for the live preflight
   and dispatcher exec. After the fix the suite passed 3/3.
2. **PowerShell 5.1 abort:** a native process writing to stderr under `ErrorActionPreference=Stop`
   terminated the runner after step 1; `Invoke-Step` now scopes `Continue` around the native call.
3. **`-ExtraComposeFiles`** switched to a comma-separated string (array flattening through
   `powershell -File` mis-bound positional parameters).
4. **`check-migrations`**: an omitted empty `pending` field is accepted only when
   `appliedCount == totalCount`.
5. New harness files: candidate-run / migrate-cap-probe / synthetic-mode overlays,
   `seed-terminal-operation.cjs`, `inside/connectivity-probe.cjs`, `inside/oauth-probe.cjs`.

Delta SHAs (full list in `harness-SHA256SUMS.txt`): `lib/live-common.cjs 7312D910…`,
`webhook-live-idp.cjs 25E16ADE…`, `check-migrations.cjs 1F911C0E…`, `run-live-gates.ps1 8D9195BB…`,
`README.md 7875A266…`, `seed-terminal-operation.cjs 5C91B1E5…`, `candidate-run.override.yml 05C73B5D…`,
`migrate-cap-probe.override.yml F0A1AEE1…`, `synthetic-mode.override.yml D623BD28…`,
`connectivity-probe.cjs C9633D81…`, `oauth-probe.cjs 6AFD037C…`. Unchanged:
`scan-plaintext-sentinels.cjs CAFE472E…`, `inside/run-dispatcher-inside.cjs F92F0B4C…`,
`lib/certs.cjs CD823C61…`, `compose/live-gates.override.yml 79E5F904…`.

## 4. What this proves — and what it does not

Proven on the tagged r4.1 images in an isolated project: 0035/0036 applied with all four columns;
the image's own dispatcher performed a live HTTPS OAuth2 client-credentials callback, survived an
injected 401 by reacquiring a fresh token, and wrote a durable `DELIVERED` receipt; no plaintext
sentinel or credential shape was found in the scanned PG/S3/Vault surface; the 64 MiB migrate cap
is not starved at fresh-schema scale (peak ≈18.07 MiB).

Not proven / out of scope: production cutover or promote; real-data-mode boot (needs a Vault transit
fixture; SEC-ENC-05 refusal observed); SC-01 catalog resolver (synthetic in-process resolver per the
accepted §12.3 boundary); operation scheduling (the seed row is synthetic); Portal roundtrip; boot
matrix; benchmark throughput; S3 coverage limited to the named buckets (large-object skip is fail-closed
by default); scans cover text-like columns, object bodies and KV secrets only, not every byte of every
server. No secrets are present in the evidence directory (leak checks for `POSTGRES_PASSWORD`,
`ADMIN_TOKEN`, `RUNTIME_TOKEN`, `ENCRYPTION_KEY`, and `postgresql://` URLs returned 0 hits).

## 5. Key evidence files

| File | Content |
|---|---|
| `run-summary.json` | runner aggregation, all steps exit 0 |
| `check-migrations.json/.log` | applied 0035/0036, four columns, container 36/36 |
| `webhook-live-idp.json/.log` | preflight, DELIVERED receipt, 401→reacquire, 2 tokens |
| `webhook-live/receipts.jsonl` | raw receiver receipts |
| `scan-plaintext-sentinels.json/.log` | PG/S3/Vault scan summary, 0 hits |
| `vault-positive/`, `s3-live2/` | supplement scans (positive Vault path, empty second bucket) |
| `migrate-final-state.json`, `migrate-runtime.log`, `migrate-stats-samples.log`, `migrate-container-inspect.json` | 64 MiB cap precheck |
| `delivery-rows.txt`, `final-project-state.txt`, `cleanup.log`, `cleanup-exit.txt` | durable DB state, final container state, cleanup |
| `sentinels.json` | synthetic sentinels (test-only values) |

Compliance: harness-only edits under `tools/live-gates/`; no product code touched; no commit, no push,
no task/gate tick; isolated project removed after evidence capture.
