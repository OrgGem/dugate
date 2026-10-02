# CONV-06 independent verification

Read-only verification of `codex-conv06-impl-2026-10-02.md`; no source/test edits, gate ticks, or commits.

## Primitive and adapters

- `packages/worker-sdk/src/bounded-fanout.ts` has no imports, so it has no business, DB, network, or external scheduler dependency. `runBoundedFanout` uses only in-process Promise workers.
- `resolveFanoutConcurrency` rejects non-finite inputs to 1, floors requested and hard-limit values, falls back to 1 for non-positive values, and otherwise returns their minimum (`bounded-fanout.ts:21-27`). For the adapters' hard cap of 8 this yields concurrency in `[1, 8]`; when an invalid cap is below 1, the deliberate fallback is 1.
- The executor claims indices in a shared local counter, writes each outcome at that input index, waits for all workers, and uses `Array.from` for final materialization (`bounded-fanout.ts:43-80`). Per-child `try/catch` stores an error outcome and continues the worker loop; siblings survive. Empty input returns `[]`. For sparse slots, `Array.from` visits missing outcome slots and emits `CHILD_NOT_SCHEDULED` (`:73-80`). These behaviors are also covered by `packages/worker-sdk/tests/bounded-fanout.test.ts:15-88`.
- Public SDK exports are present at `packages/worker-sdk/src/index.ts:2-3`.
- Both adapters retain their local `MAX_FANOUT_CONCURRENCY = 8` and `ChildTaskSpec`/`ChildOutcome` types (`businesses/document-core/src/pipelines/workflows/disbursement/primitives.ts:16-28`, `businesses/lc-checker/src/primitives.ts:27-42`). Each keeps a `resolveConcurrency` wrapper and delegates to the shared executor (`disbursement/fanout.ts:19-37`, `lc-checker/fanout.ts:18-36`). No cross-business import exists in either adapter/primitives (`rg` returned no matches for `document-core`/`lc-checker`).
- Durable call-site files `businesses/document-core/src/pipelines/workflows/disbursement/disbursement.ts`, `businesses/lc-checker/src/lc-checker.ts`, and `businesses/lc-checker/src/worker.ts` have empty `git diff` (exit 0). Existing fan-out call sites remain at `disbursement.ts:697` and `lc-checker.ts:736`; LC's durable `spawnAndWait` remains at `worker.ts:423`.

## Tests and typechecks

| Check | Working directory | Result | Exit |
|---|---|---|---:|
| `pnpm --filter @du/worker-sdk test` | `D:\Git\dugate\du-rework` | 24 suites; 650 passed / 650 total | 0 |
| `pnpm --filter @du/document-core test` (`DU_LIVE_INFRA` unset) | `D:\Git\dugate\du-rework` | 58 suites; 924 passed, 1 skipped / 925 total | 0 |
| `node ..\document-core\node_modules\jest\bin\jest.js --runInBand` (`NODE_PATH=..\document-core\node_modules`) | `D:\Git\dugate\du-rework\businesses\lc-checker` | 6 suites; 118 passed / 118 total | 0 |
| `pnpm --filter @du/worker-sdk exec tsc --noEmit -p tsconfig.json` | `D:\Git\dugate\du-rework` | clean | 0 |
| `pnpm --filter @du/document-core exec tsc --noEmit -p tsconfig.json` | `D:\Git\dugate\du-rework` | clean | 0 |
| `node ..\document-core\node_modules\typescript\bin\tsc --noEmit -p tsconfig.json` | `D:\Git\dugate\du-rework\businesses\lc-checker` | clean | 0 |

All expected totals reproduced. Suites ran sequentially; document-core passed on its first run, so no flake rerun was needed. The implementation receipt's earlier parser-budget timeout occurred when worker-sdk and document-core ran concurrently; this verification did not reproduce it.

## Verdict

The primitive, wrappers, local cap/type retention, and unchanged durable call sites match the implementation receipt. All three full suites and typechecks pass with the expected counts. No claim failed to reproduce.
