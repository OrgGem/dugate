# Benchmark Performance Plan & Execution Framework — 2026-10-06

Owner: codex_arch. Scope: ingestion, document extract/transform/analyze và webhook delivery dưới giới hạn tài nguyên. Không sửa product code, không commit/push.

**Trạng thái: SPECIFIED; execution NOT_RUN; verification/acceptance PENDING.** Báo cáo này là packet thực thi cho coordinator và tester; chưa dispatch agent, chưa tạo load hoặc thay đổi deployment. Không suy ra performance PASS từ functional receipts hay candidate build PASS.

## 1. Cơ sở và phạm vi phép đo

- [Compose entrypoint](../../docker-compose.yml), [worker](../../compose/document-core.yml), [infra](../../compose/infra.yml): deployment hiện tại cần benchmark override để áp hard quota. `DOCUMENT_CORE_CONCURRENCY` mặc định 2; bắt đầu thí nghiệm với 1.
- [Capacity targets](../../docs/22-p0-06-capacity-targets.md): chưa có SLA req/s hoặc latency được chốt; phân biệt giới hạn implemented với target unenforced. Không coi các ngưỡng thử nghiệm dưới đây là SLA release.
- [Scale/HA plan](../../tasks/SCALE-HA-2026-10-05.md): kiểm tra worker slots, provider quota, PG/Redis, heartbeat/lease và queue fairness; thêm replica trong cùng quota không đảm bảo tăng throughput.
- [OpenAPI](../../docs/21-openapi.json) là contract cho payload/action/result. [Extract harness](raw/phase-b-extract-resume-prep-2026-10-06/prepare-and-run-extract.cjs) chỉ là ví dụ admission/poll/result, không phải bằng chứng capacity.
- [Webhook dispatcher](../../services/orchestrator/src/modules/webhooks/webhooks.ts) và [bootstrap](../../services/orchestrator/src/app/bootstrap/create-app.ts) là nguồn đối chiếu production wiring. Batch size không được diễn giải thành số delivery song song.

Chỉ dùng fixture tổng hợp và provider mock xác định; không gọi AI trả phí. Load generator, provider mô phỏng bên ngoài và webhook receiver chạy ngoài quota SUT, ghi rõ latency của chúng. Nếu mock/storage/security component là thành phần nội bộ deployment thì phải tính vào quota. Không khái quát kết quả mock thành năng lực provider thật.

## 2. Resource profiles và enforcement

Quy ước của packet: **MB decimal**, worker RAM = **2,046,000,000 bytes**, toàn SUT = **4,092,000,000 bytes**; không làm tròn thành 2048/4096 MB. Nếu môi trường yêu cầu MiB, tạo profile riêng và ghi exact bytes để tránh so sánh sai.

| Profile | Hard cap | Ý nghĩa |
|---|---|---|
| W1 | document-core: 1 CPU, 2046 MB, không swap | Cô lập năng lực worker; control plane chạy ngoài cap này và vẫn phải được đo. Không gọi đây là benchmark toàn hệ thống 2 CPU. |
| S2 | Parent cgroup toàn SUT: 2 CPU, 4092 MB, không swap; worker vẫn tối đa 1 CPU/2046 MB | Bao gồm orchestrator, connector, document-core, PostgreSQL, Valkey và storage/security thực sự cần dùng. |

S2 phải có parent cgroup Linux dùng chung hoặc môi trường tương đương có hard cap tổng. Chỉ đặt quota từng container không đủ chứng minh cap tổng nếu bỏ sót container. Nếu dùng VM 2 CPU/4092 MB bao gồm OS, ghi profile `S2-host`, tính overhead OS, không trộn kết quả với `S2-container`. Không dùng riêng cấu hình Docker Desktop làm bằng chứng cap của SUT.

Phân bổ khởi điểm S2, cần idle preflight xác nhận khả thi:

| Thành phần | CPU quota | RAM MB |
|---|---:|---:|
| document-core | 1.00 | 2046 |
| orchestrator | 0.25 | 512 |
| connector | 0.15 | 256 |
| PostgreSQL | 0.25 | 512 |
| Valkey | 0.05 | 128 |
| Vault, nếu deployment cần | 0.05 | 128 |
| Object storage, nếu deployment cần | 0.10 | 192 |
| Headroom trong parent | 0.15 | 318 |
| Tổng | 2.00 | 4092 |

