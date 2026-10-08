# F-4 (test-only) — Render harness cho TenantSelect THẬT — 2026-10-08

**Kết quả: PRE-EXISTING GREEN — 8/8 scenario pass, exit 0, ngay lần chạy đầu.** Đây là task **coverage**,
không phải fix bug: component `TenantSelect` vốn đã đúng, nên **không có case đỏ nào để báo** và tôi
**không bịa** một cái đỏ. Để chứng minh "xanh" không phải "xanh rỗng", tôi chạy thêm **mutation control**
(§5): suite **đỏ 4/8, exit 1** khi hành vi "hiển thị tên" bị phá — chứng minh assertion có thật.

- **Quyết định hướng (user chốt):** **O2** — không thêm dependency; dùng đúng convention harness sẵn có của
  repo, nhưng trỏ vào **component THẬT** (không mock). Phương án thêm `vitest`/`jsdom`/`@testing-library`
  (O1) đã được trình và **không** chọn.
- **Lease:** **đúng 1 file TẠO MỚI** —
  `orchestrator/services/orchestrator/tests/tenant-select-offline.cjs`.
  **Không** sửa `src/**`, **không** sửa test cũ, **không** thêm devDependency, **không** dựng jsdom giả,
  **không** commit/push, **không** chạm `docs/21-openapi.json` (mtime **03:06:23**, trước phiên này).
- **Artifact được test (pin bằng hash, vì file KHÔNG được git track):**
  `apps/admin-web/src/components/ui/tenant-select.tsx`
  sha256 `d954f596036fcde2d38950ce6a1ab2745b78e7ea8c22b439fa032e408a4bd416` (mtime 08/10 02:49:06).
  `git ls-files` xác nhận file này **untracked** ⇒ không có commit digest cho nội dung đã test.
- **Harness mới:** sha256 `ed558d6db92085e640d92b7eca18820f5e54cb16842e7cc853cc9d146a0765c8`.
- **Environment:** Node **v24.21.0** (đúng `engines: ">=24.21.0 <25"`).
- **Raw + `SHA256SUMS.txt`:** `coordination/reports/raw/f4-tenantselect-render-2026-10-08/`.

## 1. Hạ tầng render ĐÃ DÙNG (nói thẳng)

**Không có renderer component nào trong repo** — đây là lý do phải chọn harness element-tree:

| Kiểm tra | Kết quả |
|---|---|
| `apps/admin-web/tests/` | **không tồn tại** (đường dẫn trong task trỏ sai; file thật của convention là `services/orchestrator/tests/usage-screen-offline.cjs:10`) |
| test runner trong `apps/admin-web` | **không có** (`.bin`: chỉ `cn, rimraf, shadcn, tsc, tsserver, vite`; `package.json` không có script `test`) |
| quét toàn `du-rework` (8.739 dir, 7.183 mục pnpm store, 756 `node_modules`) tìm `jsdom` / `jest-environment-jsdom` / `react-test-renderer` / `happy-dom` / `linkedom` | **0 hit** |
| `*.test.tsx` / `*.spec.tsx` toàn repo | **0 file** |
| `react-dom` | có, nhưng chỉ dùng được `react-dom/server`; SSR **không chạy `useEffect`** ⇒ không bao giờ thấy roster (mọi state của component này đều do effect sinh ra) |

⇒ Hạ tầng dùng thật: **`typescript` `transpileModule` (TSX → CJS, `jsx: React`) + `node:vm` + React hook
shim tự viết**, đúng convention `usage-screen-offline.cjs`. **Khác biệt cốt lõi:** harness cũ thay component
bằng `const TenantSelect = function TenantSelectMock() {}`; harness mới **load module thật**
(`exports.TenantSelect` phải là function, nếu không harness throw ngay) và chỉ shim `react`, `@/lib/api`,
`./select`.

**Đây KHÔNG phải DOM render.** Nó chạy code component thật rồi assert trên **cây element** trả về. Hệ quả
được ghi rõ ở §6, không giấu.

## 2. Phạm vi test đã viết (8 scenario, map thẳng vào yêu cầu a–d)

