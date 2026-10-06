# BACKFILL-WIRING-DESIGN-808 — 2026-10-05

**Task:** `task_47428dbcee5e` / dispatch `ctx_9a2ff8d85cdb`
**Scope:** source-only design for the production entry point and controls around the existing result-ref backfill. No source or tests were changed; no live database, Vault, or migration was run.

## Finding: the backfill has no production entry point

Production-source grep found declarations and implementation only: `backfillLegacyPayloads` is exported at `services/orchestrator/src/modules/encryption/legacy-payload-migration.ts:324`; `ResultRefPgMigrationStore` is declared at `:798`. There is no production `new ResultRefPgMigrationStore(...)`, `backfillLegacyPayloads(...)`, or `createBoundedDualReadWindow(...)` caller under `services/orchestrator/src`.

Current references that do exist are test-only: `services/orchestrator/tests/encmeta-enc09-kind.test.ts:164,229-363` and `services/orchestrator/tests/legacy-payload-migration.test.ts:172-269` construct stores/windows and invoke the framework. Production startup (`main.ts:146-186`, `app/bootstrap/create-app.ts:295-307`) constructs the optional metadata crypto seam, but never constructs a migration store or calls the backfill. The package exposes schema commands and `migrate:artifact-blobs` only (`services/orchestrator/package.json:17-20`); `migrate-cli.ts` handles schema migration/status/verify, while `storage-migration-cli.ts:1-50` handles S3 artifact blobs, not result refs. There is no scheduled production job either.

The bounded helper is real but not wired: `MAX_DUAL_READ_WINDOW_MS` is 14 days (`legacy-payload-migration.ts:27`), and `createBoundedDualReadWindow` validates and freezes the interval (`:500-519`). However, `ResultRefPgMigrationStoreOptions.window` is optional (`:771-780`) and `windowOpen()` returns `true` when absent (`:866-874`); only a supplied closed window prevents a row operation from starting (`:845-846`). Thus current production calls cannot enforce any bounded write window because there are no calls, and a future caller that omits `window` would silently be unbounded. This store window would constrain the backfill only; it does not wire the runtime's separate legacy-read policy.

## 1. Recommended production call point: explicit operator CLI

Add a dedicated, one-shot orchestrator CLI, for example `services/orchestrator/src/result-ref-migration-cli.ts`, and a `migrate:result-refs` package script alongside the existing migration commands. Give it explicit `census`, `backfill`, and `verify` subcommands. Follow the explicit guard/cleanup style of `storage-migration-cli.ts:13-50`, not the service startup path.

Do **not** call the backfill from `main.ts`, `createApp`, a web/admin route, or a scheduler:

- Startup runs in every application replica and every restart; it has no single operator decision, backup receipt, or safe once-only boundary. A deployment could trigger concurrent scans and writes before workers/readers are ready.
- A scheduler can reopen/retry mutations without a fresh census or operator review, and can obscure the bounded-window expiry.
- An authenticated admin request would couple a potentially long migration to HTTP timeouts/retries and expose an unnecessary DB-wide write capability to the application surface.
- A dedicated CLI is an explicit deployment operation, has a distinct process and exit code, can hold a process-wide DB lock, and fits existing `migrate` / `migrate:artifact-blobs` conventions.

The CLI should require explicit operator confirmation and evidence (same principle as `storage-migration-cli.ts:28-40`, which requires backend, migration window, verified-backup marker, rollback sign-off, and a literal confirmation). Suggested required inputs are `DATABASE_URL`, metadata/Vault Transit config and credentials, the allowed metadata key ref, backup receipt/sign-off, window start/expiry, and `RESULT_REF_MIGRATION_CONFIRM=YES`. Validate all before the first mutating call. Never print connection strings, Vault tokens, row values, result refs, or ciphertext.

