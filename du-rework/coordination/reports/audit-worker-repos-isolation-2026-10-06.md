# AUDIT-WORKER-REPOS-ISOLATION — worker dependency/import audit

Task: `task_9dd8faa07a14` (ctx_6ce51451ad04). Date: 2026-10-06. Mode: **read-only** — no source/test edit, no commit.
Scope: every declared and actual reference to `@du/contracts`, `@du/document-kit`, `@du/worker-sdk` inside
`businesses/document-core`, `businesses/lc-checker`, `businesses/example-review`, to prepare worker-repo isolation.

Method: (1) declared layer = `package.json` dependencies; (2) actual layer = all ESM/CJS statements in
`.ts/.tsx/.mts/.cts/.js/.cjs/.mjs` (multi-line imports, type-only imports, aliases, `require`, dynamic
`import()`, `import()` type positions, `jest.requireActual`); (3) config/build layer = tsconfig paths, jest
`moduleNameMapper`, Dockerfile, build scripts, and textual (non-import) references. Identifier `refs` counts
uses of the local symbol in the same file excluding the import statement itself. Extractor: `extract_imports.py`
(raw evidence `imports-full.txt`, `audit-raw.json`, per-symbol detail `audit-summary.md`).

## 1. Headline

| worker | declared deps | actually imported in src | verdict |
|---|---|---|---|
| document-core | contracts, document-kit, worker-sdk | all three | full consumer |
| lc-checker | contracts, document-kit, worker-sdk | contracts + worker-sdk only | **`@du/document-kit` declared but never imported** |
| example-review | contracts, document-kit, worker-sdk | all three | full consumer |

- Every package specifier is bare `@du/<pkg>`; the only subpath occurrence is a negative test
  (`@du/contracts/private/internal`, package-boundary suites) — no real subpath coupling.
- All three workers import platform services only in **tests/integration**, never in `src`:
  `@du/orchestrator` (example-review ×3 integration tests, document-core multi-container) and
  `@du/connector` (document-core p8-03 + multi-container). They are resolved via jest/tsconfig paths,
  not declared in `package.json`.
- `document-core/template/vendor/` holds an untracked vendored copy of contracts/document-kit/worker-sdk
  sources (13 files) referenced by no code today — candidate isolation seed or cleanup item.

## 2. Declared vs actual matrix

| worker | package | package.json | src import sites | test import sites | unique src files | refs (src+test) | status |
|---|---|---|---|---|---|---|---|
| document-core | `@du/contracts` | yes | 30 | 50 | 10 | 135 | USED |
| document-core | `@du/document-kit` | yes | 14 | 15 | 6 | 50 | USED |
| document-core | `@du/worker-sdk` | yes | 21 | 36 | 7 | 135 | USED |
| lc-checker | `@du/contracts` | yes | 7 | 0 | 3 | 10 | USED |
| lc-checker | `@du/document-kit` | yes | 0 | 0 | 0 | 0 | **UNUSED (declared only)** |
| lc-checker | `@du/worker-sdk` | yes | 13 | 3 | 3 | 38 | USED |
| example-review | `@du/contracts` | yes | 5 | 13 | 3 | 30 | USED |
| example-review | `@du/document-kit` | yes | 4 | 2 | 1 | 7 | USED |
| example-review | `@du/worker-sdk` | yes | 14 | 22 | 3 | 92 | USED |

> `src import sites` counts individual imported symbols, not statements; one multiline statement can carry many symbols.

## 3. Caller-symbol detail

> Rows named `(namespace)` are raw dynamic-`import()` occurrences; when the expression selects a
> member (`import('@du/contracts').X`) that member is attributed on its own symbol row where extractable.

### 3.1 document-core

#### `@du/contracts`

