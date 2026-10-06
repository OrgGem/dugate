# Sensitive data security review ? SEC-SENSITIVE-DATA-20261006

Date: 2026-10-06. Reviewer: Codex, requested security-review role. Scope: current dirty working tree in du-rework, canonical services/packages/businesses/Portal/Compose. This is a focused application data-lifecycle review, not a penetration test, dependency audit, certification or inspection of deployed infrastructure. No product changes, real database writes, AWS calls, secrets inspection, deployment, commit or push performed.

**Verdict: CHANGES_REQUIRED for the stated sensitive-data deployment.** Six High and two Medium findings. Severity reflects disclosure/retention risk under the user's policy, not a calculated CVSS score. Existing implementation gate status is not promoted or closed. A component offering encryption does not establish encryption of every persistent copy; expiry of a grant does not establish deletion of its object.

## Findings

### SD-01 ? HIGH: Connector durably stores provider inputs/results without application encryption

Evidence: services/connector/src/db/repository.ts:66-77 inserts JSON.stringify(request) directly into connector_invocations.request; :125-141 persists JSON.stringify(result) into result JSONB; :215 retains session_ref as text. services/connector/src/types.ts:48-58 includes invocation input/options/session; :81-90 result includes content/data/session. composition.ts:93 constructs PostgresInvocationLedger without a payload encryption seam. db/migrations/001_connector.sql:25 defines durable invocation request/result rows. CONNECTOR_ENCRYPTION_KEY protects credential secrets, not these document fields.

Impact: extracted text, prompts, provider output and session handles remain readable in a SQL export, database access, WAL or backup even if Orchestrator metadata encryption is enabled. External disk/database encryption is not established by this code review and does not replace the configured application envelope policy.

Fix/owner: Connector backend + canonical crypto contracts. Encrypt request/result/session with tenant/column/invocation AAD and managed wrapped keys, decrypt only after authorization; retain content hashes and safe replay metadata. Add an explicit historical migration, strict no-plaintext mode, content minimization and retention. Tests must inspect actual persisted SQL bytes, cover polling/resume/idempotent replay, wrong tenant/AAD and key outage. Do not break active invocations through an ad hoc purge.

Status: CONFIRMED by code and offline compiled-ledger SQL probes.

### SD-02 ? HIGH: URL/S3 source ingestion bypasses the encrypted artifact gateway

Evidence: services/orchestrator/src/modules/operations/ingestion-storage-s3.ts:85 yields acquired chunks unchanged; :91-99 puts Readable.from(measured()) to S3, no CryptoStorageFacade, envelope metadata or explicit KMS key. app/bootstrap/create-app.ts:574-583 wires that implementation directly into ingestionConsumer. Metadata encryption passed at :602 protects input_ref/payload_ref, not object bytes.

Impact: application sends readable source document bytes to storage even in the S3 deployment that requires envelope-encrypted public uploads. AWS bucket default SSE can protect physical storage but cannot be inferred here; IAM role authentication and HTTPS do not provide application envelope encryption. There is also a contract mismatch: create-app.ts:438-445 requires encrypted artifact reads, and modules/encryption/artifact-read-decrypt.ts:199-210 rejects missing du-encrypted marker. These source copies can therefore persist and then fail encrypted reads.

Fix/owner: Orchestrator source/artifact storage + crypto. Route URL and role-based S3 acquisitions through the same bounded streaming envelope writer, commit the immutable ciphertext and manifest versions, and distinguish plaintext business integrity from stored ciphertext integrity. Clean up unpublished objects/versions on failures. Preserve IAM role/no-static-key source acquisition. Test real reader/writer roundtrip with strict encryption enabled, including rejected checksum/version responses and crash recovery; mock client body must not contain plaintext.

Status: CONFIRMED by composition and offline PutObject-body probe. No claim that deployed S3 physically stores unencrypted bytes; bucket policy was not inspected.

### SD-03 ? HIGH: Worker output artifact writes can remain plaintext while backend encryption is on

Evidence: packages/worker-sdk/src/task-context.ts:728 enforces encryption only when deps.encryptionEnabled is explicitly set; :734-755 falls back to uploadArtifactStream(content) without crypto. businesses/document-core/src/main.ts:38-49 passes no crypto/encryptionEnabled/chunkedEncryptionEnabled; worker.ts:2103 forwards this config to startWorker. Orchestrator modules/artifacts/artifacts.ts:492-501 issues direct S3 upload grants; its finalize path verifies size/hash/version, not an encryption envelope. Public upload encryption therefore does not automatically encrypt worker-produced outputs.

Impact: sensitive generated/converted/extracted output can reach PG blobs or S3 as application plaintext; strict S3 read path can later reject these objects. Turning encryption on in the Portal/backend alone does not close this write path.

Fix/owner: canonical worker SDK + all worker entrypoints + artifact service. Prefer server-mediated encrypted writes so workers never need Vault wrapping privileges, or wire an authenticated worker crypto seam and a mandatory policy from runtime. Enforce the policy at server admission/finalize, not only a worker boolean; supply one compatible envelope/manifest writer and reader. Verify every deployed worker, single-shot/multipart writes, wrong tenant/epoch and missing crypto. Static evidence here specifically follows document-core's production entrypoint; other worker entrypoints require matching verification.

