# VERIFY ĐỘC LẬP (DSH) — Packet 1: fix 5 RED artifact-read · Packet 2: receipt LDBA-00 — 2026-10-09

**Vai trò:** verifier độc lập (DeepSeek-1 / term_8bfe6adc), không phải implementer.
**Tuân thủ COORDINATOR-CONTRACT:** KHÔNG sửa code/test/docs/plan; KHÔNG `git commit` / `git add` / push; **KHÔNG tick gate** (không viết VERIFIED/ACCEPTED/IMPLEMENTED); **OFFLINE** — không PostgreSQL/Redis, không claim DB window; không đọc `.env.live`.
**cwd:** `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` · **HEAD** `72e225ae5465e5a648c34bf31fbabbd182763233` · **node** `…deepseek-cli\node_modules\node\bin\node.exe` = **v22.23.3**.
**Raw:** `du-rework/coordination/reports/raw/verify-artifact-read-auth-and-ldba00-2026-10-09/DSH/` (`packet1-artifact-read-authorization.log`, `SHA256SUMS.txt`).

---

# PACKET 1 — Sửa 5 test RED `artifact-read-authorization` (implementer Qwen-2)

## 1.1 Lệnh verify + kết quả (đo độc lập)

```
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/artifact-read-authorization.test.ts
```
**REAL_EXIT=0** (đo bằng `$LASTEXITCODE` **ngay sau** lệnh, không pipe) — **ĐẠT yêu cầu (kỳ vọng 0)**

Literal (đã bỏ ANSI/CRLF):
```
Test Suites: 1 passed, 1 total
Tests:       90 passed, 90 total
Time:        2.796 s, estimated 3 s
```
**Đúng yêu cầu packet: `90 passed, 90 total`, REAL_EXIT=0** ✅ · **không có block `● ` / dòng `FAIL` nào** · dòng `Tests:` không có thành phần `failed`/`skipped`.

## 1.2 Nội dung đã sửa (đọc diff trực tiếp, không tin receipt)

File: `tests/artifact-read-authorization.test.ts` — trạng thái ` M`, digest mới `9cdd4b50fadfc8726b872f389fd7fa57e52adfa9f7d4f5d923dcd1650c8c17ca` (trước fix: `3deb94fa…`). `git diff --numstat` = **`+12 / −6`** (gồm 2 hunk có sẵn của lane khác — xem §1.4).

| Case | Vị trí | Trước | Sau |
|---|---|---|---|
| 1 | `:375-377` | `code: 'STATE_CONFLICT'` | `status: 409, code: 'PERMISSION_DENIED'` |
| 2 | `:386` | `{ status: 403, code: 'PERMISSION_DENIED' }` | `{ status: 409, code: 'LEASE_LOST' }` |
| 3 | `:588` (tên test) | `reports a state conflict, not a permission denial, …` | `reports a permission denial, not a state conflict, …` |
| 3 | `:597` | `code: 'STATE_CONFLICT'` | `status: 409, code: 'PERMISSION_DENIED'` |
| 4 | `:732` | `{ status: 403, code: 'PERMISSION_DENIED' }` | `{ status: 409, code: 'LEASE_LOST' }` |
| 5 | `:742` | `{ status: 403, code: 'PERMISSION_DENIED' }` | `{ status: 409, code: 'LEASE_LOST' }` |

⇒ Đây là **fix phía TEST** (align test về hành vi code hiện tại: `artifacts.ts:707` lease hết hạn → `conflict('LEASE_LOST')` = 409; `artifacts.ts:753-755` foreign-task-unready → `conflict('PERMISSION_DENIED')` = 409), **không sửa product code** — khớp với hướng dẫn dispatch ("6 dòng assertion") và với `docs/28` bản mới (`:1399` nay ghi 409 `PERMISSION_DENIED` / 409 `LEASE_LOST`).

## 1.3 Đối chiếu receipt của implementer (`receipt-artifact-read-auth-fix-2026-10-09.md`)

| Claim trong receipt Qwen-2 | Kiểm chứng độc lập | Khớp? |
|---|---|---|
| `Test Suites: 1 passed` · `Tests: 90 passed, 90 total` · `REAL_EXIT: 0` | đo lại: đúng y hệt | ✅ |
| `git diff --numstat` = `+12 / −6` | đo lại: `12  6` | ✅ |
| Còn **đúng 2** assertion `code: 'STATE_CONFLICT'` (`:609`, `:693`), đang xanh, không đụng | grep toàn file: **đúng 2 hit** tại `:609`, `:693` | ✅ |
| 2 hunk `:198` (comment) và `:206` (`lease_active`) **không phải của họ** (lane khác) | diff xác nhận 2 hunk đó có trước, tôi cũng từng thấy ở các lượt trước | ✅ |
| Đổi tiêu đề 1 test (`:589`) dù packet chỉ nói sửa assertion | diff xác nhận; tiêu đề mới **đúng** với assertion mới (tiêu đề cũ sẽ nói ngược) | ✅ (thay đổi hợp lý, có khai báo) |