| # | Yêu cầu | Scenario | Assertion chính |
|---|---|---|---|
| a | roster có tenant → hiển thị TÊN, không UUID | `a: option labels are tenant names and no raw id reaches any text node` | 2 `SelectItem` với label `['Alpha','Beta']`; `props.value === [TENANT_A, TENANT_B]` (id **chỉ** là value); **mọi text node** join lại **không** chứa UUID nào; positive control `text.includes('Alpha')`; `SelectValue` có `children === []` và chỉ nhận `placeholder` ⇒ không có đường nào in id ra text |
| b | state ≠ ACTIVE → kèm trạng thái | `b: a non-ACTIVE tenant is labelled with its state` | `['Alpha','Beta (SUSPENDED)']` — đúng format `tenant-select.tsx:139` |
| c | value không có trong roster → không chọn nhầm tenant nào | `c: a value outside the roster selects nothing and never fires onValueChange` | `SelectRoot.props.value === null` (không fallback sang Alpha); placeholder `Select a tenant`; render **không** tự gọi `onValueChange`; `onValueChange(UNKNOWN)` **không** propagate, `onValueChange(TENANT_A)` propagate; nhánh `allowAll`: `value===null` → sentinel `__all_tenants__` + option `All tenants` đầu tiên, chọn sentinel → báo `null` |
| d | loading / failed / empty theo đúng state thật của component | `d1` loading (promise không resolve) | placeholder `Loading tenants…`, `disabled === true`, status `Loading tenant names…`, 0 option, `listTenants` gọi đúng 1 lần với `limit='100'` |
| d | | `d2` failed (`{ok:false}`) | placeholder `Tenant list unavailable`, `disabled === true`, **0 option cũ**, phần tử `role="alert"` với text `Tenant names are unavailable for this session.` |
| d | | `d3` empty (`items: []`) | placeholder `No tenants available`, `disabled === true`, text `No tenants are available.`, **không** có `role="alert"` |
| d+ | guard thật của component | `d4` cursor lặp | gọi đúng 2 lần rồi dừng (cycle guard `:65-74`) → rơi vào `failed`, không loop vô hạn |
| d+ | phân trang thật | `d5` roster 2 trang | gọi 2 lần, gộp đủ 2 option, `value` = id trang 2, vẫn **không** có UUID trong text |

Các state ở (d) là **state thật** của component (`loadState: 'loading'|'ready'|'failed'` + `empty` suy ra từ
`tenants.length`), **không** phải prop bịa: component không có prop `state`, các state này do kết quả
`client.listTenants()` quyết định.

## 3. Lệnh + exit code (literal)

| # | Lệnh | cwd | Exit | Kết quả | Raw |
|---|---|---:|---|---|
| 0 | `node orchestrator/services/orchestrator/tests/usage-screen-offline.cjs` | `du-rework` | **0** | baseline harness cũ (đang mock TenantSelect) — PASS | `00-baseline-blocker.txt` |
| 0b | `pnpm exec tsc --noEmit -p tsconfig.json` | `apps/admin-web` | **0** | sạch (`output_bytes=0`) — trước F-4 | nt |
| 1 | `node tests/tenant-select-offline.cjs` | `services/orchestrator` | **0** | **8/8 ok** — `PASS: real TenantSelect element tree — 8 scenarios` | `01-tenant-select-harness.txt` |
| 2 | mutation control (§5) | `%TEMP%` | **1** | **FAILED 4/8** — suite bắt được mutation | `02-mutation-control.txt` |
| 3 | `node orchestrator/services/orchestrator/tests/tenant-select-offline.cjs` (chạy lại từ `du-rework`) | `du-rework` | **0** | 8/8 ok | `03-suites-and-tsc.txt` |
| 3b | `node orchestrator/services/orchestrator/tests/usage-screen-offline.cjs` | `du-rework` | **0** | PASS (không regression) | nt |
| 3c | `pnpm exec tsc --noEmit -p tsconfig.json` | `apps/admin-web` | **0** | sạch (`output_bytes=0`) | nt |

**"Toàn bộ suite test hiện có của admin-web": KHÔNG TỒN TẠI.** `apps/admin-web` không có `tests/`, không có
runner, không có script `test`. Suite gần nhất chạm `TenantSelect` là `usage-screen-offline.cjs` (thuộc
`services/orchestrator`) — đã chạy, **exit 0**. Không có suite đỏ sẵn nào trong phạm vi này để báo.