| src symbol | alias | type-only sites | refs | src site(s) |
|---|---|---|---|---|
| `CONNECTOR_ARTIFACT_MAX_BYTES` |  | 0/2 | 2 | document-core/src/actions/ingest/index.ts:12; document-core/src/worker.ts:13 |
| `InvocationArtifactContent` |  | 3/4 | 4 | document-core/src/actions/ingest/index.ts:12; document-core/src/worker.ts:13; document-core/src/worker.ts:399; document-core/src/worker.ts:437 |
| `PinnedProfilePolicy` |  | 5/5 | 5 | document-core/src/actions/prompt-application.ts:2; document-core/src/actions/prompt-precedence.ts:1; document-core/src/actions/session-seam.ts:1; document-core/src/types/context.ts:1; document-core/src/worker.ts:13 |
| `PinnedPromptOverride` |  | 3/3 | 3 | document-core/src/actions/prompt-application.ts:2; document-core/src/types/context.ts:1; document-core/src/worker.ts:13 |
| `PROMPT_OVERRIDE_PRECEDENCE` |  | 0/1 | 3 | document-core/src/actions/prompt-precedence.ts:1 |
| `PromptOverrideRead` |  | 1/1 | 1 | document-core/src/actions/prompt-precedence.ts:1 |
| `BusinessManifest` |  | 0/1 | 2 | document-core/src/manifest/document-core.manifest.ts:1 |
| `ActionManifest` |  | 0/1 | 1 | document-core/src/manifest/document-core.manifest.ts:1 |
| `ConnectorSlotManifest` |  | 0/1 | 1 | document-core/src/manifest/document-core.manifest.ts:1 |
| `WIRE_CONTRACT_VERSION` |  | 0/1 | 1 | document-core/src/manifest/document-core.manifest.ts:1 |
| `MULTIPART_MIN_TOTAL_BYTES` |  | 0/1 | 2 | document-core/src/pipelines/parser-budget.ts:33 |
| `IngestionReceipt` |  | 2/2 | 3 | document-core/src/types/actions.ts:5; document-core/src/validation/input-normalizer.ts:11 |
| `ArtifactRef` |  | 0/1 | 2 | document-core/src/types/context.ts:1 |
| `resolveIngestionSource` |  | 0/1 | 1 | document-core/src/validation/input-normalizer.ts:11 |
| `ArtifactPurpose` |  | 0/1 | 1 | document-core/src/worker.ts:13 |
| `TaskDisposition` |  | 0/1 | 10 | document-core/src/worker.ts:13 |
| `InvocationResponse` |  | 0/1 | 1 | document-core/src/worker.ts:13 |
| `(namespace)` | (module) | 2/2 | 0 | document-core/src/worker.ts:399; document-core/src/worker.ts:437 |

Test-only/extra detail (compact):

| test symbol | type-only | refs | test file(s) |
|---|---|---|---|
| `CONNECTOR_ARTIFACT_MAX_BYTES` | 0/1 | 1 | bounded-input.test.ts |
| `InvocationArtifactContentSchema` | 0/1 | 2 | bounded-input.test.ts |
| `InvocationArtifactContent` | 2/2 | 2 | bounded-input.test.ts, ingest-wire.test.ts |
| `BusinessJobV1` | 0/3 | 6 | bullmq-smoke.test.ts, provider-backed-variant.test.ts, sdk-consumer.test.ts |
| `businessQueueName` | 0/1 | 1 | bullmq-smoke.test.ts |
| `ClaimResult` | 0/3 | 6 | bullmq-smoke.test.ts, provider-backed-variant.test.ts, sdk-consumer.test.ts |
| `HeartbeatAck` | 0/1 | 1 | bullmq-smoke.test.ts |
| `TaskHeartbeatAck` | 0/1 | 1 | bullmq-smoke.test.ts |
| `ArtifactUploadGrant` | 0/1 | 1 | bullmq-smoke.test.ts |
| `SaveStepAck` | 0/1 | 1 | bullmq-smoke.test.ts |
| `TaskReportAck` | 0/1 | 1 | bullmq-smoke.test.ts |
| `ArtifactUploadGrantRequestSchema` | 0/1 | 1 | cross-service-boundary.test.ts |
| `ArtifactUploadGrantSchema` | 0/1 | 1 | cross-service-boundary.test.ts |
| `ArtifactFinalizeRequestSchema` | 0/1 | 1 | cross-service-boundary.test.ts |
| `ArtifactAccessRequestSchema` | 0/1 | 1 | cross-service-boundary.test.ts |
| `ArtifactAccessGrantSchema` | 0/1 | 1 | cross-service-boundary.test.ts |
| `InvocationGrantRequestSchema` | 0/1 | 1 | cross-service-boundary.test.ts |
| `InvocationGrantSchema` | 0/1 | 1 | cross-service-boundary.test.ts |
| `InvocationResponse` | 3/6 | 9 | disbursement-handler.test.ts, multi-container-e2e.integration.test.ts, p8-03-provider-convergence.test.ts, p9-03-doc-compare-handler.test.ts, provider-backed-variant.test.ts, sdk-consumer.test.ts |
| `TaskDisposition` | 2/2 | 9 | disbursement-handler.test.ts, p9-03-doc-compare-handler.test.ts |
| `InvocationInputSchema` | 0/1 | 3 | ingest-scan-fixtures.test.ts |
| `withIngestionSource` | 0/1 | 1 | ingest-source-pin.test.ts |
| `IngestionReceipt` | 1/1 | 1 | ingest-source-pin.test.ts |
| `validateManifest` | 0/5 | 23 | manifest.test.ts, p9-01-disbursement-registration.test.ts, p9-03-doc-compare-registration.test.ts, sdk-consumer.test.ts, suite-bootstrap-contract.test.ts |
| `hashManifest` | 0/1 | 2 | manifest.test.ts |
| `WIRE_CONTRACT_VERSION` | 0/1 | 1 | manifest.test.ts |
| `SCHEMA_LIMITS` | 0/1 | 3 | manifest.test.ts |
| `ArtifactAccessGrant` | 0/1 | 1 | multi-container-e2e.integration.test.ts |
| `InvocationGrant` | 1/3 | 2 | multi-container-e2e.integration.test.ts, p8-01-traceability-harness.test.ts, sdk-consumer.test.ts |
| `ProblemDetails` | 1/1 | 2 | multi-container-e2e.integration.test.ts |
| `UsageEventSchema` | 0/1 | 2 | p8-03-provider-convergence.test.ts |
| `MULTIPART_MIN_TOTAL_BYTES` | 0/1 | 2 | parser-budget-band.test.ts |
| `ArtifactRef` | 0/1 | 1 | r1-e-sdk-metadata-adapter.test.ts |

