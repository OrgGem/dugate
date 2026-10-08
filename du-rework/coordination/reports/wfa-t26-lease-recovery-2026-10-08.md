# WFA-T26 — lease recovery: a fenced delivery must not cancel the connector invocation — 2026-10-08

**Task:** VERIFY-A + FIX WFA-T26 (`tests/workflow-api/http-worker.integration.test.ts:1187-1222`).
**Lane:** WFA-T26 only. **WFA-T27 (cancel semantics) is qwen_2's and is NOT touched or claimed here.**
**Không commit, không push, không tick VERIFIED/ACCEPTED, không sửa test e2e, không hand-edit `docs/21-openapi.json`.**
**Tree:** HEAD `df3f955e877fe87bd190461736c40861e2fe78d5`, working tree dirty (WFA lanes).
**Node:** v24.21.0 cho harness WFA (`%TEMP%\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe`), v22.23.3 cho jest/tsc package.
**Raw:** `coordination/reports/raw/wfa-t26-lease-recovery-2026-10-08/` (+ `RESULTS.txt`, `DIGESTS.txt`, `SHA256SUMS.txt`, `probe-ledger-poller.cjs`).

## 1. Bước 1 — FAIL-FIRST (không sửa gì)

```
cd D:/Git/dugate/du-rework
<node24> tests/workflow-api/run-jest.cjs wfa-t26-diag-NODE24.log tests/workflow-api/http-worker.integration.test.ts \
  -t "recovers an expired lease without repeating the completed provider stage"
```
**exit code 1** · `Test Suites: 1 failed` · `Tests: 1 failed, 14 skipped, 15 total` (8.711 s) — raw `step1-fail-first.log`, `step1-runner-receipt.log`.
Literal: `lease-recovered schema workflow failed with LEGACY_WORKFLOW_CONNECTOR_FAILED; provider calls=["generate_disbursement_report"]; taskRows=[{"task_key":"root","state":"FAILED","attempt":3,"lease_epoch":4,"error_code":"LEGACY_WORKFLOW_CONNECTOR_FAILED"}]`; stack `legacy-schema-runtime.ts:803:21`.
Worker log cùng run: `00:22:56.493 handler failed retryable=true retryAfterMs=5000` → `00:22:56.906 lease lost during heartbeat; aborting context` → `00:22:56.912 handler failed retryable=false` → `00:22:56.918 fail report fenced (LEASE_LOST)`.

## 2. Bước 2 — DIAGNOSIS (read-only) — nguyên nhân thật

Công cụ: `probe-ledger-poller.cjs` (chỉ SELECT) poll PG WFA `:55498` trong lúc test chạy → bắt được **cả** `tasks` **và** ledger `connector_invocations` (`step2-ledger-timeline.log`):

| Thời điểm | Sự kiện |
|---|---|
| 00:32:09.643 | TASK root `RUNNING` attempt=1/3 epoch=1 |
| 00:32:09.738 | INV `06087b9c-fe2` **IN_FLIGHT** (provider đang chạy, delay 1.5s) |
| 00:32:09.812 | TASK `READY` attempt=1/3 **epoch=2** ← sweep lease hết hạn |
| 00:32:09.990 | TASK `RETRY_PENDING` attempt=2/3 epoch=3, error `LEGACY_WORKFLOW_CONNECTOR_FAILED`, **due +5s** |
| **00:32:10.543** | INV `06087b9c-fe2` → **CANCELLED** (error `CANCELLED`) ← **ledger bị terminal hoá** |
| 00:32:15.208 | TASK `RUNNING` attempt=3/3 epoch=4 (đúng hẹn +5s) |
| — | TASK `FAILED` attempt=3/3 — replay một invocation đã CANCELLED |

Các run trước đó lặp y hệt (00:22:56.216→CANCELLED .917; 00:29:11→12; 00:30:01→02). Vậy: provider **chỉ được gọi 1 lần** (dedupe đúng), nhưng **ledger row bị chuyển CANCELLED ngay sau khi sweep**, và delivery được phục hồi chỉ có thể replay một invocation **terminal CANCELLED** → non-retryable → cháy hạn mức 3 attempt → workflow FAILED.

