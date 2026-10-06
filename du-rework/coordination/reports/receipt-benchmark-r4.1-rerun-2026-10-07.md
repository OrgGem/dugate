# Receipt — Benchmark r4.1 re-run with KEK wiring (Section 13.8 resolution)

- **Task:** Re-run the r4.1 benchmark workload on Docker after the
  `CONNECTOR_INVOCATION_ENCRYPTION_KEYS` wiring fix; prove extract no longer fails pre-invocation
  with `PROVIDER_UNAVAILABLE`; collect measurements; clean up.
- **Recipient/Owner:** oc_2 (`term_169a5da5-5a0c-4cbf-b226-7f2d51264b24`), mode WORKER/BENCHMARK OPERATOR.
- **Repo scope:** `du-rework` ONLY. **Compliance: KHÔNG commit, KHÔNG push.** No product code edited
  in this packet (evidence tooling only, under `coordination/reports/`).
- **References:** `coordination/reports/receipt-benchmark-kek-config-2026-10-07.md`,
  `coordination/reports/diag-benchmark-extract-failure-2026-10-07.md`, Claude Reviewer §13.8,
  canonical benchmark plan `coordination/reports/benchmark-execution-results-2026-10-06.md`.
- **Verdict:** **PASS_INGEST_AND_EXTRACT** — **Extract 12/12 SUCCEEDED** (was 0/12
  `PROVIDER_UNAVAILABLE`), **13 mock-provider calls**, **13 `connector_invocations` rows all
  SUCCEEDED**, staleness marker `PROVIDER_UNAVAILABLE` count **0**. The fix is validated live.

## 1. Environment preparation

| Item | Value |
|---|---|
| Env file | generated: `node scripts/docker/init-env.cjs .env.benchmark.tmp` (exit 0), ports adjusted `ORCHESTRATOR_PORT=33000`, `ADMIN_SHELL_PORT=33001` (3001 occupied on host) |
| KEK validation | generated value fed through the **real parser** `parseLocalInvocationKekConfig`: `{valuePresent:true, keyRef:"du-connector-invocation-v1", activeVersion:1, versions:["1"], kekBytes:32}` — exit 0 (`kek-check.json`) |
| Project | `du-benchmark-r41-v2` (dedicated namespace, validated by the launcher) |
| Overlay | `coordination/reports/raw/benchmark-execution-2026-10-06/run-overlay.yml` (synthetic data mode + `PROVIDER_ALLOW_HOSTS=host.docker.internal`, `ALLOW_PRIVATE_PROVIDER_NETWORKS=true`) |
| Images | `candidate-portal-swagger-20261006-r4.1` (orchestrator/connector/document-core), Compose v2, Docker Desktop Linux |
| Config preflight | `node scripts/docker/benchmark.cjs config …` exit **0**, aggregate 2 CPU / 4092 MiB |
| Runtime key presence | connector container env `CONNECTOR_INVOCATION_ENCRYPTION_KEYS` present (value length 117, value never printed) |

Stack: `start-benchmark.ps1 -Worker document-core` → exit **0**; `migrate` Exited (0); orchestrator and
connector healthy; document-core worker registered and listening before the workload.

## 2. Workload execution

`benchmark-driver.cjs` (copied from the previous run, project name adapted only; evidence tooling) →
exit **0**. Synthetic fixture: bundled document-core manifest registered + activated, synthetic tenant
+ API key, `extract` slot `reasoning` bound to a `json-http` connector pointing at the deterministic
host mock provider `:38090`. Warmup + 12 measured requests per action, client concurrency 2.

## 3. Measured results

| Action | Success / measured | Result HTTP | Req/s (successful e2e) | p50 | p95 | p99 | Admission p50 / p95 |
|---|---:|---:|---:|---:|---:|---:|---:|
| ingest | **12/12** | 200 | 6.169 | 249 ms | 382 ms | 382 ms | 18 / 32 ms |
| extract | **12/12** | 200 | 4.633 | 350 ms | 544 ms | 544 ms | 13 / 56 ms |

Provider/idempotency evidence (all raw in §8):
- **Mock provider calls: 13** (12 measured + 1 warmup; exactly one provider execution per extract →
  no hidden retries). Previous run: **0**.
