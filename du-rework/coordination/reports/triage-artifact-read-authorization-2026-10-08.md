# Triage — 6 RED tests in `tests/artifact-read-authorization.test.ts` (2026-10-08)

**Task:** điều tra và triage 6 test RED trong `orchestrator/services/orchestrator/tests/artifact-read-authorization.test.ts`.
**Lane/lease:** CHỈ file test đó. **Không sửa product source** (`src/modules/artifacts/artifacts.ts` và mọi `src/**` khác giữ nguyên), không sửa file test khác.
**Quy tắc:** offline only (không DB window), **không commit/add/push**, **không tick ACCEPTED/VERIFIED**, không hand-edit `docs/21-openapi.json`, không xoá test, không hạ assertion.
**Revision:** HEAD `df3f955e877fe87bd190461736c40861e2fe78d5` (branch `codex/fix-workflow-builder`).
Cả hai file đều **sạch so với HEAD** (`git status --porcelain` rỗng cho cả hai) ⇒ RED này nằm trong revision được promote, **không** phải do lane khác sửa dở:
`tests/artifact-read-authorization.test.ts` (mtime 10-07 04:30), `src/modules/artifacts/artifacts.ts` (mtime 10-07 19:28).
**Raw:** `coordination/reports/raw/triage-artifact-read-authorization-2026-10-08/` (`red-run.log`, `post-double-fix.log`, `tsc-noemit.log`).

## 1. RED literal (trước khi động vào bất cứ thứ gì)

```
cwd D:\Git\dugate\du-rework\orchestrator\services\orchestrator
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/artifact-read-authorization.test.ts
```
**exit code 1** — `Test Suites: 1 failed, 1 total` / **`Tests: 6 failed, 84 passed, 90 total`** / 2.924 s.

| # | Test | Dòng | Expected → Received |
|---|---|---|---|
| 1 | R1-A … does not grant reads for STAGING artifacts, even in the same operation | :370 | `STATE_CONFLICT` → `PERMISSION_DENIED` |
| 2 | R1-A … rejects expired and fenced requesters before minting a read grant | :381 | `403 PERMISSION_DENIED` → `409 LEASE_LOST` |
| 3 | R1-A … keeps writes producer-scoped and hides storage keys from the public upload grant | :410 | throw `HttpError: lease has expired for task 5555…` (từ `assertLease`, `artifacts.ts:345` ← `requestUpload`, `artifacts.ts:352`) |
| 4 | CR28-03 … reports a state conflict, not a permission denial, for a declared cross-operation STAGING artifact | :592 | `STATE_CONFLICT` → `PERMISSION_DENIED` |
| 5 | CR28-03 worker lease boundaries › prefers expiry over task state when both are wrong | :727 | `403 PERMISSION_DENIED` → `409 LEASE_LOST` |
| 6 | CR28-03 worker lease boundaries › FINDING: the lease_active boolean collapses a missing expiry and a past one | :737 | `403 PERMISSION_DENIED` → `409 LEASE_LOST` |

## 2. Kết luận triage (từng test)

