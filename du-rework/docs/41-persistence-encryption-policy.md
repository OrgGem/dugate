# 41 — Persistence encryption policy and field inventory (SEC-ENC-01)

Status: **SPECIFIED → interface FROZEN by SEC-ENC-01 (offline)**. This document is the canonical persistence-encryption
policy and the field-to-writer/reader inventory the rest of `SEC-SENSITIVE-PERSISTENCE-20261006` implements against.
It does **not** claim the parent task is complete: SEC-ENC-02 (Connector), SEC-ENC-03 (source/S3 cache),
SEC-ENC-04 (worker outputs/PG blobs), SEC-ENC-05 (boot/deployment enforcement), SEC-ENC-06 (historical migration)
and VFY-SEC-ENC-01 remain open.

## 1. Policy

Sensitive data persisted anywhere in the processing flow (Orchestrator, Connector, workers) MUST be encrypted before it
reaches S3, PostgreSQL, a durable queue/outbox/cache or a dead-letter/retry store. Authentication/IAM, TLS, object
versioning and disk/SSE encryption do **not** substitute application-layer encryption for sensitive content.

**Internal transport exception (user-confirmed 2026-10-06).** Transport between internal components may be
unencrypted; internal HTTP and plaintext business payloads in authorized process memory are permitted. The exception
is TRANSPORT ONLY: the receiver encrypts before persistence, and a plaintext internal request can never be stored
verbatim for replay. Service identity, grants, tenant/role/lease authorization, integrity checks and private ingress
remain required. Public/external/provider transport is outside this exception.

Fail-closed rules:

- Missing policy, crypto seam, wrapping service or key fails the write; no plaintext fallback on error/retry paths.
- A partial write is never marked READY/SUCCEEDED; serving a missing/invalid envelope is denied in strict read mode.
- The synthetic-data exemption is **explicit only** and cannot be enabled by omitted configuration
  (`SyntheticDataExemptionSchema`, `packages/contracts/src/encryption-persistence.ts`).
- Encryption is not applied to content-free allowlisted metadata (IDs, states, approved business/profile identifiers,
  durations, non-content counters). Filename, source/callback URL, arbitrary JSON/options, prompts, session
  references, schema defaults and exception details are NOT presumed safe; an unclassified field is not an exemption.

## 2. Frozen formats (single policy, existing primitives)

| Format | Schema | Used by |
|---|---|---|
| Small metadata envelope | `SealedMetadataEnvelopeSchema` | one JSON value per PG column / outbox row (8 control-plane slots today) |
| Storage single-shot envelope ref | `StorageEnvelopeRefSchema` (+ `StorageSingleShotAadSchema`) | S3/PG objects ≤ 5 MiB, referenced by grants |
| Streaming artifact manifest | `EncryptedStorageStreamManifestSchema` | objects > 5 MiB, 4 MiB GCM chunks + per-chunk digest + keyed `manifestMac` |
| Recipient delivery envelope | `RecipientDeliveryEnvelopeSchema` | external result/download/webhook delivery (tenant public key; HPKE or RSA-OAEP wrap) |
| Wrapped DEK | `StorageWrappedDekSchema` / `WrappedDekEnvelopeSchema` | Vault Transit wrapping of the per-value DEK |

Purpose taxonomy lives in `PERSISTENCE_PURPOSES`: the eight enforced metadata slots, the storage default
`artifact-storage`, and the reserved names SEC-ENC-02/03/04 writers must use
(`connector.invocation.{request,result,session}`, `source.acquisition-cache`, `artifact.worker-output`,
`usage.outbox.payload`, `idempotency.response_body`, `webhook.delivery.payload`). A new persisted sensitive class must
add its purpose here before any writer lands.

AAD binds **tenant + purpose/slot + entity/object identity**:

- metadata: `sha256(`${tenantId}|${purpose}|${entityId}`)` (32 bytes, base64; no row id leaks)
- storage context: `{format:"du-crypto-storage-v1", tenantId, artifactId, objectVersion, purpose}`
- storage single/chunk: the context plus `sizeBytes`/`sha256` (and `index` for chunks)

