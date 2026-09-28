# QWEN-4R — lane đo RSS DATA-04 + memo parseFile (thay lane Qwen-4, kẹt kênh prompt)

> [!IMPORTANT]
> **RESUME POINT — 2026-09-25 ~21:00 giờ máy (cycle 142 = packet W-DATA04-RSS-1).**
> Đọc hết khối này là đủ để tiếp tục, khỏi đọc lại transcript.
>
> **Cycle 142 = HOÀN THÀNH.** (A) Đã đo RSS THẬT của uploadArtifactMultipart
> (packages/worker-sdk) bằng suite mới tests/artifact-multipart-rss.test.ts: fake
> transport nhận body THẬT, geometry 16 part × 64MiB = 1GiB, hai hình dạng source
> chunk (khớp 16MiB / lệch 5MiB), 3 run liên tiếp exit 0. Kết luận chính: claim
> 'memory = ĐÚNG 1 part' của Cycle 140 ĐÚNG về hướng (không đổi theo total) nhưng
> SAI về độ lớn nếu dùng làm budget RSS: live-set tại thời điểm PUT là ~2 part
> (subarray chunks 1 + Buffer.concat 1) và high-water RSS quan sát tới ~5 part
> (~320MiB với part 64MiB) do GC lag; không có creep theo số part (slope ~0).
> Ngân sách §6 phải ký theo 2×–5× partSize, KHÔNG phải 1×. (B) Memo parseFile đã
> gửi ở §5: khuyến nghị KHÔNG mở PR option 1 bây giờ; nếu cần giảm peak parse thì
> làm PR nhỏ 'transfer-list' (option 2b, ~1 file document-kit); revisit option 1
> khi parser budget > 50MiB. Lane KHÔNG sửa src, KHÔNG commit/push, HEAD 7811298.
>
> **Việc còn của lane (chờ coordinator):** adjudicate §4 (số budget cho §6) và
> quyết §5 (parseFile go/no-go). Nếu được giao tiếp, lane Qwen-4R nối lại từ đây.

## 0. Packet & role

- Packet: W-DATA04-RSS-1 (Review 156–161 instruction #3 + hold RSS của DATA-04;
  §6 policy đã user ký 19:58 — theo MONITORING-LOG).
- Ngữ cảnh đọc trước khi làm: du-rework/AGENTS.md; RESUME POINT + Cycle 140/141
  trong coordination/reports/qwen4.md.
- Boundary tuân thủ: chỉ tạo MỚI packages/worker-sdk/tests/artifact-multipart-rss.test.ts
  + file báo cáo này; 0 sửa src; 0 DB/Redis/S3; 0 commit/push.

## 1. Pre-gate: cổng 'không còn jest đang chạy' trước khi đo

- Quét tiến trình trước khi đo: 3 node khớp 'jest' còn sót (PID 23740/9076 chạy
  ~1035 phút, PID 9184 ~891 phút). Đo CPU delta qua cửa sổ 12–15 giây:
  **delta = 0ms, working set 12–26MB** → đây là jest ZOMBIE treo từ ~17 tiếng,
  không phải aggregate đang đo. Các suite đo thật của lane khác (connector full,
  orchestrator ngắn) đã kết thúc trước thời điểm chạy.
- RAM trống trước khi đo: FreeMB=8765 / 28386 — đủ cho peak đo ~0,5–1GiB.
- Ghi chú trung thực: lane KHÔNG kill tiến trình nào; quy ước zombie(CPU=0) ≠ busy.

## 2. Suite đo: tests/artifact-multipart-rss.test.ts (2 test, offline, 0 socket)

- Fake transport: init→partGrant→complete→abort như Cycle 140; fetcher VERIFY body
  thật (hash + length theo pattern độc lập) rồi THẢ ngay — không giữ tham chiếu,
  để phép đo không nhiễm bởi chính fake.
