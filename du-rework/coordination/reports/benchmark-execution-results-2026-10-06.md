# Benchmark execution results - 2026-10-06

Status: **PARTIAL: ingestion PASS; extract FAILED before provider invocation.** This is a short sample run, not a sustained capacity/SLA test or release acceptance.

## Environment and migration preflight

- Execution UTC: 2026-10-06T14:32:10.645296+00:00. Project `du-benchmark-run-20261006`; fresh disposable PostgreSQL/Valkey volumes, synthetic tenant and API keys. Existing projects were not modified.
- Candidate tag `candidate-portal-swagger-20261006-r4.1`, Node v24.21.0, Docker Desktop Linux. Per-service image IDs in final-runtime-state.json pin the actual deployed build.
- Limits verified on all 6 containers: document-core 1 CPU / 2048 MiB; complete project including stopped migration 2 CPU / 4092 MiB (4290772992 bytes); swap equals RAM. No CPU affinity pin.
- Migration prerequisite ran on a fresh DB BEFORE workload: `docker start ...-migrate-1` + `docker wait ...-migrate-1`; migration exit **0**, OOMKilled **false**, memory limit **67108864 bytes**, CPU quota **0.05**. Its log reports migration application and verification. This validates this candidate/fresh-schema run only, not arbitrary migration data volume; no migration peak RAM was sampled.
- Initial real-data-mode startup failed, exit 1, due to incomplete encryption configuration. The measured stack uses the explicit synthetic exemption in run-overlay.yml; no real/customer data was used. Security release gates are unaffected.
- Started through `start-benchmark.ps1 -Worker document-core -EnvFile <private-temp-env> -Project du-benchmark-run-20261006 -Overlay <raw>/run-overlay.yml`; final launcher exit **0**. Added optional overlay argument to benchmark tooling while retaining budget verification. No product code changes.

## Method

- Host-side Node load generator; deterministic invoice provider runs as host process on 38090, outside SUT quota as an external provider. No paid AI. External provider latency is not representative of a real AI service.
- Synthetic inline text `ingest mode=parse` and `extract type=invoice`. This run does NOT measure PDF/DOCX upload, URL acquisition, OCR or file parsing. It measures supported inline ingestion/extract requests.
- One warmup per action excluded; 12 measured requests per action, client concurrency 2, worker concurrency 1. Closed-loop workload, 100 ms operation polling, e2e latency includes admission, queue/processing, poll detection and result-body download on success.
- Fixture bootstrap registered the bundled document-core manifest through Runtime PUT, enabled/activated version 1.0.0, issued a tenant-scoped API key and pinned profile/Connector revision through authenticated management APIs. Synthetic tenant creation was isolated to the fresh benchmark DB.
- Initial admission probes returned 404 because the business manifest was not yet registered/activated; those samples are excluded (admission-preflight.json). A first attempt with synchronous stats collection is excluded (first-measured-attempt.json); final run uses asynchronous stats sampling to avoid blocking the load generator.
- Nearest-rank percentiles; with n=12, p95/p99 equal the sample maximum and do not establish tail reliability. Measurements are short, not steady-state saturation tests.

## Observed measurements

| Action | Success / measured | Successful req/s | p50 ms | p95 ms | p99 ms | Meaning |
|---|---:|---:|---:|---:|---:|---|
| ingest | 12/12 | 7.930 | 244.05 | 291.47 | 291.47 | successful e2e (admission through result fetch) |
| extract | 0/12 | 0.000 | 129.05 | 245.34 | 245.34 | terminal failure latency, NOT successful extract latency |

Extract: all measured requests were accepted HTTP 202, then FAILED / PROVIDER_UNAVAILABLE. Successful throughput is 0 req/s; successful extract latency is **N/A**. The table shows time-to-failure for extract, not capacity. Mock provider calls were **0**; count-only Connector query found **0 invocation rows**. Failure is upstream of persisted invocation/provider execution; precise root cause is not proven in this packet and requires a separate implementation/verification lane.

## RAM / CPU / OOM

Docker stats snapshots across warmup and measured window: 1. CPU percentages below use Docker convention (100%=one logical core); quota saturation divides that percentage by allocated cores. RAM is Docker-reported working-set percentage of the cap, not total RSS. Sparse short-window samples cannot prove sustained saturation or absence of brief spikes. Lifetime cgroup memory.peak, memory.events and cpu.stat are captured separately and include startup/fixture setup.

| Service | Cap MiB | Peak sampled RAM % cap | Peak sampled CPU % core | Peak sampled CPU % quota | OOMKilled | Restarts |
|---|---:|---:|---:|---:|---|---:|
| connector | 384 | 6.93 | 0.23 | 1.15 | False | 0 |
| orchestrator | 768 | 7.13 | 28.23 | 80.66 | False | 0 |
| document-core | 2048 | 2.76 | 16.79 | 16.79 | False | 0 |
| migrate | 64 | 0.00 | 0.00 | 0.00 | False | 0 |
| postgres | 640 | 9.25 | 23.91 | 79.70 | False | 0 |
| valkey | 188 | 3.43 | 0.76 | 7.60 | False | 0 |

Migrate was already exited during workload, so its sampled utilization is N/A (table zeros mean no running sample). All final OOMKilled flags are false; cgroup counters are preserved for independent review. Other pre-existing Docker workloads were running on this host; these results are subject to host contention. Container quota sum excludes host/Docker overhead and external provider process.

## Raw evidence and handoff

[Raw evidence](raw/benchmark-execution-2026-10-06/) contains migration preflight state/log, startup logs/exit codes, explicit synthetic overlay, benchmark-driver.cjs, per-request timings and Docker stats in workload.json, measurement-summary.json, final resource/state/cgroup evidence, Connector count-only query, runtime logs, cleanup evidence and SHA256SUMS.txt. No raw API key or environment values are included.

Harness completed with exit 0; functional workload verdict is **FAIL for extract**, not PASS. No product fix, image rebake, acceptance tick, commit, push or promotion. Further work: resolve pre-invocation extract failure and re-run with successful output validation, then use larger/longer file cohorts for saturation and reliable tail percentiles.

Cleanup: dedicated benchmark containers/networks/synthetic volumes removed, exit 0; temporary environment deleted. No benchmark processes left running. Success validation in this sample is terminal SUCCEEDED plus result HTTP 200; golden artifact content validation is a separate unperformed gate.
