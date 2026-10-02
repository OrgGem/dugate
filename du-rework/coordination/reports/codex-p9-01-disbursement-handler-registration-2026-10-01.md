# D3 — Disbursement handler registration

Date: 2026-10-01

## Result

Registered `disbursement` as a real document-core handler kind. The manifest declares the kind and the worker exports a handler function for it; the handler validates the versioned input and required connector bindings, executes the workflow through SDK continuation primitives, and fails with a coded non-retryable error when a required slot, connector result, approval evidence, or final result is missing or invalid. Successful completion writes a validated result artifact; failure does not fabricate an output artifact or a terminal cancellation state.

The action output schema now describes the completed disbursement result. The handler test covers classify/extract child spawning, human approval wait and resume, successful result artifact creation, missing connector binding, connector failure, missing evidence, and rejected approval.

## Registration assertions and scope

- `businesses/document-core/src/manifest/document-core.manifest.ts`: exact action list remains the original six actions plus `disbursement`; runtime handler kinds include `disbursement`.
- `businesses/document-core/tests/manifest.test.ts`: exact expected manifest action list is now seven entries, including `disbursement`.
- `businesses/document-core/tests/sdk-consumer.test.ts`: exact declared handler-kind list is now eight entries and checks that every declared kind resolves to a function in the business handler map.
- `businesses/document-core/tests/worker.test.ts`: exact registered handler key list now includes `disbursement`.
- Recipe/traceability total remains 31. The six-action fail-closed matrix and the 31-entry corpus/traceability expectations were not changed.

The existing `test.failing` case at `tests/manifest.test.ts:147` was left in place. It removes `root`, adds an unknown action, and also adds that action name to `handlerKinds`; before `disbursement` was registered, the remaining manifest action without a kind made validation return false, so the assertion unexpectedly succeeded and Jest reported “Failing test passed even though it was supposed to fail.” With `disbursement` registered, all action names in that mutated manifest have a kind, validation returns true, and the case's `expect(...).toBe(false)` fails as the test intends; `test.failing` treats that expected failure as green.

## Verification

Focused command, run from `businesses/document-core`:

```text
npx jest --runInBand --runTestsByPath tests/manifest.test.ts tests/sdk-consumer.test.ts tests/missing-variants.test.ts tests/p9-01-disbursement-registration.test.ts tests/disbursement-handler.test.ts tests/worker.test.ts
Test Suites: 6 passed, 6 total
Tests:       43 passed, 43 total
Exit code: 0
```

Full document-core suite, run from `businesses/document-core`:

```text
npx jest --runInBand
Test Suites: 3 failed, 52 passed, 55 total
Tests:       4 failed, 850 passed, 854 total
Exit code: 1
```

The four remaining test failures match the supplied baseline failure set: Redis claim timeout in `tests/bullmq-smoke.test.ts:298`, missing F8 fixture cases `DOC-02-06`, `DOC-03-06`, and `DOC-03-07` in `tests/all-variants-e2e.test.ts:377`, and the missing F8 corpus entry in `tests/corpus-regression.test.ts:248`. No D3-specific test remains red; the full suite is at the baseline failure count and has 850 passing tests.

Typechecks, all exit code 0:

```text
businesses/document-core: npx tsc --noEmit -p tsconfig.json
businesses/document-core: npx tsc --noEmit -p tsconfig.test.json
services/orchestrator: npx tsc --noEmit
```

## Files changed for D3

- `businesses/document-core/src/manifest/document-core.manifest.ts`
- `businesses/document-core/src/worker.ts`
- `businesses/document-core/tests/manifest.test.ts`
- `businesses/document-core/tests/sdk-consumer.test.ts`
- `businesses/document-core/tests/worker.test.ts`
- `businesses/document-core/tests/p9-01-disbursement-registration.test.ts`
- `businesses/document-core/tests/disbursement-handler.test.ts` (new)

No release gate was changed.