**Không ảnh hưởng runner:** `services/orchestrator/jest.config.cjs` có `testMatch: ['**/*.test.ts']` ⇒ file
`.cjs` mới **không** bị jest thu thập, số suite/test của jest không đổi.

## 4. Fail-first — trung thực

- Viết harness trước, chạy: **xanh ngay 8/8** ⇒ báo **`pre-existing green`**, **không** dựng case đỏ giả.
  Lý do đúng như dự kiến: F-4 là **gap coverage**, không phải bug đã biết — component đã đúng từ trước.
- Bù lại, tôi chứng minh suite **không rỗng** bằng mutation control ở §5 (đây là *control*, không phải "red
  của suite", và được ghi nhãn đúng như vậy).
- **Không bỏ qua test đỏ nào**: không có test đỏ nào trong suite này; mutation control đỏ **đúng như thiết kế**
  và đã được ghi log.

## 5. Mutation control — chứng minh assertion có thật (không đụng file repo)

1. Copy `tenant-select.tsx` sang `%TEMP%\f4-mutation-control\tenant-select.mutated.tsx` và đổi
   `tenant.name` → `tenant.id` (chỉ trong **bản copy**).
2. Copy harness sang `%TEMP%`, chỉ đổi đường dẫn `SOURCE` sang bản mutated (chạy với `NODE_PATH` trỏ
   `node_modules` của service để resolve `typescript`).
3. Chạy đúng suite đó: **`FAILED 4/8`, exit 1** — `a`, `b`, `c`, `d5` đỏ với diff chính xác
   (`['11111111-…','22222222-…']` thay vì `['Alpha','Beta']`); `d1–d4` vẫn xanh (đúng, chúng không assert label).
4. **File trong repo không bị đổi**: log in kèm cả dòng label của bản mutated **và** của file repo
   (`... ? tenant.name : \`${tenant.name} (${tenant.state})\``).

⇒ Suite thực sự bắt được việc "in UUID thay vì tên", tức kết quả xanh ở §3 là **có ý nghĩa**.

## 6. Điều CHƯA cover (nói thẳng)

- **Không phải DOM render**: không có jsdom/renderer trong repo. Cụ thể **chưa** kiểm được:
  - **label mà base-ui vẽ ở trigger**: `SelectValue = BaseSelect.Value` (`src/components/ui/select.tsx:8`)
    lấy label từ registry nội bộ của base-ui. Harness chỉ chứng minh được: option label = tên, `SelectValue`
    **không** nhận id và **không** có children. Cái người dùng thực sự nhìn thấy ở trigger vẫn là suy luận.
  - portal/positioner/popup DOM thật, thuộc tính a11y (`aria-describedby`, `disabled` của trigger), tương tác
    chuột/bàn phím, focus management.
  - `class`/CSS, và hành vi của `SelectRoot` (base-ui) khi `value` là sentinel.
- **Không** chạy qua BFF/HTTP thật: `client.listTenants` được stub, nên shape wire thật (`TenantPage`) không
  được xác nhận ở đây (đã có suite khác lo phần đó).
- Harness **chưa được wire vào runner nào** — giống hệt file anh em `usage-screen-offline.cjs`: phải chạy tay
  bằng `node`. Nếu muốn nó thành gate tự động thì cần một task riêng (thêm script/nhà chạy = ngoài lease này).
- Không cập nhật `docs/28-test-inventory.md` / `docs/35-acceptance-baseline.md` (ngoài lease).

## 7. Ràng buộc đã giữ

**1 file mới duy nhất** (`tenant-select-offline.cjs`). Không sửa `src/**`, không sửa test cũ, không thêm
devDependency, không dựng jsdom giả, không commit/push. `admin-web`: **0 file** bị ghi trong phiên này
(mtime kiểm chứng). `docs/21-openapi.json` mtime 03:06:23 — không chạm.

## 8. Ranh giới vai trò

Receipt này là **báo cáo thực thi + bằng chứng**, **không** claim `VERIFIED`/`ACCEPTED` và **không** tick row.
F-4 vẫn cần **verify độc lập** trên bản code này (và, nếu gate yêu cầu DOM thật, phải giải blocker hạ tầng
render ở §1 trước — receipt này không tự cho rằng đã đủ).
