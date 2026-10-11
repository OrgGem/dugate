# LDBA-08 production adapter receipt

Status: BLOCKED after the first complete adapter preflight
Date: 2026-10-09
Scope: du-rework only

## Boundary

The runner, migrations, production source modules, tests outside the lease, and all real databases remain untouched. No gate was ticked. No commit, staging, or push was performed. Rehearsal work is limited to a disposable PostgreSQL 16 container with network none, a tmpfs data directory, and no published ports.

## Implementation

- W1 exports a CommonJS adapter object for the accepted runner and a factory for offline tests. It scans only the nine allowlisted source tables, returns camelCase columns, formats timestamp-with-time-zone values as UTC-naive text, projects JSON columns as text, and rounds decimal source values to numeric 20,6 text.
- W1 exposes all nine context callbacks listed by the runner, reads enabled action mappings from the existing business_versions catalog before synchronous transform calls, and refuses to invent a local scrypt verifier. Context policies without an approved production interface fail closed.
- W1 implements tenant lookup and name-only seeding under a transaction advisory lock; destination identifier allowlists; constraint validation in a rollback-only transaction; immutable inspection; and an atomic immutable batch. For artifact_blobs it adds tenant_id from the matching planned artifacts row because the target DDL requires that foreign key while the accepted runner sends only storage_key and bytes.
- W2 has five offline tests for shape and A1 environment matching, source projection, tenant seed locking, immutable replay/conflict handling, and artifact blob tenant projection.
- W3 creates a disposable PostgreSQL 16 container with network none, tmpfs storage, and no published ports. It copies Node 24.21.0 into that container and applies migrations from both packages there.

## Evidence found before implementation

- The local Docker images include postgres:16-alpine and node:24.21.0-alpine3.24.
- The accepted LDBA-04 identity adapter only migrates a bcrypt verifier after a user supplies plaintext at first login. The LDBA-03 runner instead requires a ready scrypt password_hash during backfill. The accepted adapter explicitly does not create a locked identity with an unknown password. No safe direct transform exists for the runner contract.
- The accepted LDBA-05 connector projector only accepts POST with API_KEY_HEADER. The dispatch requires synthetic connector rows with other auth types and an HTTP URL, while the runner turns every transform error into BLOCKED_TRANSFORM and has no skip result for connectors.
- The accepted LDBA-05 receipt also records the unresolved text connector id versus UUID connector_prompt_overrides.connection_id mapping.
- The accepted LDBA-06 workflow adapter writes and verifies through the production catalog writer. The runner context requires a pure digest and sealed schema_ref result, then independently writes that row. No accepted pure preparation API is exposed.

These are contract incompatibilities, not evidence that a production transform may safely fabricate credentials, silently skip source rows, or bypass the approved modules.

## Rehearsal

Command: node scripts/ldba-08-harness.cjs

The first disposable run applied both migration sets, scanned all nine tables, and then reported BLOCKED_ADAPTER, exit 1. The cause was an adapter export mismatch: the runner requires the adapter object directly. W1 was corrected to export that object while retaining its factory for tests. The first container was removed.

The second disposable run completed the migration and seed phases:

| Check | Literal result |
|---|---|
| Orchestrator migrations | 37 files applied |
| Connector migrations | 9 files applied |
| Public base tables after migrations | 33 |
| schema_migrations | 37 rows |
| connector_schema_migrations | 9 rows; connector uses its own production ledger |
| Synthetic tenant | legacy-default inserted by name only; generated UUID resolved at runtime |
| Source rows | Operation 2; ApiKey 2; ExternalApiConnection 3; ExternalApiOverride 2; ProfileEndpoint 2; AppSetting 2; FileCache 2; User 2; UserProfileAssignment 2; total 19 |
| Source adapter scan | all nine tables scanned |
| Destination entity rows after preflight | all 13 entities at 0 |
| Container cleanup | container removed; no rehearsal container left running |

