# VERIFY ĐỘC LẬP — OPU-G2 auto refresh + data age labels — 2026-10-08

- **Vai trò:** leg verify **độc lập, READ-ONLY**. Không sửa source/test, không commit/add/push, không tick gate,
  không hand-edit `docs/21-openapi.json`, **offline only** (không PG/Redis, không claim DB window), không đọc
  `.env.live`, scope `du-rework` only.
- **Environment:** Node **v24.21.0**, pnpm 10.18.3, Windows.
- **Tree pin:** HEAD `72e225ae5465e5a648c34bf31fbabbd182763233` (`72e225a`) — **không đổi trong phiên**;
  `git status --porcelain` = **80** ở đầu phiên, **82** ở cuối phiên (delta do các lane khác đang ghi song song —
  xem §0-bis; lane này chỉ ghi receipt này).
- **⚠️ OPU-G2 là công việc CHƯA COMMIT.** HEAD **không** chứa `aria-pressed`, `AUTO_REFRESH_MS` hay
  `DataAgeLabel` (`HEAD_has_aria_pressed=False`, `HEAD_has_AUTO_REFRESH=False`, `HEAD_has_DataAgeLabel=False`;
  HEAD = 591 dòng vs cây làm việc = 681 dòng). Cả hai screen là `M`, harness là `??`. Vì vậy verdict dưới đây
  gắn với **byte của cây làm việc**, pin bằng sha256:

| Artifact | sha256 |
|---|---|
| `apps/admin-web/src/features/overview/overview-screen.tsx` | `137f3507015087c31104a1dd6212f12fa186f045654d0b73bcc88970b35e0ed2` |
| `apps/admin-web/src/features/usage/usage-screen.tsx` | `5f9ada8c17d4eb4e90cc357eec07197826d23f9469b82147c6a271fdb303d056` |
| `services/orchestrator/tests/portal-auto-refresh-offline.cjs` | `9bcb6095c8942a86297ec77473720fd6395ab512dfdd79a0680e1a706ac8df6d` |

## 0-bis. ⚠️ Lane OPU-G2 GHI FILE TRONG LÚC TÔI VERIFY — đã re-run để evidence khớp hash

Trong cửa sổ verify, chính lane OPU-G2 đã ghi lại 3 artifact (mtime):

| Artifact | mtime | Ghi chú |
|---|---|---|
| `tests/portal-auto-refresh-offline.cjs` | **14:34:05** | viết lại **sau** lần chạy đầu của tôi |
| `features/overview/overview-screen.tsx` | **14:32:48** | viết lại trong lúc tôi đang đọc |
| `features/usage/usage-screen.tsx` | **14:36:38** | viết lại trong lúc tôi đang đọc |

**Xử lý (không sửa gì, chỉ chạy lại):**
1. Hash hiện tại **trùng khít** hash đã ghi ở §0 (so lại lúc 14:49:34 — cả 3 file giống hệt) ⇒ nội dung sau các lần ghi
   đó **chính là** byte tôi pin.
2. Vì lần chạy đầu có thể đã chạy bản **trước** 14:34, tôi **re-run cả 4 lệnh bắt buộc lúc 14:49:51** trên đúng
   byte đã pin — literal **giống hệt** lần đầu (xem §1).
3. Toàn bộ trích dẫn code ở §2 được **kiểm lại** trên byte đã pin: mọi marker claim-critical vẫn ở **đúng số dòng**
   như đã trích (overview `:161,182,185,197,213,243,291,307,311,324,325`; usage `:18,39,42,61,89,96,114,118,161,188`;
   line count 681 / 225).

⇒ Evidence của receipt này (cả lần chạy và cả trích dẫn code) gắn với **một** phiên bản artifact, không trộn hai bản.
Nếu lane OPU-G2 ghi tiếp, receipt phải được chạy lại — hash ở §0 là mốc để biết điều đó.

## 1. Lệnh bắt buộc — literal + exit code (chạy 2 lần, literal giống hệt)

cwd #1–#3: `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`; cwd #4:
`D:\Git\dugate\du-rework\orchestrator\apps\admin-web`. Lần 1 = đầu phiên; lần 2 = **re-run 14:49:51** trên byte đã pin.

| # | Lệnh | Exit (lần 1 / lần 2) | Literal |
|---|---|---:|---|
| 1 | `node tests/portal-auto-refresh-offline.cjs` | **0 / 0** | 9 dòng `ok` + `PASS: OPU-G2 auto refresh + data age — 9 scenarios (opt-in only, age from last success, stale-on-failure retention, cleanup on toggle-off/unmount)` — **giống hệt nhau ở cả 2 lần** |
| 2 | `node tests/f7-overview-usage-tile-offline.cjs` | **0 / 0** | 8 dòng `ok` + `PASS: real OverviewScreen usage tile — 8 scenarios (real totals, tenant from session, platform/unscoped/failed fail-closed, unreadable payload, empty window, Operations tile intact)` |
| 3 | `node tests/usage-screen-offline.cjs` | **0 / 0** | `PASS: platform gating, TenantSelect selection, All tenants guard, forwarding, tenant session prefill and lock` |
| 4 | `pnpm --filter @du/admin-web typecheck` | **0 / 0** | `output_bytes=122` — 122 byte là **banner của pnpm** (`> @du/admin-web@0.0.0 typecheck` + dòng lệnh), **0 lỗi TS** |

