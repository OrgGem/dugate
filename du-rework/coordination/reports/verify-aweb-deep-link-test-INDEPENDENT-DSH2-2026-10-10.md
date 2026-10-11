# Verify độc lập (DSH2) — AWEB deep-link query hydration test suite — 2026-10-10

**Vai trò:** Independent Verifier (DSH2). Lease **READ-ONLY** trên `orchestrator/apps/admin-web/tests/deep-link-query-hydration.test.mjs` + hai màn hình mà nó trích helper (`features/trace/trace-screen.tsx`, `features/audit/audit-screen.tsx`).
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test/typecheck **offline**; **KHÔNG** sửa source/test/config/docs; **KHÔNG** `git add`/commit/push; **KHÔNG** tick gate; **KHÔNG** DB/Redis/mạng ngoài.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v24.21.0 (temp unzip, đúng `engines`).
**Raw:** `coordination/reports/raw/verify-aweb-deep-link-test-2026-10-10/DSH2/` — `01-node-test.log` (bản 4 test), `02-typecheck-strict.log`, `03-typecheck-loose.log`, `04-dsh2-probe.log`, `05-verbose.log`, `06-node-test-current.log` (bản 8 test), `07-dsh2-probe.cjs`, `SHA256SUMS.txt`.
**Receipt được kiểm:** `coordination/reports/receipt-aweb-deep-link-test-2026-10-10.md`.

---

## 0. Kết luận ngắn

| Hạng mục | Verdict |
|---|---|
| `node --test tests/deep-link-query-hydration.test.mjs` | **PASS, exit 0** — bản receipt mô tả: `tests 4 · suites 1 · pass 4 · fail 0`; **bản hiện tại (đã được mở rộng giữa lượt verify): `tests 8 · pass 8 · fail 0`** |
| Assertion hydration có load-bearing không? | **CÓ** — helper được **trích bằng TS parser rồi thực thi thật** (không so chuỗi), có **guard chống bỏ sót** (`remaining` phải rỗng), có **assert diagnostics rỗng**, và các test mới còn **thực thi biểu thức guard thật** của cả hai màn hình |
| `npm run typecheck` (strict) | **exit 0** — receipt ghi exit 1 vì TS6133 unused `Link` tại `audit-screen.tsx:3`; hiện `Link` **đã được dùng** ở `:469` và `:471` ⇒ **điểm chặn đã hết hiệu lực** |
| `npm run typecheck -- --noUnusedLocals false` | **exit 0** — đúng như receipt |
| Probe độc lập của tôi (input riêng, extractor riêng) | **12/12 PASS**, exit 0 |
| Không có skip/only/todo | **ĐÚNG** — 0 hit trong suite |
| Rủi ro còn lại | Không có runtime React/browser; phần 'wiring' dựa trên **regex nguồn** + thực thi biểu thức guard (§5) |

**Một dòng cho coordinator:** suite deep-link **đạt verify độc lập** — 8/8 (và 4/4 trên bản receipt mô tả) exit 0, assertion thực sự thực thi helper + guard của màn hình, probe độc lập 12/12; hai điểm cần đính chính: receipt ghi **4 test** (nay **8**, file được mở rộng lúc `23:13:49`) và **typecheck exit 1** (nay **exit 0** — `Link` đã được dùng).

---

## 1. Bằng chứng chạy

| # | Lệnh (cwd) | Exit | Literal |
|---|---|---:|---|
| 1 | `node --test tests/deep-link-query-hydration.test.mjs` (`apps/admin-web`) — bản **155 dòng / 4 test** (sha `…` xem §1.1) | **0** | `✔ Trace and Audit URL query hydration` · `ℹ tests 4` · `ℹ suites 1` · `ℹ pass 4` · `ℹ fail 0` |
| 2 | y hệt, bản **hiện tại 278 dòng / 8 test** | **0** | `ℹ tests 8` · `ℹ suites 1` · `ℹ pass 8` · `ℹ fail 0` · `duration_ms 368.8` |
| 3 | `node --test --test-reporter=spec …` (bắt tên từng test) | **0** | 8 dòng `✔` (liệt kê §1.2) |
| 4 | `npm run typecheck` (`tsc --noEmit -p tsconfig.json`) | **0** | 0 dòng output |
| 5 | `npm run typecheck -- --noUnusedLocals false` | **0** | 0 dòng output |
| 6 | probe độc lập DSH2 (`07-dsh2-probe.cjs`) | **0** | `PROBE_RESULT 12/12 checks passed` |

### 1.1 Artifact (provenance bằng sha256 — mọi file đều `??` untracked)

