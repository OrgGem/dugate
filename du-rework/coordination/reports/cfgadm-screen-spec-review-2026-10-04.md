# Screen-Spec Review: CFGADM (Settings 17-Key, Connectors / cURL Import, Workflow Mappings)

- **Date:** 2026-10-04 18:45 +07
- **Reviewer:** Antigravity UI Lead (`term_ae2d7e42`)
- **Dispatch Task:** `task_08fa395438aa` · Dispatch `ctx_46410643f3c6` · Run `run_069ecd6957cd`
- **Spec Reference:** `du-rework/coordination/dispatch-specs/2026-10-04-1840-CFGADM-SCREEN-SPEC-REVIEW.md`
- **Governing Plans & Contracts:**
  - `du-rework/tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md`
  - `du-rework/docs/admin-ui-development-contract.md` (§3, §4, §5)
  - `du-rework/coordination/dispatch-specs/2026-10-04-1835-P730-CURL-IMPORT.md`
- **Scope & Mode:** READ-ONLY on source/plans; write receipt only; no source edits; no commit/push.

---

## 1. Executive Summary & Verdict

### ⚠️ Verdict: KHÔNG CẤP `UI_APPROVED` (SPEC_REVIEW_CONCLUDED)
Theo quy định tại **`docs/admin-ui-development-contract.md` §5**:
> *"Antigravity ghi verdict `UI_APPROVED` hoặc `CHANGES_REQUIRED` cho từng packet/route/build, kèm finding cụ thể và bằng chứng... Screenshot hoặc demo component riêng lẻ không đủ để duyệt màn."*

Tại thời điểm hiện tại:
1. **Settings screen** (`apps/admin-web/src/features/settings/settings-screen.tsx`) chỉ là catalog tĩnh ("requires deployment action"), hoàn toàn thiếu form controls cho 17 legacy keys.
2. **Connectors screen** (`apps/admin-web/src/features/connectors/connectors-screen.tsx`) là màn hình tra cứu revision read-only, chưa tích hợp catalog list, form tạo/sửa, và chức năng Import cURL. Component parser/preview cURL đang được `qwen_5` triển khai độc lập theo slice `P730-CURL-IMPORT` dưới dạng leaf files chưa mount.
3. **Workflow screen** chưa tồn tại trong `apps/admin-web/src/features/`.

Do đó, báo cáo này hoàn thành **Pre-implementation Screen-Spec Review** nhằm đóng băng spec, phân tích chênh lệch (gap analysis), lập hợp đồng component cho `qwen_5`, và cảnh báo các điểm xung đột kiến trúc trước khi bước vào giai đoạn code integration. **Tuyệt đối KHÔNG cấp verdict `UI_APPROVED` trước khi có integrated build và live browser evidence**.

---

## 2. Journey 1: Settings 17-Key Surface (CFGADM-01 / 02 / 03 / 04)

### 2.1. Hiện có gì (As-Is State in `apps/admin-web`)
File hiện tại: `apps/admin-web/src/features/settings/settings-screen.tsx`
- Chỉ hiển thị một bảng thông tin tĩnh gồm 6 biến môi trường (`DU_ADMIN_WEB`, `ADMIN_SHELL_PORT/HOST`, `DU_ADMIN_AUTH_MODE`, `tenantAdminTokens`, `connectorBaseUrls`, `ENCRYPTION_KEY`).
- Mọi hàng đều gán nhãn `source: 'environment'`, `managedBy: 'DEP / ...'`, `effective: 'flag' | 'boot-time' | 'not managed'`.
- Banner thông báo: *"No deployment adapter on this build... no Save control is offered... Change a value on the deployment env/compose file and restart the orchestrator"*.
- Không có bất kỳ input field, save button, test action, secret management, hay revision tracking nào.

### 2.2. Thiếu gì (Parity Gap vs Root DUGate)
Đối chiếu với `tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md` §2 & §3:
Root DUGate quản lý 17 setting keys với 3 nhóm lưu trữ độc lập trên UI (`SettingsForm.tsx`):

