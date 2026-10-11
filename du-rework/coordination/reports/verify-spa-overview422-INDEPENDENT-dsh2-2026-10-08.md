# VERIFY ĐỘC LẬP — SPA overview usage-422 & phần còn lại của F-2 — 2026-10-08

- **Vai trò:** leg verify độc lập, **READ-ONLY**. Không sửa source/test, không commit/add/push, không tick
  gate nào, không hand-edit `docs/21-openapi.json`, **offline only** (không claim DB window, không chạy
  live PG/Redis).
- **Lane:** `dsh2`. Không có file `verify-spa-overview422-INDEPENDENT-*` nào tồn tại trước đó ⇒ dùng hậu tố
  lane này; **không ghi đè** file nào.
- **Environment:** Node **v24.21.0** (đúng `engines`), jest 30.2.0, pnpm 10.18.3, Windows.
- **Mốc so sánh (quan trọng):** trong phiên này một commit mới đã xuất hiện —
  **`72e225ae5465e5a648c34bf31fbabbd182763233`** (`72e225a`, 2026-10-08 09:49:15 +0700,
  *"chore(rework): snapshot deployment architecture code and test evidence"*). Nó **chứa cả F-2 (shell) và
  F-7 (SPA)**. Hai file SPA được verify dưới đây **sạch so với HEAD** ⇒ mọi kết luận gắn với commit đó, có
  digest (khác các receipt trước phải pin bằng hash vì cây bẩn).
- **Raw + `SHA256SUMS.txt`:** `coordination/reports/raw/verify-spa-overview422-INDEPENDENT-dsh2-2026-10-08/`.

## (a) FAIL — không có FAIL nào

