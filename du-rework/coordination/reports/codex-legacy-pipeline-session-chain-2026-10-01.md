# Legacy Pipeline Step-Chain and Session Chaining (2026-10-01)

## Scope and summary

Read-only characterization of the legacy pipeline registry, operation persistence, external-API session chaining, checkpoints/profile overrides, and the rework manifest/runtime counterpart. No source was changed and no tests were run.

The legacy registry's ordered list field is named `connections`, not `connectionChain`. The requested `ingest/parse`, `extract/invoice`, and `generate/report` entries each resolve to one connector step; `analyze/fact-check` is a concrete two-step example. A worker executes a persisted `pipelineJson` array whose steps have a `processor` slug and `variables`; prompts are resolved from connector/profile data at execution time, not stored as a `prompt` field in each pipeline step.

Legacy session state uses the exact key `pipelineState['session_id']`. The live map is shared between calls during one run and is snapshotted in the operation row's `stepsResultJson`; the next connector receives the value as a configured multipart form field. The rework wire/SDK has a `sessionRef` concept, but current orchestrator persistence omits it and the document-core action adapter does not pass or return it. Rework does support step-key checkpoint replay/resumption within an action, using task checkpoints rather than a per-operation linear `currentStep` cursor.

## 1. Legacy chain construction

`SubCaseDef` declares an ordered `connections: string[]` (`lib/endpoints/registry.ts:17-26`). `SERVICE_REGISTRY` binds the public discriminator value to that list. The exact examples are:

| Endpoint sub-case | Registry connection list | Count |
|---|---|---:|
| `ingest` / `parse` | `connections: ['ext-doc-layout']` (`lib/endpoints/registry.ts:70-83`) | 1 |
| `extract` / `invoice` | `connections: ['ext-data-extractor']` (`:112-125`) | 1 |
| `generate` / `report` | `connections: ['ext-content-gen']` (`:284-309`) | 1 |
| `analyze` / `fact-check` | `connections: ['ext-data-extractor', 'ext-fact-verifier']` (`:203-211`) | 2 |

There is no `connectionChain` property in the current registry source: `getAllEndpointSlugs()` returns `connections: sub.connections` (`lib/endpoints/registry.ts:408-424`). The runner selects the sub-case and turns each ordered connection step into a pipeline step with `processor: step.slug`, a copy of merged variables, and optional `stepId`, `captureSession`, and `injectSession` (`lib/endpoints/runner.ts:209-223`). `processor` is therefore the persisted field naming each `ExternalApiConnection` slug; it is not the registry's list-property name.

There is also no `prompt` property in the registry sub-case or generated pipeline step. `ExternalApiConnection` stores its prompt configuration in `promptFieldName` and `defaultPrompt`, plus optional `sessionIdResponsePath` and `sessionIdFieldName` (`lib/db/schema.ts:72-94`). At call time, `runExternalApiProcessor()` resolves the effective prompt and places it into a multipart field named by `promptFieldName` (`lib/pipelines/processors/external-api.ts:28-33,68-71`).

## 2. Persisted pipeline and worker reload

One serialized step has this effective shape (optional properties are omitted by `JSON.stringify` when undefined):

```json
{
  "processor": "ext-data-extractor",
  "variables": { "...": "..." },
  "stepId": "optional stable step id",
  "captureSession": "optional response dot-path or null",
  "injectSession": "optional multipart field name or null"
}
```

The runner constructs those fields from `ConnectionStep` objects (`lib/endpoints/runner.ts:210-223`), and submit writes `pipelineJson: JSON.stringify(pipeline)` into the new `operations` row (`lib/pipelines/submit.ts:298-315`). The BullMQ job payload carries the `operationId` and job metadata, not the pipeline array (`:335-351`).

The worker later reloads the `operations` row by `operationId`, parses `operation.pipelineJson`, validates it as an array of pipeline steps, and uses that parsed array (`lib/pipelines/engine.ts:96-121`). It is the same persisted step array, not a second chain independently assembled from job data. The connector records and applicable override rows are then separately loaded from the database when the worker starts (`:264-279`); the prompt text itself is not embedded in `pipelineJson`.

## 3. Legacy session chaining

The exact state key is **`session_id`**, stored in `ProcessorContext.pipelineState: Record<string, string>` (`lib/pipelines/engine.ts:30-55`). At run start the engine creates a fresh empty map (`:222-224`) and passes the same object reference to each sequential processor (`:339-356`). The BullMQ payload does not carry this map (`lib/pipelines/submit.ts:339-351`).

After an external response, `runExternalApiProcessor()` resolves the configured `captureSession` dot path (step-level setting takes precedence over connector `sessionIdResponsePath`) and, when it finds a non-empty string, stores it as `ctx.pipelineState['session_id']` (`lib/pipelines/processors/external-api.ts:173-185`). Before a later request, the step-level `injectSession` takes precedence over `connection.sessionIdFieldName`; if that field name and the state value exist, the processor appends the session value to `FormData` under that field name (`:110-117`). It is a multipart form field, not prompt interpolation. Prompt interpolation separately substitutes `{{variable}}` placeholders in the chosen prompt (`lib/pipelines/processors/prompt-resolver.ts:7-18,21-38`).

