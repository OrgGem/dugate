# Deployment Guide

Local/rework Docker Compose topology for the **DU Platform**: **Orchestrator Backend** (Platform API + Orchestration Runtime, one process), **Orchestrator Portal** (session-facing BFF), **Connector Service** and three **Business Worker** services (Document Core, LC Checker, Example Review). Run commands from `du-rework/` with Docker Engine/BuildKit and **Compose 2.20+**. The **Node 24 LTS** baseline for Orchestrator Backend/Portal build, Connector Service and all Business Workers is **SPECIFIED** (plan [DU-PLATFORM-MIGRATION](../tasks/DU-PLATFORM-MIGRATION-2026-10-05.md), 2026-10-06): an isolated MIG-04 candidate built on Node 24.21.0 PASSES, while full worker/template parity and the security gate remain OPEN. This guide describes buildable services in the current workspace; it does not establish independent Git repositories, an active production deployment, or production acceptance. The user-approved target is two repo types: Orchestrator (Portal + Backend + Connector Service source, Connector in its own service/image) and Worker template instances deployed per business. Test fixtures under `infra/` are separate from this stack.

## 1. Deployment topology

The canonical `Dockerfile` has five service targets. It pins Node by digest and pnpm 10.18.3, builds the runtime workspace dependency closure, and deploys production dependencies with compiled code. Runtime images run as `node`; the Orchestrator image also packages the Orchestrator Portal (React) bundle served at `/admin/web`. Compatibility Dockerfiles in each service directory are generated with `node scripts/docker/sync-dockerfiles.cjs`.

| Service | Container ports | Dependencies | Networks |
|---|---|---|---|
| postgres | 5432, unpublished | persistent `pgdata` | platform |
| valkey | 6379, unpublished | AOF `valkeydata`, `noeviction` | platform, worker |
| migrate | none; exits after verification | healthy postgres | platform |
| orchestrator | Orchestrator Backend: 3000 Public JSON, 3002 Internal JSON (unpublished), Orchestrator Portal shell 3001 — PM-M02 mappings materialized in working tree | successful migrate, healthy valkey | platform, worker |
| connector | Connector Service: 8080, unpublished in the default stack — PM-M02 materialized in working tree | healthy postgres and valkey; owns its migrations | platform, worker |
| document-core | none (Business Worker) | healthy orchestrator, connector, valkey | worker |
| lc-checker | none (Business Worker) | healthy orchestrator, connector, valkey | worker |
| example-review | none (Business Worker) | healthy orchestrator and valkey | worker |

`compose/infra.yml` owns infrastructure, networks and volumes exactly once. Other fragments own their services. Compose `include` does not merge conflicting resource definitions. Networks and volumes are project-scoped; no fixed container names are used.

### 1.1 PM-M02 ingress matrix

The following is the **approved target**, specified in [PM-M02 ingress spec](../coordination/reports/codex-arch-pm-m02-ingress-spec-2026-10-05.md); the route/Compose side is now **materialized in the working tree** (2026-10-06): `compose/orchestrator.yml` maps 3000/3001 through `${BIND_ADDRESS:-127.0.0.1}` and does not map 3002; `compose/connector.yml` has no host mapping for 8080; `compose/local-debug.yml` exists as the opt-in loopback overlay; the fragment defaults for workers are `RUNTIME_URL=http://orchestrator:3002/api/runtime/v1` and `CONNECTOR_URL=http://connector:8080`. PM-M02 acceptance itself remains **OPEN**: the 2026-10-06 full verifier stopped at the host TCP check because an unrelated `nginx-ui` container occupies host port 8080 (the test project published no 8080 mapping), so rerun in a collision-free environment and complete the separate-client firewall probe before closing. Working-tree materialization is not a production-deployment claim.

