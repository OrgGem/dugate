# VERIFY F-1/F-2 — independent leg B (read-only) — 2026-10-08

> [!IMPORTANT]
> RESUME POINT — **VERIFIED-CLEAN**. 2/2 lệnh exit 0 (`tsc` rỗng; jest `Tests: 21 passed, 21 total`); đọc code xác nhận F-1 đã có scope predicate trong cursor subquery, F-2 đã roster-backed select, codec test đã assert scoped subquery. **Không có RED.** Hash 1 == hash 2 ⇒ không có lane nào sửa file giữa 2 run (không BLOCKER).
> Đọc sớm SOM lúc đầu phiên ghi kết quả đọc 3a/3b/3c — nội dung giữ nguyên bên dưới, chỉ điền mục 1–2 + hash checkpoint 2.

- Agent: leg B độc lập (khác leg A/dsh2/oc2). READ-ONLY: không sửa source/test, không commit/push, không tick gate, không hand-edit openapi. Offline suites only — **không claim DB window, không chạy live DB**.
- Raw logs: `coordination/reports/raw/verify-f1f2-independent-legB-2026-10-08/01-cmd-tsc.log`, `02-cmd-jest-3-suites.log`.

## 1. Lệnh — typecheck

```
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
cwd: D:\Git\dugate\du-rework\orchestrator\services\orchestrator
```
Output: (empty) · **Exit Code: 0** (kỳ vọng 0 ✓)

## 2. Lệnh — 3 offline suites

```
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs \
  tests/tenant-list-cursor-codec-offline.test.ts tests/tenant-list-bff-offline.test.ts tests/aweb06-bff-operations.test.ts
cwd: D:\Git\dugate\du-rework\orchestrator\services\orchestrator
```

| | literal |
|---|---|
| Kết quả | `Test Suites: 3 passed, 3 total` |
| Tests line | **`Tests:       21 passed, 21 total`** |
| Exit Code | **0** (kỳ vọng 0 ✓) |
| FAIL | **không có** |

Trong stdout có 2 dòng warn có sẵn `[admin-shell] admin web mount enabled but bundle is missing` — warn tồn tại (bundle admin chưa build), **không phải FAIL**.

## Checkpoint hash (confounder guard)

| File | Trước run 1 | Sau run cuối | Khớp? |
|---|---|---|---|
| `orchestrator/services/orchestrator/src/modules/admin-read/tenant-list.ts` | `f3e6dc9487d84e1c654d93cebbd844a949cce30d4f4201bbcca26756fef7f813` | `f3e6dc9487d84e1c654d93cebbd844a949cce30d4f4201bbcca26756fef7f813` | ✅ |
| `orchestrator/services/orchestrator/src/app/admin/overview-section-renderer.ts` | `3eaff2501ecf05110aa8efe7bd41f2e1598c87ea4d2a8a6c606cdbbaa5fc3afc` | `3eaff2501ecf05110aa8efe7bd41f2e1598c87ea4d2a8a6c606cdbbaa5fc3afc` | ✅ |

⇒ Không có lane khác sửa giữa 2 checkpoint → **không STOP, không BLOCKER**. (Cùng 2 hash lúc trước lần đọc code đầu phiên → toàn bộ kết luận trên 1 trạng thái cây duy nhất.)

- Checkpoint 2 **khớp leg A** (coordinator xác nhận leg A ghi cùng `f3e6dc94…f7f813` và `3eaff250…3afc`) → 2 verifier độc lập đọc đúng 1 trạng thái cây; verdict 3a/3c ở leg B và leg A không lệch trạng thái đầu vào.

## 3a. `tenant-list.ts:123-134` — subquery cursor có scope predicate? → **CÓ (F-1 đã sửa trên cây hiện tại)**

- `:126` `const boundaryScope = scopeBind === null ? '' : ` AND id = ${scopeBind}`;` — `scopeBind` được bind từ tham số `scope` ở `:123`.
- `:130` `cursorClause = ... (lower(name), id) ${boundaryOp} ((SELECT lower(name) FROM tenants WHERE id = ${cursorId}${boundaryScope}), ${cursorId}::uuid)` ⇒ khi scope khác null, subquery là `WHERE id = $cursorId AND id = $scopeBind`.
- Phân tích an toàn: scope = NULL (platform) thì không có predicate nhưng đó là gốc được phép; scope khác null mà cursor trỏ tenant ngoài scope ⇒ `AND id` mâu thuẫn ⇒ subquery NULL ⇒ so sánh NULL ⇒ 0 hàng (fail-closed) — **không còn là cross-tenant ordering oracle**.
- Tương quan thời gian: gói nói file mtime 05:45 ngày 08/10 (sau 2 lần verify của dsh2/oc2) — với hash `f3e6dc94…` trên đây, phát hiện 3a tính trên chính cây đã đổi đó (không dùng lại kết luận của leg A).

## 3b. `tests/tenant-list-cursor-codec-offline.test.ts` — assert `AND id = <scope bind>`? → **CÓ, không phải coverage NOTE**

- `:131` `expect(calls[0]!.sql).toMatch(/SELECT lower\(name\) FROM tenants WHERE id = \$2 AND id = \$1/)` — assert trực tiếp subquery có scoped predicate.
- `:147-150` case **foreign cursor**: assert lại cùng pattern + `expect(foreignScope.calls[0]!.params).toEqual([TENANT_B, TENANT_C, 3])` — đây đúng là probe cho ordering oracle (comment `:139-140`: “Without a scope predicate inside the boundary subquery, this result reveals that ordering bit”).
- Fake DB `:54-61` parse `\(lower\(name\), id\) ... \(\(SELECT ... WHERE id = \$(\d+)(?: AND id = \$(\d+))?\)` và `boundaryScope === null || row.id.toLowerCase() === boundaryScope` → mô phỏng ngữ nghĩa fence.
- Suite này nằm trong nhóm 21/21 pass ở mục 2.

## 3c. `overview-section-renderer.ts:260-305` — roster-backed hay free-text? → **ROSTER-BACKED (F-2 đã sửa trên cây hiện tại)**

- `renderOverviewFilters` (`:260-305`) sinh `<select name="tenantId" aria-label="Tenant">` — **không còn `<input type="text">` free-text** cho tenant.
- Option dựng từ `tenantOptions` (roster): `value` là id (`esc(tenant.id)`), label là tên `tenant.name` (+ state khi không ACTIVE) — `:283-289`.
- Chống re-point: `:275-278` comment `F-2: roster-backed picker … The placeholder stays selected whenever the current tenant is not in the roster, so a failed roster read can never silently re-point the filter at a different tenant on submit` + `:279` `const inRoster = tenantOptions.some(...)` → `<option value=""${inRoster ? '' : ' selected'}>` (placeholder selected khi tenantId ∉ roster).

## Mục RED

**none** — không có test đỏ, không có FAIL nào trong 2 lệnh (đúng nghĩa “nếu thật sự không có gì”).

## Checkpoint ảnh hưởng tới verdict

- Dsh2 (F-1/F-2 = thật) và oc2 (3/3 PASS) bất đồng trên cây CŨ; verdict leg B này tính trên cây SAU 05:45 — 2 file đã được sửa (F-1 có scope predicate, F-2 roster select), test cũng đã có assert scoped subquery. **Cả 2 nhận định của dsh2 đã không còn đúng trên cây hiện tại.**
- Không claim DB window / live leg (đúng giới hạn “offline suites only”).
- Không sửa gì; không tick gate; không commit/push.