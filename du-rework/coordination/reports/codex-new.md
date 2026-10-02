# W48-CXNEW — Coder 5 status

Date: 2026-09-24  
Scope: `businesses/document-core` and an independent, DB-free traceability harness.

## Review findings

- P8-01 remains unchecked in `du-rework/tasks/P8-release-readiness.md:15`. The superseding audit at `du-rework/docs/19-traceability-audit-matrix.md:32` says BR-11 lacks a single asserted operation → task → invocation → provider-request chain and still needs explicit DB audit-log verification.
- The current live extract E2E test submits an operation and queries the Connector ledger by `operation_id`, but its query does not select or assert `task_id` (`du-rework/businesses/document-core/tests/multi-container-e2e.integration.test.ts:768,830`). The provider stub counts requests and stores the body, but does not capture the provider idempotency header (`:282-300`). Those assertions do not close the listed chain.

## Added harness

Added `du-rework/businesses/document-core/tests/p8-01-traceability-harness.test.ts`. It runs the real document-core extract handler and Worker SDK `DefaultTaskContext`/`RuntimeClient` against an in-memory synthetic Runtime/provider fetch adapter. It checks that:

- the Runtime grant request is scoped to the fixture task, lease epoch, step, and connector slot;
- the Worker SDK invocation payload carries the same operation, task, and invocation IDs;
- the provider receives that invocation ID as its idempotency key and returns a provider request ID;
- artifact upload/finalize for the result is scoped to the same task and lease.

## W48-CXNEW follow-up

The focused run exposed two TypeScript diagnostics reported by Agent-6: the test imported `@du/observability` directly even though it is not a document-core dependency, and the indexed handler was possibly undefined. Removed the direct logger-package import in favor of a small no-op logger typed through `TaskContextDeps`, and added a registration guard before invoking `documentCoreHandlers.extract`.

The first run also showed this environment cannot connect to the test's loopback listener (`ETIMEDOUT`). Replaced that listener with the in-memory fetch adapter so the harness stays offline and deterministic.

Verification: from `du-rework/businesses/document-core`, `npx jest tests/p8-01-traceability-harness.test.ts --runInBand` → **1 suite passed, 1 test passed, exit 0**. This Jest/ts-jest run compiled the target suite without the reported TypeScript errors. No database or Redis command was run; no DB window was opened.

## Status and limits

This is offline document-core/Worker SDK consumer evidence. The operation and task IDs come from a synthetic claimed-task fixture; the Runtime and Connector callback are test doubles. The harness does not prove Orchestrator’s persisted operation-to-task association, the live Connector ledger/provider path, the audit-log entity, or isolated multi-service deployment. P8-01 therefore remains open; this test must not be counted as live E2E acceptance.

No PostgreSQL or Redis command was run. No DB window was opened. No existing files or platform, Connector, or Worker SDK source files were edited. The only code file created is inside the permitted `businesses/document-core/tests/` boundary; this report is the explicitly requested coordination status file.

## R1-E — WR24-01..04 / FR24-12/13/14 static review and harness plan (2026-09-25)

Scope: current checkout of `businesses/document-core`, `packages/document-kit`, and the FR24-14 `businesses/example-review` consumer. This is planning only; no source or test files were changed and no DB/live suite was used.

### Current findings

- **WR24-03 / FR24-12 — input identity is lost before format detection.** `TaskContext.artifacts.read()` returns only `Buffer` (`businesses/document-core/src/types/context.ts`); the document-core inputs carry artifact IDs but no filename/MIME metadata (`src/types/actions.ts`). `ingest.prepareSources()` invents names such as `artifact_1`, while extract/analyze/transform/generate pass `doc_${id}` and compare passes `source_doc` / `target_doc` to `ParserBudgetHelper.safeParseBuffer()` without a MIME hint. The document-kit factory accepts filename and MIME parameters, and the detector uses the extension or hint to classify ZIP Office files; with the generated names and no hint it identifies a DOCX/XLSX ZIP as generic `zip`, which has no native parser. Therefore the current API has no trusted metadata value for an action-level test to verify.
- **WR24-04 / FR24-13 — archive limits do not fence every decompressor.** `DocumentParserFactory.parseBuffer()` validates byte/time options and dispatches, but does not run an archive preflight. `WordParser` catches `SafeArchiveExtractor` errors and proceeds to Mammoth; `ExcelParser` calls SheetJS before its guarded extractor. `SafeArchiveExtractor` itself can return warnings/entries with missing content after decompression failure, and its local-header scan can stop on truncated input without rejecting the archive. Existing document-kit tests cover traversal, count/size/ratio checks, and parser limits separately; they do not assert that unsafe Office input reaches zero fallback/SheetJS calls. `withTimeout(Promise.race)` bounds caller wait but cannot stop synchronous parser CPU.
- **WR24-01/02 / FR24-14 — unreadable review evidence can be accepted.** `businesses/example-review/src/review.ts` replaces source artifact read failures with filename-derived bytes in child and single-item paths, and the fan-in path synthesizes a `passed: true` item when a child artifact cannot be read or decoded. A synthetic success can therefore become approval without readable evidence. This source belongs to the example-review owner; happy-path cross-task artifact reads still depend on R1-A authorization.
- Document-core source reads currently propagate errors in the artifact-consuming preparation paths, but current parser-budget tests do not provide a broad action matrix proving 403/404/corrupt bytes cause zero provider calls and zero output writes. That remains a useful local regression layer separate from the example-review false-approval defect.

### Proposed DB-free harness layers

| Layer | Proposed location | Cases and required assertions |
|---|---|---|
| Archive preflight and dispatch | `packages/document-kit/tests/r1-e-archive-guard.test.ts` | Table-driven safe DOCX/XLSX, plain ZIP mislabeled as Office, malformed/truncated Office ZIP, traversal, entry-count/expanded-size/ratio violations, and unsupported/corrupt compressed entries. Use tiny synthetic headers/fixtures; do not materialize a ZIP bomb. Spy on parser dispatch, Mammoth, and SheetJS. Every rejected archive must reach zero parser/fallback/decompressor calls and produce an explicit rejection, never an empty successful `ParseResult`. Also exercise direct `WordParser.parse` / `ExcelParser.parse` so they cannot bypass the shared preflight. |
| Filename/MIME detection | `packages/document-kit/tests/r1-e-format-identity.test.ts` | Feed identical synthetic DOCX/XLSX bytes with canonical extension+MIME, extension only, MIME only, misleading extension, and a generic ZIP. Assert actual Office container markers decide DOCX vs XLSX vs ZIP; retain declared source filename/MIME separately from detected canonical format/MIME. Reject a plain ZIP that merely has a `.docx`/`.xlsx` name. |
| Action propagation and fail-closed source reads | `businesses/document-core/tests/r1-e-artifact-inputs.test.ts` | Table-drive ingest, extract, analyze, transform, generate, and compare source/target artifact paths. A metadata-aware artifact fixture should record the exact filename/MIME supplied to the parser seam for the same DOCX/XLSX bytes. For read 403/404 and corrupt/unsupported bytes, assert handler rejection and zero connector calls/output artifact writes. This needs a declared metadata seam first: the present `artifacts.read(): Promise<Buffer>` and input types cannot carry original metadata, so an ID-to-metadata contract must be agreed with R1-A before a production-path assertion can pass. |
| Review evidence fail-closed | `businesses/example-review/tests/r1-e-unreadable-evidence.test.ts` (separate component owner) | Force child source read 403/404 and child result read/JSON decode failures. Assert no filename placeholder reaches review, no fabricated passing item is produced, and aggregate state cannot become approved without every required readable result. Test failures with a fixture context now; keep cross-task happy path gated on R1-A's read authorization contract. |

### Execution and acceptance plan

1. Land the isolated document-kit archive/format tests first. Assert invocation counts at the decompressor/parser seam, not only the final error string. A synthetic limit fixture must fail before `inflateRawSync`, Mammoth, or SheetJS receives the input.
2. Agree the trusted artifact metadata shape with R1-A (artifact read result or action-level artifact reference). Do not treat a client-supplied filename/MIME as trusted ownership metadata. Then add the six-action document-core propagation matrix using that shape and canonical detector output.
3. Add negative source-read and corrupt-result assertions. For failures, require an explicit error/failure disposition, no provider inference, no result artifact, and no `passed:true` placeholder. Keep example-review fixes/tests with its owner; R1-E should not claim them from document-core tests.
4. Run only focused package-local Jest suites after implementation, with exact cwd, command, exit code, test count, and checkout/build identity recorded. No DB, Redis, live provider, or large decompression fixture is needed for these offline layers. Reserve any current-image/cross-task read proof for the R1-A dependency.

### Status at static review

At the initial review, R1-E had a harness plan but no implementation. The checkout also contained unrelated in-flight changes under document-core/document-kit. The metadata propagation contract and example-review behavior remained acceptance blockers; parser timeout tests alone did not close FR24-13's synchronous CPU boundary.

## R1-E Layer 1 — archive preflight guard (2026-09-25)

Implemented the DB-free archive boundary in `packages/document-kit`.

### Changes

- `SafeArchiveExtractor.preflightBuffer()` now validates local headers and central-directory/end records, paths and duplicate names, entry counts, declared expanded sizes and ratios, supported compression methods, compressed-data ranges, Office markers, bounded inflate output, actual sizes, and CRCs. Malformed or unreadable archive entries throw; they no longer return partial entries or warnings as a successful extraction.
- `DocumentParserFactory.parseBuffer()` runs archive preflight before parser lookup/dispatch for ZIP input and Office formats. A ZIP merely named as DOCX/XLSX fails on the missing Office marker before decompression or dispatch.
- Direct `WordParser` and `ExcelParser` calls apply the same guard. Excel verifies/extracts the archive before calling SheetJS; Word rejects preflight/decompression errors before Mammoth fallback. The verified extraction is cached per buffer/options and consumed by the parser, avoiding a second inflate pass; a SHA-256 check invalidates the cache if the input buffer changes.
- Added `packages/document-kit/tests/r1-e-archive-guard.test.ts` with table-driven malformed, traversal, entry-count, expanded-size, ratio, and unsupported-compression cases. The decompressor seam and parser/fallback seams are spied to assert ordering. Direct negative cases now cover both Word and Excel for zip bomb, path traversal, empty ZIP, and decompression error. Other cases cover understated output size, mislabelled plain ZIP, ZIP identified by filename, cache invalidation, and the safe DOCX path.
- Updated the legacy limits test so an empty XLSX is treated as unreadable input and the parser-timeout fixture uses a valid synthetic DOCX before testing the timeout behavior.

### Verification and test receipt

Target receipt for `packages/document-kit/tests/r1-e-archive-guard.test.ts`:

- Command: `npx jest tests/r1-e-archive-guard.test.ts --runInBand`
- Working directory: `D:\Git\dugate\du-rework\packages\document-kit`
- Exit code: `0`
- Result: 1 suite passed; 20 tests passed.

Package verification from the same working directory:

- Command: `npx jest --runInBand` — exit code `0`; 7 suites and 97 tests passed.
- Command: `npx tsc --noEmit -p tsconfig.json` — exit code `0`.
- Tests are local/offline. No DB, Redis, connector, or live provider was used; no DB window was opened.

### Remaining R1-E work and limits

- This is Layer 1 only. It does not implement the six-action source filename/MIME propagation contract or the example-review unreadable-artifact fixes in WR24-01/02 / FR24-14; those remain with their contract/component owners.
- ZIP64 and data-descriptor archives are explicitly rejected before parser dispatch. Some valid streaming-generated Office archives may use data descriptors and will fail closed until that format is supported.
- The size limits bound decompressed output, but synchronous inflate is not preemptible by `Promise.race`; process isolation is still required for a hard CPU deadline.

## R1-E Layer 2 — filename/MIME detection and canonical identity (2026-09-25)

Implemented the offline document-kit identity suite and detection behavior.

### Changes

- `FormatDetectionResult.format` and `.mimeType` now represent canonical detected identity. Added `.declaredFileName` and `.declaredMimeType` to retain the caller's original declarations unchanged; `.extension` remains the normalized suffix from the declared filename.
- ZIP classification inspects validated root entry names without inflating content. `word/document.xml` alone identifies DOCX; `xl/workbook.xml` alone identifies XLSX; neither marker or conflicting markers remains generic ZIP. Filename/MIME hints cannot override those container markers.
- The parser factory rejects a declared Office filename/MIME that resolves to a generic ZIP before parser lookup or decompression. Office bytes with misleading DOCX/XLSX declarations dispatch according to their actual markers.
- Added `packages/document-kit/tests/r1-e-format-identity.test.ts`: canonical extension+MIME, extension-only, MIME-only, mismatched DOCX/XLSX declarations, generic ZIP mislabeled as Office, conflicting Office markers, and assertions that declared identity remains separate from canonical identity.

### Layer 2 test receipt

- Command: `npx jest tests/r1-e-format-identity.test.ts`
- Working directory: `D:\Git\dugate\du-rework\packages\document-kit`
- Exit code: `0`
- Result: 1 suite passed; 14 tests passed.

### Package verification

- From the same working directory, `npx jest --runInBand` — exit code `0`; 8 suites and 111 tests passed.
- From the same working directory, `npx tsc --noEmit -p tsconfig.json` — exit code `0`.
- All tests use local synthetic fixtures; no DB, Redis, connector, provider, or DB window was used.

Document-kit now exposes canonical format identity while retaining declared name/MIME. Propagating that trusted identity through the six document-core actions remains separate R1-E work and still depends on the R1-A artifact metadata contract.

## R1-E Layer 3 — action propagation and fail-closed artifact reads (2026-09-25)

Added `businesses/document-core/tests/r1-e-artifact-inputs.test.ts`, an offline handler-level matrix using the real six `documentCoreHandlers` and the local `MockTaskContext`.

### Coverage

- All six actions reject artifact read failures with HTTP-style status 403 and 404 before parser invocation. Ingest uses its OCR route for these rows so a missed read failure would proceed to a connector; compare checks both source and target artifact paths.
- All six actions reject corrupt ZIP bytes and unsupported binary bytes. The suite uses ingest's native parse route and compares both artifact sides, so each parser failure is checked before provider/connector work.
- Every row counts artifact read attempts, parser calls where applicable, connector invocations, and output artifact writes. Read failures have zero parser calls; parse failures have one parser attempt; all cases have zero connector invocations and zero output writes.

### Test receipt

- Command: `npx jest tests/r1-e-artifact-inputs.test.ts`
- Working directory: `D:\Git\dugate\du-rework\businesses\document-core`
- Exit code: `0`
- Result: 1 suite passed; 28 tests passed.
- Offline run with synthetic byte buffers and in-memory context; no DB, Redis, connector, provider, or DB window was used.

### Scope note

This layer proves fail-closed action behavior for source read and parse failures. It does not add the artifact filename/MIME metadata contract or assert trusted declared-versus-detected identity propagation through document-core; that remains dependent on the R1-A artifact metadata contract described above.

## R1-E Layer 4 — trusted format propagation contract (2026-09-25)

Connected document-kit canonical format identity to document-core artifact reads and parser calls.

### Changes

