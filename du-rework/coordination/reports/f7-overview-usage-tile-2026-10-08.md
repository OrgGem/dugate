# F-7 — overview usage tile: stale copy → real usage (fix lane) — 2026-10-08

**Task:** F-7. `overview-screen.tsx:125-128` rendered `<UnavailableTile title="Usage rollup" description="Per-tenant usage
aggregation is not exposed by the platform BFF yet. …" />` — copy that was already false: the BFF route exists
(`src/app/admin/bff/operations.ts:61` route kind `usage`, `:199-220` `GET /admin/api/usage?tenantId&from&to` → upstream
`/api/v1/usage`) and the client exposes `getUsage` (`apps/admin-web/src/lib/api/client.ts:126,349`).
**Lane:** fix + test. **Không commit, không push, không tick VERIFIED/ACCEPTED, không hand-edit `docs/21-openapi.json`,
không dùng legacy root.**
**Lease:** sửa **1 file** `orchestrator/apps/admin-web/src/features/overview/overview-screen.tsx` + **1 test mới**
`orchestrator/services/orchestrator/tests/f7-overview-usage-tile-offline.cjs`. Không chạm `api-key-section-renderer.ts`,
`overview-section-renderer.ts`, `tenant-list.ts`, `apps/admin-web/src/lib/api/client.ts`, `packages/**`, `businesses/**`.
**Tree:** HEAD `df3f955e877fe87bd190461736c40861e2fe78d5`, working tree dirty (lane khác). Node v22.23.3, TypeScript 5.9.3.

---

## 1. Fail-first (log đỏ giữ nguyên)

Harness viết **trước** khi sửa, encode **tiêu chí mới** (tile phải đọc usage thật + không còn claim sai).

| Log | Exit | Kết quả |
|---|---|---|
| `raw/…/red-1-harness-v1-no-component-expansion.log` | 1 | 7/8 fail — harness v1 **không expand function component** nên không tìm thấy Card nào; đỏ thật nhưng lý do còn là artefact của harness (giữ lại, không dùng làm bằng chứng chính) |
| `raw/…/red-2-before-fix.log` | **1** | **7/8 fail — đỏ có nghĩa, trên screen trước khi sửa** |

`red-2` fail đúng bản chất defect, literal:
- scenario 1: `the usage read must be issued exactly once` → `0 !== 1` (tile **không hề đọc** usage);
- scenario 2/4/5/7/8: `stale claim /not exposed/i must be gone — got: Usage rollup | requires backend | Per-tenant usage
  aggregation is not exposed by the platform BFF yet. The tile will render real counts once the usage read endpoint lands.`
- scenario 3: không có usage read nào được phát;
- scenario 6 (Operations tile): **PASS** — harness nhìn thấy tile, và Operations phải giữ nguyên.

## 2. Fix (file:line)

`orchestrator/apps/admin-web/src/features/overview/overview-screen.tsx` (digest `6335ff7a…5337`):

| Vị trí | Nội dung |
|---|---|
| `:1` | `import { useCallback, useEffect, useMemo, useState } from 'react'` (thêm `useMemo`) |
| `:30-37` (doc) | bỏ câu "Usage/Operations have no backend yet"; nói rõ usage đọc `/admin/api/usage`, Operations vẫn `requires backend` |
| `:39-100` | `USAGE_WINDOW_MS` (24h), type `UsageRollup{,Row,Totals}`, `UsageTileState`, `isRecord/readCount/readText`, **`parseUsageRollup`** (strict: 1 row/total không đọc được → cả payload `null`, không bao giờ chế số) |
| `:102-110` | `formatMicroUsd` (từ **integer micro-USD**, không cộng float), `formatWindow` |
| `:161-165` | state `usage` + `window` = `useMemo` cửa sổ 24h (from/to ISO) |
| `:169-214` | `load()`: session fail → tile fail-closed theo problem của session; scope `null`/`platform` → `scope-required` (không gọi route); scope `tenant` → `client.getUsage({tenantId: scope.tenantId, from, to})` → parse → `ready`/`failed` (payload hỏng → `502 UNREADABLE_RESPONSE`) |
| `:281` | thay `UnavailableTile title="Usage rollup"` bằng `<UsageRollupTile state={usage} window={window} onRetry=… />`; **Operations tile giữ nguyên** |
| `:449-560` | `UsageRollupTile`: badge `live`/`unavailable`/`tenant scoped`; loading/scope-required/failed/empty/ready; ready render **totals thật** (operations, input/output tokens, cost) + bảng theo provider/model + cửa sổ UTC; `scope-required` nói "Usage is tenant scoped. Select a tenant on the Usage screen…" + `<Link to="/usage">` |

**Nguồn tenant:** `session.scope` (`{kind:'tenant', tenantId}`) — không có tenant selector ở Overview, nên tile chỉ đọc khi
session đã tenant-scoped; platform/unscoped → pane "chọn tenant" (đúng lý do: BFF trả 422 nếu thiếu `tenantId`,
`bff/operations.ts:216-219`). **Cửa sổ:** 24h gần nhất, cùng mặc định Usage screen (`usage-screen.tsx:19-20`).
**Fail-closed:** mọi nhánh lỗi chỉ render pane (`ProblemPane`/`ErrorState`/`DeniedState`/`EmptyState`), không có số giả,
không còn copy "not exposed"/"requires backend" trên tile usage.

### Sự cố trong lúc làm (giữ trung thực)
- `green-attempt1-missing-usememo-import.log` (exit 1, 8/8 fail, `useMemo is not defined`): bản fix đầu **thiếu import
  `useMemo`** — harness bắt được ngay, chưa từng có green giả.
