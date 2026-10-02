# `CANCEL_REQUESTED` — rework code-path characterization

Read-only characterization from source and migration inspection. No tests were run, no source or test files were changed, and no gate or COMP row was edited. This report records where the value is declared, consumed, projected, or absent; it does not decide whether the contract or implementation is correct and does not propose a change.

## 1. Writes to operation state or in-memory state

**No implementation write of the operation state value `CANCEL_REQUESTED` was found in `du-rework/services/orchestrator/src/**`.** No in-memory state assignment to that value was found either. The exact search was `rg -n -F 'CANCEL_REQUESTED' du-rework/services/orchestrator/src du-rework/packages/contracts/src` (no file-extension restriction); the matches in orchestrator source are type declarations, filters, comparisons, UI/parser support, and projection logic listed below—not assignments. I separately searched operation SQL writers with `rg -n -i 'INSERT INTO operations|UPDATE operations' du-rework/services/orchestrator/src`; none of the state values written is `CANCEL_REQUESTED`.

Closest operation-state writes found by that writer scan:

| Writer | Persisted state behavior |
|---|---|
| `services/orchestrator/src/modules/operations/submission.ts:284-299` | Inserted operation state is selected from `PENDING_INGESTION` or `ACCEPTED`; `:474-478` advances `PENDING_INGESTION` to `QUEUED`. |
| `services/orchestrator/src/modules/operations/ingestion-consumer.ts:208-210` | Conditional operation write sets `FAILED` for the pending-ingestion failure path. |
| `services/orchestrator/src/modules/runtime/runtime.ts:341-344,568-570,628-630,673-675,863-864,986-988,1130-1133,1237-1240,1460-1461,1511-1513` | Operation state writes use `RUNNING`, `SUCCEEDED`, `RETRY_PENDING`, `FAILED`, `WAITING_CHILDREN`, `WAITING_INPUT`, or `QUEUED`. The associated SQL predicates also contain no `CANCEL_REQUESTED` assignment. |
| `services/orchestrator/src/modules/lifecycle/lifecycle.ts:42-45` | Cancel writes `state='CANCELLED'` and `cancel_requested=true` in one operation UPDATE. The boolean column is separate from the state value. |
| `services/orchestrator/src/modules/lifecycle/lifecycle.ts:73-78` | Deadline sweep writes `TIMED_OUT`. |

Thus the located cancellation write is `CANCELLED`, with the separate `cancel_requested` boolean set true; it is not a write of the `CANCEL_REQUESTED` enum value. This is a report of current source behavior only.

## 2. Read, compare, projection, and filtering sites

The table distinguishes explicit literal references from generic operation-state reads that would consume or branch on the value if a row already contained it.