- Added `ArtifactFormatMetadata` (`canonicalFormat`, `canonicalMimeType`, declared filename and MIME) and `ArtifactReadResult` to the document-core `TaskContext` contract. `artifacts.readWithMetadata()` is an optional enriched read so existing buffer-only contexts remain compatible.
- The worker adapter preserves enriched metadata when its artifact facade provides it. For the current Worker SDK buffer-only facade, it derives canonical format/MIME from the bytes with `DocumentFormatDetector`; it does not fabricate a source-declared filename or MIME.
- `ParserBudgetHelper.readArtifact()` verifies supplied canonical format/MIME against the bytes. `safeParseArtifact()` passes the declared filename and canonical MIME to document-kit and fails closed if the parser result's detected format differs from the trusted canonical format.
- Ingest, extract, analyze, transform, generate, and both compare sides now use the enriched read/parse path. `MockTaskContext` records metadata when artifacts are registered or written and returns the same bytes with the derived canonical identity.
- Added `businesses/document-core/tests/r1-e-trusted-format-propagation.test.ts`. Six happy-path handler tests cover DOCX/XLSX across all actions, assert canonical MIME and declared filename at the parser boundary, and verify parser-detected canonical format. Analyze and transform also use deliberately misleading extension/MIME declarations to prove container markers win.

### Test receipts

- Target command: `npx jest tests/r1-e-trusted-format-propagation.test.ts`
- Working directory: `D:\Git\dugate\du-rework\businesses\document-core`
- Exit code: `0`; 1 suite passed, 6 tests passed.
- Fail-closed regression command: `npx jest tests/r1-e-artifact-inputs.test.ts`
- Same working directory; exit code: `0`; 1 suite passed, 28 tests passed.
- Action regression command: `npx jest --runInBand tests/ingest.test.ts tests/extract.test.ts tests/analyze.test.ts tests/transform.test.ts tests/generate.test.ts tests/compare.test.ts tests/six-action-fail-closed-matrix.functional.test.ts tests/all-variants-e2e.test.ts`
- Same working directory; exit code: `0`; 8 suites passed, 122 tests passed.
- Type check: `npx tsc --noEmit -p tsconfig.test.json` from the same working directory; exit code: `0`.
- All checks were offline. No DB, Redis, connector, provider, or DB window was used.

### Contract boundary

The published Worker SDK `ArtifactFacade.read()` still returns only `Buffer`. Its current runtime path can derive canonical Office identity from container bytes, but cannot recover the original declared filename/MIME. The optional rich-read seam preserves those fields when supplied; exact declared filename/MIME propagation is demonstrated with the document-core mock contract and remains dependent on an upstream artifact metadata provider. No Worker SDK, platform, or connector source was changed.

## R1-E Layer 5 — decompression limits and ZIP bomb guard (2026-09-25)

Completed the archive resource-limit boundary in `packages/document-kit`. ZIP metadata is preflighted before parser lookup/dispatch; Office parsers also run the guard when called directly. The guard checks declared total uncompressed bytes, compression ratio, entry count, paths, and supported structure before inflating. Inflate is bounded by the remaining total-size and ratio budgets, then actual size and CRC are verified before the parser consumes extracted Office XML.

### Changes and coverage

- Stable `ArchiveSecurityError.code` values identify ratio, total expanded bytes, entry count, and bounded inflate output failures: `ARCHIVE_DECOMPRESSION_RATIO_EXCEEDED`, `ARCHIVE_TOTAL_UNCOMPRESSED_BYTES_EXCEEDED`, `ARCHIVE_FILE_ENTRY_COUNT_EXCEEDED`, and `ARCHIVE_DECOMPRESSION_OUTPUT_LIMIT_EXCEEDED`.
- Default limits are 50 MiB total uncompressed data, 1,000 entries, and a 100:1 compression ratio. Format detection reads validated entry names without inflating, so over-limit DOCX/XLSX containers retain their actual detected identity; factory preflight then rejects them before `getParser()`.
- `tests/limits-boundary.test.ts` asserts extractor failures for each resource cap and factory-level DOCX/XLSX ratio and entry-count failures. A synthetic DOCX header declares 50 MiB + 1 byte to check the default total-size limit without allocating or inflating a large payload. Each factory test asserts zero parser dispatch and zero decompressor calls.
- Existing direct Word/Excel negatives in `tests/r1-e-archive-guard.test.ts` continue to cover ZIP bombs, traversal, empty archives, and decompression errors.

### Offline verification receipts

All commands ran from `D:\Git\dugate\du-rework\packages\document-kit` with local synthetic buffers only:

- `npx jest tests/limits-boundary.test.ts tests/r1-e-archive-guard.test.ts --runInBand` — exit code `0`; 2 suites and 57 tests passed.
- `npx jest --runInBand` — exit code `0`; 8 suites and 117 tests passed.
- `npx tsc --noEmit -p tsconfig.json` — exit code `0`.

No DB, Redis, connector, provider, or DB window was used. No large decompression payload was created; the default total-size integration case fails from declared ZIP metadata before inflate.

## R1-E Layer 6 — ZIP64, data descriptors, and worker CPU guard (2026-09-25)

Completed fail-safe handling for unsupported ZIP variants and added terminable worker-thread execution for built-in parsing.

### Changes and coverage

- ZIP64 is now rejected with `ARCHIVE_ZIP64_UNSUPPORTED` when found in local or central size sentinels, ZIP64 extra fields, end records, or the ZIP64 locator. Data-descriptor flags and unexpected descriptor records fail with `ARCHIVE_DATA_DESCRIPTOR_UNSUPPORTED`. Truncated or out-of-range compressed data continues to fail as malformed input before inflate; record scans always advance by validated nonzero header/name lengths.
- Office declarations that cannot be identified because of an unsupported ZIP feature run metadata-only inspection before generic ZIP/declaration mismatch handling. This preserves the specific fail-closed error while still rejecting a valid plain ZIP mislabeled as DOCX/XLSX without decompression.
- `DocumentParserFactory` and direct built-in parser entry points run their preflight and parsing on a terminable `worker_threads.Worker`. The default CPU budget is 30 seconds; `ParserOptions.timeoutMs` overrides it. Timeout terminates the worker, so synchronous decompression/parser work cannot block the caller event loop. The same worker entry works from TypeScript tests and compiled `dist` output.
- Added `tests/r1-e-zip64-descriptor-cpu.test.ts` for ZIP64 local/central/end metadata, descriptor flags/records, impossible compressed ranges, DOCX worker execution, error-code propagation, and a synchronous worker spin that is terminated while a caller-thread heartbeat still fires.
- Registered custom parsers remain caller-thread extensions and receive the existing wait timeout; JavaScript cannot preempt synchronous work in a custom parser. ZIP64 and data descriptors remain unsupported formats and fail closed rather than being extracted.

### Verification receipts

Commands ran offline; package checks used `D:\Git\dugate\du-rework\packages\document-kit` as the working directory:

- `npx jest tests/r1-e-zip64-descriptor-cpu.test.ts --runInBand` — exit code `0`; 1 suite and 10 tests passed.
- `npx jest tests/r1-e-zip64-descriptor-cpu.test.ts tests/r1-e-archive-guard.test.ts tests/r1-e-format-identity.test.ts tests/limits-boundary.test.ts --runInBand` — exit code `0`; 4 suites and 81 tests passed.
- `npx jest --runInBand` — exit code `0`; 9 suites and 127 tests passed.
- `npx tsc --noEmit -p tsconfig.json` — exit code `0`.
- `npm run build` — exit code `0`; compiled output was also smoke-tested for both factory and direct-parser worker paths.

An earlier document-core check recorded workspace compile errors in `packages/worker-sdk/src/types.ts` and `tests/bullmq-smoke.test.ts`. Cycle 84 rebuilt both packages and reran the targeted checks successfully; those diagnostics were not reproduced. No Worker SDK, platform, or connector source was changed. No DB, Redis, live provider, or DB window was used.

## Orchestrator Cycle 84 — document-core Layer 6 integration (2026-09-25)

Prepared an offline action-level regression connecting Layer 6 worker CPU isolation and archive preflight to all six document-core handlers.

### Harness and configuration review

- Added `businesses/document-core/tests/r1-e-layer6-archive-worker.test.ts`. Its 12 table-driven cases send ZIP64 local-size sentinels and unsupported data-descriptor headers through ingest, extract, analyze, transform, generate, and compare. Each row verifies parser invocation with the 30-second budget, fail-closed error propagation, and zero connector calls/output writes.
- Updated the parser-budget boundary comment to match current behavior: the business helper fences waits/deadlines, while document-kit's built-in parser worker performs cancellable CPU isolation. Custom parser factories remain wait-only.
- `document-kit/tsconfig.json` typechecks `src` with `rootDir: src`; its Jest transform also uses package `tsconfig.json`. `document-core/tsconfig.json` builds `src`, and `tsconfig.test.json` adds Jest/Node types and tests. Its Jest mapper resolves document-kit and worker-sdk source, so the integration suite exercised the TypeScript worker bootstrap path.
- Both workspace builds and both package typechecks pass with the current package outputs.

### Offline receipts

- From `D:\Git\dugate\du-rework\businesses\document-core`, `npx jest tests/r1-e-layer6-archive-worker.test.ts --runInBand` — exit code `0`; 1 suite and 12 tests passed.
- From the same directory, `npx jest tests/r1-e-layer6-archive-worker.test.ts tests/r1-e-artifact-inputs.test.ts tests/r1-e-trusted-format-propagation.test.ts tests/six-action-fail-closed-matrix.functional.test.ts --runInBand` — exit code `0`; 4 suites and 81 tests passed.
- From the same directory, `npm run build` — exit code `0`; `npm run test:typecheck` — exit code `0`.
- From `D:\Git\dugate\du-rework\packages\document-kit`, `npx jest --runInBand` — exit code `0`; 9 suites and 127 tests passed. `npm run build` and `npx tsc --noEmit -p tsconfig.json` both exited `0`.

All tests use local in-memory contexts and synthetic ZIP buffers. No DB, Redis, connector, provider, or DB window was used.

## R1-E Layer 7 — Office happy-path parsing across six actions (2026-09-25)

Extended the document-core trusted-format harness into an integration suite for valid DOCX/XLSX bytes through the real built-in parser factory and its worker-thread path. The six action cases collectively exercise both formats, including intentionally misleading source declarations where the container markers identify the canonical Office format.

### Assertions

- Each action checks source bytes and declared filename/MIME returned by `readWithMetadata`, the declared filename and canonical MIME passed at the parser boundary, and the detected canonical format returned by the parser.
- The DOCX fixture includes a paragraph and a two-row table. Tests assert exact extracted text (`Item\tAmount`, `Widget A\t250`) and exact Markdown table output.
- The XLSX fixture includes a two-row table; tests assert the header and data row in extracted text and Markdown.
- Parser calls carry a positive CPU timeout. Jest `--detectOpenHandles` completed cleanly after all worker-backed action cases, with no open-handle report.

### Offline verification receipts

All commands ran from `D:\Git\dugate\du-rework\businesses\document-core` using synthetic Office ZIP buffers and in-memory contexts:

- `npx jest tests/r1-e-trusted-format-propagation.test.ts --runInBand --detectOpenHandles` — exit code `0`; 1 suite and 6 tests passed.
- `npx jest tests/r1-e-layer6-archive-worker.test.ts tests/r1-e-artifact-inputs.test.ts tests/r1-e-trusted-format-propagation.test.ts tests/six-action-fail-closed-matrix.functional.test.ts --runInBand --detectOpenHandles` — exit code `0`; 4 suites and 81 tests passed, with no open-handle report.
- `npm run test:typecheck` — exit code `0`.
- `npm run build` — exit code `0`.

No DB, Redis, live connector/provider, or DB window was used. The suite verifies real built-in parser worker execution through `defaultParserFactory`; caller-supplied custom parser factories remain outside this worker-thread isolation contract.

## Orchestrator Cycle 87 — example-review safe Office parsing (2026-09-25)

Integrated the R1-E Layer 7 Office parsing contract into `businesses/example-review`. Source DOCX/XLSX artifacts now go through `@du/document-kit`'s default parser factory before review checks or reasoning. The factory enforces archive preflight and uses its terminable built-in parser worker; the review path supplies a 10 MiB input cap and 30-second CPU timeout.

### Changes and coverage

- Added `prepareReviewEvidence()` to select Office evidence from actual container identity or a declared `.docx`/`.xlsx` filename, parse with the detected canonical MIME, and feed extracted text into review checks and reasoning. Container markers therefore select Word versus Excel even when the declared extension is misleading.
- Office parser failures fail closed before connector calls or artifact writes. Logs contain only `DOCUMENT_PARSE_FAILED` and redacted details; caller-visible error text omits filenames and parser exceptions. Office evidence must extract non-empty text before review continues.
- Bumped the saved evidence policy version to `3`, so prior checkpoints cannot bypass Office parsing. Added DOCX/XLSX MIME types to the manifest, declared the shared `@du/document-kit` workspace dependency, and updated the package boundary/README accordingly.
- Added `businesses/example-review/tests/r1-e-office-safe-parser.test.ts`: valid DOCX and XLSX files run through both single-item root and fan-out child handlers; cases include misleading `.docx`/`.xlsx` declarations, exact Word paragraph/table and spreadsheet table assertions, parser MIME/timeout options, and reasoning text. An unsafe traversal archive verifies fail-closed behavior and credential/exception redaction.

### Offline verification receipts

- From `D:\Git\dugate\du-rework\businesses\example-review`, `npx jest tests/r1-e-office-safe-parser.test.ts --runInBand --detectOpenHandles` — exit code `0`; 1 suite and 9 tests passed, with no open-handle report.
- From the same directory, `npm run test:unit` — exit code `0`; 13 suites and 119 tests passed.
- From the same directory, `npm run test:typecheck` and `npm run build` — both exit code `0`.
- From `D:\Git\dugate\du-rework`, `pnpm --filter @du/example-review... build` — exit code `0`; contracts, document-kit, observability, worker-sdk, and example-review built in dependency order.
- From the same workspace root, `pnpm install --lockfile-only --offline --frozen-lockfile` — exit code `0`; all 13 workspace projects accepted the updated lockfile.

All parser tests use synthetic Office ZIP buffers and in-memory task contexts. No DB, Redis, live connector/provider, or DB window was used.

## P8-01 Cycle 88 — BR-11 offline traceability and audit entity harness (2026-09-25)

Extended the document-core offline trace harness to assert one identity chain across operation, root task, invocation grant, connector invocation, and provider request. The fixture records entity-shaped operation/task links, checks the grant is requested for that task, verifies operationId/taskId/invocationId on the connector invocation, and checks that the provider request idempotency key is the same invocationId whose response supplies providerRequestId.

Added `services/orchestrator/tests/p8-01-audit-entity-offline.test.ts`. It checks the admin audit migration entity fields and exercises the production `createAuditService` against an in-memory `Db.query` fake. The assertions cover persisted correlation/resource/actor/action fields, the service's list mapping, and tenant-scoped SQL/filtering with a foreign-tenant row. No database connection is created.

### Offline receipts

