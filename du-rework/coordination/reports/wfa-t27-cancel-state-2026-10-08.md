# WFA-T27 cancel semantics — CANCEL_REQUESTED không bị failTask ghi đè thành FAILED

- Task: WFA-T27 (chỉ cancel semantics; WFA-T26 thuộc lease khác — KHÔNG đụng).
- Receipt: `coordination/reports/wfa-t27-cancel-state-2026-10-08.md`; raw logs: `coordination/reports/raw/wfa-t27-cancel-2026-10-08/01..07`.
- Trạng thái: **ĐÃ FIX + xanh (e2e 3 lần liên tiếp exit 0)**. Không commit, không push, không tick VERIFIED/ACCEPTED, không sửa e2e test để làm xanh, không hand-edit `docs/21-openapi.json`.

## RESUME POINT

- Mục tiêu: sau cancel (202/200) + provider abort, operation phải kết thúc **CANCELLED** — trước đây về **FAILED**.
- Nguyên nhân gốc (read-only, bước 2): legacy cancel khi worker còn lease active chỉ ghi `CANCEL_REQUESTED` + `cancel_requested=true` (`compat/legacy-host-adapter.ts:274-279`, fallback `:294-300`); **không tồn tại transition CANCEL_REQUESTED→CANCELLED nào được gọi** cho tới khi worker report. Worker abort → handler ném `LEGACY_WORKFLOW_CONNECTOR_FAILED` (retryable false, log `00:22:31.655`) → `runtime.failTask` (runtime.ts) ghi `UPDATE tasks SET state='FAILED'` (:1014) và `UPDATE operations SET state='FAILED'` **không guard cancel_requested** (:1028) ⇒ đè mất cancel đã được trả 200.
- Fix (bước 3, minimal): `services/orchestrator/src/modules/runtime/runtime.ts` — trong `failTask`: (1) SELECT thêm `o.cancel_requested, o.state AS op_state`; (2) new branch trước retry-branch: `hasCancelSignal(...)` → UPDATE task CANCELLED (CAS cùng lease/epoch/business như nhánh FAILED), UPDATE operation CANCELLED (+state_version), `maybeScheduleWebhook`, trả `{state:'CANCELLED', operationState:'CANCELLED'}` — một cancel đã được ack thắng cả retry (không RETRY_PENDING, không outbox retry).
- Chưa cover (nêu thẳng): không close human_waits/webhook parity cho nhánh này (RUNNING task không có open wait); `hasCancelSignal` false vẫn ghi FAILED (test guard); registry/cancel ở tầng connector service đã land ở task trước (`wfa-t7-layer-abort-2026-10-08.md`).

## 1. Bước 1 — FAIL-FIRST e2e (chạy nguyên bản, không sửa gì)

```
cd D:/Git/dugate/du-rework
node <node24>/node.exe tests/workflow-api/run-jest.cjs wfa-t27-diag-NODE24.log tests/workflow-api/http-worker.integration.test.ts -t "cancels an operation while a provider stage is in flight"
```

- Node v24.21.0; `exit: 1` (log `04-e2e-red-reproduce.log`).
- Assertion đỏ **tại `http-worker.integration.test.ts:1245`**: `Expected: "CANCELLED" / Received: "FAILED"`; `:1243` (chờ provider abort) **đã PASS** ⇒ layer-3 abort hoạt động, lỗi là SEMANTIC terminal state.
- Worker log trong cùng file: `errorCode: LEGACY_WORKFLOW_CONNECTOR_FAILED, retryable:false, service: worker:document-core`, `00:22:31.655`.
- Lưu ý harness: `-t` nhiều từ bị cmd tách (pattern hiển thị `...|an|operation|...`), các lần chạy đỏ và xanh dùng cùng kiểu lệnh nên so sánh trực tiếp được; các lần chạy sạch sau dùng `-t WFA-T27` (không space).

## 2. Bước 2 — chẩn đoán read-only (file:line seam)

