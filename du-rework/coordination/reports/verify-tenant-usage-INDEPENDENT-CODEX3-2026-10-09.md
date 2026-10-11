# Independent tenant and usage verification — Codex 3

Scope: `du-rework` only. Offline checks only; no PostgreSQL or Redis was started and no DB window is claimed.

Working directory for all commands: `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`  
Node executable: `$env:TEMP/du-node24-security-c025dd92/node-v24.21.0-win-x64/node.exe`  
Each invocation reported `v24.21.0` from `node -v` (exit 0). Each test command ran in its own Node process; `REAL_EXIT` was captured immediately from `$LASTEXITCODE`.

| Command | Literal result | REAL_EXIT | Verdict |
|---|---|---:|---|
| `& $node24 node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/tenant-list-cursor-codec-offline.test.ts tests/tenant-list-bff-offline.test.ts tests/f5-bff-tenant-cursor-offline.test.ts tests/f6-api-key-tenant-select-offline.test.ts tests/f2-overview-tenant-select-offline.test.ts tests/f4-component-tenant-select.test.ts` | `Test Suites: 6 passed, 6 total`; `Tests: 36 passed, 36 total` | 0 | GREEN — tenant roster |
| `& $node24 node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/usage-drilldown.test.ts tests/usage-aggregation.test.ts tests/usage-contracts-integration-offline.test.ts` | `Test Suites: 3 passed, 3 total`; `Tests: 31 passed, 31 total` | 0 | GREEN — usage |
| `& $node24 tests/tenant-select-offline.cjs` | `PASS: real TenantSelect element tree — 8 scenarios (names-not-ids, state suffix, unknown value, loading/failed/empty/cycle/multi-page)` | 0 | GREEN — tenant-select harness |

No test failed. The harness reported all eight scenario lines as `ok`; its complete output is in [03-tenant-select-harness.log](raw/verify-tenant-usage-INDEPENDENT-CODEX3-2026-10-09/03-tenant-select-harness.log). Jest raw output is in [01-tenant-roster.log](raw/verify-tenant-usage-INDEPENDENT-CODEX3-2026-10-09/01-tenant-roster.log) and [02-usage.log](raw/verify-tenant-usage-INDEPENDENT-CODEX3-2026-10-09/02-usage.log).

No source, test, config, or docs file was edited. No gate was ticked. No `git add`, commit, or push was performed.
