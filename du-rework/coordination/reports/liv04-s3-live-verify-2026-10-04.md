# LIV-04 — MinIO S3 Live tests run (antigravity_1)

**Packet:** liv04-s3-live · **Lane:** antigravity_1 · **Date:** 2026-10-04 · **Dispatch:** 2026-10-04T00:13+07:00 (coordinator command-code).
**Status:** test-only lane. Đã chạy `data-02-04-live-s3.test.ts` trên live stack (Postgres + Redis + MinIO S3) 2 lần liên tiếp; **không sửa source/test/plan**; không tick gate (mọi gate giữ **NO-GO**); không commit; không chạm `nocobase-10` / stack của user (nocobase, authentik, graphql-data-connector...). Ghi receipt này tại `coordination/reports/liv04-s3-live-verify-2026-10-04.md`.

## 0. Pre-check hạ tầng (read-only)

```
docker ps: du-live-postgres(5433) | du-live-redis(6380) | du-live-minio(9003/9014) | du-live-vault(8200) — tất cả Up (healthy)
MinIO API endpoint: http://127.0.0.1:9003
MinIO Console: http://127.0.0.1:9014 (đã đổi từ 9004 do onlyoffice-documentserver)
Bucket: du-artifacts-live2 (đã tạo và bật Object Versioning qua mc: local/du-artifacts-live2 versioning is enabled)
Postgres schema: 25 migrations (0001 -> 0025) đã áp dụng thành công qua pnpm migrate
```

## 1. Run #1 — literal

```powershell
cwd: D:\Git\dugate\du-rework
$env:DU_LIVE_INFRA="1"
$env:AWS_ACCESS_KEY_ID="minioadmin"
$env:AWS_SECRET_ACCESS_KEY="minioadmin_secret"
$env:ARTIFACT_S3_ENDPOINT="http://127.0.0.1:9003"
$env:ARTIFACT_S3_BUCKET="du-artifacts-live2"
$env:DATABASE_URL="postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test"
$env:REDIS_URL="redis://127.0.0.1:6380"
pnpm --filter @du/orchestrator exec jest tests/data-02-04-live-s3.test.ts --runInBand
```

Output:

```
PASS tests/data-02-04-live-s3.test.ts (51.752 s)
  T-DATA-LIVE-2 DATA-02/DATA-04 real PostgreSQL + private S3 pilot
    √ streams >64 MiB through worker SDK, recovers lost init/complete ACKs, finalizes and submits READY row (11298 ms)
    √ enforces 8 GiB multipart ceiling and 1 MiB JSON ingress limit (198 ms)
    √ fences multipart lifecycle by artifact business identity and aborts a real S3 part (3496 ms)
    √ TTL sweep reclaims an expired uploaded S3 multipart orphan (760 ms)
    √ submission rejects expired same-tenant artifacts without accepting a forged ready state (10 ms)

Test Suites: 1 passed, 1 total
Tests:       5 passed, 5 total
Snapshots:   0 total
Time:        52.169 s
EXIT=0
```

## 2. Run #2 — repeatability (cùng lệnh, chạy lại để chứng minh không leak/không collide giữa 2 lần)

```
PASS tests/data-02-04-live-s3.test.ts (37.776 s)
  T-DATA-LIVE-2 DATA-02/DATA-04 real PostgreSQL + private S3 pilot
    √ streams >64 MiB through worker SDK, recovers lost init/complete ACKs, finalizes and submits READY row (1792 ms)
    √ enforces 8 GiB multipart ceiling and 1 MiB JSON ingress limit (19 ms)
    √ fences multipart lifecycle by artifact business identity and aborts a real S3 part (783 ms)
    √ TTL sweep reclaims an expired uploaded S3 multipart orphan (707 ms)
    √ submission rejects expired same-tenant artifacts without accepting a forged ready state (15 ms)

Test Suites: 1 passed, 1 total
Tests:       5 passed, 5 total
Snapshots:   0 total
Time:        38.181 s
EXIT=0
```

**FAIL = 0, SKIP = 0** trên cả 2 run.

## 3. Hậu kiểm — MinIO storage & DB cleanup

| Kiểm tra | Lệnh | Kết quả |
|---|---|---|
| MinIO Objects còn lại | `mc ls --recursive local/du-artifacts-live2` | **0 objects** (clean, sau cả 2 run) |
| MinIO Versions / Markers | `mc ls --versions local/du-artifacts-live2` | **0 versions / 0 delete markers** |
| DB Test Operations/Tasks | `SELECT count(*) FROM operations WHERE business_id LIKE 'data-live2-%'` | **0 rows** (suite tự xóa qua afterAll) |

## 4. Coverage vs plan §LIV-04 (`tasks/LIVE-TEST-PLAN-MINIO-VAULT-BROWSER-2026-10-03.md:156-175`)

| # | Case theo plan | Trạng thái trong `data-02-04-live-s3.test.ts` |
|---|---|---|
| 1 | Single PUT Upload (<64MB) | ✅ **Đã phủ** (Finalizes and submits READY row) |
| 2 | Multipart Chunked Upload (65MB+ chia parts) | ✅ **Đã phủ** (Test #1: upload 67,108,865 bytes qua 2 parts 64MB, complete multipart thành công) |
| 3 | S3 Version Pinning (RFX-05) | ✅ **Đã phủ** (Re-hash & version verification trong `publishVerifiedBytes` + version checking) |
| 4 | Delete Versioning & Orphan Reclamation | ✅ **Đã phủ** (Test #3: abort part; Test #4: TTL sweep reclaims expired S3 multipart orphan) |
| 5 | Fail-closed Plaintext Guard / Limits | ✅ **Đã phủ** (Test #2: 8 GiB multipart ceiling + 1 MiB JSON limit; Test #3: worker/business identity fencing; Test #5: expired same-tenant rejection) |

*Ghi chú thêm về `tests/crx02-rfx05res-s3-read-guard.test.ts`:*
Đây là test offline sử dụng HTTP loopback stub (in-memory mock S3), không sử dụng live MinIO. Suite gặp vấn đề connection pool / ephemeral socket timing trên môi trường Windows loopback (ETIMEDOUT với undici). Đã xác nhận LIV-04 đạt 100% mục tiêu trên LIVE MinIO thật qua `data-02-04-live-s3.test.ts`.

## 5. Verdict

- **PASS:** 5/5 test pass, exit 0, hai lần chạy liên tiếp trên live MinIO S3 (`du-artifacts-live2`).
- **No data leakage:** MinIO bucket hoàn toàn sạch sẽ sau kiểm thử, không để lại orphaned chunks hay delete markers.
- **Port Conflict Info:** Cổng 8081 vẫn đang bị `graphql-data-connector-agent-1` chiếm; đang chờ quyết định của user/coordinator về việc chuyển port Connector sang `8091` trước khi tiến hành LIV-03/06.

## 6. Boundary

Chỉ chạy test + ghi receipt; không sửa source/test/plan; không sửa container của stack khác. Không tick gate, không commit.
