# Product scope và business requirements

## Bài toán

Ứng dụng bên ngoài cần một API ổn định để dùng năng lực xử lý tài liệu/LLM. Đội quản trị kiểm soát business, connector, model, prompt, giới hạn và quyền theo profile. Đội business phát triển worker riêng mà không bổ sung nhánh dispatch trong code platform.

## Actor

| Actor | Nhu cầu | Ranh giới quyền |
|---|---|---|
| API client | Submit, polling, đọc artifact, cancel/resume được cấp quyền | Chỉ tenant/profile/operation của mình |
| Administrator | Registry, connector, profile, credential, vận hành | Có audit cho mọi thay đổi |
| Operator | Xem trạng thái, lỗi, replay được cho phép | Không tự đọc credential |
| Business developer | Publish worker + manifest + tests | Không sửa dữ liệu platform trực tiếp |
| Worker identity | Claim task, checkpoint, connector call | Business/version/operation được cấp |

V1 dùng một tenant mặc định nhưng mọi khóa dữ liệu/quyền đã mang `tenantId`; triển khai multi-tenant UI đầy đủ không thuộc v1. API key liên kết một profile, nhiều key có thể cùng profile. Không dùng API key như chính profile.

## Functional requirements

| ID | Yêu cầu | Tiêu chí đạt |
|---|---|---|
| BR-01 | Sáu action document là một business | Một manifest, một worker image, sáu action được kiểm thử |
| BR-02 | Plugin business bằng registration | Business mẫu được thêm mà không build lại platform |
| BR-03 | Profile-driven routing | Profile pin business version, action, connector bindings, prompt, limits |
| BR-04 | Async operation | Submit nhanh, trạng thái/kết quả bền vững, polling có ownership |
| BR-05 | Quản lý artifact | Upload, đọc/ghi, TTL, quyền theo tenant/operation |
| BR-06 | Retry/checkpoint | Không mất full output đã hoàn thành; không ghi phí lặp |
| BR-07 | Business workflow | Worker sở hữu sequence/parallel/human step; runtime hỗ trợ lưu trạng thái |
| BR-08 | Cancel/resume | Idempotent, có kiểm soát race, không hồi sinh terminal operation |
| BR-09 | Provider gateway | Chuẩn hóa call/result/error, giới hạn dùng chung giữa replica |
| BR-10 | Admin cấu hình động | Business/action/parameter mới hiển thị theo manifest |
| BR-11 | Traceability | Trace operation → task → invocation → provider request |
| BR-12 | Isolation | Worker khác business không thể claim job hoặc dùng binding trái quyền |

## Use cases cần mô tả trước implementation

UC-01: Admin tạo connector và kiểm tra bằng mock; publish revision cấu hình.

UC-02: Publisher đăng ký manifest; admin enable business và gán action vào profile; cấp API key.

UC-03: Client upload file, submit extract invoice, nhận operation ID, polling và tải JSON/Markdown.

UC-04: Worker gọi provider lỗi tạm thời, retry bước lỗi; output bước trước giữ nguyên.

UC-05: Business mới dùng document-kit và connector SDK; deploy riêng, đăng ký và được dùng qua generic API.

UC-06: Workflow song song, một bước cần human input; restart worker, resume không chạy lại bước hoàn thành.

UC-07: Publish business v2; profile mới chuyển v2, operation cũ chạy đến hết bằng v1.

UC-08: Provider đã nhận request nhưng worker mất response; trạng thái UNKNOWN được xử lý có chủ đích, không tuyên bố exactly-once.

## Phạm vi release

**Release đầu đầy đủ:** registry/profile/auth, connector multipart + JSON adapter và mock, artifact S3-compatible, SDK runtime, document-core sáu action, UI quản trị, sample business chứng minh mở rộng, reliability/load tests.

**Release sau có task riêng:** các business disbursement/lc-checker/doc-compare và schema-workflow độc lập. Không mặc định migrate dữ liệu hoặc port nguyên trạng workflow designer cũ.

**Ngoài phạm vi:** triển khai model inference, orchestration arbitrary cross-business DAG, Kafka/service mesh, plugin upload JavaScript vào Orchestrator, bảo đảm exactly-once ở provider không hỗ trợ, production cutover tự động.

## Giả định capacity

Chưa có số liệu SLA, throughput và quota. Phase P0 tạo workload matrix: file bytes/pages, mix action, provider latency, calls/document, tenant concurrency, thời gian chờ human. Mọi SLO trong test chỉ là benchmark target trên mock, không phải cam kết production.
