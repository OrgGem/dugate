
---

## 22 — CYCLE 22: W-DATA-03-URL-ACQ (URL task not runnable before source READY) — task_928ae74339d5

#### Inventory trước khi viết gì (quan trọng: phần lớn DATA-03 ĐÃ có)
- `packages/worker-sdk/src/source-acquisition.ts` + `source-ingestion.ts` đã hiện diện và
  ĐÃ có test: `source-acquisition.test.ts` (SSRF fence qua pinned egress, redirect bound,
  oversized, slow/idle, rebinding) và `source-ingestion.test.ts` (32 case: acquire→
  stream→pin, retry idempotence, no-READY-on-failure, materialization gate).
- Đây là công việc lane DATA + Mục 9 của chính lane này (W-DATA03-CONSUMER-JOIN-1).
  Tôi KHÔNG viết lại những phần đó — task này đòi "viết test xác nhận policy", và phần
  policy đã có test. Nên tôi đi tìm LỖ HỔNG còn lại trong scope mình.

#### Lỗ hổng tìm được (đọc code, không phải đoán)
- `IngestAction.prepareSources` chỉ kiểm tra pin khi `artifactInputs.length > 0`:
  `if (pin && artifactInputs.length > 0) { ...SOURCE_PIN_MISMATCH... }`.
- Hệ quả: một task URL mà acquisition CHƯA materialize (chưa READY) có 0 artifact ⇒
  pin KHÔNG được kiểm. Nếu task đó còn mang `input.text`, parse mode rơi vào nhánh
  `else if (sources.inlineText)` và parse TEXT ĐÓ, báo thành công — dù platform chưa
  tải byte nào. Đúng nghĩa "failed acquisition không tạo READY hay parse bytes dở" bị
  vi phạm bằng một đường vòng: không READY, không bytes, nhưng vẫn có kết quả.
- Đây KHÔNG phải lỗi giả định: tôi đã viết test trước, chạy, và nó ĐỎ trên code cũ.

#### Sửa (1 file, đúng phạm vi)
- `src/actions/ingest/index.ts` (f05634ea, 326 dòng):
  (1) Kiểm pin BẰNG KHI `pin` CÓ, không điều kiện vào số artifact. Không khớp:
      có artifact → SOURCE_PIN_MISMATCH; không artifact nào → INGESTION_SOURCE_UNRESOLVED
      (tức "chưa READY, chưa runnable"), phân biệt rõ hai nguyên nhân.
  (2) `inlineText: pin ? undefined : input.text` — task có pin KHÔNG được thỏa bằng text
      nội tuyến, vì text đó không phải object mà gate đã pin. Không có pin thì đường
      inline thường hoạt động y như cũ (không đổi semantics cho case không pin).

#### Test (1 file mới, 5 test)
- `tests/data-03-url-acq.test.ts` (44b4ecf4, 118 dòng):
  1. pin + KHÔNG artifact + có inline text => INGESTION_SOURCE_UNRESOLVED (lỗ hổng).
  2. pin + artifact không khớp => SOURCE_PIN_MISMATCH (không đổi).
  3. pin + artifact khớp + có inline text => parse bytes ĐÃ PIN, inline bị bỏ.
  4. KHÔNG pin + inline text => đường thường vẫn chạy (fallback nguyên vẹn).
  5. acquisition hỏng => không còn buffer/partial nào để parse.
- Fixture pin theo ĐÚNG `IngestionReceiptSchema` (strict: storageKey, versionId, sha256,
  sizeBytes, artifactId? — KHÔNG có `url`; lần đầu tôi viết pin có `url` nên bị
  contract validator chặn, đã sửa theo schema thật).

#### Verify (offline, literal exit code)
- `pnpm --filter @du/document-core exec tsc --noEmit` — Exit Code: 0.
- Targeted mới x3: Tests: 5 passed, 5 total — Exit Code: 0 / 0 / 0.
- **FULL document-core: Test Suites: 46 passed, 46 total; Tests: 542 passed, 542 total
  — Exit Code: 0.** (45/537 ở Mục 21 + 1 suite/5 test mới = 46/542, khớp).
- Regression worker-sdk: source-acquisition + source-ingestion = Tests: 84 passed, 84
  total — Exit Code: 0 (tôi không sửa worker-sdk ở cycle này, nhưng chạy để chắm).
- 2 mutation probe, mỗi cái đúng mục tiêu:
  M1 đưa gate về dạng cũ (`pin && artifactInputs.length > 0`, tắt nhánh unresolved) =>
  2 test đỏ (case 1 và case 5 — đúng hai test bắt lỗ hổng).
  M2 bỏ `inlineText: pin ? undefined` => đúng 1 test đỏ (case 3, inline không bị bỏ).
  ⇒ cả hai nửa của fix đều thật sự được pin.
  Restore byte-exact ingest/index.ts: sha f05634ea, 13203 B, byte_identical=true.