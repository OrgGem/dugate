# Data ownership và state machines

Đặc tả logic; chưa tạo SQL. UUID cho entity, UTC RFC3339 cho timestamp, integer cho token/bytes, decimal hoặc integer micro-USD cho tiền; không dùng floating point tích lũy billing.

## Platform schema — Orchestrator owner

| Entity | Fields chính | Constraints/index quan trọng |
|---|---|---|
| Tenant | id, name, state | Một default tenant v1 |
| ApiKey | id, tenantId, profileId, hash, prefix, status | Hash unique; không lưu raw key |
| BusinessVersion | businessId, version, contractVersion, manifest, digest, status, queue | Unique business+version; manifest immutable |
| WorkerInstance | identity, businessId/version, lastHeartbeat, capacity, imageDigest | Health không thay trạng thái registration |
| ProfileRevision | profileId, revision, tenantId, actionBindings, limits | Immutable revision; current pointer CAS |
| Operation | id, tenantId, profileRevision, business/version/action, state, stateVersion, rootTaskId, deadlineAt | Index tenant+createdAt, state+updatedAt |
| SubmissionKey | tenantId, apiKeyId, routeAction, key, requestHash, operationId, expiresAt | Unique scope+key; khác hash trả 409 |
| ExecutionSnapshot | operationId, schemaDigest, resolvedInputRef, parameter/prompt/binding revisions | Không chứa provider credentials |
| Task | id, operationId, parentId, taskKey, kind, payloadRef, state, attempt, leaseEpoch, leaseExpiresAt | Unique operation+taskKey; index dueAt/state |
| TaskDependency | parentId, childId, joinPolicy | Unique pair; same operation/business/version |
| StepCheckpoint | taskId, stepKey, generation, inputHash, outputRef, sessionRef, status | Unique task+stepKey+generation; immutable success |
| HumanWait | operationId, taskId, waitId, inputSchema, schemaDigest, status, responseRef | Unique waitId; one accepted response |
| Artifact | id, tenantId, operationId?, storageKey, mime, size, sha256, state, expiresAt | Scoped ownership; active references prevent GC |
| Outbox | id, aggregateId, type, payloadRef, dueAt, claimUntil, dispatchedAt | Index pending+dueAt; deterministic dispatch ID |
| UsageProjection | eventId, invocationId, operationId, units, cost, currency | eventId unique; corrections append-only |
| WebhookDelivery | deliveryId, operationId, terminalRevision, attempts, nextAt, status | Unique operation+terminalRevision+destination |
| AuditLog | actor, action, subject, before/after metadata, traceId | Redacted immutable audit |

Worker chỉ truy cập runtime API; dữ liệu checkpoint generic nằm ở platform. Business có thể thêm DB riêng trong tương lai khi cần domain records, không được ghi bảng platform.

## Connector schema — Connector owner

ConnectorRevision(connectorId, revision, adapter, config, credentialRef, state); SecretVersion(id, encryptedValue, rotatedAt, revokedAt); Invocation(invocationId, tenantId, operationId, taskId, inputHash, bindingRevision, state, providerRequestId, resultRef, lease, usage); UsageOutbox(eventId, invocationId, payload, deliveredAt).

Unique invocationId và inputHash collision check. Provider quota counter/lease dùng Redis với atomic operations; durable invocation/usage dùng PostgreSQL. Secret không xuất ra management GET, manifest, queue hoặc logs.

## Operation states

