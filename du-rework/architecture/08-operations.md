# 08 — Bảo mật, quan sát và vận hành

## Ranh giới tin cậy và biện pháp bắt buộc

| Rủi ro | Kiểm soát thiết kế | Bằng chứng cần trước go-live |
|---|---|---|
| Lộ dữ liệu giữa tenant/key | Authorization trên operation, artifact, result, invocation; không tin tenant header | Cross-tenant negative E2E, cached replay recheck permissions |
| Worker giả hoặc đổi provider | Service identity scoped + signed grant gắn input hash/binding revision | Wrong audience/signature/expired grant/changed payload tests |
| Public truy cập Admin/Runtime | Tách ingress/routes, RBAC/session/CSRF và service auth | Internet probe không vào runtime; forged identity bị reject |
| SSRF qua URL/provider/webhook | Allowlist scheme/host, DNS/private IP/redirect checks, egress policy | Metadata IP, IPv6, DNS rebinding, redirect test cases |
| File độc hại/zip bomb | MIME signature, decompression byte/file/depth limits, traversal/symlink reject | Archive fixtures, timeout/RSS/temp disk limits |
| Parser lỗi/chạy quá lâu | Non-root container, giới hạn resources, scratch isolation, subprocess timeout | Kill parser không làm mất runtime heartbeat hoặc phá host |
| Prompt injection trong tài liệu | Tách instructions/data, profile khóa quyền, schema validate, không tự cấp tools | Adversarial corpus, không lộ secrets hoặc gọi external action tùy ý |
| Lộ credentials/prompts | Secret write-only/encrypted, role tối thiểu, log redaction | Scan logs/errors/audit; rotation/revocation test |
| Output HTML nguy hiểm | Treat output untrusted, escape/sanitize khi hiển thị/download | XSS và content-type/download tests |
| Lạm dụng quota/chi phí | Per-tenant admission, global provider cap, retry budget, deadlines | Multi-replica quota tests, usage reconciliation |

Một account AWS không loại bỏ yêu cầu tenant isolation. DB credentials chỉ cấp đúng Orchestrator hoặc Connector; worker không đọc trực tiếp DB. Artifact signed grants ngắn hạn, không xuất bucket credentials cho client. Encryption gồm TLS trên đường truyền và storage encryption; quy trình key rotation phải tính tới operation đang chạy.

## Dữ liệu đi ra provider

Profile xác định provider nào được nhận loại tài liệu nào. Trước production phải chốt: trường dữ liệu gửi, Region/provider processing location, retention của provider, logging/training setting theo hợp đồng sử dụng, xử lý PII, quyền xóa và người phê duyệt. Không suy ra các bảo đảm này từ việc hạ tầng chạy trên AWS account của mình.

Tài liệu đầu vào có thể chứa instructions độc hại; schema validation kiểm tra cấu trúc, không chứng minh tính đúng của thông tin. Với business quyết định quan trọng, workflow human review và evidence phải được thiết kế riêng. Redaction rule-based chỉ có phạm vi pattern đã kiểm thử.

## Retention và vòng đời dữ liệu

Các thời hạn phải chốt theo nghiệp vụ trước release, không hard-code vào tài liệu như chính sách đã được duyệt:

| Loại | Nguyên tắc retention |
|---|---|
| Staging artifact | TTL ngắn, cleanup orphan sau submit lỗi; không xóa file đã attach task |
| Source/result/checkpoint | Theo profile; giữ khi active operation/human wait còn cần resume |
| Invocation ledger/idempotency | Ít nhất bằng retry/replay window; không xóa trước khi dedup không còn cần |
| Usage/audit | Theo thời hạn đối soát/kiểm toán được thống nhất; corrections append-only |
| Temp files | Xóa sau task hoặc crash recovery; không dùng như backup |
| Backup | Lịch giữ riêng, có expiration; document deletion phải giải thích cả backup retention |

Xóa dữ liệu cần reconcile refs và object storage; S3 lifecycle không được xóa checkpoint active chỉ dựa vào tuổi object. Tenant delete/legal hold nếu cần là capability cần thiết kế/test, không được xem là có sẵn từ garbage collector.

## Observability và cảnh báo

Logs/traces dùng correlationId, operationId, taskId, stepKey, invocationId, business/version, leaseEpoch. Không log raw file, prompt, Authorization, API key hoặc signed URL. Metrics labels phải bounded (business/action/status), không dùng operationId/tenant tùy ý tạo cardinality vô hạn.

