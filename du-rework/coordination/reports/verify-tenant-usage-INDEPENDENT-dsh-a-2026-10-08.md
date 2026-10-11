# Independent offline verification — tenant roster, usage 422, connector known IDs

RESUME POINT: FINISHED — four requested commands and code observations are recorded; command 2 did not discover tests.

Scope: du-rework only. Read-only verification; offline only.

## Commands and results

All requested commands used `D:\Git\dugate\du-rework\orchestrator\services\orchestrator` as the starting cwd unless noted.

### 1. Tenant roster suites

Command: `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/tenant-list-bff-offline.test.ts tests/tenant-list-cursor-codec-offline.test.ts tests/f2-overview-tenant-select-offline.test.ts`

Exit code: `0`.

Literal output:

```text
{"subsystem":"admin-shell","timestamp":"2026-10-08T05:59:19.534Z","level":"warn","service":"orchestrator","version":"unknown","environment":"test","correlationId":"400a016d-ac24-4908-b14b-1cd592856cd8","operationId":null,"taskId":null,"invocationId":null,"message":"[admin-shell] admin web mount enabled but bundle is missing"}

Test Suites: 3 passed, 3 total
Tests:       20 passed, 20 total
Snapshots:   0 total
Time:        2.562 s, estimated 3 s
Ran all test suites matching tests/tenant-list-bff-offline.test.ts|tests/tenant-list-cursor-codec-offline.test.ts|tests/f2-overview-tenant-select-offline.test.ts.
```

### 2. Usage screen suites

Both requested paths exist: `tests/usage-screen-offline.cjs` and `tests/f7-overview-usage-tile-offline.cjs`.

Command: `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/usage-screen-offline.cjs tests/f7-overview-usage-tile-offline.cjs`

Exit code: `1`.

Literal output:

```text
No tests found, exiting with code 1
Run with `--passWithNoTests` to exit with code 0
In D:\Git\dugate\du-rework\orchestrator\services\orchestrator
  276 files checked.
  testMatch: **/*.test.ts - 263 matches
  testPathIgnorePatterns: admin-action-rbac-live\.test\.ts$, admin-audit\.test\.ts$, admin-base-routes\.test\.ts$, admin-error-boundary\.test\.ts$, admin-shell-live-pane\.test\.ts$, artifact-grant-fencing\.test\.ts$, artifacts-fencing-pg\.test\.ts$, blob-wire-binary\.test\.ts$, ingress-bounded\.test\.ts$, migrations\.test\.ts$, operation-tenant-fence\.test\.ts$, runtime\.test\.ts$, usage-summary\.test\.ts$, webhook-reclaim-fence\.live\.test\.ts$, workspace-reference\.test\.ts$ - 261 matches
  testRegex:  - 0 matches
Pattern: tests/usage-screen-offline.cjs|tests/f7-overview-usage-tile-offline.cjs - 0 matches
```

Jest did not discover or execute a test for this command. No alternate invocation was attempted.

### 3. Orchestrator typecheck

