# Receipt — BIZ-05 tightening: workflow binding phải gắn vào business version đang active (2026-10-11)

> **RESUME POINT — IMPLEMENTED + offline [PASS], CHƯA ACCEPTED.** Một branch check mới trong `workflow-schemas.ts`; test fake hiệu chỉnh để phân biệt đăng-ký/không-active; một pin test mới. `tsc` 0; full offline suite 61/61 exit 0. Không commit/push; không sửa file ngoài 2 file trong scope.

- **Task:** BIZ-05 — siết kiểm tra `is_active` khi gắn workflow vào business version (nâng finding từ receipt BIZ-05, 2026-10-10).
- **Lease:** `services/orchestrator/src/modules/workflow-schemas/workflow-schemas.ts` + `services/orchestrator/tests/wfa-runtime-schema-catalog.test.ts`. Không đụng DB/migration/backend khác.
- **Method:** đọc source; thêm check; chứng minh load-bearing bằng mutation probe; chạy test offline + typecheck.

## 1. Vấn đề gốc

Trước sửa, kiểm tra khi provision workflow chỉ đòi hàng `business_versions` **tồn tại** (`workflow-schemas.ts:269-274` bản cũ):

```
SELECT 1 FROM business_versions WHERE business_id=$1 AND version=$2 LIMIT 1
```

Nên có thể gắn workflow vào một version đã bị drain (status DISABLED, is_active=false) — một liên kết metadata trỏ vào nơi không nhận việc nữa, là drift vận hành chứ không phải lỗi cấu hình lộn xộn.

## 2. Cấu trúc ownership (4 lớp, giữ nguyên)

| Lớp | Bảng / khóa | Ai ghi | Ai đọc |
|---|---|---|---|
| 1. Registry business | `business_versions(business_id, version)` + `status`/`is_active` | registry (migration 0006) | **admission**: `resolveEnabledVersion` (`submission.ts:1356-1357`) lọc `is_active=true`; `registry.ts:131` chỉ activate khi status ENABLED |
| 2. Binding profile ↔ workflow | `profile_workflow_bindings(profile_id, workflow_slug, workflow_revision, enabled)` PK `(profile_id, workflow_slug)` | action `profile_workflow.set` (`admin.ts:808`) | **chỉ** `listProfileWorkflows` (`profile-workflows.ts:78,82`) — bề mặt chọn cho UI Admin |
| 3. Credential của profile | `profile_bindings.file_url_auth_cipher` + `credentialRef` trong snapshot operation | profile writer | lúc fetch nguồn (`acquisition-ref-resolver.ts`) |
| 4. Schema workflow | `legacy_workflow_versions` (tenant, slug, revision, digest, status active/retired, business_id/version **nullable**, migration 0040) | provision (`workflow-schemas.ts`) | admission lúc resolve `resolveLegacyWorkflowSchema` (chỉ lấy `status=active`) |

Điểm mấu chốt: lớp 1 (registry) là nguồn truth cho việc version nào **nhận việc**; lớp 2 là metadata cho phép profile dùng workflow nào. Không lớp nào *chứa* trạng thái active của lớp khác — vì vậy không có đường cascade từ registry sang binding.

## 3. Thay đổi — 1 branch check

- **SQL thu hẹp:** `SELECT is_active FROM business_versions WHERE business_id=$1 AND version=$2 LIMIT 1` (giữ nguyên 1 round trip; `is_active` NOT NULL — migration 0006).
- **Refusal tường minh** khi version đã drain, không im lặng: `SCHEMA_INVALID` + *Workflow business version is not the active version; activate it via the admin API before binding a workflow* (`workflow-schemas.ts:269-281` trong trạng thái hiện tại).
- **Không đổi:** `SCHEMA_INVALID` cho version không tồn tại (giữ mã cũ); logic retire/active revision; kiểm tra ownership tenant; chữ ký lỗi.
- **Chú thích:** ghi rõ đây là **cùng một cờ mà admission dùng** (`is_active=true`) ⇒ hai cổng không thể lệch nhau; và ghi rõ do tác giả hôm qua nêu (đưa việc ra khỏi version đã drain).

## 4. Hệ quả cho từng tình huống

