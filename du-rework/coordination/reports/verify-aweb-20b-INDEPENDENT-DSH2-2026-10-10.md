# Verify độc lập (DSH2) — AWEB-16b + AWEB-20b từ góc admin-web — 2026-10-10

**Vai trò:** Independent Verifier (DSH2). Lease **READ-ONLY** trên `apps/admin-web/src/features/**` (overview + operations), harness offline liên quan, và các module/BFF mà hai packet chạm.
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test/build offline; **KHÔNG** sửa source/test/config/docs; **KHÔNG** `git add` / commit / push; **KHÔNG** tick gate; **KHÔNG** PostgreSQL/Redis/live; **KHÔNG** đọc `.env.live`.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v24.21.0 (`%TEMP%/du-node24-security-c025dd92/node-v24.21.0-win-x64/node.exe`, đúng `engines: >=24.21.0 <25`) · ambient `NODE_ENV=production`.
**Raw:** `coordination/reports/raw/verify-aweb-20b-2026-10-10/DSH2/` (9 log + `SHA256SUMS.txt`).

> **CẢNH BÁO DRIFT (đọc trước):** trong lúc tôi verify, một lane khác **đang ghi** vào chính các file của AWEB-16b (mtime `21:33:51` → `21:38:08`). Mọi kết luận dưới đây gắn với **sha256 cụ thể**, không phải với `HEAD` (HEAD không chứa phần đang bay). Có **một lần suite 16a ĐỎ thoáng qua** rồi xanh lại — ghi đầy đủ ở §4.

---

## 0. Kết luận ngắn

| Hạng mục | Verdict | Cơ sở |
|---|---|---|
| **AWEB-20b** (bulk cancel; receipt có) | **PASS ở phạm vi offline/UI-code** | harness `17/17` exit 0 (2 assertion AWEB-20b); 5/5 claim của receipt khớp code |
| **AWEB-16a** (overview tenant scope; receipt `receipt-aweb-16a-2026-10-10.md`) | **PASS** trên revision hiện tại | jest `3 passed, 3 total` exit 0, hash-stable |
| **AWEB-16b** (server-side aggregation; **receipt KHÔNG tồn tại**) | **KHÔNG THỂ VERIFY/ACCEPT** — không có receipt để đối chiếu; code đang bay, suite riêng `5/5` xanh | §3 |
| Build admin-web | **PASS** — `npm run build` exit 0 | §4.3: claim `FAIL ở client.ts:385` của **cả hai** receipt **không tái hiện được** |
| Collateral overview | 7/8 suite xanh; 2 test đỏ ở `operations-list-contract-conformance` là **stale expectation đã biết của AWEB-20a** | §4.4 |

**Một dòng cho coordinator:** AWEB-20b đạt (offline), AWEB-16a đạt lại; **AWEB-16b chưa có receipt nên chưa thể tính VERIFIED** dù code + suite riêng đang xanh trên cây — cần owner chốt receipt và cần live/DB evidence cho câu SQL aggregate.

---

## 1. Bằng chứng chạy (không có FAIL nào ngoài 2 mục đã biết)

| # | Lệnh (cwd) | Exit | Literal |
|---|---|---:|---|
| 1 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/aweb-16a-overview-tenant-operations.test.ts` (`services/orchestrator`) | **0** | `Test Suites: 1 passed, 1 total` · `Tests: 3 passed, 3 total` · `Time: 2.506 s` |
| 2 | `node tests/operations-timeline-filters-offline.cjs` (`services/orchestrator`) | **0** | `PASS operations-timeline-filters-offline.cjs - 17 assertions (OPS-1 x2, OPS-2 x4, OPS-4 x6, AWEB-20b x2, OPS-3 x3)` · 17 dòng `ok` + 1 dòng PASS (18 dòng log) |
| 3 | `node node_modules/vite/bin/vite.js build` (`apps/admin-web`) | **0** | `✓ 2697 modules transformed` · `✓ built in 10.46s` · cảnh báo `Some chunks are larger than 500 kB` |
| 4 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (`apps/admin-web`) | **0** | **0 dòng output** |
| 5 | `npm run build` (`apps/admin-web`, `tsc --noEmit && vite build`) | **0** | `✓ built in 10.12s` (lần chạy trên revision mới nhất) |
| 6 | `node --test tests/audit-state.test.mjs tests/trace-state.test.mjs` (`apps/admin-web`) | **0** | `tests 12` · `pass 12` · `fail 0` · `suites 2` |
| 7 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/aweb-16b-overview-metrics-offline.test.ts` (`services/orchestrator`) | **0** | `Test Suites: 1 passed, 1 total` · `Tests: 5 passed, 5 total` · `Time: 2.417 s` |
| 8 | batch 8 suite overview/operations (xem §4.4) | **1** | `Test Suites: 1 failed, 7 passed, 8 total` · `Tests: 2 failed, 413 passed, 415 total` |
| 9 | `git diff --check` trên 3 path trong lease | **0** | không output |

