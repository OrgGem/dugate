# SEC-SENSITIVE-PERSISTENCE-20261006

Status: SPECIFIED / TODO. User confirmed on 2026-10-06: sensitive data persisted in S3 or databases anywhere in the processing flow MUST be encrypted. This is mandatory for real data, including local/live environments; synthetic fixtures may use an explicit isolated exemption. No implementation, verification, acceptance or live cutover is claimed by this packet.

Parent: DU-PLATFORM-MIGRATION-2026-10-05.md, SEC-SENSITIVE-DATA-20261006. Findings: coordination/reports/sensitive-data-security-review-2026-10-06.md (SD-01..04 primary; SD-05..08 remain dependent security work).

## Required invariants

- Every sensitive input, source cache, output, intermediate, checkpoint, provider invocation/result, session handle and sensitive metadata copy persisted by Orchestrator, Connector or workers is encrypted before it reaches S3, PostgreSQL, an outbox or another durable store. Authentication/IAM, TLS and object versioning do not substitute encryption at rest.
- Reuse existing managed-key envelope encryption (AES-256-GCM, independent per-object/value DEK, Vault wrapping), bind tenant + data purpose/slot + row/object identity via AAD, preserve authenticated immutable manifest versions. No custom cryptographic suite, static data key in DB, browser or worker image.
- All writes fail closed if policy, crypto seam, wrapping service or required key is unavailable. A partial write cannot be marked READY/SUCCEEDED; error/retry paths cannot fall back to plaintext. Serving a missing/invalid envelope is denied in strict mode.
- Separate plaintext business hash/length used for matching/replay from stored ciphertext hash/length used for transfer/integrity. Ciphertext must not change invocation idempotency semantics, artifact grants or immutable completion timestamps.
- Content-free allowlisted operational metadata may remain queryable (IDs, states, approved business/profile identifiers, durations and non-content counters). Filename, source/callback URL, arbitrary JSON/options, prompts, session references, schema defaults and exception details are not presumed safe; classify each persisted field. An unclassified field is not an approved plaintext exception.
- Queryable metadata exemptions are documented and reviewed; decryption follows tenant/role/lease authorization. UI settings must report actual enforcement, not only a saved flag.
- Historical plaintext and backups require a tracked migration/retention disposition. Closing a read window does not erase old bytes; enabling new-write encryption does not rewrite history.
- Canonical shared contracts/crypto helpers stay in the Orchestrator repository under the migration architecture. Workers use runtime/API-mediated writes where possible; do not introduce a separate SDK repository or grant them broad Vault privileges.

## User-confirmed internal transport exception

User clarification on 2026-10-06: transport between DU Rework internal components may be unencrypted. Internal HTTP and plaintext business payloads in transit/in authorized process memory are permitted; do not mandate TLS/mTLS or delivery-payload encryption for internal Orchestrator/Connector/worker/server-BFF communication solely to complete this packet.

This exception is TRANSPORT ONLY. The receiver must encrypt sensitive data before any S3, DB, durable queue/outbox/cache or retry/dead-letter persistence. A plaintext internal request cannot be stored verbatim for replay. Service authentication/signed identity, grants, tenant/role/lease authorization, integrity checks and private ingress boundaries remain required. Public/external/provider transport is outside this exception and retains its applicable controls. Temp-file protection remains the separate SD-07 task; the exception does not authorize plaintext durable copies.

Acceptance includes internal HTTP interoperability plus ciphertext-only sensitive persistence. Storage encryption and internal delivery encryption are distinct policies; avoid requiring every worker to carry cryptographic keys when backend-managed encryption can enforce persistence.

## Execution ownership and order

Existing single coordinator binds concrete available agents and non-overlapping file leases. This document is ready for assignment; it does not dispatch a new coordinator or open a live window. No commit/push/cutover unless separately authorized.

SEC-ENC-01 freezes the producer/consumer interface and persisted-field inventory. Implement SEC-ENC-02/03/04 in parallel only after their shared interface is agreed; shared crypto files and create-app.ts belong to one integration owner. SEC-ENC-05 may prepare config/docs in parallel but enforcement integrates completed writers. SEC-ENC-06 prepares historical migration after field formats are frozen. VFY-SEC-ENC-01 verifies the complete current candidate; independent reviewer acceptance follows.

### SEC-ENC-01 - canonical persistence policy and field inventory

Owner: platform crypto/contracts integrator. Allowed paths: packages/contracts encryption schemas; services/orchestrator/src/modules/encryption; architecture/security docs. Coordinate existing metadata-crypto ownership. Read-only dependencies: Connector repository, worker SDK, all writer call sites.