Compose dependencies in the CLI using existing factories: `createDb` (`src/db/db.ts:8-35`), `buildEncryptionBootOptions` (`modules/encryption/boot-options.ts:243-280`), `adaptKeyProviderForMetadata` (`modules/encryption/metadata-key-adapter.ts`), and `createMetadataCrypto` (`modules/runtime/metadata-crypto.ts:235-238`). Abort unless metadata encryption is actually enabled and its Vault-backed sealer can be constructed. `createApp` currently leaves `metadataCrypto` undefined when `metadataEncryption` is absent (`app/bootstrap/create-app.ts:302-307`). This matters for live writers: `runtime.ts:442-443, 812-818` writes a `result_ref` verbatim when the seam is absent. Before census, deploy/configure every writer replica so new results are sealed; otherwise plaintext rows can appear behind the backfill and the zero gate will not stay zero.

## 2. Duplicate-run protection, idempotency, interruption

Use two layers of protection:

1. **Job lock:** take a PostgreSQL session advisory lock for a stable, namespaced `result_ref` migration key using a dedicated `PoolClient` from `db.pool.connect()` (`Db` exposes the pool at `src/db/db.ts:8-16`). Use `pg_try_advisory_lock`; if unavailable, exit before writes with `LOCK_BUSY`. Hold it across census/backfill/verify as appropriate, and unlock/release in `finally`. A process/database connection failure releases the session lock. Do not hold one transaction over the whole migration.
2. **Existing row safety:** keep `ResultRefPgMigrationStore.withPayloadLocked`'s per-row `SELECT ... FOR UPDATE` inside `db.tx` (`legacy-payload-migration.ts:836-849`) and its `UPDATE ... WHERE id=$1 AND updated_at=$3` compare-and-set (`:850-854,877-881`). This serializes against live writers and prevents blind overwrite if a row version changes. A failed compare must remain `MIGRATION_COMMIT_CONFLICT`; never retry the write against a newer version without re-reading and re-verifying it.

`backfillLegacyPayloads` is restart-safe at row boundaries (`:324-434`): each row is locked independently; legacy plaintext is integrity-checked, sealed, decrypted again, byte-compared, and only then committed; already encrypted rows are opened and verified rather than resealed. Re-running after an interruption re-enumerates all non-null IDs (`ResultRefPgMigrationStore.listPayloadIds`, `:831-833`), validates committed ciphertext, and continues remaining rows. No external checkpoint is required for correctness. Add cancellation between rows for SIGINT/SIGTERM so the current transaction can settle and the CLI returns `incomplete`; abrupt termination must leave PostgreSQL to roll back the current transaction. Rerun only after obtaining the job lock and repeat census/auth gate.

The existing store materializes all rows/IDs in memory (`:803-812,831-833`) and processes sequentially. Census must report candidate count and estimate memory/runtime before mutation. If production volume exceeds an explicitly tested bound, add keyset/batched enumeration before launch; do not assume the all-rows implementation scales without a measured count.

The store checks window-open before beginning each row transaction (`:845-846`), but not again immediately before its CAS update (`:850-854`). If the intended limit means “no commit after expiry,” add a second expiry check immediately before commit, and test expiry during an in-flight row. Until then, start with ample expiry headroom and treat any run crossing expiry as incomplete; never renew it automatically. The production CLI must require a window and pass it to the store—never rely on the optional default-open behavior.

## 3. Required order: census → backfill → authenticated gate

### A. Read-only census first

Run a read-only census of both target families, `operations.result_ref` and `tasks.result_ref`, before any write. Report counts per kind for plaintext candidates, valid sealed rows, unresolved rows, and references; validate row identity, tenant binding, version, and classification. Take/verify the approved DB backup before proceeding. Census is the baseline against which to compare the final pass.

The current `ResultRefPgMigrationStore.inventory()` does scan both families and returns aggregate plaintext/encrypted/unresolved counts (`legacy-payload-migration.ts:814-828`), but it does not break counts down by kind or return structured census issues. Extend the CLI/store's read-only census output to preserve per-kind coverage and unresolved reason counts without outputting the result-ref values.

