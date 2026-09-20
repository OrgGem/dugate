# Deployment, security và capacity plan

## Environments

Dev/test trong namespace riêng: PostgreSQL database/schema riêng, Redis prefix/instance riêng, MinIO/S3 bucket riêng, ports riêng. Không dùng `.env`, uploads, outputs hoặc credentials của DUGate cũ. `infra` sẽ có `.env.example` placeholders ở phase implementation, chưa tạo ở planning.

Compose dự kiến: orchestrator, connector, document-core, postgres, redis, object-storage, mock-provider. Example-review chỉ thêm vào extension test profile. Không có Coordinator/Document service độc lập.

Prod initial topology có thể giữ cùng loại service và tăng replicas; multi-host cần external/shared object storage. Migrations one-shot, graceful drain/shutdown, health endpoints phản ánh dependencies. Không mở Redis/Postgres/Connector public.

## Reliability baseline

- Redis persistence + durable volume, `maxmemory-policy=noeviction`, memory headroom/alerts; DB reconciliation vẫn cần khi queue mất dữ liệu. [BullMQ production guidance](https://docs.bullmq.io/guide/going-to-production)
- PostgreSQL backup/restore test và migration rollback/forward recovery. Pool budget = tổng replica × pool size; giới hạn kết nối theo instance.
- Outbox batch claim có lease, retry jitter, dead-letter inspection; queue job retention bounded.
- Worker SIGTERM ngừng claim mới, hoàn thành/checkpoint trong grace period; hết grace để lease recovery, không ghi success giả.
- In-flight provider call có timeout và outcome reconciliation. Connector replica scale không vượt global quota.
- Resume human wait có expiry độc lập HTTP timeout. Version v1 phải còn deploy khi v1 human waits còn khả năng resume.

## Security requirements

Auth separation: public keys; admin sessions/RBAC/CSRF; worker/service scopes; signed invocation/artifact grants; Redis least-privilege provisioning. Không tin identity headers từ internet. Rotation/revocation phải test khi job đang chạy.

Upload controls: size/count/MIME signature, archive traversal/zip bomb, parser time/resource limits, temp dir isolation, cleanup. SSRF policy cho remote file fetch, provider endpoint và webhook: scheme/host allowlist, DNS/private address checks, redirect revalidation. Không log signed URLs, prompt/file content hoặc Authorization mặc định.

Manifest/config không chạy script; schema refs mạng bị cấm. API response metadata có tenant ownership. Secret encrypted at rest và không xuất qua GET. Internal TLS và key management theo môi trường production, không mặc định private network là đủ auth.

## Observability

Logs cấu trúc dùng operationId, taskId, stepKey, invocationId, business/version, correlationId, leaseEpoch; redact. Metrics labels bounded, không dùng operationId làm metric label.

Metrics: submission p95/p99, queue oldest age, outbox age, active/expired leases, retries, failed/cancelled/unknown invocation, provider latency/429, in-flight, bytes/pages, DB connections, artifact orphan count, usage lag, webhook lag.

Alert gắn runbook: queue không có matching worker; outbox backlog; reconciliation repeat; UNKNOWN invocation; credential revoked; storage inaccessible; usage duplication attempt; capacity rejected.

## Load-test matrix

| Workload | Scale thử | Quan sát |
|---|---|---|
| Text-only inference mock | 1→2→4 business replicas | Throughput/queue wait/provider cap |
| DOCX/XLSX native parse | File nhỏ/vừa/lớn | CPU/RSS/event loop/disk |
| Mixed six actions | Burst + sustained arrival | Fairness/action starvation |
| One large fanout + small jobs | Bounded parallelism | Parent yield và latency jobs nhỏ |
| Provider quota fixed | Tăng workers/connectors | Không vượt quota; 429/backpressure |
| Replica/restart faults | Kill one service at a time | Recovery window, duplicate calls |

P0 ghi target cụ thể cùng CPU/RAM/provider mock latency; P8 báo measured results. Capacity estimate dùng arrival × calls/job × service time, sau đó đo. Không promise linear scale khi provider/DB/storage bị giới hạn.

## Release/cutover boundary

Plan này xây hệ thống mới độc lập. Không migrate/cutover production DUGate. Khi cần: inventory data/contracts, export/import thử trên snapshot được cấp, compare output, cutover/rollback plan riêng và yêu cầu triển khai cụ thể từ user.
