# Legacy fair‑share findings — bàn giao từ review du‑rework (2026-10-07)

**Nguồn:** review working tree tại HEAD `4308cc5` (reviewer read‑only). Ba finding này ban đầu nằm trong `du-rework/tasks/CODE-REVIEW-FOLLOWUP-WTREE-2026-10-07.md` (ID WT‑10/WT‑11/WT‑12), sau đó **được tách ra khỏi plan du‑rework** theo yêu cầu giữ scope du‑rework tinh khiết. File này thuộc **legacy lane** (repo root); không đóng task/gate nào của du‑rework. Code freeze toàn repo vẫn giữ: **không commit, không push**.

## Trạng thái tại thời điểm bàn giao (đã đối chiếu lại 2026-10-07 ~00:45)

| Finding | Nội dung gốc | Hiện trạng |
|---|---|---|
| **WT‑10** — `lib/queue/worker-slots.ts` dead code (zero call‑site), 4 constant trong `lib/config.ts:24-40` không được tham chiếu | Lúc review: đúng. **Nay đã lệch:** `worker.ts:29-30, 75-76, 97` đã import/gọi `tryAcquireSlot`/`releaseSlot` (receipt: `coordination/reports/receipt-p1-worker-semaphore-2026-10-06.md`, `receipt-p3-fair-share-verification-2026-10-06.md`). → **cần re-verify; có khả năng đã xử lý xong.** |
| **WT‑11** — `ACQUIRE_LUA` (`lib/queue/worker-slots.ts:35-45`) chỉ `EXPIRE` khi counter 0→1 (rolling‑lease ⇒ vượt cap khi key hết hạn giữa chừng); 2 `catch` (`:57-69`, `:73-86`) nuốt lỗi không log dù có `lib/logger.ts` | `worker-slots.ts` **không đổi từ 10/6 23:31** → có khả năng **vẫn mở**. Receipt P1 bổ sung **F‑P1‑01**: fail‑open acquire trả `true` nhưng không INCR, trong khi `finally` của worker vẫn `releaseSlot` → DECR key của holder khác → undercount/over‑admission. Gộp F‑P1‑01 vào cùng phạm vi sửa. |
| **WT‑12** — root lane thêm logic không có test; cast thừa `as { rateLimitPerMin?: number \| null }` ở `lib/endpoints/runner.ts:199`, `:289` | Phần test đã cũ: `tests/pipelines/worker-slots.test.ts`, `profile-endpoint-limits.test.ts` (tạo 00:15), `worker-slots.live-check.cjs` (00:19) đã tồn tại. Phần cast thừa chưa kiểm lại. |

## Việc còn lại đề xuất (owner: legacy lane)

1. **Re-verify WT‑10/WT‑12 trên cây hiện tại** trước khi kết luận: chạy `npm test -- tests/pipelines/` ở root và đối chiếu receipt P1/P3 với code thật (receipt không thay thế kiểm chứng).
2. **Sửa WT‑11 + F‑P1‑01 trong `lib/queue/worker-slots.ts`:** refresh `EXPIRE` ở mọi acquire thành công (hoặc lease theo holder có token); acquire fail‑open phải trả kết quả phân biệt được để worker **không** release slot không sở hữu; mọi fail‑open ghi log `warn` qua `lib/logger.ts`. Kèm test fake‑ioredis capture `EVAL` (cap không vượt, hết hạn giữa chừng không sinh slot, release chỉ khi đã INCR).
3. **Kiểm lại cast thừa** ở `lib/endpoints/runner.ts` (schema `lib/db/schema.ts:134-135` đã khai báo đủ cột).

Mọi kết luận đóng finding phải kèm: lệnh + cwd + exit code + passed/failed/skipped + đường dẫn raw output. Node môi trường hiện tại **v22.16.0** (lệch `engines >=24.21.0 <25` của du‑rework — ghi vào receipt nếu liên quan).