Ghi chú trung thực về chính lượt này: lệnh đầu tiên tôi chạy `node --test tests/` (truyền **thư mục**) đã đỏ với `Error: Cannot find module .../admin-web/tests` — đây là **lỗi cú pháp lệnh của tôi**, không phải lỗi sản phẩm; lệnh #6 truyền **file tường minh** mới là cách chạy đúng và xanh. Log đỏ đó đã bị ghi đè bởi log #6.

---

## 2. AWEB-20b — đối chiếu từng claim của `receipt-aweb-20b-2026-10-10.md`

Artifact được kiểm: `apps/admin-web/src/features/operations/operations-screen.tsx` sha256 `2209f21f00a262a7aff97178db351c9c6ce0712f739e0a93fe0a3f882cdc1ebd` (870 dòng, mtime `20:44:18`, ` M`) · harness sha256 `32e4de13fb4dae878c3ce7868cfc203e0f64a369578163931ad3737cf97d8397` (399 dòng, mtime `20:43:35`, ` M`). Cả hai **không đổi** trong suốt lượt verify (hash trước = hash sau, đã in ra).

| # | Claim trong receipt | Verdict | Bằng chứng |
|---|---|---|---|
| 1 | Bulk cancel tiếp tục tới các target còn lại sau API rejection **hoặc** transport error | **ĐÚNG** | `operations-screen.tsx:156-174` vòng `for` + `continue` khi `!result.ok` + `try/catch` quanh `client.operationAction`; harness `:330-333` `assert.deepEqual(attempted, [RUN, RUN_TWO, RUN_THREE])` |
| 2 | Chỉ ID thành công bị gỡ khỏi selection; ID lỗi giữ selection **và idempotency key** | **ĐÚNG (chia 2 mức)** | selection: `:175` + harness `:334-341` (RUN=false, RUN_TWO=true, RUN_THREE=true). Idempotency key: `:158-159` set trước call, `:166` chỉ `delete` khi thành công ⇒ key giữ lại khi lỗi — **chỉ được kiểm bằng đọc code**, harness **không** assert key retention |
| 3 | Báo đúng số succeeded/failed; alert riêng liệt kê từng ID lỗi kèm title, error code, HTTP status khi có; exception transport nhận message generic, không lộ raw | **ĐÚNG** | `:178` notice `Bulk cancel finished: N succeeded, M failed.`; `:398-410` `AlertBanner title='Bulk cancel item failures'` render `problem.title`, `problem.code`, `problem.status > 0 ? HTTP <status>`; `:168-173` problem generic `{status: 0, code: 'REQUEST_FAILED', title: 'Cancel request did not complete.'}`. Harness `:342-349` assert đúng title summary, có `CANCEL_DENIED` + `REQUEST_FAILED`, và `!includes('transport detail must not be echoed')` |
| 4 | Harness phủ batch 3 mục: 1 success, 1 API failure, 1 thrown transport failure | **ĐÚNG** | harness `:307-317` dựng 3 op (RUN/RUN_TWO/RUN_THREE) + stub `:313-316`; `:330-350` hai check AWEB-20b |
| 5 | `npx vite build` PASS, Vite báo chunk chính > 500 kB | **ĐÚNG** | lệnh #3: exit 0, `built in 10.46s`, cảnh báo chunk `1,029.60 kB` |
| 6 | `git diff --check` cho source+test trong lease PASS exit 0 | **ĐÚNG** | lệnh #9: exit 0 |
| 7 | `npm run build` **FAIL** — `tsc` báo mismatch ngoài lease ở `src/lib/api/client.ts:385` (`profileKeyAction` trả `ProfileMutationResult` nhưng interface cần `PostActionResult`) | **KHÔNG TÁI HIỆN ĐƯỢC** | lệnh #4 và #5: exit 0, 0 lỗi. `client.ts` hiện khai báo `ProfileKeyActionResult` (`:28`, `:125-132`, `:386`) và đã đổi **sau** receipt (mtime `21:33:59` > receipt `20:44`) ⇒ dòng giới hạn này là **ảnh chụp cây cũ, nay đã hết hiệu lực**, không còn là lý do hoãn acceptance dựa trên build |