- Nguồn: generator pattern 1GiB (không bao giờ materialize toàn bộ), hai geometry:
  chunk 16MiB thẳng hàng và chunk 5MiB lệch biên (stress subarray-pinning).
- Lấy mẫu RSS/external tại MỌI chunk yield + MỌI lúc PUT enters + 20 mẫu baseline.
  setInterval bị loại (xem §3.0).

**Định nghĩa WIN/LOSE (như nhau cho cả 2 test):**
- WIN = (1) result.sha256 == digest toàn cục tính lại độc lập; (2) đúng 16 PUT,
  mỗi body 64MiB, sha body nhận == patternDigest(partStart, 64MiB) == sha grant;
  (3) grants ascending 1..16, receipts complete 16, sha/size khớp; (4) 0 abort;
  (5) mẫu không rỗng (chunkSamples ≥ 64/205, uploadMax > baseline); (6) marginalRSS
  ≤ 512MiB (8 part) VÀ marginalExternal ≤ 512MiB.
- LOSE: bất kỳ điều nào sai. Retention toàn bộ source (≥16 part ≈ 1GiB marginal)
  sẽ fail (6) với biên ≥2×; mẫu rỗng fail (5) thay vì pass rỗng.

## 3. Bằng chứng chạy (exit code literal từ wrapper)

### 3.0 Run thăm dò (probe, code cũ — sampling hỏng, KHÔNG tính vào 3-run)
- setInterval bị ĐÓI trong lúc upload (chuỗi await toàn microtask resolve-ngay):
  samples=0, max=-Infinity → assertion ceiling trên rỗng là VÔ NGHĨA. Đã sửa:
  lấy mẫu trong data-path + enforce mẫu không rỗng.
- Probe vẫn lộ cấu trúc thật: plateau ≈ baseline+2..3 part, spike tốt đa 599,5MiB
  (≈5 part marginal), không creep theo part. Số này dùng để định ceiling.

### 3.1 Code chốt — 3 run liên tiếp trên file cuối cùng

| Lần | lệnh | Test Suites | Tests | Exit Code |
|---|---|---|---|---|
| R1 | npx jest tests/artifact-multipart-rss.test.ts --runInBand | 1 passed, 1 total | 2 passed, 2 total | Exit Code: 0 |
| R2 | (như trên) | 1 passed, 1 total | 2 passed, 2 total | Exit Code: 0 |
| R3 | (như trên) | 1 passed, 1 total | 2 passed, 2 total | Exit Code: 0 |

Số liệu (MiB, absolute; marginal = trừ baseline median):

| Kịch bản | baseline RSS | median upload | max upload | marginal max RSS | marginal max external | slope MiB/part |
|---|---|---|---|---|---|---|
| aligned R1 | 274,7 | 437,0 | 535,5 | 260,7 (4,1 part) | 319,6 (5,0 part) | −3,97 |
| aligned R2 | 258,2 | 374,1 | 455,6 | 197,4 (3,1) | 207,6 (3,2) | +1,29 |
| aligned R3 | 258,5 | 374,1 | 456,7 | 198,2 (3,1) | 207,6 (3,2) | +1,20 |
| lệch R1 | 318,1 | 413,1 | 537,1 | 218,9 (3,4) | 282,5 (4,4) | +2,47 |
| lệch R2 | 302,3 | 397,5 | 521,3 | 219,0 (3,4) | 282,5 (4,4) | +2,48 |
| lệch R3 | 303,2 | 398,3 | 522,1 | 218,9 (3,4) | 282,5 (4,4) | +2,47 |

Trajectory theo part (R3 aligned): 392,1 → 456,3×4 → 454,1 (plateau hai mức, không
tăng dần). R3 lệch: 391,7; 456,9–462; 392–397; 521,2; rồi về 457–462 — spike xen kẽ.