**Must fix before production backfill:** `toLockedPayload` parses the stored text and treats anything that is not recognized by `sealer.isSealed()` as plaintext (`:907-950`). A valid-shape sealed envelope that fails authentication becomes unresolved and is not resealed, which is correct. But malformed *envelope-looking* JSON or an envelope-like JSON object with invalid/missing discriminator fields can fall through to the plaintext classification and be sealed as if it were a legacy ref. Add a strict “envelope-like but invalid” classification (unresolved) and prove it in census and offline tests. Ordinary legacy URI/text values remain plaintext candidates; suspicious partial envelope markers, malformed/tampered envelopes, missing identity/version, and failed opens must block for repair, never be normalized by sealing.

Abort the mutating phase if census source/slot coverage is incomplete, DB scan fails, backup sign-off is missing, metadata key/Vault is unavailable, any row is unresolved/corrupt, or the current writer fleet is not sealing new refs. Plaintext candidates with complete trusted context/integrity data are the rows to migrate, not an abort condition by themselves.

### B. Backfill second

Construct a required bounded window using `createBoundedDualReadWindow(start, expiresAt)` and pass it to `ResultRefPgMigrationStore`; reject missing, expired, inverted, or over-14-day bounds. Run `backfillLegacyPayloads(store, new ResultRefPayloadCodec(metadataCrypto))` only after census and backup gates pass. Keep the framework's retained-source contract: it may atomically replace the same `result_ref` value with the envelope only after authenticated readback matches the exact bytes and expected size/hash (`:319-322, 366-433`). It has `legacyDeletionAllowed: false` and no DELETE statement.

The backfill catches per-row errors and continues other IDs, then returns `state: 'incomplete'` if any failed/unresolved reference remains (`:332-434`). Preserve that behavior: safe rows may make progress, but any issue makes the command exit non-zero and prohibits the auth gate/window close. Do not retry a corrupt or CAS-conflicted row as plaintext. Repair/root-cause it, re-census, then rerun.

### C. Authenticated gate last

Only after a complete backfill result, run `countUnsealedWithAuth` against the two result-ref specs (`metadata-auth-counter.ts:58-59,148-160`) and require both `plaintext === 0` and all `sealedBroken* === 0` / gate `PASS`. The gate authenticates shape-passing sealed values under the actual `(tenant, slot, refId)` context; plaintext rows are counted as plaintext and skipped, not authenticated (`metadata-auth-counter.ts:169-205`). Therefore running the auth gate before backfill cannot prove legacy rows safe. Use the two result-ref specs for this migration's scoped proof; the default counter covers all eight metadata slots, which may include unrelated slots not handled by this backfill. Run the wider metadata gate separately before making a claim about all control-plane metadata.

Repeat the census after the authenticated gate (or use its equivalent per-kind totals) and require stable totals: the expected non-null refs were handled, plaintext/unresolved counts are zero, and the verified sealed counts match. Ensure all app writer replicas remain on the sealing version during and after the gate. A gate PASS from a prior snapshot is stale if a non-sealing writer can still add rows.

## 4. Abort rules, non-actions, rollback, proof

**Abort before writes** on failed/incomplete census, uncovered kinds, suspicious envelope, missing/invalid tenant/id/version, broken sealed row, invalid/inaccessible Vault key, unverified backup, writer fleet still able to emit plaintext, lock contention, invalid/expired window, or database permission/health failure. Do not proceed based on a shape-only count.

**Never:** seal an unresolved/corrupt or unauthenticated envelope; continue with synthesized tenant/ref/version context; disable CAS; overwrite a row changed since it was read; delete a legacy/source row; emit plaintext/ciphertext into logs; automatically extend the window; or mark an incomplete run/gate as complete. A failed candidate stays untouched; the whole run remains incomplete until repaired and successfully verified.

