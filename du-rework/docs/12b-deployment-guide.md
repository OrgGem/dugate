# Deployment Guide

> Bổ trợ cho [12-operations.md](12-operations.md) (vận hành), [architecture/06-aws-deployment.md](../architecture/06-aws-deployment.md) (AWS topology), và [infra/README.md](../infra/README.md) (test infra). Tài liệu này mô tả **docker-compose stack mới** (phương án C) — vừa chạy toàn bộ, vừa chạy lẻ từng service.

---

## 1. Deployment topology — docker-compose stack

```mermaid
flowchart TB
  subgraph Host["Single host (docker compose)"]
    PG[(postgres:16<br/>pgdata volume)]
    VK[(valkey:8<br/>valkeydata volume)]
    O[orchestrator<br/>:3000]
    C[connector<br/>:8080]
    DC[document-core<br/>worker]
    ER[example-review<br/>worker<br/>(optional)]
  end

  Client([API Clients<br/>:3000]) --> O
  Admin([Admin UI<br/>:3000/admin]) --> O
  O --> PG
  O --> VK
  C --> PG
  C --> VK
  DC --> O
  DC --> VK
  DC --> C
  ER --> O
  ER --> VK
  O -.->|S3 when ARTIFACT_STORAGE_BACKEND=s3| S3[(S3 / MinIO)]

  style PG fill:#336791,color:#fff
  style VK fill:#C63535,color:#fff
  style O fill:#0ea5e9,color:#fff
  style C fill:#8b5cf6,color:#fff
  style DC fill:#10b981,color:#fff
```

### Services trong `docker-compose.yml` tổng

| Service | Image (build) | Port (host:container) | Depends on | Networks |
|---|---|---|---|---|
| `postgres` | `postgres:16-alpine` | — (internal) | — | `du-platform-net` |
| `valkey` | `valkey/valkey:8-alpine` (`--appendonly yes`) | — (internal) | — | `du-platform-net` + `du-worker-net` |
| `orchestrator` | `services/orchestrator/Dockerfile` | `3000:3000` | postgres, valkey (healthy) | `du-platform-net` + `du-worker-net` |
| `connector` | `services/connector/Dockerfile` | `8080:8080` | postgres, valkey (healthy) | `du-platform-net` |
| `document-core` | `businesses/document-core/Dockerfile` | — (worker, no port) | orchestrator (healthy), valkey | `du-worker-net` |

### Networks

| Network | Mục đích | `internal` |
|---|---|---|
| `du-platform-net` | Orchestrator ↔ DB/Valkey/Connector | `false` (cần cho orchestrator port mapping) |
| `du-worker-net` | Worker ↔ Valkey/Orchestrator runtime | `false` |

Trong file `example-review/docker-compose.yml` (extension proof), `du-platform-net` là `internal: true` — worker cô lập hoàn toàn.

---

## 2. Per-service isolation

```mermaid
flowchart LR
  subgraph A["docker compose -f services/orchestrator/docker-compose.yml up"]
    O1[orchestrator] --- PG1[(postgres)] & VK1[(valkey)]
  end
  subgraph B["docker compose -f services/connector/docker-compose.yml up"]
    C1[connector] --- PG2[(postgres)] & VK2[(valkey)]
  end
  subgraph C2["docker compose -f businesses/document-core/docker-compose.yml up"]
    DC1[document-core] --- O2[orchestrator] & VK3[(valkey)] & PG3[(postgres)]
  end
```

Mỗi compose con **tự chứa deps** (postgres + valkey) để chạy độc lập. Khi chạy qua file tổng (`include:`), Compose merge — không tạo duplicate containers.