#### `@du/document-kit`

| src symbol | alias | type-only sites | refs | src site(s) |
|---|---|---|---|---|
| `DiffEngine` |  | 0/1 | 1 | document-core/src/actions/compare/index.ts:9 |
| `DocumentFormatDetector` |  | 0/3 | 6 | document-core/src/actions/ingest/index.ts:9; document-core/src/pipelines/parser-budget.ts:34; document-core/src/worker.ts:22 |
| `PdfSplitter` |  | 0/1 | 2 | document-core/src/actions/ingest/index.ts:9 |
| `FormatConverter` |  | 0/1 | 1 | document-core/src/actions/transform/index.ts:9 |
| `PiiRedactor` |  | 0/1 | 1 | document-core/src/actions/transform/index.ts:9 |
| `TemplateEngine` |  | 0/1 | 1 | document-core/src/actions/transform/index.ts:9 |
| `TextChunker` |  | 0/1 | 2 | document-core/src/actions/transform/index.ts:9 |
| `defaultParserFactory` |  | 0/1 | 1 | document-core/src/pipelines/parser-budget.ts:34 |
| `DocumentParserFactory` |  | 0/1 | 1 | document-core/src/pipelines/parser-budget.ts:34 |
| `ParseResult` |  | 0/1 | 2 | document-core/src/pipelines/parser-budget.ts:34 |
| `ParserOptions` |  | 0/1 | 1 | document-core/src/pipelines/parser-budget.ts:34 |
| `SupportedFormat` |  | 1/1 | 1 | document-core/src/types/context.ts:2 |

Test-only/extra detail (compact):

| test symbol | type-only | refs | test file(s) |
|---|---|---|---|
| `DocumentParserFactory` | 1/3 | 9 | config.test.ts, parser-budget-band.test.ts, parser-budgets.test.ts |
| `DocumentParser` | 1/2 | 4 | config.test.ts, parser-budgets.test.ts |
| `DocumentFormatDetector` | 0/4 | 6 | fixtures/mock-context.ts, r1-e-sdk-metadata-adapter.test.ts, r1-e-trusted-format-propagation.test.ts, read-stream-acquisition.test.ts |
| `PdfSplitter` | 0/1 | 1 | parser-budget-band.test.ts |
| `ParseResult` | 1/2 | 7 | parser-budgets.test.ts, r1-e-trusted-format-propagation.test.ts |
| `defaultParserFactory` | 0/3 | 3 | r1-e-layer6-archive-worker.test.ts, r1-e-sdk-metadata-adapter.test.ts, r1-e-trusted-format-propagation.test.ts |

#### `@du/worker-sdk`