| Ingress | Container listener | Routes / caller policy | Default host mapping |
|---|---|---|---|
| Public API | Orchestrator 3000 | Existing public `/api/v1/*` excluding admin, plus existing health. Admin/runtime/internal rejected with generic 404 before body/context/handler work, even with valid privileged credentials | `${BIND_ADDRESS:-127.0.0.1}:${ORCHESTRATOR_PORT:-3000}:3000` |
| Internal JSON | Orchestrator 3002 | Existing public/admin/runtime routes with existing API-key, admin, worker business and usage identity checks | None |
| Orchestrator Portal / BFF | Orchestrator 3001 | Existing session/OIDC/CSRF and explicit BFF allowlist; upstream uses the bound internal JSON origin | `${BIND_ADDRESS:-127.0.0.1}:${ADMIN_SHELL_PORT:-3001}:3001` |
| Connector API / health | Connector 8080 | Existing root-path contract and service-identity/grant rules; existing health exemption unchanged | None |

Both JSON listeners share one Orchestrator process, resources and background loops. Listener identity establishes ingress audience; request headers cannot select it. Internal retains public handlers because BFF operations/usage reads need them; internal network reachability does not grant authorization. Public reverse proxies must target 3000 or the intended Portal routes on 3001, never 3002/8080.

Document Core, LC Checker and Example Review all default to `RUNTIME_URL=http://orchestrator:3002/api/runtime/v1` after migration. Update any explicit operator overrides at the same time. Connector URL remains `http://connector:8080`; an enabled Connector usage sink must use `http://orchestrator:3002/api/runtime/v1/usage-events` and its dedicated token. Leave usage ingestion disabled when its URL/token are unset. Do not replace public upload/artifact origins with the internal origin.

Removing host mappings fences external/public ingress, not traffic between peers on shared Compose networks. Keep route authentication and required provider/storage/OIDC outbound connectivity; changing shared networks to `internal: true` requires a separate connectivity review.

### 1.2 Optional local debug overlay

`compose/local-debug.yml` now exists in the working tree and stays outside the default root includes (`docker-compose.yml` includes only `infra`, `orchestrator`, `connector`, `document-core`, `lc-checker`, `example-review`). Use the following command sequence from `du-rework/`; config-only checks on 2026-10-06 confirmed the base effective config has no project host bindings on 3002/8080 even under widened bind, while the full PM-M02 live acceptance above remains open:

```bash
docker compose --env-file .env.docker -f docker-compose.yml -f compose/local-debug.yml config --quiet
docker compose --env-file .env.docker -f docker-compose.yml -f compose/local-debug.yml config
docker compose --env-file .env.docker -f docker-compose.yml -f compose/local-debug.yml up -d --wait
```

Inspect rendered configuration locally without sharing secrets. The overlay adds only `127.0.0.1:${ORCHESTRATOR_INTERNAL_DEBUG_PORT:-3002}:3002` for Orchestrator and `127.0.0.1:${CONNECTOR_DEBUG_PORT:-8080}:8080` for Connector. These are host debug ports, distinct from container listener settings. Bind literal loopback, never inherit `BIND_ADDRESS`; debug access still requires the applicable credentials and does not enable runtime/admin on public 3000. A profile alone must not publish ports on the normally enabled Connector service.

The deployment owner must still re-verify actual include/override merge behavior and both rendered configurations after any change: base has no 3002/8080 publication even with `BIND_ADDRESS=0.0.0.0`; debug has only loopback publication for those ports. Subsequent runs without debugging omit the overlay and recreate affected services to remove their host debug mappings. See IF-07/IF-08 in the spec for effective-config/socket/connectivity checks.

## 2. Full stack and individual services

For local Docker development, generate fresh credentials without overwriting existing files:

```bash
node scripts/docker/init-env.cjs .env.docker
docker compose --env-file .env.docker config --quiet
docker compose --env-file .env.docker build
docker compose --env-file .env.docker up -d --wait --wait-timeout 180
docker compose --env-file .env.docker ps -a
docker compose --env-file .env.docker logs --tail 100
```

The generated Connector identity expires after **24 hours**. For production, copy `.env.docker.example`, provision keys/tokens through your identity issuer, and refresh expiring service identities through your deployment process. To replace a local expired identity, generate into a new filename and use that env file; existing credentials are never overwritten by the helper.

Each standalone wrapper starts its full dependency closure using the same fragments:

