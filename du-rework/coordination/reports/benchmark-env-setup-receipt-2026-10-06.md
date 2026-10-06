# Benchmark environment setup receipt

- Date: 2026-10-06.
- Status: IMPLEMENTED; actual Docker container-resource inspection PASS.
- Scope: Compose overlay, launcher, inspector and documentation only. No product code edits, commit, push or live benchmark.
- Files: `docker-compose.benchmark.yml`, `scripts/docker/benchmark.cjs`, `scripts/docker/start-benchmark.ps1`, `scripts/docker/BENCHMARK.md`.
- Candidate image tag: `candidate-portal-swagger-20261006-r4.1`.

## Allocation decision

Exactly ONE worker per benchmark project, selectable among all three business
workers. Each worker has `deploy.resources.limits.cpus: '1.0'` and memory `2048M`;
concurrency is 1. CPU quota is used, not host-specific cpuset affinity.

| Service | CPU | Memory MiB |
|---|---:|---:|
| Selected worker | 1.00 | 2048 |
| Orchestrator + Portal/BFF | 0.35 | 768 |
| Connector | 0.20 | 384 |
| PostgreSQL | 0.30 | 640 |
| Valkey | 0.10 | 188 |
| Migrate, including while stopped | 0.05 | 64 |
| **Total** | **2.00** | **4092** |

All services use `deploy.resources.limits`; all set memory+swap equal to memory
(no additional swap allowance). Three concurrent workers at 2048 MiB each cannot
fit 4092 MiB. Multiple profiles/replicas are therefore disallowed by the launcher
and inspector. Compose has no aggregate project cgroup; this bound follows from
the sum of per-container hard limits and the fixed service set. Host/engine
overhead and external S3/Vault/IdP/provider services are outside that allocation.

## Verification and evidence

- CWD: `D:\Git\dugate`; Compose/script internally resolves `du-rework`.
- Environment: Docker Desktop Linux, Docker Server 28.5.1, Compose v2.40.3.
- Synthetic environment generated with existing init-env.cjs into a temporary
  file outside the repo. Secret values were never written into evidence.
- `node du-rework/scripts/docker/benchmark.cjs config <worker> <temp-env> du-benchmark-verify-20261006`: all three worker choices PASS, exit **0** each; each selected exactly 6 services and total 2 CPU / 4092 MiB.
- `node du-rework/scripts/docker/benchmark.cjs create document-core <temp-env> du-benchmark-verify-20261006`: PASS, exit **0**. Created stopped containers only; no application process, migration, DB initialization or workload executed.
- Inspector checked actual `HostConfig.NanoCpus`, `Memory`, `MemorySwap` for ALL project containers, not just running ones. Every allocation matched; aggregate 2 CPU / 4092 MiB.
- Negative case: added an extra unlimited container in this isolated project. Inspector rejected it with resource mismatch and exit **1**; extra container removed. This demonstrates rejection rather than silently accepting aggregate drift.
- Final resource inspector rerun: PASS, exit **0**.
- Dedicated verification project/container/network/empty-volume cleanup: exit **0**. Temporary synthetic environment deleted. No existing application project was stopped or modified.
- Raw evidence: [benchmark-env-setup-2026-10-06](raw/benchmark-env-setup-2026-10-06/), including config allocation logs, create-and-inspect.log, inspect-resources.json, negative-case log/exit and cleanup log/exit.

## Launch and remaining limits

From `du-rework`:

```powershell
node scripts/docker/benchmark.cjs config document-core .env.docker
./scripts/docker/start-benchmark.ps1 -Worker document-core -EnvFile .env.docker
node scripts/docker/benchmark.cjs check document-core .env.docker
```

The start command runs the existing migration dependency; it is prepared but NOT
executed in this setup packet. Readiness, real-data encryption gates, migration
applied-state, throughput/latency and OOM behavior are NOT VERIFIED here. In
particular the 64 MiB migration cap must be validated before workload measurement.
No production readiness or ACCEPTED claim.