- [ ] Inventory every sensitive write and read: operations/task input/result, human waits and context, checkpoint output/session, prompt carriers/config, source cache, artifact blobs/manifests, invocation request/result/session, idempotency/outbox payloads and sensitive operational fields. Record producer, consumer, store, encryption format, key owner and plaintext exemption if any.
- [ ] Freeze one required-encryption policy/format and migration contract, reuse existing primitives; define compatible streaming artifact and small metadata envelopes. Only metadata needed to locate/decrypt the ciphertext may remain in sidecars without additional protection; sensitive sidecar fields are encrypted.
- [ ] Define strict service startup/read/write behavior, key outage and rotation/revocation semantics. Explicit synthetic-data exemption cannot be enabled by omitted configuration.
- [ ] Publish producer/consumer ownership, lease boundaries and tests; update API/contracts/docs where wire behavior changes. Regenerate OpenAPI through its generator, never hand-edit docs/21.

Acceptance: field-to-writer/reader matrix complete, approved exemptions explicit, format freeze available to all consumers; focused tamper/AAD/key-failure tests. No inventory-only acceptance of the parent.

### SEC-ENC-02 - Connector invocation encryption (SD-01)

Owner: Connector backend. Allowed paths: services/connector/src/db, runtime/ledger composition, migrations and focused tests; canonical helper edits through SEC-ENC-01 owner.

- [ ] Seal persisted invocation request, provider result/data/content and session_ref before SQL execution. Inject managed crypto into the production ledger, not only a mock/test implementation. Protect arbitrary sensitive adapter configuration identified by inventory.
- [ ] Open content only after trusted invocation/tenant authorization; support pending poll, continuation sessions, failure/cancel and duplicate invoke/get/cancel replay with unchanged hashes and stable IDs.
- [ ] Fail on missing keys/wrapping outages/tampering; no plaintext fallback or unsafe result/payload in SQL logs, error strings, audit or usage outbox.
- [ ] Provide versioned schema/read migration hooks and content-safe diagnostics for historical rows.

Acceptance: actual PG persisted request/result/session cannot contain synthetic plaintext sentinels; wrong tenant/row/slot fails; key outage creates no plaintext row; poll/resume/replay survives restart and key rotation. Credential encryption alone cannot satisfy this task.

### SEC-ENC-03 - encrypted source acquisition and S3 cache (SD-02)

Owner: Orchestrator source/artifact backend. Allowed paths: modules/operations/ingestion-storage-s3.ts, ingestion-consumer.ts, source integration/tests; coordinate create-app.ts through integrator.

- [ ] Both HTTP URL and IAM-role s3:// source acquisition stream through the canonical envelope writer before destination S3 persistence. Preserve tenant/bucket/prefix/expected-owner controls and default role credential chain; no static access keys required.
- [ ] Persist ciphertext/manifest version IDs and metadata needed by the strict decrypt reader. Cache reuse validates authorization, integrity and content expiry.
- [ ] Keep business hash/length separate from encrypted transfer hash/length; READY gate commits only a readable encrypted object. Abort/reconcile orphan object/manifest versions after checksum failure, cancellation or crash.

Acceptance: captured destination body has no plaintext sentinel; real S3-compatible storage + strict reader roundtrip succeeds; missing markers/tampered manifests fail; restart/retry/source pin reuse remains stable. Test URL and role-based source legs, not just public direct upload.

### SEC-ENC-04 - encrypted worker outputs and PostgreSQL blobs (SD-03)

Owner: artifact backend/SDK integrator plus worker owners on separate source leases. Allowed paths: artifact/runtime write/read services, packages/worker-sdk artifact transport, three worker entrypoints and template; freeze shared paths to one integrator.

- [ ] Cover single upload, multipart upload, worker output/intermediate/session files and legacy/compat upload paths on BOTH PostgreSQL and S3. Prefer server-managed streaming encryption; choose a single reviewed production implementation rather than parallel incompatible envelopes.
- [ ] Runtime admission/finalize enforces required encryption server-side. Raw direct storage writes must not bypass enforcement; an untrusted worker cannot satisfy policy merely by setting a marker or boolean.
- [ ] Ensure encrypted bytes can be read using the canonical tenant-bound reader; PG blob and metadata encryption are distinct requirements. Wire production document-core, lc-checker, example-review and pilot template consistently.
- [ ] Keep worker privilege minimal: do not distribute master keys or broad Vault tokens. Reject missing crypto instead of plaintext upload. Document artifact size/hash/grant contract changes and update consumers.