The storage AAD builders in `services/orchestrator/src/modules/encryption/crypto-storage-facade.ts` now construct
these objects through the contract schemas, so facade output and contract cannot drift.

## 3. Field inventory (producer → consumer → store → format → key owner → status)

Status values: **ENFORCED** = writer seals today and a focused/negative test exists; **PLANNED** = format/purpose
frozen here, writer not yet encrypting (owner packet named); **EXEMPT** = reviewed content-free metadata.

| # | Data class / field | Producer (code) | Consumer (code) | Durable store | Format | Key owner | Status / owner |
|---|---|---|---|---|---|---|---|
| 1 | `operations.input_ref` | `modules/operations/submission.ts`, `retry.ts` | `runtime.ts`, `public.ts` | PG `operations` | sealed-metadata-v1 | Vault Transit (metadata key) | ENFORCED |
| 2 | `tasks.payload_ref` (incl. sourceUrl, join summary) | `submission.ts`, `runtime.ts` | `runtime.ts` | PG `tasks` | sealed-metadata-v1 | Vault Transit | ENFORCED |
| 3 | `human_waits.response_ref` | `runtime.ts` resume | `runtime.ts` | PG `human_waits` | sealed-metadata-v1 | Vault Transit | ENFORCED |
| 4 | `step_checkpoints.output_ref` | `runtime.ts` | `runtime.ts` | PG `step_checkpoints` | sealed-metadata-v1 | Vault Transit | ENFORCED |
| 5 | `step_checkpoints.session_ref` | `runtime.ts` | `runtime.ts` resume | PG `step_checkpoints` | sealed-metadata-v1 | Vault Transit | ENFORCED |
| 6 | `operations.prompt_overrides_ref` (prompt carrier) | `submission.ts` (carrier pin) | `runtime.ts` | PG `operations` | sealed-metadata-v1 | Vault Transit | ENFORCED |
| 7 | `tasks.result_ref` | `runtime.ts` terminal | `runtime.ts`, child join | PG `tasks` | sealed-metadata-v1 | Vault Transit | ENFORCED |
| 8 | `operations.result_ref` | `runtime.ts` terminal | `public.ts` result read | PG `operations` | sealed-metadata-v1 | Vault Transit | ENFORCED |
| 9 | Public-upload artifact bytes | `public-api/upload-encryption-gateway.ts` | `artifact-read-decrypt.ts`, delivery | S3 object + grant ref | storage single/stream + `StorageEnvelopeRef` | Vault Transit (artifact key) | ENFORCED |
| 10 | External result/download/webhook delivery | delivery/webhook egress | tenant client | wire only (ciphertext at rest not stored) | RecipientDeliveryEnvelope | recipient public key (server-side policy) | ENFORCED where tenant enabled |
| 11 | `webhook_deliveries.payload` | `modules/webhooks/webhooks.ts` | webhook dispatcher | PG `webhook_deliveries` | frozen purpose `webhook.delivery.payload` | Vault Transit | **PLANNED** (Δ121; ENC-META follow-up / SEC-ENC-04) |
| 12 | Connector `invocations.request` | `services/connector/src/db/repository.ts` | connector runtime | Connector PG (JSONB) | purpose `connector.invocation.request` | Connector/Vault-managed | **PLANNED — SEC-ENC-02** |
| 13 | Connector `invocations.result` (provider data/content) | `repository.ts` complete path | connector runtime | Connector PG (JSONB) | purpose `connector.invocation.result` | Connector/Vault-managed | **PLANNED — SEC-ENC-02** |
| 14 | Connector `invocations.session_ref` | `repository.ts`, migration 009 | poll/continue | Connector PG (TEXT) | purpose `connector.invocation.session` | Connector/Vault-managed | **PLANNED — SEC-ENC-02** |
| 15 | Source acquisition cache (URL/IAM `s3://`) | `modules/operations/ingestion-storage-s3.ts`, `ingestion-consumer.ts` | ingest/parse pipeline | destination S3 + manifest | purpose `source.acquisition-cache` | Vault Transit | **PLANNED — SEC-ENC-03** (public upload path already enforced) |
| 16 | Worker output/intermediate/session artifacts (single + multipart, PG + S3) | artifact service / worker SDK transport | artifact read path | PG blobs + S3 | purpose `artifact.worker-output` | Vault Transit | **PLANNED — SEC-ENC-04** |
| 17 | Connector usage outbox payload | `services/connector/src/db/usage-outbox.ts` | usage ingestion | Connector PG (JSONB) | purpose `usage.outbox.payload` | Connector/Vault-managed | **PLANNED — SEC-ENC-02** |
| 18 | Admin idempotency `response_body` (may echo content) | `modules/idempotency/idempotency.ts` | replay path | PG idempotency table | purpose `idempotency.response_body` | Vault Transit | **PLANNED** (classify in SEC-ENC-04/05) |
| 19 | Content-free operational metadata: ids, states, versions, timestamps, durations, counters, approved business/profile identifiers | various | queries/admin | PG columns | — | — | EXEMPT (queryable, schema-reviewed) |
| 20 | Queue job payloads / BullMQ body | queue producers | workers | Valkey | must stay reference-only (no inline content) | — | EXEMPT today via reference-only rule; any inline content becomes PLANNED |
| 21 | `profile_bindings.file_url_auth_cipher` (profile cipher) | `modules/profiles/file-url-auth.ts` | profile upsert/read, file-url download | PG `profile_bindings` | profile cipher (SHA-256 of `ENCRYPTION_KEY` or `NEXTAUTH_SECRET`) | `ENCRYPTION_KEY` / `NEXTAUTH_SECRET` | **ENFORCED** — keyless boot refused in real-data mode when artifact encryption is enabled (no synthetic exemption) |