**Giới hạn phạm vi (giữ nguyên như các lượt trước):** harness là **element-tree + `node:vm` tự viết** (transpile TSX rồi chạy với React hook giả), **không** phải renderer/DOM thật ⇒ chứng minh được logic + chuỗi event, **không** chứng minh hành vi trình duyệt (focus, confirm dialog thật, timing). Không có Playwright, không gọi API thật, không DB.

---

## 3. AWEB-16b — hiện trạng thật: **không có receipt**, code đang bay

### 3.1 Không tồn tại receipt hay dispatch cho AWEB-16b
- `coordination/reports/` có `receipt-aweb-16a`, `17`, `18`, `19`, `20a`, `20b` — **không có** `receipt-aweb-16b*` (đã liệt kê toàn bộ file khớp `*aweb*`).
- `coordination/dispatch-specs/*aweb-1[6-9]*` → **0 file**: chưa từng có dispatch packet cho dải AWEB-16..19.
- `PLAN-FRONTEND-ADMIN-WORKSPACE-2026-10-10.md:7` tự ghi **SPECIFIED / chưa dispatch**; `:82` định nghĩa AWEB-16b là backend aggregation (total/success/failure/p50/p95 + `sampledAt` + cờ stale).
⇒ **Không có chủ thể để verify**: không receipt, không acceptance đã chốt, không owner công bố. Đây là kết luận, không phải suy đoán.

### 3.2 Nhưng implementation **đang được viết** trên cây làm việc (uncommitted)
| Artifact | sha256 | mtime | git |
|---|---|---|---|
| `services/orchestrator/src/modules/admin-read/operations-metrics.ts` (mới, 155 dòng) | `db32b17f…9ab63` | 21:36:04 | `??` |
| `services/orchestrator/tests/aweb-16b-overview-metrics-offline.test.ts` (mới, 151 dòng) | `049e2777…3b97a` | 21:36:14 | `??` |
| `services/orchestrator/src/app/admin/bff/operations.ts` (`/operations/metrics`, `:39,52,195-215`) | `f6edb1ff…a14f1` | 21:33:56 | ` M` |
| `services/orchestrator/src/http/routes/public.ts` (`:17,430-450`) | `ff8de844…51c13` | 21:33:51 | ` M` |
| `packages/contracts/src/public-api.ts` (`compareAdminListTimeBounds`) | `f5594486…e53ce` | 21:09:30 | ` M` |
| `apps/admin-web/src/lib/api/client.ts` (`getOperationsMetrics`, `:159,444`) | `a753aca8…bdfe7` | 21:33:59 | ` M` |
| `apps/admin-web/src/features/overview/state.ts` (`OperationsMetricsSnapshot`, `parseOperationsMetrics`) | `7a3321cb…f867f` | 21:38:08 | ` M` |
| `apps/admin-web/src/features/overview/operations-monitor-dashboard.tsx` | `d53edcbb…1b91c` | 21:36:17 | ` M` |
| `apps/admin-web/src/features/overview/overview-screen.tsx` (request metrics `:330-366`) | `6441d28d…7a26f` | 21:37:10 | ` M` |

### 3.3 Đối chiếu acceptance plan §3 với code (đọc trực tiếp)
| Acceptance AWEB-16b | Trạng thái | Bằng chứng |
|---|---|---|
| Aggregation **server-side** theo khung thời gian + tenant | **CÓ** | `operations-metrics.ts:91-115` một câu SQL `count(*) FILTER (…)` + `percentile_cont(0.50/0.95) WITHIN GROUP … FILTER`, `WHERE created_at >= $1 AND created_at <= $2` + `AND tenant_id = $3::uuid`; `parseOperationsMetricsQuery:51-76` ép đúng `from`/`to`/`tenant`, 422 `INVALID_SCHEMA` cho thiếu/đảo/trùng/tenant không UUID/param lạ |
| Trả `total/success/failure/p50/p95` | **CÓ** | `:16-31` + `:122-137` (kèm `cancelled/timedOut/running/durationSamples`) |
| Có `sampledAt` | **CÓ** | SQL `statement_timestamp() AS sampled_at` (`:92`) → `:135` ISO |
| Có cờ **stale** | **CÓ (định nghĩa hẹp)** | `:6` `STALE_AFTER_MS = 30_000`; `:136` `stale = Date.now() - queryStartedAt > 30s` ⇒ đây là **stale của truy vấn chậm**, không phải stale của dữ liệu. UI lại gộp thêm nghĩa thứ hai: `operations-monitor-dashboard.tsx:206` in `stale || operationMetricsFailed` — **hai nghĩa khác nhau dùng chung một nhãn**, nên ghi nhận là điểm cần owner xác nhận ngữ nghĩa, không phải bug đã chứng minh |
| Không còn mẫu 100 dòng | **MỘT PHẦN (trung thực)** | KPI lấy từ aggregate (`:66-76`), nhưng `listOperations({limit: '100'})` **vẫn còn** cho biểu đồ (`overview-screen.tsx:327-334` + dashboard `:206` in rõ `chart uses the latest N list rows`) ⇒ đúng tinh thần minh bạch số liệu, khác chữ của plan |
| Fence 2 tầng giữ nguyên | **CÓ** | BFF `operations.ts:195-211` `authorizeAuditTenantRead(rbacPrincipal(principal), query.tenant)` rồi chỉ gắn `tenant` khi scope khác rỗng; upstream `public.ts:433-448` admin principal → `authorizeAuditTenantRead` → `scope === '' ? null : scope`; nhánh api-key chặn `tenantId !== apiKey.tenantId` bằng 403 `PERMISSION_DENIED` |
| UI chống response lệch (out-of-order) | **CÓ** | `overview/state.ts:121-134` từ chối payload nếu `from/to/tenantId` không khớp yêu cầu, `sampledAt` không parse được, `stale` không phải boolean, tổng các state ≠ `total`, `durationSamples > total`, `p50`/`p95` lệch null, `p50 > p95`; `overview-screen.tsx:254-255,341-366` chốt `metricsRequestId` trên `lastSuccess` |
| Suite riêng của packet | **5/5 xanh** | lệnh #7, hash 2 dependency ổn định trước/sau |

