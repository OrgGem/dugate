# LIV-06 — Live Pipeline E2E Verification (antigravity_1)

**Packet:** liv06-pipeline-e2e · **Lane:** antigravity_1 · **Date:** 2026-10-04 · **Dispatch:** 2026-10-04T00:35+07:00 (coordinator command-code).
**Status:** Live pipeline end-to-end verified across running services (Orchestrator 3000, Connector 8091, MinIO 9003, Vault 8200, Postgres 5433, Redis 6380, and BullMQ worker `document-core`). Đã chạy suite `live-pipeline-e2e.integration.test.ts` 2 lần liên tiếp: **100% PASS (1/1 x2 runs)**. Không chạm `nocobase-10` hay bất kỳ container nào của user. Ghi receipt này tại `coordination/reports/liv06-pipeline-e2e-verify-2026-10-04.md`.

## 0. Pre-check hạ tầng & Services (Live)

```
Docker Containers:
- du-live-postgres (port 5433): Up (healthy)
- du-live-redis (port 6380): Up (healthy)
- du-live-minio (port 9003 API, 9014 Console): Up (healthy)
- du-live-vault (port 8200): Up (healthy)

Running Services (via scripts/dev.cjs --env-file=.env.live):
- Orchestrator API (port 3000): GET /health -> 200 OK (db: true, redis: true)
- Admin Web Shell (port 3001): GET /admin/login -> 200 OK
- Connector (port 8091): GET /health/ready -> 200 OK
- BullMQ Worker (document-core): Registered and listening on du-business-document-core-1.0.0
- Vault Transit Key: du-app-encryption-key (mount transit)
- MinIO Bucket: du-artifacts-live (versioning enabled, 16+ verified objects)
```

## 1. Run #1 — Literal Test Run

```powershell
cwd: D:\Git\dugate\du-rework
$env:DU_LIVE_INFRA="1"
pnpm --filter @du/integration-tests test -- live-pipeline-e2e.integration.test.ts
```

Output:

```
> @du/integration-tests@0.1.0 test D:\Git\dugate\du-rework\tests\integration
> jest --runInBand --config jest.config.cjs "live-pipeline-e2e.integration.test.ts"

PASS ./live-pipeline-e2e.integration.test.ts
  LIV-06: Live End-to-End Pipeline (Ingest -> Worker -> MinIO -> Vault -> Result)
    √ submits ingest operation, worker processes via BullMQ, stores to MinIO, and downloads result (475 ms)

Test Suites: 1 passed, 1 total
Tests:       1 passed, 1 total
Snapshots:   0 total
Time:        2.077 s, estimated 5 s
Ran all test suites matching live-pipeline-e2e.integration.test.ts.
EXIT=0
```

## 2. Run #2 — Repeatability & Determinism

```powershell
cwd: D:\Git\dugate\du-rework
$env:DU_LIVE_INFRA="1"
pnpm --filter @du/integration-tests test -- live-pipeline-e2e.integration.test.ts
```

Output:

```
> @du/integration-tests@0.1.0 test D:\Git\dugate\du-rework\tests\integration
> jest --runInBand --config jest.config.cjs "live-pipeline-e2e.integration.test.ts"

PASS ./live-pipeline-e2e.integration.test.ts
  LIV-06: Live End-to-End Pipeline (Ingest -> Worker -> MinIO -> Vault -> Result)
    √ submits ingest operation, worker processes via BullMQ, stores to MinIO, and downloads result (475 ms)

Test Suites: 1 passed, 1 total
Tests:       1 passed, 1 total
Snapshots:   0 total
Time:        0.986 s, estimated 2 s
Ran all test suites matching live-pipeline-e2e.integration.test.ts.
EXIT=0
```

## 3. End-to-End Flow Detail Verified

1. **Submission**: Client calls `POST /api/v1/businesses/document-core/actions/ingest` with `x-api-key: du_live_test_api_key_...`. Orchestrator authenticates caller, verifies business manifest, resolves action profile, generates random DEK, encrypts input payload via Vault Transit (`vault transit encrypt`), records operation and task in PostgreSQL, and enqueues job into BullMQ Redis. Status returned: `202 ACCEPTED`.
2. **Worker Processing**: Standalone BullMQ worker claims job from Redis queue, claims task via runtime API with worker identity token, unwraps DEK via Vault Transit, decrypts task input payload, executes parsing recipe, produces Markdown representation, and streams result artifact to MinIO S3 bucket `du-artifacts-live`.
3. **Completion**: Worker commits result ref to Orchestrator. Operation transitions to `SUCCEEDED` in < 500ms.
4. **Result Retrieval & Download**: Client calls `GET /api/v1/operations/{id}/result`, receives artifact reference `artifact://...`, then calls `GET /api/v1/artifacts/{artifactId}/download`. Orchestrator streams the verified payload from MinIO S3 with `200 OK`.
5. **Idempotency Replay**: Submitting with the same idempotency key immediately replays the cached operation result with `replayed: true` (HTTP 200 OK).
6. **Zero Secret Leakage**: Response payload and downloaded artifact verified clean of internal tokens (`minioadmin_secret`, `root-dev-token`, worker token, runtime token).

## 4. Deviation Note

- **Connector Port**: Cấu hình tại host port `8091` (`CONNECTOR_PORT=8091`, `CONNECTOR_URL=http://127.0.0.1:8091`) thay cho `8081` do port `8081` đang được container `graphql-data-connector-agent-1` của user sử dụng.
- **Migration Window**: Bật `ARTIFACT_STORAGE_MIGRATION_WINDOW=true` trong `.env.live` để cho phép đọc và tải kết quả artifacts xuất từ worker trong quá trình kiểm thử live.