| Compose file | Chạy gì | Lệnh |
|---|---|---|
| `docker-compose.yml` (tổng) | Toàn bộ 5 services | `docker compose up -d --build` |
| `services/orchestrator/docker-compose.yml` | Orchestrator + postgres + valkey | `docker compose -f services/orchestrator/docker-compose.yml up -d` |
| `services/connector/docker-compose.yml` | Connector + postgres + valkey | `docker compose -f services/connector/docker-compose.yml up -d` |
| `businesses/document-core/docker-compose.yml` | document-core + orchestrator + postgres + valkey | `docker compose -f businesses/document-core/docker-compose.yml up -d` |
| `businesses/example-review/docker-compose.yml` | Extension proof (pinned digests) | `docker compose -f businesses/example-review/docker-compose.yml up -d` |
| `infra/docker-compose.yml` | Test fixture (5433/6380 loopback) | `docker compose -f infra/docker-compose.yml up -d` |

---

## 3. Environment variables

Copy template trước khi chạy:

```bash
cp .env.example .env   # sửa RUNTIME_TOKEN, ADMIN_TOKEN, POSTGRES_PASSWORD
```

### Bắt buộc

| Variable | Mô tả | Ví dụ |
|---|---|---|
| `RUNTIME_TOKEN` | Worker ↔ Orchestrator bearer (≥32 chars) | `openssl rand -hex 32` |
| `ADMIN_TOKEN` | Admin API bearer (khác RUNTIME_TOKEN) | `openssl rand -hex 32` |
| `POSTGRES_PASSWORD` | DB password | `change_me_...` |

`ADMIN_TOKEN == RUNTIME_TOKEN` → **từ chối boot** (fail-closed).

### Tùy chọn chính

| Variable | Default | Mô tả |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_DB` | `du` / `du_orchestrator` | DB user/db name |
| `DATABASE_URL` | `postgresql://du:...@postgres:5432/du_orchestrator` | Override DB URL (external DB) |
| `REDIS_URL` | `redis://valkey:6379` | Valkey URL |
| `ORCHESTRATOR_PORT` | `3000` | Host port mapping |
| `CONNECTOR_PORT` | `8080` | Host port mapping |
| `RUNTIME_URL` | `http://orchestrator:3000/api/runtime/v1` | Worker → Orchestrator runtime |
| `CONNECTOR_URL` | _(empty)_ | Worker → Connector |
| `AUTO_MIGRATE` | `false` | `true` = migrate on boot (dev only) |
| `ARTIFACT_STORAGE_BACKEND` | `postgres` | `postgres` hoặc `s3` |
| `ARTIFACT_S3_BUCKET` / `REGION` / `ENDPOINT` | _(empty)_ | S3 config (khi backend=s3) |
| `DOCUMENT_CORE_CONCURRENCY` | `2` | Worker concurrency |
| `HEARTBEAT_INTERVAL_MS` | `10000` | Lease heartbeat |
| `SHUTDOWN_GRACE_MS` | `15000` | Graceful shutdown |

Xem đầy đủ trong [.env.example](../.env.example).

---

## 4. Health checks & lifecycle

| Service | Health check | Interval | Start period |
|---|---|---|---|
| `postgres` | `pg_isready -U du` | 5s | — |
| `valkey` | `valkey-cli ping` | 5s | — |
| `orchestrator` | `fetch http://127.0.0.1:3000/health` | 10s | 15s |
| `connector` | `fetch http://127.0.0.1:8080/health/ready` | 10s | 25s |
| `document-core` | (worker, no HTTP — liveness via heartbeat) | — | — |

**Boot order:** `postgres` + `valkey` (healthy) → `orchestrator` → `connector` / `document-core`.

**Shutdown:** `SIGTERM` → `installGracefulShutdown` → `app.close()` (webhook drain → lease drain → queues/redis/pg) → `exit(0)`. Second signal → `exit(1)` ngay. Xem [09-system-architecture.md](09-system-architecture.md) § shutdown chain.

**Migrations:** Production chạy `npm run migrate` **trước** `npm start` (`AUTO_MIGRATE=false`). Dev/test có thể `AUTO_MIGRATE=true` để zero-config boot. Xem `services/orchestrator/src/main.ts` boot order.

