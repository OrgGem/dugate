# Independent verification: tenant roster, usage, and connector suites

## Evidence

- Scope: `D:/Git/dugate/du-rework` only. No source, test, configuration, or product documentation files were edited. No live-gated suite was run; no PostgreSQL or Redis window is claimed.
- Working directory: `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`
- Node executable: `%TEMP%\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe`
- Node version: `v24.21.0`
- Command (one Jest process, all 15 suites):

```powershell
& $nodePath node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/tenant-list-cursor-codec-offline.test.ts tests/tenant-list-bff-offline.test.ts tests/f5-bff-tenant-cursor-offline.test.ts tests/f6-api-key-tenant-select-offline.test.ts tests/f2-overview-tenant-select-offline.test.ts tests/f4-component-tenant-select.test.ts tests/usage-drilldown.test.ts tests/usage-aggregation.test.ts tests/usage-contracts-integration-offline.test.ts tests/admin-connector-render.test.ts tests/admin-connector-view-model.test.ts tests/bff-connectors-actions.test.ts tests/p745-connector-actions.test.ts tests/p745-connector-boot-composition.test.ts tests/p745-connector-management-proxy.test.ts
```

`$nodePath` was set to the Node executable above. Captured immediately after Jest: `REAL_EXIT=0`.

Literal Jest summary from the log after removing CRLF and ANSI formatting:

```text
Test Suites: 15 passed, 15 total
Tests:       215 passed, 215 total
Time:        4.867 s, estimated 7 s
```

## Results

All requested groups passed in the same run:

- Tenant roster: 6 suites passed.
- Usage: 3 suites passed.
- Connector: 6 suites passed.
- Failures: none. There are no failing test names or expected/received values to report.

The live-gated suites `migrations.test.ts`, `usage-summary.test.ts`, `artifact-grant-fencing.test.ts`, `artifacts-fencing-pg`, and `liveSuites` were not run and are not counted as passing.

## Evidence files and gaps

Raw Jest output: `du-rework/coordination/reports/raw/verify-tenant-usage-connector-INDEPENDENT-CODEX4-2026-10-09/jest-15-suites.log`. PowerShell captured this log as UTF-16LE; the UTF-8 inspection copy is `jest-15-suites-utf8.log`. Its last lines were inspected with `tail`, `sed` (ANSI/CR cleanup), and `cat -v`.

No test failures or other verification gaps were found within the 15 requested offline suites. Live-gated behavior remains unverified by this run.

No gate was ticked. No commit, staging, or push was performed.