On the first step the new map has no `session_id`; the conditional append therefore adds no session field (`lib/pipelines/engine.ts:222-224`; `lib/pipelines/processors/external-api.ts:110-117`). The provider response may establish one for following steps.

After each successful step, the engine saves a `pipeline_state_snapshot` copy in that step's result entry and persists the accumulated array to `operations.stepsResultJson` (`lib/pipelines/engine.ts:365-394`). Thus live state is in memory between calls; its durable copy is the operation row's `stepsResultJson`, not BullMQ job data.

## 4. Legacy checkpoint and resume semantics

The engine defines `resumeFromStep = operation.currentStep ?? 0` (`lib/pipelines/engine.ts:222-229`). Before invoking each loop step it writes that step's zero-based index to `operations.currentStep` (`:281-293`). When `resumeFromStep > 0` and `stepsResultJson` parses, the engine restores the first `resumeFromStep` result entries, restores `currentText` from the last entry's `content_preview`, and restores `pipelineState` from that entry's `pipeline_state_snapshot`; the loop then starts at `resumeFromStep` (`:231-249,281-284`).

`content_preview` is only the first 500 characters of a step's output (`:365-373`), so it is the value used to re-seed the next step's `input_content` on resume (`:300-305`), rather than the full prior response. The session map is recoverable only when the corresponding successful-step snapshot made it into `stepsResultJson`. If the process dies before that database update, the in-memory session value is lost. Since `currentStep` is set at step start, a crash before the next step's start update can cause the last step to be run again.

The pipeline resume path reads the operation row and uses `currentStep` and `stepsResultJson`; it does not reconstruct execution state from the row's `state` field (`lib/pipelines/engine.ts:96-100,222-249`). The separate user-input resume route sets the operation state back to `RUNNING`, persists the edited/restored `stepsResultJson`, and re-enqueues the operation (`app/api/v1/operations/[id]/resume/route.ts:75-96`).

## 5. Profile and prompt overrides

`ProfileEndpoint` has a `connectionsOverride` text field, while `ExternalApiOverride` is keyed by connection, API key, endpoint, and `stepId` and contains `promptOverride` (`lib/db/schema.ts:101-114,120-137`). `loadProfileEndpoint()` resolves by API-key/endpoint and falls back to the service-level endpoint (`lib/endpoints/profile-resolver.ts:19-45`).

`parseConnectionSteps()` converts the profile's legacy string-array or current `ConnectionStep[]` JSON into an ordered list, or uses registry defaults when absent/invalid (`lib/endpoints/profile-resolver.ts:117-141`). The runner uses that list instead of the registry list to build the pipeline (`lib/endpoints/runner.ts:209-223`). As a result, `connectionsOverride` can change the connector order, replace connector slugs, attach per-step capture/injection names, and change the number of steps. It changes the pipeline structure as well as content.

At execution, the engine resolves an `ExternalApiOverride` by the step's `connectionId` plus the operation's API key and endpoint, using `stepId` (or `_default`) (`lib/pipelines/engine.ts:264-279,307-323`). That record changes the prompt only; it does not alter the processor list or number of steps. Prompt precedence is code-injected `variables._prompt`, then non-empty `ExternalApiOverride.promptOverride`, then `ExternalApiConnection.defaultPrompt`; the chosen string is interpolated against the step variables (`lib/pipelines/processors/prompt-resolver.ts:21-38`). The final prompt is appended under `connection.promptFieldName` (`lib/pipelines/processors/external-api.ts:68-71`).

## 6. Rework counterpart

Rework actions declare named connector slots and their accepted capabilities on an `ActionManifest`; a slot is a binding capability, not a registry-ordered chain (`du-rework/packages/contracts/src/manifest.ts:14-21,30-45`). For example, document-core `ingest` declares optional `ocr` and `vision` slots (`du-rework/businesses/document-core/src/manifest/document-core.manifest.ts:27-69`), while `extract` and `generate` declare a required `reasoning` slot (`:71-101,173-206`). The pinned execution snapshot records profile revision, prompt revisions, and `connectorBindings` (`slot -> connectorId@revision`) (`du-rework/packages/contracts/src/runtime.ts:51-73`). Action code defines the calls and their ordering; for example, the extract recipe executes `build-prompt`, `connector-inference`, and `validate-schema` (`du-rework/businesses/document-core/src/actions/extract/index.ts:67-165`).

The runtime's durable task checkpoint table is `step_checkpoints(task_id, step_key, generation, input_hash, output_ref, status, created_at)` with primary key `(task_id, step_key, generation)` (`du-rework/services/orchestrator/migrations/0001_platform_v1.sql:101-110`). The worker-facing `SaveStepRequestSchema` declares `inputHash`, `outputRef`, and optional `sessionRef` (`du-rework/packages/contracts/src/runtime.ts:104-110`). In `runtime.saveStep()`, the service validates the lease, checks the previous checkpoint's status and `input_hash`, replays an identical successful checkpoint or increments `generation`, seals the output reference, and inserts the checkpoint row (`du-rework/services/orchestrator/src/modules/runtime/runtime.ts:424-481`). The insert has no `session_ref` column/value, and claim reconstruction selects and returns step key, generation, input hash, status, and output ref only (`:1521-1549`). Thus the contract field `sessionRef` is not persisted in the current orchestrator checkpoint row or returned in `checkpointRefs`.

