# CONV-06 PREP — bounded-fanout primitive decision evidence

Date: 2026-10-02  
Mode: read-only characterization; no source/test edits, no suite runs, no gate changes.

## Verdict

**Feasible, with a narrow boundary:** the in-process queue-index executor can be a pure generic Worker SDK primitive. The two business `ChildTaskSpec` types have the same fields and their stage types are domain-specific unions; their `ChildOutcome` shapes and per-child failure conversion are structurally identical. Keep each business's input validation, hard-ceiling value, workflow failure policy, stage diagnostics, join checks, and typed continuation local. The SDK's current `spawnAndWait` is a separate durable queue operation and is not a substitute for this local executor. Evidence: the two type declarations and fanout implementations (`businesses/document-core/src/pipelines/workflows/disbursement/primitives.ts:13-34,36-70`, `businesses/lc-checker/src/primitives.ts:24-45,47-73`, `businesses/document-core/src/pipelines/workflows/disbursement/fanout.ts:12-81`, `businesses/lc-checker/src/fanout.ts:12-78`) versus the SDK durable facade (`packages/worker-sdk/src/types.ts:175-194`, `packages/worker-sdk/src/task-context.ts:429-450`).

## Comparison

| Dimension | Document-core disbursement | LC-checker | Compatibility / boundary |
|---|---|---|---|
| Child spec | `{ childId: string, stage: DisbursementStage, input: TInput }`; stages are `classify`, `extract`, `crosscheck`, `report` (`businesses/document-core/src/pipelines/workflows/disbursement/primitives.ts:13,18-23`). | `{ childId: string, stage: LcCheckerStage, input: TInput }`; stages are `ocr`, `screen`, `visual`, `adjudicate`, `report` (`businesses/lc-checker/src/primitives.ts:24,29-34`). | Same structural identity/input shape; only the stage union is business-owned. A generic executor can preserve each concrete spec type without importing either business (`businesses/document-core/src/pipelines/workflows/disbursement/fanout.ts:40-44`, `businesses/lc-checker/src/fanout.ts:39-43`). |
| Outcome | `childId`, `status: succeeded | failed`, optional `payload`, optional `{code,message}` error (`businesses/document-core/src/pipelines/workflows/disbursement/primitives.ts:25-34`). | The same fields, optionality, and status values (`businesses/lc-checker/src/primitives.ts:36-45`). | Exact structural match. Both executors emit payload only on success, and error only on failure (`businesses/document-core/src/pipelines/workflows/disbursement/fanout.ts:55-60`, `businesses/lc-checker/src/fanout.ts:54-59`). The declared interface itself is not a discriminated union (`.../disbursement/primitives.ts:29-34`, `businesses/lc-checker/src/primitives.ts:40-45`). |
| Concurrency hard cap | `MAX_FANOUT_CONCURRENCY = 8` (`businesses/document-core/src/pipelines/workflows/disbursement/primitives.ts:15-16`). | `MAX_FANOUT_CONCURRENCY = 8` (`businesses/lc-checker/src/primitives.ts:26-27`). | Same current value, but it remains policy at each business boundary per CONV-06; an SDK helper should accept the cap or a caller-resolved concurrency rather than own a business policy (`tasks/CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md:81-83`). |
| Resolver semantics | Non-finite → 1; floor; values below 1 → 1; cap at 8 (`businesses/document-core/src/pipelines/workflows/disbursement/fanout.ts:17-23`). | Same (`businesses/lc-checker/src/fanout.ts:16-22`). | Resolver algorithm is shareable. Input validation is not: disbursement defaults missing/non-number values to 2, then resolves (`businesses/document-core/src/pipelines/workflows/disbursement/disbursement.ts:147-161`); LC-checker rejects non-number, fractional, or `<1` input before capping (`businesses/lc-checker/src/lc-checker.ts:181-204`). Preserve those entry semantics outside the shared primitive. |
| Queue-index loop and order | Shared `next` index; reserve index before awaiting; write result into `outcomes[index]`; await all workers; return array in input order (`businesses/document-core/src/pipelines/workflows/disbursement/fanout.ts:45-69,71-81`). | Same algorithm (`businesses/lc-checker/src/fanout.ts:44-68,70-78`). | Directly shareable. One child failure is caught and recorded so siblings continue (`businesses/document-core/src/pipelines/workflows/disbursement/fanout.ts:34-38,55-61`; `businesses/lc-checker/src/fanout.ts:33-37,54-61`). Empty specs yield `[]`: one worker is created by `Math.max(length, 1)`, immediately exits on missing spec, then the empty outcome array is returned (`.../disbursement/fanout.ts:49-54,64-81`; `businesses/lc-checker/src/fanout.ts:48-53,63-78`). |
| Error conversion / defensive slot | Preserve string `err.code`; otherwise use `CHILD_FAILED`; use `Error.message` or `String(err)` (`businesses/document-core/src/pipelines/workflows/disbursement/fanout.ts:25-32`). If a result slot was never filled, emit `CHILD_NOT_SCHEDULED` and `Fan-out slot was never executed` (`.../disbursement/fanout.ts:71-80`). | Same conversion (`businesses/lc-checker/src/fanout.ts:24-31`) and same `CHILD_NOT_SCHEDULED` fallback (`businesses/lc-checker/src/fanout.ts:70-76`). | Common mapping can be shared without a domain error taxonomy. The `unknown-${index}` expressions use different syntax but produce the same fallback identifier (`.../disbursement/fanout.ts:74-80`; `businesses/lc-checker/src/fanout.ts:70-76`). Existing focused tests cover sibling survival, order, caps, fractions, and `NaN` at `businesses/document-core/tests/p9-01-disbursement.test.ts:209-255` and `businesses/lc-checker/tests/lc-checker.test.ts:210-254`. |
| Business diagnostics and failure policy | Join token/count checks use `CHILD_RESULT_MISMATCH` / `CHILD_RESULT_INCOMPLETE` (`businesses/document-core/src/pipelines/workflows/disbursement/disbursement.ts:223-233,302-320`). `applyFailurePolicy` throws `ALL_CHILDREN_FAILED` for zero successes and `CHILD_RESULT_MISMATCH` for partial failure under `fail-closed`; `continue-on-partial` keeps partial results (`.../disbursement.ts:409-430`). | Join checks have the same broad error codes but LC-specific stage/token wording (`businesses/lc-checker/src/lc-checker.ts:318-355`). Visual failures are retained as request/reason records (`.../lc-checker.ts:290-303,608-620`); OCR `fail-closed` rejects only when no document succeeded, then records per-file failures for surviving cases (`.../lc-checker.ts:532-554`). | Keep all these behaviors in the business workflows. The shared mapper ends at per-child outcome creation; it must not decide whether partial success is acceptable or construct workflow diagnostics. |
| Continuation contract | `DisbursementContinuation` includes `spawn-children`, `wait-for-input`, and `terminate` (`businesses/document-core/src/pipelines/workflows/disbursement/primitives.ts:36-70`). | `LcCheckerContinuation` includes `spawn-children` and `terminate`; the file explicitly says no human-wait continuation exists for this workflow (`businesses/lc-checker/src/primitives.ts:10-13,47-73`). | Not a shared type. This difference does not block a helper that only accepts a spec array and returns per-child outcomes. |