Status: CONFIRMED code-path exposure; no live worker upload executed in this review.

### SD-04 ? HIGH: Production PostgreSQL configuration permits encryption to be disabled by omission

Evidence: modules/encryption/boot-options.ts:223-225 returns no crypto blocks when PG backend has both flags absent/off. No NODE_ENV production guard exists in that decision. main.ts:244 consumes the null result. .env.local.sample defaults to postgres and does not enable the flags. This local convenience remains permitted in production by the same boot code.

Impact: operations input, task payloads, checkpoint output and result references can be stored without application encryption through a configuration omission. Enabling metadata encryption alone is insufficient to secure independent artifact/Connector paths above.

Fix/owner: platform boot/deployment. Introduce an explicit sensitive-data deployment policy that refuses startup unless all required data writers, managed keys and strict metadata read mode are active. Keep an explicit isolated synthetic-data dev opt-out. Backfill historical rows before requiring forbid; encrypting new writes does not rewrite existing rows or backups.

Status: CONFIRMED compiled boot probe with NODE_ENV=production and ARTIFACT_STORAGE_BACKEND=postgres returns null.

### SD-05 ? HIGH: No end-to-end bounded retention for completed sensitive request data

Evidence: Orchestrator app/bootstrap/create-app.ts:984-1019 schedules lease/queue-integrity/multipart/webhook work, not completed-request content purge. Source materialization modules/operations/ingestion-consumer.ts:266-269 inserts READY source artifacts without expires_at. Connector has no invocation-content purge/TTL in production sources. Orchestrator modules/idempotency/idempotency.ts:155-158 expressly leaves its purge helper unwired. Searches of DELETE FROM in canonical production sources locate blob abort/verification cleanup and configuration deletions, not a request lifecycle erasure job. A multipart STAGING timeout is not a READY artifact retention policy.

Impact: inputs, outputs, intermediate/checkpoint data, Connector invocation content and associated copies can persist without a business-approved retention deadline. Encryption alone does not establish short retention. Soft-delete, hiding in UI, operation cancellation or updated_at changes do not constitute erasure.

Fix/owner: Orchestrator lifecycle/storage + Connector + deployment. Define separate content versus content-free audit retention, retention deadline anchored to immutable completion/creation policy, maximum lifetime for abandoned work, and cross-service purge acknowledgment. Delete ciphertext/sidecars/versions, PG content, stale outbox and eligible replay content while preserving minimal idempotency tombstones. Handle active references/retry windows explicitly; post-retention retry requires fresh submission. Include S3 current/noncurrent versions, failed uploads, PostgreSQL WAL/backups, Valkey AOF/snapshots, logs and provider retention contracts in deployment policy. Preserve completed_at during cleanup.

Status: CONFIRMED missing scheduler/default expiry in reviewed application sources. Any external retention controller, bucket lifecycle or backup policy is unverified, not assumed absent from the deployed estate.

### SD-06 ? HIGH: Artifact content expiry is not enforced on all reads

Evidence: modules/artifacts/artifacts.ts:404-428 selects state/tenant/version but does not load/check artifacts.expires_at; :474-483 issues a fresh download grant. http/routes/public.ts:578-601 authorizes a published input/output download without an expires_at predicate. Runtime blob route checks token_expires_at (grant expiry), which is a different lifetime. Submission/retry expiry checks do not cover these read paths.

Impact: an artifact with an elapsed content-retention deadline can remain readable when still READY, including obtaining a fresh read grant. A delayed or failed erasure job leaves an access window beyond the content policy.

Fix/owner: artifact backend/public/runtime API. Apply shared content-expiry authorization at grant issue and byte-read/download, preferably at the database snapshot under the relevant row lock. Clip grant expiry to remaining content lifetime; recheck reads and redirects. Distinguish content-expired response from missing/foreign according to disclosure contract. Test expired READY rows, already-issued grants and concurrent expiry/purge using a controlled clock.

Status: CONFIRMED offline service probe issued a fresh read grant for an expired READY row. Public read exposure is static source evidence, not a live HTTP reproduction.

### SD-07 ? MEDIUM: Plaintext parser temp files depend on cleanup rather than protected ephemeral storage

Evidence: packages/worker-sdk/src/artifact-streams.ts:164-165 defaults to os.tmpdir(); businesses/document-core/src/pipelines/parser-budget.ts:125-151 writes acquired/decrypted document bytes to a normal file and :229 disposes in finally. SDK stale threshold is 2h (:124); :260-270 keeps live/referenced dirs without an age ceiling, and reference check :310-318 is tenant-wide and conservatively retains on uncertainty. compose/document-core.yml has no tmpfs/encrypted-temp mount. This is not a finding that normal successful cleanup is absent: it exists.