| File | sha256 | mtime | lines |
|---|---|---|---|
| `tests/deep-link-query-hydration.test.mjs` (**hiện tại**) | `b146b462e1a6bffc5ad71eeb681c1bcc3c04061be8531f52c780883951912ffa` | 23:13:49 | 278 |
| `src/features/trace/trace-screen.tsx` | `7c7c33560dc29ac79a40a57acecbbc0c6039d8b0fd18120ec9ffb87a4c76ad08` | 22:59:35 | 396 |
| `src/features/audit/audit-screen.tsx` | `54ce19a63a331ce4252f48681e77ad52410006370773379bd7f8181d3b72afb5` | 23:05:02 | 488 |
| `src/features/trace/state.ts` | `9e2b3db07362eedcfdfc7e878b1b8bb092ecd9c09b0f101990a256eb8b0f9b50` | 21:09:31 | 373 |
| `src/features/audit/state.ts` | `6c99b75fdcb53f7903d8e36a5ec0a85ca2db4bc26fee2d97246117950e27786a` | 20:24:43 | 144 |

### 1.2 Tám test của bản hiện tại (đều `✔`)
1. `hydrates each supported Trace identifier and preserves the lookup priority`
2. `uses safe defaults when Trace and Audit query parameters are missing`
3. `reads Trace tenantId safely and retains its session tenant authorization fence`
4. `blocks malformed and unavailable tenant context in both screens`
5. `maps Audit query filters, operationId resource fallback, and UTC time bounds`
6. `ignores malformed and overlong UTC time bounds instead of hydrating them`
7. `round-trips encoded special characters in Trace IDs and Audit filters`
8. `wires Audit hydration and tenant scoping to the URL while retaining correlationId`

---

## 2. Đối chiếu receipt từng claim

| # | Claim | Verdict | Bằng chứng |
|---|---|---|---|
| 1 | Thêm suite offline `node:test` **thực thi helper hydration thật** sau khi trích bằng TS parser | **ĐÚNG** | `extractDeclarations` (`:8-25`) + `loadHelpers` (`:27-44`); helper được gọi thật và so `deepEqual` trên cả object kết quả |
| 2 | Kiểm Trace operation/correlation/task | **ĐÚNG** | test 1 (`:108-122`) |
| 3 | Kiểm parse `tenantId` + fence phiên tenant | **ĐÚNG** | test 3 (`:144-156`): `safeQueryValue` + 5 regex wiring (đều khớp code thật, §4) |
| 4 | Kiểm Audit correlation/tenant | **ĐÚNG** | test 5 (`:204-205`), test 8 (`:269-270`) |
| 5 | Kiểm map filter, fallback `operationId` → resource, ưu tiên `resource` tường minh | **ĐÚNG** | test 5 (`:206-225`) |
| 6 | Kiểm hydration bound UTC | **ĐÚNG** | test 5 (`:216-220`) + test 6 (`:228-242`, 4 giá trị hỏng) |
| 7 | Assertion wiring: URL đầu **và** URL đổi đều dùng helper | **ĐÚNG** | trace `:154-155`, audit `:271-272` — khớp code thật `trace-screen.tsx:85,106` và `audit-screen.tsx:154,180` |
| 8 | `node --test …` PASS exit 0, **4 tests, 1 suite** | **ĐÚNG tại thời điểm receipt** — nay **8 tests** | §1 (2 lượt chạy, cùng exit 0) |
| 9 | `npm run typecheck` exit 1 vì TS6133 unused `Link` (`audit-screen.tsx:3`) | **KHÔNG TÁI HIỆN ĐƯỢC (đã hết hiệu lực)** | `Link` nay được dùng ở `:469`, `:471`; file mtime 23:05:02; `npm run typecheck` → **exit 0**, 0 diagnostics |
| 10 | `npm run typecheck -- --noUnusedLocals false` PASS exit 0 | **ĐÚNG** | lệnh #5 |
| 11 | Không dùng dịch vụ ngoài; không stage/commit/push | **ĐÚNG** | mọi lệnh offline; file vẫn `??`, không có gì staged |

---

## 3. Audit assertion hydration — có thật, không vacuous

| Cơ chế | Vì sao đáng tin |
|---|---|
| **Guard chống bỏ sót** (`:23`) | `assert.deepEqual([...remaining], [])` — nếu ai đổi tên/xoá helper, suite **đỏ ngay** thay vì lặng lẽ bỏ qua; probe M1 xác nhận **cả 7 khai báo** còn tồn tại |
| **Guard biên dịch** (`:35-36`) | `reportDiagnostics: true` + assert **0 error** — code trích ra phải transpile sạch |
| **Thực thi thật** | Helper chạy với input thật rồi `deepEqual` cả object (`{kind, value, error}` / `{draft, filters}`) — không phải so chuỗi |
| **Guard biến/điều kiện** (test 4, `:46-78`) | `getVariableInitializer` và `getTenantAvailabilityGuard` **assert là tìm thấy**, rồi `evaluateExpression` **chạy chính biểu thức thật** của màn hình với binding tổng hợp; có **negative control** (tenant trong phiên → `false`) ⇒ chứng minh guard chặn đúng chứ không phải 'luôn true' |
| **Regex wiring** | 11 regex nguồn (5 trace + 6 audit) — tôi đối chiếu từng cái với code thật: trace `:85, :86, :87, :106, :127, :132`; audit `:154, :156, :157, :180, :200, :231` — tất cả là **code thật**, không nằm trong comment |
| **Không skip** | 0 hit `.skip/.only/xit/xdescribe/todo(`; jest/node reporter báo `skipped 0`, `todo 0` |

