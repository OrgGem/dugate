
---

## 21 — CYCLE 21: W-INGEST-WIRE-01 (ingest/ocr + ingest/digitize transmit the document) — task_197417c12b31

#### Defect thật trước khi sửa (đọc code, không phải lúc test)
- `ingest/ocr` gửi `{ language, hasBuffer: sources.buffers.length > 0 }` — MỘT BOOLEAN.
  Connector không nhận byte, hash, hay MIME; không có gì để đọc.
- `ingest/digitize` gửi `{ task: "digitize_handwriting" }` — KHÔNG CÓ GÌ ngoài tên task.
- Cả hai test cũ (DOC-01-v2/v3) truyền `text: "image-placeholder"` / `"form-placeholder"`
  và assert provider được gọi. Đó chính là bằng chứng giả mà
  tasks/ARCHITECTURE-REVIEW-FOLLOWUP-2026-09-27.md:7 cấm ("không dùng hasBuffer hay
  tên task làm bằng chứng đã truyền tài liệu").
- Contract ĐÃ ĐÓNG SẴN: `InvocationInput.artifacts?: readonly { artifactId: string }[]`
  có ở @du/contracts, connector service và worker-sdk. Không cần mở rộng contract —
  chỉ phải DÙNG đúng field đã freeze. Đây là "protocol bounded đã freeze" của spec.

#### Thay đổi (chỉ businesses/document-core)
1. `src/actions/ingest/index.ts` (8b43ce2c, 310 dòng):
   - `prepareSources` trả thêm `artifactIds: string[]` — id của artifact THẬT SỰ đã
     đọc, cùng thứ tự. Không dựng lại bằng index về sau (đó là đoán).
   - OCR: guard `INGESTION_SOURCE_UNRESOLVED` nếu không có artifact + truyền
     `artifacts: [{ artifactId: sourceArtifactId }]`. Xoá hẳn `hasBuffer`.
   - Digitize: cùng contract, giữ `task` làm NHÃN định tuyến nhưng thêm reference.
   - Checkpoint input của cả 2 bước đổi sang `artifactId` (id là identity của
     input, đúng ý nghĩa hơn boolean).
   - native `parse`/`split` KHÔNG đổi: vẫn local, không gọi Connector (docs/10).
2. `tests/ingest-wire.test.ts` (672659ee, 167 dòng, 8 test) — file mới.
3. `tests/ingest.test.ts` (05eb4bc7), `corpus-regression.test.ts` (1687cb7d),
   `all-variants-e2e.test.ts` (59ece128): fixture OCR/digitize nay ghi PNG thật
   (1x1 hợp lệ, base64) + assert payload mang artifactId và KHÔNG còn hasBuffer.
   Đây là các test ĐÃ CHỨNG MINH SAI — sửa chúng là phần việc của task, không phải
   nới lỏng để xanh.

#### Tự sửa lỗi trong lúc làm (báo lại vì suýt nộp hỏng)
- Edit đầu tiên của tôi dán nhầm tên khối (`new_string = "..."` nằm trong
  `old_string`) làm MẤT header `} else if (...)`, guard `sourceArtifact` và wrapper
  `executeWithCheckpoint` của cả hai nhánh ⇒ 26 lỗi compile. Đã vá lại từng nhánh,
  typecheck sạch. Nói thẳng: đây là lỗi thao tác của tôi, không phải tìm lỗi của
  người khác.
- `ArtifactReadResult` không có `artifactId` ⇒ không thể lấy id từ buffer đã đọc;
  đó là lý do `prepareSources` phải trả `artifactIds` thay vì suy ra.

#### Verify (offline, literal exit code)
- `pnpm --filter @du/document-core exec tsc --noEmit` — Exit Code: 0 (sau mỗi hunk; 2 lỗi
  compile thật ở giữa chừng đã sửa).
- Targeted: corpus-regression + all-variants-e2e + ingest + ingest-wire + ingest-source-pin
  = 5 suites, Tests: 88 passed, 88 total — Exit Code: 0.
- **FULL document-core: Test Suites: 45 passed, 45 total; Tests: 537 passed, 537 total
  — Exit Code: 0.** (44/529 ở Mục 20 + 1 suite / 8 test mới = 45/537, khớp).
- Mutation probe, 2 lần, mỗi lần đúng một nhánh:
  M1 đưa OCR về `hasBuffer: true` ⇒ 2 test đỏ (wire OCR + foreign denial).
  M2 bỏ `artifacts` khỏi vision ⇒ đúng 1 test digitize đỏ.
  ⇒ cả hai nhánh đều thật sự được pin, không phải test "cho xanh".
  Restore byte-exact ingest/index.ts: sha 8b43ce2c, 12346 B, byte_identical=true.
  `hasBuffer` còn duy nhất trong COMMENT giải thích, không còn call site thực thi.