| src symbol | alias | type-only sites | refs | src site(s) |
|---|---|---|---|---|
| `LeaseLostError` |  | 0/3 | 7 | document-core/src/actions/extract/index.ts:11; document-core/src/pipelines/step-checkpoint.ts:3; document-core/src/worker.ts:80 |
| `createLogger` |  | 0/1 | 1 | document-core/src/main.ts:1 |
| `ArtifactStreamError` |  | 0/1 | 1 | document-core/src/pipelines/parser-budget.ts:41 |
| `createTempWorkspace` |  | 0/1 | 1 | document-core/src/pipelines/parser-budget.ts:41 |
| `SealedArtifact` |  | 1/1 | 1 | document-core/src/pipelines/step-checkpoint.ts:4 |
| `resolveFanoutConcurrency` |  | 0/1 | 1 | document-core/src/pipelines/workflows/disbursement/fanout.ts:12 |
| `runBoundedFanout` | runSharedBoundedFanout | 0/1 | 1 | document-core/src/pipelines/workflows/disbursement/fanout.ts:12 |
| `TaskArtifactCrypto` |  | 2/2 | 3 | document-core/src/types/context.ts:3; document-core/src/worker.ts:80 |
| `defineBusiness` |  | 0/1 | 2 | document-core/src/worker.ts:3 |
| `startWorker` |  | 0/1 | 1 | document-core/src/worker.ts:3 |
| `TaskHandler` |  | 0/1 | 3 | document-core/src/worker.ts:3 |
| `TaskContext` | SdkTaskContext | 0/1 | 42 | document-core/src/worker.ts:3 |
| `BusinessDefinition` |  | 0/1 | 3 | document-core/src/worker.ts:3 |
| `WorkerConfig` |  | 0/1 | 2 | document-core/src/worker.ts:3 |
| `WorkerHandle` |  | 0/1 | 2 | document-core/src/worker.ts:3 |
| `QueueConsumer` |  | 0/1 | 2 | document-core/src/worker.ts:3 |
| `TaskArtifactBinding` |  | 1/1 | 1 | document-core/src/worker.ts:80 |
| `WorkerCryptoSeam` |  | 1/1 | 1 | document-core/src/worker.ts:80 |

Test-only/extra detail (compact):

| test symbol | type-only | refs | test file(s) |
|---|---|---|---|
| `LeaseLostError` | 0/3 | 15 | cancellation-fencing.test.ts, checkpoint-replay.test.ts, provider-backed-variant.test.ts |
| `TaskArtifactCrypto` | 2/2 | 3 | checkpoint.test.ts, doc-core-crypto-seam.test.ts |
| `TaskContext` | 2/6 | 13 | disbursement-handler.test.ts, p8-03-provider-convergence.test.ts, p9-03-doc-compare-handler.test.ts, parser-budgets.test.ts, provider-backed-variant.test.ts, r1-e-sdk-metadata-adapter.test.ts |
| `CryptoStorageFacade` | 0/1 | 2 | doc-core-crypto-seam.test.ts |
| `bindTaskCrypto` | 0/1 | 1 | doc-core-crypto-seam.test.ts |
| `CryptoKeyProvider` | 1/1 | 1 | doc-core-crypto-seam.test.ts |
| `TaskArtifactBinding` | 1/1 | 0 | doc-core-crypto-seam.test.ts |
| `WrappedDek` | 1/1 | 2 | doc-core-crypto-seam.test.ts |
| `TEMP_WORKSPACE_PREFIX` | 0/6 | 9 | ingest-scan-fixtures.test.ts, ingest-scan-tamper.test.ts, ingest-timeout-recovery.test.ts, ingest.test.ts, parser-budget-band.test.ts, read-stream-acquisition.test.ts |
| `defineBusiness` | 0/2 | 4 | multi-container-e2e.integration.test.ts, sdk-consumer.test.ts |
| `startWorker` | 0/3 | 1 | multi-container-e2e.integration.test.ts, provider-backed-variant.test.ts, sdk-consumer.test.ts |
| `TaskHandler` | 1/1 | 1 | multi-container-e2e.integration.test.ts |
| `DefaultTaskContext` | 0/1 | 1 | p8-01-traceability-harness.test.ts |
| `RuntimeClient` | 0/1 | 1 | p8-01-traceability-harness.test.ts |
| `TaskContextDeps` | 1/1 | 1 | p8-01-traceability-harness.test.ts |
| `ConnectorInvocationPayload` | 1/1 | 1 | p8-01-traceability-harness.test.ts |
| `resolveFanoutConcurrency` | 0/1 | 1 | p9-01-disbursement.test.ts |
| `QueueConsumer` | 0/2 | 3 | provider-backed-variant.test.ts, sdk-consumer.test.ts |
| `(namespace)` | 1/1 | 0 | read-stream-acquisition.test.ts |

