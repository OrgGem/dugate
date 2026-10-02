# 07 — Khả năng mở rộng, sizing và kiểm thử tải

## Nguyên tắc

Scale độc lập Orchestrator, từng business worker và Connector. Database, Redis, S3 bandwidth và provider quota là giới hạn chung; thêm worker không tự tăng throughput nếu provider đã bão hòa. API nhận nhanh không đồng nghĩa document hoàn thành nhanh: cần đo riêng admission, queue wait, processing và end-to-end latency.

| Tầng | Tín hiệu | Hành động | Điểm chặn |
|---|---|---|---|
| Orchestrator | Request/target, CPU, event-loop lag, outbox age | Thêm EC2 replicas, phân phối request | DB pool, polling quá dày, loops không có distributed claim |
| Worker theo business/version | Ready backlog, oldest runnable age, active slots, CPU/RSS | Tăng EC2/concurrency có giới hạn | Parser CPU/RAM, provider cap, version không có worker |
| Connector | In-flight, latency, CPU, provider 429 | Thêm replicas khi Connector nghẽn | Global provider quota vẫn giữ nguyên |
| PostgreSQL | Connections, locks, IO, commit latency, table growth | Index, query/pool tuning, vertical scale, tách Connector DB | State writes không scale bằng read replicas |
| Redis | Memory, command latency, persistence lag | Giới hạn payload/retention, scale phù hợp | Không eviction queue keys để che thiếu RAM |
| Storage/network | Bytes/sec, temp disk, upload/download latency | Streaming, limits, bounded parallel I/O | File amplification, egress và page count |

Không dùng tổng số operation để scale workers: WAITING_INPUT, delayed retries và provider-pending không phải ready work. CPU đơn thuần cũng không phản ánh workers đang chờ mạng. BullMQ cần exporter riêng để đưa metric sang CloudWatch; AWS không tự đọc queue BullMQ.

## Công thức ước lượng

Đặt λ = jobs/giây; T = thời gian giữ worker slot trung bình (giây); c = slots/EC2; u = utilization mục tiêu (ví dụ 0,7). Số worker EC2 khởi điểm:

`N >= ceil(λ × T / (c × u))`

Đây là xấp xỉ steady-state, chưa tính tail latency, burst, failover, task mix và retry. Nếu job yield khi chờ provider/children, T là tổng thời gian slot thực sự bị giữ, không phải wall-clock toàn operation. Concurrency parser phải bị chặn theo memory: `slots <= floor((RAM khả dụng - overhead)/peak RSS mỗi task)` rồi benchmark lại.

Ví dụ **giả định**, không phải benchmark DUGate: 60 jobs/phút = 1 job/s; T=12s; c=4; u=0,7 → ceil(12/2,8)=5 worker EC2. Nếu mỗi job gọi LLM hai lần, cần ít nhất 120 calls/phút chưa tính retry; provider cap 90 calls/phút chỉ cho lý thuyết 45 jobs/phút. Thêm worker lúc đó chỉ tăng queue wait.

Với token quota: `λ <= token_budget_per_minute / (60 × expected_tokens_per_job)`. Phải tính cả input/output tokens theo cách provider định nghĩa và cộng retry headroom. Quota scope theo provider account/model/domain, không nhân quota với số Connector replicas.

## Autoscaling trên EC2

Mỗi business/version hoặc nhóm version tương thích có Auto Scaling group và image cấu hình rõ; warm-up gồm pull image, start tools, register/heartbeat, readiness. Tăng capacity theo backlog/ready worker hoặc utilization; oldest runnable age dùng alarm/step scaling với thresholds đo thực tế. Không scale-to-zero business có latency SLO nghiêm ngặt hoặc cần luôn sẵn sàng resume.

AWS target tracking hỗ trợ custom metrics nhưng metric cần phản ánh utilization và thay đổi tương ứng khi số instances thay đổi. Vì vậy backlog-per-ready-instance là ứng viên tốt hơn raw backlog; cần benchmark hệ số với BullMQ và workload thực tế. Đây là áp dụng nguyên tắc AWS vào thiết kế, không phải tính năng BullMQ tích hợp sẵn. [AWS EC2 target tracking](https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-scaling-target-tracking.html).