| Nhóm Legacy | 17 Legacy Keys | Hiện trạng Rework | Yêu cầu Parity |
|---|---|---|---|
| **AI Defaults** | `ai_provider`, `ai_api_key`, `ai_model`, `openai_api_key`, `openai_base_url` | Thiếu 100% | 2 provider active (`gemini`, `openai-compatible`), custom model name, custom base URL, write-only credential (Keep/Replace/Clear), test connection action gọi mock/real provider |
| **Prompt Defaults** | `ai_image_prompt`, `ai_pdf_prompt`, `ai_docx_prompt`, `ai_compare_prompt`, `ai_generate_prompt` | Thiếu 100% | 5 prompt editors, bộ preset song ngữ (English/Vietnamese), placeholder syntax validation (`{user_prompt}`, `{input_content}`), diff so với default |
| **Storage & Retention** | `s3_endpoint`, `s3_bucket`, `s3_access_key`, `s3_secret_key`, `s3_region`, `s3_cache_ttl_hours` | Thiếu 100% | Endpoint S3/MinIO, bucket name, region, numeric cache TTL, write-only S3 access/secret, nút Test Bucket (HeadBucket/read-write probe), preview/cleanup cache & output stats |
| **Retired** | `api_secret_key` | Thiếu | Cần quyết định CONT ghi nhận retire chính thức trong catalog, không để trống |

### 2.3. Yêu cầu UI Contract cho Slice kế tiếp
1. **Lưu từng nhóm độc lập (Independent Group Mutation)**:
   - Giao diện phải chia thành 3 Card/Panel độc lập: `AI Defaults`, `Prompt Defaults`, `Storage & Retention`.
   - Mỗi nhóm có trạng thái dirty riêng, mutation riêng mang theo `expectedRevision` (CAS concurrency guard) và idempotency key.
   - Tuyệt đối không gửi form chung (PUT toàn bộ) làm vô tình ghi đè cấu hình nhóm khác.
2. **Xử lý Secret Write-Only**:
   - Sử dụng cơ chế 3 trạng thái tường minh cho `ai_api_key`, `openai_api_key`, `s3_access_key`, `s3_secret_key`:
     - `Keep`: Giữ nguyên secret hiện có trên server (UI chỉ hiển thị `••••••••`, payload gửi `{ action: 'keep' }`).
     - `Replace`: Nhập secret mới vào password input (payload gửi `{ action: 'replace', value: '...' }`).
     - `Clear`: Xóa secret (payload gửi `{ action: 'clear' }`), backend từ chối nếu policy bắt buộc credential.
   - Không lưu trữ secret trong draft state của browser, không đưa vào `localStorage` hay export JSON.
3. **Cơ chế Test Trước Khi Apply**:
   - Nút `Test Connection` (AI) và `Test Bucket` (S3) phải test dựa trên draft parameters hiện tại mà KHÔNG commit/publish revision.
   - Kết quả test hiển thị rõ HTTP status, latency, error details (đã sanitize, không leak key).
4. **Phân định Rõ Desired vs Effective Revision**:
   - Cung cấp badge trạng thái: `draft`, `pending activation`, `active`, `rollback available`.

### 2.4. Rủi ro & Cảnh báo (Risks)
- **Rủi ro Ghi đè Mask (`Masked Overwrite`)**: Nếu frontend serialize input hiển thị `••••••••` gửi lên backend làm key mới. Bắt buộc dùng pattern action `keep`/`replace`/`clear`.
- **Nhập nhằng Deployment vs Dynamic Config**: Giao diện cần phân tách rõ giữa **Cấu hình Hạ tầng Boot-time** (chỉ đọc, do Docker Compose/k8s quản lý) và **Cấu hình Vận hành Dynamic** (Admin chỉnh sửa và lưu vào DB/Vault có revision).

---

## 3. Journey 2: Connectors & Import cURL (CFGADM-07 & qwen_5 implementation)

### 3.1. Hiện có gì (As-Is State in `apps/admin-web`)
File hiện tại: `apps/admin-web/src/features/connectors/connectors-screen.tsx`
- Giao diện tra cứu revision đơn lẻ bằng `connectorId` + `revision`.
- Gọi client `createAdminApiClient().getConnectorRevision(id, rev)`.
- Render thông tin cơ bản: adapter name, masked endpoint host, danh sách capabilities, số lượng secret slots, updatedAt.
- Hai nút `Test credential` và `Rotate secret` bị vô hiệu hóa cứng (`disabled`) với tooltip giải thích do thiếu upstream capability (`F3/PAR-03/14`).
- Không có danh sách catalog connectors, không có form tạo connector mới, không có chức năng import.

