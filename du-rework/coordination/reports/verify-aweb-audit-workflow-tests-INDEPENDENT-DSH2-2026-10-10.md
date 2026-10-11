# Verify độc lập (DSH2) — hai suite mới: audit event links + workflow simulation honesty — 2026-10-10

**Vai trò:** Independent Verifier (DSH2). Lease **READ-ONLY** trên `orchestrator/apps/admin-web/tests/audit-event-links.test.mjs`, `tests/workflow-simulation-honesty.test.mjs` và hai màn hình mà chúng trích helper (`features/audit/audit-screen.tsx`, `features/workflows/workflows-screen.tsx`).
**Ràng buộc đã tuân thủ:** chỉ đọc + chạy test **offline**; **KHÔNG** sửa source/test/config/docs; **KHÔNG** `git add`/commit/push; **KHÔNG** tick gate; **KHÔNG** DB/Redis/mạng ngoài.
**Repo:** `D:/Git/dugate/du-rework` · **HEAD** `d0b22104e3f9fcda095bc75c9588fac8afac38f3` · **Node** v24.21.0 (temp unzip, đúng `engines`).
**Raw:** `coordination/reports/raw/verify-aweb-audit-workflow-tests-2026-10-10/DSH2/` — `01-both-suites.log`, `02-audit-event-links.log`, `02-workflow-simulation-honesty.log`, `03-dsh2-probe.log`, `04-dsh2-probe.cjs`, `SHA256SUMS.txt`.
**Receipt được kiểm:** `receipt-aweb-audit-links-unit-test-2026-10-10.md` · `receipt-aweb-workflow-simulation-test-2026-10-10.md`.

---

## 0. Kết luận ngắn

| Hạng mục | Verdict |
|---|---|
| `audit-event-links.test.mjs` | **5/5 PASS, exit 0** — `tests 5 · pass 5 · fail 0 · skipped 0 · todo 0` (khớp receipt) |
| `workflow-simulation-honesty.test.mjs` | **5/5 PASS, exit 0** — `tests 5 · pass 5 · fail 0 · skipped 0 · todo 0` (khớp receipt) |
| Chạy gộp hai suite | **10/10 PASS**, exit 0, `suites 2` |
| Assertion có load-bearing? | **CÓ** — audit: trích + **thực thi** `safeQueryValue`/`auditEventLinks`, có guard chống bỏ sót + guard diagnostics; workflow: 3 finder **assert là tìm thấy** biểu thức thật, rồi **render JSX thật** bằng `react-dom/server` (không so chuỗi) |
| Không skip/only/todo | **ĐÚNG** — 0 hit ở cả hai suite; reporter báo `skipped 0`, `todo 0` |
| Nguồn GAP của receipt audit | **XÁC NHẬN** — `verify-aweb-batch-audit-sim-metrics-INDEPENDENT-DSH-2026-10-10.md` §4 GAP 1 đúng là '`auditEventLinks` vẫn không có unit test' |
| Claim '0 ký tự nháy kép' của receipt workflow | **ĐÚNG** — đếm trên file receipt: 0 |
| Probe độc lập của tôi (input riêng, extractor riêng) | **11/11 PASS**, exit 0 |

**Một dòng cho coordinator:** cả hai suite **đạt verify độc lập** — 5/5 + 5/5 exit 0 đúng như receipt, assertion thực thi/render thật (không vacuous), GAP 1 có thật và đã được đóng; chỉ còn giới hạn đã biết: **không có browser/Playwright** nên phần render link trong JSX của màn Audit và hành vi mở URL trực tiếp vẫn chưa được chứng minh.

---

## 1. Bằng chứng chạy

| # | Lệnh (cwd `apps/admin-web`) | Exit | Literal |
|---|---|---:|---|
| 1 | `node --test tests/audit-event-links.test.mjs tests/workflow-simulation-honesty.test.mjs` | **0** | `✔ audit event deep links` · `✔ workflow simulation honesty` · `ℹ tests 10` · `ℹ suites 2` · `ℹ pass 10` · `ℹ fail 0` |
| 2 | `node --test tests/audit-event-links.test.mjs` | **0** | `ℹ tests 5` · `ℹ pass 5` · `ℹ fail 0` · `skipped 0` · `todo 0` |
| 3 | `node --test tests/workflow-simulation-honesty.test.mjs` | **0** | `ℹ tests 5` · `ℹ pass 5` · `ℹ fail 0` · `skipped 0` · `todo 0` |
| 4 | probe độc lập DSH2 (`04-dsh2-probe.cjs`) | **0** | `PROBE_RESULT 11/11 checks passed` |

Artifact đã kiểm (mọi file liên quan đều `??` untracked ⇒ provenance bằng sha256):