- From `D:\Git\dugate\du-rework\businesses\document-core`, `npx jest tests/p8-01-traceability-harness.test.ts tests/traceability.test.ts --runInBand` — exit code `0`; 2 suites and 8 tests passed.
- From the same directory, `npm run test:typecheck` — exit code `0`.
- From `D:\Git\dugate\du-rework\services\orchestrator`, `npx jest tests/p8-01-audit-entity-offline.test.ts --config jest.unit.config.cjs --runInBand` — exit code `0`; 1 suite and 2 tests passed.
- From the same directory, `npm run test:unit` — exit code `1`; 22 of 26 suites passed (766 tests passed), and 4 suites could not compile because `src/modules/webhooks/webhooks.ts:242` uses `allowHosts` before its declaration at line 258 (TS2448/TS2454). The focused P8-01 audit suite passes independently.

This is offline synthetic identity/entity evidence, not proof of persisted multi-service trace linkage. P8-01's isolated cross-service E2E acceptance clause remains open. No DB window was opened; no live DB, Redis, connector, or provider was used.

## Orchestrator Cycle 89 — BR-12 isolation offline harness (2026-09-25)

Added `services/orchestrator/tests/br12-isolation-offline.test.ts` with three DB-free cases:

- The production outbox dispatcher resolves a business-B task to business B's versioned queue; a business-A queue consumer has no matching delivery to claim.
- The production submission and profile services reject an API key bound only to business A when it submits to business B (`403 PERMISSION_DENIED`), before a transaction or operation/task/outbox write.
- A direct-claim characterization calls the production runtime service with a business-A worker identity and a business-B task. It demonstrates a remaining BR-12 gap: the runtime claim API does not scope the worker identity to a business, so the claim succeeds and returns the business-B snapshot. Queue separation alone does not protect a forged/direct task-ID claim. This case documents the missing boundary; it does not count as a passing negative authorization assertion.

### Offline receipts

- From `D:\Git\dugate\du-rework\services\orchestrator`, `npx jest tests/br12-isolation-offline.test.ts --config jest.unit.config.cjs --runInBand` — exit code `0`; 1 suite and 3 tests passed (including the explicit direct-claim gap characterization).
- From the same directory, `npm run test:unit` — exit code `1`; 24 of 28 suites passed, 829 of 837 tests passed. Four unrelated suites failed: `artifact-storage-service.test.ts` has TS2339 on `failure.message`; `admin-shell-platform-mount.test.ts` and `admin-shell-server.test.ts` hit localhost HTTP timeouts; `artifacts-fencing.test.ts` expected `HASH_MISMATCH` but received `SIZE_MISMATCH`. The new BR-12 suite passes in the full run.

The binding-use denial and queue routing checks are green. BR-12 remains open for server-side cross-business claim rejection; the runtime needs a trusted worker-business scope and an offline test asserting rejection before lease mutation. No DB window was opened and no live DB or Redis was used.

## Orchestrator Cycle 91 — BR-12 runtime claim authorization (2026-09-25)

The worker SDK now sends its manifest-derived `businessId` with each claim. The claim route validates the request contract, and `createRuntimeService.claimTask` compares the worker business to the task's operation business immediately after its locked read. A mismatch returns `403 PERMISSION_DENIED` before operation-state reads, lease updates, or construction/return of an execution snapshot. Existing runtime and integration claim fixtures now provide their business context.

Converted the BR-12 direct-claim characterization into a rejection test: a business-A worker attempting a business-B task is denied; the test asserts no execution snapshot is disclosed and no task/operation update query occurs. The queue-routing and unauthorized cross-business binding-use assertions remain covered.

### Offline receipts

- From `D:\Git\dugate\du-rework\services\orchestrator`, `npx jest tests/br12-isolation-offline.test.ts --config jest.unit.config.cjs --runInBand` — exit code `0`; 1 suite and 3 tests passed.
- From `D:\Git\dugate\du-rework\packages\worker-sdk`, `npx jest tests/connector-session.test.ts --runInBand` — exit code `0`; 1 suite and 30 tests passed, including the assertion that the worker sends manifest business identity on claim.
- Contracts: `pnpm --filter @du/contracts build`, `pnpm --filter @du/contracts lint`, and `pnpm --filter @du/contracts test` all exited `0`; 7 suites and 80 tests passed.
- Worker SDK: `pnpm --filter @du/worker-sdk build` and `npm run lint` exited `0`.
- Orchestrator `npm run lint` exited `1` on unrelated existing errors in `src/modules/auth/oidc-client.ts` (TS2304 `JsonWebKey`; TS2345/TS18048 optional JWKS configuration values). The BR-12 Jest suite's TypeScript transform passed.
- Additional full worker-SDK Jest attempt was not clean: the forced-exit run had 8/9 suites and 139/140 tests pass; `network-boundaries.boundary.test.ts` failed at its loopback download with `TRANSPORT_FAILURE`. The targeted claim-context suite passes independently.

No DB window was opened; these tests and typechecks used no live DB or Redis.

## Orchestrator Cycle 93 — BR-06 usage deduplication and BR-08 cancel/resume race (2026-09-25)

Added `businesses/document-core/tests/br06-checkpoint-dedup-offline.test.ts`. It runs the real document-core `extract` handler with durable-checkpoint behavior in an in-memory `TaskContext`: the first connector attempt throws a simulated 429, the retry succeeds and records one synthetic usage-ledger write, and a redelivered action restores the checkpoint without another connector attempt or usage write. The fixture intentionally records usage at the connector seam; it does not claim PostgreSQL ledger readback.

Added `services/orchestrator/tests/br08-cancel-resume-race-offline.test.ts`. It invokes the production lifecycle cancel and runtime resume services with an in-memory transaction fake that serializes transactions like the operation row lock. The cancel-wins race and pre-existing `CANCELLED`, `SUCCEEDED`, `FAILED`, and `TIMED_OUT` operations all return 409 `STATE_CONFLICT` for resume. Assertions prove resume stops after the locked operation read, with zero queued task/outbox writes and zero child task inserts.

### Offline receipts

- From `D:\Git\dugate\du-rework\businesses\document-core`, `npx jest tests/br06-checkpoint-dedup-offline.test.ts --runInBand` — exit code `0`; 1 suite, 1 test passed.
- From the same directory, `npx jest tests/checkpoint.test.ts tests/checkpoint-replay.test.ts tests/br06-checkpoint-dedup-offline.test.ts --runInBand` — exit code `0`; 3 suites, 9 tests passed.
- From `D:\Git\dugate\du-rework\services\orchestrator`, `npx jest tests/br08-cancel-resume-race-offline.test.ts --config jest.unit.config.cjs --runInBand` — exit code `0`; 1 suite, 5 tests passed.
- From the same directory, `npx jest tests/br12-isolation-offline.test.ts tests/br08-cancel-resume-race-offline.test.ts --config jest.unit.config.cjs --runInBand` — final rerun exit code `0`; 2 suites, 8 tests passed. The initial attempt exited `1` while ts-jest could not resolve `notFound` in `submission.ts`; the import was present on rerun. Cycle 93 did not edit that source file.
- From document-core, `npm run test:typecheck`, `npm run lint`, and `npm run build` all exited `0`. From Orchestrator, `npm run lint` and `npm run build` both exited `0`.

The traceability matrix now cites both suites and records the remaining limits: BR-06 uses a synthetic in-memory usage sink rather than a persisted ledger readback; BR-08 uses serialized fake transactions rather than live PostgreSQL lock timing or HTTP-route concurrency. No DB window was opened; no live DB or Redis was used.

## Orchestrator Cycle 95 — BR-12 authenticated worker business identity (2026-09-25)

Added `services/orchestrator/src/modules/runtime/worker-identity.ts` and wired it into the runtime claim route. Orchestrator `ServerConfig.workerIdentityTokensByBusiness` maps each business ID to a unique worker bearer token. Runtime auth accepts configured worker tokens; claim auth resolves the authenticated business from that token and compares it with `body.businessId`. A mismatch returns `403 PERMISSION_DENIED` before `claimTask` is invoked, and the runtime service receives the verified business identity. The platform runtime token alone remains insufficient to claim a business. Token matching is constant-time, and startup rejects empty, duplicate, or platform-role-aliasing worker tokens.

Updated the runtime HTTP test fixture to use a dedicated worker identity token for claims. Extended `services/orchestrator/tests/br12-isolation-offline.test.ts` with a DB-free forged-business case: business A's token paired with a business B claim is denied, the claim service spy remains untouched, and business B's matching token resolves only to business B.

### Offline receipts

- From `D:\Git\dugate\du-rework\services\orchestrator`, `npx jest tests/br12-isolation-offline.test.ts --config jest.unit.config.cjs --runInBand` — exit code `0`; 1 suite, 4 tests passed.
- From the same directory, `npm run lint` — exit code `0`.
- From the same directory, `npm run build` — exit code `0`.

Workers continue to use the existing `WorkerConfig.runtimeToken` bearer field, provisioned with the per-business token present in `workerIdentityTokensByBusiness`; no worker-supplied body value establishes identity. No DB window was opened and no live DB or Redis was used.

## Cycle 96 — Artifact metadata propagation (2026-09-25)

Closed the metadata gap between artifact upload, authorized read grants, and document-core parser dispatch:

- Added optional `fileName` to the upload-grant contract. The Orchestrator stores the original declared filename when supplied in `artifacts.file_name` and includes `fileName`, declared `mimeType`, finalized `sizeBytes`, and `sha256` in read grants. Added migration `services/orchestrator/migrations/0014_artifact_declared_filename.sql`; it is authored but was not applied to any database.
- Added `ArtifactFacade.readWithMetadata(artifactId)` to worker-sdk. It streams under the configured cap, verifies grant size/hash when supplied, and returns `{ buffer, filename?, mimeType?, sizeBytes, sha256 }`. SDK artifact writes and the `uploadArtifact` helper now include the original filename in their upload-grant request.
- Updated the document-core SDK adapter to retain the grant's exact declared filename/MIME while deriving canonical format/MIME from the actual bytes. The existing document-kit factory receives the declared name and MIME and continues to dispatch Office parsing from container markers with archive preflight.
- Added offline tests for the SDK write/read grant round trip and digest rejection, document-kit DOCX/XLSX parse with declared identity (including a conflicting declaration), the document-core SDK adapter, and the Orchestrator grant metadata seam using an in-memory DB fake.

### Offline receipts

- From `D:\Git\dugate\du-rework\packages\worker-sdk`, `npx jest tests/artifact-read-metadata.test.ts tests/artifact-streams.test.ts --runInBand` — exit code `0`; 2 suites and 47 tests passed.
- From the same directory, `npx jest tests/artifact-read-metadata.test.ts tests/artifact-streams.test.ts tests/connector-session.test.ts tests/fan-out.test.ts tests/worker.test.ts tests/temp-sweep.test.ts tests/workspace-reference-wiring.test.ts tests/artifact-sweep-guard.test.ts tests/connector-input-contract.test.ts --runInBand` — exit code `0`; 9 suites and 141 tests passed. Updated the connector-session offline fixture to consume the SDK's streaming upload body and write a committed synthetic output artifact before asserting completion; the fan-out test now asserts filename propagation.
- From `D:\Git\dugate\du-rework\packages\document-kit`, `npx jest --runInBand` — exit code `0`; 10 suites and 130 tests passed.
- From `D:\Git\dugate\du-rework\businesses\document-core`, `npx jest tests/r1-e-sdk-metadata-adapter.test.ts tests/r1-e-trusted-format-propagation.test.ts tests/r1-e-artifact-inputs.test.ts --runInBand` — exit code `0`; 3 suites and 35 tests passed.
- From `D:\Git\dugate\du-rework\services\orchestrator`, `npx jest tests/artifact-storage-service.test.ts --config jest.unit.config.cjs --runInBand` — exit code `0`; 1 suite and 7 tests passed.
- Contracts `npm run build` and `npm run lint`; worker-sdk, document-kit, document-core, and Orchestrator `npm run build` and `npm run lint` — every command exited `0`.
- The default worker-sdk `npx jest --runInBand` includes the separate `[LOCK]` network-boundaries characterization suite, whose latest run exited `1` at 146/147 tests: the local listener SHA-mismatch case received `TRANSPORT_FAILURE` instead of `HASH_MISMATCH`. The focused offline SDK regression command above excludes that intentionally gated boundary suite; no product changes were made to its download path.

All new tests use synthetic bytes, injected fetch, or in-memory persistence. No DB window was opened, no migration was applied, and no live DB, Redis, connector, or provider was used.

## Reviewer audit findings - atomic writes, typed events, tenant reads (2026-09-25)

Closed the three findings in the Orchestrator audit path:

- Admin mutations for profile bindings and business versions use `auditedMutation`, which runs the mutation and `admin_audit_events` INSERT in the same transaction. Offline failure injection already exercised business-version activation and profile-binding revision creation; an audit INSERT failure rejects and leaves the fake transaction journal empty. Added an assertion that the binding ledger row carries the new event identity.
- Replaced `apikey.profile_bind` with the typed `profile_binding.bind` event in the profile-binding route and dispatcher. Added the kind to the overview view-model and event allowlist with the label `Profile binding granted`; retained truthful rendering for historical `apikey.profile_bind` rows and updated ledger, view-model, and browser-mock expectations. The API-key create/revoke controls have no mutating API routes yet; the profile-binding grant is the current API-key-associated mutation.
- GET `/api/v1/admin/audit` now delegates to `listAuthorizedAuditEvents`, which resolves tenant scope from the authenticated principal before calling the audit repository. A tenant-A operator requesting `tenantId=B` receives `403 PERMISSION_DENIED` and the offline spy confirms no ledger read occurs. Missing tenant selection resolves to the operator's own tenant; platform access remains unchanged.

### Offline receipts

- Working directory `D:\Git\dugate\du-rework\services\orchestrator`: `npx jest tests/admin-action-dispatcher.test.ts tests/admin-mutation-atomicity.test.ts tests/admin-audit-scope.test.ts tests/admin-overview-view-model.test.ts tests/p8-01-audit-entity-offline.test.ts tests/admin-idempotency.test.ts --config jest.unit.config.cjs --runInBand` - exit code `0`; 6 suites and 141 tests passed.
- Same working directory: `npm run lint` - exit code `0` (`tsc --noEmit -p tsconfig.json`).
- Same working directory: `npm run build` - exit code `0` (`tsc -p tsconfig.json`).
- From `D:\Git\dugate\du-rework\tests\browser`, `npm run lint` - exit code `0` (`tsc --noEmit -p tsconfig.json`).

No DB window was opened and no live PostgreSQL or Redis was used.

## Orchestrator Cycle 99 — BR-12 worker privilege scope narrowing (2026-09-25)

Narrowed worker bearer authorization at the HTTP route boundary:

- Worker tokens are resolved only from the configured business-to-token map. They are rejected with `403 PERMISSION_DENIED` before dispatch on every non-runtime API path, including `/api/v1/admin/*`, `/api/v1/operations`, and `/api/v1/usage`; Connector `/api/runtime/v1/usage-events` is also denied to worker identities.
- Business version registration is platform-runtime-only. Worker-instance heartbeat requires the body business ID to match the authenticated token. Workspace-reference reads pass the authenticated business into the filtered runtime query.
- Every task runtime route checks the task's business before calling runtime mutation/read services. Artifact grant/finalize/access routes check artifact and body task ownership; blob access checks the artifact business before using the grant. Thus a business-A token cannot claim, heartbeat, complete, read children, mutate, or obtain artifact data for business B.
- Expanded `br12-isolation-offline.test.ts` with route-level offline coverage for admin/public denials, Connector usage ingestion, platform-only registration, cross-business task and artifact access, worker heartbeat identity, workspace-reference scoping, and successful own-business claim/heartbeat/complete/children operations.