**Seam thật (file:line, trước fix):**
- `orchestrator/packages/worker-sdk/src/task-context.ts:346-349` — `abort(reason)` set `cancelFlag` cho 'cancel' nhưng gọi `this.abortController.abort()` **không kèm reason** ⇒ `signal.reason` luôn là AbortError, không ai phân biệt được lease-loss với cancel (dù `docs/16` và business code đã branch `ctx.signal.reason === 'cancel'`).
- `orchestrator/packages/worker-sdk/src/connector-invoker.ts:167-170` — `onAbort` gọi `notifyConnectorCancel()` cho **mọi** abort ⇒ lease loss gửi `POST /invocations/:id/cancel` (terminal) tới Connector.
- Phía Connector: `services/connector/src/services.ts:180-197` (`cancel` → `ledger.cancel` + `abortInFlightProviderDispatch`), `invoke.ts:106-109` (replay `IN_FLIGHT` = `INVOCATION_UNKNOWN`), `invoke.ts:103` (replay `CANCELLED` = non-retryable), wrap tại `legacy-schema-runtime.ts:800-820`.
- Vì sao attempt 2/3 vẫn đỏ: attempt 2 đua với provider đang chạy (IN_FLIGHT → INVOCATION_UNKNOWN, retryable, +5s) → attempt 3 replay row CANCELLED → hết budget → FAILED. **Đây không phải lỗi gọi lại provider.**

Không dùng suy đoán: kết luận CANCELLED đến từ ledger row thật + đúng mốc thời gian sweep.

## 3. Bước 3 — FIX (minimal, 2 dòng hành vi)

| File | Thay đổi |
|---|---|
| `packages/worker-sdk/src/task-context.ts:348` | `this.abortController.abort(reason);` — reason đi theo signal |
| `packages/worker-sdk/src/connector-invoker.ts:171` | `if (signal?.reason === 'cancel') notifyConnectorCancel();` — chỉ **cancel thật** mới terminal hoá invocation |

Không đụng `services/connector/**` (địa hạt T27), không đụng e2e test, không đụng document-core.

**Fail-first unit/offline test viết TRƯỚC khi sửa:** `packages/worker-sdk/tests/wfa-t26-lease-loss-abort.test.ts` (7 case, offline hoàn toàn, fetch double):
`step3-focused-red.log` — **exit 1, 5 failed / 2 passed**: `ctx.abort('lease-lost')` cho `signal.reason = {}`; lease-lost / pre-aborted / shutdown / no-reason đều POST `/cancel` (mong đợi 0). Hai case xanh sẵn là guard T27 (cancel thật vẫn POST cancel).
*(Lần chạy đầu của bước này lỗi `Cannot find module .../jest/bin/jest.js` do đường dẫn runner tôi gõ sai — đã xoá log đó và chạy lại đúng; không tính là đỏ sản phẩm.)*

## 4. Kết quả sau fix (command + exit code literal)

| # | Command (cwd) | Exit | Kết quả |
|---|---|---|---|
| 1 | `node node_modules/jest/bin/jest.js --runInBand --config jest.config.cjs tests/wfa-t26-lease-loss-abort.test.ts` (`packages/worker-sdk`) | **0** | **7 passed / 7** (`step3-focused-green.log`, `step11-focused-green-restored.log`) |
| 2 | `<node24> tests/workflow-api/run-jest.cjs … -t "recovers an expired lease…"` (`du-rework`) | **0** | **1 passed, 14 skipped** (`step12-final-focused.log`) |
| 3 | `<node24> tests/workflow-api/run-jest.cjs … http-worker.integration.test.ts` (full, không `-t`) | **0** | **15 passed / 15** — 3 lần liên tiếp (`step7-*`) + lần cuối (`step12-final-full.log`) |
| 4 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (`businesses/document-core`) | **0** | không output (`step8-document-core-tsc.log`) |
| 5 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (`packages/worker-sdk`) | **0** | không output (`step8-worker-sdk-tsc.log`) |
| 6 | `node node_modules/typescript/bin/tsc -p tsconfig.json` (`packages/worker-sdk`, **build dist**) | **0** | bắt buộc: harness resolve `@du/worker-sdk` → `dist/index.js`, không map src |
| 7 | jest `wfa-t7-abort-invoke.test.ts` + `r1-d-lifecycle-offline.test.ts` (`services/connector`) | **0** | 35 passed, 8 skipped — đường abort phía Connector còn nguyên |

**Ledger sau fix** (`step6-ledger-timeline-fixed.log`): INV `c12af5a6-729` **IN_FLIGHT 00:46:54.127 → SUCCEEDED 00:46:55.651** (không còn CANCELLED); TASK attempt1 → sweep → attempt2 `RETRY_PENDING` (+5s) → attempt3 → **SUCCEEDED**; provider vẫn **1 lần**.

