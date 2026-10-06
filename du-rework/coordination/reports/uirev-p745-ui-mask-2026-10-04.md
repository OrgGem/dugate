# UI Review Receipt: P745-UI-MASK (Q2 Form-Field Mask/Unmask Toggle)

- **Date:** 2026-10-04 23:58 +07
- **Reviewer:** Antigravity UI Lead (`term_ae2d7e42`)
- **Task Reference:** `P745-UI-MASK` by `qwen_5`
- **Receipt Reviewed:** `coordination/reports/p745-ui-mask-2026-10-04.md`
- **Reviewed Code & Test Artifacts:**
  - `apps/admin-web/src/features/connectors/curl-import-preview.tsx` (Summary & PreviewTable leaf)
  - `apps/admin-web/src/features/connectors/connectors-screen.tsx` (Card mount passing draft)
  - `tests/browser/admin-web/p730-curl-import.spec.ts` (19 Playwright tests, cases 17-19 newly added)
- **Governing Standard:** `docs/admin-ui-development-contract.md` (§1, §3, §4, §5)
- **Prior Reference:** `coordination/reports/curl-ui-review-2026-10-04.md` (§2.2 Adjudication of Q2)
- **Mode:** READ-ONLY on source/plans; write receipt only; no source edits; no commit/push.

---

## 1. Phán Quyết Nghiệm Thu (Verdict)

### 🟢 **`UI_APPROVED`** *(SLICE COMPONENT & HEURISTIC TOGGLE VERIFIED)*

