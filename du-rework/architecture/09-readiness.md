# 09 — Hồ sơ bảo vệ kiến trúc và tiêu chí go-live

## Kết luận ở thời điểm lập tài liệu

Kiến trúc mục tiêu phù hợp với hướng ba tầng: Orchestrator quản lý giao tiếp/trạng thái, mỗi business có worker độc lập, Connector tập trung provider integration. Thiết kế cho phép scale theo vai trò và mở rộng business qua registration/profile trong phạm vi contract hiện có.

**Chưa đủ bằng chứng để kết luận sẵn sàng go-live.** Đây là kết quả đối chiếu source/docs ngày 20/09/2026, không phải đánh giá AWS đang vận hành và không phải báo cáo pentest/load test. Các agent có thể tiếp tục thay đổi source sau snapshot này.

## Bảng đối chiếu thiết kế và implementation

| ID | Quan sát tại thời điểm đọc | Ảnh hưởng | Điều kiện đóng |
|---|---|---|---|
| GAP-01 | `services/orchestrator` mới có README trong inventory; chưa thấy implementation API/runtime hoàn chỉnh | Chưa chứng minh public operation lifecycle | Build image và six-action E2E qua HTTP/DB/Redis/S3 |
| GAP-02 | Chưa thấy readiness gate files trong `coordination/gates` | Shared protocol chưa được xác nhận freeze | Publish contract/workspace/runtime/SDK gates với bằng chứng |
| GAP-03 | Worker có ResultEnvelope `{status,data,provenance,warnings}`; shared contract dùng `{schemaVersion,data,artifacts,usage,warnings}` | Không thể xem local worker output là public response | Một adapter/schema chính thức, contract tests producer/consumer |
| GAP-04 | Public top-level artifacts/output khác worker artifactIds/outputFormat; transform action/variant và compare side mapping cần thống nhất | Dễ bỏ sót file/format hoặc vượt quyền | Canonical normalization + negative/conflict tests |
| GAP-05 | Connector HTTP shell dùng routes không prefix `/internal/v1`, lowercase states và một số status khác spec | Runtime/client không wire-compatible mặc định | Freeze HTTP base/router mount/status/error mapping, smoke test |
| GAP-06 | Báo cáo Connector nêu concrete clients, production signed token verification và service-scope middleware còn follow-up | Local ports/tests không chứng minh durable/auth production | PostgreSQL/Redis thật, auth/grant negative tests và migrations |
| GAP-07 | Transform source có `sources.text.slice(0, 4000)` ở inference calls | Có thể mất nội dung dài dù success | Chunking có coverage hoặc reject size rõ; long-document tests |
| GAP-08 | Business manifest/output schemas còn khái quát; template binding, compare diff shape, webhook signing chưa freeze | Tài liệu chưa thể làm generated SDK contract hoàn chỉnh | OpenAPI + action JSON Schemas + webhook test vectors versioned |
| GAP-09 | `infra` chưa có bằng chứng topology EC2/IaC/restore được triển khai | HA/scale/RPO/RTO mới là đề xuất | IaC review, deploy rehearsal, fault/restore report |
| GAP-10 | Unit tests do lanes báo cáo; chưa có cross-service/load/security evidence trong snapshot | Không suy ra 31 variants sẵn sàng production | Chạy matrix tích hợp và quality corpus, lưu evidence |
| GAP-11 | Registry gốc có 31 core variants và 3 workflows. **Cập nhật 2026-10-02:** source rework hiện đã khai báo đủ 31 variant — ba variant từng là khoảng trống (`extract/id-card`, `analyze/fact-check`, `analyze/summarize-eval`) đã có handler, recipe, normalizer và validator. Khoảng trống còn lại **không còn ở code**, mà ở quyết định công bố compatibility scope | Chưa tự đóng: có code không bằng có cam kết sản phẩm | Product owner chốt đưa vào hoặc defer từng chức năng, công bố compatibility scope |
| GAP-12 | Compare source cắt snippets 3000 ký tự, fallback malformed JSON sang object summary và validate chỉ non-null object | Có thể success với kết quả thiếu nội dung/sai schema | Bounded chunking hoặc reject; validate output schema theo variant, không fallback success để che malformed output |

