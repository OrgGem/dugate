# 05 — Admin, Registry, Runtime và Connector API

Đây là giao tiếp mục tiêu giữa các service, không cho phép truy cập bằng public API key. Catalog đầy đủ trong [Admin/Runtime spec](../docs/07-internal-api.md) và [Connector spec](../docs/08-connector-api.md). Các body dưới là ví dụ review; manifest và wire DTO phải qua contract gate trước tích hợp.

## Identity và base paths

| Bề mặt | Base | Xác thực và quyền |
|---|---|---|
| Admin trên Orchestrator | `/api/internal/v1` | Session, RBAC admin/operator/viewer, CSRF cho cookie mutations |
| Worker runtime trên Orchestrator | `/api/runtime/v1` | Service bearer identity, audience và business/version scopes |
| Connector management/runtime | `/internal/v1` | Service auth; admin management scope tách invocation scope |

Worker identity được provision lúc deploy, không tự lấy quyền bằng businessId trong request. Invocation cần thêm grant ngắn hạn do runtime ký, gắn operation/task/step/inputHash/binding revision/artifacts/deadline. Connector phải xác minh signature, issuer, audience, expiry và các binding; kiểm tra field đơn thuần không thay thế cryptographic verification.

## Registry và profile

| Method/path | Request | Response |
|---|---|---|
| PUT runtime `/businesses/{id}/versions/{version}` | BusinessManifest | 201 registered disabled; 200 cùng digest; 409 cùng version khác digest |
| PUT runtime `/workers/{instanceId}/heartbeat` | business/version, digest, capacity | 200 health lease |
| POST admin `/businesses/{id}/versions/{version}/enable` | Version đã validate | 200 enabled |
| POST admin `/businesses/{id}/versions/{version}/drain` | path | 200, ngừng submit mới |
| POST admin `/businesses/{id}/versions/{version}/retire` | path | 200 hoặc 409 còn dependency |
| GET/POST admin `/profiles` | create metadata hoặc query | 200 list / 201 created |
| POST admin `/profiles/{id}/revisions` | Immutable profile revision | 201; 409 stale; 422 invalid binding |
| POST admin `/api-keys` | Tenant/profile scope | 201 raw key đúng một lần |
| POST admin `/api-keys/{id}/revoke` | path | 200 revoked |

Manifest tối thiểu về mặt nội dung: business ID/version, contract version, digest, actions với input/output/profile/UI schemas, connector slots/capabilities, handler kinds và limits. Queue name do platform kiểm soát; không tin arbitrary queue trong manifest. Shape JSON chính xác theo [manifest contracts](../packages/contracts/src/manifest.ts), cần đồng bộ manifest của document-core trước freeze.

Profile revision request minh họa:

```json
{
  "expectedRevision": 3,
  "name": "Invoice integration",
  "actionBindings": [{
    "businessId": "document-core", "version": "1.0.0", "action": "extract", "enabled": true,
    "parameters": {"type": "invoice"}, "lockedFields": ["type"], "promptOverrides": {},
    "connectorBindings": {"reasoning": {"connectorId": "llm-primary", "revision": 2}},
    "limits": {"maxParallelTasks": 4}
  }],
  "artifactPolicy": {},
  "callbackPolicy": {}
}
```

Shape của limits/policy/bindings còn phải chốt, ví dụ thể hiện ý nghĩa. 201 response cần cung cấp profileId, revision mới và thời điểm publish; exact DTO chưa freeze. Publish validate slot capabilities và mọi locked fields; không cho cấu hình thiếu connector cần thiết vào active profile. Khi admin thêm business, UI đọc schemas để render cấu hình và hiển thị action mới.

## Runtime task lifecycle

