# Worker import audit summary (read-only)

Generated from `audit-raw.json` (extractor handles multi-line imports, require, dynamic import and `import()` type positions).
`refs` counts identifier references in the file excluding the import statement itself. `tier` = src | tests | scripts.


## document-core

Declared: @du/contracts (dependencies, workspace:*), @du/document-kit (dependencies, workspace:*), @du/worker-sdk (dependencies, workspace:*)

### Tier matrix (import call sites by file tier)

| package | src sites | test sites | script sites | usage refs |
|---|---|---|---|---|
| `@du/contracts` | 30 | 50 | 0 | 135 |
| `@du/document-kit` | 14 | 15 | 0 | 50 |
| `@du/worker-sdk` | 21 | 36 | 0 | 135 |

### `@du/contracts` — caller symbols

| symbol | local alias | type sites | src sites | test sites | refs | import sites (src first) |
|---|---|---|---|---|---|---|
| `(namespace)` (dynamic import) | (module) | 2/2 | 2 | 0 | 0 | document-core/src/worker.ts:399; document-core/src/worker.ts:437 |
| `ActionManifest` (import) |  | 0/1 | 1 | 0 | 1 | document-core/src/manifest/document-core.manifest.ts:1 |
| `ArtifactAccessGrant` (import) |  | 0/1 | 0 | 1 | 1 | document-core/tests/multi-container-e2e.integration.test.ts:7 |
| `ArtifactAccessGrantSchema` (import) |  | 0/1 | 0 | 1 | 1 | document-core/tests/cross-service-boundary.test.ts:2 |
| `ArtifactAccessRequestSchema` (import) |  | 0/1 | 0 | 1 | 1 | document-core/tests/cross-service-boundary.test.ts:2 |
| `ArtifactFinalizeRequestSchema` (import) |  | 0/1 | 0 | 1 | 1 | document-core/tests/cross-service-boundary.test.ts:2 |
| `ArtifactPurpose` (import) |  | 0/1 | 1 | 0 | 1 | document-core/src/worker.ts:13 |
| `ArtifactRef` (import) |  | 0/2 | 1 | 1 | 3 | document-core/src/types/context.ts:1; document-core/tests/r1-e-sdk-metadata-adapter.test.ts:2 |
| `ArtifactUploadGrant` (import) |  | 0/1 | 0 | 1 | 1 | document-core/tests/bullmq-smoke.test.ts:5 |
| `ArtifactUploadGrantRequestSchema` (import) |  | 0/1 | 0 | 1 | 1 | document-core/tests/cross-service-boundary.test.ts:2 |
| `ArtifactUploadGrantSchema` (import) |  | 0/1 | 0 | 1 | 1 | document-core/tests/cross-service-boundary.test.ts:2 |
| `BusinessJobV1` (import) |  | 0/3 | 0 | 3 | 6 | document-core/tests/bullmq-smoke.test.ts:5; document-core/tests/provider-backed-variant.test.ts:8; document-core/tests/sdk-consumer.test.ts:7 |
| `BusinessManifest` (import) |  | 0/1 | 1 | 0 | 2 | document-core/src/manifest/document-core.manifest.ts:1 |
| `CONNECTOR_ARTIFACT_MAX_BYTES` (import) |  | 0/3 | 2 | 1 | 3 | document-core/src/actions/ingest/index.ts:12; document-core/src/worker.ts:13; document-core/tests/bounded-input.test.ts:3 |
| `ClaimResult` (import) |  | 0/3 | 0 | 3 | 6 | document-core/tests/bullmq-smoke.test.ts:5; document-core/tests/provider-backed-variant.test.ts:8; document-core/tests/sdk-consumer.test.ts:7 |
| `ConnectorSlotManifest` (import) |  | 0/1 | 1 | 0 | 1 | document-core/src/manifest/document-core.manifest.ts:1 |
| `HeartbeatAck` (import) |  | 0/1 | 0 | 1 | 1 | document-core/tests/bullmq-smoke.test.ts:5 |
| `IngestionReceipt` (import) |  | 2/2 | 1 | 1 | 2 | document-core/src/validation/input-normalizer.ts:11; document-core/tests/ingest-source-pin.test.ts:2 |
| `InvocationArtifactContent` (import) |  | 1/2 | 2 | 0 | 4 | document-core/src/actions/ingest/index.ts:12; document-core/src/worker.ts:13 |
| `InvocationArtifactContentSchema` (import) |  | 0/1 | 0 | 1 | 2 | document-core/tests/bounded-input.test.ts:3 |
| `InvocationGrant` (import) |  | 0/2 | 0 | 2 | 1 | document-core/tests/multi-container-e2e.integration.test.ts:7; document-core/tests/sdk-consumer.test.ts:7 |
| `InvocationGrantRequestSchema` (import) |  | 0/1 | 0 | 1 | 1 | document-core/tests/cross-service-boundary.test.ts:2 |
| `InvocationGrantSchema` (import) |  | 0/1 | 0 | 1 | 1 | document-core/tests/cross-service-boundary.test.ts:2 |
| `InvocationInputSchema` (import) |  | 0/1 | 0 | 1 | 3 | document-core/tests/ingest-scan-fixtures.test.ts:7 |
| `InvocationResponse` (import) |  | 1/5 | 1 | 4 | 8 | document-core/src/worker.ts:13; document-core/tests/multi-container-e2e.integration.test.ts:7; document-core/tests/p8-03-provider-convergence.test.ts:5; document-core/tests/provider-backed-variant.test.ts:8; document-core/tests/sdk-consumer.test.ts:7 |
| `MULTIPART_MIN_TOTAL_BYTES` (import) |  | 0/2 | 1 | 1 | 4 | document-core/src/pipelines/parser-budget.ts:33; document-core/tests/parser-budget-band.test.ts:5 |
| `PROMPT_OVERRIDE_PRECEDENCE` (import) |  | 0/1 | 1 | 0 | 3 | document-core/src/actions/prompt-precedence.ts:1 |
| `PinnedProfilePolicy` (import) |  | 3/3 | 3 | 0 | 3 | document-core/src/actions/prompt-precedence.ts:1; document-core/src/types/context.ts:1; document-core/src/worker.ts:13 |
| `PinnedPromptOverride` (import) |  | 2/2 | 2 | 0 | 2 | document-core/src/types/context.ts:1; document-core/src/worker.ts:13 |
| `ProblemDetails` (import) |  | 1/1 | 0 | 1 | 2 | document-core/tests/multi-container-e2e.integration.test.ts:7 |
| `PromptOverrideRead` (import) |  | 1/1 | 1 | 0 | 1 | document-core/src/actions/prompt-precedence.ts:1 |
| `SCHEMA_LIMITS` (import) |  | 0/1 | 0 | 1 | 3 | document-core/tests/manifest.test.ts:3 |
| `SaveStepAck` (import) |  | 0/1 | 0 | 1 | 1 | document-core/tests/bullmq-smoke.test.ts:5 |
| `TaskDisposition` (import) |  | 0/1 | 1 | 0 | 10 | document-core/src/worker.ts:13 |
| `TaskHeartbeatAck` (import) |  | 0/1 | 0 | 1 | 1 | document-core/tests/bullmq-smoke.test.ts:5 |
| `TaskReportAck` (import) |  | 0/1 | 0 | 1 | 1 | document-core/tests/bullmq-smoke.test.ts:5 |
| `UsageEventSchema` (import) |  | 0/1 | 0 | 1 | 2 | document-core/tests/p8-03-provider-convergence.test.ts:5 |
| `WIRE_CONTRACT_VERSION` (import) |  | 0/2 | 1 | 1 | 2 | document-core/src/manifest/document-core.manifest.ts:1; document-core/tests/manifest.test.ts:3 |
| `businessQueueName` (import) |  | 0/1 | 0 | 1 | 1 | document-core/tests/bullmq-smoke.test.ts:5 |
| `hashManifest` (import) |  | 0/1 | 0 | 1 | 2 | document-core/tests/manifest.test.ts:3 |
| `resolveIngestionSource` (import) |  | 0/1 | 1 | 0 | 1 | document-core/src/validation/input-normalizer.ts:11 |
| `validateManifest` (import) |  | 0/5 | 0 | 5 | 23 | document-core/tests/manifest.test.ts:3; document-core/tests/p9-01-disbursement-registration.test.ts:1; document-core/tests/p9-03-doc-compare-registration.test.ts:1; document-core/tests/sdk-consumer.test.ts:7; document-core/tests/suite-bootstrap-contract.test.ts:3 |
| `withIngestionSource` (import) |  | 0/1 | 0 | 1 | 1 | document-core/tests/ingest-source-pin.test.ts:2 |
| `IngestionReceipt` (import type) |  | 1/1 | 1 | 0 | 2 | document-core/src/types/actions.ts:5 |
| `InvocationArtifactContent` (import type) |  | 2/2 | 0 | 2 | 2 | document-core/tests/bounded-input.test.ts:4; document-core/tests/ingest-wire.test.ts:23 |
| `InvocationGrant` (import type) |  | 1/1 | 0 | 1 | 1 | document-core/tests/p8-01-traceability-harness.test.ts:2 |
| `InvocationResponse` (import type) |  | 2/2 | 0 | 2 | 2 | document-core/tests/disbursement-handler.test.ts:2; document-core/tests/p9-03-doc-compare-handler.test.ts:2 |
| `PinnedProfilePolicy` (import type) |  | 2/2 | 2 | 0 | 2 | document-core/src/actions/prompt-application.ts:2; document-core/src/actions/session-seam.ts:1 |
| `PinnedPromptOverride` (import type) |  | 1/1 | 1 | 0 | 1 | document-core/src/actions/prompt-application.ts:2 |
| `TaskDisposition` (import type) |  | 2/2 | 0 | 2 | 9 | document-core/tests/disbursement-handler.test.ts:2; document-core/tests/p9-03-doc-compare-handler.test.ts:2 |
| ⚠ `InvocationArtifactContent` (type import()) |  | 2/2 | 2 | 0 | 0 | document-core/src/worker.ts:399; document-core/src/worker.ts:437 |

