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
| POST /connectors/{id}/revisions | Proxy immutable config publish; Vault body includes independently supplied `tenantId` and `accountId` with the pinned source | 201 |
| POST /connectors/{id}/credentials/rotate | Proxy write-only credential rotation | 200 |
| POST /connectors/{id}/test | Explicit controlled invocation | 200 result+latency hoặc problem |
| GET /operations, /operations/{id} | Operator views tenant-scoped | 200 |
| POST /operations/{id}/replay | Tạo operation mới có replayOf | 202 |
| GET /audit, /usage | Cursor pages, filters | 200 |

Profile publish body: `{expectedRevision, name, actionBindings:[{businessId,version,action,enabled,parameters,lockedFields,promptOverrides,connectorBindings,limits}], artifactPolicy, callbackPolicy}`. Platform kiểm tra slots/capabilities theo manifest và Connector public metadata. Binding không có raw secrets. Activation pointer CAS; operation cũ dùng snapshot.

Connector Vault revision requests carry `{credentialSource, tenantId, accountId}`. The revision writer checks those trusted binding coordinates against the parsed source and canonical `du/tenants/{tenantId}/connectors/{connectorId}/accounts/{accountId}` path before persistence. `credentialSource` contains only `kind`, mount/path/key and pinned version metadata; plaintext credentials and Vault tokens are never accepted in revision JSONB.

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
| POST /tasks/{id}/artifacts/multipart | leaseEpoch,uploadToken,purpose,mime,sizeBytes | 201 STAGING multipart session+uploadHandle; 200 replay; 409 LEASE_LOST/IDEMPOTENCY_CONFLICT/MULTIPART_NOT_AVAILABLE/MULTIPART_EXPIRED; 413 |
| POST /artifacts/{id}/multipart/part | leaseEpoch,partNumber,sha256 | 200 presigned PUT cho đúng một part, size do server chốt; 422 PART_OUT_OF_RANGE |
| POST /artifacts/{id}/multipart/complete | leaseEpoch,parts[etag,size,sha256],sha256 | 200 committed=true (row vẫn STAGING); 409 PART_SET_MISMATCH/CHECKSUM_MISMATCH/LEASE_LOST |
| POST /artifacts/{id}/multipart/abort | leaseEpoch,reason | 200 ABORTED idempotent; 409 STATE_CONFLICT |
| POST /artifacts/{id}/finalize | size,sha256 | 200 READY sau verify storage metadata |

## Multipart upload branch (DATA-02)

Artifact trên ngưỡng single-PUT đi qua init → per-part grant → complete → finalize. `uploadToken` (uuid client sinh, unique theo task) là khóa replay cho init; part URL và provider upload id không rời server (client chỉ nhận `uploadHandle` dẫn xuất), không vào log. `complete` đối chiếu receipt của client với ListParts của storage và với ledger grant server đã ghi, rồi re-hash toàn bộ pinned version trước khi commit; generated chưa được commit luôn bị xóa khi bất kỳ bước nào fail. Row vẫn `STAGING` tới khi `finalize` chuyển sang `READY`. Session quá hạn bị sweep sang `ABORTED` kèm dọn storage, nối vào chu kỳ recovery timer (single-flight) của tiến trình.

### Public branch — `/api/v1/uploads` (DATA-02, packet W-DATA02-PUB-1)

Client upload (source artifact) chạy cùng lifecycle với trust tier khác — `x-api-key` + tenant fence, không lease, schema body là §2 bỏ `leaseEpoch`/`purpose` (server ép `input`):

| POST /api/v1/uploads | uploadToken (uuid) hoặc Idempotency-Key, mimeType, sizeBytes, fileName? | 201 STAGING `input` row không task; 200 replay; 401; 409/413/422 |
| POST /api/v1/uploads/{id}/part | partNumber, sha256 | 200 presigned PUT, size do server chốt; foreign tenant → 404 |
| POST /api/v1/uploads/{id}/complete | parts[], sha256 | 200 committed=true VÀ row → `READY` (complete là cạnh finalize của nhánh này) |
| POST /api/v1/uploads/{id}/abort | reason? | 200 ABORTED idempotent; row `READY` → 409, không bao giờ purge byte đã commit |