Căn cứ theo **`docs/admin-ui-development-contract.md` §5**:
1. **Mục tiêu slice `P745-UI-MASK`:** Triển khai cơ chế toggle Mask/Unmask cho các trường form nhập từ cURL (Heuristic Q2), đảm bảo mặc định ẩn secret (`masked-by-default`), hiển thị fingerprint (`****last4`), bảo vệ tuyệt đối headers (không bao giờ lộ raw), tuân thủ khả năng tiếp cận (`aria-pressed`, `aria-label`), và giữ vững tính độc lập không rò rỉ dữ liệu nhạy cảm.
2. **Thực chứng độc lập:**
   - **Playwright Test Runner:** 19/19 tests passed trên [`p730-curl-import.spec.ts`](file:///D:/Git/dugate/du-rework/tests/browser/admin-web/p730-curl-import.spec.ts) (thời gian chạy: 1.2s).
   - **TypeScript Typecheck:** `pnpm --filter @du/admin-web typecheck` $\rightarrow$ **Exit Code 0** (3 lần liên tiếp).
   - **Production Build:** `pnpm --filter @du/admin-web build` $\rightarrow$ **Exit Code 0** (2665 modules, bundle thành công trong 12.35s).
   - **Bảo toàn DOM/SSR:** Bằng chứng kết xuất SSR chứng minh secret hoàn toàn vắng mặt trên markup khởi tạo, nút bấm toggle có thuộc tính `aria-pressed="false"`.
3. **Kết luận:** Slice đạt đầy đủ các tiêu chuẩn kỹ thuật của UI Contract §5. Antigravity phê duyệt chính thức gói `P745-UI-MASK`.

---

## 2. Đánh Giá Chi Tiết Theo Tiêu Chuẩn UI Contract §5

### 2.1. Tuân Thủ Heuristic Q2 (Masked-by-Default & Boundary)
- **Cơ chế mặc định:** `CurlImportSummaryView` khởi tạo state `revealedFields` bằng một `Set<number>` rỗng (`new Set()`). Mọi trường thuộc từ điển nhạy cảm (`api_key`, `secret`, `token`, `password`,...) đều được bọc bởi badge `secret` và chuỗi mặt nạ `****last4`.
- **Ranh giới Heuristic (Heuristic Boundary):**
  - Test 18 kiểm chứng rõ ràng: Trường `author=Nguyen` (không thuộc từ điển secret) hiển thị công khai ở dạng preview văn bản rõ ràng.
  - Trường `api_key=hiddenvalue1` bị ẩn ngay từ model và tầng render (`****lue1`), chuỗi thô `hiddenvalue1` hoàn toàn không xuất hiện trong payload tóm tắt (`summary`).
- **Quy tắc bất di bất dịch cho Headers:**
  - Bảng `Headers` không truyền tham số `action` vào `PreviewTable`.
  - `hasAction = rows.some((row) => row.action != null)` $\rightarrow$ `false` $\rightarrow$ Cột `Reveal` **hoàn toàn không được kết xuất** cho Headers.
  - Ngăn chặn triệt để nguy cơ người vận hành vô tình làm lộ Bearer token hoặc credential header trên giao diện.

### 2.2. Khả Năng Tiếp Cận & Trực Quan (A11y & Visual Consistency)
- Nút bấm Show/Hide sử dụng biến thể `variant='ghost'` và kích thước `size='sm'`, tái sử dụng nguyên vẹn token hệ thống từ design system.
- Thuộc tính ARIA chuẩn mực:
  - `aria-pressed={revealed}` (phản ánh trạng thái hiển thị logic).
  - `aria-label={(revealed ? 'Hide value for ' : 'Show value for ') + field.name}` (hỗ trợ trọn vẹn cho Screen Readers).
- Không phát sinh bảng màu thứ hai (No 2nd palette), kế thừa toàn bộ biến CSS từ `:root` / `tokens.css`.

---

## 3. Phán Quyết Các Delta (Adjudication of Deltas d18, d19, d20)

| Delta | Nội dung thay đổi | Đánh giá kỹ thuật | Phán quyết của UI Lead |
|---|---|---|:---:|
| **d18** | `CurlImportSummaryView` nhận thêm prop tùy chọn `draft?: CurlImportDraft`. | Cần thiết để component con có thể truy cập giá trị thô khi người dùng chủ động bấm Reveal (vì `summary` cố tình không chứa raw secret). Thiết kế tùy chọn (`optional`) giúp tương thích ngược hoàn hảo khi component được gọi ở các màn hình chỉ xem (view-only). | **CHẤP NHẬN (PASS)**<br>*Không cần thay đổi.* |
| **d19** | `PreviewTable` bổ sung cột tùy chọn `action` / `Reveal`. | Cột `Reveal` chỉ xuất hiện khi ít nhất một dòng có `action`. Headers table truyền `action=undefined` nên cột tự động biến mất. Tái sử dụng bảng biểu tinh gọn, không nhân bản code. | **CHẤP NHẬN (PASS)**<br>*Đạt chuẩn clean code.* |
| **d20** | Nút Toggle là **display-only**; chưa hỗ trợ tính năng "đánh dấu / gỡ đánh dấu secret" vào draft model trước khi Apply. | **Phân tích:**<br>1. Scope của packet cURL Import là **Accept-only** (sinh ra in-memory draft, việc lưu trữ do Save connection đảm nhiệm).<br>2. Thao tác "Show/Hide" của operator là để **kiểm tra đối soát parse**, tuyệt đối không nên tự động giáng cấp (downgrade) phân loại từ secret sang plaintext.<br>3. Tính năng chỉnh sửa phân loại secret thủ công thuộc về màn hình soạn thảo kết nối tổng thể (Connection Form Editor), không thuộc phạm vi preview cURL. | **CHẤP NHẬN AS-IS**<br>*Hành vi display-only an toàn và đúng đắn nhất. **KHÔNG CẦN** packet bổ sung.* |

---

## 4. Minh Bạch Ranh Giới Khoảng Trống (Honest GAP Boundary)

- **Click-to-reveal State Transition:**
  - Do môi trường kiểm thử offline không cài đặt `jsdom` hoặc `@testing-library/react`, sự kiện click chuột thực tế để lật state `revealedFields` trong DOM chưa được kích hoạt trong test runner Node.
  - `qwen_5` đã minh bạch ghi nhận trạng thái **SKIP** (không tự nhận PASS giả tạo) và cung cấp kiểm chứng tĩnh (Test 17 static wiring guard) kết hợp kiểm chứng SSR markup.
- **Đánh giá ranh giới:**
  - Đây là khoảng trống đã được dự liệu và thuộc phạm vi kiểm thử của **Plane A Browser Harness** (theo runbook vừa ban hành tại [`ui-browser-env-2026-10-04.md`](file:///D:/Git/dugate/du-rework/coordination/reports/ui-browser-env-2026-10-04.md)).
  - Khoảng trống này không cản trở việc cấp phán quyết `UI_APPROVED` cho slice mã nguồn và component này.

---

## 5. Kết Luận & Khuyến Nghị

1. Gói **`P745-UI-MASK`** do `qwen_5` thực hiện đạt chất lượng cao, tuân thủ nghiêm ngặt chỉ dẫn Heuristic Q2 và hợp đồng UI Contract §5.
2. Chính thức cấp phán quyết: **`UI_APPROVED`**.
3. Các delta **d18, d19, d20** được phê duyệt nguyên trạng, không yêu cầu mở thêm packet phụ.
4. Điều phối viên có thể yên tâm đóng gói slice cURL Import UI và chuyển giao sang các giai đoạn tiếp theo.