| # | Nguyên nhân RED | Product đúng/sai? | Kết luận |
|---|---|---|---|
| 3 | **TEST DOUBLE SAI (không phải product)** | Product **ĐÚNG** | Double `OfflineArtifactAccessDb.execute` (:195-212) chọn shape theo `sql.includes('T.STATE')`; SQL của `assertLease` (`artifacts.ts:328-331`) chọn `lease_active` **nhưng không có `t.state`** ⇒ double trả shape 3 cột `{lease_epoch, operation_id, tenant_id}` ⇒ `row.lease_active === undefined` ⇒ `!undefined` → `LEASE_LOST 'lease has expired'` cho **mọi** đường `requestUpload`/`assertLease`, kể cả khi fixture đặt `leaseActive: true`. Đã sửa double (xem §4) — test xanh, không hạ assertion nào. |
| 1 | **MISMATCH docs ↔ code** (test theo docs cũ) | Product **hợp lý nhưng lệch tài liệu** — cần owner phân xử | Test: STAGING_OUTPUT (taskId=PARENT_TASK, cùng operation) đọc bởi CHILD_TASK → mong `STATE_CONFLICT`. Code: `artifacts.ts:753-755` `if (art.taskId !== req.taskId && art.state !== 'READY') throw PERMISSION_DENIED('foreign task cannot access unready artifact')` chạy **trước** check `:756` (`STATE_CONFLICT 'artifact is not READY'`). Tài liệu đang ghi hành vi cũ: `docs/28-test-inventory.md:1399`. |
| 4 | **MISMATCH docs ↔ code** (test theo docs cũ) | Product **hợp lý nhưng lệch tài liệu** — cần owner phân xử | Test có **khai báo** reference (`submitArtifacts = [DECLARED_INPUT, FOREIGN_STAGING_OUTPUT]`, :585-588); `isPublicArtifactPurpose('output') === true` (`artifacts.ts:1335-1337`) ⇒ `declaredReference = true` ⇒ không bị chặn ở `:750-751`; nhưng `:753-755` chặn tiếp vì artifact do OTHER_TASK tạo và đang STAGING → `PERMISSION_DENIED`. Docs `:1399` ghi 409 `STATE_CONFLICT`. |
| 2, 5, 6 | **MISMATCH docs ↔ code** (test theo docs cũ) | Product **nhất quán với phần lớn tài liệu**; 403 chỉ khớp 1 dòng inventory | Code: `artifacts.ts:704-707` — epoch lệch → `LEASE_LOST`; `!lease_active` → `LEASE_LOST` (đều 409), rồi mới `:708-710` state → `STATE_CONFLICT`. Docs ủng hộ 409: `docs/28-test-inventory.md:1323` (fencing suite: lease chết ⇒ read grant 409 `LEASE_LOST`), `docs/04-data-state.md:57`, `docs/06b-api-spec-overview.md:170,215`, `docs/07-internal-api.md:49,51,81`, `docs/17-operational-runbooks.md:146,765`, `docs/18-release-readiness-report.md:66`. Chỉ `docs/28:1399` ghi "expiry plus a wrong state yields 403". |

**Không có bằng chứng nào cho thấy product bị lỗi ở 5 test còn lại**: cả 5 đều là *đổi thứ tự/code* có chủ đích trong `requestAccess`/`assertLease` (đọc code thấy rõ thứ tự epoch → lease → state, và rule "foreign task không đọc artifact chưa READY"), trong khi assertion giữ nguyên hành vi đã được ghi trong inventory ngày 2026-09-29. Theo `du-rework/AGENTS.md` §2, đây là **MISMATCH** phải ghi lại (docs vs code vs test) chứ không được tự sửa một phía.

**Test 6 ghi nhận thêm (không phải bug mới):** projection `(t.lease_expires_at IS NOT NULL AND t.lease_expires_at > now()) AS lease_active` (`artifacts.ts:330`, `:690`) gộp "chưa từng có expiry" và "đã hết hạn" thành cùng một `false`; service không phân biệt được hai trạng thái đó. Test này tự đánh dấu `FINDING:` — nó mô tả đúng code hiện tại; chỉ khác kỳ vọng code lỗi (403 vs 409).

## 3. MISMATCH cần owner phân xử (không tự sửa)

| Hạng mục | Docs (expected) | Code (actual) | Test | Owner đề xuất |
|---|---|---|---|---|
| STAGING artifact do task khác tạo, cùng operation | `docs/28-test-inventory.md:1399` → 409 `STATE_CONFLICT` | `src/modules/artifacts/artifacts.ts:753-755` → 403 `PERMISSION_DENIED` | `tests/artifact-read-authorization.test.ts:366-374` | artifacts owner + docs owner |
| STAGING artifact cross-operation **đã khai báo** | `docs/28:1399` → 409 `STATE_CONFLICT` | `artifacts.ts:753-755` (sau khi qua `:750`) → 403 `PERMISSION_DENIED` | `:583-594` | artifacts owner + docs owner |
| Lease hết hạn (epoch đúng) | `docs/28:1399` → 403; `docs/28:1323` + 5 tài liệu khác → 409 `LEASE_LOST` | `artifacts.ts:707` → 409 `LEASE_LOST` | `:376-390`, `:719-729`, `:731-743` | artifacts owner + docs owner |
| Thứ tự expiry-vs-state khi cả hai sai | `docs/28:1399` → 403 (thứ tự thì đúng: expiry trước state) | `artifacts.ts:707` trước `:708` → 409 `LEASE_LOST` | `:719-729` | artifacts owner |