---

## 5. Valkey vs Redis

Queue mặc định là **Valkey + BullMQ** (BSD fork của Redis, wire-compatible):

- Giữ nguyên code `BullMQ` / `ioredis` — chỉ đổi `REDIS_URL` sang `valkey:6379`.
- Image: `valkey/valkey:8-alpine` với `--appendonly yes` (persistence).
- Không dùng Redis 7.4+ RSAL cho deploy mới.
- `pgboss` là phương án thay thế (chỉ Postgres+S3, bỏ Valkey) — không chạy chung với BullMQ trên cùng queue.

---

## 6. Volumes & persistence

| Volume | Mount | Nội dung | Backup |
|---|---|---|---|
| `pgdata` | `/var/lib/postgresql/data` | PostgreSQL data | `infra/scripts/backup-postgres.sh` |
| `valkeydata` | `/data` | Valkey AOF | Không cần backup riêng (queue là transient; DB là source of truth) |

Artifact bytes:
- `postgres` backend: nằm trong `pgdata` (bytea) — pilot only.
- `s3` backend: private S3 bucket — durable, versioned. Xem [ADR-10](../architecture/02-application.md).

---

## 7. Backup / Restore / Rollback

| Thao tác | Lệnh / Tài liệu |
|---|---|
| Backup Postgres | `infra/scripts/backup-postgres.sh` (pg_dump custom + sha256 sidecar) |
| Restore Postgres | `infra/scripts/restore-postgres.sh` (verify sha256 + single-transaction restore) |
| Migrations | `services/orchestrator: npm run migrate` / `migrate:status` / `migrate:verify` |
| Rollback image | `docker compose pull && docker compose up -d` với digest cũ |
| Rollback profile | Admin: chuyển profile về revision trước (không tự biến đổi checkpoint cũ) |

Không rollback DB phá hủy cột sau khi code mới đã ghi dữ liệu. Giữ old workers cho snapshot/waits cũ; chỉ retire khi không còn dependency (xem [architecture/06-aws-deployment.md](../architecture/06-aws-deployment.md) § deploy & rollback).

---

## 8. Capacity sizing (placeholder)

Chưa có SLA/throughput/quota production. Workload matrix cần đo:

| Dimension | Ví dụ |
|---|---|
| File bytes/pages | 1KB – 300MB, 1–100 pages |
| Action mix | ingest 30%, extract 40%, analyze 15%, ... |
| Provider latency | 500ms – 30s per call |
| Calls per document | 1–5 (tùy recipe) |
| Tenant concurrency | 1–100 concurrent operations |
| Human wait time | phút – ngày |

Mọi SLO trong test chỉ là benchmark target trên mock, không phải cam kết production. Xem [22-p0-06-capacity-targets.md](22-p0-06-capacity-targets.md) và [architecture/07-capacity.md](../architecture/07-capacity.md).

---

## 9. Liên kết tài liệu

| Tài liệu | Vai trò |
|---|---|
| [02-architecture.md](02-architecture.md) | Kiến trúc mục tiêu 3 tầng |
| [09-system-architecture.md](09-system-architecture.md) | Đường dữ liệu đã materialize |
| [12-operations.md](12-operations.md) | Vận hành chi tiết |
| [17-operational-runbooks.md](17-operational-runbooks.md) | Runbooks & alerts |
| [architecture/06-aws-deployment.md](../architecture/06-aws-deployment.md) | AWS EC2 topology |
| [architecture/08-operations.md](../architecture/08-operations.md) | Operations (arch view) |
| [infra/README.md](../infra/README.md) | Test infra (5433/6380) |
| [infra/deployment-architecture.md](../infra/deployment-architecture.md) | Target deployment proposal |
| `docker-compose.yml` + `services/*/docker-compose.yml` | Compose files (phương án C) |
| `.env.example` | Env template |