### Offline receipts

- Working directory `D:\Git\dugate\du-rework\services\orchestrator`: `npx jest tests/br12-isolation-offline.test.ts --config jest.unit.config.cjs --runInBand` — exit code `0`; 1 suite, 18 tests passed.
- Same working directory: `npm run lint` — exit code `0` (`tsc --noEmit -p tsconfig.json`).
- Same working directory: `npm run build` — exit code `0` (`tsc -p tsconfig.json`).

No DB window was opened; no live PostgreSQL or Redis was used.

## Orchestrator Cycle 100 — R1-B / FIX-CR-06 active lease fencing (2026-09-25)

Hardened runtime task mutations in `services/orchestrator/src/modules/runtime/runtime.ts`:

- `heartbeatTask`, `completeTask`, `failTask`, and `saveStep` (the runtime checkpoint save) now verify the current epoch, `RUNNING` task state, unexpired lease, and token-derived worker business while holding the task row lock. A foreign business fails with `403 PERMISSION_DENIED`; stale, expired, cancelled, and lost write-side CAS fences fail with `409 LEASE_LOST`.
- Conditional SQL writes re-check epoch, state, expiry using `clock_timestamp()`, and worker business. Heartbeat no longer revives an expired lease; transaction failures roll back the entire mutation. The HTTP task routes pass the business resolved from the authenticated worker token into these service methods.
- Added `services/orchestrator/tests/runtime-lease-fencing-offline.test.ts`. Its in-memory transaction fake covers all four mutations across stale epoch, expired lease, cancelled task, foreign business, and a write-side CAS race; it verifies rollback and zero committed writes. The BR-12 offline suite also verifies the authenticated business is propagated from route to runtime.
- Updated `docs/19-traceability-audit-matrix.md` with fresh BR-12 worker privilege, artifact metadata propagation, atomic-audit/tenant-scope, and lease-fencing evidence. P8-01's separate isolated multi-service E2E acceptance remains PARTIAL.

### Offline receipts

- Working directory `D:\Git\dugate\du-rework\services\orchestrator`: `npx jest tests/runtime-lease-fencing-offline.test.ts tests/br12-isolation-offline.test.ts --config jest.unit.config.cjs --runInBand` — exit `0`; 2 suites, 39 tests passed.
- Same working directory: `npx jest tests/runtime-lease-fencing-offline.test.ts tests/br12-isolation-offline.test.ts tests/br08-cancel-resume-race-offline.test.ts tests/admin-mutation-atomicity.test.ts tests/admin-audit-scope.test.ts tests/artifact-storage-service.test.ts --config jest.unit.config.cjs --runInBand` — exit `0`; 6 suites, 88 tests passed.
- Same working directory: `npm run lint` and `npm run build` — both exit `0`.
- Worker SDK metadata regression from `D:\Git\dugate\du-rework\packages\worker-sdk`: `npx jest tests/artifact-read-metadata.test.ts tests/artifact-streams.test.ts --runInBand` — exit `0`; 2 suites, 47 tests passed.
- Document-kit metadata regression from `D:\Git\dugate\du-rework\packages\document-kit`: `npx jest tests/r1-e-declared-metadata-parse.test.ts tests/r1-e-format-identity.test.ts --runInBand` — exit `0`; 2 suites, 17 tests passed.
- Document-core metadata regression from `D:\Git\dugate\du-rework\businesses\document-core`: `npx jest tests/r1-e-sdk-metadata-adapter.test.ts tests/r1-e-trusted-format-propagation.test.ts tests/r1-e-artifact-inputs.test.ts --runInBand` — exit `0`; 3 suites, 35 tests passed.

All Cycle 100 suites were offline and used in-memory fakes or existing synthetic artifact fixtures. No DB window was opened and no live DB or Redis was used.

## Orchestrator Cycle 101 — R1-B / MM-10b terminal response alignment (2026-09-25)

Aligned the runtime lease-fencing contract with the accepted MM-10b terminal response:

- After authenticating the worker business and checking `leaseEpoch`, `assertActiveLease` now returns `410 TASK_TERMINAL` for terminal states (`SUCCEEDED`, `FAILED`, `CANCELLED`, `TIMED_OUT`) before checking whether the lease is active. `completeTask` and `failTask` also return 410 for CANCELLED tasks. Current-epoch terminal heartbeats and the shared lease-fenced mutation path no longer report `409 LEASE_LOST`; stale epochs retain the epoch-first 409 response. The conditional write-side epoch/state/expiry predicates remain in place.
- Updated the offline lease-fencing matrix so CANCELLED is expected to return 410 across heartbeat, complete, fail, and checkpoint mutations. Added a DB-free MM-10b probe that asserts same-epoch post-cancel heartbeat returns 410 without changing lease expiry or issuing writes, a guard-order assertion that stale epoch remains 409, and a table-driven heartbeat check for all four terminal states.

### Offline receipts

- Working directory `D:\Git\dugate\du-rework\services\orchestrator`: `npx jest tests/runtime-lease-fencing-offline.test.ts --config jest.unit.config.cjs --runInBand` — exit code `0`; 1 suite, 27 tests passed.
- Same working directory: `npx jest tests/runtime-lease-fencing-offline.test.ts --config jest.unit.config.cjs --runInBand --testNamePattern="MM-10b"` — exit code `0`; 1 suite, 2 MM-10b tests passed (25 unrelated tests skipped by the name filter).
- Working directory `D:\Git\dugate\du-rework`: with `DU_LIVE_INFRA` unset, `npx jest tests/integration/p8-02b-redisloss-sameepoch-fault.integration.test.ts --config tests/integration/jest.config.cjs --runInBand` — exit code `0`; 1 suite and 6 tests skipped by the suite's live-infrastructure gate. This is recorded as a skip, not as live MM-10b verification.
- Working directory `D:\Git\dugate\du-rework\services\orchestrator`: `npm run lint` — exit code `0` (`tsc --noEmit -p tsconfig.json`); `npm run build` — exit code `0` (`tsc -p tsconfig.json`).

No DB window was opened and no live PostgreSQL or Redis was used. No commit or push was performed.

## P8-01 Cycle 114 — Traceability harness review (2026-09-25)

Reviewed the requested harness locations. `tests/harness/traceability/` and `tests/integration/p8-01-traceability.integration.test.ts` do not exist; equivalent coverage is split between `businesses/document-core/tests/p8-01-traceability-harness.test.ts` and `services/orchestrator/tests/p8-01-audit-entity-offline.test.ts`. The live candidate is `businesses/document-core/tests/multi-container-e2e.integration.test.ts`.

The offline document-core case runs the real extract handler and Worker SDK context, and checks synthetic operation/root-task IDs, task-bound invocation-grant request, operation/task/invocation IDs at the Connector seam, and matching provider idempotency key/providerRequestId. Its operation/task rows and Runtime/Connector/provider boundaries are test doubles. The audit case exercises production `createAuditService` with an in-memory DB fake and verifies entity fields, correlation/resource mapping, and tenant filtering, but it is independent of the operation trace. Production audit writes are currently used by admin mutations; no tested event joins the provider trace to `admin_audit_events`.

P8-01 remains PARTIAL. The existing live multi-container suite is a suitable real Orchestrator/Connector/mock-provider harness and verifies persisted operation/invocation evidence, but it was not run under the no-live-test constraint and it does not assert an audit-ledger join. The end-to-end persisted operation → root task → invocation grant → provider request → audit entity chain is therefore not yet confirmed.

### Offline receipts

- From `D:\Git\dugate\du-rework\businesses\document-core`, `npm run test:typecheck` — exit `0` after refreshing stale test-only `ArtifactFacade` mocks for the SDK metadata/stream methods.
- Same working directory: `npx jest tests/p8-01-traceability-harness.test.ts --runInBand` — exit `0`; 1 suite, 1 test passed.
- From `D:\Git\dugate\du-rework\services\orchestrator`, `npx tsc --noEmit --pretty false` — exit `0`; `npx tsc` focused on `tests/p8-01-audit-entity-offline.test.ts` — exit `0`.
- Same working directory: `npx jest tests/p8-01-audit-entity-offline.test.ts --config jest.unit.config.cjs --runInBand` — exit `0`; 1 suite, 2 tests passed.
- An expanded offline selection of four document-core suites passed 3 suites / 64 tests; `provider-backed-variant.test.ts` had 1 unrelated worker-delivery failure because its fake Runtime omitted `POST /tasks/:id/fail`, masking the initial handler error. This is recorded as a remaining offline-suite issue, not as P8-01 evidence.

No live tests ran; no DB window was opened and no live PostgreSQL or Redis was used. No commit or push was performed.

## P8-01 Cycle 115 — Integration harness implementation (2026-09-25)

Added `tests/integration/p8-01-traceability.integration.test.ts`. The suite uses a per-run PostgreSQL schema and Redis database namespace, real Orchestrator/Connector compositions and document-core worker, plus a loopback synthetic provider. Its trace assertion joins:

- submitted operation and persisted root task (`operation.root_task_id` / `tasks.operation_id`);
- invocation grant scoped to that operation and task;
- provider request idempotency key equal to the grant's invocation ID and Connector ledger `provider_request_id` equal to the mock provider response ID;
- usage event payload carrying the same operation, task, and invocation IDs;
- a real `operations.cancel` admin audit row whose resource identifies the same operation and whose correlation ID is asserted.

A worker fetch barrier pauses at the first post-provider step checkpoint so the operation audit mutation is performed while the trace is still in flight. Teardown releases the barrier and closes the worker, Connector, mock provider, Orchestrator, and suite-owned schema.

Also fixed the two Batch 7 items: added the missing `POST /tasks/:id/fail` route to the provider-backed Fake Runtime, and made binary artifact uploads bypass its JSON body parser. Added `@du/egress` to the dependency build sequence before `@du/connector` and updated build-order expectations and fail-fast count.

### Verification receipts

- Working directory `D:\Git\dugate\du-rework\businesses\document-core`: `npx jest tests/build-dependency-order.test.ts tests/provider-backed-variant.test.ts --runInBand` — exit `0`; 2 suites, 17 tests passed.
- Same working directory: `npm run test:typecheck` — exit `0` (`tsc --noEmit -p tsconfig.test.json`).
- Working directory `D:\Git\dugate\du-rework\tests\integration`: `npm run lint` — exit `0` (`tsc --noEmit -p tsconfig.json`), including the new integration suite.

The P8-01 integration test itself was not run in this pass. No database/Redis connection or DB window was opened; no commit or push was performed. P8-01 remains PARTIAL until the integration lane runs the isolated suite and records its test receipt.

## Document-Core Batch 7 — sdk-consumer Fake Runtime repair (2026-09-25)

Completed the `sdk-consumer.test.ts` Fake Runtime fixes. The fetch adapter now accepts JSON strings, streaming `ReadableStream` bodies, and opaque byte bodies without trying to JSON-decode artifact payloads. The six-action delivery helper asserts that a non-empty artifact upload reached the fake upload route. Added `/tasks/:id/fail` handlers to the durable-checkpoint and lease-loss fixtures; their assertions confirm successful checkpoint execution does not fail and lease loss emits no terminal failure report. The six-action and failure-classification fixtures already had the route.

### Verification receipts

- Working directory `D:\Git\dugate\du-rework\businesses\document-core`: `npx jest tests/sdk-consumer.test.ts --runInBand` — exit `0`; 1 suite, 12 tests passed.
- Same working directory: `npm run test:typecheck` — exit `0` (`tsc --noEmit -p tsconfig.test.json`).
- Same working directory, with `REDIS_SMOKE=0`: `npx jest --runInBand --testPathIgnorePatterns='multi-container-e2e.integration.test.ts' --testNamePattern='^(?!.*live usage_events projection query aggregates provider tokens and costs matching UsageSchema)'` — exit `0`; 40 suites passed, 489 tests passed, 1 PostgreSQL projection test skipped by name filter. The multi-container DB/Redis suite was excluded, and the Redis smoke suite returned before opening a Redis connection.

The broad receipt covers all 40 suites in the DB-free lane; it is not a live integration receipt. No DB/Redis connection was used, no DB window was opened, and no commit or push was performed.

## P8-01 Cycle 116 — schema and assertion review (2026-09-25)

Reviewed every SQL statement and selected/asserted column in `tests/integration/p8-01-traceability.integration.test.ts` against the checked-in Orchestrator/Connector migrations. The setup insert into `api_keys` and `profile_bindings` cleanup match migrations `0001_platform_v1.sql` and `0004_profile_bindings.sql`. The selected fields for `operations`/`tasks` match `0001_platform_v1.sql`; `invocation_grants` fields and `created_at` ordering match `0003_artifacts_grants.sql`; Connector ledger fields match `services/connector/src/db/migrations/001_connector.sql`.

The two schema nuances are accounted for by the suite: invocation identity in `usage_events` is nested in its JSONB `payload` (there is no `invocation_id` column), and audit-to-operation linkage uses `admin_audit_events.resource` plus `correlation_id` (there is no operation FK). `007_connector_credential_source.sql` only adds `connector_revisions.credential_source`, which supports revision setup and does not change any queried trace table. No source-level SQL/schema discrepancy was found.

### Review scope and receipt

- Static review only; no Jest command, typecheck, migration, DB window, PostgreSQL connection, or Redis connection was used. Consequently there is no new test exit code or test count to report.
- Tester-1 owns confirmation that the target database has applied the migration set and the live P8-01 run receipt. P8-01 remains PARTIAL until that isolated execution is reported.


## P8-01 lease timeout repair (2026-09-25)

Tester-1's live receipt at `coordination/reports/tester.md:6271` showed the document-core worker losing its lease before the P8-01 assertions completed. The suite configured `heartbeatIntervalMs: 60_000`, exactly equal to the platform's `LEASE_DEFAULTS.leaseMs: 60_000`; scheduling and DB/network latency can make the first heartbeat arrive after the conditional lease-expiry check. That causes the SDK to abort the task context and treat the terminal report as ambiguous.

Changed only the P8-01 worker fixture heartbeat interval to `2_000` ms, consistent with the existing document-core multi-container integration worker fixtures. This leaves ample margin inside the 60-second lease while the test intentionally pauses a step-save request. Runtime heartbeat and lease policy were not changed.

- From `D:\Git\dugate\du-rework`, `npm run lint --prefix tests/integration` — exit `0` (runs TypeScript `tsc --noEmit -p tsconfig.json`).
- No Jest integration run, DB/Redis connection, migration, DB window, commit, or push was performed. Tester-1 must rerun the live suite for a new runtime receipt.

## P8-01 barrier timeout and teardown repair (2026-09-25)

Tester-1's live receipt at tester.md:6597 identified the long-held customFetch barrier as the timeout source: after the first step-save request was intercepted, the test waited on grant, Connector invocation, usage, and audit DB assertions before releasing the fetch promise. This exceeded RuntimeClient's request deadline, caused an ambiguous runtime report, and left the delivery for redelivery.

Moved the operation cancel and audit verification immediately after the checkpoint signal, with gate release in a finally block before the remaining trace-row assertions. Added a 5-second safety release to the test seam so a stalled assertion cannot hold the HTTP request past the runtime client deadline. The release callback is idempotent. In afterAll, the gate is released first; isolated artifact-directory cleanup now uses the guarded cleanup helper, and collected teardown failures are reported to stderr instead of throwing a second Jest hook error.