Runner preflight literal status: BLOCKED_TRANSFORM. Runner exit: 1. Harness exit: 1. Runner report counters: read 19, written 0, skipped 1, failed 12; destination planned 0, written 0, skipped 1. Failure rows were ExternalApiConnection 3, ExternalApiOverride 2, ProfileEndpoint 2, AppSetting 1, FileCache 2, and User 2. The literal row codes were TRANSFORM_ERROR for the context-dependent connector, profile, workflow, file, and user rows, and INVALID_UUID for both connector override rows. The detailed reasons were:

- Connector preparation has no configured approved context provider. The accepted LDBA-05 projector rejects unsupported auth types, but the runner cannot represent an intentional connector skip. The synthetic HTTP connector also conflicts with the dispatch claim that HTTP should be skipped: the accepted LDBA-05 endpoint parser currently permits both HTTP and HTTPS.
- ExternalApiOverride carries a text connector identifier while the runner requires UUID connectionId. The plan already says the target is uuid-only, has no revision column, and v1 override projection is deferred. The runner cannot defer a row.
- Profile naming and connectionsOverride normalization have no approved synchronous/pure production policy exposed to this runner.
- The accepted LDBA-06 adapter delegates to the production catalog writer and reader; the runner instead requires a pure digest/schema_ref result and then writes that row itself.
- FileCache has no approved production object reader, artifact token policy, or purpose policy in the leased modules.
- The accepted LDBA-04 identity path can re-hash only after the user presents plaintext at first login. The runner requires a scrypt password_hash during backfill. No hash was fabricated and no identity row was written.

No --execute run was attempted after preflight failed, in accordance with the dispatch stop condition. The synthetic harness set matching A1 environment strings only to exercise the accepted runner against synthetic UTC data. This does not close A1; timezone behavior for a real legacy source remains open. No live, legacy, or shared database was contacted, and no DB window is claimed.

The AppSetting fixture includes two rows with the same key to exercise the requested duplicate-slug selection. The verified source mapping says AppSetting.key is unique, so this synthetic table omitted that key constraint to make the dispatch fixture possible. The runner reports winner=undefined and skipped=undefined because its duplicate report reads row.id although its source key is row.key. This fixture is not evidence that duplicate keys can occur in the real source; the source-key constraint versus duplicate-fixture requirement needs coordinator disposition. The runner was not edited.

Offline test command: node --test tests/ldba-03-production-adapter.test.cjs

Literal result: tests 5, pass 5, fail 0, exit 0.

Syntax checks: node --check passed for W1 and W3. Hygiene check: all four leased files have zero ASCII double-quote characters and zero trailing-whitespace lines.

## Open items for coordinator

- Resolve the identity backfill contract: provide plaintext at an approved first-login flow, or revise the runner and its acceptance contract in a separately authorized packet.
- Define how unsupported connector rows are reported as intentional skips without weakening immutable writes or hiding source rows.
- Reconcile the dispatch HTTP-skip expectation with the accepted connector projector, which currently accepts HTTP and HTTPS.
- Resolve connector text identity versus UUID override identity before importing overrides.
- Reconcile the AppSetting.key uniqueness constraint with the required duplicate-key synthetic fixture and correct duplicate diagnostics that use a nonexistent row.id.
- Expose an approved pure workflow-schema preparation interface, or define a transaction-safe integration with the accepted catalog writer.
- Define the approved legacy object reader, artifact token derivation, and artifact purpose mapping required by the runner context.
- Provide a synchronous existing-business-registry lookup compatible with resolveBusinessAction, whose runner call site is synchronous.
- Resolve profile naming and connectionsOverride normalization against approved legacy behavior.

## Final verification

Only the four leased files were written. The accepted runner, source, tests outside the lease, migrations, plans, and other documentation were not changed. No commit, git add, push, or gate tick was performed. The adapter infrastructure and offline tests are present, but LDBA-08 acceptance is not met because runner preflight is BLOCKED_TRANSFORM and execute/idempotency/count reconciliation were correctly not attempted.