### 3.2. Thiếu gì & Handoff Spec cho `qwen_5` (`curl-import.ts` + `curl-import-preview.tsx`)
Theo dispatch spec `2026-10-04-1835-P730-CURL-IMPORT.md`, `qwen_5` đang được giao tạo 3 leaf files độc lập:
1. `apps/admin-web/src/features/connectors/curl-import.ts`
2. `apps/admin-web/src/features/connectors/curl-import-preview.tsx`
3. `tests/browser/admin-web/p730-curl-import.spec.ts`

Để đảm bảo slice của `qwen_5` có thể tích hợp mượt mà vào `ConnectorsScreen` ở slice `P730-UI-INTEGRATE`, Antigravity đưa ra **Hợp đồng Screen-Spec** bắt buộc như sau:

#### A. Parser & Preview Model Contract (`curl-import.ts`)
```typescript
export interface ParsedCurlResult {
  endpointUrl: string;
  httpMethod: 'POST' | 'PUT';
  authType: 'NONE' | 'BEARER' | 'API_KEY_HEADER';
  authKeyHeader?: string;       // e.g. 'x-api-key', 'authorization'
  authSecretStaged?: string;    // Write-only staging (chỉ giữ trong memory lúc preview)
  authSecretMasked: string;     // '••••••••' để render an toàn trên UI
  extraHeaders: Array<{ key: string; value: string }>;
  staticFormFields: Array<{ key: string; value: string }>;
  detectedPromptField?: string; // Tự detect field 'query', 'prompt', 'text'
  detectedFileField?: string;   // Tự detect field có prefix '@' hoặc tên 'files', 'file'
  unsupportedFlags: string[];   // Các flag shell không hỗ trợ: -k, --insecure, -o, --output...
  parseErrors: string[];        // Lỗi cú pháp, unmatched quotes, invalid URL
}

export interface StagedConnectorImport {
  endpointUrl: string;
  httpMethod: 'POST' | 'PUT';
  authType: 'NONE' | 'BEARER' | 'API_KEY_HEADER';
  authKeyHeader: string;
  authSecret: string;
  extraHeaders: Record<string, string>;
  staticFormFields: Record<string, string>;
  promptFieldName: string;
  fileFieldName: string;
}
```

#### B. Component Preview Contract (`curl-import-preview.tsx`)
- **Props interface**:
  ```typescript
  export interface CurlImportPreviewProps {
    parsed: ParsedCurlResult;
    onAccept: (imported: StagedConnectorImport) => void;
    onCancel: () => void;
    isSubmitting?: boolean;
  }
  ```
- **Hành vi UI bắt buộc**:
  - Hiển thị badge trạng thái parse: `Valid` (xanh), `Warnings` (vàng nếu có unsupported flags), `Error` (đỏ nếu URL rỗng hoặc cú pháp vỡ).
  - Preview bảng Headers và Form Fields cho phép người dùng kiểm tra hoặc xóa từng dòng trước khi áp dụng.
  - Secret hiển thị ở dạng masked (`••••••••`), kèm checkbox/toggle xác nhận nạp credential.
  - Nút `Apply to Connector Form` bị `disabled` nếu có lỗi nghiêm trọng trong `parseErrors`.
- **Token Design Conformance**:
  - Dùng đúng primitives của `@/components/ui/`: `Button`, `Card`, `Badge`, `AlertBanner`, `Input`.
  - Dùng CSS tokens (`var(--surface-card)`, `var(--border-subtle)`, `var(--text-main)`), không dùng custom color codes.
  - Responsive reflow xuống tối thiểu `320px`.

