# 01 — Tổng quan ứng dụng và chức năng

## Bài toán và giá trị

DUGate cung cấp một giao diện thống nhất để các hệ thống bên ngoài xử lý tài liệu mà không phải tự quản lý parser, provider LLM, credentials, hàng đợi, retry và theo dõi tác vụ. Ứng dụng trả về operation ngay sau khi tiếp nhận; kết quả được lấy qua polling hoặc thông báo webhook. Tài liệu và kết quả lớn nằm ở object storage, không đi vòng qua Redis dưới dạng binary.

Người tích hợp dùng API key gắn profile. Quản trị viên quyết định key được dùng business/action nào, version nào, connector/model nào, prompt và giới hạn nào. Đội vận hành theo dõi hàng đợi, lỗi, usage, replay và tình trạng worker. Nhà phát triển business cung cấp image, manifest và schemas, không sửa logic nghiệp vụ vào Orchestrator.

## Sáu core API trong một business `document-core`

| API | Giá trị sử dụng | Các biến thể mục tiêu | Kết quả chính |
|---|---|---|---|
| `ingest` | Chuẩn hóa tài liệu đầu vào | parse, ocr, digitize, split | Text/Markdown, metadata, fields hoặc PDF đã tách |
| `extract` | Bóc dữ liệu có cấu trúc | invoice, contract, receipt, table, custom | JSON theo schema và cảnh báo thiếu/không chắc chắn |
| `analyze` | Đánh giá nội dung theo tiêu chí | classify, sentiment, compliance, quality, risk | Nhãn, điểm, findings và evidence nếu có |
| `transform` | Biến đổi nội dung/định dạng | convert, translate, rewrite, redact, template | Nội dung hoặc artifact sau biến đổi |
| `generate` | Tạo nội dung dựa trên tài liệu | summary, outline, report, email, minutes, qa | Tóm tắt, báo cáo, email, biên bản, câu trả lời |
| `compare` | So sánh hai phía tài liệu | diff, semantic, version | Thay đổi văn bản/ngữ nghĩa và changelog |

Phạm vi đang được mô tả trong spec rework: **6 action, 28 biến thể**, cùng một worker deployment `document-core`, có thể nhân bản nhiều replica. Endpoint nhiều không đồng nghĩa cần nhiều microservice. Registry gốc hiện có **31 biến thể core**, vì thêm `extract/id-card`, `analyze/fact-check`, `analyze/summarize-eval`; đây là chênh lệch scope cần chủ sản phẩm quyết định, chưa được xem là đã chấp thuận cắt bỏ.

Native parse/convert/diff có thể chạy cục bộ trong worker; OCR/vision/reasoning đi qua Connector khi recipe yêu cầu. Không cam kết giữ hoàn hảo layout, nhận dạng tuyệt đối chữ viết tay hay độ chính xác tuyệt đối của LLM. Đầu ra phải qua schema validation và đánh giá chất lượng theo corpus nghiệm thu.

## Business/workflow mở rộng

Một business mới, ví dụ `invoice-review`, có thể thực hiện ingest → extract → kiểm tra điều kiện → chờ người duyệt → tạo báo cáo. Các bước, nhánh và quyết định nằm trong worker của business đó. Generic coordinator trong Orchestrator chỉ quản lý task, dependency, wait, deadline và trạng thái.

API mục tiêu: `POST /api/v1/businesses/invoice-review/actions/review`. Đây là ví dụ extension, chưa phải business đã được triển khai. Không mặc định `/docs/workflows` cũ hoạt động trong rework. V1 child tasks nằm cùng business/version với parent; gọi chéo business cần contract bổ sung, không tự suy ra từ hỗ trợ workflow.

Thêm business gồm deploy image, đăng ký manifest, kiểm tra capabilities, admin enable và publish profile revision. Đăng ký thành công không tự cấp quyền cho API key. Orchestrator/Connector không đổi code nếu business chỉ dùng protocol, task types và adapter capabilities đã hỗ trợ. Provider protocol mới hoặc kiểu tương tác UI mới vẫn có thể cần thay đổi platform.

## Quản trị và kiểm soát

| Chức năng | Hành vi mục tiêu |
|---|---|
| Registry | Danh mục business/version, digest, schema, heartbeat/capacity; enable/drain/retire |
| Profile | Version pin, tham số mặc định/khóa, prompt overrides được cho phép, binding slots, quota |
| API key | Key gắn tenant/profile, raw key hiển thị một lần, revoke và audit |
| Connector | Quản lý config revision, capabilities, credential rotation, test có kiểm soát |
| Operation | Theo dõi tiến trình, kết quả, lỗi, cancel, human resume, operator replay |
| Usage | Tập hợp usage từ provider attempts, phân biệt estimated và measured, không đếm đôi parent |
| Artifact | Upload/download có quyền, expiry và dọn dữ liệu theo retention |

UI dùng schema trong manifest để hiển thị cấu hình business; không thực thi JavaScript tùy ý từ manifest. Profile revision mới áp dụng cho operation mới; operation đang chạy giữ snapshot để có thể giải thích và tái hiện quyết định.

## Phạm vi chưa cam kết

Chưa đưa vào baseline: marketplace code, sandbox chạy code do khách hàng upload, agent tự chọn tool tùy ý, arbitrary DAG editor, multi-region active-active, tính chính xác tài chính của usage chưa đối soát, migration/cutover production cũ. Các biến thể ngoài 28 mục trên cần yêu cầu và nghiệm thu riêng.

## Chức năng ở registry gốc cần quyết định chuyển sang rework

| Chức năng gốc | Ý nghĩa nghiệp vụ tham khảo | Cách biểu diễn dự kiến nếu được đưa vào scope |
|---|---|---|
| extract / id-card | Trích xuất trường CCCD/hộ chiếu từ tài liệu | Bổ sung schema/recipe/action variant document-core; không tự tuyên bố phát hiện giả mạo |
| analyze / fact-check | Đối chiếu nội dung với reference_data | Bổ sung variant với dữ liệu chuẩn và evidence; không coi là kiểm chứng toàn bộ kiến thức thế giới |
| analyze / summarize-eval | Tóm tắt và đánh giá nội dung | Bổ sung output schema tách summary/evaluation và tiêu chí |
| workflows / disbursement | Đối chiếu giải ngân: tách file, trích xuất song song, đối chiếu, tờ trình | Business worker riêng, schema input hồ sơ và resolution data, join/checkpoint |
| workflows / lc-checker | Kiểm tra bộ chứng từ Letter of Credit theo tiêu chí nghiệp vụ | Business worker riêng, bộ rule/reference được version hóa, evidence và review |
| workflows / doc-compare | So sánh văn bản dài theo mục và báo cáo chi tiết | Business worker riêng, phân mục/fanout/join, khác compare core đơn lẻ |

Đây là inventory từ [registry gốc](../../lib/endpoints/registry.ts), không phải xác nhận chất lượng các chức năng cũ. Rework chưa có public request/response đã freeze cho ba workflow này; không sao chép mô tả kiến trúc workflow cũ. Hợp đồng chuyển đổi phải được đặc tả trước khi hứa tương thích cho client.