### 3.2 lc-checker

#### `@du/contracts`

| src symbol | alias | type-only sites | refs | src site(s) |
|---|---|---|---|---|
| `BusinessManifest` |  | 0/2 | 4 | lc-checker/src/manifest.ts:1; lc-checker/src/registry-tool.ts:1 |
| `WIRE_CONTRACT_VERSION` |  | 0/1 | 1 | lc-checker/src/manifest.ts:1 |
| `contentHash` |  | 0/2 | 3 | lc-checker/src/registry-tool.ts:1; lc-checker/src/worker.ts:24 |
| `CONNECTOR_ARTIFACT_MAX_BYTES` |  | 0/1 | 2 | lc-checker/src/worker.ts:24 |
| `CONNECTOR_ARTIFACT_MAX_COUNT` ⚠ |  | 0/1 | 0 | lc-checker/src/worker.ts:24 |

#### `@du/document-kit` — no imports

#### `@du/worker-sdk`

| src symbol | alias | type-only sites | refs | src site(s) |
|---|---|---|---|---|
| `resolveFanoutConcurrency` |  | 0/1 | 1 | lc-checker/src/fanout.ts:12 |
| `runBoundedFanout` | runSharedBoundedFanout | 0/1 | 1 | lc-checker/src/fanout.ts:12 |
| `createLogger` |  | 0/1 | 1 | lc-checker/src/main.ts:1 |
| `safeErrorForLog` |  | 0/1 | 1 | lc-checker/src/main.ts:1 |
| `ChildTaskSpecInput` |  | 1/1 | 1 | lc-checker/src/worker.ts:29 |
| `TaskContext` |  | 1/1 | 14 | lc-checker/src/worker.ts:29 |
| `TaskDisposition` |  | 1/1 | 4 | lc-checker/src/worker.ts:29 |
| `TaskHandler` |  | 1/1 | 4 | lc-checker/src/worker.ts:29 |
| `BusinessDefinition` |  | 0/1 | 1 | lc-checker/src/worker.ts:30 |
| `defineBusiness` |  | 0/1 | 2 | lc-checker/src/worker.ts:30 |
| `startWorker` |  | 0/1 | 1 | lc-checker/src/worker.ts:30 |
| `WorkerConfig` |  | 1/1 | 1 | lc-checker/src/worker.ts:30 |
| `WorkerHandle` |  | 1/1 | 1 | lc-checker/src/worker.ts:30 |

Test-only/extra detail (compact):

| test symbol | type-only | refs | test file(s) |
|---|---|---|---|
| `TaskContext` | 1/1 | 2 | fakes.ts |
| `TaskDisposition` | 1/1 | 2 | fakes.ts |
| `resolveFanoutConcurrency` | 0/1 | 1 | lc-checker.test.ts |

### 3.3 example-review

#### `@du/contracts`

| src symbol | alias | type-only sites | refs | src site(s) |
|---|---|---|---|---|
| `BusinessManifest` |  | 0/3 | 5 | example-review/src/manifest.ts:1; example-review/src/registry-tool.ts:1; example-review/src/worker.ts:1 |
| `WIRE_CONTRACT_VERSION` |  | 0/1 | 1 | example-review/src/manifest.ts:1 |
| `contentHash` |  | 0/1 | 2 | example-review/src/registry-tool.ts:1 |

Test-only/extra detail (compact):

| test symbol | type-only | refs | test file(s) |
|---|---|---|---|
| `BusinessManifest` | 0/1 | 1 | manifest.test.ts |
| `validateManifest` | 0/2 | 4 | manifest.test.ts, version-coexistence.test.ts |
| `contentHash` | 0/2 | 4 | p7-03-registry-live.integration.test.ts, p7-04-profile-assignment.integration.test.ts |
| `ArtifactRef` | 2/2 | 3 | task-context-consumer.test.ts, test-helper.ts |
| `CheckpointRef` | 2/2 | 2 | task-context-consumer.test.ts, test-helper.ts |
| `InvocationGrant` | 1/1 | 1 | task-context-consumer.test.ts |
| `InvocationResponse` | 2/2 | 4 | task-context-consumer.test.ts, test-helper.ts |
| `JoinPolicy` | 1/1 | 3 | test-helper.ts |

#### `@du/document-kit`

