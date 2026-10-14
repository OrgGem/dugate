# Constrained benchmark environment

Run from `du-rework` with Node 24, Docker Compose 2.20+ and a Linux Docker engine.
Provision `.env.docker` using the existing environment guide. For synthetic local
credentials only: `node scripts/docker/init-env.cjs .env.docker` (never overwrites).
Images tagged `candidate-portal-swagger-20261006-r4.1` must already be available.
The runner does not build or pull a different application tag.

Apply the local database bootstrap and schema migrations before starting the
benchmark project. The runner pins application images to
`candidate-portal-swagger-20261006-r4.1`; use the same tag for bootstrap and
migrations. Review that these commands use only the local development database
configured in `.env.docker`:

```powershell
$env:DU_IMAGE_TAG = 'candidate-portal-swagger-20261006-r4.1'
docker compose --project-name du-benchmark --env-file .env.docker -f docker-compose.yml -f docker-compose.benchmark.yml --profile local-bootstrap up -d postgres valkey
docker compose --project-name du-benchmark --env-file .env.docker -f docker-compose.yml -f docker-compose.benchmark.yml --profile local-bootstrap run --rm connector-db-init
docker compose --project-name du-benchmark --env-file .env.docker -f docker-compose.yml -f docker-compose.benchmark.yml --profile migration run --rm orchestrator-migrate migrate
docker compose --project-name du-benchmark --env-file .env.docker -f docker-compose.yml -f docker-compose.benchmark.yml --profile migration run --rm connector-migrate migrate
```

```powershell
# Safe preflight: prints only resource allocations, never the resolved environment.
node scripts/docker/benchmark.cjs config document-core .env.docker

# Starts the dedicated project after the explicit migration step above.
./scripts/docker/start-benchmark.ps1 -Worker document-core -EnvFile .env.docker

# Equivalent cross-platform launcher and subsequent inspect check:
node scripts/docker/benchmark.cjs start document-core .env.docker
node scripts/docker/benchmark.cjs check document-core .env.docker
```

Choose `document-core`, `lc-checker`, or `example-review`. Exactly one worker may
run in this project. Stop the previous dedicated benchmark project before changing
worker; never activate multiple benchmark profiles or scale above one replica.
The runner clears inherited `COMPOSE_PROFILES`, explicitly selects one profile,
validates the resolved Compose service set before launch, and rejects unexpected
services, replicas, missing/unlimited limits or mismatches during inspect.

| Container | CPU quota | RAM MiB |
|---|---:|---:|
| Selected worker (concurrency 1) | 1.00 | 2048 |
| Orchestrator, including Portal/BFF | 0.35 | 768 |
| Connector | 0.20 | 384 |
| PostgreSQL | 0.30 | 640 |
| Valkey | 0.10 | 188 |
| **Running allocation total** | **1.95** | **4028** |

The overlay uses `deploy.resources.limits`. It also sets `memswap_limit` equal
to RAM, so no extra swap budget is allowed. `cpus: '1.0'` means a CPU quota;
it does not pin a physical core. CPU affinity (`cpuset`) is intentionally omitted
so this works across hosts without assuming particular logical CPU IDs.

Compose has no parent cgroup enforcing a whole-project limit. The sum of running
container hard limits stays under the 2.00 CPU / 4092 MiB ceiling while the
service set stays fixed.
Use the guarded launcher and inspect check. Docker/host overhead and external
services (S3, Vault, IdP or provider) are outside these container totals. Do not add
sidecars to the benchmark without redistributing the allocation and updating the
guard. Three simultaneous 2048 MiB workers cannot fit this budget.

`create` instead of `start` creates stopped containers for inspecting limits only;
it does not execute application processes. Passing the inspect check does not
prove application readiness or benchmark performance. Migrations are outside
this running allocation and must complete before measuring.

Cleanup the dedicated project without deleting its persisted data:

```powershell
docker compose --project-name du-benchmark --env-file .env.docker -f docker-compose.yml -f docker-compose.benchmark.yml --profile benchmark-document-core down
```