Đây là hypothesis phân bổ, không phải sizing production đã verify. Nếu service không boot/idle được, ghi `PROFILE_INFEASIBLE` và điều chỉnh phân bổ trong cùng tổng budget, giữ log; không âm thầm bỏ service cần thiết. Chỉ chạy worker document-core cho workload này; nếu bật lc-checker/example-review hay auxiliary khác, phải phân bổ lại budget và ghi manifest mới.

Benchmark-only Compose override cho W1 (lưu trong raw evidence, không sửa Compose sản phẩm):

```yaml
services:
  document-core:
    cpus: 1.0
    mem_limit: 2046000000
    memswap_limit: 2046000000
    environment:
      CONCURRENCY: "1"
```

Executor xác minh override environment khớp Compose resolved config và worker startup log. Với S2 thêm quota cho mọi service cùng parent đã tạo bởi runner; không dùng parent giả chưa tồn tại. Lưu `docker compose config`, inspect `HostConfig.NanoCpus/Memory/MemorySwap/CgroupParent`, và cgroup v2 `cpu.max`, `memory.max`, `memory.swap.max` của child/parent. Một CPU nghĩa quota một core-time, không mặc định pin một core vật lý. Lưu CPU model, kernel, Docker, Node/image digest, filesystem và host contention.

## 3. Workload matrix

Mỗi fixture có SHA-256, loại file, bytes/pages/chars, expected output/schema và seed. Smoke từng fixture ở concurrency 1 để xác nhận payload hợp lệ; lỗi 422 do harness không được gộp thành lỗi capacity. Tách thời gian upload/admission khỏi processing; cũng báo end-to-end gồm upload.

| ID | Workload | Fixtures và tham số | Bằng chứng thành công |
|---|---|---|---|
| B01 | Ingestion pipeline | PDF digital và DOCX: 1/10/50 pages, chọn file <=10 MB; thêm scanned PDF/OCR thành cohort riêng nếu pipeline hỗ trợ | Admission, terminal success, artifact tồn tại và nội dung kỳ vọng; ghi parser/OCR path |
| B02 | Extract | Invoice/text golden nhỏ/vừa/lớn, text <=100,000 chars; mock kết quả schema cố định | Fields/schema đúng, artifact/result đọc được; theo dõi pending/resume nếu có |
| B03 | Transform | Fixture và transform operation hợp lệ theo contract hiện hành, ba kích thước; input artifact từ B01 | Đúng format/nội dung kỳ vọng, không mất artifact; không gộp dependency generation vào latency độc lập |
| B04 | Analyze | Golden document nhỏ/vừa/lớn, prompt/profile cố định, mock output xác định | Schema/result đúng; ghi provider call count và latency |
| B05 | Mixed document | Ingest 30%, extract 30%, transform 20%, analyze 20%; size mix 60/30/10% nhỏ/vừa/lớn | Báo từng action/size và aggregate; đây là benchmark mix đề xuất, không phải traffic production |
| B06 | Concurrent webhook | Hai mode `notification_only`/`notification_with_result`; chia cohort no-auth và auth được wiring hỗ trợ; receiver delay 0/50/250/1000 ms | Correlation operation/delivery, đúng mode/auth/payload, receipt durable; kiểm tra duplicate logical delivery |
| B07 | Mixed + webhook contention | B05, callback cho 100% operations; mở 1/5/10 receiver destinations, đợt terminal gần đồng thời | Queue ops và webhook backlog, fairness, completion latency, CPU/PG contention |
| B08 | Resilience riêng | Receiver 429/500/timeout có lịch lỗi xác định; idempotent submission replay 1%; burst | Retry/backoff/lease recovery đúng; tách expected faults khỏi unexpected errors |

