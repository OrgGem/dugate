# WFA-04 independent verification receipt

Date: 2026-10-07 (Asia/Bangkok)  
Verifier: `/root/workflow_verify`  
Workspace: `D:\Git\dugate\du-rework`  
Write scope used: `tests/workflow-api/` and this report only.

## Contract parity baseline

The frozen source-derived fixtures are in `tests/workflow-api/fixtures/`. The named route accepts exactly `disbursement`, `lc-checker`, and `doc-compare`. Each requires at least one non-empty file at admission; `doc-compare` needs two files in its worker. Only `disbursement` forwards a truthy `resolution_data` variable. The old schema route accepted optional files, selected by trimmed `schemaSlug`, and parsed optional `input` JSON without verifying it was a non-null object. The object-only check is therefore an explicit security exception. A supplied `input.schemaSlug` previously overwrote the route selector during variable assembly; the safe path must keep the admitted schema pinned.

For a normal legacy workflow submit, the source contract is HTTP 202, an `Operation-Location` pointing to `/api/v1/operations/{id}`, and `{name:"operations/{id}",done:false,metadata:{state:"RUNNING",workflow:<selector>,progress_percent:0,progress_message:"Initializing workflow..."}}`. The schema route uses the same shape with `Initializing schema workflow...`. The named route did not forward `Idempotency-Key` or execute synchronously. Poll, result, resume, and cancel requirements, including `WAITING_USER_INPUT`, are captured in `legacy-contract-baseline.json`; the intentional tenant/auth hardening exceptions are listed there as well.

The schema fixture records all ten legacy node kinds (`connector`, `parallel`, `join`, `file_parse`, `file_url_download`, `callback`, `archive_compress`, `archive_extract`, `human`, and `input`), nested ordered parallel branches, bindings, and a human checkpoint. These fixture assertions establish only that verification requirements remain explicit; they do not establish runtime compatibility.

## Harness and infrastructure

The harness refuses non-loopback infrastructure URLs, allocates a unique PostgreSQL search-path schema and a non-default Redis database, and uses a synthetic offline key wrapper. Synthetic workflow/file fixtures are defined; they have not yet been submitted through HTTP because the integration seams are still pending. The integration infrastructure is dedicated to this run:

| Service | Container | Bound endpoint |
| --- | --- | --- |
| PostgreSQL 16 | `du-wfa-20261007-55498-pg` | `127.0.0.1:55498`, database `du_workflow_api_test`, user `du_wfa` |
| Redis 7 | `du-wfa-20261007-56398-redis` | `127.0.0.1:56398` |

The services are isolated from the legacy app and shared local development services. No paid provider is configured. At the time of this receipt, the real app, migrations, outbox, queue, and worker have not yet been started by this harness; service availability alone is not end-to-end evidence.

## Test receipts

Fixture guard (four checks), from `D:\Git\dugate\du-rework`, Node `v24.21.0` at `%TEMP%\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe`:

```powershell
& "$env:TEMP/du-node24-security-c025dd92/node-v24.21.0-win-x64/node.exe" node_modules/.pnpm/node_modules/jest/bin/jest.js --config tests/workflow-api/jest.config.cjs --runInBand
```

Exit: 0. Result: 1 suite passed, 4 tests passed. Raw output: `tests/workflow-api/logs/fixture-guard-node24-2026-10-07.log`.

The first CLI attempt used `node_modules/jest/bin/jest.js`, which does not exist in this pnpm layout. It failed with `MODULE_NOT_FOUND` (exit 1); the raw failed-first receipt is preserved at `tests/workflow-api/logs/fixture-guard-missing-root-cli-attempt.log`. The corrected pnpm path above is what produced the four fixture passes.

Harness and decoder checks (four fixture guards, four production multipart decoder checks, and two isolation/crypto checks), same cwd and Node version:

```powershell
& "$env:TEMP/du-node24-security-c025dd92/node-v24.21.0-win-x64/node.exe" tests/workflow-api/run-jest.cjs
```

Exit: 0. Result: 3 suites passed, 10 tests passed. The decoder checks cover the three actual process names, disbursement-only `resolution_data`, file aliases/order/empty files, strict object JSON, and file limits. The harness checks validate generated DB/Redis namespaces and exercise production AES-GCM metadata crypto with a synthetic local key wrapper, including cross-tenant AAD rejection. Raw output: `tests/workflow-api/logs/harness-readiness-node24-2026-10-07.log`.

Fresh isolated PostgreSQL catalog test, same cwd and Node version:

```powershell
& "$env:TEMP/du-node24-security-c025dd92/node-v24.21.0-win-x64/node.exe" tests/workflow-api/run-jest.cjs schema-catalog-source-mapped-node24-2026-10-07.log
```

Exit: 0. Result: 4 suites passed, 11 tests passed. This run created a unique schema in the dedicated test database, discovered and applied `0037_legacy_workflow_schema_catalog.sql` with the production migration runner, then exercised encrypted immutable revisions, active revision CAS, retirement, and tenant fencing through the production catalog API. It verified sensitive schema text is absent from the stored JSON envelope. The isolated schema was dropped by teardown; a read-only PostgreSQL check found no remaining `du_test_wfa_%` namespaces. Raw output: `tests/workflow-api/logs/schema-catalog-source-mapped-node24-2026-10-07.log`.

Before that pass, an isolated temporary-table probe reproduced a PostgreSQL foreign-key type mismatch in the first draft (`text` referencing `uuid`). Runtime corrected the migration column to `uuid`; the corrected migration then applied successfully in the fresh-schema test. Raw failed probe: `tests/workflow-api/logs/schema-catalog-fk-type-probe-failed-2026-10-07.log`.

Real HTTP admission boundary test, same cwd and Node version:

```powershell
& "$env:TEMP/du-node24-security-c025dd92/node-v24.21.0-win-x64/node.exe" tests/workflow-api/run-jest.cjs http-admission-diagnostic-node24-2026-10-07.log
```

Exit: 0. The full harness passed 5 suites and 14 tests. The HTTP fixture booted the real Orchestrator on loopback with the production migrations and synthetic metadata key, seeded one tenant and one active public API key, then posted to the actual legacy schema route. Missing credentials returned 401 before body parsing; non-object JSON returned 400; body `apiKeyId` mismatch returned 403; unknown selectors returned 404 even when `input.schemaSlug` named a provisioned sentinel. Before/after counts for operations, tasks, outbox, artifacts, and idempotency keys stayed equal for every rejected request. No worker was started in this test, and it does not establish queue or result behavior. Raw output: `tests/workflow-api/logs/http-admission-diagnostic-node24-2026-10-07.log`.

The first HTTP integration attempt failed (exit 1): the invalid-input and unknown-selector requests received 500 instead of 400/404 while API wiring was still changing concurrently. The raw first attempt is preserved at `tests/workflow-api/logs/http-admission-first-attempt-node24-2026-10-07.log`; the subsequent full run against the then-current shared source passed the same assertions.

Legacy route response-projection unit test:

```powershell
& "$env:TEMP/du-node24-security-c025dd92/node-v24.21.0-win-x64/node.exe" tests/workflow-api/run-jest.cjs route-projection-first-node24-2026-10-07.log
```

Exit: 0. Result: 6 suites passed, 16 tests passed. With an explicitly in-memory host, the actual route handler still returns the exact 202 envelope for named and schema workflow selectors even when `sync=true` and `Idempotency-Key` are supplied; repeated named submissions invoke the host twice. It also pins the schema lookup to the multipart selector when `input.schemaSlug` differs. This is a route-unit check only, not submission/database/queue evidence. Raw output: `tests/workflow-api/logs/route-projection-first-node24-2026-10-07.log`.

The first PostgreSQL catalog test attempt failed (exit 1) because ts-jest resolved `@du/contracts` to stale package `dist`, where the newly added `LegacyWorkflowSchemaValidationError` export was not yet built. The failure receipt is retained in `tests/workflow-api/logs/harness-readiness-node24-2026-10-07.log`. The isolated Jest config now maps that package to its current TypeScript source, then the same DB test passed. This source mapping is test harness configuration only.

These fixture, decoder, catalog, and rejected-request checks are not full endpoint or worker evidence. The catalog portion of WFA-T37 has direct fresh-DB evidence, and invalid-input/auth no-side-effect checks have real HTTP evidence. A real worker suite is now running against the isolated PG/Redis services; its current evidence and open failures are recorded below.

## End-to-end status

The isolated worker harness boots the production Orchestrator, applies migrations in its unique PostgreSQL schema, registers and activates the real `document-core@1.1.0` manifest, uploads through the production encrypted artifact path, starts the production `startDocumentCoreWorker`, and dispatches the real PostgreSQL outbox into its dedicated Redis database. The synthetic key provider is local and no paid provider is configured. Tests live in `tests/workflow-api/http-worker.integration.test.ts`; the suite includes immutable schema pin mutation, input-only result/poll/download, legacy resume at one and two human checkpoints, two parallel checkpoints with encrypted branch artifacts and joins, one-file named `doc-compare`, admin-fallback denial, metadata-only upload denial, cross-tenant poll/cancel, and paused cancellation.