### 3.2 Không giao tranh + nguyên package
- npm run lint (tsc src): Exit Code: 0.
- npm test (full worker-sdk, --runInBand): **13 suites / 173 tests pass** (171 nền
  Cycle 140 + 2 mới), family real-listener xanh lần này, Exit Code: 0.
- tsc đứng riêng cho file test (flags = tsconfig.base, có noUncheckedIndexedAccess): exit 0.
- git rev-parse --short HEAD = 7811298; git status --porcelain: footprint lane đúng
  bằng ?? tests/artifact-multipart-rss.test.ts + file báo cáo này.

## 4. PHÁN QUYẾT claim Cycle 140: 'memory = đúng 1 part' có phải budget RSS không?

1. **Về live-set logic: claim sai nhẹ (2 chứ không phải 1).** putPart gọi
   Buffer.concat(chunks) khi partChunks VẪN còn sống (mảng chỉ reset sau khi await
   putPart return) → tại thời điểm PUT: ~1 part chunks (cộng tối đa một chunk
   nguyên ven 5–16MiB bị subarray ghim lại với geometry lệch) + 1 part body concat
   = **2 part live**, chưa tính GC lag.
2. **Về RSS đo được: claim đúng hướng nhưng sai độ lớn nếu dùng làm budget.**
   Median RSS upload 374–437MiB absolute (≈ baseline jest + 1,5–3 part); max
   456–537MiB; marginal worst 261MiB (R-series) / 323MiB (probe) = ~4–5 part;
   slope −4..+2,5 MiB/part ≈ 0 → không tăng tích lũy theo 16 part: allocator
   Windows + V8 external GC trả bộ nhớ đúng lúc trên máy này.
3. **Kết luận cho §6 / capacity plan:** ngân sách ĐÚNG cho mỗi multipart upload
   đồng thời với part-cap 64MiB = **live 2× partSize (128MiB), high-water RSS
   5× partSize (~320MiB)** — KHÔNG phải 1×. Ký '1 part' làm budget RSS là cấp
   container thiếu 3–5× so với số đo thật. Các số này KHÔNG phụ thuộc total
   (1GiB hay 8GiB như nhau) — đó mới là giá trị sử dụng được của claim gốc.
4. Không có retention toàn bộ source: assertion external (≤8 part) xanh với biên
   ≥1,6× trên giá trị đo lớn nhất (319,6MiB).

## 5. MEMO QUYẾT ĐỊNH: parseFile(path) cho document-kit (lane KHÔNG sửa document-kit)

**Hiện trạng đọc trực tiếp (fact):** seam Step B
(businesses/document-core/src/pipelines/parser-budget.ts): artifact >1MiB đổ ra
TempWorkspace file, rồi readFile(target) materialize NGUYÊN Buffer 1×doc đưa vào
safeParseBuffer → defaultParserFactory.parseBuffer →
document-kit/src/parsers/worker-isolation.ts gửi buffer qua workerData (structured
clone = **COPY lần 2 vào worker thread**, Buffer.from(workerData.buffer)). Bốn
parser built-in đều Buffer-API: mammoth (docx), xlsx/SheetJS, pdf-lib, text.
Parser budget mặc định DEFAULT_MAX_BUFFER_SIZE_BYTES = 10MiB; INLINE_READ_BYTES = 1MiB.
Peak parse hiện tại ≈ 2×doc (parent + worker) + nội tại parser — chặn ở ~40–60MiB/task.

**Option 1 — parseFile(path) trong document-kit (parse từ fd):**
- Chi phí: CAO, phải làm đồng thời: entry factory mới + worker-isolation (truyền
  path thay buffer) + SafeArchiveExtractor preflight fd-based (đọc EOCD cuối file,
  đổi zip đọc sang random-access kiểu yauzl) + text reader stream. docx chỉ ăn
  khi đổi backend unzip của mammoth; **PDF với pdf-lib BẮT BUỘC load nguyên
  Uint8Array — không xuống dưới 1×file nếu không đổi engine**; xlsx readFile của
  SheetJS vẫn ngấm cả file trong worker (chặn được copy parent, không chặn copy
  worker). Cộng ma trận test parity với parseBuffer (48 test parser-budgets + suite
  kit) và review bảo mật zip mới.