⇒ **Packet 1: ĐẠT.** Không phát hiện test bị bỏ qua, không có assertion nào bị nới thêm ngoài việc khớp code.

## 1.4 GAP của Packet 1

1. **`docs/28-test-inventory.md:1401` đã cũ:** dòng này vẫn ghi *"suite hiện **5 failed, 85 passed, 90 total** (exit 1, node v24.21.0, 2 tiến trình độc lập, không flake)"* — sau fix Qwen-2 suite là **90 passed, 90 total, exit 0**. Cần owner docs cập nhật (tôi **không** sửa docs).
2. **Câu hỏi thiết kế còn mở (không phải mismatch nữa):** đường đọc hiện dùng `conflict()` → cặp **409 + `PERMISSION_DENIED`**, trong khi `forbidden()` (`src/http/errors.ts:53`) cho **403 + `PERMISSION_DENIED`** và hiện không được dùng. Test+docs nay đã thống nhất theo code, nhưng việc chọn 403 hay 409 cho ngữ nghĩa "permission denied" vẫn là **quyết định của owner** — tôi ghi nhận, không quyết.
3. Fix **chưa commit** (` M`, digest `9cdd4b50…`) ⇒ kết quả gắn với working tree.

---

# PACKET 2 — Static analysis receipt `ldba-00-schema-mapping.md` (author Codex-1)

## 2.1 Kiểm tra hình thức

| Hạng mục | Yêu cầu packet | Thực tế đo được | Kết luận |
|---|---|---|---|
| Tồn tại | có | `du-rework/coordination/reports/ldba-00-schema-mapping.md`, `??` (untracked), mtime `2026-10-09 02:35:46`, sha256 `36e3e0df8b85f31da475cf869fe873f05b91bb7bb945d960dfacf452751f803e` | ✅ |
| Số dòng | **195** | **194** (`Get-Content … .Count`) | ⚠️ **lệch 1 dòng** — khác biệt quy ước đếm (dòng trống cuối/trailing newline), không phải thiếu nội dung: file kết thúc bằng dòng `Boundaries` + dòng trống cuối |
| 9 bảng cũ ↔ migrations | có | **9 mục** `### 1..9` (`Operation`, `ApiKey`, `ExternalApiConnection`, `ExternalApiOverride`, `ProfileEndpoint`, `AppSetting`, `FileCache`, `User`, `UserProfileAssignment`) — mỗi bảng là bảng map từng cột legacy `schema.ts:line` → migration `file:line` + nhãn `MATCH/TYPE/TRANSFORM/MISSING/PARTIAL` | ✅ |
| 6 mismatch có file:line | có | **`## Six mismatch checks` (:160)** với **đúng 6 mục đánh số**, mỗi mục trích file:line cụ thể | ✅ |
| Không sửa product code/test | có | xem §2.3 | ✅ (có giới hạn attributability) |

Cấu trúc đầy đủ: `## Resume point and method` (:8) · `## Nine-table map` (:18) · `## Six mismatch checks` (:160) · `## Rework tables with no complete legacy row source` (:169) · `## A1 before A2` (:175) · `## Plan and documentation discrepancies to carry forward` (:181) · `## Boundaries` (:191-193).

## 2.2 Spot-check độc lập các trích dẫn (tôi tự đọc, không tin receipt)

| Trích dẫn trong LDBA-00 | Tôi đọc được | ✓/✗ |
|---|---|---|
| `schema.ts:10-11` `pgTable('Operation')` + `id text … crypto.randomUUID()` | đúng nguyên văn | ✅ |
| `schema.ts:33` cost `doublePrecision` | `totalCostUsd: doublePrecision('totalCostUsd')…` | ✅ |
| `schema.ts:177` password text · `:191` id text | `password: text('password')…` · `id: text('id').primaryKey()…randomUUID()` | ✅ |
| `lib/auth.ts:4` bcryptjs · `:34-37` `bcrypt.compare` | `import bcrypt from "bcryptjs";` · `await bcrypt.compare(` | ✅ |
| `0001:16,38` `tenant_id uuid NOT NULL REFERENCES tenants(id)` | đúng cả 2 dòng | ✅ |
| `0001:37` `id uuid PRIMARY KEY` · `:43` `state text` | đúng | ✅ |
| `0024:39` `pipeline_json jsonb` · `0024:61` `total_cost_usd numeric(20,6)` | đúng | ✅ |
| `0010:25-27` audit `tenant_id` **nullable** | `tenant_id uuid, -- NULL for platform-global events` | ✅ |
| `0020:5-7` `admin_crypto_config.tenant_id` **text** | `tenant_id text PRIMARY KEY CHECK (…)` | ✅ |
| `0022:3-5` `budget_reservations.tenant_id` **text** | `tenant_id text NOT NULL` | ✅ |
| `0026:161-165` `user_profile_assignments` PK `(user_id, api_key_id)`, **không có tenant** | `user_id uuid NOT NULL REFERENCES admin_local_users(id)`, `api_key_id uuid NOT NULL REFERENCES api_keys(id)`, `PRIMARY KEY (user_id, api_key_id)` | ✅ |
| `0037:4-20` catalog `(tenant_id, slug, revision)` + digest CHECK + JSONB `schema_ref` + one-active index | `legacy_workflow_schemas` đúng như mô tả (`PRIMARY KEY (tenant_id, slug, revision)`, `digest … ^sha256:`, `schema_ref jsonb`, `status IN ('active','retired')`, unique index WHERE status='active') | ✅ |
| Connector migrations `001..009` tồn tại | `001_connector.sql` … `009_connector_invocation_session_ref.sql` | ✅ |
| Plan / dispatch / `docs/14` tồn tại | `PLAN-LEGACY-DB-ADAPTER-2026-10-09.md`, `dispatch-specs/2026-10-09-0225-LDBA-00.md`, `docs/14-reference-compatibility.md` đều có | ✅ |

