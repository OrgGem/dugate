# RCR Runtime Independent Diagnostics — 2026-10-05

Scope: read-only follow-up on RCR-02, RCR-04, and RCR-05 for the current checkout. The source editor still owns the runtime source lease; this report makes no product-source, contract, migration, test, or coordination-state changes. The reviewed source still has the RCR paths described below (runtime.ts last write observed 2026-10-05 01:25 local; no newer source edit was visible during the fresh read).

## RCR-02 — spawn/wait do not enforce the live lease at mutation time

`spawnChildren` in `services/orchestrator/src/modules/runtime/runtime.ts:941` locks the task and reads `lease_epoch`/state, then checks only terminal state and epoch (`:950-978`). It does not select the expiry or business identity. Exact existing-child replay is intentionally checked before the `RUNNING` gate (`:981-1025`), preserving retries after the parent moves to `WAITING_CHILDREN`; genuinely new child rows and outbox deliveries are then written (`:1058-1096`). The final parent transition is an unconditional `UPDATE tasks ... WHERE id=$1` (`:1110-1113`) and its row count is ignored. Natural lease expiry does not change the epoch or release the row lock, so an expired worker can still commit new children and transition the parent.

The HTTP route authenticates the task at `http/routes/runtime.ts:449-453`, but discards the `workerBusinessId` returned by `assertTaskRuntimeAuth` and does not pass an identity into the service. That route check is a separate pre-transaction read; the service write path lacks the same-business fence used by other runtime mutations.

`waitInput` has the same gap (`runtime.ts:1178-1201`): it locks the task and checks epoch/state but reads no expiry or business id. Existing wait replay is intentionally before the `RUNNING` gate (`:1209-1227`). A new wait is inserted and the task is moved to `WAITING_INPUT` with an unconditional update and no row-count check (`:1235-1262`). The route at `http/routes/runtime.ts:469-473` likewise discards the authenticated business id.

Minimal fence shape: preserve existing replay behavior for a fully persisted, matching replay after expiry; for any new mutation, require the same business identity, current epoch, `RUNNING`, and `lease_expires_at > clock_timestamp()` in a write-side CAS. Keep all child/dependency/outbox/wait/task/operation writes in one transaction and throw `LEASE_LOST` if the final task transition affects zero rows so the transaction rolls back all earlier inserts. The initial check improves error reporting; the database-clock predicate on the state-changing write closes expiry between read and write. Do not require a live lease for a no-write replay, but retain epoch and business identity checks.

Coverage currently present: `tests/runtime-lease-fencing-offline.test.ts` exercises expired/current-epoch rejection, wrong business, stale epoch, and write-race rollback for heartbeat, completion, failure, and saveStep. It does not exercise spawn/wait. Existing `runtime.test.ts` exercises normal fan-out and human-wait flows behind the live-infrastructure guard; it does not cover expiry before recovery or expiry between read and write for these two endpoints.

## RCR-04 — SaveStep contract default is bypassed

The contract at `packages/contracts/src/runtime.ts:170-176` already defines `SaveStepRequestSchema`, including `status: z.enum(['SUCCEEDED', 'FAILED']).default('SUCCEEDED')`. The HTTP route (`http/routes/runtime.ts:405-413`) passes `ctx.body as never`, and the service at `runtime.ts:657-707` accepts a handwritten body type and never parses it. Therefore the default is not applied: omission reaches INSERT parameter `$6` as `undefined` even though `step_checkpoints.status` is NOT NULL with a database default. Because the SQL explicitly includes the status column, PostgreSQL sees NULL and rejects the write. Invalid enums, missing required fields, and out-of-range epochs can also cross this boundary to fail later than the contract requires.

Use the shared schema’s parsed result at the service boundary (before opening a transaction) and use only `parsed.data` for all downstream values. The existing `zodIssuesToProblem` helper already maps contract issues to the 422 `INVALID_SCHEMA` problem shape. This preserves the contract default and prevents any SQL on invalid requests. `packages/contracts/tests/dto.test.ts` has DTO validation coverage with explicit status and missing required data, but no assertion that omitted status parses to `SUCCEEDED`; the service/write path has no focused offline regression for this default.

## RCR-05 — `sessionRef` exists on the wire contract but is dropped at persistence/readback

The shared contract exposes optional nullable `sessionRef` on both `SaveStepRequestSchema` (`packages/contracts/src/runtime.ts:170-176`) and `CheckpointRefSchema` (`:42-50`). The SDK consumes the field: `packages/worker-sdk/src/connector-session.ts:286-322` falls back to a prior checkpoint value and calls `step.run(..., { sessionRef })`; `packages/worker-sdk/src/task-context.ts:350-375` sends it on save and keeps it in the local checkpoint. The runtime save signature omits it and the INSERT only names `output_ref` and `status` (`runtime.ts:657-707`). Claim projection selects only `step_key`, `generation`, `input_hash`, `status`, and `output_ref` (`:1817`), then constructs objects without `sessionRef` (`:1824-1840`). Thus the consumer’s restart fallback receives no persisted value.