**Bài học hạ tầng (ghi lại):** fix ở `src` **không** có tác dụng cho tới khi rebuild `dist` — lần chạy e2e ngay sau khi sửa src vẫn thấy CANCELLED (`step4-*`), sau rebuild mới xanh (`step6-*`).

## 5. Attribution — A/B có kiểm soát (không nhận công, không giấu đỏ)

Revert 2 sửa đổi trong `src` + rebuild dist (`step10-prefix-rebuild.log`, exit 0) rồi chạy lại; sau đó khôi phục **byte-exact** (hash khớp `cc8aca7e…c221` / `f56c6a3a…01e3`) và rebuild lại:

| Bộ | PRE-fix | POST-fix | Kết luận |
|---|---|---|---|
| `packages/worker-sdk` (full 34 suites) | 4 failed suites / **17 failed** / 707 passed | 3 failed suites / **12 failed** / 712 passed | **0 regression**; 5 test chỉ đỏ trước fix = đúng 5 case WFA-T26 của tôi |
| `businesses/document-core` (full 64 suites) | 8 failed suites / **11 failed** / 978 passed | y hệt | **pre-existing**, không liên quan thay đổi này |

**Đỏ pre-existing phải giữ nguyên trạng thái (KHÔNG do lane này):**
- worker-sdk: 10 case `connector-invoker.test.ts` (409 taxonomy / lost response / endpoint không resolve / timeout-signal), 1 case `classifyFailure`, 1 case `crypto-seam` byte-identity port — có **cả trước và sau** fix.
- document-core: `bullmq-smoke`, `package-boundary`, `sdk-consumer`, `manifest`, `missing-variants`, `legacy-workflow-mapping`, `p9-03-doc-compare-registration`, `worker.test.ts` — y hệt trước/sau.

## 6. WFA-T27 — KHÔNG claim

T27 đỏ trong receipt mục 5 (3/3 run: `Expected CANCELLED / Received FAILED`) và **xanh trong mọi run sau thay đổi của lane này** (3 lần full + lần cuối, đều 15/15). Trong khoảng thời gian đó **chỉ có** sửa đổi worker-sdk của lane này (`services/connector/src/{invoke,services}.ts` mtime 06:48 local, *trước* các run đỏ ~07:22 local), nên rất có thể T27 xanh là **tác dụng phụ** của cùng khiếm khuyết lease-loss-cancel. **Lane này không nhận T27**: chủ sở hữu (qwen_2) phải tự verify cancel semantics và tick theo gate của họ.

## 7. Giới hạn chưa cover

- Chưa chạy toàn monorepo, chưa chạy browser/deployment gate; chỉ WFA harness + 3 package liên quan.
- Harness WFA **không** cô lập schema cho Connector: `connectorIsolationContext.dbSchema` không được `CREATE SCHEMA`, nên ledger `connector_invocations` nằm ở **`public`** dùng chung (poller thấy hàng chục row của các run trước). Không sửa (ngoài phạm vi) — ghi để owner harness xử lý.
- 12 test worker-sdk + 11 test document-core đỏ pre-existing (§5) vẫn **đỏ**; không tick, không sửa.
- Fix phụ thuộc `dist` đã rebuild trong working tree (dist bị gitignore); ai build lại từ src sẽ có fix, nhưng harness hiện **không** map `@du/worker-sdk` → src.

## 8. Artifact & digest

- Sửa: `packages/worker-sdk/src/connector-invoker.ts` (`cc8aca7e…c221`), `packages/worker-sdk/src/task-context.ts` (`f56c6a3a…01e3`); dist rebuild (`dist/connector-invoker.js c6886882…e5f2`, `dist/task-context.js 91275a89…338f`).
- Test mới: `packages/worker-sdk/tests/wfa-t26-lease-loss-abort.test.ts` (`ab7b4370…9932`).
- Không sửa: `tests/workflow-api/http-worker.integration.test.ts` (`b52aa970…fe5a`, mtime 02:58 không đổi), `services/connector/src/{invoke,services}.ts`, `businesses/document-core/src/**`, `docs/21-openapi.json`.
- Raw: `coordination/reports/raw/wfa-t26-lease-recovery-2026-10-08/` — fail-first, ledger timeline trước/sau, focused red/green, 3 full run, A/B pre-fix, typecheck, regression, `RESULTS.txt`, `DIGESTS.txt`, `SHA256SUMS.txt`, poller script.
