# WFA-T27 attribution — fix runtime.ts failTask có CẦN THIẾT không? (A/B có kiểm soát)

- Task: verdict attribution theo yêu cầu coordinator. **Không tự tick gate** (quyết định thuộc coordinator).
- Không commit, không push, không sửa e2e test, không hand-edit `docs/21-openapi.json`.
- Lease dùng trong lượt này chỉ `services/orchestrator/src/modules/runtime/runtime.ts`.
- Raw: `coordination/reports/raw/wfa-t27-cancel-2026-10-08/08-A-my-fix-reverted-RED.log`, `09-B-restored-GREEN.log` (receipt trước: `wfa-t27-cancel-state-2026-10-08.md`).

## RESUME POINT

- **VERDICT: fix của lane này (`runtime.ts failTask` +`hasCancelSignal`) là CẦN THIẾT và (trên tree hiện tại) đủ để T27 xanh. T27 xanh KHÔNG phải tác dụng phụ của fix T26 (worker-sdk).**
- A/B chứng minh bằng đo, không phải suy luận: giữ nguyên T26 fix trong `dist` + revert nhánh `hasCancelSignal` → T27 ĐỎ lại đúng `:1245`; khôi phục byte-for-byte → xanh.
- Cả 2 fix là orthogonal theo cơ chế: T26 đổi CÓ GỬI `POST /invocations/:id/cancel` trên lease-loss (`connector-invoker.ts:153` `reason === 'cancel'`) — T27 là cancel THẬT nên guard đó luôn cho qua; T27 cần quyết định terminal state ở `failTask`.

## 1. Đọc lại (đúng yêu cầu)

- Receipt lane này: `wfa-t27-cancel-state-2026-10-08.md` — chỉ ra seam `runtime.ts failTask` UPDATE tasks `state='FAILED'` (:1014) + UPDATE operations `state='FAILED'` (:1028) không guard cancel, trong khi legacy cancel (worker còn lease) chỉ ghi `CANCEL_REQUESTED` (`legacy-host-adapter.ts:274-279`).
- Receipt T26: `wfa-t26-lease-recovery-2026-10-08.md` — fix của họ tại `worker-sdk/src/task-context.ts:348` (abort mang reason) + `worker-sdk/src/connector-invoker.ts:171` (chỉ `reason === 'cancel'` mới gọi `notifyConnectorCancel`); §6 họ **từ chối claim T27** (gửi lại owner).
- Code hiện tại: `worker-sdk/dist/connector-invoker.js:153` `if (signal?.reason === 'cancel') notifyConnectorCancel();` — **T26 fix ĐANG có trong dist** (dist là thứ harness dùng, không map src).
- `runtime.ts` hiện tại có nhánh `hasCancelSignal` của lane này (mtime `2026-10-08 07:46:59`, SHA-256 `c735d18e7ce73eff5b27ebd12eff97764dd41ecdba3fa7abbb315851468b3c86`).

## 2. A/B có kiểm soát (chỉ đổi runtime.ts)

| Bộ | Trạng thái | Command (cwd `du-rework`, Node v24.21.0) | Exit | Kết quả |
|---|---|---|---|---|
| **A** | T26 fix CÒN trong dist + **revert nhánh failTask của lane này** | `run-jest.cjs wfa-t27-attribution-my-fix-reverted-NODE24.log tests/workflow-api/http-worker.integration.test.ts -t WFA-T27` (01:37 UTC / 08:37 local) | **1** | `Expected: "CANCELLED" / Received: "FAILED"` tại `:1245`; `:1243` (provider abort) vẫn PASS |
| **B** | khôi phục byte-for-byte từ backup (SHA-256 khớp `c735d18e…b3c86`) | cùng lệnh, log `wfa-t27-attribution-restored-NODE24.log` (01:39 UTC / 08:39 local) | **0** | `√ cancels an operation … (WFA-T27) (1438 ms)`, 1 passed |

=> **Không có fix của lane này thì T27 đỏ dù fix T26 đã land** ⇒ CẦN THIẾT. Với tree hiện tại (layers 1–3 + T26 + runtime.ts) T27 xanh ⇒ đủ (trên tree này).

## 3. Vì sao lý luận 'T26 là tác dụng phụ' không đứng — 3 bằng chứng

1. **Cơ chế:** trong T27, abort đến từ heartbeat thấy `cancelRequested` → `ctx.abort('cancel')` → `signal.reason === 'cancel'` → guard của T26 **cho qua** → `notifyConnectorCancel` chạy y như trước; T26 chỉ chặn nhánh lease-loss. Lưu ý T26 chỉ đổi việc GỬI cancel (terminal hóa ledger), không đổi **trạng thái terminal của task/operation** — chỗ đó duy nhất do `failTask` quyết định.
2. **Chạy đỏ gốc (07:22 local, TRƯỚC fix T26):** `wfa-t27-diag-NODE24.log` `exit: 1`, `:1243` provider abort **ĐÃ PASS** → assertion provider-abort chưa bao giờ cần T26; chỉ `:1245` sai. A/B hôm nay tái hiện đúng như vậy với T26 đã land.
3. **Report giống hệt nhau:** log B (xanh) VẪN có `handler failed errorCode=LEGACY_WORKFLOW_CONNECTOR_FAILED retryable=false` (01:39:55) — tức worker vẫn report failure trong cả 2 trạng thái; khác biệt duy nhất là `failTask` có nhánh CANCELLED hay không. Nếu T26 là nguyên nhân xanh, log B sẽ không còn dòng report đó.

## 4. Lịch sử chồng chéo (vì sao ban đầu không phân định được)

- Run đỏ của lane này: 00:22 UTC (07:22 local) — chưa có fix T26, chưa có runtime.ts fix.
- 3 run xanh của lane này: 00:48/00:55/00:56 UTC (07:48–07:56 local) — **cả 2 fix cùng có mặt** (dist rebuild của T26 ~00:46 UTC theo `step6-ledger-timeline-fixed.log`) ⇒ các run đó **không** phân định được attribution; A/B ở mục 2 mới là run tách rời duy nhất trong phạm vi lease.

## 5. Quyết định gate

- **KHÔNG tự tick** VERIFIED/ACCEPTED cho T27 — thuộc coordinator. Bằng chứng A/B nộp ở đây.

## 6. Giới hạn

1. Chưa đo 'chỉ fix của lane này mà KHÔNG có T26' (muốn làm phải sửa `worker-sdk/**` — ngoài lease). Cơ chế đã nêu ở mục 3.3 nhưng đây là phân tích, không phải đo.
2. Chưa chạy full suite 15/15 trong lượt attribution này (chỉ `-t WFA-T27`); 15/15 trước đó do coordinator verify độc lập (08:02 rebuild) và receipt T26.
3. Trạng thái tree cuối lượt: `runtime.ts` byte-identical với trước A/B (hash mục RESUME POINT), backup còn ở `%TEMP%\t27-attribution-runtime.fixed.ts`.
4. Không commit, không push.