| src symbol | alias | type-only sites | refs | src site(s) |
|---|---|---|---|---|
| `defaultParserFactory` |  | 0/1 | 1 | example-review/src/review.ts:4 |
| `DocumentFormatDetector` |  | 0/1 | 1 | example-review/src/review.ts:4 |
| `FormatDetectionResult` |  | 1/1 | 1 | example-review/src/review.ts:5 |
| `ParseResult` |  | 1/1 | 1 | example-review/src/review.ts:5 |

Test-only/extra detail (compact):

| test symbol | type-only | refs | test file(s) |
|---|---|---|---|
| `defaultParserFactory` | 0/1 | 2 | r1-e-office-safe-parser.test.ts |
| `ParseResult` | 1/1 | 1 | r1-e-office-safe-parser.test.ts |

#### `@du/worker-sdk`

| src symbol | alias | type-only sites | refs | src site(s) |
|---|---|---|---|---|
| `createLogger` |  | 0/2 | 2 | example-review/src/main.ts:1; example-review/src/review.ts:3 |
| `safeErrorForLog` |  | 0/1 | 1 | example-review/src/main.ts:1 |
| `TaskHandler` |  | 1/2 | 4 | example-review/src/review.ts:2; example-review/src/worker.ts:2 |
| `TaskContext` |  | 1/1 | 5 | example-review/src/review.ts:2 |
| `TaskDisposition` |  | 1/1 | 2 | example-review/src/review.ts:2 |
| `LeaseLostError` |  | 0/1 | 5 | example-review/src/review.ts:3 |
| `BusinessDefinition` |  | 0/1 | 1 | example-review/src/worker.ts:2 |
| `QueueConsumer` |  | 0/1 | 1 | example-review/src/worker.ts:2 |
| `WorkerConfig` |  | 0/1 | 1 | example-review/src/worker.ts:2 |
| `WorkerHandle` |  | 0/1 | 1 | example-review/src/worker.ts:2 |
| `defineBusiness` |  | 0/1 | 2 | example-review/src/worker.ts:2 |
| `startWorker` |  | 0/1 | 1 | example-review/src/worker.ts:2 |

Test-only/extra detail (compact):

| test symbol | type-only | refs | test file(s) |
|---|---|---|---|
| `LeaseLostError` | 0/2 | 6 | child-review.test.ts, fencing.test.ts |
| `WorkerHandle` | 1/1 | 1 | example-review-continuation.integration.test.ts |
| `defineBusiness` | 0/2 | 3 | manifest.test.ts, version-coexistence.test.ts |
| `TaskHandler` | 2/3 | 4 | manifest.test.ts, r1-e-office-safe-parser.test.ts, task-context-consumer.test.ts |
| `TaskContext` | 2/2 | 11 | task-context-consumer.test.ts, test-helper.ts |
| `TaskDisposition` | 2/2 | 14 | task-context-consumer.test.ts, test-helper.ts |
| `StepFacade` | 1/1 | 2 | task-context-consumer.test.ts |
| `ArtifactFacade` | 1/1 | 2 | task-context-consumer.test.ts |
| `ConnectorFacade` | 1/1 | 2 | task-context-consumer.test.ts |
| `SpawnFacade` | 1/1 | 4 | task-context-consumer.test.ts |
| `HumanWaitFacade` | 1/1 | 4 | task-context-consumer.test.ts |
| `ProgressFacade` | 1/1 | 2 | task-context-consumer.test.ts |
| `ChildTaskSpecInput` | 2/2 | 6 | task-context-consumer.test.ts, test-helper.ts |
| `ConnectorInvokeInput` | 1/1 | 3 | task-context-consumer.test.ts |
| `ArtifactPurpose` | 1/1 | 2 | task-context-consumer.test.ts |

## 4. Config/build coupling that must change for repo isolation

