# 05 — Admin, Registry, Runtime và Connector API

Đây là giao tiếp mục tiêu giữa các service, không cho phép truy cập bằng public API key. Catalog đầy đủ trong [Admin/Runtime spec](../docs/07-internal-api.md) và [Connector spec](../docs/08-connector-api.md). Các body dưới là ví dụ review; manifest và wire DTO phải qua contract gate trước tích hợp.

> **Ingress/listener (PM-M02, đã materialize):** Orchestrator Backend chạy một process với hai JSON listener — Public `:3000` và Internal `:3002`; Orchestrator Portal/BFF giữ listener riêng `:3001`; Connector Service giữ `:8080` nội bộ. Public `:3000` chặn `/api/v1/admin*`, `/api/runtime*`, `/api/internal*` sớm bằng generic 404 (`orchestrator/services/orchestrator/src/http/ingress-guard.ts`), kể cả khi caller có credential hợp lệ; audience do listener quyết định, không lấy từ `Host`/forwarding headers. Internal `:3002` giữ route public/admin/runtime cho BFF/workers/services với auth đầy đủ. `compose/orchestrator.yml` chỉ map 3000/3001 qua `${BIND_ADDRESS:-127.0.0.1}`, không map 3002; `compose/connector.yml` không publish 8080; debug local chỉ opt-in qua `compose/local-debug.yml` bind literal `127.0.0.1`. Runtime URL mặc định của workers là `http://orchestrator:3002/api/runtime/v1`; Connector URL là `http://connector:8080`.

## Identity và base paths

| Bề mặt | Base và listener | Xác thực và quyền |
|---|---|---|
| Admin trên Orchestrator Backend | `/api/v1/admin/*` + `POST /api/v1/admin/actions` (dispatcher) + shell `/admin/*`; phục vụ trên Internal `:3002`, **bị chặn trên Public `:3000`** | Đa số route admin JSON chỉ nhận admin bearer token (fail-closed 401 khi thiếu); session/OIDC/local chỉ cấp quyền trên `POST /api/v1/admin/actions` qua `resolveAdminActionAuthAsync`, có RBAC/CSRF. Source: `orchestrator/services/orchestrator/src/http/routes/admin.ts` |
| Worker runtime trên Orchestrator Backend | `/api/runtime/v1` trên Internal `:3002` | Service bearer identity theo business cho task route; token usage riêng (`USAGE_TOKEN`) cho `POST /usage-events`. Không dùng public API key. Source: `orchestrator/services/orchestrator/src/http/routes/runtime.ts` |
| Connector Service management/runtime | Root paths `/connectors*`, `/invocations*`, `/capabilities`, `/health/live`, `/health/ready` trên `:8080` nội bộ — **không có prefix `/internal/v1`** | Service auth; scope `connector:manage` tách `connector:invoke`; invocation cần thêm signed grant. Admin quản trị qua Orchestrator Backend proxy, không gọi trực tiếp từ browser. Source: `orchestrator/services/connector/src/http/server.ts` |

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

Manifest tối thiểu về mặt nội dung: business ID/version, contract version, digest, actions với input/output/profile/UI schemas, connector slots/capabilities, handler kinds và limits. Queue name do platform kiểm soát; không tin arbitrary queue trong manifest. Shape JSON chính xác theo [manifest contracts](../orchestrator/packages/contracts/src/manifest.ts), cần đồng bộ manifest của document-core trước freeze.

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

## Connector invocation (root paths trên `:8080`, không prefix `/internal/v1`)

| Endpoint | Request | Response mục tiêu |
|---|---|---|
| POST `/invocations` | InvocationRequest + signed grant | 200 completed / 202 pending |
| GET `/invocations/{id}` | Scoped identity + `x-invocation-grant` | 200 state/result/usage |
| POST `/invocations/{id}/cancel` | reason | 202 best-effort |
| GET `/capabilities` | Service auth | 200 adapter catalog |
| GET `/health/live`, `/health/ready` | Probe (public) | 200 / 503 |

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
