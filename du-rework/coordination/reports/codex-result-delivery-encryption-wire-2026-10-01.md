# Result-Delivery Encryption Wire Characterization (2026-10-01)

## Scope and findings

Read-only comparison of legacy operation result/download responses and rework result/artifact delivery. Legacy has no result-encryption policy or application crypto on either response path: result JSON and output bytes are returned as plaintext at the application layer. Rework uses a tenant-scoped, server-side `deliveryEncryption` policy for both the result JSON and artifact bytes. When that policy is enabled, a missing, revoked, unavailable, or unusable recipient key fails the request with 503; the enabled path does not downgrade to plaintext.

An absent/disabled rework policy intentionally selects its plaintext response path. That is a policy decision, not a crypto-failure fallback. The public result and download requests contain no caller-controlled plaintext override.

## Legacy result and output-file delivery

`GET /api/v1/operations/:id` loads the operation and returns `formatOperationResponse(op)` as JSON (`app/api/v1/operations/[id]/route.ts:14-37`). A missing/deleted operation returns 404 (`:22-26`); an `x-api-key-id` mismatch returns 403 only when that header is present (`:29-35`). A successful operation's JSON result contains `output_format`, `content`, `extracted_data`, `pipeline_steps`, `usage`, and a `download_url` (`lib/pipelines/format.ts:35-50`). The `content` value is copied from the operation's `outputContent`; successful processing stores `currentText` there (`lib/pipelines/engine.ts:397-414`). No result encryption or ciphertext envelope is applied by the formatter or route.

`GET /api/v1/operations/:id/download` returns 404 for a missing/deleted operation, 403 for a present mismatching `x-api-key-id`, and 409 until the operation is done and `SUCCEEDED` (`app/api/v1/operations/[id]/download/route.ts:19-41`). On success, inline `outputContent` is returned directly with a format-derived `text/html`, `application/json`, or `text/markdown` content type (`:44-57`). Otherwise it streams `outputFilePath` from local or S3 storage with the same format-derived content type; file/backend errors and absent output return 404 (`:60-118`). Neither branch encrypts the response bytes in the application.

There is no legacy result-encryption concept in these paths. The operation formatter copies plaintext fields, and the download route returns the stored string or stream without a crypto call (`lib/pipelines/format.ts:17-50`; `app/api/v1/operations/[id]/download/route.ts:44-105`). Legacy output is therefore plaintext end to end at the application layer. The local storage backend writes the stream directly to a file (`lib/storage/local-backend.ts:22-47`); the S3 adapter sends the stream as the object body and sets content type, without an application encryption or server-side-encryption parameter (`lib/storage/s3-backend.ts:48-77`). The repository does not establish whether deployment infrastructure adds TLS or storage-layer encryption; those are outside this application behavior.

## Rework policy selection

The effective delivery setting is a per-tenant server-side policy. The Admin configuration mutation accepts a boolean `deliveryEncryption` and optional `recipientKeyVersion` (`du-rework/services/orchestrator/src/server.ts:2664-2695`); the API is `POST /api/v1/admin/crypto-config` (`:2613-2629`). The store persists `delivery_encryption` and `pinned_recipient_key_version` per tenant (`du-rework/services/orchestrator/src/app/admin/crypto-config-store.ts:17-27,30-47`), and enabling delivery encryption is rejected with 409 if there is no usable recipient public key (`du-rework/services/orchestrator/src/app/admin/crypto-config-api.ts:286-295`).

At composition, the store-backed configuration takes precedence over static `ServerConfig.deliveryEncryption.policyByTenant`; the stored boolean becomes policy `enabled`, and the configured recipient version becomes `pinnedRecipientKeyVersion` (`du-rework/services/orchestrator/src/server.ts:370-378,500-510,1122-1145`). The policy type contains `enabled`, optional suite, and optional pinned recipient key version (`du-rework/services/orchestrator/src/modules/public-api/delivery-encryption.ts:34-46`); its service documents absent policy as plaintext (`:96-110,142-169`). Static per-tenant policy is also a server configuration input (`:59-67`).

Neither public delivery route selects this policy from a query parameter, request body, or header. `/result` resolves it using the authenticated API key's tenant ID (`services/orchestrator/src/server.ts:1926-1930,1990-1994`); artifact download does the same (`:2010-2032,2054-2059`). The policy is evaluated for every request.

## Rework result JSON response

For a successful operation, `GET /api/v1/operations/:id/result` creates the plaintext result envelope `{schemaVersion, data, artifacts, usage, warnings}` (`du-rework/services/orchestrator/src/server.ts:1979-1985`). With policy absent or disabled, it returns that envelope with HTTP 200 (`:1990-1999`). With encryption enabled, `encryptedDeliveryBody` serializes that exact plaintext envelope, encrypts it, and returns `{schemaVersion: "1", encrypted: true, delivery}` (`:1891-1915,1986-1999`). The contracts define plaintext and encrypted result variants as a union, and specify that decrypting `delivery` yields the original `ResultEnvelope` (`du-rework/packages/contracts/src/operations.ts:171-195`).

