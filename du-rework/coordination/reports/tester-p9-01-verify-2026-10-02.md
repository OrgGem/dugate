# P9-01 independent verification — 2026-10-02

Read-only verification against the current working tree. No source/test files
were edited, no shared DB/Redis/S3 was used, and P9-01 was not ticked.

## Commands and raw results

Working directory for all commands: `D:\Git\dugate\du-rework\businesses\document-core`.

### Requested disbursement suites

Command:

```text
npx jest --runInBand --runTestsByPath tests/p9-01-disbursement.test.ts tests/p9-01-disbursement-registration.test.ts
```

Exit code: **0**. Jest output:

```text
Test Suites: 2 passed, 2 total
Tests:       49 passed, 49 total
Snapshots:   0 total
Time:        2.033 s
Ran all test suites within paths "tests/p9-01-disbursement.test.ts", "tests/p9-01-disbursement-registration.test.ts".
```

### Current manifest-test status (additional check for the PARTIAL claim)

Command:

```text
npx jest --runInBand --runTestsByPath tests/manifest.test.ts
```

Exit code: **0**. Jest output:

```text
Test Suites: 1 passed, 1 total
Tests:       15 passed, 15 total
Snapshots:   0 total
Time:        2.219 s
Ran all test suites within paths "tests/manifest.test.ts".
```

This does not reproduce the two `manifest.test.ts` failures described in the
historical P9-01 follow-up. The current test at `tests/manifest.test.ts:28-38`
expects seven actions including `disbursement`. The two negative cases at
`:147-155` and `:157-162` remain explicitly marked `test.failing`; the suite's
current aggregate is nevertheless 15/15 passed.

### Typechecks

Both commands ran from the same CWD and emitted no diagnostics:

| Command | Exit code |
|---|---:|
| `npx tsc --noEmit -p tsconfig.json` | 0 |
| `npx tsc --noEmit -p tsconfig.test.json` | 0 |

## Claim comparison

| Claim | Independent observation |
|---|---|
| Continuation set is exactly `spawn-children`, `wait-for-input`, `terminate` | **Verified.** The union is `DisbursementContinuation = SpawnChildren \| WaitForInput \| Terminate` at `src/pipelines/workflows/disbursement/primitives.ts:36-70`; a join is represented as input (`JoinSubmission`), not as a fourth continuation. Emissions are visible at `disbursement.ts:551`, `:579`, `:609`, `:619`, and `:670`. |
| Fan-out is bounded | **Verified.** The hard ceiling is 8 at `primitives.ts:15-16`; requested concurrency is clamped in `fanout.ts:18-22` and bounded workers are used at `:40-64`. Both classify and extract continuations cap the requested value at `disbursement.ts:551-555` and `:579-583`. |
| Human approval is a real workflow gate | **Verified in code.** The workflow yields `wait-for-input` after extraction (`disbursement.ts:598-615`); a false approval terminates with `FAILED` (`:617-625`). The host resume schema defines `approved` as boolean and requires it (`worker.ts:1125-1150`); business validation also checks the explicit boolean (`disbursement.ts:384-391`). When encrypted evidence is required but no encryption seam is available the workflow refuses the approval wait (`disbursement.ts:600-606`; host check `worker.ts:1105-1109`). |
| “NOT wired to the platform” / zero dispatch in `worker.ts`, `main.ts`, and `server.ts` | **Not verified; contradicted by current code.** `worker.ts:1393-1406` registers `disbursement` in `documentCoreHandlers` and passes the map with the manifest to `defineBusiness`; `worker.ts:1415-1418` starts that definition through `startWorker`. The SDK dispatches a queue job by `job.kind` into `definition.handlers[job.kind]` at `packages/worker-sdk/src/worker.ts:298-302`. The host maps spawn and wait continuations at `businesses/document-core/src/worker.ts:1083-1127`, and calls `advanceDisbursement` at `:1229-1237`. `main.ts:39-51` starts the generic document-core worker. A literal `rg -n "disbursement" services/orchestrator/src/server.ts` returned no matches; that does not negate the worker-side handler/queue dispatch. The manifest comment at `document-core.manifest.ts:241-242` still says host dispatch wiring is pending, which conflicts with these current worker paths. |
| PARTIAL because two new failures remain in `manifest.test.ts` | **Not reproduced.** The current manifest suite passes 15/15, and the current action-list assertion includes `disbursement` (`manifest.test.ts:28-38`). |

The registration suite also passes all four tests. It asserts the manifest action,
workflow recipe/step IDs and public export (`tests/p9-01-disbursement-registration.test.ts:8-75`).

## Verdict

**VERIFIED=No** for the composite PARTIAL/not-wired claim as stated in the
dispatch spec: the 49 targeted tests and both typechecks pass, but the stated
manifest failures are absent on this build and worker-side host/queue dispatch
is present. This is not a claim of live deployment/provider verification; no
live queue/provider test was run. The specific unresolved item is that the
dispatch spec and older receipt wording are stale or inconsistent with the
current tree (including the stale manifest comment cited above). No P9-01 gate
was changed.