| File and lines | Kind of use and behavior for `CANCEL_REQUESTED` |
|---|---|
| `services/orchestrator/src/modules/runtime/runtime.ts:182-187` | **Explicit compare.** `hasCancelSignal` returns true when `row.op_state === 'CANCEL_REQUESTED'` (also true for the separate boolean signal or `CANCELLED`). |
| `services/orchestrator/src/modules/runtime/runtime.ts:360-383,393-417` | **Read of cancel signal.** The lease-extension path loads `o.state AS op_state`, calls `hasCancelSignal`, and returns `cancelRequested: true` for this value; at `:394-400`, the atomic UPDATE predicate explicitly excludes it with `o.state <> 'CANCEL_REQUESTED'`. |
| `services/orchestrator/src/modules/runtime/runtime.ts:297-303` | **Generic terminal classification.** The operation terminal array contains `SUCCEEDED`, `FAILED`, `CANCELLED`, `TIMED_OUT`, not `CANCEL_REQUESTED`; a row with this state is not rejected by that terminal check. |
| `services/orchestrator/src/modules/runtime/runtime.ts:341-344` | **Generic conditional write filter.** The claim path's operation UPDATE allows only `ACCEPTED`, `QUEUED`, `WAITING_CHILDREN`, `WAITING_INPUT`, or `RETRY_PENDING`; it will not update a row whose state is `CANCEL_REQUESTED`. The preceding task-row write is separate (`:334-339`). |
| `services/orchestrator/src/modules/runtime/runtime.ts:1000-1032` | **Generic resume state read.** `resumeOperation` checks whether the state is one of the four terminal states; `CANCEL_REQUESTED` is not among them, so it passes this check. Later validation is against the state version, wait, and task (`:1028-1137`); there is no explicit `CANCEL_REQUESTED` branch. |
| `services/orchestrator/src/modules/runtime/runtime.ts:1321-1340` | **Raw read/pass-through.** `getOperation` and `getTenantOperation` return rows selected with `SELECT *`; the returned `state` is available to callers. |
| `services/orchestrator/src/modules/runtime/runtime.ts:522-523,563-565,609-610,1511-1518` | **Generic state projection in acknowledgements.** Replay/join/child paths select an operation's current `state` and return it as `operationState`; the final helper can return `CANCEL_REQUESTED` unchanged if that value is in the row. |
| `services/orchestrator/src/modules/operations/ingestion-consumer.ts:198-202,490-507` | **Explicit compare/filter.** The DB loader selects operation state as `opState`; the consumer skips/completes the delivery when the value is `CANCEL_REQUESTED` (or any other listed state), without opening the ingestion gate. |
| `services/orchestrator/src/modules/lifecycle/lifecycle.ts:32-40` | **Generic cancel-state read.** The service selects state and checks membership in `SUCCEEDED`, `FAILED`, `CANCELLED`, `TIMED_OUT`. `CANCEL_REQUESTED` is not included, so a row with that value is handled by the nonterminal path at `:42-66`, which writes `CANCELLED` directly. |
| `services/orchestrator/src/modules/lifecycle/lifecycle.ts:73-78` | **Deadline filter.** The sweep's `state IN (...)` list excludes `CANCEL_REQUESTED`; it does not select that state for transition to `TIMED_OUT`. |
| `services/orchestrator/src/modules/operations/facade.ts:13-24,66-84` | **Terminal/read behavior.** `isTerminal` excludes `CANCEL_REQUESTED`; `waitForTerminal` therefore continues polling while an operation remains in that state, until another terminal state or its wait deadline. |
| `services/orchestrator/src/modules/operations/facade.ts:32-50` | **Wire projection.** `toOperationView` copies `r.state` into the response `state` and progress message without remapping it. |
| `services/orchestrator/src/modules/operations/facade.ts:87-99` | **Result-status mapping.** The result status helper maps only `SUCCEEDED` to 200 and `TIMED_OUT` to 410; `CANCEL_REQUESTED` follows the default 409 branch. The route uses it at `services/orchestrator/src/server.ts:1929-1937`. |
| `services/orchestrator/src/server.ts:1782-1803,3184-3185`; `packages/contracts/src/public-api.ts:84-100` | **List filter.** The server applies the contract's `OPERATIONS_STATE_FILTER_WIRE_STATES`; its `RUNNING` group contains `CANCEL_REQUESTED`, so a RUNNING-filtered operations list includes rows with that state. |
| `services/orchestrator/src/server.ts:1832-1841`; `services/orchestrator/src/modules/operations/facade.ts:32-50` | **Detail projection.** Public detail loads the tenant-scoped row and passes it through `toOperationView`, which copies the state without normalization. |
| `services/orchestrator/src/modules/webhooks/webhooks.ts:33-46,59-82` | **Generic terminal check.** The webhook helper selects `op.state` and checks the four-state terminal list. `CANCEL_REQUESTED` is not in that list, so it does not schedule an event for that state. There is no `operation.cancel-requested` event in this event mapping. |
| `services/orchestrator/src/modules/usage/usage.ts:357-402`; `services/orchestrator/src/modules/usage/budget-reservations.ts:224-255` | **No state-specific use found.** The usage project queries usage-event rows; the budget scope query reads operation tenant/key/profile/business columns, not operation state. The exact-token search returned no `CANCEL_REQUESTED` match in usage modules. |
| `services/orchestrator/src/app/admin/operation-section-data.ts:416-429,480-485,909-925` | **Admin list parsing/filtering.** The RUNNING-group comment and contract-backed `STATE_FILTER_MATCH` include the value; `normaliseOperation` accepts it as a valid wire state. |
| `services/orchestrator/src/app/admin/operation-view-models.ts:121-149,362-380` | **Admin display/action model.** The label is “Cancel requested,” badge is `warning`; `canCancelOperation`'s explicit cancellable set excludes it. |
| `services/orchestrator/src/compat/legacy-operations.ts:13-27,102-109,126-163` | **Compatibility type/filter/projection.** The canonical union includes it; the legacy RUNNING filter group accepts it; `toLegacyOperationState` maps it to legacy `RUNNING`; `mapCanonicalOperationToLegacy` retains the canonical value in `metadata.canonical_state` and computes `done` from the terminal list (which excludes it). |