| Đường | File:line | Kết luận |
|---|---|---|
| Legacy cancel, worker còn lease | `compat/legacy-host-adapter.ts:274-279` (fallback `:294-300`) | ghi `state='CANCEL_REQUESTED', cancel_requested=true`, **không** ghi CANCELLED, trả 200 |
| Canonical cancel | `modules/lifecycle/lifecycle.ts:48-56` | ghi CANCELLED ngay + cancel tasks + close waits (không đi đường này vì worker active) |
| Worker | `packages/worker-sdk/src/worker.ts:373` heartbeat → `ctx.abort('cancel')`; catch → `classifyFailure` → `runtime.failTask` | report failure bình thường cho một cancel |
| Executor wrap | `businesses/document-core/.../legacy-schema-runtime.ts` (catch quanh `context.connector.invoke`) | `CANCELLED` (409) bị wrap thành `LEGACY_WORKFLOW_CONNECTOR_FAILED`, retryable false |
| **SEAM** | `modules/runtime/runtime.ts` `failTask`: UPDATE tasks `state='FAILED'` (:1014) + UPDATE operations `state='FAILED'` (:1028), **không có predicate cancel** | chính chỗ này ghi đè `CANCEL_REQUESTED` → `FAILED` |
| Sweeper | `lifecycle.ts:76-109` (`sweepDeadlines`) | chỉ TIMED_OUT — không có sweeper CANCEL_REQUESTED→CANCELLED |

⇒ Nguyên nhân thật: failTask không biết một cancel đã được chấp nhận; không phải do layer 1/2/3 abort.

## 3. Bước 3 — FAIL-FIRST unit trước khi sửa product

- Test mới `services/orchestrator/tests/wfa-t27-cancel-ack.test.ts` (offline, fake Db theo mẫu `runtime-lease-fencing-offline.test.ts`): fixture mô phỏng đúng trạng thái thật (`tasks.state='RUNNING'` + `op cancel_requested=true / op_state='CANCEL_REQUESTED'`).
- **RED (log `01-unit-fail-first-RED.log`, Exit Code: 1)**: 2 test đỏ đúng kỳ vọng — `FAILED/FAILED` thay vì `CANCELLED/CANCELLED`; `RETRY_PENDING` thay vì `CANCELLED`; 1 test guard đã xanh (không cancel vẫn FAILED).
- Sửa product (sau red): `runtime.ts` `failTask` — 3 hunk ở trên.
- **GREEN (log `02-unit-after-fix-GREEN.log`, Exit Code: 0)**: 3/3 passed.
- Regression (log `03-regression-unit-suites.log`, Exit Code: 0): `wfa-t27-cancel-ack` + `runtime-lease-fencing-offline` + `br08-cancel-resume-race-offline` → 3 suites / **41 passed**; `runtime-recovery.test.ts` SKIP là gate live-infra có sẵn (`liveDescribe`), không phải do thay đổi.

## 4. E2E sau fix — 3 lần liên tiếp xanh (Node v24.21.0, cùng lệnh với lần đỏ)

| # | Log | Exit | Kết quả |
|---|---|---|---|
| 1 | `05-e2e-after-fix-run1.log` | 0 | `exit: 0`, 47 skipped / 2 passed (pattern `cancels` khớp T27 + paused-cancel) |
| 2 | `06-e2e-after-fix-run2.log` | 0 | `√ cancels an operation ... (WFA-T27) (1439 ms)`, 1 passed |
| 3 | `07-e2e-after-fix-run3.log` | 0 | `√ cancels an operation ... (WFA-T27) (1433 ms)`, 1 passed |

Log runner gốc vẫn còn ở `tests/workflow-api/logs/wfa-t27-*.log` (giữ nguyên).

## 5. Giới hạn / việc chưa làm (không tick VERIFIED/ACCEPTED)

1. **Chưa chạy full suite `http-worker.integration.test.ts` không `-t`** — thuộc gate mục 5 của lane WFA-HANDOVER; WFA-T26 đang được agent khác làm (test T26 có thể còn đỏ vì work-in-progress của họ, không phải do fix này).
2. Unit regression có chạy nhưng `runtime-recovery.test.ts` cần live infra (skip có gate), chưa chạy window live PG.
3. Ghi nhận delta hành vi có chủ đích: một failure report đến SAU khi cancel đã được chấp nhận giờ trả `{state:'CANCELLED'}` thay vì `{state:'FAILED'}` — mọi consumer đọc failTask đều nằm trong orchestrator (grep chỉ có tests gọi trực tiếp).
4. Chưa mở rộng scope: không sửa `legacy-operation-serializers`/contract; executor wrap `CANCELLED`→`LEGACY_WORKFLOW_CONNECTOR_FAILED` vẫn giữ nguyên (không thuộc seam này).
5. Không commit, không push, không tick VERIFIED/ACCEPTED.