Scale-in bảo thủ hơn scale-out: cooldown, min replicas, drain claims, hoàn thành/checkpoint, lifecycle hook, termination grace. Không xóa replica cuối của version còn wait/snapshot cần resume. Max EC2 phải bị chặn theo ngân sách và quota provider; scale vô hạn không giải quyết provider outage.

## Backpressure và fairness

- Admission quota theo key/tenant/action, giới hạn file size/pages/fanout/active operations; trả 429/503 có Retry-After khi xác định được.
- Worker concurrency riêng local parser và provider tasks; child fanout bounded và parent yield để một hồ sơ lớn không chiếm hết slots.
- Global provider limiter dùng Redis atomic operations, lease expiry; khi limiter mất trạng thái phải hạn chế dispatch/reconcile, không mặc định mọi quota bằng 0 used.
- Không nhận vô hạn vào RAM Connector. Pending invocations persist rồi scheduling continuation. HTTP timeout và operation deadline độc lập.
- Cùng business nhiều tenants cần đo starvation; queue priority đơn thuần không bảo đảm fairness. Khi thực sự cần dedicated queues/worker groups cho khách lớn, phải thiết kế quota/routing qua platform thay vì cho client tự chọn queue.

## Load-test và mục tiêu nghiệm thu đề xuất

Các con số dưới là **mục tiêu cần chủ dự án chốt**, chưa phải SLA hoặc số đo đạt được:

| Chỉ số | Mục tiêu khởi điểm | Cách đo |
|---|---|---|
| Submit JSON sau artifact staging | p95 < 500ms, p99 < 1s | Không tính thời gian upload/provider |
| API availability | Đề xuất 99,9%/tháng cho topology HA | Định nghĩa excluded errors/maintenance rõ trước ký |
| Queue wait | p95 < 30s ở workload chuẩn | Từ durable accepted tới first claim; phân tách per business |
| Processing SLO | Chốt riêng mỗi loại file/provider | Không áp một số cho text 1 trang và OCR 500 trang |
| Queue recovery | Không mất logical task đã accepted trong fault tests | DB truth/outbox recovery, không hứa zero duplicate delivery |
| Quota | Không vượt configured cap trong concurrent replica test | Có log acquire/release/provider dispatch |

Ma trận benchmark bắt buộc: 1→2→4 replicas; small/medium/large file; native PDF/DOCX/XLSX; scan OCR; 31 variant validation; mixed action traffic; burst và sustained; provider 429/timeout/UNKNOWN; worker kill; API restart; Redis mất queue; DB restore/failover. Thời gian chạy cần đủ đạt steady-state và soak phát hiện memory/temp-file leaks, không chỉ burst vài giây.

Mỗi báo cáo ghi instance CPU/RAM/arch, image digest, concurrency, DB/Redis configs, page/file/token distribution, λ, provider mock latency/quota, dataset hash, p50/p95/p99, throughput, queue age, error/retry, RSS/CPU/IO và cost/job. Mock chứng minh cơ chế tải; corpus provider thật xác minh chất lượng và provider latency, có budget riêng.

## Chi phí và giới hạn mở rộng

Mô hình chi phí gồm EC2/EBS, ALB, NAT/egress, S3 storage/requests, observability, backup, provider tokens/pages và đội vận hành DB/Redis self-hosted. Không đưa đơn giá AWS vào sizing khi chưa biết Region/instance/workload. Cắt log payload nhạy cảm, lifecycle artifacts và bounded retries vừa giảm chi phí vừa giảm rủi ro dữ liệu.

Để bảo vệ đề xuất: trình bày throughput đã đo và bottleneck hiện tại, không cam kết “scale tuyến tính” hoặc “unlimited”. Chỉ tách thêm service parser/coordinator khi profile thực tế chứng minh cần isolation/scaling khác; ba vai trò hiện tại đủ làm baseline.