`uploadToken` public unique theo (tenant, token) trên partition không-task (migration `0016`); khóa dẫn xuất từ Idempotency-Key deterministic theo tenant. `finalize` runtime là route mang lease, nên client không có gì để chứng minh ở đó — `complete` public đã chạy toàn bộ cổng storage-authoritative (ListParts đối chiếu ledger + re-hash whole-object) trước khi ghi `READY`. Submit guard vẫn chỉ nhận `READY` (chặn STAGING/foreign/expired và bytes nhúng quá budget). Route runtime không với được row public (auth JOIN thiếu operation → 404; `ownerTaskOf` → 409) và ngược lại. Session public quá hạn được cùng một sweeper dọn như runtime.
| POST /artifacts/{id}/access | taskId,leaseEpoch,mode | 200 short-lived grant với ownership |
| POST /tasks/{id}/invocation-grants | leaseEpoch,stepKey,bindingSlot,inputHash | 201 signed scoped grant+invocationId |
| POST /usage-events | connector usage batch | 200 accepted/duplicate IDs; connector identity only |

ClaimResult: `{taskId,operationId,leaseEpoch,leaseExpiresAt,attempt,deadlineAt,executionSnapshot,checkpointRefs}`. Large snapshot fields dùng artifact refs. Claim transaction nhận ACCEPTED task trước dispatcher ACK cũng hợp lệ.

`children[]` gồm deterministic `taskKey`, registered handler `kind`, `payloadRef`. Tất cả cùng business/version/operation của parent; giới hạn số con và maxParallelTasks. Request idempotency dựa parent+child taskKey; cùng key khác payloadHash trả 409. Parent không phát job trực tiếp trước transaction này.

V1 joinPolicy chỉ `all-success`: một child terminal failed → parent failure continuation với lỗi; unfinished siblings cancel theo policy. Join reconciliation atomically tạo đúng một continuation, business code quyết định bước kế. Human wait chỉ ở root sau join.

## State/report errors

409 LEASE_LOST/STATE_CONFLICT/INPUT_HASH_MISMATCH/MULTIPART_NOT_AVAILABLE/MULTIPART_EXPIRED/PARTS_EXCEEDED/PART_SET_MISMATCH/CHECKSUM_MISMATCH/SIZE_MISMATCH; 410 TASK_TERMINAL; 413 PAYLOAD_TOO_LARGE; 422 INVALID_SCHEMA/PART_OUT_OF_RANGE/UNREGISTERED_HANDLER; 429 CAPACITY; 503 TEMPORARY_UNAVAILABLE. SDK đọc lại context sau ambiguous HTTP response; không tạo task/invocation mới bằng random ID để vượt conflict.

Lease defaults đề xuất cho test: 60 giây, heartbeat mỗi 15 giây; production cấu hình theo latency/restart budget. Lease task và HTTP timeout provider là hai khái niệm độc lập. Stale completion không được override cancel hoặc newer attempt.


## Encryption boundaries (ADR-18 baseline — CHƯA triển khai)

> **Trạng thái:** ADR-18 design baseline; không có code encryption nào trong orchestrator/runtime. `ENC-00` `[~]`, `G-ENC` mở. Ghi ở đây để internal API spec phản ánh ranh giới thiết kế, không phải endpoint đang chạy.

- **Runtime worker** không bao giờ nhận plaintext DEK hay master key qua `/api/runtime/v1`. Artifact download grant (`POST /artifacts/{id}/access`) trả reference đến ciphertext; giải mã xảy ra trong app-layer streaming gateway, không trong worker process.
- **Multipart upload** (runtime + public): presigned PUT/part chỉ mang ciphertext chunk. `complete` re-hash trên ciphertext, không trên plaintext. Streaming gateway thực hiện AES-256-GCM chunked encryption trước khi ghi storage.
- **Connector credential** (ADR-17/ADR-18 giao): Vault KV v2 giữ provider secret; Vault Transit giữ DEK wrap key. Hai mount tách biệt. `credentialSource` trong revision JSONB không chứa plaintext hay Vault token.
- **Vault Transit key reference** sẽ xuất hiện trong artifact envelope metadata (ENC-01 schema) dưới dạng `keyName` + `keyVersion`, không phải secret material. Deployment cấu hình Vault key name cho phép (deployment-level config, không phải per-request caller input).
- Queue payload, outbox `payloadRef`, log structured: không chứa inline plaintext tài liệu. Metadata nhạy cảm (filename, MIME) ở mức cho phép theo ADR-18 §5; nội dung luôn encrypted reference.