Các kích thước là fixture lựa chọn, không tuyên bố upload limit đã enforce. Body action lấy từ OpenAPI/canonical schemas, không sáng tác payload dựa trên tên action. Provider mock dùng delay cố định 50 ms cho baseline và 250/1000 ms cho sensitivity; ghi call count, throughput và CPU của mock để loại trừ bottleneck ngoài SUT.

Webhook concurrency là nhiều operation/receiver delivery cùng outstanding, không ép sửa dispatcher. Giữ batch/timer mặc định baseline; chỉ sweep knob đã expose qua deployment/config, lưu giá trị thật. Không monkey-patch production để tăng concurrency. Không inject DB delivery rows làm bằng chứng end-to-end; có thể làm microbenchmark riêng, gắn nhãn rõ.

## 4. Preconditions và trình tự execution

1. Freeze candidate image digests và source/spec/fixture hashes. Ghi commit + dirty diff hash, không dựa riêng vào tag mutable. Dùng namespace/database/bucket benchmark riêng; không chạy trên dữ liệu production.
2. Kiểm tra migration applied-state của đúng stack, đặc biệt callback policy/result delivery (0035 và migration bổ sung nếu candidate yêu cầu); kiểm tra admission snapshot và dispatcher mode → auth → send → receipt qua đường production. Mode/auth nào chưa wiring được ghi `BLOCKED`, không mock thay để tuyên bố live PASS. Security/storage giữ policy của candidate; không disable encryption/auth để lấy số đẹp.
3. Preflight idle 5 phút: readiness, quota đúng, không OOM/restart, đủ free space, clocks UTC đồng bộ; load generator không saturation. Smoke mỗi action/mode và golden output. Nếu thất bại, dừng cohort liên quan.
4. W1 rồi S2: single-action B01–B04, mixed B05, webhook B06–B07, cuối cùng B08. Worker concurrency sweep **1 → 2 → 4** trong cùng 1 CPU/2046 MB; giữ tất cả biến khác cố định và không suy ra 4 tốt hơn 1.
5. Open-loop arrival rate ladder **0.1, 0.25, 0.5, 1, 2, 4, 8 ops/s**; dừng tăng khi không ổn định. Dùng seed và lịch arrival cố định, ghi planned/actual send cùng generator dropped arrivals. Không dùng closed-loop concurrency để suy ra req/s capacity; closed-loop 1/2/4/8/16 clients chỉ là diagnostic bổ sung.
6. Mỗi điểm: warm-up 2 phút, measurement 10 phút, drain tối đa 10 phút; lặp 3 lần độc lập sau khi queue drain/restore fixture state. Warm-up không tính percentile; vẫn lưu raw. Tải chậm thiếu mẫu không kéo dài vô hạn để có p99: ghi `INSUFFICIENT_SAMPLES`.
7. Chọn λ* là điểm cao nhất đạt rubric cả 3 lần; thử soak 30 phút tại 70% λ*, rồi burst 2× λ* trong 60 giây và recovery tối đa 5 phút. Chỉ thực hiện nếu còn trong stop bounds.

Stop bounds mỗi run: tối đa 5,000 new operations; outstanding document backlog 500; OOM, unexpected restart hoặc mất lease/correctness lập tức dừng phát tải. Unexpected failures >5% trong cửa sổ 60 giây có ít nhất 20 requests, hoặc queue tăng liên tục 3 phút, dừng tăng tải và chuyển drain. Nếu drain quá 10 phút, ghi unfinished/censored và lưu trạng thái để điều tra; không reset DB để che failure. Receiver timeout injection có nhãn riêng để không kích hoạt nhầm criterion unexpected failure. Không reset dữ liệu ngoài namespace benchmark.

## 5. Metric definitions và thu thập

