# Receipt — Codex Wave 3, W3 (Findings 1, 3, 5)

| Field | Value |
|---|---|
| Packet | `FOLLOWUP-CODEX-WAVE3-W3` (P1) |
| Worker | `dsh_3` (DeepSeek Harness, `deepseek-v4.1-flash`) |
| Status | **COMPLETE** — tsc 0, live 60/60, offline 61/61, three negative controls each fail their own test |
| Files changed | `src/modules/operations/submission.ts`, `src/modules/operations/retry.ts`, `tests/pc-r02-workflow-execution-pins.test.ts` |

## Finding 1 — payload wrapping (`submission.ts`)

`taskPayloadValue` chose the legacy `{ input, legacyWorkflowSchema }` carrier when a
compiled pin existed. PC-R02 made that true for **v2 workflow members** too, and the
function catalog marks every non-Core action (e.g. `example-review`) as kind
`workflow`, so a plain handler would have received a carrier it never reads.

The discriminator is now the **route**, not the pin: the carrier is used only when
`ctx.legacyProjection` is present — the legacy workflow engine's own marker. A v2
workflow member still persists the compiled identity on the operation columns; its
handler gets the effective input map directly.

Test: submits through a v2 workflow member and opens the sealed task payload —
asserts `workflow_schema_slug` is persisted **and** the payload has no
`legacyWorkflowSchema` (and no `input` wrapper).

## Finding 3 — defaults snapshot divergence (`submission.ts`)

`buildProfileResolutionV2` read the tenant-defaults snapshot for the fingerprint, and
admission read it **again** for sealing. A concurrent settings publish between the two
reads would store defaults the fingerprint never covered.

`ResolvedAdmission.tenantDefaults` now carries the snapshot forward
(`undefined` = not forwarded / v1 path, `null` = forwarded with no snapshot), and both
admission-time reads prefer it. The preflight context, which has no resolved admission,
keeps its own read.

Test: a call-counted `globalSettings` fake returns snapshot A for the first two reads
(preview, submit-time resolution) and a divergent snapshot B for any third. Asserts the
sealed `tenant_defaults_ref` opens to **A** and that exactly **two** reads happened.

## Finding 5 — replay after expired input (`retry.ts`)

The coalesced-replay answer sat after carrier preparation, so a second click returned
`RETRY_INPUT_UNAVAILABLE` whenever the original input had expired — even with a valid
execution already in flight.

A guarded fast path now runs right after the preflight authorization: a cheap probe for
an in-flight retry, and if one exists, `replayCoalescedRetryUnderLock` takes the full
lock prefix in order (group → business → key → grant → operation), **reauthorizes under
those locks**, and only then returns the replay. Revoked grants still deny immediately
(this is not a return to PC-R03's unlocked replay). Preparation still happens outside
the locks when no retry exists, so the common path keeps its short lock hold.

Test: retry #1 succeeds, the original's `root_task_id` is cleared (the input is now
genuinely unavailable), retry #2 must return execution #1 as `replayed: true`.

## Verification

| # | Command (cwd `services/orchestrator`) | Result |
|---|---|---|
| 1 | `tsc --noEmit -p tsconfig.json` | **exit 0** |
| 2 | `DU_LIVE_INFRA=1` on pc-r02 + pc-r08 + cutover matrix | **60 passed, 3 suites** |
| 3 | unit config on the 6 v2/retry suites | **61 passed, 6 suites** |
| 4 | Control F1: carrier predicate back to `workflowPin` | **1 failed** (Finding 1 test) |
| 5 | Control F3: admission re-reads instead of forwarding | **1 failed** (Finding 3 test) |
| 6 | Control F5: fast path disabled | **1 failed** — `HttpError: original request input is unavailable` |

Each finding has exactly one test that fails when its fix is reverted, so none of the
three is a coincidence of the shared fixture.

## Residual notes

1. The Finding 5 fast path duplicates the lock-prefix ordering (it calls the same four
   lock helpers). That is deliberate: sharing the whole tail with the main path would
   mean holding authority locks across the crypto/artifact preparation.
2. The idempotency request hash still folds `ctx.workflowSchemaPin` when present. That is
   unchanged by this packet and consistent because a v2 submit forwards the same pin on
   first submission and replay.