| Endpoint dưới runtime | Request chính | Success | Conflict |
|---|---|---|---|
| POST `/tasks/{id}/claim` | deliveryId, workerInstanceId | 200 ClaimResult | 409 busy; 410 terminal |
| POST `/tasks/{id}/heartbeat` | leaseEpoch | 200 leaseExpiresAt | 409 lease lost |
| GET `/tasks/{id}/context` | leaseEpoch theo HTTP binding cần freeze | 200 snapshot + refs + cancel flag | 409 stale |
| PUT `/tasks/{id}/steps/{stepKey}` | leaseEpoch, inputHash, outputRef, sessionRef? | 201 / 200 replay | 409 hash mismatch |
| POST `/tasks/{id}/children` | leaseEpoch, children[], joinPolicy, continuationRef | 202 durable wait/dependencies | 422 handler không đăng ký |
| POST `/tasks/{id}/wait-input` | leaseEpoch, waitKey, schema, uiSchema?, contextRef | 200 waitId | 409 state conflict |
| POST `/tasks/{id}/complete` | leaseEpoch, resultRef, resultHash | 200 idempotent transition | 409 stale/terminal conflict |
| POST `/tasks/{id}/fail` | leaseEpoch, errorCode, retryable, retryAfterMs? | 200 retry scheduled hoặc terminal | 409 stale |
| POST `/tasks/{id}/artifacts` | leaseEpoch, purpose, mime, size | 201 upload grant + ID | 403 scope, 413 size |
| POST `/artifacts/{id}/finalize` | size, sha256 | 200 READY sau verify | 409 mismatch |
| POST `/tasks/{id}/invocation-grants` | leaseEpoch, stepKey, bindingSlot, inputHash | 201 invocationId + grant | 403 binding, 409 lease |
| POST `/usage-events` | Connector usage batch | 200 accepted/duplicate IDs | 403 wrong identity |

Claim request và phần response trọng tâm:

```json
{"deliveryId": "delivery-task-001", "workerInstanceId": "document-core-node-a"}
```

```json
{
  "taskId": "33333333-3333-4333-8333-333333333333",
  "operationId": "22222222-2222-4222-8222-222222222222",
  "leaseEpoch": 2,
  "leaseExpiresAt": "2026-09-20T08:01:00Z",
  "attempt": 1,
  "deadlineAt": "2026-09-20T08:05:00Z",
  "executionSnapshot": {"businessId": "document-core", "businessVersion": "1.0.0", "action": "extract"},
  "checkpointRefs": []
}
```

Snapshot trong ví dụ rút gọn; production cần input/artifact refs, resolved parameters, profile/schema/prompt/binding revisions. Queue chỉ chứa envelope versioned và IDs/refs, không chứa credentials, full PDF hay prompt nhạy cảm.

## Connector invocation

| Endpoint | Request | Response mục tiêu |
|---|---|---|
| POST `/internal/v1/invocations` | InvocationRequest | 200 completed / 202 pending |
| GET `/internal/v1/invocations/{id}` | Scoped identity | 200 state/result/usage |
| POST `/internal/v1/invocations/{id}/cancel` | reason | 202 best-effort |
| GET `/internal/v1/capabilities` | Service auth | 200 adapter catalog |
| GET `/internal/v1/health/live`, `/health/ready` | Probe identity/network policy | 200 / 503 |

```json
{
  "contractVersion": "1", "invocationId": "invocation-001", "grant": "SIGNED_GRANT_PLACEHOLDER",
  "operationId": "22222222-2222-4222-8222-222222222222",
  "taskId": "33333333-3333-4333-8333-333333333333",
  "stepKey": "extract-invoice", "bindingSlot": "reasoning",
  "input": {"prompt": "Extract invoice fields.", "text": "Invoice INV-001...", "outputSchema": {"type": "object"}},
  "options": {"temperature": 0}, "sessionRef": null,
  "deadlineAt": "2026-09-20T08:05:00Z"
}
```

```json
{
  "invocationId": "invocation-001", "state": "SUCCEEDED",
  "result": {"data": {"invoiceNumber": "INV-001"}},
  "usage": {"inputTokens": 100, "outputTokens": 20, "pages": 1, "costMicrousd": 0, "measurement": "estimated"},
  "providerRequestId": "provider-demo-001"
}
```

State uppercase theo shared operation contracts là mục tiêu; Connector local HTTP hiện dùng lowercase, chưa đồng bộ. Pending cần state PENDING + nextPollAt, ledger giữ provider request ID. UNKNOWN trả lỗi phân loại và yêu cầu reconciliation, không tự coi FAILED để retry mới. 403 grant/binding, 409 hash/unknown, 422 invalid input/capability, 429 rate limit, 502 bad provider response, 503 unavailable, 504 timeout có phân loại outcome.

Management còn có GET/POST connectors, GET connector, POST revisions, rotate credentials, disable, test. Admin proxy qua Orchestrator; chỉ trả redacted metadata. Secret input là write-only; kiểm tra kết nối có thể phát sinh provider usage và phải audit. HTTP shell hiện tại chưa phải management API hoàn chỉnh đã auth; xem readiness gaps.