| Metric | Định nghĩa / cách thu thập |
|---|---|
| Offered ops/s | Scheduled new logical operations / measurement seconds; báo actual submissions và arrivals bị generator bỏ riêng |
| Admission req/s | Public submission HTTP attempts/s, chia accepted/rejected; retry/idempotent replay tách riêng |
| Total HTTP req/s | Submission + polling + downloads + management, phân route; không gọi tổng polling là business throughput |
| Completion ops/s | Unique logical operations terminal-success trong window/s; báo terminal-failed và cohorts khởi tạo trong window riêng để tránh tail/warm-up bias |
| Delivery throughput | Unique durable successful webhook deliveries/s; wire attempts/s và retries/s riêng; cả hai modes riêng |
| Admission latency | Actual HTTP send → response; thêm scheduled send → response để nhận diện generator delay/coordinated omission |
| Operation latency | Admission → terminal; scheduled arrival → result-accessible; upload-inclusive E2E riêng. Queue wait/active slot chỉ báo khi có timestamp/event đáng tin |
| Callback latency | Operation terminal → receiver arrival → durable receipt; receiver ACK/wire RTT riêng; tính end-to-end operation → delivery |
| Percentiles | p50/p95/p99 theo action, fixture size, mode và profile; histogram/raw samples, N, timeout/censored counts; không lấy trung bình percentile giữa runs |
| CPU / throttling | Sample 1 giây child và parent cgroup `cpu.stat`: CPU cores used = Δusage_usec/Δwall_usec; utilization = cores/quota; throttled periods ratio và Δthrottled_usec/Δwall_usec riêng, không diễn giải throttled time thành lost throughput |
| RAM / memory pressure | `memory.current`, peak, RSS/cache nếu available, `memory.events` high/max/oom/oom_kill, swap.current; aggregate parent là số tổng, không cộng parent với child |
| Saturation | Quota-normalized CPU, RAM headroom, queue age/depth slope, active slots, provider latency, PG connections/locks/slow queries, Redis memory/eviction/rejected writes, disk/network I/O |
| Errors / correctness | Unexpected HTTP 5xx/timeout rate theo HTTP attempts; terminal failures theo accepted unique ops; webhook failures theo deliveries và attempts riêng; missing/duplicate result, auth mismatch, lost job/lease, OOM/restarts riêng |

CPU/RAM sampling phải phủ warm-up, load, drain, recovery. Dùng cgroup raw làm nguồn quota/throttling; `docker stats` bổ trợ, không lấy phần trăm host làm utilization quota. Ghi overhead observer và không thêm metrics sidecar chưa tính vào S2.

Harness lưu monotonic durations + UTC timestamps, operationId/deliveryId/runId, tuyệt đối không ghi API key, token hay secret. Poll kết quả cố định 1 giây có jitter/seed và max polling clients; báo polling quantization tối đa xấp xỉ cadence, không tuyên bố precision millisecond cho terminal suy từ poll. Ưu tiên existing server timestamp/event read-only. Timeout không bỏ khỏi thống kê: trình bày count và bound, percentile success-only gắn nhãn rõ. p99 cần ít nhất 1,000 completed samples/cohort để báo exploratory tail, kèm N và spread giữa 3 runs; ít hơn chỉ ghi insufficient, không suy ra SLA.

Đối soát cuối drain: unique accepted = success + failed + cancelled (nếu contract có) + unfinished. Callback eligible = delivered + permanently failed + pending, tách mode. Duplicate wire attempts có thể hợp lệ trong at-least-once delivery; lỗi correctness là trùng logical receipt hoặc receiver không idempotent theo contract, không coi mọi retry là bug.

## 6. Evaluation rubric

Ngưỡng dưới đây là **benchmark qualification đề xuất**, không thay reviewer/release gate hoặc SLA chưa chốt:

| Điều kiện | Đánh giá |
|---|---|
| Resource cap đúng, provenance/fixture/golden smoke đủ | Run hợp lệ; sai cap hoặc generator/mock saturation ⇒ INVALID, không dùng capacity estimate |
| Không OOM/restart/lost operation/security mismatch/result corruption | Bắt buộc cho qualification; một occurrence ⇒ FAIL và finding có evidence |
| Baseline terminal success >=99%, unexpected HTTP failure <1%; webhook eligible baseline cuối drain >=99% delivered | Chỉ áp workload không inject lỗi; rate có denominator/N; fault cohort đánh giá policy/recovery riêng |
| Backlog không tăng bền vững sau warm-up, completed throughput theo kịp accepted; drain trong bound | Sustainable; nếu overload báo SATURATED và throughput thực tế, không tính λ* |
| Latency và CPU/RAM | Báo p50/p95/p99 + headroom ở từng load, điểm knee/throttling; chưa gán PASS cho absolute p95 chưa được chốt |
| 3 runs consistent, soak không memory/backlog growth liên tục; burst hồi phục trong 5 phút | Đủ evidence capacity đề xuất; báo variance và mọi outlier, không chọn riêng best run |