Command: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`

Exit code: `0`; literal output: *(no output)*.

### 4. Admin web typecheck

Starting cwd: `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`; effective cwd: `D:\Git\dugate\du-rework\orchestrator\apps\admin-web`.

Requested command: `cd ../../apps/admin-web && pnpm --filter @du/admin-web typecheck`

Executed in PowerShell as: `Set-Location ../../apps/admin-web; pnpm --filter @du/admin-web typecheck`

Exit code: `0`.

Literal output:

```text
../../..                                 |  WARN  Unsupported engine: wanted: {"node":">=24.21.0 <25"} (current: {"node":"v22.16.0","pnpm":"10.18.3"})
../../../businesses/document-core        |  WARN  Unsupported engine: wanted: {"node":">=24.21.0 <25"} (current: {"node":"v22.16.0","pnpm":"10.18.3"})
../../../businesses/example-review       |  WARN  Unsupported engine: wanted: {"node":">=24.21.0 <25"} (current: {"node":"v22.16.0","pnpm":"10.18.3"})
../../../businesses/lc-checker           |  WARN  Unsupported engine: wanted: {"node":">=24.21.0 <25"} (current: {"node":"v22.16.0","pnpm":"10.18.3"})
.                                        |  WARN  Unsupported engine: wanted: {"node":">=24.21.0 <25"} (current: {"node":"v22.16.0","pnpm":"10.18.3"})
../../packages/connector-client          |  WARN  Unsupported engine: wanted: {"node":">=24.21.0 <25"} (current: {"node":"v22.16.0","pnpm":"10.18.3"})
../../packages/contracts                 |  WARN  Unsupported engine: wanted: {"node":">=24.21.0 <25"} (current: {"node":"v22.16.0","pnpm":"10.18.3"})
../../packages/document-kit              |  WARN  Unsupported engine: wanted: {"node":">=24.21.0 <25"} (current: {"node":"v22.16.0","pnpm":"10.18.3"})
../../packages/egress                    |  WARN  Unsupported engine: wanted: {"node":">=24.21.0 <25"} (current: {"node":"v22.16.0","pnpm":"10.18.3"})
../../packages/observability             |  WARN  Unsupported engine: wanted: {"node":">=24.21.0 <25"} (current: {"node":"v22.16.0","pnpm":"10.18.3"})
../../packages/worker-sdk                |  WARN  Unsupported engine: wanted: {"node":">=24.21.0 <25"} (current: {"node":"v22.16.0","pnpm":"10.18.3"})
../../services/connector                 |  WARN  Unsupported engine: wanted: {"node":">=24.21.0 <25"} (current: {"node":"v22.16.0","pnpm":"10.18.3"})
../../services/orchestrator              |  WARN  Unsupported engine: wanted: {"node":">=24.21.0 <25"} (current: {"node":"v22.16.0","pnpm":"10.18.3"})
../../../tests/browser                   |  WARN  Unsupported engine: wanted: {"node":">=24.21.0 <25"} (current: {"node":"v22.16.0","pnpm":"10.18.3"})
../../../tests/integration               |  WARN  Unsupported engine: wanted: {"node":">=24.21.0 <25"} (current: {"node":"v22.16.0","pnpm":"10.18.3"})
../../../tests/login                     |  WARN  Unsupported engine: wanted: {"node":">=24.21.0 <25"} (current: {"node":"v22.16.0","pnpm":"10.18.3"})

> @du/admin-web@0.0.0 typecheck D:\Git\dugate\du-rework\orchestrator\apps\admin-web
> tsc --noEmit -p tsconfig.json
```

## Code review

(b) `orchestrator/services/orchestrator/src/modules/admin-read/tenant-list.ts:131-133`: the cursor subquery appends `AND id = ${scopeBind}` when `scopeBind !== null`; platform scope (`null`) omits it. The scope predicate is present.

(c) `orchestrator/services/orchestrator/src/app/admin/overview-section-renderer.ts:281-289`: `inRoster` is computed with `tenantOptions.some((tenant) => tenant.id === tenantId)`. The placeholder is selected when `inRoster` is false, including an empty/failed roster. The guard is present.

Additional source-only checks related to the lane title: `src/app/admin/bff/operations.ts:216-226` returns 422 `INVALID_SCHEMA` for empty platform usage scope before constructing/calling upstream; `src/http/routes/admin.ts:581` sets `knownConnectorIds` to `Object.keys(connectorBaseUrls ?? {})`. These paths were read, not exercised by the commands above. Existing tests were located by search, but no extra suites were run.

## Conclusion

There was no assertion failure in command 1, orchestrator typecheck, or admin-web typecheck. Command 2 exited `1` with `No tests found`; therefore the requested usage-screen suites were not executed. Overall result: **FAIL / incomplete offline verification**, not a clean offline result. The code observations above do not replace the missing test execution. No DB window was used or claimed, and no gate was changed.