- `connector_invocations`: **SUCCEEDED = 13**, no error codes. Previous run: **0 rows**.
- `operations`: `extract SUCCEEDED = 13`, `ingest SUCCEEDED = 13`, `error_code` none.
- document-core worker log: **0** `PROVIDER_UNAVAILABLE`, **0** `handler failed` lines.
- Envelope sanity (bonus): 13 request rows stored as `version 1 / aes-256-gcm`, **0** rows containing
  the synthetic plaintext sentinel — the KEK is actively sealing invocation storage, not merely accepted.

## 4. Resources / stability (all caps from the guarded allocation)

- Resource inspector final run: **exit 0**, every container matches its limit, aggregate **2 CPU /
  4092 MiB**, swap == RAM; **OOMKilled=false**, **RestartCount=0** for all 6 containers
  (`final-container-state.json`).
- `docker stats` sampled peaks: orchestrator 10.35 % / 79.5 MiB / 32.5 % CPU core;
  connector 8.58 % / 32.9 MiB / 9.2 %; document-core 3.55 % / 72.7 MiB / 22.4 %; postgres 8.7 % /
  55.7 MiB / 28.7 %; valkey 3.43 % / 6.4 MiB / 2.8 % (2 samples during the short run).
- cgroup `memory.peak`: orchestrator 109.5 MB, document-core 78.5 MB, connector 53.4 MB,
  postgres 106.2 MB, valkey 9.1 MB (migrate unavailable — container exited; its cap check was done
  by the previous packet).

## 5. Comparison — Section 13.8 root cause resolved

| Signal | Previous run (2026-10-06) | This re-run (2026-10-07) |
|---|---|---|
| extract | 0/12, `FAILED PROVIDER_UNAVAILABLE`, p50 ≈129 ms | **12/12 SUCCEEDED, HTTP 200**, p50 350 ms |
| mock provider calls | 0 | **13** |
| `connector_invocations` | 0 rows | **13 SUCCEEDED** |
| failure point | ledger `claim` (no KEK) → 502 before provider | provider invoked, result validated, operation SUCCEEDED |

## 6. Cleanup

- `docker compose … down -v --remove-orphans` for `du-benchmark-r41-v2`: exit **0**; dedicated
  containers, networks and synthetic volumes removed.
- `.env.benchmark.tmp` deleted and confirmed absent; mock-provider port 38090 free (provider child
  terminated by the driver); no stray benchmark containers.
- Other projects untouched (arch-phase-b stack and `du-live-*` still running).

## 7. Honest limits

- Short synthetic sample (12 measured per action, concurrency 2): not a sustained capacity/SLA run;
  p95/p99 with n=12 are coarse. Mock provider is a deterministic host process **outside** the SUT
  resource budget; no paid AI; inline text only (no PDF/DOCX/OCR path).
- The driver and summary script were copied/adapted from the previous run as evidence tooling
  (project name/ports); they did not modify product code.
- The KEK wiring changes (`compose/connector.yml`, `scripts/docker/init-env.cjs`) remain
  **uncommitted** from the previous packet, per code freeze. Boot-refusal follow-up (SEC-ENC-05 per
  the diagnostic §5) is still open and out of scope here.

## 8. Evidence

`coordination/reports/raw/benchmark-r41-rerun-2026-10-07/` (**22 files + `SHA256SUMS.txt`**), including:
- `workload.json` `029372AF…`, `measurement-summary-rerun.json` `1261EF78…`, `driver-console.log`
  `32DC7F46…`, `start-benchmark.log` `766742C0…`
- `kek-check.json`, `benchmark-config.json`, `start-benchmark-exit.txt` (0), `driver-exit.txt` (0)
- `invocation-counts.txt` (`SUCCEEDED|13`), `operation-counts.txt` (`extract|SUCCEEDED|13`,
  `ingest|SUCCEEDED|13`), `envelope-sanity.txt` (`13|0|1|aes-256-gcm`) `11AE93AD…`
- `final-container-state.json` `E6436A24…`, `final-resource-inspect.json`, `cgroup-peaks.txt`
- `cleanup.log`, `cleanup-exit.txt` (0), runtime logs for document-core/orchestrator/connector.