- From D:\Git\dugate\du-rework, npm run lint --prefix tests/integration — exit code 0 (TypeScript no-emit check).
- No live Jest test, DB/Redis connection, migration, DB window, commit, or push was run. Tester-1 can rerun the integration suite in the next DB window.

## Cycle 138 — P8-01 live receipt and BR-11 update (2026-09-25)

Verified the BR-11 row and Section 9 in docs/19-traceability-audit-matrix.md against Tester-1's receipt in coordination/reports/tester.md:6781-6801. The tester-owned live run held the PostgreSQL/Redis window from 13:14:39.296 to 13:14:48.821 +07:00 and ran from D:\Git\dugate\du-rework:

- Command: npx.cmd jest --config tests/integration/jest.config.cjs tests/integration/p8-01-traceability.integration.test.ts --runInBand
- Result: ExitCode 0; 1 suite passed, 1/1 test passed; 8.348 seconds; no Jest open-handle warning.

The asserted persisted extract trace links operation -> root task -> invocation grant -> successful Connector invocation -> mock provider request ID -> usage event -> operation.cancel admin audit event. Connector provider_request_id matches the mock provider response; usage payload invocationId matches the grant; the audit row matches resource operation:<id> and the operation correlation ID.

The receipt also contains post-cancel worker logs STATE_CONFLICT and TASK_TERMINAL / fail report fenced. These are log observations only; the integration test does not assert a terminal-fence status. This live receipt covers extract only. BR-11 continues to list ingest, analyze, transform, generate, and compare as lacking equivalent joined live receipts, so P8-01 remains PARTIAL pending the remaining action-scope acceptance and explicit terminal-fence assertion if that behavior is claimed.

This documentation pass only reviewed the Tester-owned receipt; no live test, DB/Redis connection, migration, commit, or push was performed by Codex-New.

## COMP-03 — Legacy idempotency and sync characterization (2026-10-01)

Static source review only. No source, migration, contract, or test files were changed; no tests, DB/Redis calls, or gate ticks were performed.

### Behavior table

| Behavior | Legacy DUGate | Rework orchestrator |
|---|---|---|
| Key storage and scope | Stores the raw `idempotency-key` on `Operation`; the unique constraint is global, with no API-key, tenant, route, or endpoint component (`lib/db/schema.ts:10-14`; `drizzle/0000_violet_franklin_storm.sql:78,107`). Lookup and race recovery filter only by key (`lib/pipelines/submit.ts:142-146,317-330`). | Stores the raw key in `submission_keys`; primary key scope is `(tenant_id, api_key_id, route_action, key)` (`services/orchestrator/migrations/0001_platform_v1.sql:57-68`). Lookup additionally checks `expires_at > now()` (`services/orchestrator/src/modules/operations/submission.ts:678-690`). Default retention is 24 hours (`:231-234`). |
| What is compared | Nothing from the request body is hashed or compared. A matching key returns the existing operation even if the endpoint/body differs (`lib/pipelines/submit.ts:142-146`). | Compares `canonicalRequestHash`: SHA-256 over canonical JSON containing version, normalized `input`, artifacts reduced to `(role, sha256-or-artifactId)` and sorted, `output`, callback URL, and `sourceUrl` when supplied (`packages/contracts/src/hashing.ts:12-35`; `packages/contracts/src/manifest-validator.ts:11-29`). Object keys sort recursively; array order is preserved. A same-scope key with a different hash is HTTP 409 (`services/orchestrator/src/modules/operations/submission.ts:202-208,219-224`). The key itself is not hashed. |
| Correlation ID | `x-correlation-id` (or a generated UUID) is for request logging and the newly enqueued job; it is not stored on `Operation`, used in lookup, or returned in the operation envelope (`lib/endpoints/runner.ts:59-60,247`; `lib/pipelines/submit.ts:341`; `lib/db/schema.ts:10-14`; `lib/pipelines/format.ts:17-33`). Same key with a different correlation ID still replays one operation. | Server accepts/echoes the current header; submission normalizes it, persists it for a newly created operation, and returns the current request's normalized ID even on replay (`services/orchestrator/src/server.ts:717-719,1740-1742,1759`; `services/orchestrator/src/modules/operations/submission.ts:173,226-227,287-300,362-363`). Correlation ID is excluded from the request hash (`packages/contracts/src/hashing.ts:7-9,22-35`). |
| Replay wire result | Same operation ID/current state, formatted as the operation response; replay is always HTTP 200 with no `Operation-Location`, regardless of the first response status (`lib/endpoints/runner.ts:256-276`; `lib/pipelines/submit.ts:143-145`; `lib/pipelines/format.ts:17-33`). | Same operation ID/current state and `replayed: true`; active POST route returns 200 for replay (`services/orchestrator/src/modules/operations/submission.ts:226-227`; `services/orchestrator/src/server.ts:1751-1762`). It returns the retry's correlation ID in the body/header, not the original operation's ID. |
| Concurrent same-key submit | Both callers may miss the read, but the global unique constraint allows one operation insert. The loser catches PostgreSQL `23505`, reads the winner, and returns it as replay (`lib/pipelines/submit.ts:142-146,317-330`; `drizzle/0000_violet_franklin_storm.sql:107`). | Operation, root task, key marker, and outbox row are in one transaction (`services/orchestrator/src/modules/operations/submission.ts:256-282,284-359`). The composite primary key prevents two committed operations for the same scope/key (`services/orchestrator/migrations/0001_platform_v1.sql:67`). The transaction has a `FOR UPDATE` recheck, but no submission-level duplicate-key catch; a racing loser can roll back and become a generic 500, then a client retry can replay (`services/orchestrator/src/db/db.ts:24-36`; `services/orchestrator/src/server.ts:821-831`). This is not a second committed operation. |
| Record versus enqueue | Operation/key insert commits before `queue.add`; the async enqueue is later (`lib/pipelines/submit.ts:300-315,335-390`). A crash or queue error in that gap leaves the key pointing at an unqueued operation; retry takes the early replay return and does not enqueue again (`:142-146`). Queue-full handling explicitly deletes the new operation before returning 503 (`:353-366`). | Operation/task/key/outbox commit atomically; publication happens after commit through the dispatcher. The public route triggers a best-effort dispatch, and the periodic dispatcher starts by default (`services/orchestrator/src/modules/operations/submission.ts:24-29,328-359`; `services/orchestrator/src/server.ts:1748-1750,884`; `services/orchestrator/src/modules/queue/dispatcher.ts:24-81,84-90`). A crash before publish leaves the durable outbox row for the sweeper; stable delivery IDs deduplicate queue publication. |
| Sync and timeout | `?sync=true` is exact string matching (`lib/endpoints/runner.ts:228-229`). New operation enqueues then awaits BullMQ completion up to `SYNC_TIMEOUT_MS` (default 30,000 ms, env-overridable); timeout or job failure is swallowed, then the operation is reloaded (`lib/queue/pipeline-queue.ts:18-19`; `lib/pipelines/submit.ts:369-390`). Runner nevertheless returns 200 for every sync request; it does not switch to 202/location when still unfinished (`lib/endpoints/runner.ts:256-276`). A replay returns before sync enqueue/wait, so a replay with `sync=true` can also return 200 while `done:false` (`lib/pipelines/submit.ts:142-146`; `lib/endpoints/runner.ts:256-257`). |
| Rework sync/status | Active `POST /api/v1/businesses/:id/actions/:action` does not inspect `sync`; a new request returns 202 immediately, and the response has body links but no `Operation-Location` header (`services/orchestrator/src/server.ts:1730-1763,798-800`). `GET /api/v1/operations/:id?wait=N` is a separate long-poll: 500-ms DB polling, clamped to 0–30 seconds, returns HTTP 200 with latest state on terminal completion or timeout (`services/orchestrator/src/server.ts:1806-1840`; `services/orchestrator/src/modules/operations/facade.ts:16,57-84`). The isolated compat router decodes `sync=true` and passes `executeSync` to its injected port, but itself selects 200 from the flag/replay bit without checking terminal state; it sets `Operation-Location` only for its 202 path (`services/orchestrator/src/compat/legacy-wire-decoders.ts:245-270`; `services/orchestrator/src/compat/legacy-action-router.ts:413-445`). It is not mounted by `server.ts` (source search found only its definition and tests). |

### MISMATCH list

1. **Legacy key scope/body comparison is too broad.** A key reused by a different API key/tenant, endpoint, or body can silently alias the first operation: lookup is global and compares only the raw key (`lib/pipelines/submit.ts:142-146,326-329`; `lib/db/schema.ts:10-14`). Rework instead scopes the key by tenant/API key/route and rejects changed content with 409 (`services/orchestrator/migrations/0001_platform_v1.sql:67`; `services/orchestrator/src/modules/operations/submission.ts:202-224`). This is a cross-caller replay/isolation risk in legacy.
2. **Legacy `sync=true` does not meet “200 only when done.”** Timeout/failure is swallowed and the runner returns 200 even if `done` is false; an idempotent replay bypasses the wait and has the same status. Both paths omit `Operation-Location` (`lib/pipelines/submit.ts:142-146,376-385`; `lib/endpoints/runner.ts:256-276`). This is a COMP-03 contract blocker; do not weaken the semantic requirement.
3. **Rework active submit has no `POST ?sync=true` behavior.** The actual server route returns 202 for a new operation without waiting or a location header; GET `?wait=` is a distinct 200 status poll. The compat adapter's sync flag/status logic is isolated and not mounted in `server.ts` (`services/orchestrator/src/server.ts:1730-1763,1806-1840`; `services/orchestrator/src/compat/legacy-action-router.ts:434-445`). This is a COMP-03 gap for the required wire contract.
4. **Legacy enqueue has a durable crash gap; rework closes it with outbox.** Legacy persists the key before queue publication and replay will not retry publication (`lib/pipelines/submit.ts:300-315,335-390,142-146`). Rework writes the outbox in the same transaction and retries dispatch in its background sweep (`services/orchestrator/src/modules/operations/submission.ts:328-359`; `services/orchestrator/src/modules/queue/dispatcher.ts:24-90`).
5. **Rework expiry check is inconsistent.** Fast lookup excludes expired markers, but the in-transaction duplicate lookup does not test `expires_at`; with an expired row still present, a request can still replay it rather than create a fresh operation (`services/orchestrator/src/modules/operations/submission.ts:269-280,678-690`). No `submission_keys` expiry-delete path was found in orchestrator source/migrations. This makes the documented/default 24-hour retention behavior unreliable.
6. **Concurrent rework collision is safe against duplicate commits but may fail the racing request.** The transaction's unique-key error is not caught and translated to replay in `submission.ts:256-363`; the server maps non-HTTP errors to 500 (`services/orchestrator/src/server.ts:828-831`). A retry can take the fast replay path. Neither inspected keyed path silently commits a second operation for the same effective key scope.

### Hard-check disposition

No inspected keyed path returns 202 on replay after a 200 first response: legacy and the active rework route explicitly use HTTP 200 for replay (`lib/endpoints/runner.ts:256-257`; `services/orchestrator/src/server.ts:1751-1762`). No second operation is committed for a concurrent same-scope/key race under the unique constraints. However, the sync completion/status mismatches above are COMP-03 blockers: legacy can report 200 before completion, and the active rework submission route does not implement `?sync=true`.

## Legacy-to-rework route surface map (2026-10-01)

Static source inventory only. I enumerated all 32 route files under `app/api/v1/**` and `app/api/internal/**`, yielding 45 exported method/path handlers. No source, contract, test, plan, or gate was changed; no tests or live services were run. Classification describes handler behavior, not path resemblance.

### Middleware and auth facts

- `middleware.ts:8-17,27-30` bypasses `/api/internal/**` entirely. Each internal handler must enforce its own guard; the middleware itself gives these routes no authentication.
- `middleware.ts:32-52` passes every `/api/v1/**` request through without authenticating it. It strips incoming `x-api-key-id`, `x-user-id`, and `x-user-role`, then may re-inject user ID/role from a verified NextAuth token. It neither validates `x-api-key` nor removes `apiKeyId` in query/body/form data.
- Other matched paths require a NextAuth token (`middleware.ts:55-75`); unauthenticated API calls get 401 and pages redirect. The matcher is `middleware.ts:78-82`.
- `requireAuth` is NextAuth session presence only; `requireAdmin` requires session role `ADMIN`; `requireProfileAccess(apiKeyId)` requires a session and either ADMIN or a matching `(userId, apiKeyId)` assignment (`lib/auth-guard.ts:17-70`). `canMutate` includes both ADMIN and USER (`lib/rbac.ts:9-11`).
- For six document submissions, the middleware's “runner will validate” comment is not the behavior: `lib/endpoints/runner.ts:84-110` does only best-effort raw-key lookup, logs missing/invalid keys, and continues. The runner does not reject an absent/unknown key before loading/submitting (`:177,234-248`).
- `HARDENING-MUST-NOT-REPLICATE` rows flag defects to avoid copying; they do not decide whether Product keeps the capability. The legacy internal `apiKeyId` values used by profile/override/test pages are authorized selectors when followed by `requireProfileAccess`; they are not treated as authentication by themselves.

### Public legacy routes