- Harness phải sửa 2 điểm trước khi xanh: (a) `textOf` phải gom cả **number** child (React render number thành text) —
  nếu không, assertion "1210/305 hiện ra" fail oan; (b) tile Operations phải tìm bằng **copy riêng**
  (`/operations list\/actions/i`) vì tile usage giờ chứa chữ "Operations" (label totals).

## 3. Green + VERIFY (command + exit code literal)

| # | Command (cwd) | Exit | Kết quả |
|---|---|---|---|
| 1 | `node tests/f7-overview-usage-tile-offline.cjs` (`services/orchestrator`) | **0** | `PASS: real OverviewScreen usage tile — 8 scenarios …` (`verify1-f7-harness.log`) |
| 2 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (`apps/admin-web`) | **0** | không output (`verify2-adminweb-tsc.log`), tsc 5.9.3 |
| 3 | `node tests/tenant-select-offline.cjs` (`services/orchestrator`) | **0** | `PASS: real TenantSelect element tree — 8 scenarios …` (F-4 không regression) |

⚠️ Đường dẫn tsc trong packet (`../../node_modules/typescript/bin/tsc` từ `apps/admin-web`) **không tồn tại** trong
workspace này (`orchestrator/node_modules` không có `typescript`) → dùng đường dẫn tương đương đúng:
`apps/admin-web/node_modules/typescript/bin/tsc` (chính là `tsc` mà script `typecheck` của package dùng).

8 scenario của harness: (1) session tenant → đọc đúng 1 lần với `tenantId` từ session, cửa sổ from<to, render totals thật
`1210/305/acme`, không còn copy sai; (2) platform → **không** gọi route, có link `/usage`, copy "select a tenant";
(3) 403 → denied pane, không số; (4) payload không đọc được → error pane, **không một chữ số nào** được render;
(5) cửa sổ rỗng → EmptyState; (6) Operations tile giữ nguyên copy + badge; (7) session fail → tile fail-closed, không đọc;
(8) session không có admin principal → pane trung thực, không lộ tenant id.

## 4. Mutation control (bắt buộc)

- Revert fix về **đúng bản HEAD** của file (`git show HEAD:<path>`, có lại copy "not exposed by the platform BFF yet")
  → chạy harness: **`mutation-red.log`, exit 1, 7/8 fail** (đúng các assertion stale-claim/không-đọc).
- Khôi phục bản fix từ backup byte: `RESTORED_HASH = 6335ff7a139c370938024512fa86df877e5805ba3d5340e9c93d89b200285337`,
  **`RESTORE_BYTE_EXACT=True`** (khớp hash trước mutation) → chạy lại: `green-after-restore.log`, **exit 0, 8/8**.

## 5. Giới hạn chưa cover (nói thẳng)

- **Element-tree level, không phải DOM render**: repo không có jsdom/@testing-library/react-test-renderer/happy-dom; harness
  transpile TSX + React shim và assert trên **cây element trả về** (giống convention `tenant-select-offline.cjs`). Không
  chứng minh được pixel/DOM thật, không chứng minh được hành vi của base-ui/`Link`/`Table` khi render thật.
- **Client bị stub, không có BFF/HTTP thật**: không có round trip `/admin/api/usage` → không chứng minh wiring URL/credential
  của BFF, không chứng minh shape thật trả về (shape được lấy từ `usage.ts:102-117` + test live `usage-summary.test.ts`).
- **Không chạy browser/Playwright** (ngoài lease, cần harness riêng) và **không chạy live PG**.
- **Collateral (ngoài lease, KHÔNG sửa)**: `du-rework/tests/browser/admin-web/overview.spec.ts:80`
  `expect(page.getByText('requires backend')).toHaveCount(2)` — sau fix chỉ còn **1** badge đó (Operations), nên spec này
  **sẽ đỏ** và cần owner browser sửa `2 → 1` (và nên thêm assertion cho usage thật). Các spec khác không bị ảnh hưởng:
  `tests/browser/tests/orchestrator-portal-all-features.spec.ts:259` chỉ assert `getByText('Usage rollup')` visible, title
  giữ nguyên. Rủi ro chưa kiểm chứng thêm: test 320px overflow (`overview.spec.ts:147-158`) — tile mới thêm `dl` + bảng
  trong `TableContainer` (giống pattern đã có), chưa đo lại bằng browser.
- `parseUsageRollup` được **export** khỏi screen (đặt trong file screen vì lease không cho sửa `features/overview/state.ts`);
  harness hiện test qua cây element, không import hàm này.

## 6. Artifact

- Sửa: `orchestrator/apps/admin-web/src/features/overview/overview-screen.tsx` (`6335ff7a…5337`).
- Test mới: `orchestrator/services/orchestrator/tests/f7-overview-usage-tile-offline.cjs` (`34759b2e…2dde`, 8 scenario).
- Receipt này + raw: `coordination/reports/raw/f7-overview-usage-tile-2026-10-08/` (12 file: red-1/red-2, green, attempt-1,
  mutation-red, green-after-restore, verify1-3, `RESULTS.txt`, `DIGESTS.txt`, `SHA256SUMS.txt`).
- Digest tham chiếu: `state.ts a2be0423…59f5`, `client.ts c2f7d709…5bea`, `bff/operations.ts 63689f23…4d58`,
  `tests/browser/admin-web/overview.spec.ts 89ad0872…ce77`.
- **Không** file nào khác bị sửa/tạo/xóa ngoài 3 đường dẫn trên (git status: 1 modified + 2 untracked); **không** commit/push;
  `docs/21-openapi.json` không bị chạm.