| Từ | Sang | Điều kiện |
|---|---|---|
| ACCEPTED | QUEUED | Dispatch đã được ghi nhận; worker có thể claim trực tiếp nếu dispatch ACK bị mất |
| ACCEPTED / QUEUED | RUNNING | Root/task claim hợp lệ |
| RUNNING | WAITING_CHILDREN | Parent persist dependency và nhường slot |
| RUNNING | WAITING_INPUT | Worker persist human wait schema |
| RUNNING | RETRY_PENDING | Lỗi retryable, còn budget/deadline |
| WAITING_CHILDREN | QUEUED | Join policy satisfied, continuation outbox commit |
| WAITING_INPUT | QUEUED | Resume validate và CAS thành công |
| RETRY_PENDING | QUEUED | Đến dueAt, continuation dispatch |
| Trạng thái chưa terminal | CANCEL_REQUESTED | Client có quyền yêu cầu cancel |
| CANCEL_REQUESTED | CANCELLED | Fenced task claims, xử lý active call best-effort; kết quả muộn không đổi terminal |
| Trạng thái chưa terminal | TIMED_OUT | Operation deadline hết, fence các task |
| RUNNING | SUCCEEDED | Root finalize, output hợp lệ, tất cả prerequisite hoàn tất |
| Trạng thái chưa terminal | FAILED | Lỗi permanent, hết retry hoặc join failure policy |

Terminal = SUCCEEDED, FAILED, CANCELLED, TIMED_OUT. Không resume terminal operation; muốn chạy lại tạo operation mới có `replayOf`. Trong workflow có child chạy, trạng thái operation biểu diễn root coordinator; per-task detail thể hiện nhánh đang chạy.

Task có READY, RUNNING, WAITING_CHILDREN, WAITING_INPUT, RETRY_PENDING, SUCCEEDED, FAILED, CANCELLED. Claim cấp leaseEpoch tăng dần; progress/checkpoint/complete phải mang epoch hiện hành. Stale worker trả 409 LEASE_LOST; không được gọi provider mới sau mất lease.

## Retry owner và checkpoint

- Platform runtime là nguồn chính cho business retry budget, attempt và dueAt. Business SDK report retryable failure; transaction tạo continuation outbox rồi kết thúc queue delivery hiện tại.
- BullMQ retry/stalled recovery chỉ xử lý lỗi vận chuyển/claim/runtime unavailable. Khi delivery lại, runtime quyết định còn task nào hợp lệ. Không nhân retry budget ở HTTP client, queue và workflow.
- `stepKey` ổn định theo business definition + branch/item ID; không dùng vị trí mảng dễ thay đổi hoặc random mỗi retry.
- OutputRef chứa full output, inputHash và session snapshot; preview chỉ phục vụ UI.
- Step result commit trước continuation. Task có thể chạy lại sau crash nhưng completed step chỉ đọc kết quả.
- Ghi state và outbox cùng transaction. CAS `stateVersion`/leaseEpoch để completion và cancel cạnh tranh có thứ tự rõ.

## Invocation states và unknown outcome

NEW → IN_FLIGHT → SUCCEEDED hoặc FAILED; mất khả năng xác định kết quả → UNKNOWN. Retry transport dùng cùng invocationId; một provider retry sau lỗi xác định chưa xử lý có attempt record riêng. Nếu provider hỗ trợ idempotency, adapter dùng cùng khóa; nếu không, UNKNOWN cần reconcile/manual policy trước khi tạo invocation mới có thể phát sinh phí.

Late usage vẫn ghi ledger dù operation đã cancelled; cancellation không có nghĩa provider chưa tính phí. Parent chỉ tổng hợp usage, không ghi debit lần nữa.

## Reconciliation bắt buộc

- Operation/task có outbox chưa dispatch: gửi lại với stable delivery ID.
- Job bị Redis mất nhưng task chưa terminal: lease expiry + DB sweep tái tạo delivery.
- Task completion đã commit nhưng HTTP response mất: duplicate report trả snapshot hiện tại.
- Invocation success nhưng usage chưa đến platform: Connector replay usage outbox.
- Artifact object chưa finalized: expire staging; không xóa object đang được task/checkpoint giữ.

Retention cụ thể là config được chốt P0. Không xóa idempotency/checkpoint/ledger sớm hơn cửa sổ retry/replay được công bố.