Output đầy đủ của #1 (9 scenario, tên scenario trùng khớp từng claim):
```
  ok  usage-1: a failed first load shows Unavailable, never a zero age, and never polls
  ok  usage-2: a successful load shows an age derived from when it completed
  ok  usage-3: polling starts only after the operator opts in, on the declared cadence
  ok  usage-4: a failed refresh keeps the last good data and marks it stale
  ok  usage-5: turning the toggle off and unmounting both clear the interval
  ok  overview-1: a failed first load shows Unavailable and never polls
  ok  overview-2: a successful load is fresh; opt-in registers one interval that polls
  ok  overview-3: a failed refresh keeps the last good rollup and marks it stale
  ok  overview-4: unmount clears the interval (no leak)
```

## 2. Kiểm tra code (đọc trực tiếp, không chỉ tin harness)

### Claim 1 — toggle auto-refresh MẶC ĐỊNH TẮT, có `aria-pressed` — **ĐÚNG**

| Screen | State khởi tạo | Nút toggle |
|---|---|---|
| Overview | `overview-screen.tsx:197` `const [autoRefresh, setAutoRefresh] = useState(false);` | `:321-329` — `aria-pressed={autoRefresh}` (`:324`), `data-portal-auto-refresh-toggle="true"` (`:325`), `onClick={() => setAutoRefresh(!autoRefresh)}` (`:326`), nhãn `Auto refresh: {autoRefresh ? 'On' : 'Off'}` (`:328`) |
| Usage | `usage-screen.tsx:61` `const [autoRefresh, setAutoRefresh] = useState(false);` | `:186-193` — `aria-pressed={autoRefresh}` (`:188`), nhãn `:192` |

Không có `setAutoRefresh(true)` hay giá trị khởi tạo `true` ở đâu khác (grep toàn 2 file). Harness pin thêm:
`portal-auto-refresh-offline.cjs:360` `assert.equal(toggle.props['aria-pressed'], false, 'the toggle is OFF by default (no consent)')`
và `:395` (sau opt-in thì `true`).

### Claim 2 — data-age = **Unavailable** khi chưa load thành công, không bao giờ 0/tuổi giả — **ĐÚNG**

- Overview `overview-screen.tsx:177-191`, Usage `usage-screen.tsx:34-47` — cùng một `DataAgeLabel`:
  - `data-data-age-state={lastSuccessAt === null ? 'unavailable' : stale ? 'stale' : 'fresh'}` (overview `:182`, usage `:39`)
  - `lastSuccessAt === null` ⇒ literal **`'Data age: Unavailable (no successful load yet)'`** (overview `:185`, usage `:42`)
  - nhánh tuổi chỉ chạy khi `lastSuccessAt !== null` (overview `:186`, usage `:43`) ⇒ **không có đường nào in tuổi khi chưa từng load**
- `formatDataAge` (overview `:163-170`) chỉ được gọi từ nhánh đã-có-success, và clamp `Math.max(0, …)` — nên `0s`
  chỉ có thể là **tuổi thật của dữ liệu vừa load xong**, không phải giá trị bịa cho trạng thái chưa load.
- Harness pin: `:365` `data-data-age-state === 'unavailable'`, `:367` text chứa `Unavailable`,
  **`:368` `assert.ok(!/\b0s\b/.test(ageText), 'no fake zero age')`**, `:426` sau khi đã có success thì **không**
  được quay lại `Unavailable`.
- Chi tiết cộng thêm (đúng hướng): Usage `:160-161` — khi đổi tenant scope thì `lastSuccess.current = null`,
  tức quay về `Unavailable` thay vì giữ tuổi cũ của tenant khác.

### Claim 3 — refresh thất bại giữ last good data + đánh dấu **stale** — **ĐÚNG**

- Overview `:288-297`:
  ```ts
  if (cycleFailed) {
    if (lastSuccess.current !== null) setStale(true);
    return;                     // ← không ghi đè pane nào
  }
  const stamp = Date.now(); lastSuccess.current = stamp; setLastSuccessAt(stamp); setStale(false);
  ```
  Mọi nhánh lỗi đều được bọc `if (!hasLastGood)` (`:219-224`, `:243`, `:248-257`, `:267`, `:272-281`) ⇒ khi đã có
  last-good thì pane **không** bị thay bằng pane lỗi; `hasLastGood` đọc từ ref đồng bộ (`:203`, `:211`).
- Usage `:86-105`: `:89` chỉ set `loading` khi `lastSuccess.current === null`; `:91-98` lỗi + đã có last-good ⇒
  **chỉ** `setStale(true)` rồi `return` (không `setSummary`); `:100-104` thành công ⇒ stamp + `setStale(false)`.
