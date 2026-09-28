## 23 — CYCLE 23: W-DATA-03-ORCH-VERIFY (URL task not runnable until source READY — phía Orchestrator) — task_d3329e56f028, ctx_a197b906cb36

#### Inventory trước khi viết gì (đo trước, không đoán)
Packet bảo *verify and wire* trong 2 file test. Tôi đọc cả 2 trước khi chạy gì:

- `tests/url-ingestion-consumer-offline.functional.test.ts` — **đã tồn tại**, 33 test, xanh
  sẵn (viết ở Mục 9 / cycle 9).
- `tests/url-ingestion-backend-failclosed-offline.test.ts` — **đã tồn tại**, 5 test, xanh sẵn
  (viết ở Mục 12 / cycle 12).

⇒ 38 test có sẵn và đang xanh. Nếu cycle này chỉ chạy lại chúng thì **không deliver được gì**.
Vậy "wire" phải chỉ một khoảng trống thật, và tôi phải tìm ra nó bằng đọc code chứ không bằng
chạy test cho xanh.

#### Lỗ hổng tìm được (đọc code, không phải lúc test)
Mệnh đề packet cần giữ: **business task chỉ runnable khi source artifact READY trong S3**.
Tôi lần theo cả ba tầng có thể giữ mệnh đề này:

1. **Tầng submit** — `submission.ts` đã từ chối khi backend ≠ s3 (422
   `UNSUPPORTED_STORAGE_BACKEND`, Mục 12). Đúng, nhưng đây là *điều kiện tiên quyết*, không
   phải *điều kiện READY*.
2. **Tầng dispatch (routing)** — `dispatcher.ts:36-41` có
   `AND (payload->>'gate') IS DISTINCT FROM 'ingestion'`. Đúng là dispatcher **không publish**
   row gate-ingestion lên business queue.
3. **Tầng claim (boundary)** — `claimTask` trong `src/modules/runtime/runtime.ts`:
   **KHÔNG có nhánh nào kiểm tra `PENDING_INGESTION`.** Tôi grep toàn bộ file: chỉ có
   terminal check + ownership fence + artifact consistency.

Đây là hàng rào **1 lớp**, không phải hàng rào. Cụ thể, mọi đường sau vẫn đưa được một task
`PENDING_INGESTION` tới chỗ worker nhận việc, và lúc đó nó **cấp lease thật** cho một task
mà input chưa có byte nào:

- BullMQ redelivery của một job đã publish trước khi gate có (hoặc đã publish vì dispatcher
  chạy trước lúc row được stamp `gate`).
- Row ghi vào DB trước khi `gate` tồn tại (mọi row đã persist từ trước Mục 9).
- Bất kỳ path nào khác re-stamp `dispatched_at` mà không đi qua predicate của dispatcher.

⇒ Đây đúng là loại bug mà tôi đã gặp ở Mục 11 (post-lease ownership fence): **routing không phải
boundary**. Sửa đúng bài toán này bắt buộc phải chạm `src/`, không sửa được bằng test-only.