### `@du/document-kit` — caller symbols

| symbol | local alias | type sites | src sites | test sites | refs | import sites (src first) |
|---|---|---|---|---|---|---|
| `DiffEngine` (import) |  | 0/1 | 1 | 0 | 1 | document-core/src/actions/compare/index.ts:9 |
| `DocumentFormatDetector` (import) |  | 0/7 | 3 | 4 | 12 | document-core/src/actions/ingest/index.ts:9; document-core/src/pipelines/parser-budget.ts:34; document-core/src/worker.ts:22; document-core/tests/fixtures/mock-context.ts:2; document-core/tests/r1-e-sdk-metadata-adapter.test.ts:3; document-core/tests/r1-e-trusted-format-propagation.test.ts:1; document-core/tests/read-stream-acquisition.test.ts:6 |
| `DocumentParser` (import) |  | 1/2 | 0 | 2 | 4 | document-core/tests/config.test.ts:3; document-core/tests/parser-budgets.test.ts:11 |
| `DocumentParserFactory` (import) |  | 0/3 | 1 | 2 | 8 | document-core/src/pipelines/parser-budget.ts:34; document-core/tests/config.test.ts:3; document-core/tests/parser-budgets.test.ts:11 |
| `FormatConverter` (import) |  | 0/1 | 1 | 0 | 1 | document-core/src/actions/transform/index.ts:9 |
| `ParseResult` (import) |  | 0/2 | 1 | 1 | 8 | document-core/src/pipelines/parser-budget.ts:34; document-core/tests/parser-budgets.test.ts:11 |
| `ParserOptions` (import) |  | 0/1 | 1 | 0 | 1 | document-core/src/pipelines/parser-budget.ts:34 |
| `PdfSplitter` (import) |  | 0/2 | 1 | 1 | 3 | document-core/src/actions/ingest/index.ts:9; document-core/tests/parser-budget-band.test.ts:6 |
| `PiiRedactor` (import) |  | 0/1 | 1 | 0 | 1 | document-core/src/actions/transform/index.ts:9 |
| `TemplateEngine` (import) |  | 0/1 | 1 | 0 | 1 | document-core/src/actions/transform/index.ts:9 |
| `TextChunker` (import) |  | 0/1 | 1 | 0 | 2 | document-core/src/actions/transform/index.ts:9 |
| `defaultParserFactory` (import) |  | 0/4 | 1 | 3 | 4 | document-core/src/pipelines/parser-budget.ts:34; document-core/tests/r1-e-layer6-archive-worker.test.ts:1; document-core/tests/r1-e-sdk-metadata-adapter.test.ts:3; document-core/tests/r1-e-trusted-format-propagation.test.ts:1 |
| `DocumentParserFactory` (import type) |  | 1/1 | 0 | 1 | 2 | document-core/tests/parser-budget-band.test.ts:7 |
| `ParseResult` (import type) |  | 1/1 | 0 | 1 | 1 | document-core/tests/r1-e-trusted-format-propagation.test.ts:2 |
| `SupportedFormat` (import type) |  | 1/1 | 1 | 0 | 1 | document-core/src/types/context.ts:2 |

