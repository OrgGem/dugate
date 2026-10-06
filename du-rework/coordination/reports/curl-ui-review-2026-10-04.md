# UI Review Receipt: CURL-IMPORT Leaf & Open Questions Q1/Q2/Q3

- **Date:** 2026-10-04 19:38 +07
- **Reviewer:** Antigravity UI Lead (`term_ae2d7e42`)
- **Dispatch Task:** `task_2f948281c7bf` · Dispatch `ctx_297fda93eb9c` · Run `run_069ecd6957cd`
- **Spec Reference:** `du-rework/coordination/dispatch-specs/2026-10-04-1935-CURL-UI-REVIEW.md`
- **Reviewed Artifacts:**
  - `du-rework/coordination/reports/p730-curl-import-2026-10-04.md` (qwen_5 receipt)
  - `du-rework/apps/admin-web/src/features/connectors/curl-import.ts` (593 lines)
  - `du-rework/apps/admin-web/src/features/connectors/curl-import-preview.tsx` (240 lines)
  - `du-rework/tests/browser/admin-web/p730-curl-import.spec.ts` (245 lines)
- **Governing Contract:** `du-rework/docs/admin-ui-development-contract.md` (§3, §4, §5)
- **Mode & Constraints:** READ-ONLY on source/plans; write receipt only; no source edits; no commit/push.

---

## 1. Verdict & Scope Boundary

### ⚠️ Verdict: KHÔNG CẤP `UI_APPROVED` (COMPONENT_SPEC_VERIFIED / INTEGRATION_PENDING)

Căn cứ theo **`docs/admin-ui-development-contract.md` §5**:
> *"Antigravity ghi verdict `UI_APPROVED` hoặc `CHANGES_REQUIRED` cho từng packet/route/build, kèm finding cụ thể và bằng chứng... Review trên route/browser và diff source; screenshot hoặc demo component riêng lẻ không đủ để duyệt màn."*

**Đánh giá tổng quát cho slice `P730-CURL-IMPORT` của `qwen_5`:**
1. Hai leaf files (`curl-import.ts` và `curl-import-preview.tsx`) được thiết kế với chất lượng cao, phân định ranh giới bộ nhớ chặt chẽ (hai shape: `CurlImportDraft` mang secret in-memory và `CurlImportSummary` hoàn toàn sạch secret cho preview).
2. Mã nguồn tuân thủ nghiêm ngặt hệ thống design tokens, accessibility, reflow 320px, và nguyên tắc không thực thi lệnh shell (zero eval/child_process).
3. **Tuy nhiên**, đây là các unmounted leaves (chưa được đưa vào bundle Vite của `apps/admin-web`, chưa mount vào route `/admin/connectors`, test suite Playwright còn mang trạng thái **SKIP** do chưa có runner/browser harness chạy thật).
4. Do đó, Antigravity xác nhận **đạt chuẩn kỹ thuật leaf component**, nhưng **KHÔNG CẤP `UI_APPROVED`** tại packet này. Verdict `UI_APPROVED` sẽ được xem xét sau khi hoàn thành packet tích hợp `P730-UI-INTEGRATE` với browser evidence thực tế.

---

## 2. Đánh Giá & Đề Xuất Hướng Xử Lý Cho 3 Câu Hỏi Mở (Q1 / Q2 / Q3)

### 2.1. Câu hỏi Q1: Fail-Closed vs Legacy Silent-Accept
* **Bối cảnh:** Trong bản cũ (`app/api-connections/page.tsx:87`), hàm `parseCurl` bỏ qua trong im lặng các lỗi cú pháp (ví dụ: `-X` không có value thì mặc định thành `POST`, `-H` thiếu `:` thì âm thầm bỏ qua header đó, `-F` thiếu `=` thì bỏ qua form field, dấu ngoặc kép không đóng vẫn nhận). Trong bản mới của `qwen_5`, parser áp dụng fail-closed (báo lỗi cụ thể `FLAG_VALUE_MISSING`, `HEADER_MALFORMED`, `FORM_FIELD_MALFORMED`, `UNTERMINATED_QUOTE`, `COMMAND_SUBSTITUTION_UNSUPPORTED`).
* **Đánh giá Chuyên môn của Antigravity:**
  * Việc legacy silent-accept các lỗi cú pháp là một **anti-pattern nguy hiểm trong vận hành**. Khi operator dán một lệnh cURL chứa auth header hoặc static form fields nhưng bị gõ sai cú pháp (như thiếu dấu `:`), legacy âm thầm bỏ qua khiến connection được tạo ra mà **thiếu hụt authentication hoặc tham số nghiệp vụ**, dẫn đến lỗi 401/403 runtime rất khó debug.
  * Việc fail-closed kèm thông báo lỗi rõ ràng và vị trí token (`tokenIndex`) giúp người vận hành lập tức nhận biết và chỉnh sửa lệnh cURL trước khi nhập vào hệ thống.
