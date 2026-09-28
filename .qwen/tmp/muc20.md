
---

## 20 — CYCLE 20: W-ENC-04-DOC-CORE (document-core honours the crypto seam) — task_9f1e5d8a98e9 follow-up

#### Phát hiện quyết định khi đọc code (không phải lúc code)
- Cả OUTPUT của action lẫn OUTPUT của checkpoint ĐÃ đi qua encrypted facade từ
  cycle 19, vì `artifacts.write` -> `writeStream` (dòng 667-676 task-context.ts) và
  chính `writeStream` đã seal. Nên nhiệm vụ ở document-core KHÔNG phải "thêm mã hóa"
  mà là: (a) đưa seam tới context nội bộ để business code chạm được, (b) làm checkpoint
  tự seal để không phụ thuộc ai, (c) test chứng minh. Đã kiểm chứng bằng đọc code +
  test, không giả định.

#### Deliverable (chỉ businesses/document-core + 1 method worker-sdk)
1. `src/types/context.ts` (f4f5f2e7): `TaskContext.crypto?: TaskArtifactCrypto` —
   OPTIONAL, nên MockTaskContext và mọi context test cũ không phải sửa.
2. `src/worker.ts` (f60714c3): `taskCrypto()` feature-detect + export
   `toInternalContext` (trước đây private) để test được. Gắn crypto khi worker có seam.
3. `src/pipelines/step-checkpoint.ts` (a7c52ff1): `executeWithCheckpoint` giờ
   persist DẠNG SEALED khi có seam, mở trong suốt khi replay; thêm
   `assertEncryptionAvailable(ctx, required)` fail-closed TRƯỚC khi step body chạy;
   thêm `isSealedRecord()`. Không seam => trả về đúng giá trị cũ, byte-for-byte.
4. `tests/doc-core-crypto-seam.test.ts` (86e5cfc2, 295 dòng, 9 test).
5. worker-sdk `src/task-context.ts` (7ea1dd2a): thêm `cryptoSeam()`. Xem dưới.

#### LỖI THẬT TÔI GÂY RA VÀ ĐÃ SỬA (quan trọng hơn cả phần code)
- Adapter đầu tiên feature-detect `cryptoFor`. SAI: method đó CÓ mặt trên class dù
  `deps.crypto` chưa được cấu hình, nên worker bật/tắt mã hóa đều trông như "đã bật".
  Hậu quả đo được: `internal.crypto` là handle mà mọi lời gọi đều ném, checkpoint seal
  vỡ, và **3 suite tôi làm đỏ**: sdk-consumer (9 test), provider-backed-variant,
  p8-01-traceability-harness — tất cả fail với
  `"artifact encryption is not configured for this worker"`.
- Sửa: worker-sdk thêm `cryptoSeam(): WorkerCryptoSeam | undefined` (predicate nói
  thật sự có cấu hình hay không), adapter dùng predicate, giữ `cryptoFor` cho handler.
  Sau khi sửa: full document-core 44/44 suite, 529/529 test, Exit Code: 0.
- Bài học đã ghi: phân biệt "method tồn tại" với "tính năng được bật". Một API
  optional phải có predicate nếu consumer cần BRANCH theo trạng thái.

#### Test của tôi suýt vacuous — mutation probe bắt được (lần thứ hai trong 2 cycle)
- M2: thêm `leak: base64(plaintext)` vào record lưu. Test **VẪN XANH** — vì
  `JSON.stringify(record).not.toContain(SENTINEL)` không thấy sentinel đã base64-encode.
  Nghĩa là assertion của tôi chỉ chứng minh "plaintext không nằm dạng thô",
  yếu hơn nhiều so với điều cần chứng minh.
- Sửa: thêm `leaksSentinel()` đi base64-decode MỌI string trước khi kết luận.
  M2 chạy lại => **1 failed / 8 passed**, đúng test "persists an envelope...".
  Restore byte-exact (a7c52ff1, 6980 B, `leak_left=false`), 9/9 xanh trở lại.
- Đây là lần thứ hai trong hai cycle liên tiếp một assertion của tôi không cắn;
  không có mutation probe thì cả hai đều đã được nộp như bằng chứng.

#### Verify (offline, literal exit code)
- `pnpm --filter @du/document-core exec tsc --noEmit` — Exit Code: 0 (sau mỗi hunk;
  1 lỗi thật: export chưa có trong worker-sdk dist => phải build lại dist, đã build).
- `pnpm --filter @du/document-core test` FULL: Test Suites: 44 passed, 44 total;
  Tests: 529 passed, 529 total — Exit Code: 0. Số học khớp: 43 suite/520 test
  (baseline ghi nhận trước cycle) + đúng 1 suite/9 test của tôi.
- Suite mới x3 liên tiếp: Tests: 9 passed, 9 total — Exit Code: 0 / 0 / 0.
- Regression worker-sdk: crypto-seam 14/14 Exit 0; `tsc --noEmit` Exit 0.
- Lượt full đầu tiên có 5 suite đỏ: 3 do lỗi adapter ở trên (đã sửa, giờ xanh),
  `p8-03` = `connect ETIMEDOUT 127.0.0.1:5433` (Postgres live, ngoài offline gate),
  `bullmq-smoke` cần Redis. Cả hai XANH ở lượt full sau — nhiễu môi trường, không
  phải code (cùng họ Δ35).

#### Δ-DEVIATION (chờ coordinator adjudicate)
- Δ44 — checkpoint > 5 MiB vẫn chưa đi được: seam của worker-sdk từ chối single-shot
  quá trần, và chunked manifest chưa có field trong `finalizeArtifact` (cần
  contracts + orchestrator). Tồn tại từ Mục 19, chưa có gì mới.
- Δ45 — CHƯA deployment nào bật seam: `deps.crypto` phải được truyền khi khởi
  động worker (orchestrator/sidecar), và DEK vẫn chưa có đường delivery (Δ41).
  ⇒ "không còn worker path ghi plaintext durable" CHƯA đạt trên bất kỳ môi trường
  thật nào; cycle này chỉ chứng minh hành vi ĐÚNG KHI BẬT, và fallback đúng khi tắt.
- Δ47 — checkpoint seal ở tầng document-core là LỚP THỨ HAI: worker-sdk đã tự seal
  output qua `artifacts.write`, còn `StepCheckpointManager` seal lại giá trị mà
  context nội bộ nhận. Hai lớp không xung đột (nội bộ seal trước, SDK seal sau), nhưng
  nếu sau này ai đó chỉ bỏ lớp trong document-core thì vẫn an toàn — và nếu ai đó
  chỉ bỏ lớp trong worker-sdk thì checkpoint internal vẫn còn được seal. Cần quyết
  định: giữ cả hai (defense in depth, phí mã hóa kép) hay chọn một chỗ duy nhất.