| Compose file | Services beyond shared infrastructure |
|---|---|
| `services/orchestrator/docker-compose.yml` | migrate, orchestrator |
| `services/connector/docker-compose.yml` | connector |
| `businesses/document-core/docker-compose.yml` | migrate, orchestrator, connector, document-core |
| `businesses/lc-checker/docker-compose.yml` | migrate, orchestrator, connector, lc-checker |
| `businesses/example-review/docker-compose.yml` | migrate, orchestrator, example-review |

```bash
docker compose --env-file .env.docker -f businesses/lc-checker/docker-compose.yml up -d --build --wait
# Build a single image without starting dependencies:
docker build --target lc-checker -t du-lc-checker:local .
# Start selected services within the shared full-stack project:
docker compose --env-file .env.docker up -d --build document-core
```

Standalone files use different project names. Use different host ports if starting multiple projects concurrently. For scaling workers, prefer the full stack's selected services so they share one runtime and queue. Register business manifests and configure profile/provider bindings before submitting real jobs; worker process startup does not provision these records.

### 2.1 Deployment verification status (2026-10-06)

Scoped live-local evidence on the isolated `arch-phase-b-20261006` Docker stack (PostgreSQL 16, Valkey 8, Orchestrator Backend, Connector Service, three Business Workers) — **Ingest and Extract both PASS 100%** for the exercised fixtures:

| Flow | Operation | Evidence |
|---|---|---|
| Ingest | `64edc168-c736-4e9f-aebb-71b5aed722cd` | 202 → SUCCEEDED; 1 task / 2 checkpoints; `/result` + download HTTP 200; idempotency replay 200 with the same operation ID ([phase-b-live-summary](../coordination/reports/phase-b-live-summary-2026-10-06.json)) |
| Extract | `3191692e-ff4b-479d-9b7b-686e530ba45b` | 202 → SUCCEEDED; 1 task / 3 checkpoints; exactly 1 mock provider call; `/result` + download 200 matching fixture invoice `INV-ARCH-PHASE-B-MOCK-001` / total `4250` ([run-summary](../coordination/reports/raw/phase-b-extract-resume-prep-2026-10-06/run-summary.json); [E2E follow-up](../coordination/reports/live-stack-deploy-e2e-2026-10-06.md#follow-up-live-extract-window---arch-phase-b-20261006)) |

Scope and limits: this is a **scoped live-local PASS**, not production cutover, VFY-PLAT-MIG-06 acceptance, or a real-provider proof. The Extract case used a disposable `json-http` Connector revision and a **mock provider**; the stack did not include MinIO, Vault or an external model provider. A historical run on `pm-m02-verify-20261006-887` failed with HANDLER_ERROR before the first checkpoint and is superseded for these two action flows; it remains on record for the PM-M02 host-port verifier and other open checks (real-provider/negative/compatibility cases, separate-client firewall probe, full PM-M02 acceptance).

## 3. Environment variables

`.env.docker` is explicitly passed with `--env-file`; existing `.env` and local development settings are not rewritten. The build context excludes secrets, dependencies and generated artifacts.

| Variable | Required format / behavior |
|---|---|
| `POSTGRES_PASSWORD` | provisioned password; URL-encode reserved characters in `DATABASE_URL` when overriding |
| `RUNTIME_TOKEN`, `ADMIN_TOKEN` | distinct platform/runtime and admin bearer tokens |
| `ENCRYPTION_KEY` | stable profile cipher secret, retain across deployments |
| `ADMIN_SHELL_COOKIE_SECRET` | stable random cookie signing secret |
| `INVOCATION_GRANT_SECRET` | raw 32 ASCII bytes consumed as UTF-8 by Orchestrator |
| `CONNECTOR_INVOCATION_GRANT_SECRET` | base64 encoding of the **same bytes**, consumed by Connector |
| `SERVICE_IDENTITY_SECRET` | base64-encoded 32-byte key shared by the Connector verifier and Orchestrator management-token issuer |
| `CONNECTOR_ENCRYPTION_KEY` | separate base64-encoded 32-byte Connector encryption key |
| `CONNECTOR_SERVICE_TOKEN` | signed HS256 identity, `aud=connector`, scope `connector:invoke`, valid future `exp`; never the raw signing key |
| `WORKER_IDENTITY_TOKENS_BY_BUSINESS` | JSON business-to-token map for scoped worker identities |
| `DOCUMENT_CORE_RUNTIME_TOKEN`, `LC_RUNTIME_TOKEN`, `EXAMPLE_REVIEW_RUNTIME_TOKEN` | must match that map; fallback to platform runtime token for compatibility |
| `ORCHESTRATOR_PORT`, `ADMIN_SHELL_PORT` | Compose host ports for Public JSON / Portal; container listeners stay 3000/3001. Native Orchestrator uses `ORCHESTRATOR_PORT` (fallback `PORT`) for its public listener |
| `ORCHESTRATOR_HOST` | PM-M02 public listener host; Compose explicitly binds `0.0.0.0` inside the container |
| `ORCHESTRATOR_INTERNAL_HOST`, `ORCHESTRATOR_INTERNAL_PORT` | PM-M02 internal listener; Compose sets `0.0.0.0` / `3002` without host publication; native defaults `127.0.0.1` / `3002` |
| `ORCHESTRATOR_INTERNAL_DEBUG_PORT`, `CONNECTOR_DEBUG_PORT` | PM-M02 opt-in overlay host ports only, default 3002/8080, bound to literal `127.0.0.1`. The default base stack does not publish 3002/8080; `CONNECTOR_PORT`/`PORT` only set the Connector container listener |
| `BIND_ADDRESS` | defaults to 127.0.0.1; applies to Public JSON / Portal host mappings only in PM-M02, never internal/Connector debug mappings |
| `DU_IMAGE_PREFIX`, `DU_IMAGE_TAG` | image naming; defaults `du` and `local`; use immutable release tags in deployments |
| `POSTGRES_IMAGE`, `VALKEY_IMAGE` | infra image overrides; use reviewed digests for release pinning |
| `DU_ADMIN_AUTH_MODE` | set `local`, `oidc` or `both` in production and provision users/IdP; blank retains legacy token login |
| `DU_ADMIN_WEB` | defaults 0; set 1 to enable packaged React UI at `/admin/web` on the Orchestrator Portal port (3001) |
| `DU_ADMIN_TRUST_PROXY_PROTOCOL` | defaults false; true only behind a trusted TLS proxy supplying `X-Forwarded-Proto: https` |
| `RUNTIME_URL`, `CONNECTOR_URL`, `REDIS_URL` | PM-M02 worker defaults: `http://orchestrator:3002/api/runtime/v1`, `http://connector:8080`, existing Valkey URL; migrate explicit old Runtime overrides |
| `USAGE_SINK_URL`, `USAGE_SINK_TOKEN` | When Connector usage sink is enabled, use internal Runtime `/api/runtime/v1/usage-events` on 3002 with its dedicated identity; unset remains disabled |
| `ARTIFACT_STORAGE_BACKEND` | postgres by default; S3 requires bucket and applicable AWS credentials/region/endpoint |
| `DOCUMENT_CORE_CONCURRENCY`, `LC_CONCURRENCY`, `EXAMPLE_REVIEW_CONCURRENCY` | default 2, 4, 2 |

Production admin cookies require HTTPS. Route the Orchestrator Portal through your TLS reverse proxy before using login. S3, Vault Transit, tenant/worker identity, OIDC and credential-workflow env settings are explicitly forwarded; file-based secrets and external infrastructure can be mounted/configured through an operator overlay. Connector management boot requires the configuration described below; Docker startup alone does not enable it.

#### 3.1 Admin Web React — rollout theo route (AWEB-08)

`DU_ADMIN_WEB_ROUTES` là **allow-list theo route** cho app React; route không nằm
allow-list trả **một 404 document nhất quán** (“Route not enabled on this
deployment”, có link về `/admin`), fail-closed — route chỉ hiện khi được liệt kê
tường minh. Gate chạy **server-side** trong `shell-server.ts`; assets và shell
root `/admin/web` không bị gate.

| `DU_ADMIN_WEB_ROUTES` | Hành vi |
|---|---|
| vắng / blank | giữ nguyên hành vi cũ: toàn bộ SPA được phục vụ |
| danh sách một phần (vd `overview,security`) | route trong list render; route khác → 404 nhất quán + link `/admin` |
| tên lạ (vd `overview,bogus`) | tên lạ bị bỏ (log warn), phần còn lại vẫn áp dụng |
| `,` (có mặt, rỗng sau parse) | chỉ shell root `/admin/web` còn reachable |

- **Staging khuyến nghị**: bật từng bước — `DU_ADMIN_WEB=1` +
  `DU_ADMIN_WEB_ROUTES=overview` trước (route đã `UI_APPROVED`), thêm dần sau
  review từng màn.
- **Legacy không đổi**: mọi route `/admin/*` của renderer cũ tiếp tục phục vụ
  như trước trong suốt quá trình rollout.
- **Rollback**: xoá `DU_ADMIN_WEB` (+ `DU_ADMIN_WEB_ROUTES`) khỏi env và restart
  **service rework** — không đụng container/dịch vụ khác.
- Rollout matrix + evidence: [`coordination/reports/aweb08prep-per-route-flag-2026-10-04.md`](../coordination/reports/aweb08prep-per-route-flag-2026-10-04.md);
  quy ước UI/BFF: [admin-ui-development-contract.md](admin-ui-development-contract.md).

#### 3.2 Connector management + Vault credential workflow (2026-10-05)

Credential workflow production writer (KV v2) + connector management seam. **Toàn bộ hoặc không**: vắng cả 3 env ⇒ workflow tắt (`credentialWorkflow:false`, các route trả **503 fail-closed**); env **một phần hoặc sai định dạng ⇒ từ chối boot** (`CredentialWorkflowBootError`) — deployment nửa cấu hình không được boot vào 503 im lặng.

| Variable | Default | Mô tả |
|---|---|---|
| `DU_VAULT_KV_OPTIONS` | _(unset — workflow tắt)_ | JSON object, bắt buộc `vaultAddress` (http(s) tuyệt đối); tùy chọn `kvMount` (mặc định `secret`), `requestTimeoutMs` (số nguyên dương). Sai JSON/field ⇒ refuse boot. |
| `DU_VAULT_KV_TOKEN` | _(unset)_ | Vault token machine-identity cho KV v2 writer (CAS). Machine identity, **không** root token ngoài provisioning — xem LIV-05/liv05b. |
| `DU_CONNECTOR_INITIAL_BINDINGS` | _(unset)_ | JSON `{ "<connectorId>": { "tenantId", "accountId" } }` — binding khởi tạo cho connector legacy→bound; validate **fail-closed lúc construct** (thiếu/hỏng ⇒ refuse boot). |

**Connector-management boot configuration:** `services/orchestrator/src/main.ts` parses `DU_CONNECTOR_BASE_URLS` (JSON `connectorId → base URL`) and the shared base64 `SERVICE_IDENTITY_SECRET` used by Connector. When management URLs are configured, a missing/invalid 32-byte key refuses boot; Orchestrator signs a fresh `aud=connector`, `connector:manage` HS256 JWT for each request, with a 60-second token lifetime. The key stays in server-side environment only and is never sent to Portal/browser. The legacy `DU_CONNECTOR_MANAGEMENT_HEADERS` and `DU_CONNECTOR_IDENTITY_EXPIRES_AT` settings are rejected; expiry is carried and checked in each JWT. Docker configuration passes the same `SERVICE_IDENTITY_SECRET` to Orchestrator and Connector, and the optional URL map is documented in [.env.docker.example](../.env.docker.example).

- Nếu cả base URL và service identity key đều unset, app vẫn boot nhưng management store vắng: capability báo `management:false`, danh sách management trả 503. Khi URL được cấu hình, thiếu/sai key làm boot fail; không còn chế độ management call không identity. Credential workflow được yêu cầu mà thiếu base URL hoặc issuer key cũng từ chối boot.
- **Compose forwarding (cập nhật 2026-10-06):** `.env.docker.example` có `DU_CONNECTOR_BASE_URLS`, `SERVICE_IDENTITY_SECRET`, `CONNECTOR_SERVICE_TOKEN`; `compose/orchestrator.yml` forward `DU_CONNECTOR_BASE_URLS` + `SERVICE_IDENTITY_SECRET`, còn `compose/connector.yml` forward `SERVICE_IDENTITY_SECRET`. Đường cấu hình management qua Compose đã có; tuy nhiên end-to-end live management list/capabilities và credential workflow trên stack này vẫn cần verification theo PLAT-MIG-01/03/VFY trước khi tuyên bố tích hợp hoàn tất.

Chi tiết hành vi + bằng chứng: [connector-wire-a](../coordination/reports/connector-wire-a-2026-10-05.md), [credworkflow-impl](../coordination/reports/credworkflow-impl-2026-10-05.md).

Xem đầy đủ trong [.env.example](../.env.example).

---

## 4. Health checks & lifecycle

| Service | Health check | Interval | Start period |
|---|---|---|---|
| `postgres` | `pg_isready -U du` | 5s | — |
| `valkey` | `valkey-cli ping` | 5s | — |
| `orchestrator` | `fetch http://127.0.0.1:3000/health` | 10s | 20s |
| `connector` | `fetch http://127.0.0.1:8080/health/ready` | 10s | 25s |
| `document-core` | (worker, no HTTP — liveness via heartbeat) | — | — |

**Boot order:** healthy Postgres ? `migrate` exits 0 ? Orchestrator; Connector starts after healthy Postgres/Valkey and applies its own migration chain. Workers wait for healthy dependencies. API healthchecks verify HTTP status; worker startup is checked through logs and queue connectivity. The current runtime worker-heartbeat endpoint is a compatibility acknowledgment (`DEGRADED`), not persisted health telemetry.

**Shutdown:** application containers use `init: true` and receive SIGTERM. Orchestrator/Connector have 40 seconds to finish their 30-second drain budget; workers have 30 seconds for their 15-second SDK grace period.

**Migrations:** Compose runs the packaged CLI explicitly (`node dist/migrate-cli.js migrate`) before API startup. `AUTO_MIGRATE=false` remains fixed. For schema upgrades on an existing stack, stop the API and workers first, back up Postgres, run `docker compose --env-file .env.docker run --rm migrate`, then recreate the application services. Do not allow an older API to serve traffic while changing its schema.

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
| Rollback cờ Admin Web | Xoá `DU_ADMIN_WEB`/`DU_ADMIN_WEB_ROUTES` khỏi env + restart **service rework** (legacy `/admin/*` không bị ảnh hưởng) |
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
| [02-architecture.md](02-architecture.md) | Kiến trúc mục tiêu 3 tầng + tên chuẩn + luồng Docker 2026-10-06 |
| [09-system-architecture.md](09-system-architecture.md) | Đường dữ liệu đã materialize (gồm live Docker Ingest/Extract) |
| [12-operations.md](12-operations.md) | Vận hành chi tiết |
| [17-operational-runbooks.md](17-operational-runbooks.md) | Runbooks & alerts |
| [architecture/06-aws-deployment.md](../architecture/06-aws-deployment.md) | AWS EC2 topology |
| [architecture/08-operations.md](../architecture/08-operations.md) | Operations (arch view) |
| [infra/README.md](../infra/README.md) | Test infra (5433/6380) |
| [infra/deployment-architecture.md](../infra/deployment-architecture.md) | Target deployment proposal |
| `docker-compose.yml` + `services/*/docker-compose.yml` | Compose files (phương án C) |
| `.env.example` | Env template |

## 10. Build/deployment regression checks

```bash
node --test tests/deployment/docker.test.cjs
# Against an ALREADY running isolated test project with synthetic env:
# DU_SMOKE_ENV_FILE=/path/smoke.env DU_SMOKE_PROJECT=du-fix-smoke node --test tests/deployment/smoke.cjs
```

Checks cover dependency order, exclusion of SDK development-only Connector dependencies, generated Dockerfile parity, grant key/token formats, all six Compose entrypoints, host/container ports, migration dependency, network reachability and refusal to start with missing secrets. See [Docker repair receipt](../coordination/reports/docker-fix-all-2026-10-05.md) for measured image builds and isolated startup evidence.

Implementation references: [Docker include](https://docs.docker.com/reference/compose-file/include/), [Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/), [pnpm 10 deployment](https://pnpm.io/10.x/cli/deploy), [pnpm Docker guidance](https://pnpm.io/10.x/docker).