* **Đề xuất của Antigravity:**
  1. **CHẤP NHẬN TOÀN BỘ CÁC CƠ CHẾ FAIL-CLOSED (Δ1–Δ4, Δ6–Δ10):**
     - Δ1 (`FLAG_VALUE_MISSING`), Δ2 (`HEADER_MALFORMED`), Δ3 (`FORM_FIELD_MALFORMED`), Δ4 (`METHOD_UNSUPPORTED`): Giữ fail-closed.
     - Δ6 (`BEARER_TOKEN_MISSING`), Δ7 (`UNTERMINATED_QUOTE`), Δ8 (`COMMAND_SUBSTITUTION_UNSUPPORTED`), Δ9 (`NOT_A_CURL_COMMAND`), Δ10 (`URL_SCHEME_UNSUPPORTED`): Giữ fail-closed vì lý do an toàn bảo mật bắt buộc.
  2. **GIỮ CƠ CHẾ NOTES CHO CÁC FLAG KHÔNG ẢNH HƯỞNG (Warning/Info):**
     - Các flags như `--compressed`, `-s`, `--location`, `--globoff` tiếp tục được phân loại vào `notes` (`FLAGS_IGNORED`) kèm banner cảnh báo màu vàng, không chặn import.

---

### 2.2. Câu hỏi Q2: Heuristic Masking cho Form Fields
* **Bối cảnh:** `curl-import.ts` hiện tại che giấu 100% giá trị của mọi header (`preview: set (N chars)` cho non-secret, `****1234` cho secret). Đối với form fields (`-F`), parser dùng heuristic danh sách `SECRET_NAMES` + `SECRET_NAME_FRAGMENTS` (`token`, `secret`, `password`, `key`, v.v.) để mask. Các form fields thông thường (ví dụ `model=gpt-4o`, `prompt=hello`) được hiển thị tối đa 120 ký tự trong preview. Rủi ro tồn đọng: nếu operator đặt tên field nhạy cảm dị biệt (như `session-id`, `auth-blob`), giá trị có thể hiển thị trong preview.
* **Đánh giá Chuyên môn của Antigravity:**
  * Nếu áp dụng **All-Value Masking** (che giấu toàn bộ giá trị form fields): Operator sẽ hoàn toàn không thể kiểm tra xem parser đã bóc tách đúng tham số cấu hình tĩnh hay chưa (ví dụ: `model`, `version`, `language`, `temperature`). Điều này làm mất đi giá trị cốt lõi của tính năng Preview.
  * Nếu chỉ dựa vào heuristic cứng: Luôn tồn tại trường hợp ngoại lệ rò rỉ secret không chuẩn.
* **Đề xuất của Antigravity:**
  1. **Giữ nguyên Heuristic Hiện Tại làm Mặc định Tự động:** Các trường khớp với `SECRET_NAMES` / `SECRET_NAME_FRAGMENTS` tự động gắn `Badge: warning ("secret")` và che giấu dạng `****1234`.
  2. **Bổ sung vào Hợp đồng `P730-UI-INTEGRATE`:**
     - Trong bảng `Imported form fields`, bổ sung thêm một nút toggle hoặc icon con mắt `[ 👁️ Mask / Unmask ]` cho từng hàng.
     - Nếu phát hiện trường nhạy cảm không nằm trong từ điển, operator có thể click ngay tại preview để chuyển trường đó sang trạng thái `secret` trước khi bấm Apply.
  3. **Bảo toàn An toàn Tuyệt đối cho Headers:** Tiếp tục duy trì quy tắc: **Không bao giờ hiển thị giá trị thô của bất kỳ Header nào** trên preview (chỉ hiển thị số lượng ký tự hoặc fingerprint).

---

### 2.3. Câu hỏi Q3: Phạm vi của `onApply` Callback (Accept-Only)
* **Bối cảnh:** `qwen_5` đã chủ động bổ sung prop `onApply?: (draft: CurlImportDraft) => void` và nút bấm `Apply to connection` trong `curl-import-preview.tsx`. Coordinator đặt câu hỏi: nên giữ `onApply` theo hướng accept-only (đẩy dữ liệu vào form cha) hay biến leaf này thành presentational thuần túy (bỏ nút bấm)?
* **Đánh giá & Đề xuất của Antigravity:**
  * **HOÀN TOÀN ĐỒNG THUẬN VỚI ĐỀ XUẤT CỦA COORDINATOR — GIỮ `onApply` THEO CHẾ ĐỘ ACCEPT-ONLY:**
    * Một component Import mà không có callback chuyển giao dữ liệu thì không thể tích hợp được vào flow nghiệp vụ.
    * Ranh giới phân tầng: `CurlImportPreview` là một controlled leaf component. Nó **không gọi API**, **không lưu storage**, **không mutate backend**.
    * Khi operator bấm `Apply to connection`, component chỉ phát sự kiện `onApply(draft)` đưa dữ liệu đã bóc tách (kèm secret staged trong memory) lên form cha (`ConnectorsScreen`).
    * Tại form cha, operator vẫn phải rà soát, bổ sung các thông tin chưa có từ cURL (như tên connector, timeout), và chủ động bấm nút "Lưu Connector" (gửi kèm CAS `expectedRevision` và CSRF token). Cơ chế này hoàn toàn đúng đắn và chuẩn mực.