| # | Lệnh (literal) | cwd | Exit | Literal |
|---|---|---|---:|---|
| 1 | `pnpm --filter @du/admin-web typecheck` (script `apps/admin-web/package.json:11` = `tsc --noEmit -p tsconfig.json`) | `D:\Git\dugate\du-rework` | **0** | `output_bytes=122` — 122 byte là **banner của pnpm**, **0 lỗi TS** |
| 2 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/f2-overview-tenant-select-offline.test.ts tests/admin-overview-render.test.ts tests/admin-overview-triage.test.ts` | `…\orchestrator\services\orchestrator` | **0** | `Test Suites: 3 passed, 3 total` · `Tests: 183 passed, 183 total` |
| 3 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | `…\orchestrator\services\orchestrator` | **0** | `output_bytes=0` (sạch tuyệt đối) |
| 4 | `node tests/f7-overview-usage-tile-offline.cjs` **(bổ sung, không thuộc 4 lệnh bắt buộc)** | `…\orchestrator\services\orchestrator` | **0** | 8/8 `ok`, `PASS: real OverviewScreen usage tile — 8 scenarios` |
| 5 | `node tests/usage-screen-offline.cjs` **(bổ sung)** | `…\orchestrator\services\orchestrator` | **0** | `PASS: platform gating, TenantSelect selection, All tenants guard, forwarding, tenant session prefill and lock` |

**Không có FAIL.** Không có test nào bị skip trong 3 suite của #2 (`183 passed` = đúng tổng, `0 skipped`).

## (b) F-2 còn mở ở SPA không? — **ĐÃ ĐÓNG Ở CẢ HAI SURFACE**, nhưng bởi **hai lane khác nhau**

Đây là hai surface độc lập, không thay thế nhau:

### Surface 1 — shell server-rendered `/admin` (F-2, commit `72e225a`)
| Bằng chứng | file:line |
|---|---|
| Ô free-text đã bị thay bằng `<select>` roster-backed | `src/app/admin/overview-section-renderer.ts:294` (`<select name="tenantId" aria-label="Tenant">`) |
| Placeholder mặc định "Select a tenant", `selected` khi tenant hiện tại không có trong roster (chống re-point khi submit) | `overview-section-renderer.ts:283` |
| Trạng thái "Select a tenant" riêng khi chưa chọn tenant | `overview-section-renderer.ts:371-372` (`data-overview-tenant-required="true"`) |
| Không gọi usage/audit khi `tenantId` rỗng (đóng gốc 422) | `overview-section-data.ts` (`tenantRequired` + `Promise.resolve(null)`) — được pin bởi test |
| Test pin hành vi | `tests/f2-overview-tenant-select-offline.test.ts:104` (không còn `placeholder="All tenants"`), `:118` (có select), `:136-137` (**0** request `/api/v1/usage` và `/api/v1/admin/audit` khi tenant rỗng), `:140` (tenant-required), `:155-157` (có tenant ⇒ đúng 1 usage + 1 audit + 1 roster) |

⇒ Chạy #2: **xanh**. Đây là surface mà receipt `tenant-usage-connector-verify-dsh2` gọi là F-2.

### Surface 2 — SPA React `apps/admin-web` (F-7, cùng commit `72e225a`)
| Câu hỏi của task | Trả lời + file:line |
|---|---|
| Overview có thực sự gửi `tenantId` lên usage không? | **Có — nhưng chỉ khi session là tenant-scoped**: `features/overview/overview-screen.tsx:186-190` gọi `client.getUsage({tenantId: scope.tenantId, from, to})`. Đây là **call site duy nhất** của `getUsage` trong screen này. |
| Nếu rỗng thì UI xử lý ra sao — lỗi rõ ràng hay lỗi chung? | **Không gửi request nào** và hiện thông điệp **riêng, rõ ràng**: `:182-184` (`scope === null \|\| scope.kind === 'platform'` ⇒ `setUsage({kind:'scope-required'})`) → `:499-507` render *"Usage is tenant scoped. Select a tenant on the Usage screen to read its counts."* + link `/usage`. **Không phải lỗi chung, và không thể có 422** vì không có request. State `scope-required` là một nhánh riêng, được chú thích là "not a failure" (`:56-61`). Session fail ⇒ tile fail-closed (`:174-175`). |
| Comment ở `:180` là code thật hay chỉ comment? | **Code thật**: comment `:180-181` mô tả đúng nhánh `:183-184`; hành vi được pin bởi harness F-7. |
| Usage có nhánh 422 riêng không? | **Không có nhánh 422 riêng**: `features/usage/usage-screen.tsx:65-68` chỉ tách `403 → denied`, còn lại → `error` chung (`ErrorState` + `problem.title`/`statusCode`/`code`). **Nhưng** user không gặp 422 thiếu-tenant: guard `:46` chặn trước khi gửi (thiếu tenant ⇒ `validTenant` false; All ⇒ `tenantId === null`), Load disabled `:112`, alert riêng `:113` (All) và `:114` (chưa chọn). ⇒ Khi platform session chưa chọn tenant, người dùng thấy **"Select a tenant to load usage."**, không thấy lỗi. |
| Có còn sổ với `usage-422-fix-2026-10-08.md` không? | **Không còn sổ.** Receipt đó khai phạm vi = **Usage screen + BFF + tests** (`usage-422-fix-2026-10-08.md:15-19,55-56`) và **không** nhắc SPA Overview; phần SPA Overview được xử lý bởi lane **F-7** (`overview-screen.tsx` +288 dòng, `tests/f7-overview-usage-tile-offline.cjs` +469 dòng trong `72e225a`). Hai receipt **bổ sung nhau**, không mâu thuẫn. |

**Harness F-7 pin đúng câu hỏi này** (chạy #4, 8/8 xanh):
`f7-overview-usage-tile-offline.cjs:317-331` — platform session ⇒ `getUsage.length === 0`, tile nói "select a tenant", có `Link` tới `/usage`; `:415-443` — session fail / không có principal ⇒ `0` request + pane honest; `:289-312` — tenant session ⇒ đúng 1 request với `tenantId` từ session.

**Kết luận (b):** finding usage-422 cho platform-session-chưa-chọn-tenant **đã đóng ở cả hai surface** —
shell bởi F-2, SPA bởi F-7 — mỗi surface có test riêng, cả hai đều xanh trong phiên này.

## (c) Có assertion nào bị nới/yếu không? — **KHÔNG**

Đối chiếu diff đã commit (`git diff df3f955 72e225a`) với phần "3 assertion cũ phải cập nhật" trong
`f2-overview-tenantselect-2026-10-08.md` §5: **khớp chính xác từng chỗ**, và không có chỗ nào khác:

| Vị trí | Trước | Sau | Đánh giá |
|---|---|---|---|
| `tests/admin-overview-render.test.ts:347` | `expect(calls.length).toBe(6)` | `toBe(7)` **+** `expect(calls.filter(u => u.includes('/api/v1/admin/tenants'))).toHaveLength(1)` | **Mạnh hơn**: vẫn pin số chính xác, thêm vế định danh request mới |
| `tests/admin-overview-triage.test.ts:80` | `expect(calls).toHaveLength(6)` | `7` **+** cùng vế tenants | **Mạnh hơn** |
| `tests/admin-overview-triage.test.ts:574` | `expect(html).not.toMatch(/<option[^>]*\bselected/)` (toàn trang) + `toContain('<option value="today">')` | scope vào **`<select name="timeRange">`**: `const timeWindow = /<select name="timeRange"[^>]*>(.*?)<\/select>/.exec(html)?.[1] ?? ''` rồi assert trên `timeWindow` | **Giữ nguyên ý định, siết phạm vi**: preset độc hại vẫn làm select timeRange có `selected` ⇒ vẫn đỏ. Trước đây regex toàn trang chỉ đúng vì chỉ có 1 select. |

- **Không assertion nào bị xoá, không test nào bị bỏ, không `skip`/`todo` mới.**
- Suite mới của F-2 (295 dòng, 11 test) **là assertion thật**, không rỗng: nó assert *sự vắng mặt* của ô
  free-text (`:104`), *số request* (0 vs 1) và *fail-closed* khi roster lỗi (`:165-193`).
- Đã kiểm chéo: `git diff` của 2 file test cũ **chỉ** chứa 3 hunk trên ⇒ không có thay đổi assertion nào khác
  lẫn vào từ lane khác.

## (d) Verdict

**VERIFIED (offline, read-only, tại commit `72e225a`):**
1. Shell F-2: tenant picker roster-backed + trạng thái tenant-required + **không** gọi usage/audit khi chưa
   chọn tenant — `f2-overview-tenant-select-offline.test.ts` xanh trong #2 (183 test tổng).
2. SPA F-7: Overview **không** gửi request usage khi session platform/unscoped, hiện thông điệp riêng +
   link; tenant session gửi đúng `tenantId` của session — harness F-7 8/8 (#4).
3. Usage screen: fail-closed trước khi gửi (guard + 2 alert + Load disabled) ⇒ **422 thiếu-tenant là
   unreachable từ UI** — `usage-screen-offline.cjs` xanh (#5).
4. Không có assertion bị nới/yếu trong diff F-2 (mục c).
5. Typecheck: admin-web **exit 0** (#1); service **exit 0, 0 byte** (#3).

**OPEN (nói thẳng):**
1. **Không có verify browser/live** cho cả hai surface — mọi bằng chứng ở đây là **offline + element tree**,
   không phải DOM đã vẽ. Cụ thể chưa chứng minh được: label mà base-ui vẽ ở trigger của `<select>` shell,
   portal/positioner, a11y attributes, và tương tác thật. Không claim DB window.
2. **Coverage của SPA chưa tự động**: `jest.config.cjs:6` là `testMatch: ['**/*.test.ts']` ⇒ các harness
   `.cjs` (F-7, usage-screen, tenant-select) **không** được jest thu thập; chúng chỉ chạy khi gọi tay. Nghĩa
   là bảo đảm "SPA không gọi usage khi thiếu tenant" **không nằm trong bất kỳ lượt suite tự động nào**. Đây
   là điểm mở về *gate*, không phải về *code*.
3. **Usage screen không có pane 422 riêng** — chấp nhận được (422 do nguyên nhân khác vẫn hiện
   title/status/code của problem, không im lặng), nhưng là một nuance UX còn mở nếu muốn thông điệp chuyên biệt.
4. Tôi verify **artifact**, không verify quy trình/claim của lane F-7; và các suite đỏ có sẵn khác trong repo
   (đã phân loại ở `triage-pre-existing-red-2026-10-08.md`) **không** nằm trong phạm vi lần này.

**Không tick `VERIFIED`/`ACCEPTED` cho gate nào** — chữ "VERIFIED" ở trên chỉ là kết luận kỹ thuật của leg
verify này, không phải trạng thái ledger; việc reconcile thuộc coordinator.

## Read-only proof + mốc pin

- **Trong cửa sổ verify (12:46–12:50 ngày 08/10), lane này chỉ ghi 6 file**: 5 file trong
  `coordination/reports/raw/verify-spa-overview422-INDEPENDENT-dsh2-2026-10-08/` + receipt này. Không file
  `src/` hay `tests/` nào bị ghi bởi lane này (kiểm bằng liệt kê mtime toàn `du-rework`).
- Các file khác đổi trong cùng cửa sổ (`fix-observability-node-env-2026-10-08.md` 12:37,
  `med1-*` + `src/db/migrations.ts` 12:43–12:45) thuộc **lane khác**, có receipt riêng — không phải lane này.
- **10/10 file được verify đều CLEAN so với HEAD** (`git status --porcelain` rỗng):
  `overview-section-renderer.ts`, `overview-section-data.ts`, `f2-overview-tenant-select-offline.test.ts`,
  `admin-overview-render.test.ts`, `admin-overview-triage.test.ts`, `f7-overview-usage-tile-offline.cjs`,
  `usage-screen-offline.cjs`, `overview-screen.tsx`, `usage-screen.tsx`, `jest.config.cjs`
  ⇒ verdict gắn **chính xác** với commit **`72e225ae5465e5a648c34bf31fbabbd182763233`**, không phải một cây
  đang bẩn dở. (Cây tổng thể vẫn đang được các lane khác sửa — 51 file dirty — nhưng **không** nằm trong tập
  file đã verify.)