Impact: crash, SIGKILL or stalled cleanup can leave readable temp copies on the host/container writable layer; snapshots/swap may retain them. Reference protection provides correctness, not a hard confidentiality-retention bound. Risk becomes High if deployment actually uses persistent unencrypted temp storage with real sensitive data.

Fix/owner: workers/parser + deployment. Use bounded tmpfs with controlled permissions and swap policy, or ephemeral encrypted volumes/keys; isolate worker temp root, monitor oldest plaintext age, remove after operation use and on shutdown/crash recovery. Do not overwrite-delete arbitrary SSD files as a guarantee of secure erasure. Test crash/restart and disk-full paths; verify deployed mounts rather than claiming tmpfs from code alone.

Status: CONFIRMED static data path; actual filesystem encryption/swap/mounts unverified.

### SD-08 ? MEDIUM: Sensitive public/runtime responses do not enforce no-store at the backend

Evidence: app/bootstrap/create-app.ts:718-719 sets correlation/content type, :829 passes route headers, :831-839 streams response with no central Cache-Control. Public artifact download http/routes/public.ts:646-650 returns only content-type. Source search finds no no-store policy in those public/runtime handlers. Portal BFF upstream.ts:180-183 DOES use no-store.

Impact: authenticated clients or middleware can retain downloaded documents/results locally contrary to strict data handling. This is not evidence of a shared-cache cross-tenant leak: Authorization responses have additional cache restrictions, and no proxy was tested.

Fix/owner: HTTP middleware + deployment. Add Cache-Control: no-store for sensitive JSON/artifact/runtime responses and errors containing identifying details, keep static hashed Portal assets cacheable, configure ingress/CDN/access logs consistently. Verify actual response headers for API key, runtime grant and BFF paths. Clients/providers still require their own storage policy.

Status: CONFIRMED missing backend policy, deployment/client behavior unverified.

## Protections observed and limits

- Orchestrator metadata AES-256-GCM envelopes bind tenant/slot/row; wrapped per-value DEKs use Vault. Metadata read mode now supports forbid and a bounded legacy window. Do not reuse older docs claiming every reader hardcodes allowPlaintext=true: that statement is stale for the current control point.
- S3 boot requires crypto config, and the public upload gateway writes an encrypted marker/manifest. Strict read rejects marker-less objects. The separate writers above are the coverage gaps.
- Shared logging redacts request/response payloads, secrets, paths and class-only errors; worker diagnostics only retain compiled file locations. This audit did not establish a complete no-PII proof across all third-party tools/container access logs.
- Portal BFF uses no-store, role/tenant authorization and CSRF. No localStorage/sessionStorage/IndexedDB storage of document content was identified in Portal source searched. Browser RAM/DOM still receives authorized details.
- Worker temp finally cleanup, startup/timer sweeps and grant method/expiry fences exist. These controls do not substitute content retention and protected storage.
- IAM source roles avoid explicit access keys; source tenant/bucket/prefix/expected-owner policy is separate from content encryption. No real AWS IAM/bucket/KMS/lifecycle configuration inspected.
- Default Compose persists PG and Valkey volumes; Valkey AOF is enabled. Storage, transport TLS, backup snapshots and provider zero-retention settings need deployment evidence. No arbitrary claim that the whole Redis queue contains document bytes: reviewed design queues identifiers/references.

## Evidence and validation

Node v24.21.0, existing built artifacts from the current prior owner build. Workspace is dirty and concurrently edited; there is no immutable release digest. Probe files inspect compiled code plus source evidence above; re-run against the release candidate after remediation.

- `node du-rework/coordination/reports/sensitive-data-review-probe-2026-10-06.cjs`, cwd D:/Git/dugate: **6/6 exposure probes passed, exit 0**. Mock SQL/S3 only; synthetic sentinels; no real DB/network/credentials/user content. Raw: sensitive-data-review-probe-2026-10-06.log. A green probe here confirms a defect, not security acceptance.
- From services/orchestrator, Node 24 `node node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/encryption-boot-options.test.ts tests/metadata-read-policy.test.ts tests/crypto-storage-facade.test.ts tests/request-redaction.test.ts`: **4 suites, 167 passed, 0 failed, exit 0**. Raw: sensitive-data-security-tests-2026-10-06.log and .exit.txt. These prove existing primitives and policy tests, not end-to-end persistence coverage.
- All application findings remain OPEN. No code fixes, complete stack verification, dependency rescan or security acceptance performed in this review.

## Recommended order and acceptance

1. Close SD-01/02/03 writer gaps before admitting real sensitive content.
2. Apply SD-04 policy to every producer/consumer, migrate historical data and decide backup/key lifecycle.
3. Implement SD-05/06 bounded retention and read enforcement as one lifecycle contract; preserve immutable completion timing and safe replay tombstones.
4. Harden temp storage and no-store headers (SD-07/08), then independently test crash/key-outage/purge/replay scenarios across Orchestrator, Connector, all workers and Portal.

Final acceptance requires an agreed retention duration by data class and deployment evidence for encrypted volumes/backups, S3 version lifecycle, tmpfs/swap and provider retention. No duration has been invented in this review.
