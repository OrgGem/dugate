# FIX — WFA §8 finding LOW: legacy page-token cursor unscoped — 2026-10-08

**SOM (skeleton of method) — sẽ cập nhật dần trong cùng file này.**

## Finding (verbatim từ `coordination/reports/wfa-section8-security-review-2026-10-08.md`)

> **LOW - legacy page-token cursor unscoped:** `src/compat/legacy-host-adapter.ts:405-430` (esp. `:420-429`);
> `src/modules/runtime/runtime.ts:1845-1852`. Outer list query is tenant/API-key scoped but its page-token
> scalar subquery loads `created_at`/`id` by operation id only. `runtime.listOperations` has the same pattern;
> no call site for that helper was found. Outer result rows remain scoped.

## Mục tiêu (từ task)

Subquery cursor **phải có scope predicate** (`tenant_id` hoặc `api_key`) **giống ngoài query**, hoặc
**fail-closed**. Không được fake success.

## Lease (chỉ 3 file)

1. `orchestrator/services/orchestrator/src/compat/legacy-host-adapter.ts`
2. `orchestrator/services/orchestrator/src/modules/runtime/runtime.ts` — **chỉ `:1845-1852`**
3. `orchestrator/services/orchestrator/tests/fix-section8-legacy-cursor-offline.test.ts` (file test **mới** của lane này)

Không sửa file khác, không sửa `tests/` của lane khác.

## Trạng thái: ĐANG LÀM

- [x] Đọc finding + 2 site nguồn.
- [x] Xác nhận reachability: `listLegacyOperations` **có** call site thật — `legacy-http-mount.ts:714`
      (route list legacy) ⇒ leak **reachable**. `runtime.listOperations` **không** có call site nào trong repo
      (grep 1 hit = định nghĩa) ⇒ đúng như finding, nhưng vẫn phải vá (lease yêu cầu).
- [x] Viết test fail-first (RED) — xem §RED.
- [ ] Sửa 2 site.
- [ ] Chạy lại (GREEN) + `tsc --noEmit`.
- [ ] Cập nhật receipt này (bảng lệnh/exit/literal, file:line từng thay đổi).

## Kế hoạch kỹ thuật (decision + lý do)

**Decision: thêm scope predicate vào CHÍNH subquery, mirror đúng scope của outer query. Không dùng
fail-closed bằng `NULL` cưỡng bức, không đổi shape ngoài.**

Lý do:
- Scope của outer ở site 1 là **tenant + api_key fence**: `tenant_id = $1` AND
  `(pipeline_json->0->>'workflow' IS NULL OR api_key_id = $3)`. Mirror **cả hai** vào subquery ⇒ token của
  tenant khác **hoặc** của api_key khác đều không đọc được.
- Hai param `$1` (tenant) và `$3` (apiKeyId) **đã tồn tại** trong câu lệnh ⇒ **không thêm param**, không đổi
  vị trí placeholder (`$2` là LIMIT) ⇒ không phá vỡ bất kỳ test nào đang pin shape SQL.
- Hệ quả khi token ngoài scope: subquery trả `NULL` ⇒ `(created_at, id) < (NULL, NULL)` ⇒ `NULL` ⇒ row bị
  loại ⇒ **trang rỗng (fail-closed)**, không rò và không "thành công giả".
- Site 2: outer scope là `tenant_id=$1` ⇒ subquery thêm `AND tenant_id=$1`; cùng param, không thêm placeholder.
- **Không** thêm `deleted_at IS NULL` / filters vào subquery: đó là điều kiện *visibility/filter*, không phải
  *authorization*; thêm vào sẽ làm hỏng walk hợp lệ khi row biên bị soft-delete giữa 2 trang. Phạm vi vá đúng
  bằng phạm vi finding (scope predicate).

## RED (fail-first)

(cập nhật sau khi chạy)

## Bảng lệnh / exit / literal

(cập nhật sau khi chạy)

## Ràng buộc

NO commit / NO `git add` / NO push. Không hand-edit `docs/21-openapi.json`. Không tick `ACCEPTED`/`VERIFIED`,
không sửa WFA plan file, không chạy live DB, không claim DB window.