### `@du/worker-sdk` — caller symbols

| symbol | local alias | type sites | src sites | test sites | refs | import sites (src first) |
|---|---|---|---|---|---|---|
| `(namespace)` (dynamic import) | (module) | 1/1 | 0 | 1 | 0 | document-core/tests/read-stream-acquisition.test.ts:282 |
| `ArtifactStreamError` (import) |  | 0/1 | 1 | 0 | 1 | document-core/src/pipelines/parser-budget.ts:41 |
| `BusinessDefinition` (import) |  | 0/1 | 1 | 0 | 3 | document-core/src/worker.ts:3 |
| `ConnectorInvocationPayload` (import) |  | 1/1 | 0 | 1 | 1 | document-core/tests/p8-01-traceability-harness.test.ts:3 |
| `CryptoKeyProvider` (import) |  | 1/1 | 0 | 1 | 1 | document-core/tests/doc-core-crypto-seam.test.ts:21 |
| `CryptoStorageFacade` (import) |  | 0/1 | 0 | 1 | 2 | document-core/tests/doc-core-crypto-seam.test.ts:21 |
| `DefaultTaskContext` (import) |  | 0/1 | 0 | 1 | 1 | document-core/tests/p8-01-traceability-harness.test.ts:3 |
| `LeaseLostError` (import) |  | 0/6 | 3 | 3 | 22 | document-core/src/actions/extract/index.ts:11; document-core/src/pipelines/step-checkpoint.ts:3; document-core/src/worker.ts:80; document-core/tests/cancellation-fencing.test.ts:1; document-core/tests/checkpoint-replay.test.ts:5; document-core/tests/provider-backed-variant.test.ts:2 |
| `QueueConsumer` (import) |  | 0/3 | 1 | 2 | 5 | document-core/src/worker.ts:3; document-core/tests/provider-backed-variant.test.ts:2; document-core/tests/sdk-consumer.test.ts:2 |
| `RuntimeClient` (import) |  | 0/1 | 0 | 1 | 1 | document-core/tests/p8-01-traceability-harness.test.ts:3 |
| `TEMP_WORKSPACE_PREFIX` (import) |  | 0/6 | 0 | 6 | 9 | document-core/tests/ingest-scan-fixtures.test.ts:8; document-core/tests/ingest-scan-tamper.test.ts:7; document-core/tests/ingest-timeout-recovery.test.ts:6; document-core/tests/ingest.test.ts:9; document-core/tests/parser-budget-band.test.ts:8; document-core/tests/read-stream-acquisition.test.ts:7 |
| `TaskArtifactBinding` (import) |  | 2/2 | 1 | 1 | 1 | document-core/src/worker.ts:80; document-core/tests/doc-core-crypto-seam.test.ts:21 |
| `TaskArtifactCrypto` (import) |  | 2/2 | 1 | 1 | 4 | document-core/src/worker.ts:80; document-core/tests/doc-core-crypto-seam.test.ts:21 |
| `TaskContext` (import) | SdkTaskContext | 0/5 | 1 | 4 | 51 | document-core/src/worker.ts:3; document-core/tests/p8-03-provider-convergence.test.ts:2; document-core/tests/parser-budgets.test.ts:10; document-core/tests/provider-backed-variant.test.ts:2; document-core/tests/r1-e-sdk-metadata-adapter.test.ts:4 |
| `TaskContextDeps` (import) |  | 1/1 | 0 | 1 | 1 | document-core/tests/p8-01-traceability-harness.test.ts:3 |
| `TaskHandler` (import) |  | 1/2 | 1 | 1 | 4 | document-core/src/worker.ts:3; document-core/tests/multi-container-e2e.integration.test.ts:29 |
| `WorkerConfig` (import) |  | 0/1 | 1 | 0 | 2 | document-core/src/worker.ts:3 |
| `WorkerCryptoSeam` (import) |  | 1/1 | 1 | 0 | 1 | document-core/src/worker.ts:80 |
| `WorkerHandle` (import) |  | 0/1 | 1 | 0 | 2 | document-core/src/worker.ts:3 |
| `WrappedDek` (import) |  | 1/1 | 0 | 1 | 2 | document-core/tests/doc-core-crypto-seam.test.ts:21 |
| `bindTaskCrypto` (import) |  | 0/1 | 0 | 1 | 1 | document-core/tests/doc-core-crypto-seam.test.ts:21 |
| `createLogger` (import) |  | 0/1 | 1 | 0 | 1 | document-core/src/main.ts:1 |
| `createTempWorkspace` (import) |  | 0/1 | 1 | 0 | 1 | document-core/src/pipelines/parser-budget.ts:41 |
| `defineBusiness` (import) |  | 0/3 | 1 | 2 | 6 | document-core/src/worker.ts:3; document-core/tests/multi-container-e2e.integration.test.ts:29; document-core/tests/sdk-consumer.test.ts:2 |
| `resolveFanoutConcurrency` (import) |  | 0/2 | 1 | 1 | 2 | document-core/src/pipelines/workflows/disbursement/fanout.ts:12; document-core/tests/p9-01-disbursement.test.ts:32 |
| `runBoundedFanout` (import) | runSharedBoundedFanout | 0/1 | 1 | 0 | 1 | document-core/src/pipelines/workflows/disbursement/fanout.ts:12 |
| `startWorker` (import) |  | 0/4 | 1 | 3 | 2 | document-core/src/worker.ts:3; document-core/tests/multi-container-e2e.integration.test.ts:29; document-core/tests/provider-backed-variant.test.ts:2; document-core/tests/sdk-consumer.test.ts:2 |
| `SealedArtifact` (import type) |  | 1/1 | 1 | 0 | 1 | document-core/src/pipelines/step-checkpoint.ts:4 |
| `TaskArtifactCrypto` (import type) |  | 2/2 | 1 | 1 | 2 | document-core/src/types/context.ts:3; document-core/tests/checkpoint.test.ts:2 |
| `TaskContext` (import type) | SdkTaskContext | 2/2 | 0 | 2 | 4 | document-core/tests/disbursement-handler.test.ts:3; document-core/tests/p9-03-doc-compare-handler.test.ts:3 |

