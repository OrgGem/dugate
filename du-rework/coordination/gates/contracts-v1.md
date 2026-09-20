# Gate: contracts-v1 — **READY**

- Date: 2026-09-20
- Owner: Claude (platform lane)
- Package: `@du/contracts@0.1.0` (`du-rework/packages/contracts`)
- Wire contract version: `WIRE_CONTRACT_VERSION = '1'`, `SUPPORTED_WIRE_MAJORS = [1]`

## Evidence (actual commands + results, Windows / pnpm 9, Node 24)

```
cd du-rework/packages/contracts
npx tsc --noEmit -p tsconfig.json   → exit 0 (strict, noUncheckedIndexedAccess)
pnpm test                           → Test Suites: 5 passed, 5 total
                                      Tests: 70 passed, 70 total
```

Suites: `manifest.test.ts` (REG-01..04: digest determinism, mutation, contract-major rejection,
network-$ref rejection, schema size limits), `state-machine.test.ts` (operation/task transition
tables), `queue.test.ts` (BusinessJobV1 strict payload, queue naming rules, job ID stability),
`hashing-errors.test.ts` (canonical request hash, RFC 9457 problem docs), `dto.test.ts`
(runtime/connector/public/sdk DTOs).

## How to consume

- pnpm workspace install at `du-rework/` root resolves `@du/contracts@workspace:*`.
- Import from the package root: `import { ... } from '@du/contracts'`.
  The barrel `src/index.ts` re-exports every module; build output is `dist/` (CJS + .d.ts).

## Module map (exports for consumer lanes)

| Module | Key exports (selection) |
|---|---|
| `version.ts` | `WIRE_CONTRACT_VERSION`, `SUPPORTED_WIRE_MAJORS`, `SCHEMA_LIMITS`, `RETENTION_DEFAULTS` |
| `errors.ts` | `ProblemSchema`, `problem()`, `STATUS_CODES`, `PublicErrorCodes`, `RuntimeErrorCodes`, `ConnectorErrorCodes` |
| `manifest.ts` | `BusinessManifestSchema`, `ActionManifestSchema`, `ConnectorSlotManifestSchema` (field: `acceptedCapabilities: string[]`), `BusinessStatus`, `RegistrationRecordSchema` |
| `manifest-validator.ts` | `validateManifest()`, `hashManifest()`, `canonicalize()`, `queueNameFor()` |
| `json-schema-guard.ts` | `validateJsonSchema()` — no network `$ref`, size/depth/property budget |
| `operations.ts` | `OperationStates`, `TaskStates`, `InvocationStates`, `OPERATION_TRANSITIONS`, `TASK_TRANSITIONS`, `canTransition()`, `isTerminalOperationState()`, `OperationViewSchema`, `OperationDetailSchema`, `ResultEnvelopeSchema`, `UsageSchema`, `ArtifactRefSchema`, `SubmissionSchema` (strict), `CORRELATION_ID_REGEX`, `IDEMPOTENCY_KEY_REGEX` |
| `runtime.ts` | **Connector lane wire types** → `InvocationGrantRequestSchema`, `InvocationGrantSchema`, `InvocationGrantClaimsSchema`, `UsageEventSchema`, `UsageIngestBatchSchema`, `UsageIngestAckSchema`; **SDK/orchestrator** → `ClaimTaskRequestSchema`, `ClaimResultSchema`, `ExecutionSnapshotSchema`, `CheckpointRefSchema`, `SaveStepRequestSchema`/`SaveStepAckSchema`, `SpawnChildrenRequestSchema`/`AckSchema` (joinPolicy literal `'all-success'`), `WaitInputRequestSchema`/`AckSchema`, `CompleteTaskRequestSchema`, `FailTaskRequestSchema`, `TaskReportAckSchema`, `WorkerHeartbeatSchema`, `HeartbeatAckSchema` `{health, leaseExpiresAt, capacity}`, `TaskHeartbeatAckSchema` `{leaseExpiresAt, cancelRequested}`, artifact grant/finalize/access schemas, `LEASE_DEFAULTS` `{leaseMs: 60_000, heartbeatIntervalMs: 15_000}` |
| `queue.ts` | `BusinessJobV1Schema` (strict: contractVersion/deliveryId/taskId/operationId/businessId/businessVersion/action/kind/correlationId), `businessQueueName()` → `du-business-{id}-{exactVersion}`, `jobIdForDelivery()` → `du-{deliveryId with : folded to -}`, `QUEUE_NAME_REGEX`, `QUEUE_TRANSPORT_RETRY` |
| `connector.ts` | `InvocationRequestSchema` (strict: contractVersion/invocationId/grant/operationId/taskId/stepKey/bindingSlot/input/options?/sessionRef?/deadlineAt), `InvocationResponseSchema` (state ∈ NEW/IN_FLIGHT/PENDING/SUCCEEDED/FAILED/UNKNOWN/CANCELLED), `InvocationInputSchema` (strict — no credential fields accepted), `ConnectorCapabilitySchema` |
| `sdk.ts` | `TaskDispositionSchema` (completed `{resultRef: string}`, waiting-children, waiting-input `{waitId}`, retry-scheduled), `JoinPolicies`, `RetryClassificationSchema` |
| `public-api.ts` | `SubmitAckSchema`, `PageQuerySchema`, `pageOf()`, `WebhookPayloadSchema` (strict), `WebhookEventTypes`, `WEBHOOK_SIGNATURE_HEADER`/`TIMESTAMP`/`DELIVERY` constants, `webhookSigningPayload()`, `ArtifactMetadataSchema`, `PublicBusinessActionSchema` |
| `hashing.ts` | `canonicalRequestHash()`, `contentHash()`, `normalizeRouteAction()` |