| worker | surface | sibling path reference |
|---|---|---|
| document-core | `jest.config.cjs:16-19` | `@du/worker-sdk`, `@du/document-kit` → `../../packages/*/src`; `@du/orchestrator`, `@du/connector` → `../../services/*/dist` |
| document-core | `tsconfig.json:7-8`, `tsconfig.test.json:7-8` | `@du/orchestrator`, `@du/connector` → `../../services/*` (three packages resolve through workspace node_modules) |
| document-core | `scripts/build-dependencies.cjs` | builds 9 workspace packages/services in order (`pnpm --filter @du/...`), incl. `packages/contracts`, `packages/document-kit`, `packages/worker-sdk`, connector, orchestrator |
| document-core | `Dockerfile` (synced) | copies whole workspace (`packages`, `services`, `businesses`, `apps`, `tests`, `scripts/docker`) and builds via `scripts/docker/build-runtime.cjs` |
| document-core | `template/vendor/**` (13 files, untracked) | vendored copies of contracts (7), document-kit (5), worker-sdk (1) sources; no code references them |
| lc-checker | `jest.config.cjs:11-14` | contracts/worker-sdk → `../../packages/*/dist`; document-kit → `../../packages/document-kit/src`; orchestrator → `../../services/orchestrator/dist` |
| lc-checker | `tsconfig.json:10-13`, `tsconfig.test.json:7-10` | all three packages + `@du/orchestrator` → sibling paths |
| lc-checker | `Dockerfile` (synced) | same whole-workspace build as document-core |
| example-review | `jest.config.cjs:11-14` | same mapping shape as lc-checker |
| example-review | `tsconfig.json:10-13`, `tsconfig.test.json:7-10` | all three packages + `@du/orchestrator` → sibling paths |
| example-review | `Dockerfile` (synced) | same whole-workspace build as document-core |

All three Dockerfiles are generated by `scripts/docker/sync-dockerfiles.cjs` and build every workspace
service from one context; per-worker isolation needs a self-contained context and pinned dependency build.

## 5. Adjacent couplings found (outside the three packages, isolation-relevant)

- `@du/orchestrator` imported by tests only: example-review `tests/p7-03-registry-live.integration.test.ts:3`,
  `tests/p7-04-profile-assignment.integration.test.ts:3`, `tests/example-review-continuation.integration.test.ts:3`
  (`createApp`, `createDb`, `App`); document-core `tests/multi-container-e2e.integration.test.ts:13`.
- `@du/connector` imported by tests only: document-core `tests/multi-container-e2e.integration.test.ts:28`,
  `tests/p8-03-provider-convergence.test.ts:9` (`PgSqlClient`).
- None of these are declared in the workers' `package.json`; they resolve via jest/tsconfig sibling paths,
  which the isolated repo will not have. Example-review README already claims a public-package boundary;
  the production `src` tree honours it, integration tests do not (test-scope only).

## 6. Findings

| ID | severity | finding | evidence |
|---|---|---|---|
| W-AUD-01 | HIGH (isolation) | `@du/lc-checker` declares `@du/document-kit` (`workspace:*`) but has **zero** imports in src/tests; only jest/tsconfig path entries remain. Either drop the dependency or justify it before freezing the worker manifest. | `lc-checker/package.json:19`; zero import hits in `audit-raw.json`; `jest.config.cjs:12`, `tsconfig.json:11` |
| W-AUD-02 | MEDIUM | Unused import `CONNECTOR_ARTIFACT_MAX_COUNT` in `lc-checker/src/worker.ts:26` (only `CONNECTOR_ARTIFACT_MAX_BYTES` is used, lines 121/129). | grep: single occurrence; `audit-summary.md` ⚠ row |
| W-AUD-03 | MEDIUM | All three workers depend on sibling workspace paths at build/test time (tsconfig paths, jest moduleNameMapper, Dockerfile workspace COPY, `build-dependencies.cjs`). Repo isolation must vendor/pin the three packages and cut these references. | section 4 |
| W-AUD-04 | INFO | `document-core/template/vendor/` contains an untracked vendored copy of the three packages' sources (13 files) referenced by no code; decide seed vs delete. | `git status` reports `?? businesses/document-core/template/` |
| W-AUD-05 | INFO | Integration tests import `@du/orchestrator`/`@du/connector` without declaring them; isolated-repo test policy must use built artifacts or exclude/move these suites. | section 5 |
| W-AUD-06 | LOW | No real subpath or deep-import coupling; the only subpath string is the negative boundary test `@du/contracts/private/internal`. | `document-core/tests/package-boundary.test.ts:195` |

## 7. Minimum isolation cut (src symbols the worker repo must provide)

**document-core**