#### C. Quy chuẩn An toàn (Security Hardening)
1. **Không Shell Execution**: Tuyệt đối không dùng `eval()`, `child_process`, hay regex execution cho phép command substitution. Bắt buộc reject ngay lập tức nếu phát hiện `$(` hoặc ký tự backtick ``` ` ``` trong text cURL.
2. **Không Rò rỉ Secret vào Storage**:
   - Tuyệt đối KHÔNG lưu `importCurlText` hoặc `authSecretStaged` vào `localStorage`, `sessionStorage`, URL query, console log, hay test reports.
   - Khi component unmount hoặc người dùng bấm `Hủy`, state memory phải được dọn dẹp sạch sẽ.
3. **Phân định 3 Cấp độ Test**:
   - `Readiness probe`: Ping URL kiểm tra DNS / SSL / network reachable.
   - `Credential test`: Xác thực API key qua Vault / connector adapter.
   - `Live invocation test`: Gửi multipart form với prompt + test files thực sự để kiểm tra parsing output (`responseContentPath`). Ba hành động này không được gộp làm một.

#### D. Vị trí Mount (Mount Location Spec cho Slice Tích hợp)
- Trong `apps/admin-web/src/features/connectors/connectors-screen.tsx`:
  - Thêm header button: `Import from cURL` cạnh nút `Create Connector`.
  - Mở Dialog / Sheet nhập cURL thô, render component `CurlImportPreview` ngay bên dưới.
  - Sau khi `onAccept`, dữ liệu được load vào Connector Creation Wizard / Editor.

---

## 4. Journey 3: Workflow Mappings (CFGADM-09)

### 4.1. Hiện có gì (As-Is State in `apps/admin-web`)
- Thư mục `apps/admin-web/src/features/workflows/` **chưa tồn tại**.
- Màn hình `businesses-screen.tsx` hiện chỉ quản lý định nghĩa Business đơn giản (tên, slug, danh sách profiles), hoàn toàn không chứa luồng Workflow DAG hay mapping nodes.

### 4.2. Thiếu gì (Parity Gap vs Root DUGate)
Root DUGate cung cấp `app/workflow-builder/page.tsx` và `lib/workflow-builder/types.ts` với đầy đủ:
1. **Import Workflow Schema (JSON & XML)**:
   - Import JSON workflow schema định nghĩa input properties và danh sách nodes.
   - Import legacy XML workflow definition.
2. **Workflow Schema Inspection**:
   - Xem cấu trúc Schema Inputs (`InputSchema`: kiểu dữ liệu, nhãn, widget type, required).
   - Danh sách 10 loại nodes chuẩn: `connector`, `parallel`, `join`, `file_parse`, `file_url_download`, `callback`, `archive_compress`, `archive_extract`, `human`, `input`.
3. **Node Overrides (Edit-as-Revision)**:
   - Cho phép chỉnh sửa cấu hình override trên từng `connector` node:
     - `overrideConnector.prompt`: Ghi đè prompt mặc định.
     - `overrideConnector.staticFormFields`: JSON string chứa các static fields bổ sung.
     - `overrideConnector.extraHeaders`: JSON string chứa custom HTTP headers.
     - `overrideConnector.responseContentPath`: Dot-path trích xuất kết quả từ output.
     - `overrideConnector.timeoutSec`: Timeout override.
4. **Execution & HITL Lifecycle**:
   - Chạy workflow test (`schemaSlug run`).
   - Tạm dừng duyệt Human-in-the-loop (HITL) cho node loại `human`.

### 4.3. Yêu cầu UI Contract cho Slice kế tiếp
1. **Ranh giới Tính năng (Scoping Boundary)**:
   - Kế hoạch `ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md` §1 quy định rõ:
     > *"Graph designer mới và export UI là enhancement, không là blocker parity."*
   - Do đó, UI mới KHÔNG cần xây dựng trình kéo thả Canvas phức tạp (ReactFlow/DAG canvas). Thay vào đó, xây dựng **Structured Tree / List View** rõ ràng, trực quan cho Inputs, Nodes, Bindings và Overrides.
2. **An toàn Bảo mật khi Import**:
   - Backend BFF parser phải kích hoạt XXE / DTD protection, giới hạn payload kích thước tối đa 512KB, giới hạn độ sâu JSON/XML nesting tối đa 16 levels.
   - Tuyệt đối từ chối các node type lạ không nằm trong danh sách 10 types hợp lệ của `types.ts`.
3. **Mô hình Bất biến & Pin Revision**:
   - Thao tác sửa node overrides phải sinh ra schema revision mới (CAS `expectedRevision`).
   - Khi một Operation đang chạy với workflow revision cũ, việc publish revision mới không được làm ảnh hưởng đến operation đang chạy.
4. **Ranh giới Thực thi (Worker Delegation)**:
   - Admin Web chỉ làm nhiệm vụ Catalog, Schema Editor, và trigger submit Operation tới `/admin/api/operations`.
   - Việc thực thi workflow do P9 Worker đảm nhiệm bất đồng bộ; UI không gọi runner đồng bộ trực tiếp trong BFF.

---

## 5. Bảng Đối Chiếu Quy Chuẩn UI Contract (docs/admin-ui-development-contract.md)

| Tiêu chuẩn Contract | Yêu cầu Quy định | Đánh giá Hiện trạng & Hướng dẫn cho Slice tiếp theo |
|---|---|---|
| **§1 Framework & Styling** | React + Vite + Tailwind CSS + CSS variables shadcn | Tuân thủ. Tất cả component mới phải dùng biến CSS `var(--*)`, không định nghĩa thêm bảng màu độc lập. |
| **§1 BFF Architecture** | Browser chỉ gọi `/admin/api/*` cùng origin qua session cookie; không nhận token trực tiếp | Bắt buộc tuân thủ. Secret cURL import hay API key chỉ gửi qua BFF staging endpoint, không lưu local. |
| **§2 Layering & Lease** | Antigravity: UI primitives; Feature owners: Business logic; Integrator: Router & App shell | `qwen_5` chỉ viết component độc lập trong lease. Việc ghép vào `connectors-screen.tsx` sẽ do Integrator/Coordinator điều phối. |
| **§3 State Panels** | 5 states chuẩn: `loading`, `ready`, `empty`, `error`, `denied` | Cả Settings, Connectors và Workflow screens mới phải bao phủ đủ 5 states này. |
| **§3 Accessibility & 320px** | Semantic HTML, labels, keyboard navigation, reflow 320px | Component `curl-import-preview.tsx` và Settings form phải reflow mượt mà ở độ rộng màn hình 320px. |
| **§4 CSRF & CAS Concurrency** | Mutations gửi `X-CSRF-Token` và `expectedRevision` | Bắt buộc trên mọi mutation lưu AI defaults, Prompts, Storage, Connectors và Workflow overrides. |
| **§5 Review & Verdict** | `UI_APPROVED` chỉ cấp sau khi có integrated build và browser evidence | **KHÔNG CẤP `UI_APPROVED`** trong đợt review spec này. |

---

## 6. Danh Sách Cảnh Báo & Lệch Chuẩn (Δ-DEVIATION Flags)

> [!WARNING]
> ### Δ-DEV-01: Settings Screen Hoàn Toàn Tê Liệt Đối Với Parity
> File `apps/admin-web/src/features/settings/settings-screen.tsx` hiện tại chỉ là placeholder thông tin môi trường với thông báo "requires deployment action". Điều này trực tiếp xung đột với yêu cầu cốt lõi của `ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md` (yêu cầu quản trị được 17 keys qua UI).
> **Khuyến nghị:** Cần lập packet `CFGADM-01` (AI), `CFGADM-02` (Prompts), `CFGADM-03` (Storage) để xây dựng form controls động song song với bảng deployment tĩnh.

> [!IMPORTANT]
> ### Δ-DEV-02: Phân Tách Lease Giữa qwen_5 và Integrator cho cURL Import
> Dispatch `P730-CURL-IMPORT` của `qwen_5` chỉ có lease trên 3 leaf files (`curl-import.ts`, `curl-import-preview.tsx`, `p730-curl-import.spec.ts`). `qwen_5` KHÔNG được phép sửa `connectors-screen.tsx`.
> **Khuyến nghị:** Sau khi `qwen_5` nộp receipt, Coordinator cần dispatch một packet riêng `P730-UI-INTEGRATE` cho Integrator để mount dialog import vào `ConnectorsScreen`.

> [!NOTE]
> ### Δ-DEV-03: Kế Hoạch Định Vị Màn Hình Workflow
> Cần thống nhất vị trí mount cho Workflow trong router Admin Web: trở thành một top-level navigation item `/admin/workflows` hoặc một tab chuyên dụng trong `/admin/businesses`. Top-level tab được khuyến nghị để bảo đảm tính tương đương với legacy menu.

---

## 7. Kết Luận & Hành Động Kế Tiếp

1. **Receipt Status:** Hoàn tất đầy đủ việc rà soát screen-spec cho 3 journeys theo yêu cầu của packet `CFGADM-SCREEN-SPEC-REVIEW` (`task_08fa395438aa`).
2. **Quy chuẩn Verdict:** Giữ vững nguyên tắc hợp đồng — **KHÔNG CẤP `UI_APPROVED`**. Chỉ cấp sau khi các slice implementation được tích hợp vào build và vượt qua browser verification tests.
3. **Tiếp tục Giám sát:** Tiếp tục duy trì nhịp audit 30 phút (`task-233`) để theo dõi tiến độ của `qwen_5`, Coordinator và các lane liên quan.