| Legacy method + path | Legacy handler | Legacy auth actually applied | Legacy response shape class | Rework counterpart by behavior | Classification | Owner |
|---|---|---|---|---|---|---|
| `GET /api/v1/billing/balance` | `app/api/v1/billing/balance/route.ts:17` | Reads only `x-api-key-id` (`:18-20`); middleware strips it, so normal requests get 401; no raw-key proof in handler | JSON per-key balance/limits | ABSENT; `/api/v1/usage/summary` is a tenant aggregate, not a key balance | HARDENING-MUST-NOT-REPLICATE | COMP-08; Product decides balance/ledger disposition |
| `GET /api/v1/billing/usage` | `app/api/v1/billing/usage/route.ts:24` | Reads only `x-api-key-id` (`:25`); middleware strips it; no raw-key proof | JSON per-key usage breakdown | ABSENT; tenant usage/events are not the per-key projection | HARDENING-MUST-NOT-REPLICATE | COMP-08 |
| `POST /api/v1/docs/analyze` | `app/api/v1/docs/analyze/route.ts:5` | Middleware passes through; runner accepts missing/invalid raw key and does not require verified identity (`middleware.ts:32-52`; `lib/endpoints/runner.ts:84-110,177`) | Legacy operation LRO JSON; normally 202 + `Operation-Location`, sync/replay 200 | `POST /api/v1/businesses/:businessId/actions/:action` is only the canonical submit primitive; no `/docs/analyze` wire adapter (`server.ts:1730-1763`) | HARDENING-MUST-NOT-REPLICATE | COMP-03 + COMP-04 |
| `POST /api/v1/docs/compare` | `app/api/v1/docs/compare/route.ts:5` | Same fail-open runner path as analyze (`middleware.ts:32-52`; `runner.ts:84-110,177`) | Legacy operation LRO JSON; 202 + location, sync/replay 200 | `POST /api/v1/businesses/:businessId/actions/:action` is not the legacy multipart facade (`server.ts:1730-1763`) | HARDENING-MUST-NOT-REPLICATE | COMP-03 + COMP-04 |
| `POST /api/v1/docs/extract` | `app/api/v1/docs/extract/route.ts:5` | Same fail-open runner path as analyze (`middleware.ts:32-52`; `runner.ts:84-110,177`) | Legacy operation LRO JSON; 202 + location, sync/replay 200 | `POST /api/v1/businesses/:businessId/actions/:action` is not the legacy multipart facade (`server.ts:1730-1763`) | HARDENING-MUST-NOT-REPLICATE | COMP-03 + COMP-04 |
| `POST /api/v1/docs/generate` | `app/api/v1/docs/generate/route.ts:5` | Same fail-open runner path as analyze (`middleware.ts:32-52`; `runner.ts:84-110,177`) | Legacy operation LRO JSON; 202 + location, sync/replay 200 | `POST /api/v1/businesses/:businessId/actions/:action` is not the legacy multipart facade (`server.ts:1730-1763`) | HARDENING-MUST-NOT-REPLICATE | COMP-03 + COMP-04 |
| `POST /api/v1/docs/ingest` | `app/api/v1/docs/ingest/route.ts:5` | Same fail-open runner path as analyze (`middleware.ts:32-52`; `runner.ts:84-110,177`) | Legacy operation LRO JSON; 202 + location, sync/replay 200 | `POST /api/v1/businesses/:businessId/actions/:action` is not the legacy multipart facade (`server.ts:1730-1763`) | HARDENING-MUST-NOT-REPLICATE | COMP-03 + COMP-04 |
| `POST /api/v1/docs/transform` | `app/api/v1/docs/transform/route.ts:5` | Same fail-open runner path as analyze (`middleware.ts:32-52`; `runner.ts:84-110,177`) | Legacy operation LRO JSON; 202 + location, sync/replay 200 | `POST /api/v1/businesses/:businessId/actions/:action` is not the legacy multipart facade (`server.ts:1730-1763`) | HARDENING-MUST-NOT-REPLICATE | COMP-03 + COMP-04 |
| `POST /api/v1/docs/workflows` | `app/api/v1/docs/workflows/route.ts:15` | No route guard; caller-supplied form `apiKeyId` is looked up directly/hash-resolved (`:49-74`); missing value falls back to first ADMIN key (`:77-85`) | 202 JSON workflow operation + `Operation-Location` (`:99-115`) | ABSENT; canonical business action is not a process-to-business workflow mapping | HARDENING-MUST-NOT-REPLICATE | COMP-09; Product owns any scope decision |
| `POST /api/v1/docs/workflows/schema` | `app/api/v1/docs/workflows/schema/route.ts:15` | No route guard; caller-supplied form `apiKeyId` (`:59-74`); missing value falls back to first ADMIN key (`:76-78`) | 202 JSON workflow operation + `Operation-Location` (`:95-110`) | ABSENT; no schemaSlug-to-business adapter is mounted | HARDENING-MUST-NOT-REPLICATE | COMP-09; Product owns any scope decision |
| `GET /api/v1/operations` | `app/api/v1/operations/route.ts:29` | Optional `x-api-key-id` adds a filter only (`:35-38`); middleware strips it, so an ordinary request has no tenant/key filter | JSON `{operations,next_page_token}` page | `GET /api/v1/operations`; active server verifies raw key and tenant-fences the query (`server.ts:1776-1803`) | HARDENING-MUST-NOT-REPLICATE | COMP-06 |
| `GET /api/v1/operations/:id` | `app/api/v1/operations/[id]/route.ts:14` | Ownership comparison runs only if `x-api-key-id` is present (`:29-35`); middleware strips it, so missing header skips the check | JSON legacy operation LRO | `GET /api/v1/operations/:id`; active server resolves key and reads by tenant (`server.ts:1806-1840`) | HARDENING-MUST-NOT-REPLICATE | COMP-06 |
| `DELETE /api/v1/operations/:id` | `app/api/v1/operations/[id]/route.ts:40` | Same optional-ID check; absent header skips ownership check (`:54-60`) | 204 no-content soft-delete | ABSENT; active server has no DELETE operation route | HARDENING-MUST-NOT-REPLICATE | COMP-07 |
| `POST /api/v1/operations/:id/cancel` | `app/api/v1/operations/[id]/cancel/route.ts:10` | Same optional-ID check; absent header skips ownership check (`:24-30`) | JSON legacy operation LRO | `POST /api/v1/operations/:id/cancel`; active server resolves key and tenant-scopes cancellation (`server.ts:2087-2094`) | HARDENING-MUST-NOT-REPLICATE | COMP-07 |
| `GET /api/v1/operations/:id/download` | `app/api/v1/operations/[id]/download/route.ts:15` | Same optional-ID check; absent header skips ownership check (`:29-35`) | Binary attachment on success; JSON error envelope otherwise | ABSENT; `GET /api/v1/artifacts/:artifactId/download` is artifact-ID based, not operation-ID compatibility (`server.ts:2003-2011`) | HARDENING-MUST-NOT-REPLICATE | COMP-07 |
| `POST /api/v1/operations/:id/resume` | `app/api/v1/operations/[id]/resume/route.ts:20` | No session, API-key, or ownership guard in handler | JSON `{success,message}` acknowledgement | `POST /api/v1/operations/:id/resume`; active server resolves key, tenant-fences, and uses CAS (`server.ts:2097-2104`) | HARDENING-MUST-NOT-REPLICATE | COMP-07 |
| `GET /api/v1/services` | `app/api/v1/services/route.ts:8` | Reads only `x-api-key-id` (`:10-13`); middleware strips it, normally 401; no raw-key validation | JSON service/endpoint catalog | ABSENT; no rework service catalog equivalent | HARDENING-MUST-NOT-REPLICATE | COMP-08 |

### Internal legacy routes

| Legacy method + path | Legacy handler | Legacy auth actually applied | Legacy response shape class | Rework counterpart by behavior | Classification | Owner |
|---|---|---|---|---|---|---|
| `GET /api/internal/analytics` | `app/api/internal/analytics/route.ts:11` | Session plus `canMutate` (ADMIN or USER, `:12-15`); aggregate queries are global, with no tenant predicate | JSON dashboard totals, time series, profile/pipeline breakdown | ABSENT; usage projections and audit log are different data/products | HARDENING-MUST-NOT-REPLICATE | Product (keep/scope decision); ORCH-PAR-07 if retained |
| `GET /api/internal/apikeys` | `app/api/internal/apikeys/route.ts:12` | `requireAuth`; list is assigned-profile keys for USER and all for ADMIN (`:13-30`) | JSON key/profile rows; no raw key | `GET /api/v1/admin/api-keys[/:keyId]` is a partial admin list/detail, not the legacy user-assignment view (`server.ts:2558-2610`) | PARITY-NEEDED | ORCH-PAR-01 |
| `PUT /api/internal/apikeys` | `app/api/internal/apikeys/route.ts:38` | `requireAdmin` (`:39`); rotates existing key and returns copy-once raw key | JSON rotation/copy-once key result | ABSENT; active admin dispatcher has issue/revoke, no rotate action (`server.ts:2351-2393`; `dispatcher.ts:540,619`) | PARITY-NEEDED | ORCH-PAR-01 |
| `POST /api/internal/apikeys` | `app/api/internal/apikeys/route.ts:70` | `requireAdmin` (`:71`) | JSON new key with copy-once raw secret | `POST /api/v1/admin/actions` with `action=apikey.issue` (`server.ts:2351-2393`; `dispatcher.ts:540`) | PARITY-NEEDED | ORCH-PAR-01 |
| `DELETE /api/internal/apikeys` | `app/api/internal/apikeys/route.ts:104` | `requireAdmin` (`:105`) | JSON delete result | `POST /api/v1/admin/actions` with `action=apikey.revoke` (`server.ts:2351-2393`; `dispatcher.ts:619`) | PARITY-NEEDED | ORCH-PAR-01 |
| `GET /api/internal/auth-key` | `app/api/internal/auth-key/route.ts:11` | No session guard; validates raw `x-api-key`; rate-limit bucket uses the first 16 characters of caller-supplied key (`:12-18`) | JSON `{valid,apiKeyId}` or error | ABSENT as a standalone endpoint; active protected routes validate full-key SHA-256 and ACTIVE status (`server.ts:4182-4198`) | HARDENING-MUST-NOT-REPLICATE | ORCH-PAR-01 |
| `GET /api/internal/dev-sync-endpoints` | `app/api/internal/dev-sync-endpoints/route.ts:7` | `requireAdmin` (`:8-9`) | JSON sync result; GET deletes/rebuilds profile endpoints (`:13-35`) | ABSENT; no destructive GET equivalent | HARDENING-MUST-NOT-REPLICATE | Product (retention decision); ORCH-PAR-08 if retained |
| `GET /api/internal/ext-connections` | `app/api/internal/ext-connections/route.ts:17` | `requireAuth` only (`:18`), no admin/tenant fence; lists global connections (secrets masked, `:22-30`) | JSON connection/config collection | ABSENT; connector revision/credential routes do not list these connection configs | HARDENING-MUST-NOT-REPLICATE | ORCH-PAR-03 |
| `POST /api/internal/ext-connections` | `app/api/internal/ext-connections/route.ts:38` | `requireAdmin` (`:39`) | 201 JSON created connection with secret masked | ABSENT; rework credential rotation does not create connector config | PARITY-NEEDED | ORCH-PAR-03 |
| `PUT /api/internal/ext-connections/:id` | `app/api/internal/ext-connections/[id]/route.ts:16` | `requireAdmin` (`:20-21`) | JSON updated connection with secret masked | ABSENT; credential endpoint changes secrets, not connection config/revision | PARITY-NEEDED | ORCH-PAR-03 |
| `DELETE /api/internal/ext-connections/:id` | `app/api/internal/ext-connections/[id]/route.ts:93` | `requireAdmin` (`:97`) | JSON deletion acknowledgement | ABSENT; no equivalent connection retirement route | PARITY-NEEDED | ORCH-PAR-03 |
| `POST /api/internal/ext-connections/:id/test` | `app/api/internal/ext-connections/[id]/test/route.ts:11` | No handler guard; `/api/internal/**` is middleware-bypassed. Invokes configured connector using caller-controlled test input | JSON preview/mapped content/errors | `GET /api/v1/connectors/:id/test` exists but is health/readiness only (`server.ts:1354-1364`), not an invocation/preview proxy | HARDENING-MUST-NOT-REPLICATE | ORCH-PAR-03 |
| `GET /api/internal/ext-overrides` | `app/api/internal/ext-overrides/route.ts:19` | ADMIN can list all; USER must select `apiKeyId` and pass `requireProfileAccess` (`:23-39`) | JSON override collection | ABSENT; `POST /api/v1/admin/profile-bindings` binds connector revisions, not legacy prompt overrides (`server.ts:2200-2275`) | PARITY-NEEDED | ORCH-PAR-02 |
| `POST /api/internal/ext-overrides` | `app/api/internal/ext-overrides/route.ts:59` | Body `apiKeyId` is checked with `requireProfileAccess` before enabled-profile/connection checks (`:61-82`) | JSON upsert or delete acknowledgement | ABSENT; profile-binding action is a different resource/operation | PARITY-NEEDED | ORCH-PAR-02 |
| `DELETE /api/internal/ext-overrides` | `app/api/internal/ext-overrides/route.ts:134` | Body `apiKeyId` is checked with `requireProfileAccess` (`:136-148`) | JSON delete acknowledgement | ABSENT; no equivalent per-profile override deletion | PARITY-NEEDED | ORCH-PAR-02 |
| `GET /api/internal/profile-endpoints` | `app/api/internal/profile-endpoints/route.ts:19` | Requires query `apiKeyId`, then `requireProfileAccess` (`:21-28`) | JSON endpoint policy/config plus connection/override data | ABSENT; admin profile manifest read is not the mutable per-key endpoint configuration | PARITY-NEEDED | ORCH-PAR-02 |
| `POST /api/internal/profile-endpoints` | `app/api/internal/profile-endpoints/route.ts:110` | Body `apiKeyId` is checked with `requireProfileAccess` (`:113-123`); USER mutation is restricted to enabled endpoint/allowed fields (`:135-147`) | JSON updated profile-endpoint record | ABSENT; no endpoint-policy upsert in active rework routes | PARITY-NEEDED | ORCH-PAR-02 |
| `POST /api/internal/prompt-wizard` | `app/api/internal/prompt-wizard/route.ts:16` | `requireAuth` only (`:17-18`) | JSON upgraded prompt text | ABSENT; no prompt-wizard route in orchestrator | RETIRE-OR-KEEP-decision | Product (ORCH-PAR-00); ORCH-PAR-06 if retained |
| `POST /api/internal/recover-stalled` | `app/api/internal/recover-stalled/route.ts:24` | Checks `INTERNAL_API_SECRET` only when configured (`:27-31`); unset secret means no auth check | JSON recovered operation list/count | ABSENT; deadline sweep does not recover stalled queue work (`server.ts:2314-2349`) | HARDENING-MUST-NOT-REPLICATE | ORCH-PAR-08; Product owns retention/scope |
| `GET /api/internal/recover-stalled` | `app/api/internal/recover-stalled/route.ts:73` | No auth guard | JSON stale-count/threshold | ABSENT; no equivalent unguarded recovery probe | HARDENING-MUST-NOT-REPLICATE | ORCH-PAR-08; Product owns retention/scope |
| `POST /api/internal/test-profile-endpoint` | `app/api/internal/test-profile-endpoint/route.ts:13` | Form `__apiKeyId` is a selector, then `requireProfileAccess` checks it (`:19-31`); internally injects header for runner (`:57-81`) | Runner LRO JSON, dynamic 200/202 | ABSENT; connector health check does not execute a profile-configured request | RETIRE-OR-KEEP-decision | Product (ORCH-PAR-00); ORCH-PAR-02/03 if retained |
| `GET /api/internal/user-profiles` | `app/api/internal/user-profiles/route.ts:10` | `requireAdmin` (`:11`) | JSON user-to-key assignment list | ABSENT; profile-binding is key-to-connector/profile, not user-to-key | RETIRE-OR-KEEP-decision | Product (ORCH-PAR-00); ORCH-PAR-05 if retained |
| `POST /api/internal/user-profiles` | `app/api/internal/user-profiles/route.ts:34` | `requireAdmin` (`:35`) | JSON assignment replacement acknowledgement | ABSENT; no user↔API-key assignment route | RETIRE-OR-KEEP-decision | Product (ORCH-PAR-00); ORCH-PAR-05 if retained |
| `GET /api/internal/workflow-schemas` | `app/api/internal/workflow-schemas/route.ts:13` | `requireAdmin` (`:14`) | JSON one schema or schema catalog | ABSENT; no schema registry route in active server | RETIRE-OR-KEEP-decision | Product (ORCH-PAR-00); ORCH-PAR-04/COMP-09 if retained |
| `POST /api/internal/workflow-schemas` | `app/api/internal/workflow-schemas/route.ts:28` | `requireAdmin` (`:29`) | 201 JSON imported schema; accepts JSON/XML | ABSENT; no schema authoring/import route in active server | RETIRE-OR-KEEP-decision | Product (ORCH-PAR-00); ORCH-PAR-04/COMP-09 if retained |
| `DELETE /api/internal/workflow-schemas` | `app/api/internal/workflow-schemas/route.ts:57` | `requireAdmin` (`:58`) | JSON delete acknowledgement | ABSENT; no schema registry delete route | RETIRE-OR-KEEP-decision | Product (ORCH-PAR-00); ORCH-PAR-04/COMP-09 if retained |
| `PUT /api/internal/workflow-schemas/override` | `app/api/internal/workflow-schemas/override/route.ts:9` | `requireAdmin` (`:10-11`) | JSON updated schema/node override | ABSENT; no DSL/schema override route | RETIRE-OR-KEEP-decision | Product (ORCH-PAR-00); ORCH-PAR-04 if retained |
| `GET /api/internal/workflow-schemas/pipeline-mappings` | `app/api/internal/workflow-schemas/pipeline-mappings/route.ts:13` | `requireAuth` only (`:14-15`), no role/tenant fence; response includes connector configuration and `extraHeaders` (`:37-46,80-96`) | JSON pipeline-mapping/config list | ABSENT; no pipeline-mapping endpoint | HARDENING-MUST-NOT-REPLICATE | Product (scope/retention); ORCH-PAR-04 if retained |