| Tình huống | Trước | Sau |
|---|---|---|
| Gắn workflow vào version **đăng ký + active** (bình thường) | cho phép | **cho phép** (không đổi) |
| Gắn workflow vào version **đã drain** (status DISABLED) | cho phần metadata drift | **refuse** — không còn drift; operator phải activate version trước |
| Operation đã admitted trước khi version bị drain, đang chạy | không đổi | **không đổi** — job chạy theo queue/claim cũ; worker đọc manifest từ payload của chính job đó (đường worker không lọc business_versions.is_active) |
| Drain version rồi bật lại binding cũ (`enabled=true`, cùng workflow) | binding vẫn nguyên | **vẫn nguyên** — không có gì cascade; nhưng nếu provision lại (revision mới) sẽ bị refuse vì version chưa active |
| Workflow schema retire (revision cũ → `status=retired`) | admission `:234` chỉ lấy active ⇒ request mới không tìm thấy schema | **không đổi**; binding trỏ revision cũ vẫn nguyên nhưng không còn dùng được (đúng như thiết kế pin) |
| Trỏ sang profile khác | nghiệp vụ sở hữu (không FK tới binding) | không đổi |

## 5. Verification (cwd `services/orchestrator`, Node v24.21.0, offline)

```
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --runTestsByPath \
  tests/wfa-runtime-schema-catalog.test.ts tests/aweb-14-workflow-business-offline.test.ts \
  tests/legacy-http-mount.test.ts tests/admin-mutation-atomicity.test.ts
Test Suites: 4 passed, 4 total
Tests:       61 passed, 61 total
REAL_EXIT: 0
```

### Chứng minh pin bằng mutation probe (source tạm sửa, rồi restore nguyên văn)

1. **Mutation SQL** (lọc `is_active=false`): probe chứa `√` vẫn xanh — **fake green**: fake `dbHarness` quyết định qua **map của nó**, không qua predicate SQL ⇒ pin không bắt được mutation *SQL*.
2. **Mutation phía code** (bỏ cánh `if (!registered.is_active)` đi): pin **đỏ đúng test** — `1 failed, 4 passed` với `Resolved to value:` chứng minh provision **thành công** khi version đã drain. Sau khi restore: 5/5 xanh.
⇒ Pin bảo vệ **việc bỏ code-side check**; việc sửa SQL phải do fake độc lập kiểm tra (không thuộc lease này). Khai báo điểm mở này trong receipt, không tự mờ nó đi.

## 6. Chỉnh test fake (cùng file test, trong scope)

- `dbHarness()` nay chứa `businessVersions: Map<string, boolean>` (mặc định `document-core@1.1.0 → true`) và đọc cả `select is_active from business_versions`. Mặc định active giữ nguyên ý nghĩa test cũ; test mới bật `false` để pin refusal.
- Pin mới: **refuses to bind a workflow to a business version that is not the active one** — quét version refuse với `SCHEMA_INVALID`, không ghi hàng (`db.rows` rỗng), và khi version active thì provision thành công `revision: 1`.

## 7. Phân định thay đổi

| File | Delta của TÔI | Ghi chú |
|---|---|---|
| `modules/workflow-schemas/workflow-schemas.ts` | **1 branch** (`SELECT is_active` + refusal message) | `git diff --numstat` = `+115/-2` nhưng phần lớn là thay đổi có sẵn của lane khác (`:489`/`:525` không thuộc delta của tôi) |
| `tests/wfa-runtime-schema-catalog.test.ts` | fake registry + 1 pin mới | `tests/` là **untracked** ⇒ `git diff` không chứng minh; chỉ ghi delta |

## 8. Còn mở / ranh giới

- **Coverage:** không có test offline cho refusal trước kia; mutation chỉ phủ code-side. SQL-side mutation không bị pin (ghi rõ ở §5.1).
- Chưa chạy live (PG/Redis) — offline-only, theo bound của lane.
- Không sửa registry/BFF/docs; chỉ 2 file trong scope.
- `file:line` trong báo cáo là survey 2026-10-11; cây đang đổi giữa chừng.

## 9. Ranh giới đã giữ

- Không git add / commit / push.
- Không tick gate, không cập nhật task/plan.
- Không chạy DB/Redis/S3; không gọi API thật; offline.
- Không thay đổi backend, contracts, `lib/api`, docs kỹ thuật khác.
- **Zero double quotes** (COORDINATOR-CONTRACT) — đã đo bằng đếm ký tự.
- File tạo: receipt này.