## Conventions frozen at v1

1. **Money/usage**: integer micro-USD (`costMicrousd`), integer token counts, `measurement` ∈ measured/estimated, `eventId` dedup. No floats on the wire.
2. **IDs**: taskId/operationId are UUIDs; `resultRef` is a **string** (artifact URI), completion carries `resultHash = contentHash(resultRef)`.
3. **Leasing**: every runtime write carries `leaseEpoch`; 409 `LEASE_LOST` → abort, 410 → task terminal. `LEASE_DEFAULTS` 60s lease / 15s heartbeat.
4. **Queue**: `du-business-{businessId}-{exactVersion}` only — no floating tags; stable job id `du-{deliveryId}` (`:` folded to `-`; BullMQ rejects `:` in custom job IDs); at-least-once transport; business retry budget is runtime-owned.
5. **Errors**: RFC 9457 `application/problem+json`, `type: urn:du:error:{code_lowercase}`.
6. **Join policy v1**: `'all-success'` only. Spawn = persist children+dependency atomically, parent yields its slot; resume is a fresh delivery.
7. **Checkpoints**: SUCCEEDED + matching `inputHash` → replay stored output, never re-execute; mismatch → 409 `INPUT_HASH_MISMATCH`.

## Known limits / notes for consumers

- `ConnectorSlotManifestSchema` uses `acceptedCapabilities: string[]` (**not** a single `capability` string).
- `defaultLimits` supports `maxParallelTasks`/`timeoutSeconds` only — there is **no** `maxRetries` field (runtime owns retry budget).
- `BusinessManifestSchema` is non-strict (unknown keys stripped); digest computed over declared fields after canonicalization.
- Root install applies two pnpm overrides to unblock peer manifests without editing peer files:
  `@types/mammoth → empty-npm-package` (deprecated stub package; mammoth ships its own types — Antigravity should drop the dep) and `pdf-lib@^1.17.9 → ^1.17.1` (requested version does not exist on npm).

## Change policy after READY

Post-READY edits require: impact note in this gate, updated consumer fixtures, and prior notice to lane owners in `coordination/requests/*`. No breaking wire edits within major '1'.

### Change log

- **2026-09-20 — `ProblemSchema.correlationId` widened** (non-breaking). Was `z.string().uuid()`; now `^[A-Za-z0-9._-]{8,128}$` to match `CORRELATION_ID_REGEX`. Rationale: the orchestrator echoes client-supplied correlation IDs into `application/problem+json`; a non-UUID client token previously failed response parse. All previously valid values (UUIDs) still parse — consumers need no change. Contracts suite still 70/70.
- **2026-09-20 — `jobIdForDelivery()` fixed to a BullMQ-legal ID** (breaking in form, zero consumer impact). Was `du:{deliveryId}`; BullMQ 5 rejects custom job IDs containing `:` (Redis key separator), so the convention was unexecutable on the pinned queue. Now `du-{deliveryId}` with `:` folded to `-` (retry deliveryIds `taskId:retry:N` → `du-taskId-retry-N`). Determinism and injectivity preserved for our deliveryId charset. Verified zero consumers outside the orchestrator dispatcher (grep across connector/connector-client/document-core/document-kit/worker-sdk src: 0 hits). Contracts suite 70/70, worker-sdk 23/23, orchestrator runtime slice 6/6.