| File | sha256 | mtime | lines |
|---|---|---|---|
| `tests/audit-event-links.test.mjs` | `ad7c58c6cac41d8cda1f4a2ed74c99383b5c0e6c2da91b50c27e22a1ac65ef2a` | 23:22:02 | 78 |
| `tests/workflow-simulation-honesty.test.mjs` | `4acf1df1b4c8387419338513abbe34af18e20effb0ba67472d869d216ffec62c` | 23:22:43 | 146 |
| `src/features/audit/audit-screen.tsx` | `54ce19a63a331ce4252f48681e77ad52410006370773379bd7f8181d3b72afb5` | 23:05:02 | 488 |
| `src/features/workflows/workflows-screen.tsx` | `7797884b04e28f3c08c315004cf2372974ca400808369efeda5cb17ad3f991dc` | 23:14:46 | 1216 (` M`) |

---

## 2. Đối chiếu receipt `audit-links-unit-test`

| # | Claim | Verdict | Bằng chứng |
|---|---|---|---|
| 1 | Đóng **GAP 1 §4 bullet 1** của review DSH2 audit/sim metrics | **ĐÚNG** | Review đó (`verify-aweb-batch-audit-sim-metrics-INDEPENDENT-DSH-2026-10-10.md` §4 dòng 43) đúng là nêu '`auditEventLinks` vẫn không có unit test' |
| 2 | Suite standalone offline tại `tests/audit-event-links.test.mjs` | **ĐÚNG** | file tồn tại, 78 dòng, không import dịch vụ ngoài |
| 3 | **Trích và thực thi** `safeQueryValue` + `auditEventLinks` từ Audit screen qua TS AST | **ĐÚNG** | `extractDeclarations` (`:6-22`) + `loadAuditEventLinks` (`:24-36`) trả về **hàm thật** rồi gọi trong từng test |
| 4 | Phủ: operation → Trace; resource hợp lệ khác → chỉ Audit; trim + encode ký tự đặc biệt; resource rỗng/không hợp lệ → null; operationId vượt giới hạn → giữ Audit | **ĐÚNG, đủ 5 nhóm** | test `:43-48`, `:50-55`, `:57-62`, `:64-68`, `:70-77` |
| 5 | `node --test …` pass 5 test, exit 0 | **ĐÚNG** | lệnh #2 |
| 6 | Không stage/commit/push | **ĐÚNG** | file vẫn `??`; không có gì staged |

**Bổ sung ranh giới của tôi (probe L1–L6)** — các điểm suite của tác giả chưa phủ:
- tiền tố **không phân biệt hoa/thường** và **giữ nguyên case** của giá trị (`OPERATION:Op-9` → `/trace?operationId=Op-9`) — L2;
- giới hạn operationId **bao gồm** đúng 64 và **loại** 65 (suite chỉ kiểm 65) — L3;
- giới hạn resource **bao gồm** 128 và **loại** 129 — L4;
- `operation:` **trần** (không có id) vẫn giữ **link Audit**, chỉ mất link Trace — L5 (đây là hành vi đúng: resource vẫn là filter hợp lệ);
- link luôn **query-safe**: không có `#`/space thô, và **không bao giờ** sinh `/operations?id=` (đúng ghi chú thiết kế trong source) — L6.

---

## 3. Đối chiếu receipt `workflow-simulation-test`

| # | Claim | Verdict | Bằng chứng |
|---|---|---|---|
| 1 | Thêm `tests/workflow-simulation-honesty.test.mjs` | **ĐÚNG** | file tồn tại, 146 dòng |
| 2 | Suite **đánh giá payload kết quả simulation hiện tại** | **ĐÚNG** | `findSimulationResultPayload` (`:12-33`) trích **object literal thật** từ nhánh `testSource === 'simulation'`, rồi `new Function` dựng lại object (`:72-79`) |
| 3 | **Render JSX stage-result** cho 3 trường hợp populated / empty / backend | **ĐÚNG** | `renderStagePanel` (`:81-95`) transpile với `jsx: React` rồi `renderToStaticMarkup` — **render thật**, không so chuỗi nguồn |
| 4 | Kiểm **stage-count fallback** khi stages rỗng/thiếu | **ĐÚNG** | `findWorkflowStageCountExpression` (`:53-66`) + `workflowStageCount` (`:97-99`), 4 fixture (`:140-145`) |
| 5 | Stages rỗng ⇒ thông điệp configuration-gap nói **không stage nào chạy** và **không phải một run pass** | **ĐÚNG** | test `:123-130`: `/No stages defined for this workflow\./`, `/no stage ran/`, `/configuration gap, not a passing run/`, và **phủ định** `/Stages walked by this simulation/` |
| 6 | Stage count thiếu ⇒ **0** (không phải 1) | **ĐÚNG** | test `:140-145`; probe W4 thêm fixture `nodesCount: 0` (0 phải thắng `stages.length`) |
| 7 | PASS, 5 test, 1 suite, 0 fail, exit 0 | **ĐÚNG** | lệnh #3 |
| 8 | Receipt tự quét **0 nháy kép** | **ĐÚNG** | đếm trên chính file receipt: 0 |
| 9 | Không git add/commit/push | **ĐÚNG** | file vẫn `??` |

**Kiểm 'honesty' ở tầng sản phẩm (độc lập):** `sim-op` **không còn** xuất hiện trong `workflows-screen.tsx`; payload simulation **không có** khoá `operationId`; `operationId` chỉ được **chuyển tiếp** khi backend thật trả về (`:448`, `:456` — `typeof responseData.operationId === 'string' ? … : undefined`) ⇒ lỗi AWEB-17 (bịa id) không tái phát; probe W1 khẳng định cả ba điều.