`output_ref` already uses the runtime metadata encryption seam before storage and is opened during claim (`runtime.ts:689-704`, `:1820-1840`; `modules/runtime/metadata-crypto.ts:44-62`). A provider session reference can contain a continuation credential, so the durable field needs the same at-rest protection and authenticated readback. The additive shape that best fits the current code is a nullable `step_checkpoints.session_ref` JSONB column, a distinct `step_checkpoints.session_ref` metadata slot, seal-before-insert, and claim-time open under tenant/slot/row context. Bind the envelope to the full checkpoint primary key (`taskId:stepKey:generation`); the existing `output_ref` binding omits generation, but that weaker pattern should not be copied to a new field. No backfill is needed for absent historical values; preserve null/omitted compatibility and fail closed if an envelope cannot be opened.

The initial read-only diagnosis flagged generation ordering as a contract caveat: claim had no ORDER BY, while the SDK's step.peek uses checkpointList.find(stepKey). After root traced this consumer path (task-context.ts:378, connector-session.ts:293-294), root directed the minimal deterministic fix: sort by step key and descending generation while keeping every generation in the existing wire array. That narrow addition is included below; no SDK or shared-contract change was needed.

The current migration sequence ended at 0031_prompt_overrides_ref.sql. The implementation receipt below records the released 0032 migration and the completed source changes.

## Implementation receipt — 2026-10-05

Status: IMPLEMENTED; candidate frozen for independent verification. The implementation followed the released RCR-RUNTIME lease and preserved all pre-existing dirty worktree content. No contract, SDK, global coordination ledger, existing shared test, or verifier-owned test file was edited by this lane.

RCR-02: spawn and wait now read the DB-clock lease state and business identity under the task lock. Both routes pass their authenticated worker business id into the service. Business id and epoch are checked before replay; fully durable matching child/wait replays still return without requiring a live lease. New work requires RUNNING plus an active lease before inserts. The final parent-task transition uses a DB-clock expiry, state, epoch, and business-id CAS; a zero-row result raises LEASE_LOST inside the transaction and rolls back all tentative child, dependency, outbox, or wait rows. Non-RUNNING new requests retain STATE_CONFLICT.

RCR-04: saveStep parses the existing SaveStepRequestSchema before opening a transaction and uses only parsed values. The existing default now persists SUCCEEDED; malformed or incomplete requests map to 422 INVALID_SCHEMA without database writes.

RCR-05: migration 0032 adds nullable step_checkpoints.session_ref JSONB. The existing sessionRef fields in the shared request and checkpoint contracts were reused unchanged. Defined references are sealed under the new step_checkpoints.session_ref slot with AAD bound to tenant, slot, task id, step key, and generation; claim opens and type-checks the value. Omitted values stay SQL NULL and are projected as null, while explicit null is persisted as JSON null or a sealed null; both remain compatible with the optional nullable contract and SDK. Claim now orders by step_key and generation descending, retaining all generations; this narrow addition follows the consumer path at task-context.ts:378 and connector-session.ts:293-294, where the SDK selects the first checkpoint for a step. The historical output_ref AAD was not changed.

Released product write set:

- services/orchestrator/src/modules/runtime/runtime.ts
- services/orchestrator/src/http/routes/runtime.ts
- services/orchestrator/src/modules/runtime/metadata-crypto.ts (additive slot only)
- services/orchestrator/migrations/0032_checkpoint_session_ref.sql
- coordination/reports/rcr-runtime-luna-2026-10-05.md (this receipt)

No test file was authored by this lane. The verifier-owned rcr-luna-verification.test.ts and runtime-encryption-metadata.test.ts were refreshed separately; they are not part of this lane's write set.

Final product SHA-256:

- runtime.ts — ACB476FD3079E6F3FDBF4B81BB54F5FE0B5B2F07679BB72AB47C73664BC09138 (95120 bytes)
- http/routes/runtime.ts — 8A4209F370B4BEDCA8C24C52AC5D1B08F7D5D59EE9AC72184F7C53D3A9CA5602 (24341 bytes)
- metadata-crypto.ts — C614ECDCFDA50EAC79A29EAC2098B92CB3BBA77280D90DDEC6F3A815A4A602A1 (14499 bytes)
- 0032_checkpoint_session_ref.sql — 69A9CC6BEA5DF9A999546AB5BB98A43EE1A1A0C3835BE5D7E8C6AEE72788E55E (142 bytes)

Focused verification (cwd: services/orchestrator):

    pnpm exec tsc --noEmit -p tsconfig.json
    exit 0; no output

    pnpm exec jest --runInBand --runTestsByPath tests/runtime-lease-fencing-offline.test.ts
    Test Suites: 1 passed, 1 total
    Tests:       33 passed, 33 total
    Snapshots:   0 total
    Time:        5.61 s

    pnpm exec jest --runInBand --runTestsByPath tests/enc-meta-sentinel-runtime-refs.test.ts
    Test Suites: 1 passed, 1 total
    Tests:       10 passed, 10 total
    Snapshots:   0 total
    Time:        6.75 s, estimated 8 s

    pnpm exec jest --runInBand --runTestsByPath tests/rcr-luna-verification.test.ts tests/runtime-encryption-metadata.test.ts
    Test Suites: 2 passed, 2 total
    Tests:       122 passed, 122 total
    Snapshots:   0 total
    Time:        5.423 s

    git diff --check -- [released product source paths]
    no whitespace errors; Git printed only LF-to-CRLF advisory notices for runtime.ts and metadata-crypto.ts

Limits: checks were offline and used the existing scripted runtime and metadata harnesses. No PostgreSQL migration execution, Vault, Redis, provider, production, live integration, commit, or push was performed. This receipt is owner evidence; independent verification and review remain separate gates.