The exact-token search found no literal `CANCEL_REQUESTED` in `server.ts`, `lifecycle.ts`, `facade.ts`, `webhooks.ts`, or usage modules. Their generic state reads/filters are listed above where they have a defined effect on such a value. The server consumes the value indirectly through the contract-backed RUNNING filter and the shared view/result helpers.

## 3. Cancel route and lifecycle path

The public cancel route in `server.ts:2087-2094` resolves the caller's API key, calls `ctx.lifecycle.cancelOperation(id, tenantId)`, then returns 200 for replay or 202 otherwise. It contains no intermediate state update. The admin action path also delegates to the same service (`services/orchestrator/src/modules/admin-actions/dispatcher.ts:410-429`).

`lifecycle.cancelOperation` reads the current state and treats only `SUCCEEDED`, `FAILED`, `CANCELLED`, and `TIMED_OUT` as terminal (`lifecycle.ts:32-40`). For any other state—including a preexisting `CANCEL_REQUESTED` value—it writes `state='CANCELLED'` and `cancel_requested=true` in a single UPDATE (`:42-45`), then updates tasks/waits and schedules the terminal webhook (`:46-66`). **The located route/service path does not pass through an operation state of `CANCEL_REQUESTED`; it writes `CANCELLED` directly.**

## 4. Contract and wire-schema exposure

`CANCEL_REQUESTED` is not only a transition-table entry. It is in `OperationStates`, which defines `OperationState`, `OperationStateSchema`, and the `state` field of `OperationViewSchema` (`packages/contracts/src/operations.ts:11-27,129-147`). The operation transition table also names it as a destination from several active states and gives it outgoing transitions to `CANCELLED` and `TIMED_OUT` (`operations.ts:68-94`).

Other wire schemas accept the same enum: `TaskReportAckSchema.operationState` (`packages/contracts/src/runtime.ts:178-186`), `SubmitAckSchema.state` (`packages/contracts/src/public-api.ts:628-640`), and `WebhookPayloadSchema.state` (`public-api.ts:654-664`). The public operations filter also includes it in the RUNNING group (`public-api.ts:84-100`). The compatibility projection can carry it as `metadata.canonical_state` while exposing legacy `state: RUNNING` (`compat/legacy-operations.ts:126-163`).

Accordingly, source code permits the value in typed operation/wire state and can project it if a row already contains it; the application-state writer scan above found no current service writer that creates such a row.

## 5. Deadline sweep

`sweepDeadlines` updates only operations in `ACCEPTED`, `QUEUED`, `RUNNING`, `WAITING_CHILDREN`, `WAITING_INPUT`, or `RETRY_PENDING` whose deadline has passed (`lifecycle.ts:71-78`). `CANCEL_REQUESTED` is absent from that SQL predicate. Task and wait updates at `:81-94` operate only on ids returned by that predicate. The contract separately lists `CANCEL_REQUESTED -> TIMED_OUT` (`operations.ts:89`); the deadline-sweep query does not select that state.

## 6. Database column

The table is created in `services/orchestrator/migrations/0001_platform_v1.sql:36-55`; `operations.state` is `text NOT NULL DEFAULT 'ACCEPTED'` (`:43`). The column has no enum type or `CHECK` constraint in that table definition. A scan of `du-rework/services/orchestrator/migrations/**/*.sql` for operations state checks/constraints found no later constraint on `operations.state`; it is free text at the SQL-schema layer, subject to `NOT NULL` and application-level contracts. Migration `0003_artifacts_grants.sql:36-37` adds the separate `cancel_requested boolean NOT NULL DEFAULT false` column.

## Search boundary

Source searches used: `rg -n -F 'CANCEL_REQUESTED' du-rework/services/orchestrator/src du-rework/packages/contracts/src`; `rg -n -i 'INSERT INTO operations|UPDATE operations' du-rework/services/orchestrator/src`; and migration searches for operation state checks/constraints plus inspection of the `operations` table creation. No runtime tests, database queries, or live requests were performed.