---

## 4. Tính load-bearing của hai suite

| Suite | Cơ chế bảo đảm không 'xanh rỗng' |
|---|---|
| audit links | `assert.deepEqual([...remaining], [], …)` ⇒ thiếu/đổi tên helper là **đỏ ngay**; assert **0 error diagnostics** sau transpile; helper được **gọi thật** và so `deepEqual` cả object `{audit, trace}` |
| workflow simulation | **3 finder** mỗi cái `assert.ok(...)` là **đã tìm thấy** biểu thức thật (payload, panel, stage-count) ⇒ đổi cấu trúc là đỏ; assert **0 error diagnostics**; payload được **dựng lại và đọc field**; panel được **render thật** rồi assert văn bản (gồm cả **phủ định**, phân biệt 3 nhánh); stage-count chạy 4–7 fixture |

Cả hai: **0** `.skip/.only/xit/xdescribe/todo(`; reporter báo `skipped 0`, `todo 0`.

---

## 5. Probe độc lập — 11/11 (extractor riêng, input riêng)

Tôi tự viết finder/extractor (không sao chép code của suite) và dùng input của mình:

| # | Kiểm | Kết quả |
|---|---|---|
| L1 | operation → cả hai link; resource khác → **không** bịa link Trace | ok |
| L2 | tiền tố không phân biệt hoa/thường, giá trị giữ nguyên case | ok |
| L3 | giới hạn operationId: 64 giữ, 65 mất Trace nhưng **giữ Audit** | ok |
| L4 | giới hạn resource: 128 giữ, 129 → cả hai null | ok |
| L5 | rỗng/khoảng trắng/control char → null; `operation:` trần → chỉ Audit | ok |
| L6 | encode query-safe (không `#`/space thô), không sinh `/operations` | ok |
| W1 | payload tự nhãn `SIMULATED_SUCCESS` + `dataSource: 'simulation'`, **không** `operationId`, **không** `sim-op` | ok |
| W2 | stages `undefined`/`null`/`[]` → `[]` | ok |
| W3 | render 3 nhánh **tách biệt** (populated / simulation rỗng / backend rỗng) bằng assert dương **và** phủ định | ok |
| W4 | stage-count: `{stages:[]}`→0, `{}`→0, `{nodesCount:0,…}`→**0**, `{nodesCount:null,stages:[a,b]}`→2, `{nodesCount:4,…}`→4 | ok |
| M1 | mỗi suite có guard fail-loud riêng; không skip/only/todo; panel được render thật | ok |

---

## 6. Ghi chú & open items

1. **Giới hạn đã biết (không phải lỗi của hai suite):** không có browser/Playwright ⇒ (a) phần **render link trong JSX** của màn Audit (`audit-screen.tsx:469`, `:471`) chỉ được chứng minh ở mức **helper**; (b) hành vi **mở URL trực tiếp** trên trình duyệt và tính honesty của màn simulation trên UI thật **chưa** được chứng minh. Đúng như review DSH trước đã nêu.
2. **Một case nên bổ sung (tuỳ chọn):** `operation:` trần — hiện giữ link Audit và mất link Trace; hành vi đúng nhưng chưa được pin bởi suite nào. Tôi đã pin trong probe; nếu muốn, owner thêm 1 assertion.
3. **Mọi file `??` untracked** ⇒ không có `git diff`/blame; kết luận gắn sha256 tại §1. `workflows-screen.tsx` thì ` M` (1216 dòng, mtime 23:14:46).
4. **Context build:** `npm run typecheck` của admin-web hiện **exit 0** (điểm `TS6133` unused `Link` đã được đóng ở lượt trước) — hai suite này không làm thay đổi trạng thái đó.
5. **Không có assertion nào bị nới:** cả hai suite là **file mới** (`??`), không sửa file test cũ; diff so với cây là 'thêm mới' chứ không phải 'nới'.

---

## 7. Xác nhận

- Chỉ **đọc** + chạy `node --test`/probe offline; **không** sửa source/test/config/docs; **không** `git add`/commit/push; **không** tick gate.
- File tôi tạo: receipt này + 5 file raw trong `coordination/reports/raw/verify-aweb-audit-workflow-tests-2026-10-10/DSH2/` (kèm `SHA256SUMS.txt`). Probe chạy trong `%TEMP%`, nạp source TSX thật; không bind cổng, không mạng.
- Không DB/Redis, không claim DB window, không đọc `.env.live`.
- Ghi chú trung thực: probe của tôi có **2 FAIL ở lượt đầu**, cả hai do **kỳ vọng sai của tôi** — (a) tôi tưởng `operation:` trần phải null cả hai link (thực tế giữ Audit, đúng thiết kế); (b) tôi áp guard `remaining` của suite audit cho suite workflow (suite này guard bằng 3 `assert.ok` của finder). Đã sửa **probe**, không đụng sản phẩm; sau đó **11/11**.
- Receipt tự quét: **0 ký tự nháy kép**, **0 dòng trailing whitespace**.