---

## 3. Rà Soát Tuân Thủ UI Development Contract (§3, §4, §5)

| Tiêu chuẩn Quy định | Hiện trạng Triển khai của Slice | Đánh giá & Khuyến nghị |
|---|---|---|
| **Hệ thống Design Tokens** | Dùng biến CSS: `var(--radius-sm)`, `var(--border-dark)`, `var(--bg-card)`, `var(--text-sub)`. | **ĐẠT (PASS)**. Hoàn toàn không tạo palette màu hoặc scale typography thứ hai. |
| **Bảo mật Secret (§4)** | Không dùng `localStorage`, `sessionStorage`, `console.log`, `fetch`. Tách 2 shape `Draft` (in-memory) và `Summary` (clean). | **XUẤT SẮC (EXCELLENT)**. Bảo vệ secret triệt để ngay từ tầng schema dữ liệu. |
| **5 Trạng thái Chuẩn (§3)** | `empty` (khi text rỗng), `error` (AlertBanner kèm mã lỗi/tokenIndex), `ready` (bảng preview). | **ĐẠT (PASS)**. Trạng thái `denied` thuộc quyền kiểm soát của App Shell / route cha. Trạng thái `loading` không cần thiết vì parser là synchronous pure function. |
| **Khả năng Reflow 320px (§3)** | `min-w-0`, `flex-wrap`, `break-words`, `TableContainer` cuộn ngang tự nhiên, grid 1 cột trên mobile. | **ĐẠT (PASS)**. Bố cục co giãn an toàn, không vỡ layout ở viewport hẹp. |
| **Tiếp cận & Bàn phím (a11y)** | Semantic HTML, `<dl>`, `<dt>`, `<dd>`, `aria-labelledby`, `aria-label` trên Table và Textarea. | **ĐẠT (PASS)**. Hỗ trợ tốt cho trình đọc màn hình và điều hướng phím. |
| **Ranh giới Layering (§2)** | Không import code legacy, không gọi BFF trực tiếp, nhận props và emit events. | **ĐẠT (PASS)**. Tuân thủ ranh giới giữa component leaf và feature screen. |

---

## 4. Các Khoảng Trống Kỹ Thuật Chuyển Tiếp Sang `P730-UI-INTEGRATE`

Để hoàn tất việc đưa tính năng Import cURL vào phục vụ người dùng thực tế, packet tiếp theo (`P730-UI-INTEGRATE`) cần giải quyết các mục sau:

1. **Mount vào Giao diện `ConnectorsScreen`:**
   - Bổ sung nút `[ Import cURL ]` tại phần header của danh sách Connectors hoặc bên trong Creation Modal.
   - Khi click, mở Dialog/Sheet chứa `CurlImportPreview`.
2. **Adapter DTO Mapping:**
   - Xây dựng hàm mapping từ `CurlImportDraft` sang state của form tạo Connector:
     - `endpointUrl` $\rightarrow$ `form.endpointUrl`
     - `httpMethod` $\rightarrow$ `form.httpMethod` (`POST` / `PUT`)
     - `auth.type` $\rightarrow$ `form.authType` (`NONE` / `BEARER` / `API_KEY_HEADER`)
     - `auth.secretValue` $\rightarrow$ nạp vào trường credential ở chế độ `replace` (không echo ra HTML)
     - `headers` $\rightarrow$ nạp vào danh sách `extraHeaders`
     - `formFields` $\rightarrow$ tự động map các trường không phải prompt/files vào `staticFormFields`
3. **Kích hoạt Browser Test Harness:**
   - Chạy test Playwright thực tế trên route đã mount (`ConnectorsScreen`) thay vì để trạng thái SKIP.
   - Cung cấp browser evidence (screenshot hoặc test trace) chứng minh luồng Paste $\rightarrow$ Preview $\rightarrow$ Apply $\rightarrow$ Form populated hoạt động trơn tru.

---

## 5. Kết Luận

1. **Kết quả Rà soát:** Hai leaf files của `qwen_5` đạt chuẩn cao về mặt kỹ thuật, an toàn dữ liệu và tuân thủ UI contract.
2. **Giải quyết 3 Câu hỏi:** Antigravity đã đề xuất cụ thể (chấp nhận fail-closed cho Q1; giữ heuristic kết hợp bổ sung manual toggle cho Q2; giữ cơ chế `onApply` accept-only cho Q3).
3. **Chuyển giao:** Sẵn sàng cho Coordinator dispatch gói tích hợp `P730-UI-INTEGRATE`.