λ* là mức offered load đã đo, không extrapolate vượt ladder. Báo production planning rate sơ bộ **0.7 × λ***, giới hạn bởi provider quota và profile đã thử; đây là engineering headroom hypothesis. So sánh W1/S2 cùng fixture/rate/concurrency để xác định control-plane contention. Ước tính slots theo peak memory thực đo và occupied slot time; pending/yield wall time không tự coi là CPU slot occupancy.

Không kết luận throughput theo acceptance 202 đơn thuần. Một hệ thống ACK nhanh nhưng queue tăng hoặc callback thiếu vẫn chưa đạt benchmark qualification. Review độc lập kiểm tra raw metrics, quota và golden reconciliation trước VERIFIED; ACCEPTED cần verdict reviewer/coordinator theo gate hiện hành.

## 7. Execution packets và evidence layout

Coordinator gán owner theo roster/lease hiện hành; bảng này không tự cấp quyền dispatch hoặc thay task đang chạy.

| Packet | Deliverable | Dependency | Hiện trạng |
|---|---|---|---|
| BENCH-01 Environment | Benchmark-only manifest, digests, enforced quota, idle evidence | Frozen candidate và isolated namespace | SPECIFIED / NOT_RUN |
| BENCH-02 Harness | Contract-valid fixtures, seeded open-loop runner, receiver/mock, raw timestamp export; không sửa product | BENCH-01 smoke | SPECIFIED / NOT_IMPLEMENTED |
| BENCH-03 Measurement | W1/S2 matrix, 3 repeats, stop/drain logs, cgroup and operation evidence | BENCH-01/02, callback prerequisites | SPECIFIED / NOT_RUN |
| BENCH-04 Independent review | Recompute metrics/accounting; identify bottleneck and qualification verdict | BENCH-03 raw evidence | PENDING |

Raw evidence root: `coordination/reports/raw/benchmark-performance-2026-10-06/<profile>/<scenario>/<run-id>/`.

Required files: `manifest.json` (resources/units/image digests/source dirty hash/seed/fixture hashes/config/migrations), `requests.jsonl`, `operations.jsonl`, `webhooks.jsonl`, `resources.jsonl`, `generator-health.jsonl`, sanitized service logs, `stop-drain.json`, `summary.json`, `SHA256SUMS`. Record exact commands and exit codes. Harness and override thuộc benchmark artifacts, không patch product. Không lưu secrets trong resolved config; redact trước khi đưa vào receipt nhưng giữ digest của artifact an toàn.

Summary schema fields tối thiểu: runId/profile/scenario/rate/concurrency/windowSeconds; scheduled/sent/accepted/uniqueSucceeded/failed/unfinished; submissionReqPerSec/completionOpsPerSec/deliveryOpsPerSec/pollReqPerSec; per-cohort latency N/p50/p95/p99/censored; parent/worker CPU peak/utilization/throttling/memoryPeak/oom; backlog start/end/slope/drainSeconds; correctness findings; validity/qualification verdict và raw evidence pointers.

| Profile/scenario | Offered ops/s | Completed ops/s | Admission p95 | E2E p50/p95/p99 | CPU / throttle | Peak RAM | Error rate | Verdict |
|---|---|---|---|---|---|---|---|---|
| W1 / B01–B08 | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | PENDING |
| S2 / B01–B08 | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | NOT_RUN | PENDING |

## 8. Receipt cho packet lập kế hoạch

Đã tạo workload matrix, hai resource profiles, execution sequence, metric definitions, stop bounds, evaluation rubric và evidence contract. Chưa implement harness, chưa chạy benchmark, chưa đo performance; không đóng migration/release gate từ báo cáo này. Phạm vi thay đổi của packet chỉ là file Markdown này, không sửa product code.