Both variants are JSON and use the listener's default `content-type: application/json` (`du-rework/services/orchestrator/src/server.ts:716-720,798-810`). Encryption changes the JSON envelope shape and the bytes inside it, not the content type. Operation state errors remain 409 (or 410 for expired operations) before delivery encryption is attempted (`:1931-1937`).

## Rework artifact download response

The artifact download is a separate `GET /api/v1/artifacts/:id/download` path referenced by result artifact entries (`du-rework/services/orchestrator/src/server.ts:1971-1978,2010-2017`). It first tenant-scopes the artifact and verifies its READY state (`:2012-2039`). If the stored artifact is sealed at rest, the route decrypts it before delivery (`:2041-2053`); this at-rest read step is separate from delivery encryption.

When the tenant delivery policy is enabled, the route buffers the artifact within the configured blob limit, independently calls the same delivery-envelope helper on the artifact bytes, and includes `artifactId` and `mimeType` as outer metadata (`du-rework/services/orchestrator/src/server.ts:2054-2077`). It returns JSON with `content-type: application/json`; the contract shape is `{schemaVersion, encrypted: true, delivery, artifactId, mimeType}` (`du-rework/packages/contracts/src/operations.ts:198-208`). With delivery encryption absent or disabled, it streams the artifact bytes unchanged with the artifact's MIME type (`du-rework/services/orchestrator/src/server.ts:2078-2083`; contract `du-rework/packages/contracts/src/operations.ts:211-215`). Thus artifact bytes are encrypted independently at download time under the same tenant policy; they do not inherit the result JSON ciphertext. Artifact lookup failures return 404, non-READY state returns 409, and the bounded-read helper documents 413 on exceeding its cap (`server.ts:2033-2039,1876-1883`).

## Encryption failure behavior

Legacy has no selectable encryption branch, key registry, or crypto-failure path in either result handler. Its responses remain plaintext because encryption is not implemented there; this is not a fallback triggered by a failed encryption attempt.

In rework, once policy is enabled, key and crypto failures are fail-closed:

| Condition | Observed behavior | Source |
|---|---|---|
| Delivery policy disabled or absent | Return the normal plaintext result or raw artifact stream; this is policy-selected plaintext. | `du-rework/services/orchestrator/src/server.ts:1902-1904,1995-1999,2058-2083` |
| Enabled with registry unconfigured/unavailable | The service throws a registry error and the route translates it to HTTP 503; no plaintext result or bytes are returned. | `du-rework/services/orchestrator/src/server.ts:1855-1874,1904-1914`; `du-rework/services/orchestrator/src/modules/public-api/delivery-encryption.ts:180-185,199-210` |
| No current or pinned recipient key, or key revoked | Translate to HTTP 503; pinned-key lookup does not fall back to the current key. | `du-rework/services/orchestrator/src/server.ts:1855-1869`; `du-rework/services/orchestrator/src/modules/public-api/delivery-encryption.ts:187-210` |
| Invalid/unusable registered key material or crypto operation failure | Delivery encryption throws a crypto failure, translated to HTTP 503. Unsupported HPKE also throws rather than returning plaintext. | `du-rework/services/orchestrator/src/modules/public-api/delivery-encryption.ts:214-220,226-264`; `du-rework/services/orchestrator/src/server.ts:1870-1874,1908-1914` |

The service constructs AES-256-GCM ciphertext and wraps its fresh DEK using the registered recipient public key (`du-rework/services/orchestrator/src/modules/public-api/delivery-encryption.ts:222-258`). If the registry instead contains a syntactically usable but unintended public key, the server has no recipient private key with which to detect that mismatch; it encrypts to the registered public key, so the intended receiver may be unable to decrypt. That case is not a plaintext downgrade.

## Caller-controlled downgrade check

No legacy result-encryption toggle exists, so there is no legacy crypto mode for a caller to downgrade. In rework, the `ServerConfig` contract states this is platform configuration, never caller input, and explicitly says a client cannot select plaintext, key ID, or key version (`du-rework/services/orchestrator/src/server.ts:370-378`). The result route passes only tenant ID and serialized result to the policy helper, and the artifact route likewise uses only the tenant policy (`:1990-1994,2054-2077`). No result/download query flag, request body field, or request header bypasses an enabled tenant policy. The Admin `deliveryEncryption` mutation is an authenticated control-plane configuration change, not a per-delivery request override (`:2613-2695`).