## Worker SDK today and actual consumers

The Worker SDK fan-out helpers are durable runtime helpers: the module describes persisted child tasks, parent slot release, and polling (`packages/worker-sdk/src/fan-out.ts:19-29`). `spawnChild` posts to the runtime children endpoint and validates a durable acknowledgement (`packages/worker-sdk/src/fan-out.ts:92-147`); for a batch, `SpawnFacade.spawnAndWait` accepts `ChildTaskSpecInput {taskKey, kind, payload}` and `joinPolicy: 'all-success'` (`packages/worker-sdk/src/types.ts:175-194`). `DefaultTaskContext` hashes/maps those payloads, calls the runtime, and returns `waiting-children` (`packages/worker-sdk/src/task-context.ts:429-450`). These functions are exported from the package entry (`packages/worker-sdk/src/index.ts:57-79`). They do not implement the business-local queue-index mapper or return its `ChildOutcome[]` contract.

Both business-local functions are explicitly described as an in-process path for testability, with a real queue still possible (`businesses/document-core/src/pipelines/workflows/disbursement/disbursement.ts:687-697`, `businesses/lc-checker/src/lc-checker.ts:727-736`). Production adapters use the durable SDK path: disbursement maps child stage/id/input into a task payload before `spawnAndWait` (`businesses/document-core/src/worker.ts:1106-1125`); LC-checker maps children to task keys/kinds, saves workflow state, reports progress, and calls `spawnAndWait` (`businesses/lc-checker/src/worker.ts:409-423`). Thus extracting the local loop would deduplicate the in-process helper/test seam; it would not replace or alter production durable spawning.