- Harness pin: `:409/420` payload cũ (`1210`) **vẫn hiển thị** sau refresh lỗi; `:422` state `stale`;
  `:425` tuổi vẫn suy từ lần success trước (`45s`).

### Claim 4 — unmount / toggle-off dọn interval — **ĐÚNG**

Cùng một effect ở cả hai screen (overview `:306-312`, usage `:113-119`):
```ts
useEffect(() => {
  if (!autoRefresh) return undefined;      // chưa opt-in ⇒ không tạo timer
  const timer = setInterval(() => { void load(); }, AUTO_REFRESH_MS);
  return () => clearInterval(timer);       // cleanup chạy cho CẢ toggle-off và unmount
}, [autoRefresh, load]);
```
Cadence khai báo tường minh: `AUTO_REFRESH_MS = 10_000` (overview `:161`, usage `:18`).
Harness pin: `:361/389` trước opt-in `timers.size === 0`; `:396` sau opt-in **đúng 1** interval; `:398` cadence
=== `AUTO_REFRESH_MS`; `:440-441` toggle-off ⇒ `timers.size === 0` **và** `clearInterval` đã được gọi cho đúng
timer đó; `:445` opt-in lại ⇒ interval mới; `:447` unmount ⇒ `timers.size === 0`.

## 3. FAIL

**Không có FAIL.** Cả 4 lệnh bắt buộc đều exit **0**; không có assertion đỏ, không có suite đỏ, không có
scenario nào fail trong 9 + 8 + 1 lần chạy harness. Không có kết quả đỏ nào để trích.

## 4. `docs/21-openapi.json`

- mtime **2026-10-08 03:06:23** (không đổi so với các lần kiểm trước trong ngày).
- `git status --porcelain -- du-rework/docs/21-openapi.json` → **không có dòng nào** ⇒ **sạch so với HEAD**,
  tức **không bị sửa** bởi lane OPU-G2 cũng như bởi phiên verify này. Claim "không sửa" **đạt**.

## 5. Quan sát trung thực (không phải FAIL, nhưng người đọc cần biết)

1. **Assurance của OPU-G2 là manual-only.** `tests/portal-auto-refresh-offline.cjs` là harness `.cjs`:
   `jest.config.cjs:6` vẫn là `testMatch: ['**/*.test.ts']` ⇒ jest **không bao giờ** thu thập nó (dù
   `roots` `:5` có chứa `tests/`). Grep toàn `du-rework` (trừ `node_modules` + `coordination/reports`) cho
   `portal-auto-refresh-offline`: **0 hit** — không script, config, `package.json` hay CI nào gọi nó. Nghĩa là
   **9 scenario của OPU-G2 không chạy trong bất kỳ lượt suite tự động nào**; chúng chỉ chạy khi gọi tay như
   trong receipt này. (Cùng lớp vấn đề đã ghi ở `coverage-gaps-READONLY-2026-10-08.md`.)
2. **Label tuổi không tự tick.** `formatDataAge(Date.now() - lastSuccessAt)` được tính **lúc render**
   (overview `:186`, usage `:43`); hai screen này **không** có interval 1 giây nào (khác
   `operations-screen.tsx:45,50` — nơi có `setInterval(..., 1000)` cho đồng hồ riêng). Nên khi auto-refresh
   **TẮT** và không có state change nào khác, chuỗi tuổi **đứng yên** ở giá trị của lần render cuối. Điều này
   **không** vi phạm 4 claim đang verify (nó không hiển thị tuổi giả/0 cho trạng thái chưa load), nhưng nếu
   acceptance mong đợi một con số tự đếm thì đó là khoảng trống cần owner xác nhận.
3. **OPU-G2 chưa commit** ⇒ chưa có digest để trích; verdict này gắn với 3 hash ở §0.

## 6. Limits — những gì tôi CHƯA chứng minh

- **Không có browser, không có DOM.** Cả 3 harness assert trên **element tree** với React hook shim tự viết
  (đã ghi trong header của harness). Chưa chứng minh: `aria-pressed` được browser phơi ra đúng, nút bấm được
  thật, `setInterval` thật của browser chạy đúng cadence 10s, và label cập nhật như người dùng thấy.
- **Không có DB/Redis**, không chạy live suite nào ⇒ hành vi của BFF `/admin/api/usage` khi refresh thật
  không nằm trong phạm vi này.
- **Không chạy toàn bộ suite jest** ⇒ tôi không xác nhận được trạng thái xanh/đỏ của các suite khác trong
  repo, cũng không xác nhận OPU-G2 không làm đỏ suite nào khác.
- **Chưa chứng minh "không rò interval" ở mức runtime thật** (đếm timer là của fake `setInterval` trong
  harness, `portal-auto-refresh-offline.cjs:257,262`), chỉ chứng minh ở mức element-tree/cleanup contract.
- **Không đọc `.env.live`** (theo yêu cầu) và không có secret nào xuất hiện trong output đã chạy.

**Không tick `VERIFIED`/`ACCEPTED` cho gate nào** — chữ "ĐÚNG" ở §2 là kết luận kỹ thuật của leg verify này,
không phải trạng thái ledger. Việc reconcile thuộc coordinator.