### 3.4 Điều **chưa** được chứng minh cho AWEB-16b
1. **Không có receipt** ⇒ không thể VERIFIED/ACCEPTED; mọi thứ ở §3.3 là *đọc code + chạy suite của chính tác giả*, **không phải** verify độc lập một packet đã giao.
2. **Câu SQL aggregate chưa từng chạy trên PostgreSQL thật.** Suite 16b chỉ assert **chuỗi SQL + params** qua `db.query` giả (`:65-104`) — đúng như tên test. Tính đúng của `percentile_cont … FILTER`, kiểu trả về `::text`, và độ chính xác p50/p95 trên dữ liệu thật **chưa có bằng chứng nào**. Lượt này offline nên tôi **không** claim.
3. **Chưa có browser/live evidence** cho Overview mới (KPI thật, nhãn sample/stale, hành vi khi metrics lỗi).
4. **Route mới chưa được kiểm bằng HTTP thật**: chưa rõ 401/403/422 trên wire, và `authorizeAuditTenantRead` với principal platform + `tenant` do client gửi (BFF đã chặn theo scope, nhưng upstream cũng nhận trực tiếp).
5. **Suite 16b không nằm trong lease nào đã công bố** — cần coordinator mở lease/receipt trước khi tính là giao hàng.

---

## 4. Drift của cây làm việc trong lúc verify (bắt buộc đọc cùng §0)

