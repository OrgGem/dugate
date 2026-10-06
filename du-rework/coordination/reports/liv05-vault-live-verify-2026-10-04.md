# LIV-05 — Vault Live tests run (cc_1)

**Packet:** liv05-vault-live · **Lane:** cc_1 · **Date:** 2026-10-04 · **Dispatch:** 2026-10-04T00:13+07:00 (coordinator command-code).
**Status:** test-only lane. Đã chạy `vault-live.test.ts` (lần đầu — file 90 dòng mới) trên live stack 2 lần liên tiếp; **không sửa source/test/plan**; không tick gate (mọi gate giữ **NO-GO**); không commit; không chạm `nocobase-10` / stack của user (nocobase, authentik…). Chỉ ghi receipt này (+ log tạm trong `%TEMP%`).

## 0. Pre-check hạ tầng (read-only)

```
docker ps: du-live-postgres(5433) | du-live-redis(6380) | du-live-minio(9003/9014) | du-live-vault(8200) — tất cả Up (healthy)
GET /v1/sys/health → initialized=true, sealed=false, version=2.1.1
GET /v1/auth/token/lookup-self (root-dev-token) → VALID, policies=root
GET /v1/transit/keys/du-app-encryption-key → tồn tại (latest_version=1)
baseline GET /v1/secret/metadata/{,du,du/connector}?list=true → 404 (chưa có secret nào — nền sạch)
```

## 1. Run #1 — literal

```
cwd: D:\Git\dugate\du-rework
$env:DU_LIVE_INFRA='1'
pnpm --filter @du/orchestrator exec jest tests/vault-live.test.ts --runInBand
```

Output (verbatim; dòng `node.exe : PASS …` + `CategoryInfo…` là noise đóng gói stdout/stderr của pnpm wrapper PowerShell, không phải lỗi):

```
PASS tests/vault-live.test.ts
  HashiCorp Vault Live Integration
    √ Vault status is initialized and unsealed (75 ms)
    √ Transit KMS: Real DEK wrap, version pin, and unwrap round-trip (53 ms)
    √ KV v2 Engine: Secret create with CAS, read version, and cleanup (13 ms)

Test Suites: 1 passed, 1 total
Tests:       3 passed, 3 total
Time:        5.873 s
EXIT=0
```

## 2. Run #2 — repeatability (cùng lệnh, chạy lại để chứng minh không leak/không collide giữa 2 lần)

```
PASS tests/vault-live.test.ts
    √ Vault status is initialized and unsealed (21 ms)
    √ Transit KMS: Real DEK wrap, version pin, and unwrap round-trip (22 ms)
    √ KV v2 Engine: Secret create with CAS, read version, and cleanup (19 ms)
Test Suites: 1 passed, 1 total
Tests:       3 passed, 3 total
EXIT=0
```

Log đầy đủ: `%TEMP%\liv05-vault-live.log`, `%TEMP%\liv05-vault-live-run2.log`.
**FAIL = 0, SKIP = 0** trên cả 2 run.

## 3. Hậu kiểm — secret test đã cleanup khỏi Vault

| kiểm tra | kết quả |
|---|---|
| `LIST secret/metadata/du/connector` | **404 — không còn entry nào** (test tự `DELETE metadata` path `du/connector/live-test-<ts>/provider/acc-1`) |
| `LIST secret/metadata/du`, `LIST secret/metadata` | 404 — không còn folder trung gian |
| Quét `live-test-*` dưới `du/connector` | **NO leftovers** (sau cả 2 run) |
| Transit key `du-app-encryption-key` | còn nguyên, `latest_version=1` (test chỉ wrap/unwrap, không tạo version mới) |

## 4. Coverage vs plan §LIV-05 (`tasks/LIVE-TEST-PLAN-MINIO-VAULT-BROWSER-2026-10-03.md:182-193`)

Plan định nghĩa 5 case; suite hiện tại phủ **1.5/5**:

| # | case theo plan | trạng thái trong `vault-live.test.ts` |
|---|---|---|
| 1 | Orchestrator Write-Only: Admin API → KV v2 CAS + Postgres chỉ lưu metadata ref | **KHÔNG phủ** — suite ghi KV trực tiếp qua HTTP API Vault (không qua Admin API/Orchestrator, không kiểm Postgres) |
| 2 | Connector Read-Only: grant → đọc đúng version đã pin | **KHÔNG phủ** |
| 3 | Tenant Boundary Denial 403 (fail-closed) | **KHÔNG phủ** — và hiện **chưa thể chứng minh policy** vì `.env.live` đang dùng **root token** cho mọi phía (coordinator F6: `coordination/reviews/2026-10-03-2340-coordinator.md:29` — init script mới upload policy, chưa tạo token/AppRole gắn policy) |
| 4 | Transit KMS DEK wrap/unwrap round-trip | ✅ **Đã phủ** (test #2: wrap → version pin → unwrap → bytes bằng nhau) |
| 5 | Key Rotation & Revocation (request mới nhận version mới; revoke → 502/403 rõ ràng) | **KHÔNG phủ** |

Ghi nhận (không tự thêm test — đúng ranh giới test-only): đây đúng là **F7** đã cảnh báo trước (`.../2026-10-03-2340-coordinator.md:30`): suite mới 3 case, thiếu tenant-boundary 403 + rotation/revoke + AppRole như plan. Muốn đóng đủ §LIV-05 cần (a) infra: token/AppRole scoped theo policy thay root token (F6), (b) test bổ sung 3 case — thuộc owner khác.

## 5. Verdict + phần chưa phủ

- **PASS (ở mức suite đã viết):** 3/3 test pass, exit 0, hai lần chạy liên tiếp; cleanup hậu kiểm sạch (không còn `live-test-*`; folder `du/connector` trở về không tồn tại như baseline); không rò rỉ dữ liệu test.
- **PARTIAL (ở mức plan §LIV-05):** thiếu case #1, #2, #3, #5 như bảng §4; case #3 còn bị chặn bởi F6 (root token ⇒ không chứng minh được policy/tenant boundary). Các mục này **ghi nhận để coordinator/owner quyết**, không tự thêm.
- Không có FAIL nào cần phân loại test-bug/code-bug/infra.

## 6. Boundary

Chỉ chạy test + ghi receipt; không sửa file source/test/plan nào; không xóa/đụng secret nào khác; HTTP chỉ đọc tới Vault của stack `du-live-*` (không chạm container/service của user). Không tick gate, không commit.
