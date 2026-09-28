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