Test cần chạy lại sau khi owner chốt: `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/artifact-read-authorization.test.ts` (hiện **6 → còn 5 đỏ**, xem §4).

## 4. Việc đã làm trong lease (chỉ file test)

- **Sửa double** `OfflineArtifactAccessDb.execute` (:195-212): nhánh `FROM TASKS T JOIN OPERATIONS O` khi SQL **không** có `T.STATE` nay trả thêm `lease_active: task.leaseActive` — đúng projection mà `assertLease` (`artifacts.ts:328-331`) thực sự SELECT. Đây là sửa **test double**, không phải hạ assertion: test 3 vẫn khẳng định đủ 3 điều (grant không có `storageKey`, `uploadUrl` là blob proxy, không lộ key).
- **Không** sửa 5 assertion còn lại (1, 2, 4, 5, 6): chúng đang phản ánh hành vi đã ghi trong `docs/28:1399`; sửa chúng thành 403/409 của code hiện tại sẽ là tự phân xử MISMATCH — thuộc owner.
- **Không** xoá/skip/`.todo` bất kỳ test nào; tổng số test giữ nguyên 90.

## 5. Bằng chứng sau khi sửa double

```
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/artifact-read-authorization.test.ts
```
**exit code 1** — `Test Suites: 1 failed, 1 total` / **`Tests: 5 failed, 85 passed, 90 total`** / 3.364 s (`post-double-fix.log`).
So với trước: **84 → 85 passed**, **6 → 5 failed**; test 3 (`keeps writes producer-scoped and hides storage keys from the public upload grant`, :410) **đã xanh**; **không test nào khác đổi trạng thái** (đúng dự đoán: `requestUpload` là call site duy nhất của `assertLease` trong file này — grep chỉ có :410).
5 test còn đỏ **giữ nguyên đúng chữ ký cũ** (không bị đổi code lỗi):

| Test còn đỏ | Dòng | Expected → Received |
|---|---|---|
| does not grant reads for STAGING artifacts, even in the same operation | :370 | `STATE_CONFLICT` → `PERMISSION_DENIED` |
| rejects expired and fenced requesters before minting a read grant | :381 | `403 PERMISSION_DENIED` → `409 LEASE_LOST` |
| reports a state conflict, not a permission denial, for a declared cross-operation STAGING artifact | :592 | `STATE_CONFLICT` → `PERMISSION_DENIED` |
| prefers expiry over task state when both are wrong | :727 | `403 PERMISSION_DENIED` → `409 LEASE_LOST` |
| FINDING: the lease_active boolean collapses a missing expiry and a past one | :737 | `403 PERMISSION_DENIED` → `409 LEASE_LOST` |

**Typecheck:** `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → **exit 0** (`tsc-noemit.log`, không output); thêm test-inclusive temp config (`src/**` + file test) → **exit 0** (`tsc-test-inclusive.log`).
**Không tick gate nào.** Không sửa `src/**`, không sửa file test khác, không commit/push.

### Thay đổi duy nhất trong file test (để truy vết)
- Trước (HEAD blob): `OfflineArtifactAccessDb.execute` nhánh không-`T.STATE` trả `{lease_epoch, operation_id, tenant_id}`.
- Sau: trả thêm `lease_active: task.leaseActive` (kèm comment trỏ `artifacts.ts:328-331`).
- File sau khi sửa: SHA-256 `3deb94faa3e78c039af9ffd1687e212efea5f354a2c92447bcbf12fcd1ca60b5` (blob HEAD trước khi sửa: SHA-256 `f774be69c738b9e7e45a692d72e49abebe1e6c917ebff41139b9741b7555797a`).

## 6. Giới hạn

- Toàn bộ kết luận dựa trên **double offline** (`Map`-based), không chạy PostgreSQL thật: double không chứng minh được `now()`/`lease_expires_at` thật, và chính double là thứ vừa phát hiện sai ở test 3.
- Chưa chạy suite live (`artifact-grant-fencing.test.ts` cần DB window) — không claim.
- Không kết luận thay owner về MISMATCH ở §3; **không tick gate nào**.
- Ghi chú ngoài phạm vi: task F-4 tenant-select (đã được lane khác hoàn tất) bị dừng giữa chừng; file `tests/f4-component-tenant-select.test.ts` do lượt trước tạo vẫn còn trong working tree (untracked, 12 test xanh) — coordinator quyết định giữ hay xoá.

