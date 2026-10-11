# Independent verification — RV01 cursor fence and MED1 migration ledger

Date: 2026-10-09  
Scope: `du-rework` only. Offline verification; no PostgreSQL/Redis started and no DB window claimed.

## Runtime

Before the test commands, from `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`:

| Command | Exit code | Literal output |
|---|---:|---|
| `node -v` | 0 | `v22.16.0` |

## Required commands and results

| # | cwd | Exact command | Exit code | Literal test/compiler result |
|---:|---|---|---:|---|
| 1 — RV01 cursor fence | `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/rv01-loopback-http-offline.test.ts` | 0 | `Test Suites: 1 passed, 1 total`<br>`Tests: 48 passed, 48 total` |
| 2 — MED1 object drift | `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/med1-migration-ledger-object-drift.test.ts tests/med1-verify-migrations-object-drift.test.ts` | 0 | `Test Suites: 2 passed, 2 total`<br>`Tests: 13 passed, 13 total` |
| 3 — migrations and ledger guard | `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/migrations.test.ts tests/migrations-ledger-guard.test.ts` | 0 | `Test Suites: 1 passed, 1 total`<br>`Tests: 17 passed, 17 total` |
| 4 — public upload encryption gateway | `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/public-upload-encryption-gateway.test.ts` | 0 | `Test Suites: 1 passed, 1 total`<br>`Tests: 12 passed, 12 total` |
| 5 — backend typecheck | `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | 0 | Empty output; no diagnostics. |
| 6 — admin-web typecheck | `D:/Git/dugate/du-rework/orchestrator/apps/admin-web` | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | 0 | Empty output; no diagnostics. |

The Jest summaries above are literal. The executed suites account for 90 passing tests total.

## RED and skipped/live-gated status

- RED: **KHÔNG CÓ** in the suites that were collected and executed; all four Jest commands exited `0`.
- `tests/migrations.test.ts` was supplied to command 3 but was **not collected** by `jest.unit.config.cjs`: it is listed in that config’s `liveSuites` ignore patterns (`migrations\\.test\\.ts$`, line 18). The one passing suite / 17 passing tests in command 3 are not evidence that `migrations.test.ts` passed. It was not run with the live Jest config.
- No other skipped count was reported in the executed suite summaries. No live suite was run.

## Conclusion

The collected offline RV01, MED1 drift, ledger-guard, and public-upload suites passed, as did both requested typechecks. The migrations integration suite remains live-gated and unverified by this run. No source, test, config, or OpenAPI file was modified. No `.env.live` file was read. No commit, staging, push, or gate change was performed.