Acceptance: inspect actual artifact_blobs.bytes and S3 object bytes/manifests for all three workers and both storage backends; single/multipart outputs roundtrip; no seam/policy outage rejects before plaintext persistence; mismatched tenant/lease/envelope denied.

### SEC-ENC-05 - mandatory real-data boot and deployment policy (SD-04)

Owner: platform boot/deployment integrator. Allowed paths: main/boot-options/composition/config, Compose/env samples, local-dev scripts and deployment docs; coordinate shared source leases.

- [ ] Required encryption is the real-data default across PG/S3 and every producer. A missing flag, partial crypto config or missing key fails startup with content-safe error. Only an explicit synthetic-data mode may opt out, isolated from real tenant data.
- [ ] Apply strict metadata read mode after historical readiness; legacy reads allowed only through explicit bounded audited migration window. Do not silently manufacture Vault secrets or enable a migration window in scripts.
- [ ] Surface effective encryption policy and applied configuration per service in existing health/admin views; a Portal toggle cannot weaken the platform real-data requirement.
- [ ] Document and verify S3 bucket SSE/KMS as defense in depth plus bucket policy, PG/Valkey volume and backup encryption, secret mounts and key ownership. Application envelopes remain required for sensitive content even with disk/S3 server-side encryption.
- [ ] Local runner builds/verifies the updated services and refuses real-data startup without required encryption config; synthetic test mode is visible. Preserve public/internal ingress boundaries.

Acceptance: boot matrix PG/S3 x real/synthetic x complete/missing/outage config, actual worker production wiring, and no successful real-data plaintext write. Deployment tests include effective policy, not environment strings alone.

### SEC-ENC-06 - historical data migration and compatibility

Owner: data migration/crypto owner. Allowed paths: encryption/backfill CLI, Connector migration helpers, migration runbooks/tests; no shared/live DB or S3 mutations in implementation phase.

- [ ] Dry-run inventory and resumable, bounded backfill for DB content and S3 artifact/source/manifest copies; use managed keys and authenticated context. No sensitive values in receipts or logs.
- [ ] Compare decrypted business hash/length before and after, preserve IDs, active invocation sessions, retry/replay and immutable started_at/completed_at. Coordinate claims to prevent two writers during backfill.
- [ ] Keep migration status/revision and counts; refuse strict cutover while incompatible historical rows remain. Rollback does not create new plaintext copies.
- [ ] Specify removal/expiry of old plaintext object versions, PG rows/WAL/backup snapshots and cache copies with deployment owners. Backfill itself cannot guarantee erasure from historical backups.

Acceptance: isolated PG/S3 backfill supports interruption/restart and strict post-migration readers; historical/current data preserve behavior; an operator-reviewable dry-run and version/backup disposition exist. Live migration/cutover remains a separate action.

### VFY-SEC-ENC-01 - independent persistence verification and security review

Owner: existing independent tester; reviewer: assigned independent backend/security reviewer. Write lease: tests/harness, reports and isolated fixture namespaces only; production source read-only.

- [ ] Exercise real public upload/URL/IAM-S3 acquisition -> operation/task/outbox -> every worker -> Connector -> checkpoint/output -> Portal/result/download on the current candidate.
- [ ] Inspect actual PG JSONB/TEXT/BYTEA and destination S3 object/manifest versions using synthetic unique sentinels; verify no sensitive plaintext in every inventoried persistent copy, logs or dead-letter/retry content. Merely decoding an encrypted API response is insufficient.
- [ ] Wrong-tenant/row/slot tamper, missing keys, Vault outage, crash/restart, rotation, concurrent retry, multipart failure and historical backfill. Failures must not leak plaintext or leave falsely READY data.
- [ ] Record candidate digest, commands/cwd, isolated DB/Redis/S3/Vault namespaces, passed/failed/skipped, raw output and findings. Offline mocks do not replace this gate; skipped cases remain OPEN.
- [ ] Independent reviewer assesses complete field matrix and deployment evidence; record APPROVED or CHANGES_REQUIRED. Parent stays unchecked until full required acceptance is satisfied.

## Related lifecycle work remains OPEN

SD-05 retention/purge, SD-06 content expiry, SD-07 protected temp storage and SD-08 no-store headers remain required by SEC-SENSITIVE-DATA-20261006. Encryption tasks do not close them. Retention duration by data class still needs agreement; no arbitrary duration is introduced here. Core encryption writers can proceed without waiting for that duration decision.