| Alert | Dấu hiệu | Hành động đầu tiên |
|---|---|---|
| Outbox backlog | Oldest outbox age vượt budget | Kiểm tra dispatcher claims, Redis connectivity, DB locks |
| Queue không xử lý | Runnable age tăng, không matching worker | Kiểm tra version/digest, readiness, heartbeat, capacity |
| Lease expiry tăng | Heartbeat timeout/stale completion | Kiểm tra parser event-loop blocking, CPU/RSS, runtime latency |
| Provider 429/timeout | Quota saturation hoặc provider outage | Giảm admission/dispatch, kiểm tra quota account và retry budget |
| UNKNOWN invocation | Không xác định provider outcome | Tra providerRequestId, reconcile trước retry |
| Usage lag | Connector outbox chưa ack | Khôi phục usage delivery; không tự xóa pending ledger |
| DB/Redis saturation | Connections/IO/memory/latency tăng | Chặn tải mới theo policy, sửa bottleneck; không flush queue |
| Artifact failures | Missing/finalize/hash/permission lỗi | Kiểm tra grants/storage/config; giữ task state để phục hồi |
| Webhook lag | Nhiều delivery thất bại | Kiểm tra endpoint/signature/SSRF policy, redelivery có audit |

Dashboard phải có queue wait và processing latency riêng, provider costs measured/estimated riêng, failed/cancelled/timeouts và accepted volume. Mỗi alarm có owner/on-call, severity và runbook; ngưỡng cuối cùng dựa trên benchmark.

## Backup và disaster recovery trên EC2

PostgreSQL tự quản cần backup nhất quán và WAL archiving/PITR hoặc giải pháp tương đương đã diễn tập; snapshot EBS đơn lẻ chưa chứng minh application-consistent restore. Backup phải mã hóa và lưu tách khỏi EC2 nguồn. S3 versioning hỗ trợ phục hồi object nhưng không thay thế chính sách backup và bảo vệ quyền xóa.

Redis persistence giảm mất queue, không là bản ghi nghiệp vụ duy nhất. Khi restore, task DB, invocation ledger và object checkpoint phải được reconcile; không restore queue cũ rồi phát lại toàn bộ inference một cách mù quáng.

**Mục tiêu đề xuất cần duyệt:** RPO platform/Connector DB ≤ 5 phút, RTO ≤ 60 phút cho kịch bản restore đã định nghĩa. Đây chưa phải cam kết đạt; asynchronous replication cũng không đồng nghĩa RPO=0. Phải ghi riêng mất instance, mất AZ, operator delete, corruption và mất Region; baseline một Region chưa có DR liên Region.

Diễn tập restore:

1. Đóng admission hoặc chuyển maintenance, ghi recovery point và ảnh hưởng người dùng.
2. Restore DB sang EC2 cô lập; xác minh schema, counts, refs, outbox và invocation states. Restore artifacts theo cùng recovery window khi cần.
3. Khởi động runtime với dispatch/provider calls bị chặn; reconcile lost tasks, leases, pending/UNKNOWN invocations, idempotency records và usage.
4. Kiểm tra synthetic operations, không gọi lại provider nếu chưa biết outcome cũ. Mở dispatch có kiểm soát, theo dõi duplicate/usage/queue age.
5. Ghi RPO/RTO đo được, dữ liệu mất nếu có, timeline, người quyết định và corrective actions.

## Runbook sự cố trọng yếu

**Provider outage:** giảm/đóng admission cho binding bị ảnh hưởng; giữ queued work trong deadline; circuit state không làm crash loop service. Không tự đổi provider/model khi có policy/quality/retention khác; nếu đổi, tạo revision và audit.

**Worker bị kill:** runtime lease hết hạn, task được recover; completed checkpoints được đọc lại. Xác minh stale worker không complete và logical inference không bị gọi mới khi ledger đã success.

**Redis mất dữ liệu:** dừng dispatch không kiểm soát, khôi phục Redis/config/ACL; reconstruct eligible deliveries từ DB; reconcile provider quota an toàn; kiểm tra duplicate delivery được runtime từ chối hoặc replay đúng.

**DB unavailable:** không trả 202 nếu chưa durable commit; trả 503. Worker ngừng bước cần grant/checkpoint khi không xác minh được lease. Kết quả provider đang bay có thể dẫn UNKNOWN, cần reconciliation.

**Rò rỉ key/secret:** revoke public key hoặc rotate provider credential, audit phạm vi, xử lý in-flight grants theo revocation policy, không xuất raw secret để điều tra. Lưu timeline và tenant bị ảnh hưởng.

**Rollback release:** chuyển profile/version, drain replicas mới, giữ workers cũ, đảm bảo migrations backward-compatible. Không dùng `git reset` hoặc xóa DB/Redis để rollback trạng thái nghiệp vụ.