### Security defects and semantic mismatches

- **Client identity is not proof.** The public operation handlers treat `x-api-key-id` as an optional filter/ownership check, but the middleware strips that header and these handlers skip the check when it is absent. This creates unfiltered operation listing and by-ID/lifecycle access rather than a secure API-key identity; do not preserve this fallback. The two public workflow handlers additionally accept form `apiKeyId` as a database selector and silently choose an ADMIN key when absent (`app/api/v1/docs/workflows/route.ts:49-85`; `app/api/v1/docs/workflows/schema/route.ts:59-78`).
- **Fail-open submission.** The six `/docs/*` wrappers reach a runner that logs invalid/missing raw keys but does not reject them. A rework adapter must require verified API-key identity; it must not copy legacy anonymous/default-profile execution (`lib/endpoints/runner.ts:84-110,177-178`).
- **Other explicit non-replication defects:** first-16-character caller-key rate-limit buckets (`app/api/internal/auth-key/route.ts:12-18`); unguarded external-connection test that invokes the provider (`app/api/internal/ext-connections/[id]/test/route.ts:11-20,164-177`); recovery POST fail-open when secret is unset and unguarded recovery GET (`app/api/internal/recover-stalled/route.ts:24-31,73-79`); destructive GET sync (`app/api/internal/dev-sync-endpoints/route.ts:7-35`); global analytics available to USER (`app/api/internal/analytics/route.ts:11-15`); and pipeline mappings available to any session while exposing connector headers (`app/api/internal/workflow-schemas/pipeline-mappings/route.ts:13-15,37-46,80-96`).
- **No false positives for profile selectors.** Internal profile/override/test handlers take client `apiKeyId` values but perform `requireProfileAccess` before using them; preserve that authorization, not just the selector input (`lib/auth-guard.ts:45-70`).
- **Counterparts are not assumed from similar names.** The active server verifies raw `x-api-key`, resolves an ACTIVE key to its tenant, and fails closed (`services/orchestrator/src/server.ts:4182-4198`). Same-path operation list/detail/cancel/resume counterparts therefore have actual tenant fencing unlike legacy. Conversely, rework `GET /api/v1/connectors/:id/test` is health/readiness only, and `GET /api/v1/artifacts/:id/download` uses artifact ID; neither implements the legacy provider-test or operation-download behavior.
- The server's canonical submit route is `POST /api/v1/businesses/:id/actions/:action` (`services/orchestrator/src/server.ts:1730-1763`). The compat router is not mounted by the active `server.ts`; do not count its source/test presence as an exposed `/api/v1/docs/*` route.

### Rework-only surfaces (not legacy route counterparts)

These active server surfaces are classified as `NEW-BUILD` relative to the inventoried legacy route files; names that resemble a legacy route are called out above only where handler semantics match.

| Rework method/path family | Handler evidence | Classification |
|---|---|---|
| `GET /health`, `GET /api/v1/health` | `services/orchestrator/src/server.ts:1206-1241` | NEW-BUILD |
| `GET /api/v1/usage/summary`, `/usage/events`, `/usage` | `server.ts:1255-1352`; tenant usage/event projections, not per-key billing | NEW-BUILD |
| `POST /api/runtime/v1/usage-events` | `server.ts:1243-1253` | NEW-BUILD |
| `POST /api/v1/uploads`; `PUT /api/v1/uploads/:id[/content]`; `POST /api/v1/uploads/:id/(part|complete|abort)` | `server.ts:1442-1497` | NEW-BUILD |
| `POST /api/runtime/v1/tasks/:id/artifacts`; `POST /api/runtime/v1/artifacts/:id/(finalize|access|multipart/*)`; `PUT|GET /api/runtime/v1/artifacts/blob/:id` | `server.ts:1367-1548` | NEW-BUILD |
| `POST /api/runtime/v1/tasks/:id/invocation-grants`; `PUT /api/runtime/v1/businesses/:id/versions/:version`; worker/task claim, heartbeat, step, progress, complete, fail, children, wait-input and workspace-reference routes | `server.ts:1500-1705` | NEW-BUILD |
| `GET /api/v1/operations/:id/result`; `GET /api/v1/artifacts/:id/download` | `server.ts:1917-2060`; not equivalent to legacy LRO projection/operation-ID download without a compat projection | NEW-BUILD |
| Admin business/version activation, profile-bindings, connector revision/credential, deadline sweep, crypto-config, audit and generic action control plane | `server.ts:2107-2745`; where a legacy feature overlaps, the rows above distinguish the actual resources | NEW-BUILD |

### Product decisions intentionally left open

No route was labeled `DEFER` or treated as decided retired. Every `RETIRE-OR-KEEP-decision` row names Product as decision owner (ORCH-PAR-00 inventory) and the likely ORCH-PAR lane only if kept. Billing balance ledger/scope and global/admin surfaces likewise remain Product/security decisions; this map does not tick or close any gate.

## COMP-01b — Legacy workflow wire characterization (2026-10-01)

Static source characterization only. No source, contract, test, plan, or gate was changed; no tests or live services were run. P9-01..05 and COMP-09 remain unticked.

### Three process workflows

All three use POST /api/v1/docs/workflows with multipart/form-data; the handler calls req.formData(). The process field is required, trimmed, and must exactly match a registry key: disbursement, lc-checker, or doc-compare (app/api/v1/docs/workflows/route.ts:19-28; lib/endpoints/registry.ts:372-403). Unknown process returns 404; missing/empty process returns 400. The workflow route's only document validation is “at least one normalized non-empty file” (route.ts:31-34). normalizeFiles recognizes files[] (repeatable), source_file, target_file, and file, in that order; zero-byte/non-File values are discarded (lib/endpoints/runner.ts:36-53).

| Process | Exact accepted request fields (required vs optional) | Successful initial response | Poll-visible workflow steps / behavior |
|---|---|---|---|
| disbursement | Required: process=disbursement and ≥1 normalized file. Optional: resolution_data form string (registry describes it as reference JSON; route copies a nonempty string without parsing/required validation, route.ts:36-45; registry.ts:379-387). Optional x-correlation-id header; absent value becomes a generated UUID (route.ts:16). Optional form apiKeyId is unsafe and flagged below. | 202 and relative Operation-Location: /api/v1/operations/{id}; common initial envelope below, metadata.workflow="disbursement" (route.ts:88-115). | Steps 0 classify files (ext-classifier), 1 OCR/extract (ext-data-extractor), then pauses for HITL; after resume, step 2 cross-check (ext-fact-verifier) and step 3 report (ext-content-gen) (lib/pipelines/workflows/disbursement.ts:93-154,157-207,210-259). |
| lc-checker | Required: process=lc-checker and ≥1 normalized file. No workflow-specific form parameters are registered (registry.ts:388-394). Optional x-correlation-id header; optional apiKeyId has the shared unsafe behavior. | 202 and relative Operation-Location; common initial envelope, metadata.workflow="lc-checker" (route.ts:88-115). | Steps 0 OCR each file (ext-doc-layout), 1 UCP 600/ISBP 821 compliance check (ext-fact-verifier), 2 report (ext-content-gen) (lib/pipelines/workflows/lc-checker.ts:68-125,128-165,168-209). No explicit HITL pause call exists in this workflow. |
| doc-compare | Required at HTTP boundary: process=doc-compare and ≥1 normalized file. Actual workflow requires ≥2: runDocCompare throws when fewer than two arrive (lib/pipelines/workflows/doc-compare.ts:46-56), so one-file requests are accepted with 202 then fail asynchronously. No upper-bound/exactly-two check exists: with >2 files all are OCRed, while only filesData[0] and [1] feed TOC/compare (doc-compare.ts:48-56,84-110,141-180). No workflow-specific form parameters are registered (registry.ts:395-401). Optional x-correlation-id; shared unsafe apiKeyId. | 202 and relative Operation-Location; common initial envelope, metadata.workflow="doc-compare" (route.ts:88-115). | Steps 0 OCR (ext-doc-layout), 1 TOC extraction (ext-doc-compare), 2 section comparison (ext-doc-compare), 3 report (ext-content-gen) (lib/pipelines/workflows/doc-compare.ts:84-133,136-161,164-193,196-224). No explicit HITL pause call exists. |

