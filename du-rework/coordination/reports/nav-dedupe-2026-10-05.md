# NAV-DEDUPE — single-source canonical nav cho view-models — 2026-10-05

**Packet:** NAV-DEDUPE (coordinator 02:17; follow-up §5.2 của `shell-red-fix-2026-10-05.md`). **Lane:** cc_3 (`term_4954d39e`).
**Snapshot:** 2026-10-05 02:17–02:3x +07 · HEAD `b088eececcb5f3df0b4edbe073a29401dafda624`. **Offline; không tick; không commit/push.**

## 0. TL;DR

- `view-models.ts` **không còn list nav song song**: `import { getCanonicalNavItems } from './p6-01-shell-fixtures'` (:42) + `export const ALL_NAV_ITEMS: readonly NavItem[] = getCanonicalNavItems()` (:57). Một nguồn duy nhất = fixtures (đúng nav router/render đang dùng).
- **Buộc đổi test — chỉ `tests/admin-view-model.test.ts`**: 3 `expectedSections` (5→7 item), 1 label list (5→7), 1 control case, **+1 pin mới** (`ALL_NAV_ITEMS` `toEqual` **và** `toBe` `getCanonicalNavItems()`). **`p6-01-shell-fixtures.ts` 0 delta** (là nguồn, không phải đối tượng sửa).
- Bề mặt hành vi: view-models helpers giờ thấy/resolve thêm `overview` + `api-keys` (hệ quả trực tiếp của single-source, có chủ đích); không có consumer src nào khác của các helper này (grep) — ngoài tests.
- **Evidence:** 3-suite ×3 = **118/118 exit 0**; bộ 6-suite ×3 = **376/376 exit 0** (375 + 1 pin mới); `tsc --noEmit` exit 0; sweep 11 suite shell-adjacent: **10 passed / 1 skipped / 0 failed** (session-lifecycle đã xanh nhờ fix của lane khác — §4).

## 1. Thay đổi nguồn (view-models.ts)

```diff
src/app/admin/view-models.ts:42
+import { getCanonicalNavItems } from './p6-01-shell-fixtures';

src/app/admin/view-models.ts:51-57
-/** Canonical section list for the admin shell. Paths are relative to /admin. */
-export const ALL_NAV_ITEMS: readonly NavItem[] = [
-  { section: 'businesses', ... requiredRole: 'viewer' },
-  { section: 'operations', ... requiredRole: 'viewer' },
-  { section: 'profiles',   ... requiredRole: 'admin'  },
-  { section: 'connectors', ... requiredRole: 'admin'  },
-  { section: 'grants',     ... requiredRole: 'admin'  },
-];
+/**
+ * Canonical section list for the admin shell. Paths are relative to /admin.
+ * NAV-DEDUPE (2026-10-05): single source of truth — the list is owned by
+ * `./p6-01-shell-fixtures` (`getCanonicalNavItems`), the same nav the router
+ * and renderer consume; this export re-references it for view-model consumers.
+ */
+export const ALL_NAV_ITEMS: readonly NavItem[] = getCanonicalNavItems();
```

- Không cycle: `p6-01-shell-fixtures.ts` chỉ import `./types`; `index.ts` barrel export cả hai — tsc xác nhận.
- Giữ tên export `ALL_NAV_ITEMS` ⇒ không phá import hiện hữu (chỉ 1 consumer: chính test này).

## 2. Đổi test bị buộc (ghi rõ) — `tests/admin-view-model.test.ts`

| Vị trí | Trước | Sau |
|---|---|---|
| :52-55 `cases` | viewer/operator `[businesses, operations]`; admin 5 item | **7 item**: viewer/operator `[businesses, operations, overview]`; admin `+ profiles, connectors, grants, api-keys` |
| :62-66 (mới) | — | **pin NAV-DEDUPE**: `expect(ALL_NAV_ITEMS).toEqual(getCanonicalNavItems())` **và** `.toBe(...)` (cùng identity) |
| :767-775 labels | 5 labels | 7 labels (`Overview`, `API keys` thêm) |
| :804-805 control | viewer `[businesses, operations]` | `[businesses, operations, overview]` |

Không đổi (vẫn đúng với 7-item): gateCases :68-81, monotone :78-80, `sectionForPath` cases :85-99 + :809-837 (7-item list bao trùm các case cũ), csrf-absence :862-867, `visibleNavItems('admin')).toHaveLength(ALL_NAV_ITEMS.length)` (dynamic), not-contain grants :806.

**Fixtures: 0 dòng sửa.**

## 3. Evidence literal

```
run0 (5 suite: 3 shell + fixtures + view-model): Test Suites: 5 passed · Tests: 353 passed  → raw/navdedupe-run0.txt

3-suite packet ×3:
  R1_EXIT=0 · R2_EXIT=0 · R3_EXIT=0 — mỗi lượt Test Suites: 3 passed · Tests: 118 passed, 118 total
  → raw/navdedupe-3suite-r1.txt, -r2.txt, -r3.txt

6-suite ×3 (3 shell + fixtures + view-model + render):
  R1_EXIT=0 · R2_EXIT=0 · R3_EXIT=0 — mỗi lượt Test Suites: 6 passed · Tests: 376 passed, 376 total
  → raw/navdedupe-6suite-r1.txt, -r2.txt, -r3.txt

tsc --noEmit -p tsconfig.json → TSC_EXIT=0            → raw/navdedupe-tsc.txt
Sweep 11 suite shell-adjacent → SWEEP_EXIT=0 · 10 passed / 1 skipped / 0 failed / 387 tests (386 passed, 1 skipped)
  → raw/navdedupe-sweep.txt
git diff --check (2 file) → exit 0
```

## 4. Quan sát / attribution

- **`admin-shell-session-lifecycle` giờ xanh** (sweep PASS + solo 51/51 ×2, exit 0 → `raw/navdedupe-sessionlifecycle-r1.txt`, `-r2.txt`): diff working-tree của lane đó (mtime `2026-10-05T02:04:17+07`) cho thấy họ đã tự đóng đúng 2 fail tôi báo ở `shell-red-fix` §5 — pin `process.env.NODE_ENV = 'test'` trong describe cookie-config ("the mount default reads process.env at creation time: pin it clean") + đổi console-sink test sang mock `process.stdout.write` (sink observability ghi stdout, không qua console.warn). **Packet này 0 chạm file đó**; handoff §5.1 của shell-red-fix coi như đã đóng bởi chủ sở hữu.
- Sau dedupe, muốn thêm/bớt section chỉ sửa **một chỗ**: `p6-01-shell-fixtures.ts` NAV_ITEMS.

## 5. Compliance

- Write set đúng **2 file**: `src/app/admin/view-models.ts`, `tests/admin-view-model.test.ts` (post sha20: `b3b91a3936947afb8494` / `3a117d0d2b628b69418b`).
- Không chạm fixtures, các shell suite khác, session-lifecycle, BFF/admin-web. HEAD `b088eece` không đổi; không commit/push/staging; không tick task/gate.