Nguồn trực tiếp: [shared DTO](../orchestrator/packages/contracts/src/operations.ts), [worker result DTO](../businesses/document-core/src/types/results.ts), [normalizer](../businesses/document-core/src/validation/input-normalizer.ts), [transform action](../businesses/document-core/src/actions/transform/index.ts), [Connector HTTP](../orchestrator/services/connector/src/http/server.ts), [Connector report](../coordination/reports/copilot.md). Đây là danh sách khoảng trống phục vụ review, không thay thế full code audit.

## Những khác biệt với tài liệu project gốc

| Chủ đề | Cách xử lý trong rework |
|---|---|
| `/api/upload`, `/api/transform`, NextAuth trong docs-site cũ | Là API giao diện ứng dụng cũ, không dùng làm public contract rework |
| `/api/v1/extract`, envelope `name/done/metadata` trong integration guide | Không mặc định hỗ trợ; canonical mới là business/action + Operation `id/state` |
| `id-card`, `fact-check`, `summarize-eval` có trong registry gốc | Đã có trong 31 variants của source rework (handler + recipe + validator); cần quyết định scope/parity có ghi nhận ra contract công bố |
| `mind_map` được mô tả trong integration guide | Không tự đưa vào enum rework nếu chưa có schema/implementation/test |
| Mô tả OCR/layout/handwriting rất mạnh | Chỉ cam kết theo parser/provider capability và corpus đo được |
| Workflow endpoint cũ | Không hứa import nguyên trạng; map workflow sang business worker theo spec riêng |
| Raw provider/prompt overrides | Profile kiểm soát, credential ở Connector, không client bypass |

Nếu cần giữ nguyên client cũ: phải có compatibility matrix theo route/field/status/result, facade tests và kế hoạch version/deprecation. Hồ sơ này không tự đổi hợp đồng của khách đang dùng production.

## Các quyết định cần trình bày

| Quyết định | Lý do chọn | Trade-off |
|---|---|---|
| Ba vai trò triển khai | Phân tách API/state, business compute, provider I/O rõ | Có HTTP/queue contracts cần quản lý version |
| Coordinator trong Orchestrator | Giảm số service và tránh business scheduler riêng | Background loops phải an toàn với nhiều replicas |
| document-kit trong worker | Không thêm network hop/parser service từ đầu | Parser nặng cần process/resource isolation |
| PostgreSQL truth + outbox | State/lệnh dispatch cùng transaction, phục hồi khi queue lỗi | Reconciliation và outbox maintenance là bắt buộc |
| At-least-once + fencing/idempotency | Phù hợp retry/crash của hệ phân tán | Không bảo đảm provider exactly-once khi outcome UNKNOWN |
| Worker manifest + generic API/profile | Thêm business trong contract không cần platform code | Custom UI/adapter/protocol mới vẫn cần update |
| EC2 riêng từng vai trò, một account | Đơn giản ownership và scale từng nhóm | Tự quản HA/patch/backup PostgreSQL/Redis tốn công vận hành |
| S3 thay shared local disk | Artifacts dùng chung multi-host, độc lập EC2 lifecycle | Cần grants, retention và object/DB reconciliation |

## Go-live gates và evidence register

Tất cả đang **OPEN/chưa có bằng chứng nghiệm thu trong hồ sơ này**. Owner theo vai trò để đội dự án phân công tên cụ thể; không đánh dấu PASS chỉ vì có code/test file.