- Rủi ro: CAO — đổi engine zip/pdf = đổi hành vi byte-level trên adversarial input;
  TOCTOU giữa verify-sha ở seam và lúc worker mở file (ngăn được nhờ TempWorkspace
  task-scoped nhưng dispose phải dời ra SAU khi worker xong — đụng lifecycle ART-02);
  format-detection phải đọc prefix từ fd.
- Lợi ích thực chất: −1×doc (bỏ copy parent) ngay lập tức; thêm −1×doc CHỈ cho text
  và (nếu đổi backend) docx. PDF/xlsx: 0 nếu giữ engine.

**Option 2 — splice buffer tại seam parser-budget (không đổi document-kit):**
- BẤT KHẢ THI cho docx/xlsx/pdf: container cần central directory EOF (zip) / xref
  EOF (pdf) — cắt buffer thì parser hiện tại từ chối. Seam chỉ có thể: stream-hash
  từ fd (không đổi peak, vì buffer vẫn cần cho parse) hoặc slice riêng cho plain-
  text (lợi ích không đáng kể với budget 10MiB).
- Biến thể 2b (khuyến nghị nếu cần hành động NGAY): **transfer-list trong
  worker-isolation** — new Worker không workerData, postMessage({buffer},
  [buffer.buffer]) ĐỔI QUYỀN SỞ HỮU ArrayBuffer sang worker thay vì clone. Diff ~1
  file document-kit, rủi ro thấp (byte y hệt, chỉ ownership), peak 2× → 1× + nội
  tại parser. Vẫn là sửa src document-kit → cần ID + lane riêng; lane này không làm.

**KHUYẾN NGHỊ cho coordinator:**
1. **KHÔNG mở PR option 1 bây giờ.** Vì: (a) đầu vào parse bị chặn 10MiB bởi parser
   budget — bài toán ≥1GiB mà Cycle 140/142 vừa đo là đường WRITE (envelope output),
   parseFile không phục vụ nó; (b) pdf-lib không thể xuống dưới 1×file → hứa 'RSS-
   theo-chunk thật sự khi parse' là hợp đồng không thể giao với stack hiện tại; (c)
   chi phí + rủi ro bảo mật không tương xứng 10–20MiB/task tiết kiệm được.
2. Nếu muốn giảm peak parse ngay: mở ID nhỏ cho option 2b (transfer-list) — một file
   document-kit; acceptance: peak parse 1 doc ≤ 1×doc + internals, suite kit xanh.
3. **Revisit option 1 khi:** §6 nâng parser budget >50MiB, HOẶC có yêu cầu parse PDF
   >100MB và đổi engine random-access được chấp thuận.
4. Khi ký §6: số ở phần A (live 2× / high-water 5× per partSize) là ngân sách RSS của
   UPLOAD; ngân sách parse ≈ 2× maxBufferSizeBytes + internals — hai số riêng, đừng
   cộng dồn thành một budget.

## 6. Next owner / việc còn lại

- **Coordinator:** adjudicate §4 (budget §6 nên là live 2× / high-water 5× per part)
  và quyết §5 (go/no-go 2b; option 1 giữ nguyên cờ).
- **Tester-1:** window live §9.1–9.3 (DATA-04 ACCEPTED) — đã có số RSS offline để
  đối chiếu khi đo live.
- **Lane Qwen-4R:** tiếp tục chuỗi DATA-04 nếu được giao; receipt sau ghi vào file
  này với số tăng dần, không sửa section cũ.
- Nhắc kỷ luật lane: kết thúc mỗi cycle ghi dòng /compress để user kích.

> /compress