Historical plaintext rows and backups are handled by SEC-ENC-06; enabling new-write encryption does not rewrite
history.

## 4. Strict behavior, key lifecycle

- **Startup**: crypto configuration is validated by `modules/encryption/boot-options.ts`; an absent seam historically
  meant plaintext. SEC-ENC-05 flips real-data deployments to required-by-default and makes the synthetic exemption
  visible/explicit; until then a deployment without a seam is a KNOWN GAP, not an approved mode.
- **Reads**: `metadata-read-policy.ts` provides the strict reader; a plaintext row is only readable through the
  bounded, audited migration window (`metadata-window-control.ts`, metrics + auth counter). Strict mode denies a
  missing/invalid envelope.
- **Key outage**: wrapping/unwrapping failure is `KEY_PROVIDER_FAILED` / fail-closed; no plaintext row is produced.
- **Rotation/revocation**: storage envelopes pin `keyVersion`; `rewrap` re-wraps a DEK under a target Transit version
  without touching plaintext; recipient keys have fingerprint/version/revoke semantics (`recipient-key-registry.ts`).
  Delivery to a revoked key fails 503, never plaintext.
- **Migration contract**: envelope `version` fields are the migration unit; the backfill CLI
  (`backfill-metadata-cli.ts`) and `legacy-payload-migration.ts` operate per slot with content-safe diagnostics.

## 5. Ownership boundaries

Producer/consumer ownership and leases per the parent plan: Connector repository owns SEC-ENC-02 rows (12–14, 17);
source/artifact backend owns rows 15–16 (SEC-ENC-03/04); boot/deployment owns SEC-ENC-05; data-migration owns
SEC-ENC-06; VFY-SEC-ENC-01 inspects real PG/S3 bytes with synthetic sentinels. This document and the contract module
are owned by the platform crypto/contracts integrator (SEC-ENC-01).

## 6. Documentation supersession

Some older status paragraphs still say "no encryption code exists" (e.g. `docs/04-data-state.md:84-86`,
`docs/07-internal-api.md:86-88`). They predate `metadata-crypto.ts`, the storage facade and the delivery paths and
are superseded by this document; their owners should update them under the docs lease rather than treating those
lines as current state. `docs/09-system-architecture.md:127` already reports the metadata path as implemented.