| Gate | Owner | Tiêu chí đạt | Evidence phải lưu |
|---|---|---|---|
| GL-01 Contract | Platform + business + Connector leads | Không còn wire mismatch; OpenAPI/schema/version pin nhất quán | Contract diff, generated examples validation, compatibility tests |
| GL-02 Chức năng | BA + QA | 31 variants có acceptance; sáu public APIs và workflow mẫu hoạt động | Test matrix, fixture hashes, outputs, quality acceptance |
| GL-03 Durability | Platform lead | Outbox, lease fencing, full checkpoint, join/resume/cancel đúng khi crash | Fault-injection results, DB assertions, duplicate usage checks |
| GL-04 Provider integrity | Connector lead | Global quota, UNKNOWN handling, credential rotation, usage dedup | Multi-replica DB/Redis/provider mock tests |
| GL-05 Security | Security + QA | Auth boundaries, tenant isolation, upload/SSRF/XSS/grants kiểm thử | Negative E2E, review findings và remediation |
| GL-06 Deploy | DevOps | IaC, immutable images, health/drain/rolling/rollback hoạt động | Staging deployment log, image digests, rollback rehearsal |
| GL-07 Capacity | SRE + product owner | Workload/SLO/quota đã chốt; load/soak đạt với headroom | Báo cáo theo [capacity](07-capacity.md), bottlenecks và max limits |
| GL-08 Recovery | DBA + SRE | Backup restore đạt RPO/RTO đã duyệt, failover không split-brain | Restore timestamps, lost-data analysis, queue/ledger reconcile |
| GL-09 Operations | Operations owner | Dashboard, alerts, on-call, retention, secrets rotation và runbook | Alert drill, ownership, policy revisions |
| GL-10 Release | Release/product owner | Canary và rollback criteria, known-risk decisions được ghi nhận | Release checklist, sign-off, client compatibility scope |

Evidence record nên gồm: gate/test ID, commit SHA, image digest, ngày, môi trường/config, command/scenario, expected/actual, artifact path, người chạy và reviewer. Không đưa API keys/raw tài liệu thật vào evidence công khai.

## Câu hỏi thường gặp khi bảo vệ

**Thêm business có phải sửa Orchestrator không?** Không trong giới hạn manifest/action schema/runtime capabilities hiện có. Deploy image/queue/version, register disabled, validate, enable và publish profile. Nếu cần protocol mới, extension contract vẫn phải được phát triển có version.

**Queue mất thì có mất job không?** Thiết kế lưu operation/task/outbox ở PostgreSQL và reconstruct eligible delivery. Đó là mục tiêu phải chứng minh bằng fault test; Redis persistence đơn thuần không đủ.

**Có gọi LLM hai lần và tính tiền hai lần không?** Hệ thống dedup logical invocation và usage event. Tuy nhiên crash sau provider nhận request có thể UNKNOWN; chỉ provider idempotency/reconciliation mới giải quyết chắc chắn outcome. Không claim exactly-once tuyệt đối.

**Một EC2 chết có gián đoạn không?** Pilot một replica có gián đoạn. Cấu hình HA cần nhiều app replicas cùng HA cho DB/Redis, ingress/egress và kiểm chứng recovery; không chỉ tăng worker.

**Vì sao không dùng Kubernetes ngay?** EC2 groups, immutable containers, ASG và scripts/IaC đủ cho baseline nếu deploy/drain/health được làm đúng. Chỉ chọn orchestrator hạ tầng phức tạp hơn khi số deployment và nhu cầu vận hành chứng minh lợi ích.

**LLM trả đúng JSON có nghĩa là dữ liệu đúng không?** Không. Schema chỉ bảo đảm hình dạng; chất lượng phải đo bằng corpus/evidence, có warnings/human review theo business.

**Có thể go-live sau khi đọc tài liệu này không?** Tài liệu giúp quyết định kiến trúc và nghiệm thu; release còn cần đóng gates bằng bằng chứng thực thi. Không có triển khai AWS, migration hay cutover được thực hiện bởi việc tạo hồ sơ.

## Agenda bảo vệ đề xuất — 30 phút

1. 5 phút: bài toán, actor, sáu core APIs và workflow extension.
2. 8 phút: ba tầng, ownership, sequence, failure/idempotency model.
3. 7 phút: topology EC2, isolation, HA/pilot distinction và scaling bottlenecks.
4. 5 phút: demo upload/submit/result, registration/profile và evidence đã có.
5. 5 phút: gaps, quyết định còn mở, go-live gates và người chịu trách nhiệm.

Các quyết định còn cần chủ dự án chốt: Region, traffic/file/page mix, provider/account quota, mức availability và RPO/RTO, retention/PII policy, pilot hay HA ngay, danh sách client compatibility và ngân sách. Không cần chốt các thông tin này để đọc/review kiến trúc, nhưng phải chốt trước sizing và production release.