For ordinary application rollback, keep the crypto-capable release and key configuration; encrypted rows remain valid and should continue to be read as envelopes. If the only issue is that some legacy rows remain, rerun the CLI after remediation inside a newly authorized bounded window. Avoid reverting to a binary that treats sealed values as opaque/raw.

The generic framework exposes `restoreLegacyPayload` (`:444-488`) for an operator-selected row, but the PG result-ref store has no second copy of the original plaintext: it stores the envelope in `result_ref`. Its `restoreLegacy` callback decrypts then updates that same column back to plaintext with a compare (`:856-860,883-886`). Thus restoring is a deliberate representation rollback, not preservation of both copies; the generic “ciphertext is kept” comment does not describe this single-column PG adapter. Prefer forward-compatible code rollback while retaining ciphertext. Use row restoration only with separate backup/sign-off, a valid decrypt key, a fresh lock, and verified CAS; it is not an automatic response to a failed gate.

Prove no data damage with both algorithmic and auditable evidence: each candidate's plaintext hash/size is captured from the locked source, the just-produced envelope is decrypted and byte-compared before commit, and updated-at CAS rejects concurrent mutation (`legacy-payload-migration.ts:357-433,845-854`). Retain a restricted, value-free run receipt containing window id/start/expiry, binary/config/key-ref identity (never token), backup receipt id, per-kind before/after counts, scanned/migrated/verified/failed counts, blocker/error-code counts, auth-gate result, and final exit status. If row-level proof is required, store keyed digests/row ids in a restricted audit artifact; never store or print result-ref plaintext/ciphertext. Current framework result has aggregate counts and issue codes (plus payload IDs), not a durable per-row verification manifest, so add that only if the deployment's audit requirement demands it.

## 5. Implementation packets and leases

Packets are offline implementation units. The mutating production CLI remains operator-run and user-gated; no startup/scheduled execution.

| Order | Packet / lease | Acceptance evidence | User-gated boundary |
|---|---|---|---|
| 1 | **Read-only census + classification hardening** — `modules/encryption/legacy-payload-migration.ts`; tests `legacy-payload-migration.test.ts`, `encmeta-enc09-kind.test.ts`; add per-kind census fields/reasons. | Per-kind coverage; corrupt/partial envelope is unresolved; normal text is plaintext; no writes in census. | Live census against production DB is operator-gated. |
| 2 | **CLI + dependency composition** — new `src/result-ref-migration-cli.ts`; `services/orchestrator/package.json`; reuse `db.ts`, boot options, metadata adapter/crypto. | Required guards, correct sealer/key ref, explicit command/subcommand, sanitized summary, correct exit code/cleanup; no startup import/caller. | Production DB/Vault credentials, backup receipt, key choice, window/confirmation. |
| 3 | **Duplicate lock + interruption/window enforcement** — CLI plus `legacy-payload-migration.ts` store/framework. | Second run fails `LOCK_BUSY` before writes; SIGINT/SIGTERM waits for current row then exits incomplete; forced kill rolls back current row; rerun verifies committed rows and completes; missing/closed/expiring window cannot commit outside policy. | Selecting the live window and deciding stop/renew requires explicit operator approval; never auto-renew. |
| 4 | **Census → backfill → auth orchestration** — CLI and focused new `result-ref-migration-cli.test.ts`; use `metadata-auth-counter.ts` with two result-ref specs. | Auth gate cannot run after census failure or incomplete backfill; gate proves both slots open under correct AAD; stable final census required; value-free receipt. | Backup sign-off, writer fleet readiness, live backfill, and any restore are operator-gated. |

## Source check record

- Re-grepped production source, package scripts, tests, migration tools, and boot construction for backfill/store/window references; only declarations are in production source.
- Read the backfill algorithm, PG store locking/SQL/classifier, window helpers, result-ref writer, metadata auth counter, DB wrapper, boot crypto composition, and existing CLI conventions.
- No tests, live services, DB, Vault, or production data were accessed; only this design receipt was written.