## Possible API sketch — not frozen

One generic shape that avoids importing business-specific stage unions:

```ts
export interface FanoutChildIdentity {
  readonly childId: string;
}

export interface FanoutChildOutcome<TPayload = unknown> {
  readonly childId: string;
  readonly status: 'succeeded' | 'failed';
  readonly payload?: TPayload;
  readonly error?: { readonly code: string; readonly message: string };
}

export function resolveFanoutConcurrency(requested: number, hardLimit: number): number;

export function runBoundedFanout<
  TSpec extends FanoutChildIdentity,
  TPayload,
>(
  specs: readonly TSpec[],
  maxConcurrency: number, // resolved by the caller under its own input policy
  run: (spec: TSpec) => Promise<TPayload>,
): Promise<readonly FanoutChildOutcome<TPayload>[]>;
```

The signature is a sketch only. `resolveFanoutConcurrency` can take each business's hard cap (`8` today); business input validation/defaulting stays local. `runBoundedFanout` should preserve the current ordered-array, catch-per-child, error-code fallback, empty-array, and unscheduled-slot semantics. Keep domain failure policy and user-facing diagnostics after this return boundary. The exact public API and whether the outcome interface is exported or kept behind business aliases are owner-freeze questions.

## Candidate file/change matrix after interface freeze

| Area | Candidate changes | Preserve |
|---|---|---|
| Worker SDK | Add a pure executor module such as `packages/worker-sdk/src/bounded-fanout.ts`, export its API from `packages/worker-sdk/src/index.ts:1-79`, and add `packages/worker-sdk/tests/bounded-fanout.test.ts`. | No business imports, DB/Redis/network calls, runtime child scheduling, or stage/failure-policy rules. |
| Document-core | Replace local queue loop/resolver/error conversion in `businesses/document-core/src/pipelines/workflows/disbursement/fanout.ts:12-81` with a typed adapter; keep the business wrapper `runSpawnedChildren` (`.../disbursement.ts:687-697`), stage specs and continuation (`.../primitives.ts:13-23,36-70`), join/failure policy (`.../disbursement.ts:302-320,409-430`); adapt `businesses/document-core/tests/p9-01-disbursement.test.ts:209-255`. | Default concurrency 2, cap 8, disbursement diagnostics, partial-failure policy, and durable worker mapping. |
| LC-checker | Replace local executor/resolver in `businesses/lc-checker/src/fanout.ts:12-78`; keep its `runSpawnedChildren` wrapper (`businesses/lc-checker/src/lc-checker.ts:727-736`), stage specs/continuation (`businesses/lc-checker/src/primitives.ts:24-34,47-73`), strict input normalization (`businesses/lc-checker/src/lc-checker.ts:181-204`), join and OCR/visual behavior (`.../lc-checker.ts:318-355,532-554,608-620`); adapt `businesses/lc-checker/tests/lc-checker.test.ts:210-254`. | LC stage names, required positive-integer input, per-stage diagnostics, and outcome policy. |

## Owner-freeze questions and risks

1. Worker SDK owner: is a new public pure utility in `@du/worker-sdk` desired, or should the common function remain package-internal? Existing exports in `packages/worker-sdk/src/index.ts:57-79` are public API.
2. Both business owners: freeze whether the shared resolver takes a per-call hard limit (keeping `8` in each business) and whether existing optional `payload`/`error` fields must remain source-compatible (`businesses/document-core/src/pipelines/workflows/disbursement/primitives.ts:29-34`, `businesses/lc-checker/src/primitives.ts:40-45`).
3. Confirm the packet's benefit is deduplicating the in-process/testable executor, since production uses durable `spawnAndWait` (`businesses/document-core/src/worker.ts:1106-1125`, `businesses/lc-checker/src/worker.ts:409-423`). If the intended objective is to unify runtime scheduling, that is a separate interface and behavior decision.
4. Freeze behavior tests for empty arrays, concurrency normalization/cap, ordered results under out-of-order completion, one rejection without sibling cancellation, error code/message fallback, and missing-slot fallback. The current suites assert most core cases in `businesses/document-core/tests/p9-01-disbursement.test.ts:209-255` and `businesses/lc-checker/tests/lc-checker.test.ts:210-254`; neither suite was run for this prep task.

## Verification status

Read-only code inspection only. No test suites or typechecks were run, no source or test files were changed, and no gate was ticked.
