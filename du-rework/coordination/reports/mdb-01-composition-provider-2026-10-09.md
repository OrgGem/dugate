# MDB-01 composition provider

Scope: `du-rework` only. No commit, `git add`, or push. No PostgreSQL or Redis was started and no database window is claimed. WT-01 was not run.

## Changes

- `orchestrator/services/orchestrator/scripts/ldba-context-provider.cjs:3-39` adds the context callback contract. Until a domain policy is approved, connector, profile, workflow-schema, and FileCache callbacks throw `CONTEXT_POLICY_REQUIRED`; local-user migration throws `PASSWORD_RESET_REQUIRED`.
- `orchestrator/services/orchestrator/scripts/ldba-03-production-adapter.cjs:5-13,158-185,695-701` defaults to that provider when the env path is unset, validates required callbacks, and converts module-load failures to the stable `CONTEXT_MODULE_LOAD_FAILED` adapter error. `loadContextProvider` is exported for offline verification.
- `orchestrator/services/orchestrator/src/app/bootstrap/create-app.ts:127-179` adds `registerLdb03ContextProvider`, which resolves and validates the module, then publishes its absolute path as `LDBA03_CONTEXT_MODULE`.
- `orchestrator/services/orchestrator/src/main.ts:19,231-233` registers the provider before other boot work.
- `orchestrator/services/orchestrator/tests/mdb-01-composition-provider.test.ts:24-53` adds two offline cases: composition and adapter load the same provider object, and an explicitly missing module fails closed.

## Fail-first evidence

Working directory: `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`

Command:

```text
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/mdb-01-composition-provider.test.ts
```

Exit code: `1`.

Literal RED excerpts:

```text
FAIL tests/mdb-01-composition-provider.test.ts
TypeError: composition.registerLdb03ContextProvider is not a function
Expected asymmetric matcher: ObjectContaining {"code": "CONTEXT_MODULE_LOAD_FAILED", "name": "AdapterConfigurationError"}
Received name:    "Error"
Test Suites: 1 failed, 1 total
Tests:       2 failed, 2 total
```

## Verification

Runtime: `node -v` returned `v24.21.0` (exit 0).

Focused offline suite, run after implementation:

```text
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/mdb-01-composition-provider.test.ts
```

Exit code: `0`.

Literal summary:

```text
Test Suites: 1 passed, 1 total
Tests:       2 passed, 2 total
Snapshots:   0 total
```

Offline adapter and runner regression:

```text
node --test tests/ldba-03-production-adapter.test.cjs tests/ldba-03-backfill-offline.test.cjs
```

Exit code: `0`. Literal summary: `tests 27`, `pass 27`, `fail 0`, `skipped 0`.

Backend typecheck:

```text
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

Exit code: `0`; no output.

From `D:/Git/dugate/du-rework`, `git diff --check -- orchestrator/services/orchestrator/scripts/ldba-03-production-adapter.cjs orchestrator/services/orchestrator/src/app/bootstrap/create-app.ts orchestrator/services/orchestrator/src/main.ts` exited `0`.

## Residual boundary

This closes the missing-provider and composition-registration gap. It does not make the legacy data transforms cutover-ready: the built-in provider deliberately fails closed for callbacks without approved domain policy implementations. Connector preparation, profile mapping, workflow-schema preparation, FileCache reading/token/purpose policy, and legacy-user rehash still require their separately approved implementations. No live database behavior was tested.

No files outside the MDB-01 lease were changed for this task. No gate was ticked.
