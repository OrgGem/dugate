# Admin và Runtime API spec

## Auth boundaries

Admin `/api/internal/v1`: authenticated session, RBAC admin/operator/viewer và CSRF cho mutation cookie-auth. Runtime `/api/runtime/v1`: service bearer identity với scopes business/version và audience; không dùng public API key. Credentials được provision/deploy riêng, không tin businessId trong body nếu identity không khớp.

## Admin catalog

| Method/path dưới /api/internal/v1 | Mục đích | Success |
|---|---|---|
| GET /businesses | List versions, status, health | 200 |
| POST /businesses/{id}/versions/{version}/enable | Enable đã validate manifest | 200 |
| POST /businesses/{id}/versions/{version}/drain | Chặn submit mới | 200 |
| POST /businesses/{id}/versions/{version}/retire | Retire nếu không còn dependency | 200 hoặc 409 |
| GET/POST /profiles | List/create | 200/201 |
| GET /profiles/{id} | Read current+revision | 200 |
| POST /profiles/{id}/revisions | Validate bindings/limits/prompt, publish revision | 201,409 stale,422 invalid |
| POST /api-keys | Create tenant/profile-scoped key | 201 raw key chỉ lần này |
| POST /api-keys/{id}/revoke | Revoke | 200 |
| GET /connectors | Proxy redacted connector catalog | 200 |
| POST /connectors | Proxy create | 201 |
| POST /connectors/{id}/revisions | Proxy immutable config publish | 201 |
| POST /connectors/{id}/credentials/rotate | Proxy write-only credential rotation | 200 |
| POST /connectors/{id}/test | Explicit controlled invocation | 200 result+latency hoặc problem |
| GET /operations, /operations/{id} | Operator views tenant-scoped | 200 |
| POST /operations/{id}/replay | Tạo operation mới có replayOf | 202 |
| GET /audit, /usage | Cursor pages, filters | 200 |

Profile publish body: `{expectedRevision, name, actionBindings:[{businessId,version,action,enabled,parameters,lockedFields,promptOverrides,connectorBindings,limits}], artifactPolicy, callbackPolicy}`. Platform kiểm tra slots/capabilities theo manifest và Connector public metadata. Binding không có raw secrets. Activation pointer CAS; operation cũ dùng snapshot.

## Runtime catalog

| Method/path dưới /api/runtime/v1 | Request chính | Response / semantics |
|---|---|---|
| PUT /businesses/{id}/versions/{version} | BusinessManifest | 201 new disabled; 200 replay; 409 digest mismatch |
| PUT /workers/{instanceId}/heartbeat | business/version,digest,capacity | 200 health lease; scope check |
| POST /tasks/{id}/claim | deliveryId,workerInstanceId | 200 ClaimResult; 409 busy; 410 terminal delivery |
| POST /tasks/{id}/heartbeat | leaseEpoch | 200 leaseExpiresAt; 409 stale |
| GET /tasks/{id}/context | leaseEpoch | 200 execution snapshot, checkpoints, cancel flag |
| PUT /tasks/{id}/steps/{stepKey} | leaseEpoch,inputHash,outputRef,sessionRef | 201 success; 200 identical replay; 409 conflict |
| POST /tasks/{id}/progress | leaseEpoch,percent,message | 200, throttled/coalesced |
| POST /tasks/{id}/children | leaseEpoch,children[],joinPolicy,continuationRef | 202 durable children+dependency+wait+outbox transaction |
| POST /tasks/{id}/wait-input | leaseEpoch,waitKey,schema,uiSchema,contextRef | 200 waitId; persist before release |
| POST /tasks/{id}/complete | leaseEpoch,resultRef,resultHash | 200 idempotent terminal task transition |
| POST /tasks/{id}/fail | leaseEpoch,errorCode,retryable,retryAfterMs? | 200 retry schedule hoặc terminal failure |
| POST /tasks/{id}/artifacts | leaseEpoch,purpose,mime,size | 201 scoped upload grant+artifact ID |
| POST /artifacts/{id}/finalize | size,sha256 | 200 READY sau verify storage metadata |
| POST /artifacts/{id}/access | taskId,leaseEpoch,mode | 200 short-lived grant với ownership |
| POST /tasks/{id}/invocation-grants | leaseEpoch,stepKey,bindingSlot,inputHash | 201 signed scoped grant+invocationId |
| POST /usage-events | connector usage batch | 200 accepted/duplicate IDs; connector identity only |

ClaimResult: `{taskId,operationId,leaseEpoch,leaseExpiresAt,attempt,deadlineAt,executionSnapshot,checkpointRefs}`. Large snapshot fields dùng artifact refs. Claim transaction nhận ACCEPTED task trước dispatcher ACK cũng hợp lệ.

`children[]` gồm deterministic `taskKey`, registered handler `kind`, `payloadRef`. Tất cả cùng business/version/operation của parent; giới hạn số con và maxParallelTasks. Request idempotency dựa parent+child taskKey; cùng key khác payloadHash trả 409. Parent không phát job trực tiếp trước transaction này.

V1 joinPolicy chỉ `all-success`: một child terminal failed → parent failure continuation với lỗi; unfinished siblings cancel theo policy. Join reconciliation atomically tạo đúng một continuation, business code quyết định bước kế. Human wait chỉ ở root sau join.

## State/report errors

409 LEASE_LOST/STATE_CONFLICT/INPUT_HASH_MISMATCH; 410 TASK_TERMINAL; 422 INVALID_SCHEMA/UNREGISTERED_HANDLER; 429 CAPACITY; 503 TEMPORARY_UNAVAILABLE. SDK đọc lại context sau ambiguous HTTP response; không tạo task/invocation mới bằng random ID để vượt conflict.

Lease defaults đề xuất cho test: 60 giây, heartbeat mỗi 15 giây; production cấu hình theo latency/restart budget. Lease task và HTTP timeout provider là hai khái niệm độc lập. Stale completion không được override cancel hoặc newer attempt.