### Non-import textual references

| file:line | text |
|---|---|
| `document-core/jest.config.cjs:16` | '^@du/worker-sdk$': '<rootDir>/../../packages/worker-sdk/src/index.ts', |
| `document-core/jest.config.cjs:17` | '^@du/document-kit$': '<rootDir>/../../packages/document-kit/src/index.ts', |
| `document-core/scripts/build-dependencies.cjs:6` | *   1. @du/contracts (foundational schemas and wire contracts) |
| `document-core/scripts/build-dependencies.cjs:9` | *   4. @du/document-kit (document parsing & conversion utilities) |
| `document-core/scripts/build-dependencies.cjs:10` | *   5. @du/worker-sdk (worker runtime, context, and facades) |
| `document-core/scripts/build-dependencies.cjs:28` | { name: '@du/contracts', dir: 'packages/contracts', cmd: 'pnpm --filter @du/contracts build' }, |
| `document-core/scripts/build-dependencies.cjs:31` | { name: '@du/document-kit', dir: 'packages/document-kit', cmd: 'pnpm --filter @du/document-kit build' }, |
| `document-core/scripts/build-dependencies.cjs:32` | { name: '@du/worker-sdk', dir: 'packages/worker-sdk', cmd: 'pnpm --filter @du/worker-sdk build' }, |
| `document-core/src/pipelines/parser-budget.ts:17` | *    The built-in @du/document-kit factory also runs built-in parsers on a terminable worker |
| `document-core/src/types/actions.ts:14` | * DATA-03 ingestion source pin (Δ14 envelope, `@du/contracts` |
| `document-core/src/types/context.ts:63` | /** Grant-scoped read descriptor without bytes (mirrors @du/worker-sdk ArtifactStat). */ |
| `document-core/template/vendor/document-kit/src/types.ts:6` | * Core type definitions for @du/document-kit |
| `document-core/tests/build-dependency-order.test.ts:10` | '@du/contracts', |
| `document-core/tests/build-dependency-order.test.ts:13` | '@du/document-kit', |
| `document-core/tests/build-dependency-order.test.ts:14` | '@du/worker-sdk', |
| `document-core/tests/build-dependency-order.test.ts:31` | '@du/contracts', |
| `document-core/tests/build-dependency-order.test.ts:34` | '@du/document-kit', |
| `document-core/tests/build-dependency-order.test.ts:35` | '@du/worker-sdk', |
| `document-core/tests/build-dependency-order.test.ts:60` | { name: '@du/contracts', dir: 'packages/contracts', cmd: 'pnpm --filter @du/contracts build' }, |
| `document-core/tests/build-dependency-order.test.ts:62` | { name: '@du/worker-sdk', dir: 'packages/worker-sdk', cmd: 'pnpm --filter @du/worker-sdk build' }, |
| `document-core/tests/build-dependency-order.test.ts:111` | if (cmd.includes('@du/worker-sdk')) { |
| `document-core/tests/build-dependency-order.test.ts:149` | '@du/contracts', |
| `document-core/tests/build-dependency-order.test.ts:152` | '@du/document-kit', |
| `document-core/tests/build-dependency-order.test.ts:153` | '@du/worker-sdk', |
| `document-core/tests/manifest.test.ts:6` | it('validates documentCoreManifest strictly against @du/contracts v1 validator', () => { |
| `document-core/tests/package-boundary.test.ts:10` | '@du/contracts', |
| `document-core/tests/package-boundary.test.ts:11` | '@du/worker-sdk', |
| `document-core/tests/package-boundary.test.ts:12` | '@du/document-kit', |
| `document-core/tests/package-boundary.test.ts:195` | '@du/contracts/private/internal', |

## lc-checker

Declared: @du/contracts (dependencies, workspace:*), @du/document-kit (dependencies, workspace:*), @du/worker-sdk (dependencies, workspace:*)

### Tier matrix (import call sites by file tier)

| package | src sites | test sites | script sites | usage refs |
|---|---|---|---|---|
| `@du/contracts` | 7 | 0 | 0 | 10 |
| `@du/document-kit` | 0 | 0 | 0 | 0 |
| `@du/worker-sdk` | 13 | 3 | 0 | 38 |

### `@du/contracts` — caller symbols

| symbol | local alias | type sites | src sites | test sites | refs | import sites (src first) |
|---|---|---|---|---|---|---|
| `BusinessManifest` (import) |  | 0/2 | 2 | 0 | 4 | lc-checker/src/manifest.ts:1; lc-checker/src/registry-tool.ts:1 |
| `CONNECTOR_ARTIFACT_MAX_BYTES` (import) |  | 0/1 | 1 | 0 | 2 | lc-checker/src/worker.ts:24 |
| ⚠ `CONNECTOR_ARTIFACT_MAX_COUNT` (import) |  | 0/1 | 1 | 0 | 0 | lc-checker/src/worker.ts:24 |
| `WIRE_CONTRACT_VERSION` (import) |  | 0/1 | 1 | 0 | 1 | lc-checker/src/manifest.ts:1 |
| `contentHash` (import) |  | 0/2 | 2 | 0 | 3 | lc-checker/src/registry-tool.ts:1; lc-checker/src/worker.ts:24 |

### `@du/worker-sdk` — caller symbols

| symbol | local alias | type sites | src sites | test sites | refs | import sites (src first) |
|---|---|---|---|---|---|---|
| `BusinessDefinition` (import) |  | 0/1 | 1 | 0 | 1 | lc-checker/src/worker.ts:30 |
| `WorkerConfig` (import) |  | 1/1 | 1 | 0 | 1 | lc-checker/src/worker.ts:30 |
| `WorkerHandle` (import) |  | 1/1 | 1 | 0 | 1 | lc-checker/src/worker.ts:30 |
| `createLogger` (import) |  | 0/1 | 1 | 0 | 1 | lc-checker/src/main.ts:1 |
| `defineBusiness` (import) |  | 0/1 | 1 | 0 | 2 | lc-checker/src/worker.ts:30 |
| `resolveFanoutConcurrency` (import) |  | 0/2 | 1 | 1 | 2 | lc-checker/src/fanout.ts:12; lc-checker/tests/lc-checker.test.ts:3 |
| `runBoundedFanout` (import) | runSharedBoundedFanout | 0/1 | 1 | 0 | 1 | lc-checker/src/fanout.ts:12 |
| `safeErrorForLog` (import) |  | 0/1 | 1 | 0 | 1 | lc-checker/src/main.ts:1 |
| `startWorker` (import) |  | 0/1 | 1 | 0 | 1 | lc-checker/src/worker.ts:30 |
| `ChildTaskSpecInput` (import type) |  | 1/1 | 1 | 0 | 1 | lc-checker/src/worker.ts:29 |
| `TaskContext` (import type) |  | 2/2 | 1 | 1 | 16 | lc-checker/src/worker.ts:29; lc-checker/tests/fakes.ts:1 |
| `TaskDisposition` (import type) |  | 2/2 | 1 | 1 | 6 | lc-checker/src/worker.ts:29; lc-checker/tests/fakes.ts:1 |
| `TaskHandler` (import type) |  | 1/1 | 1 | 0 | 4 | lc-checker/src/worker.ts:29 |

### Non-import textual references

| file:line | text |
|---|---|
| `lc-checker/jest.config.cjs:11` | '^@du/contracts$': '<rootDir>/../../packages/contracts/dist/index.js', |
| `lc-checker/jest.config.cjs:12` | '^@du/document-kit$': '<rootDir>/../../packages/document-kit/src/index.ts', |
| `lc-checker/jest.config.cjs:13` | '^@du/worker-sdk$': '<rootDir>/../../packages/worker-sdk/dist/index.js', |

## example-review

Declared: @du/contracts (dependencies, workspace:*), @du/document-kit (dependencies, workspace:*), @du/worker-sdk (dependencies, workspace:*)

### Tier matrix (import call sites by file tier)

| package | src sites | test sites | script sites | usage refs |
|---|---|---|---|---|
| `@du/contracts` | 5 | 13 | 0 | 30 |
| `@du/document-kit` | 4 | 2 | 0 | 7 |
| `@du/worker-sdk` | 14 | 22 | 0 | 92 |

### `@du/contracts` — caller symbols

| symbol | local alias | type sites | src sites | test sites | refs | import sites (src first) |
|---|---|---|---|---|---|---|
| `BusinessManifest` (import) |  | 0/4 | 3 | 1 | 6 | example-review/src/manifest.ts:1; example-review/src/registry-tool.ts:1; example-review/src/worker.ts:1; example-review/tests/manifest.test.ts:1 |
| `WIRE_CONTRACT_VERSION` (import) |  | 0/1 | 1 | 0 | 1 | example-review/src/manifest.ts:1 |
| `contentHash` (import) |  | 0/3 | 1 | 2 | 6 | example-review/src/registry-tool.ts:1; example-review/tests/p7-03-registry-live.integration.test.ts:4; example-review/tests/p7-04-profile-assignment.integration.test.ts:4 |
| `validateManifest` (import) |  | 0/2 | 0 | 2 | 4 | example-review/tests/manifest.test.ts:1; example-review/tests/version-coexistence.test.ts:1 |
| `ArtifactRef` (import type) |  | 2/2 | 0 | 2 | 3 | example-review/tests/task-context-consumer.test.ts:16; example-review/tests/test-helper.ts:3 |
| `CheckpointRef` (import type) |  | 2/2 | 0 | 2 | 2 | example-review/tests/task-context-consumer.test.ts:16; example-review/tests/test-helper.ts:3 |
| `InvocationGrant` (import type) |  | 1/1 | 0 | 1 | 1 | example-review/tests/task-context-consumer.test.ts:16 |
| `InvocationResponse` (import type) |  | 2/2 | 0 | 2 | 4 | example-review/tests/task-context-consumer.test.ts:16; example-review/tests/test-helper.ts:3 |
| `JoinPolicy` (import type) |  | 1/1 | 0 | 1 | 3 | example-review/tests/test-helper.ts:3 |

### `@du/document-kit` — caller symbols

| symbol | local alias | type sites | src sites | test sites | refs | import sites (src first) |
|---|---|---|---|---|---|---|
| `DocumentFormatDetector` (import) |  | 0/1 | 1 | 0 | 1 | example-review/src/review.ts:4 |
| `defaultParserFactory` (import) |  | 0/2 | 1 | 1 | 3 | example-review/src/review.ts:4; example-review/tests/r1-e-office-safe-parser.test.ts:1 |
| `FormatDetectionResult` (import type) |  | 1/1 | 1 | 0 | 1 | example-review/src/review.ts:5 |
| `ParseResult` (import type) |  | 2/2 | 1 | 1 | 2 | example-review/src/review.ts:5; example-review/tests/r1-e-office-safe-parser.test.ts:2 |

### `@du/worker-sdk` — caller symbols

| symbol | local alias | type sites | src sites | test sites | refs | import sites (src first) |
|---|---|---|---|---|---|---|
| `BusinessDefinition` (import) |  | 0/1 | 1 | 0 | 1 | example-review/src/worker.ts:2 |
| `LeaseLostError` (import) |  | 0/3 | 1 | 2 | 11 | example-review/src/review.ts:3; example-review/tests/child-review.test.ts:1; example-review/tests/fencing.test.ts:1 |
| `QueueConsumer` (import) |  | 0/1 | 1 | 0 | 1 | example-review/src/worker.ts:2 |
| `TaskHandler` (import) |  | 0/2 | 1 | 1 | 2 | example-review/src/worker.ts:2; example-review/tests/manifest.test.ts:5 |
| `WorkerConfig` (import) |  | 0/1 | 1 | 0 | 1 | example-review/src/worker.ts:2 |
| `WorkerHandle` (import) |  | 0/1 | 1 | 0 | 1 | example-review/src/worker.ts:2 |
| `createLogger` (import) |  | 0/2 | 2 | 0 | 2 | example-review/src/main.ts:1; example-review/src/review.ts:3 |
| `defineBusiness` (import) |  | 0/3 | 1 | 2 | 5 | example-review/src/worker.ts:2; example-review/tests/manifest.test.ts:5; example-review/tests/version-coexistence.test.ts:2 |
| `safeErrorForLog` (import) |  | 0/1 | 1 | 0 | 1 | example-review/src/main.ts:1 |
| `startWorker` (import) |  | 0/1 | 1 | 0 | 1 | example-review/src/worker.ts:2 |
| `ArtifactFacade` (import type) |  | 1/1 | 0 | 1 | 2 | example-review/tests/task-context-consumer.test.ts:1 |
| `ArtifactPurpose` (import type) |  | 1/1 | 0 | 1 | 2 | example-review/tests/task-context-consumer.test.ts:1 |
| `ChildTaskSpecInput` (import type) |  | 2/2 | 0 | 2 | 6 | example-review/tests/task-context-consumer.test.ts:1; example-review/tests/test-helper.ts:9 |
| `ConnectorFacade` (import type) |  | 1/1 | 0 | 1 | 2 | example-review/tests/task-context-consumer.test.ts:1 |
| `ConnectorInvokeInput` (import type) |  | 1/1 | 0 | 1 | 3 | example-review/tests/task-context-consumer.test.ts:1 |
| `HumanWaitFacade` (import type) |  | 1/1 | 0 | 1 | 4 | example-review/tests/task-context-consumer.test.ts:1 |
| `ProgressFacade` (import type) |  | 1/1 | 0 | 1 | 2 | example-review/tests/task-context-consumer.test.ts:1 |
| `SpawnFacade` (import type) |  | 1/1 | 0 | 1 | 4 | example-review/tests/task-context-consumer.test.ts:1 |
| `StepFacade` (import type) |  | 1/1 | 0 | 1 | 2 | example-review/tests/task-context-consumer.test.ts:1 |
| `TaskContext` (import type) |  | 3/3 | 1 | 2 | 16 | example-review/src/review.ts:2; example-review/tests/task-context-consumer.test.ts:1; example-review/tests/test-helper.ts:9 |
| `TaskDisposition` (import type) |  | 3/3 | 1 | 2 | 16 | example-review/src/review.ts:2; example-review/tests/task-context-consumer.test.ts:1; example-review/tests/test-helper.ts:9 |
| `TaskHandler` (import type) |  | 3/3 | 1 | 2 | 6 | example-review/src/review.ts:2; example-review/tests/r1-e-office-safe-parser.test.ts:3; example-review/tests/task-context-consumer.test.ts:1 |
| `WorkerHandle` (import type) |  | 1/1 | 0 | 1 | 1 | example-review/tests/example-review-continuation.integration.test.ts:5 |

### Non-import textual references

| file:line | text |
|---|---|
| `example-review/jest.config.cjs:11` | '^@du/contracts$': '<rootDir>/../../packages/contracts/dist/index.js', |
| `example-review/jest.config.cjs:12` | '^@du/document-kit$': '<rootDir>/../../packages/document-kit/src/index.ts', |
| `example-review/jest.config.cjs:13` | '^@du/worker-sdk$': '<rootDir>/../../packages/worker-sdk/dist/index.js', |
| `example-review/tests/package-boundary.test.ts:10` | '@du/contracts', |
| `example-review/tests/package-boundary.test.ts:11` | '@du/document-kit', |
| `example-review/tests/package-boundary.test.ts:12` | '@du/worker-sdk', |
| `example-review/tests/task-context-consumer.test.ts:20` | * against the real TaskContext interface exported by @du/worker-sdk. |