### 4.1 Một lần suite 16a **ĐỎ thoáng qua**, rồi xanh lại — cùng một lane sửa
| Thời điểm | `overview-screen.tsx` | Kết quả 16a | Literal |
|---|---|---|---|
| ~21:26 (lượt chạy đầu) | sha `23d9200b…f96b`, 1125 dòng, mtime 21:34:43 | **ĐỎ** | `Tests: 2 failed, 1 passed, 3 total`, exit 1, `ReferenceError: operationsMetricsRequestSequence is not defined at load` |
| ~21:41 (re-run, lệnh #1/#9) | sha `6441d28d…7a26f`, 1127 dòng, mtime 21:37:10 | **XANH** | `Tests: 3 passed, 3 total`, exit 0, hash trước = hash sau |

Nguyên nhân đã xác định, không suy đoán: harness 16a (`tests/aweb-16a-overview-tenant-operations.test.ts:51-59`) **trích riêng arrow function `load`** rồi inject một **danh sách binding cố định**; revision `23d9200b` đọc một `useRef` khai báo ngoài `load` (`operationsMetricsRequestSequence`) mà danh sách inject không có ⇒ `ReferenceError`. Revision `6441d28d` đã chuyển state đó vào `lastSuccess.metricsRequestSequence` (`:254-255` — `lastSuccess` **có** trong danh sách inject) ⇒ xanh lại. **Đây là bài học về độ giòn của harness trích-callback, không phải bug sản phẩm**, nhưng nó chứng minh: bất kỳ ai thêm binding ngoài `load` đều làm đỏ suite 16a.

### 4.2 Test 16a không đổi trong suốt lượt
`tests/aweb-16a-overview-tenant-operations.test.ts` sha `483f1da6…f331` (137 dòng, mtime `20:43:05`, `??`) — **giống hệt** thời điểm receipt. Vậy chuyển đỏ→xanh là do **code sản phẩm đổi**, không phải test bị nới.

### 4.3 Claim giới hạn build trong **cả hai** receipt đã hết hiệu lực
Cả `receipt-aweb-16a` và `receipt-aweb-20b` đều ghi `npm run build` FAIL ở `client.ts:385`. Trên cây hiện tại: `tsc` exit 0, `npm run build` exit 0 (lệnh #4, #5), `client.ts` đã có `ProfileKeyActionResult` và mtime `21:33:59` **sau** hai receipt (`20:43`/`20:44`). ⇒ Cả hai packet **không còn** bị chặn bởi lý do này.

### 4.4 Collateral (batch 8 suite, lệnh #8)
Xanh: `aweb-16b-overview-metrics-offline`, `aweb-16a-overview-tenant-operations`, `admin-overview-triage`, `admin-overview-render`, `admin-overview-view-model`, `f2-overview-tenant-select-offline`, `aweb06-bff-operations`.
Đỏ: `operations-list-contract-conformance.test.ts` — `2 failed, 413 passed` với đúng 2 test `W-CONTRACT-ALIGN-1: the route reads exactly the contract parameter set` ⇒ **khớp disclosure của `receipt-aweb-20a`** (17/19, stale kỳ vọng 6 tham số). Không phải regression mới của 16b/20b.

### 4.5 File đổi **sau** khi tôi đọc
`apps/admin-web/src/features/overview/state.ts` đổi từ `487dbbbe…de59` (21:36:11) sang `7a3321cb…f867f` (21:38:08) — bản mới **siết thêm** kiểm tra nhất quán nội bộ (`:131-134`). Mô tả UI ở §3.3 tương ứng bản `7a3321cb`; suite 16b không phụ thuộc file này nên kết quả `5/5` vẫn hợp lệ (dependency của nó: `operations-metrics.ts` + file test, cả hai hash không đổi).

---

## 5. GAP / open items cho coordinator

1. **AWEB-16b: mở receipt + lease chính thức** cho lane đang viết (`operations-metrics.ts`, BFF route, client/state/screen/dashboard). Không có receipt thì không có mốc để VERIFIED/ACCEPTED, dù code đang xanh.
2. **Cần một lượt live/DB tối thiểu cho câu SQL aggregate** (p50/p95 + `FILTER` + `::text` + `statement_timestamp`) — đây là phần **duy nhất** của 16b mà offline không thể chứng minh. Nếu chưa có DB window, ghi rõ acceptance đang thiếu đúng mục này.
3. **Chốt ngữ nghĩa `stale`**: server = truy vấn chậm > 30 s; UI = `stale || metricsFailed`. Hai nghĩa một nhãn — cần owner quyết (tách nhãn, hay định nghĩa lại).
4. **Harness trích-callback của 16a rất giòn**: nên bổ sung cảnh báo/ghi chú trong lease 16a rằng mọi binding ngoài `load` phải nằm trong danh sách inject, nếu không suite đỏ dù sản phẩm đúng.
5. **Hai receipt cũ còn treo một câu sai đã hết hiệu lực** (build FAIL ở `client.ts:385`). Nếu coordinator dùng receipt làm bằng chứng đóng task, nên ghi đính chính để tránh một lần nữa hoãn acceptance vì lý do không còn tồn tại.
6. **Không có browser/runtime evidence** cho cả hai packet: 16b (KPI + nhãn sample/stale) và 20b (bulk cancel trên UI thật) đều chỉ có offline. Offline pass **không** thay gate browser/live.
7. `docs/28`/`docs/35` chưa được cập nhật cho route `/api/v1/operations/metrics` và cho `from`/`to` của AWEB-20a (ngoài lease lượt này; chỉ ghi nhận).

---

## 6. Xác nhận

- Chỉ **đọc** + chạy lệnh; **không** sửa source/test/config/docs; **không** `git add`/commit/push; **không** tick gate nào.
- File duy nhất tôi tạo: receipt này + 9 log + `SHA256SUMS.txt` trong `coordination/reports/raw/verify-aweb-20b-2026-10-10/DSH2/`. `dist/` của admin-web bị **ghi đè bởi chính lệnh build** (gitignored, không phải thay đổi nguồn).
- Không dùng PostgreSQL/Redis, không claim DB window, không đọc `.env.live`.
- Receipt tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
- Mọi kết luận gắn sha256 tại §2/§3.2; cây đang di chuyển nên **đừng** suy diễn kết quả này sang revision khác.