**Không tìm thấy trích dẫn sai nào** trong các điểm tôi kiểm (12 nhóm, ~20 dòng cụ thể).

## 2.3 Claim "không sửa product code / test" — kiểm chứng và giới hạn

Bằng chứng **ủng hộ**:
- **Migrations: 0 thay đổi** theo git (`orchestrator/services/orchestrator/migrations` + `services/connector/src/db/migrations`) ⇒ không migration nào bị sửa.
- File plan `PLAN-LEGACY-DB-ADAPTER-2026-10-09.md` là **`??` untracked, mtime 02:12:26** — **trước** receipt (02:35:46) ⇒ tồn tại sẵn, không bị sửa sau khi phân tích.
- `docs/14-reference-compatibility.md`: **sạch vs HEAD** (không có dòng status).
- `docs/04-data-state.md`: có ` M` nhưng mtime **2026-10-08 19:16** — **trước** cửa sổ làm việc ⇒ không phải do lượt LDBA.
- Receipt tự khai `## Boundaries` (:193): *"No DB, build, or test was run. No source/test/migration/docs/plan file was changed. No commit, git add, or push was performed."*

**Giới hạn attributability (ghi trung thực):** trong cửa sổ 02:00–03:10 cùng ngày, có **15 file `src/`** bị sửa bởi **các lane khác** (ví dụ `tests/artifact-read-authorization.test.ts` lúc 02:33:49 — fix của Qwen-2; `apps/admin-web/src/**` lúc 02:40+), nên **mtime/git không thể chứng minh ai sửa gì**. Vì vậy tôi xác nhận: *không có bằng chứng nào cho thấy LDBA-00 sửa product/test*, nhưng **không** khẳng định tuyệt đối thay cho git-author attribution (cây đang dirty đa lane).

## 2.4 Đánh giá Packet 2

Receipt **đầy đủ và có chất lượng kiểm chứng được**: 9 bảng map chi tiết tới từng cột, 6 mismatch đều có file:line và tôi **xác minh đúng** khi đọc lại migration/schema; ngoài ra có thêm 3 mục giá trị (bảng rework không có nguồn legacy đầy đủ, khuyến nghị A1-trước-A2, danh sách lệch plan/docs phải chuyển tiếp). Sai lệch duy nhất: **194 dòng thay vì 195** (quy ước đếm). ⇒ **Packet 2: ĐẠT** (static-analysis receipt, không tự tick gate, có mục Boundaries).

---

# TỔNG KẾT

| Packet | Kết quả | Bằng chứng chính |
|---|---|---|
| 1 — fix 5 RED artifact-read (Qwen-2) | **ĐẠT** | REAL_EXIT=0 · `Test Suites: 1 passed, 1 total` · **`Tests: 90 passed, 90 total`** · 0 FAIL · diff 6 dòng assertion + 1 tên test, đúng hành vi code |
| 2 — LDBA-00 schema mapping (Codex-1) | **ĐẠT** | 194 dòng (claim 195); 9 bảng map; **6 mismatch đều có file:line — 0 trích dẫn sai khi spot-check**; migrations 0 thay đổi; plan/docs trước cửa sổ |

**GAP cần owner xử lý:** (a) `docs/28:1401` còn ghi "5 failed, 85 passed" — nay đã 90/90; (b) số dòng receipt LDBA-00 lệch 1 so với packet (194 vs 195); (c) câu hỏi thiết kế 403-vs-409 cho `PERMISSION_DENIED` vẫn mở (code dùng `conflict()` = 409, `forbidden()` = 403 không dùng); (d) cả fix Packet 1 và receipt Packet 2 đều **chưa commit** ⇒ kết quả gắn working tree.

**XÁC NHẬN:** chỉ chạy 1 lệnh test + đọc file; **không sửa** code/test/docs/plan; **không commit / `git add` / push**; **không tick gate**; không chạm `docs/21-openapi.json`; **không đọc `.env.live`**; offline, không claim DB window. Artifact duy nhất của lượt này: receipt này + 1 raw log.