---

## 4. Probe độc lập của tôi — 12/12 (extractor riêng, input riêng)

Tôi tự viết extractor (tách `names` cần trích khỏi `returnNames` cần trả về, vì interface bị xoá khi transpile) và dùng **input của mình**, không lặp lại 8 test của tác giả:

| # | Kiểm | Kết quả |
|---|---|---|
| T1 | Ưu tiên khi có **cả ba** định danh: `operationId` > `correlationId` > `taskId` | ok |
| T2 | Ứng viên **rỗng/khoảng trắng** thì **rơi xuống** ứng viên kế | ok |
| T3 | Ứng viên **không hợp lệ** thì **báo lỗi và KHÔNG rơi xuống** (`operationId=bad%0Avalue&taskId=task-39` → `kind=operationId`, `value=''`, có error) | ok — đây là ngữ nghĩa tinh tế mà bộ test của tác giả không phủ |
| T4 | Không có định danh nào → `{kind:'operationId', value:'', error:null}` | ok |
| T5 | `safeQueryValue`: trim, **200 nhận / 201 từ chối**, control char, rỗng, khoảng trắng, `null` | ok (8 case) |
| A1 | `severity` không phân biệt hoa/thường; giá trị lạ → `ALL` | ok |
| A2 | `sort` chỉ nhận 2 giá trị đã công bố; `limit` chỉ nhận 25/50/100/200, còn lại → 50 | ok (2 + 4 + 4 case) |
| A3 | Ưu tiên resource: tường minh > fallback `operation:…` > rỗng; `operationId` chứa control char **không** thành resource | ok |
| A4 | Bound UTC round-trip **chính xác** qua `localDateTimeToUtc`; 4 input hỏng/rỗng → chuỗi rỗng | ok |
| A5 | Query rỗng → đúng defaults của màn hình; `safeQueryValue` audit cap **128** | ok |
| M1 | Cả 7 khai báo suite trích vẫn tồn tại (extractor của tôi ném lỗi nếu thiếu) | ok |
| M2 | Suite không có skip/only/todo; có guard missing-declaration + diagnostics | ok |

---

## 5. GAP / open items

1. **Không có runtime React/browser**: suite chạy helper + biểu thức guard ở mức module; hành vi thật của `useEffect`/`useSearchParams` (thứ tự hydrate, đổi URL khi đang mở) **chưa** được chứng minh. Đây là giới hạn đã biết của cả hai lượt (test + verify).
2. **Regex wiring là mức yếu nhất**: một thay đổi ngữ nghĩa vẫn giữ nguyên chuỗi (ví dụ thêm `return` sớm trước lời gọi) sẽ không bị bắt. Riêng guard tenant đã được mitigate bằng `evaluateExpression`, nhưng các regex khác thì chưa.
3. **Receipt đã cũ ở hai điểm**: số test (4 → **8**) và typecheck (exit 1 → **exit 0**). Cả hai đều là tiến triển, không phải falsehood tại thời điểm ghi, nhưng nên đính chính để coordinator không hoãn acceptance vì một chặn đã hết.
4. **Mọi file liên quan `??` (untracked)** ⇒ provenance chỉ bằng sha256, không có `git diff`/blame; kết luận gắn revision tại §1.1.
5. **Suite đọc source theo đường dẫn tương đối** (`new URL('../src/...', import.meta.url)`) ⇒ nếu di chuyển file màn hình, suite đỏ (fail loud) — chấp nhận được, chỉ cần biết khi refactor.
6. **Suite mở rộng giữa lượt verify** (23:13:49) — nếu coordinator muốn chốt acceptance, nên yêu cầu owner ghi receipt bổ sung cho 4 test mới (test 2, 4, 6, 7) vì receipt hiện tại chỉ mô tả bản 4 test.

---

## 6. Xác nhận

- Chỉ **đọc** + chạy `node --test`/`tsc`/probe offline; **không** sửa source/test/config/docs; **không** `git add`/commit/push; **không** tick gate.
- File tôi tạo: receipt này + 7 file raw trong `coordination/reports/raw/verify-aweb-deep-link-test-2026-10-10/DSH2/` (kèm `SHA256SUMS.txt`). Probe chạy trong `%TEMP%`; không bind cổng, không mạng.
- Không DB/Redis, không claim DB window, không đọc `.env.live`.
- Ghi chú trung thực: probe của tôi có **1 lần lỗi runtime ở lượt chạy đầu** do chính extractor của tôi trả về cả **interface** (bị xoá khi transpile) — đã sửa **probe** (tách `returnNames`), không đụng sản phẩm; sau đó **12/12**.
- Receipt tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