For the three process requests, form apiKeyId is optional but is not authentication: the handler looks up a caller-provided database ID or raw-key hash, and if absent chooses the oldest ADMIN key (app/api/v1/docs/workflows/route.ts:49-85). The route has no auth guard; /api/v1/** middleware passes through rather than authenticating (middleware.ts:32-52). The endpoint does not read/forward x-api-key, webhook_url/README's webhookUrl, or idempotency-key. Caller-supplied identity and the oldest-ADMIN-key fallback are HARDENING-MUST-NOT-REPLICATE; do not carry either into COMP-09/P9.

On successful submitPipelineJob, all three take the same unconditional 202 branch (the code does not choose status based on process or eventual completion):

~~~json
{
  "name": "operations/{id}",
  "done": false,
  "metadata": {
    "state": "RUNNING",
    "workflow": "{process}",
    "progress_percent": 0,
    "progress_message": "Initializing workflow..."
  }
}
~~~

The header is Operation-Location: /api/v1/operations/{id}. Errors before successful enqueue remain 400/404/etc.; 202 is accepted work, not a guarantee of eventual success (route.ts:22-34,88-115).

### Schema workflow (schemaSlug)

The legacy route is POST /api/v1/docs/workflows/schema, multipart form. schemaSlug is required and trimmed; the route applies no slug-format regex. It loads the exact appSettings key wb_schema:<slug> (app/api/v1/docs/workflows/schema/route.ts:18-28; lib/workflow-builder/loader.ts:10,20-32). A valid submission requires a found, JSON-decodable schema whose validateSchema result has no errors (schema/route.ts:30-34; lib/workflow-builder/interpreter.ts:35-75).

- Optional input is a JSON string; malformed JSON returns 400. The route treats it as an object but does not validate its shape against an input schema (schema/route.ts:39-48).
- Optional files use the same files[], source_file, target_file, file normalization; fileless schemas are accepted (schema/route.ts:36-38). Optional form apiKeyId and x-correlation-id are also read.
- Missing/blank schemaSlug returns 400. An unknown slug, unreadable stored JSON, or absent setting returns a 404 JSON error envelope {type,title,status,detail}; a loaded but structurally invalid schema returns 400 with validation details (schema/route.ts:19-34; lib/endpoints/runner.ts:18-27).
- A valid slug and successful submit return 202 + Operation-Location: /api/v1/operations/{id}. Initial body has name, done:false, and metadata {state:"RUNNING", workflow:<schemaSlug>, progress_percent:0, progress_message:"Initializing schema workflow..."} (schema/route.ts:81-109).
- apiKeyId MUST NOT be copied as auth. The route trusts a form-supplied ID/raw key at :59-74, performs no session/API-key guard, then falls back to the oldest ADMIN key when absent (:76-79). This is HARDENING-MUST-NOT-REPLICATE; a caller must not acquire another profile or an ADMIN identity by submitting a field.
- Additional selector-integrity issue: pipeline variables are built as {schemaSlug, ...input} (schema/route.ts:50-56), so input.schemaSlug can overwrite the requested slug. The worker dispatches schema execution from ctx.pipelineVars.schemaSlug (lib/pipelines/workflow-engine.ts:439-449). Do not reproduce this override; bind execution to the validated registration/slug.

The active rework has no mounted POST /api/v1/docs/workflows/schema route. document-core/src/pipelines/legacy-workflow-mapping.ts:171-238 contains a helper that could resolve a schemaSlug only against a supplied unique active-registration list, but resolveLegacySchemaSlug has no active server mount/registration path; it is not wire parity. Schema authoring/execution belongs to P9-04/P9-05 and COMP-09, not an invented action alias.

### Rework mapping attempts — no inferred aliases

| Legacy process | Rework business/action verdict | Owner |
|---|---|---|
| disbursement | ABSENT. No matching business/action or active route was found. P9-01 lists a separate business packet; generic document-core actions are not this multistage classify/extract/HITL/cross-check/report flow. | COMP-09 + P9-01 |
| lc-checker | ABSENT. No matching LC business/action. A core analyze:compliance recipe is not the legacy LC workflow with per-document OCR, UCP/ISBP checking over OCR plus original PDFs, and report generation. | COMP-09 + P9-02 |
| doc-compare | ABSENT. No matching advanced workflow business/action. Core compare is not the four-step OCR→TOC→section compare→report flow; P9-03 explicitly distinguishes advanced doc-compare from core compare. | COMP-09 + P9-03 |

document-core/src/pipelines/legacy-workflow-mapping.ts:4,56-88 recognizes only simple-extraction, multi-step-analysis, and transform-compare; it does not register any of the three process strings above. It maps those different names to core recipes, but does not mount a route or implement these workflows. The active orchestrator server has only the generic business/action submit primitive (services/orchestrator/src/server.ts:1730-1763), not a workflow facade. The COMP plan explicitly says these workflows are in P9-01..05 and must not be aliased to one of the six core actions (du-rework/tasks/API-COMPAT-DUGATE-2026-09-28.md:18). P9 remains TODO and names separate business owners/acceptance (du-rework/tasks/P9-business-backlog.md:3,18-22).

### Poll, checkpoint, and HITL wire observed by clients

GET /api/v1/operations/{id} returns HTTP 200 with formatOperationResponse (app/api/v1/operations/[id]/route.ts:14-37; lib/pipelines/format.ts:17-72). The common running poll is:

~~~json
{
  "name": "operations/{id}",
  "done": false,
  "metadata": {
    "state": "RUNNING",
    "pipeline": ["ext-classifier"],
    "current_step": 0,
    "progress_percent": 0,
    "progress_message": "...",
    "create_time": "...",
    "update_time": "...",
    "pipeline_steps": []
  }
}
~~~

The initial pipeline is the placeholder submitted to satisfy submitPipelineJob, not the actual workflow graph (workflows/route.ts:43-48; schema route uses ext-classifier at schema/route.ts:50-56). Polls can and do expose done:false mid-run: parent operation starts RUNNING/done:false (lib/pipelines/submit.ts:300-315); updateProgress persists progress/message and stepsResultJson while the child step runs (workflow-engine.ts:206-214). metadata.pipeline_steps contains completed steps and is updated after step boundaries; it can be empty or show only earlier steps while a child job is still running. The first poll reads the DB message “Initializing pipeline...” (submit.ts:313), which differs from the initial 202 body’s “Initializing workflow...”. metadata.current_step is a DB checkpoint, not a live counter: ordinary updateProgress does not update it, so it stays at initial 0 until pause or success; failWorkflow does not advance it (workflow-engine.ts:206-214,217-231,255-266,274-289; default lib/db/schema.ts:21).

| Workflow | Step objects surfaced under metadata.pipeline_steps as execution progresses | Pause/resume visible on the legacy wire |
|---|---|---|
| disbursement | Step 0 carries classify stepName/processor/content_preview/extracted_data/sub_results; each sub-result includes document label/status, child operation ID, content/extracted data/logical docs. Step 1 carries extraction extracted_data and per-file sub_results (disbursement.ts:131-153,192-203). Later step 2 has cross-check result/child ID; step 3 has report content preview (:223-254). | After step 1, client polls state=WAITING_USER_INPUT, done:false, checkpoint current_step:2, message requesting OCR review, with steps 0 and 1 visible (disbursement.ts:204-207; workflow-engine.ts:246-271). Legacy POST /api/v1/operations/{id}/resume consumes JSON; {step,extracted_data} edits a matching saved step, marks is_human_edited, returns operation to RUNNING and re-enqueues. Step 1's edited extracted data is restored and execution continues at step 2 (app/api/v1/operations/[id]/resume/route.ts:20-98; disbursement.ts:61-90,211-259). |
| lc-checker | Step 0 has OCR summary, ocr_texts, and per-file sub_results; step 1 contains compliance extracted_data; step 2 has report preview (lc-checker.ts:104-122,157-164,197-204). | No explicit pauseWorkflow/HITL branch; remains RUNNING with progress polls until SUCCEEDED/FAILED. |
| doc-compare | Step 0 has OCR summary, ocr_texts, and per-file sub_results; step 1 has the two TOCs; step 2 has section-comparison result; step 3 has report preview (doc-compare.ts:112-130,153-160,185-192,212-219). | No explicit pauseWorkflow/HITL branch; remains RUNNING with progress polls until SUCCEEDED/FAILED. |

On success, the poll adds result with output_format, content, extracted_data, pipeline_steps, usage, and download_url; on failure it adds error:{code,message,failed_step} and, when steps exist, partial step/usage result (lib/pipelines/format.ts:35-69). completeWorkflow sets done:true/state:SUCCEEDED; failWorkflow sets done:true/state:FAILED (workflow-engine.ts:217-231,274-292). Schema workflows can also pause when a DSL contains a human node; this uses WAITING_USER_INPUT and stores _nodeResults with stepsResult for resume (lib/workflow-builder/run-schema.ts:31-55; workflow-engine.ts:246-266,376-389). When the saved _nodeResults object is nonempty, the formatter exposes the stored wrapper object under metadata.pipeline_steps, not a projected plain step array (format.ts:31).

The legacy resume route itself has no auth/tenant guard; the prior route map marks it HARDENING-MUST-NOT-REPLICATE. This characterization records the observable resume body/state only and does not endorse copying that access behavior. No COMP-01/COMP-09 or P9 gate was ticked.

## COMP-01c — Operation list + lifecycle response-shape matrix (2026-10-01)

Read-only characterization of the operation list/detail/lifecycle wire surfaces. Success JSON below uses the handler's exact casing and nesting; JSON responses have the framework's `application/json` content type unless noted. No source, contract, COMP row, or gate was changed.

### Response matrix

| Surface | Legacy response | Rework response |
|---|---|---|
| List `GET /api/v1/operations` | `200 {operations:[...] , next_page_token:<operation-id|null>}`. Each item is `{name,done,metadata:{state,endpoint_slug,current_step,progress_percent,progress_message,create_time,update_time}}`; completed `FAILED` adds `error:{code,message,failed_step}`, and completed `SUCCEEDED` adds `result:{usage:{input_tokens,output_tokens,cost_usd}}`. Invalid state filter is `400 {error}`. (app/api/v1/operations/route.ts:29-55,96-130) | API-key path `200 {items:[...],nextCursor,prevCursor,total,limit}`. Each item is projected as `{id,name,businessId,businessVersion,action,state,stateVersion,createdAt,updatedAt,deadlineAt,progress:{percent,message},links:{self,result}}`; it has no legacy `done`, `metadata`, inline result/error, `endpoint_slug`, or `next_page_token`. Actual `toOperationView` omits `tenantId` although `OperationViewSchema` requires it; the admin-bearer list variant uses `toOperationDetailWire` and adds `tenantId`. (services/orchestrator/src/server.ts:1766-1803,4101-4109; modules/operations/facade.ts:32-51; packages/contracts/src/operations.ts:129-147) |
| Detail `GET /api/v1/operations/{id}` | `200` `formatOperationResponse`: `{name,done,metadata:{state,pipeline,current_step,progress_percent,progress_message,create_time,update_time,pipeline_steps}}`; completed success adds `result:{output_format,content,extracted_data,pipeline_steps,usage:{input_tokens,output_tokens,pages_processed,model_used,cost_usd,breakdown},download_url}`, completed failure adds `error:{code,message,failed_step}` and, when step JSON exists, partial `result:{pipeline_steps,usage:{input_tokens,output_tokens,cost_usd,breakdown}}`. Missing/deleted is `404 {type,title,status,detail,requested_id}`; key-id mismatch is `403 {type,title,status,detail}`. (app/api/v1/operations/[id]/route.ts:14-37; lib/pipelines/format.ts:17-70) | API-key path `200` returns the same `OperationView` projection as each list item (no `done`, `metadata`, inline output/result/error); optional `?wait=` still returns that view after polling. Admin-bearer alternate path returns `{operation,result,artifacts,serverNow}`. Rework errors are `application/problem+json` with `type,title,status,code` and optional `detail,correlationId,errors`; all responses receive `x-correlation-id`. (services/orchestrator/src/server.ts:716-720,811-831,1806-1841,4111-4179; services/orchestrator/src/http/errors.ts:19-24; packages/contracts/src/errors.ts:82-99) |
| Result `GET /api/v1/operations/{id}/result` | **No legacy route/handler.** Legacy success result is nested in the detail response above; a direct request has no app-defined response body. (legacy route inventory: app/api/v1/operations/[id]/route.ts:14-40; no sibling `result/route.ts`) | `200` on `SUCCEEDED`: `{schemaVersion:'1',data:{resultRef}|{},artifacts:[{artifactId,role,mimeType?,sizeBytes?,hashSha256?,download}],usage:{inputTokens,outputTokens,costMicrousd,measurement},warnings:[]}`. Tenant encryption can instead return `{schemaVersion:'1',encrypted:true,delivery}`. `TIMED_OUT` gives `410`; other non-success states give `409`; missing/foreign operation gives `404`. Success is JSON; thrown errors are `application/problem+json`. The contract names these `ResultEnvelope` / `EncryptedResultEnvelope`. (services/orchestrator/src/server.ts:1917-2000; modules/usage/usage.ts:357-377; packages/contracts/src/operations.ts:160-196; services/orchestrator/src/http/errors.ts:19-24) |
| Cancel `POST /api/v1/operations/{id}/cancel` | Successful cancellation is `200` with the full formatted detail envelope; it sets `done:true,state:CANCELLED`, so the formatter includes neither success result nor failure error. Errors: `404 {type,title,status}`, `403 {type,title,status,detail}`, or `409 {type,title,status,detail}` when `done` was already true. (app/api/v1/operations/[id]/cancel/route.ts:10-45; lib/pipelines/format.ts:17-70) | First request is `202`, replay is `200`; body `{operationId,state,replayed}`. A first accepted cancellation returns `state:'CANCELLED'`; replay returns the existing terminal state. Missing/foreign operation is `404`; lifecycle conflicts/errors serialize as Problem Details. (services/orchestrator/src/server.ts:2087-2094; modules/lifecycle/lifecycle.ts:13-20,27-68) |
| Resume `POST /api/v1/operations/{id}/resume` | `200 {success:true,message:'Resumed successfully'}`; `404 {error:'Operation not found'}`; non-paused state is `400 {error}`; caught failures are `500 {error}`. Success body carries no state or operation id. (app/api/v1/operations/[id]/resume/route.ts:20-33,83-102) | First resume is `202`, replay is `200`; body `{operationId,state,stateVersion,replayed,taskId}`. A new resume advances to `QUEUED`; a replay returns the operation's current state. Missing/foreign wait or operation is `404`; stale version/state conflict is `409`; invalid schema/input is `422`, all as Problem Details. (services/orchestrator/src/server.ts:2097-2104; modules/runtime/runtime.ts:1000-1017,1022-1067,1078-1137) |
| Download `GET /api/v1/operations/{id}/download` | `200` raw `outputContent` or streamed `outputFilePath` bytes, not JSON. Explicit headers: format-derived `Content-Type` with UTF-8 and `Content-Disposition: attachment; filename=...`; local-file path adds `Content-Length`, S3 adds it when metadata has a size. Errors are 404 missing/file/no-output, 403 key-id mismatch, and 409 unless `done && state==='SUCCEEDED'`. (app/api/v1/operations/[id]/download/route.ts:15-42,44-57,60-118) | **No operation-id download handler.** A legacy client requesting this exact path falls through to `404 {type:'urn:du:error:not_found',title:'not found',status:404,code:'NOT_FOUND'}`; the server's default response content type is `application/json` plus `x-correlation-id`. The distinct `GET /api/v1/artifacts/{artifactId}/download` returns raw bytes with only the artifact MIME `Content-Type` (no attachment disposition), or `200 {schemaVersion:'1',encrypted:true,delivery,artifactId,mimeType}` when encryption is enabled; its missing/not-ready responses are 404/409 Problem Details. A legacy operation-id URL is not translated to an artifact-id URL. (services/orchestrator/src/server.ts:716-720,2003-2011,2033-2084,2746; packages/contracts/src/operations.ts:201-230) |

**Additional legacy DELETE:** `DELETE /api/v1/operations/{id}` soft-deletes and returns `204` with an empty body; missing/deleted is `404 {type,title,status}`, key-id mismatch is `403 {type,title,status,detail}`. No rework DELETE route exists; unmatched paths use the server's generic 404 body above. (app/api/v1/operations/[id]/route.ts:40-64; services/orchestrator/src/server.ts:2746)

### Pagination dialect

Legacy list accepts `page_size` (default 20, capped at 100), `page_token`, and `filter`, not a page number or named `cursor`. `page_token` is a plain operation ID; it is looked up for `createdAt`, then rows strictly older than that timestamp are returned. `next_page_token` is the last returned item's operation ID when there is another page, otherwise `null`; order is `createdAt DESC` only, with no ID tiebreak. (app/api/v1/operations/route.ts:29-33,58-64,91-99,127-130)

Rework public operations list reads `limit,cursor,state,tenant,id,sort` and returns `nextCursor` and `prevCursor` as well as count `total` and `limit`. Its local operations cursor is base64url of `<canonical timestamp>|<uuid>|<field:direction>[|p]`; it binds the sort key and UUID, with `p` marking the backward walk. The **admin 4-slot codec does not serve the public operations list**: `AdminResourceListSortCursor` is always `base36-microseconds|encoded-id|sort-code|n-or-p` before base64url encoding, and is consumed by admin audit and mutable admin-resource lists. Public operations uses its own `encodeOperationsListCursor` / decoder and grammar. (services/orchestrator/src/server.ts:1771-1803,2959-3000,3382-3414; packages/contracts/src/public-api.ts:347-352,409-455; services/orchestrator/src/server.ts:2719-2743,3511-3523,3723-3735,3983-4029)

### State map

Known legacy writer states are `RUNNING` and `WAITING_USER_INPUT` (non-terminal), `SUCCEEDED` and `FAILED` (terminal), plus `CANCELLED` from the cancel handler. List/detail serialize the stored state verbatim; the operations DB column is plain `text`, so this writer inventory is not a database-enforced enum. `PENDING` is accepted as a legacy list filter but no checked operation writer sets it. (app/api/v1/operations/route.ts:40-50,101-112; lib/db/schema.ts:10-42; lib/pipelines/submit.ts:300-315; lib/pipelines/workflow-engine.ts:217-220,246-257,275-281; lib/pipelines/engine.ts:132-133,400-401,455-456)

Rework contract states are non-terminal `PENDING_INGESTION`, `ACCEPTED`, `QUEUED`, `RUNNING`, `WAITING_CHILDREN`, `WAITING_INPUT`, `RETRY_PENDING`, `CANCEL_REQUESTED`; terminal `SUCCEEDED`, `FAILED`, `CANCELLED`, `TIMED_OUT`. (packages/contracts/src/operations.ts:11-37,73-94)

| Route | Legacy state visible / gate | Rework state visible / gate |
|---|---|---|
| List and detail | Emit stored state, from known legacy set above; detail's `done` is separate from state. | Emit any contract operation state via `OperationView.state`; no legacy `done` boolean. |
| Result | No separate route; detail nests success result only for `done && SUCCEEDED`, failure fields only for `done && FAILED`. | `SUCCEEDED`→200 envelope; `TIMED_OUT`→410; every other state→409. (services/orchestrator/src/modules/operations/facade.ts:87-99; services/orchestrator/src/server.ts:1929-1937) |
| Cancel | Non-done row is rewritten to `CANCELLED` and returned as terminal/done; already-done row gets 409. | New cancel returns `CANCELLED`; replay returns one of the already-terminal states `SUCCEEDED/FAILED/CANCELLED/TIMED_OUT`. |
| Resume | Only accepts `WAITING_USER_INPUT`, writes `RUNNING`; success response does not include that state. | New resume writes/returns `QUEUED`; replay returns current non-terminal state. |
| Download | Serves bytes only when `done && SUCCEEDED`; otherwise 409. | Operation-ID download route absent; artifact route is admitted only for artifacts belonging to a `SUCCEEDED` operation and `READY` artifact. |

State names present on only one side: legacy-only `WAITING_USER_INPUT`; rework-only `PENDING_INGESTION`, `ACCEPTED`, `QUEUED`, `WAITING_CHILDREN`, `WAITING_INPUT`, `RETRY_PENDING`, `CANCEL_REQUESTED`, `TIMED_OUT`. Shared names are `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELLED`. `WAITING_INPUT` and `WAITING_USER_INPUT` are distinct wire values; this report makes no mapping decision.

**MUST-NOT-REPLICATE — premature terminal cancellation:** legacy cancel writes `done:true,state:CANCELLED` directly without stopping/confirming the worker (`app/api/v1/operations/[id]/cancel/route.ts:39-45`). Rework lifecycle also writes operation and task `CANCELLED` synchronously (`services/orchestrator/src/modules/lifecycle/lifecycle.ts:42-50,64-68`), while a running leased worker can observe the cancel signal later by heartbeat (`services/orchestrator/src/modules/runtime/runtime.ts:357-384`). These paths can publish terminal `CANCELLED` while execution may still be in flight; this is recorded as MUST-NOT-REPLICATE, not as a recommended lifecycle behavior.

This is characterization only; no response-shape, state, adapter, COMP-row, or gate change is proposed or made. The separate golden-fixture assertion spec is not duplicated here.