Step-boundary replay/resumption is present: the worker SDK's `step.run()` checks an existing successful checkpoint, verifies the input hash, reads and returns the full stored output without re-running the callback, and otherwise stores output and calls the runtime checkpoint endpoint (`du-rework/packages/worker-sdk/src/task-context.ts:315-351,360-375`). Document-core's `StepCheckpointManager` likewise reuses a matching stored step output and executes later steps through the task checkpoint facade (`du-rework/businesses/document-core/src/pipelines/step-checkpoint.ts:95-134`). The rework boundary is a stable task `stepKey` and input hash, not a numeric `operations.currentStep` cursor.

### SessionRef distinction

There is a `sessionRef` protocol concept: the connector request and result schemas include it (`du-rework/packages/contracts/src/connector.ts:73-105`); the Connector HTTP adapter forwards it to provider request mappings and normalizes provider-returned `sessionRef` (`du-rework/services/connector/src/adapters/http.ts:31-75,85-110`). The generic Worker SDK `runConnectorStep()` accepts an explicit continuation ref, can look at an existing checkpoint's ref for the same `stepKey`, passes it to `connector.invoke`, and returns the result (`du-rework/packages/worker-sdk/src/connector-session.ts:257-323`). `TaskContext.connector.invoke` includes the sent `sessionRef` in the canonical hash and invocation payload (`du-rework/packages/worker-sdk/src/task-context.ts:784-817`).

That protocol/helper is not an automatic, durable analogue of legacy's shared `pipelineState` chain in the current document-core path. The document-core worker adapter's `connector.invoke` accepts only slot/input/options, calls SDK invocation without `invokeOpts`, and omits `res.result.sessionRef` from the adapted return object (`du-rework/businesses/document-core/src/worker.ts:305-350,377-401`); the document-core actions call this adapter. Separately, although the SDK's `step.run()` sends an optional session ref (`packages/worker-sdk/src/task-context.ts:329-351`), the orchestrator save method and table described above discard it. A custom handler can explicitly forward a returned session reference during one live task execution through the lower-level SDK API, but the existing document-core operation path neither performs that hand-off nor reloads a session reference from the runtime checkpoint row after redelivery.

Direct answers for the current rework implementation: **(a)** the lower-level connector contract can carry a caller-forwarded `sessionRef` from one live call to a later call, but the standard document-core adapter does not chain it and runtime checkpoints do not make it durable; **(b)** yes, a multi-step action can resume at step boundaries by replaying completed task-keyed checkpoints and continuing the action at the next step (`task-context.ts:315-351,360-375`; `step-checkpoint.ts:95-134`), but there is no legacy-style numeric operation cursor; **(c)** the configurable ordered registry/profile connector chain, automatic shared `session_id` multipart injection/snapshot, and `pipelineJson` plus `currentStep` cursor have no direct counterpart in the current rework path (details below).

## Legacy behaviors without a direct rework counterpart

| Legacy behavior | Rework counterpart observed |
|---|---|
| Registry `connections` plus per-ProfileEndpoint ordered `connectionsOverride` can create/reorder/remove linear external-connector steps (`lib/endpoints/registry.ts:17-26,408-424`; `lib/endpoints/profile-resolver.ts:117-141`; `lib/endpoints/runner.ts:209-223`). | Manifest connector slots are named capability bindings; action implementation determines which calls occur and in what order (`du-rework/packages/contracts/src/manifest.ts:14-45`; `du-rework/packages/contracts/src/runtime.ts:61-65`). No equivalent profile field supplies a per-operation ordered connector chain. |
| One shared `pipelineState['session_id']` is captured from a provider response path, passed automatically to later steps as a configured multipart field, and snapshotted in `stepsResultJson` (`lib/pipelines/engine.ts:222-245,365-394`; `lib/pipelines/processors/external-api.ts:110-117,173-185`). | `sessionRef` is present in the connector protocol and generic SDK helper, but current document-core does not automatically hand it from one connector call to the next, and orchestrator checkpoint storage does not persist/return the field (`du-rework/businesses/document-core/src/worker.ts:305-350,377-401`; `du-rework/services/orchestrator/src/modules/runtime/runtime.ts:424-481,1526-1549`). |
| Operation row stores the whole serialized legacy pipeline and advances a numeric `currentStep` cursor (`lib/pipelines/submit.ts:300-315`; `lib/pipelines/engine.ts:222-249,281-294`). | Rework stores action execution snapshots and task-keyed, generation-numbered step checkpoints; no equivalent legacy `pipelineJson`/`resumeFromStep` chain is used (`du-rework/services/orchestrator/migrations/0001_platform_v1.sql:101-110`; `du-rework/services/orchestrator/src/modules/runtime/runtime.ts:424-481`). |
