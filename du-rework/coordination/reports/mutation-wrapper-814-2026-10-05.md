# MUTATION-WRAPPER-814 — 2026-10-05

Task `task_95c4a231793d`, dispatch `ctx_8baae16235b7`. Mutation verification only: no product source or test file was edited, no commit was made, and no task checkbox was changed.

## Result

Both protection paths are covered by tests that turn red when their bypass is restored. The wrapper bypass mutation produced **3 failing tests out of 11**; disabling both envelope-recognition decisions used by `assertReadableWithoutSeam` produced **4 failing tests out of 24** across the wrapper and reader suites. After restoring the isolated copies, 24/24 tests passed; the unmodified working-tree source also passed the same 24 tests under the standard Jest configuration.

## Mutations and observed failures

All mutations were applied to a temporary copy of `services/orchestrator/src` and resolved into the existing test suite using a temporary Jest mapper.

| Mutation | Observed RED tests | Why the tests failed |
|---|---:|---|
| Restored the old `openMetadata` no-seam bypass by removing its `assertReadableWithoutSeam(value)` call while leaving `return value` | 3/11; exit 1 | Sealed TEXT and JSONB values resolved as raw values instead of `KEY_PROVIDER_FAILED`; the shared-wrapper/reader assertion also saw `RESOLVED` from the wrapper. Eight tests stayed green. |
| Reverted both envelope-detection decisions called by `assertReadableWithoutSeam`: serialized JSON TEXT (`looksLikeEnvelope(JSON.parse(value))`) and already-parsed JSONB (`looksLikeEnvelope(value)`) both returned false | 4/24; exit 1 | The wrapper’s sealed TEXT and JSONB no-seam tests and shared-rule test failed, and the direct `readStoredText` no-seam test failed because the sealed TEXT value resolved instead of throwing `KEY_PROVIDER_FAILED`. Twenty tests stayed green. |

The failures distinguish each representation: the TEXT-specific assertion catches the string parsing decision, and the JSONB assertion catches the parsed-object decision. The direct reader assertion independently proves that the reader path enforces the same guard; the wrapper assertions prove the wrapper cannot bypass it.

## Baseline and restoration evidence

Before mutation, the wrapper suite passed 11/11 and the reader regression suite passed 13/13. After restoring both temporary copies from the current source files, the combined suite passed 24/24. The standard command against the working-tree source also passed 24/24:

```text
pnpm exec jest --runInBand --verbose tests/wrapper-fix-812.test.ts tests/bypass-fix-810.test.ts
Test Suites: 2 passed, 2 total
Tests:       24 passed, 24 total
Exit code:   0
```

SHA-256 was captured before the test and after cleanup. The values are identical; restored temporary-copy hashes also matched the current source hashes:

| File | Before | After |
|---|---|---|
| `src/modules/runtime/runtime.ts` | `092DD4D90B4C33F822401223BF95FC477A9E22C15E33A1DB9E021C8AD998FD03` | `092DD4D90B4C33F822401223BF95FC477A9E22C15E33A1DB9E021C8AD998FD03` |
| `src/modules/runtime/metadata-crypto.ts` | `CD912689722585607DF6217E2F9FBA86C08B0F313312A45A44EF6C27D8236A9C` | `CD912689722585607DF6217E2F9FBA86C08B0F313312A45A44EF6C27D8236A9C` |

The source files were already modified in the shared worktree before this task; these hashes prove the task preserved those exact starting bytes. The temporary source tree, both temporary Jest configs, and the failed external harness directory were removed. No mutation was staged or sent to a reusable branch.

## Scope limits

This is an offline unit-level mutation check with the deterministic local key-provider test double. It proves test sensitivity for wrapper and reader control flow, not the deployed build, production Vault access, or live database policy. No live-only check was run or needed for these mutations.