- `@du/contracts`: `CONNECTOR_ARTIFACT_MAX_BYTES`, `InvocationArtifactContent`, `PinnedProfilePolicy`, `PinnedPromptOverride`, `PROMPT_OVERRIDE_PRECEDENCE`, `PromptOverrideRead`, `BusinessManifest`, `ActionManifest`, `ConnectorSlotManifest`, `WIRE_CONTRACT_VERSION`, `MULTIPART_MIN_TOTAL_BYTES`, `IngestionReceipt`, `ArtifactRef`, `resolveIngestionSource`, `ArtifactPurpose`, `TaskDisposition`, `InvocationResponse` (plus inline `import()` types at worker.ts:399/437)
- `@du/document-kit`: `DiffEngine`, `DocumentFormatDetector`, `PdfSplitter`, `FormatConverter`, `PiiRedactor`, `TemplateEngine`, `TextChunker`, `defaultParserFactory`, `DocumentParserFactory`, `ParseResult`, `ParserOptions`, `SupportedFormat`
- `@du/worker-sdk`: `LeaseLostError`, `createLogger`, `ArtifactStreamError`, `createTempWorkspace`, `SealedArtifact`, `resolveFanoutConcurrency`, `runBoundedFanout`, `TaskArtifactCrypto`, `defineBusiness`, `startWorker`, `TaskHandler`, `TaskContext`, `BusinessDefinition`, `WorkerConfig`, `WorkerHandle`, `QueueConsumer`, `TaskArtifactBinding`, `WorkerCryptoSeam`

**lc-checker**

- `@du/contracts`: `BusinessManifest`, `WIRE_CONTRACT_VERSION`, `contentHash`, `CONNECTOR_ARTIFACT_MAX_BYTES`, `CONNECTOR_ARTIFACT_MAX_COUNT`
- `@du/document-kit`: (none)
- `@du/worker-sdk`: `resolveFanoutConcurrency`, `runBoundedFanout`, `createLogger`, `safeErrorForLog`, `ChildTaskSpecInput`, `TaskContext`, `TaskDisposition`, `TaskHandler`, `BusinessDefinition`, `defineBusiness`, `startWorker`, `WorkerConfig`, `WorkerHandle`

**example-review**

- `@du/contracts`: `BusinessManifest`, `WIRE_CONTRACT_VERSION`, `contentHash`
- `@du/document-kit`: `defaultParserFactory`, `DocumentFormatDetector`, `FormatDetectionResult`, `ParseResult`
- `@du/worker-sdk`: `createLogger`, `safeErrorForLog`, `TaskHandler`, `TaskContext`, `TaskDisposition`, `LeaseLostError`, `BusinessDefinition`, `QueueConsumer`, `WorkerConfig`, `WorkerHandle`, `defineBusiness`, `startWorker`


## 8. Evidence index (under `coordination/reports/raw/audit-worker-repos-isolation/`)

| file | content | SHA-256 |
|---|---|---|
| `imports-full.txt` | extractor stdout: every statement with symbol, alias, type flag, refs; plus non-import textual refs | `1A52F2ED2C191B6A0627B9200C8D2B3D6AEFD99598EA785ACDA3E6DFBA58D33A` |
| `audit-raw.json` | machine-readable extraction (all 249 statement-entries) | `96CB73DF031E2DF7BECFBA3D95A55A925D5C9990F5C342B11591065555AC7BD2` |
| `audit-summary.md` | per-worker/per-package symbol tables including every test import site | `8EABFA25DE05818D5BE508BF9AED943EDD48A2928BFB5B64288135F2724761CC` |
| `extract_imports.py` | read-only extractor (copied from the verification temp dir) | `64562A9746FE94F564927261A51A909E1848CC6FE98F269D7C021D8F4DE38BE6` |
| `summarize_audit.py` | aggregation script for `audit-summary.md` | `D7BB20B1E6F25CA8A32347646FBB039B500DB0DB7852BBB14B002090310F88F9` |
| `make_receipt.py` | receipt generator (narrative + tables from `audit-raw.json`) | `D13CA74F5DFB1417425988A498AF09F083CC39D7F920117B1C6945AD9BA92397` |
| `summary-build.log` | extractor/summarizer run log | `63E7B8F7EADBBA9E1346C02C8AF2D71B089A57C3701E1C582D3919AB3715B5EF` |
| `receipt-build.log` | receipt generator run log | `1A3ADF73A129CB8FDA15CEF3EC31B5C98CC3A7323CF1742CF8B51569CEB99C24` |

## 9. Limitations

- Text/regex extraction, not a TypeScript compiler API run: counts and type-only flags reflect the source text;
  aliased symbols and inline `import()` types are handled, but a `tsc --traceResolution` audit was not run.
- `template/vendor` and `.cjs` scripts were scanned for statements; generated `dist/` and `node_modules/` were excluded.
- This audit changes nothing; the repository was only read. No commit, tick or push.