Fresh focused worker attempt after the server-sealing and API-key read-fence builds, from `D:\Git\dugate\du-rework`, Node `v24.21.0`:

```powershell
& "$env:TEMP/du-node24-security-c025dd92/node-v24.21.0-win-x64/node.exe" tests/workflow-api/run-jest.cjs schema-worker-final-current-node24-2026-10-07.log tests/workflow-api/http-worker.integration.test.ts
```

Exit: 1. Result: 1 suite, 6 tests passed and 2 failed. This run used the dedicated PostgreSQL schema and Redis DB described above, synthetic encrypted artifact/metadata keys, the real production Orchestrator, migration runner, `document-core@1.1.0` manifest/worker, PostgreSQL outbox, and BullMQ dispatch. The receipt contains no inline bearer/API-key patterns. Raw output: `tests/workflow-api/logs/schema-worker-final-current-node24-2026-10-07.log`.

Passing end-to-end cases: a fileless schema input node executed, stayed on its immutable revision-1 admission pin after the catalog's active schema advanced to revision 2, emitted the versioned result, and exposed matching legacy poll/download responses; one-file `doc-compare` preserved HTTP 202 and failed asynchronously in the real worker with the two-document error; two ordered human nodes resumed through the legacy request and each consumed a separate response; an ADMIN bearer was rejected without writes; metadata crypto without artifact encryption rejected file uploads before artifact/blob/operation/task/outbox writes; and a paused workflow cancelled with its wait closed while same-tenant alternate-key and cross-tenant access remained denied. Same-tenant alternate-key poll, `/result`, and download each returned 404. The real worker was run with encryption enabled, so the checkpoint SyntaxError from the preceding receipt no longer reproduces.

The full worker receipt above had two failures. Runtime patched branch-result selection, then the verifier reran the sequential-parallel case alone against the rebuilt executor:

```powershell
& "$env:TEMP/du-node24-security-c025dd92/node-v24.21.0-win-x64/node.exe" tests/workflow-api/run-jest.cjs schema-worker-parallel-rerun-node24-2026-10-07.log tests/workflow-api/http-worker.integration.test.ts -t 'runs two ordered parallel checkpoints'
```

Exit: 0. Result: 1 selected test passed, 7 skipped by the Jest name filter. The four encrypted branch tasks and the root succeeded; both ordered parallel checkpoints, both joins, and the projected terminal result were asserted. Raw output: `tests/workflow-api/logs/schema-worker-parallel-rerun-node24-2026-10-07.log`. This supersedes the parallel failure in the preceding full-suite receipt, but the full suite has not yet been rerun against this patch.

One current parity failure remains from the latest full-suite run. The single-human route resumed successfully and the worker reached `SUCCEEDED`, but the pre-resume legacy poll projection returned `metadata.state: WAITING_INPUT`; the frozen old response expects `WAITING_USER_INPUT`. The API owner has the receipt. The worker itself no longer reproduces the checkpoint SyntaxError. Keep the expected legacy state assertion unchanged pending the route fix.

The prior compile, setup, and worker failure receipts remain preserved as historical evidence, including the initial `SyntaxError`, `OUTPUT_NOT_COMMITTED`, profile setup and old progress assertion failures. The fresh receipt supersedes their behavioral conclusions where it has passing evidence; it does not erase those raw logs.

Independent verifier coverage remains partial. `input`, `human`, `parallel`, and `join` schema execution have real worker evidence; the selected parallel rerun passes, while the full suite still needs rerunning after that patch. `connector`, `file_parse`, `file_url_download`, `callback`, `archive_compress`, and `archive_extract` do not yet have independent real worker success/rejection evidence. Only the one-file asynchronous-failure branch of named `doc-compare` has been driven through HTTP and the worker. The actual named processes are still `disbursement`, `lc-checker`, and `doc-compare`; the first two have no independent end-to-end evidence in this receipt. WFA-T01..03, WFA-T15..24 for the unexercised nodes, and WFA-T25..28 beyond the tested resume/cancel cases remain open. No full WFA-T01..38 acceptance claim is made.

Cleanup status: dedicated containers `du-wfa-20261007-55498-pg` and `du-wfa-20261007-56398-redis` remain running for reruns; stop only these verifier-owned containers after verification is complete.
