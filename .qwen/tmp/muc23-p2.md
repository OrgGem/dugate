#### Sửa (1 file src — `src/modules/runtime/runtime.ts`, sha `902185d2`, 77510 B)

Chèn vào `claimTask`, **sau** khối terminal check và **trước** khi lease được cấp:

```typescript
if ((t.op_state as string) === 'PENDING_INGESTION') {
  throw conflict('STATE_CONFLICT', 'task is not runnable until its ingestion source is READY');
}
```

Vị trí này là cố ý:

- **Sau** terminal check — một task đã terminal vẫn trả về lỗi terminal như cũ, không đổi
  semantics của các path khác.
- **Trước** mọi cây lấy lease — nên lần claim bị từ chối **không lấy lease, không tăng
  `attempt`, không ghi `last_delivery_id`**. Đây là điều test mới phải chứng minh, không phải
  điều tôi tự khẳng định.
- Dùng `op_state` (state của **operation**) chứ không phải `state` của task: cổng nằm ở
  operation, và claim query đã project `o.state AS op_state` sẵn — không thêm bind param,
  không thêm round-trip.

Không sửa `dispatcher.ts`, không sửa `ingestion-consumer.ts` (mtime `2026-09-26T10:03`, tôi
không chạm).

#### Test (1 file, +2 test; 33 -> 35)

`tests/url-ingestion-consumer-offline.functional.test.ts`:

- `TaskRow` bổ sung 5 cột lease (`lease_epoch`, `lease_expires_at`, `leased_by`,
  `last_delivery_id`, `attempt`) + `seedGatedSubmission` set giá trị đầu. Trước đó harness
  không có các cột này, nên mệnh đề "refused claim lấy **không** lease" sẽ là assertion vào
  một field không tồn tại — đó là loại test vacuous tôi đã trúng ở cycle 20.
- Router thêm 4 nhánh, tất cả đều là SQL thật mà `claimTask` phát ra:
  1. `SELECT ... FROM tasks t JOIN operations o ... FOR UPDATE OF t` (chỉ project
     `op_state` **khi** SQL có `o.state AS op_state` — router đọc text nên phải ràng điều kiện).
  2. `SELECT state FROM operations WHERE id=$1`.
  3. `UPDATE tasks SET lease_epoch=... leased_by=... last_delivery_id=... state='RUNNING'`
     (chỉ khi `row.lease_epoch + 1 === expectedEpoch`, trả `rowCount 0` nếu không sở hữu —
     mô phỏng đúng CAS, không phải update unconditional).
  4. `UPDATE operations SET state='RUNNING' ... state_version = state_version + 1` (chỉ khi
     op đang `PENDING_INGESTION`).
  Không có 3 và 4 thì test "gate mở rồi claim thành công" sẽ đụng `unrouted sql` và chứng
  minh được **không gì cả**.
- 2 test mới:
  1. `claim boundary: a PENDING_INGESTION task is refused and takes NO lease` — assert
     `STATE_CONFLICT`, `state` vẫn `PENDING_INGESTION`, `lease_epoch` 0, `leased_by` null.
  2. `claim boundary: once the gate opens, the SAME task claims normally` — chạy consumer
     thật (`sweep.opened === 1`, op → `QUEUED`, task → `READY`), rồi claim **chính task đó**
     và assert snapshot mang artifact pin đã materialize (guard bám trạng thái cổng, không bám
     id task).

`tests/url-ingestion-backend-failclosed-offline.test.ts` — **không sửa**. 5 test của nó đã đúng
phạm vi; nói thẳng thay vì sửa cho có.

