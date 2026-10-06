# AWEB-UX-NAV-COMP-01 — Navigation and input audit

Yêu cầu trực tiếp của người dùng ngày 2026-10-05: kiểm tra input của Orchestrator Admin UI, chuyển layout sang left navigator; header chỉ chứa logo, thời gian và tài khoản (Profile, Logout).

Phạm vi implementation: React Admin Web tại `/admin/web/*`. Renderer cũ tại `/admin/*` vẫn là fallback hiện có; không đổi route rollout flags. Đây là packet do người dùng giao trực tiếp, không dispatch hoặc thay active coordinator ledger.

## Acceptance và đường đi

- Desktop: tất cả route của React router xuất hiện ở navigator bên trái, route đang mở có `aria-current=page`; header chỉ có brand, đồng hồ kèm timezone và account controls.
- 320px: navigator thu gọn, mở/đóng bằng button; không tràn ngang trang.
- Profile tài khoản hiển thị `displayName`, `role`, `scope` từ `GET /admin/api/session`; Logout dùng form `POST /admin/logout` hiện có. Không hiển thị CSRF token trong dialog.
- Business/Version có completion từ registry theo scope server, version suggestions cập nhật theo Business, không áp dụng response cũ khi Business đổi; vẫn nhập tay được khi lỗi/không có dữ liệu.
- Connector ID và revision có completion từ management list hiện đã tải; revision options lọc theo ID.
- Usage có calendar inputs, timezone UTC ghi trên label; chỉ gửi ISO UTC cho khoảng thời gian hợp lệ.

Luồng thay đổi: React shell → session BFF (read), logout route hiện có; BusinessInputs → businesses/versions BFF → registry; Connector lookup → list DTO đã parse trong screen; Usage calendar → usage BFF. Không thay service, DB, queue, worker hoặc wire DTO. Owner: Codex nhận yêu cầu trực tiếp. Các consumer: Profiles, Docs Test Workbench, Connectors, Usage và toàn bộ React router.

## Kết quả rà soát input

| Màn / trường | Dạng phù hợp | Nguồn lựa chọn / lưu ý | Trạng thái packet |
|---|---|---|---|
| Profiles: Business ID, Version | Completion phụ thuộc nhau | Businesses + versions BFF; vẫn cho nhập ID/version chưa có trong trang danh mục | Đã đổi |
| Docs Test Workbench: Business ID, Version | Completion phụ thuộc nhau | Cùng component với Profiles; chỉ tải khi workbench mở | Đã đổi |
| Connectors: ID, Revision lookup | Completion | Management list có capability gating; revision lọc theo ID, có `latest` | Đã đổi |
| Usage: from/to | Bộ chọn ngày giờ | Label UTC; serialize ISO UTC, khóa Load khi khoảng thời gian không hợp lệ | Đã đổi |
| Profiles: profileName khi load | Searchable selection + tạo mới | Cần endpoint list profile theo Business/Version/API key; hiện chỉ có detail endpoint | Đề xuất, chưa đổi |
| Profiles: allowedFileExtensions CSV | Multi-selection + cho thêm extension | Cần allowlist từ manifest/backend; không hardcode `.pdf,.docx` thành toàn bộ giá trị hợp lệ | Đề xuất, chưa đổi |
| Profiles: parameter values | Checkbox / number / select / completion theo schema | DTO hiện không mang type/enum/range/widget; không suy type từ chuỗi value | Cần bổ sung metadata contract |
| Profiles: connectionsOverride slug, stepId | Searchable selection | Cần connection/step catalog; connectorId và connection slug không cùng identity | Đề xuất, chưa đổi |
| Profiles: prompt connectionId, apiKeyId, endpointSlug, stepId | Selection phụ thuộc | Cần catalog đúng scope và mapping identity; API-key ID không phải raw API key | Đề xuất, chưa đổi |
| Profiles/Docs: endpointSlug | Selection từ manifest actions | Cần manifest theo đúng Business/Version trước khi chọn, không dùng danh sách cố định sáu endpoint legacy | Đề xuất, chưa đổi |
| Connectors import: adapter | Select hoặc completion | Adapter registry nằm ở Connector; BFF capability DTO hiện chỉ có booleans | Cần BFF adapter catalog |
| Connectors import: connector ID | Completion + tạo mới | Có thể tái dùng list khi phân biệt create/revision được thể hiện rõ | Đề xuất, chưa đổi |
| Security/API keys: tenant ID | Searchable selection | Cần tenant catalog dành cho platform admin; scoped role vẫn lấy tenant từ server session | Cần BFF tenant catalog |
| Security: storageKeyRef, recipientKeyVersion | Selection | Cần danh mục reference/version không chứa key material | Đề xuất, chưa đổi |
| Profiles: header_name | Completion cho header phổ biến + nhập tay | Không dùng selection đóng vì API tùy biến có header riêng | Đề xuất, chưa đổi |
| Identity: role; Profiles: priority, file URL auth type; Operations: state | Select | Các trường này đã dùng select | Giữ nguyên |
| Tên mới, username, password, token, secret value, URL, cURL, JSON | Text/password/textarea | Dữ liệu tự do hoặc write-only; không tạo completion/cache secret | Giữ nguyên |
| Settings / Workflows | Chưa có editor hoạt động trên React build này | Không tạo control giả khi backend chưa advertised | Giữ nguyên |

Native `datalist` được dùng cho completion nên cách hiển thị popup tùy browser; đây không phải combobox tùy biến hay danh mục đóng. Không lưu suggestions/secrets vào localStorage. Danh sách Business có thể phân trang nên không ép người dùng chỉ chọn các mục đã tải.

## Kiểm tra và giới hạn

- Cwd `D:/Git/dugate/du-rework`, `pnpm --filter @du/admin-web build`: typecheck và Vite build exit 0. Vite cảnh báo bundle >500 kB, không chặn build.
- Cwd `D:/Git/dugate/du-rework/tests/browser`, `pnpm exec playwright test --config admin-web/playwright.config.ts navigation-completion.spec.ts --output test-results-navigation-completion`: fixture browser tests. Session/registry/connector/usage responses được mock; không dùng DB/Redis/S3/Vault thật.
- Browser evidence: `tests/browser/artifacts/navigation-completion-desktop.png`, `navigation-completion-mobile.png`; đã kiểm tra ảnh desktop và 320px.
- Chưa kiểm chứng logout/session expiry trên backend live; test chỉ đối chiếu form với route hiện có. Chưa có verdict reviewer độc lập; không đánh dấu VERIFIED/ACCEPTED và không đổi rollout flag.
