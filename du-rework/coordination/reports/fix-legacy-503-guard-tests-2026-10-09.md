# Legacy workflow 503 guard tests

Scope: test-only change in `orchestrator/services/orchestrator/tests/legacy-http-mount.test.ts`. Working directory for Jest: `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`. Node: `v24.21.0` (`C:\Users\Gem\AppData\Local\Temp\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe`). No live PostgreSQL or Redis was used.

## Added cases

- Line 256: POST `/api/v1/docs/workflows` with `host({})` (no `submitLegacyWorkflow`) asserts the legacy 503 type, title, status and detail, and echoes `x-correlation-id` in `body.correlationId`.
- Line 280: POST `/api/v1/docs/workflows/schema` with `host({})` (no `resolveLegacyWorkflowSchema`) asserts the 503 response and deployment-unavailable detail.
- Line 297: configured schema resolver throws `SCHEMA_CRYPTO_UNAVAILABLE`; the test asserts the mapped 503 response and temporary-unavailable detail.

## Verification

Each Jest run used a separate process. `$node24` resolved to `C:\Users\Gem\AppData\Local\Temp\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe`; `node -v` returned `v24.21.0`. The exit value was captured immediately after each Jest invocation with `$REAL_EXIT = $LASTEXITCODE`.

| Run | Command | Literal Jest summary | REAL_EXIT |
|---|---|---|---:|
| Initial focused run | `& $node24 node_modules/jest/bin/jest.js --runInBand --config jest.unit.cjs --config jest.unit.config.cjs tests/legacy-http-mount.test.ts` | `Test Suites: 1 passed, 1 total`; `Tests: 35 passed, 35 total` | 0 |
| Case 3 mutation probe | Same command, while the test fixture temporarily threw `SCHEMA_CRYPTO_MUTATION` instead of `SCHEMA_CRYPTO_UNAVAILABLE` | `Test Suites: 1 failed, 1 total`; `Tests: 1 failed, 34 passed, 35 total` | 1 |
| Restored run | Same command after restoring `SCHEMA_CRYPTO_UNAVAILABLE` | `Test Suites: 1 passed, 1 total`; `Tests: 35 passed, 35 total` | 0 |
| Final post-restore run | Same command and Node path | `Test Suites: 1 passed, 1 total`; `Tests: 35 passed, 35 total` | 0 |

The mutation made case 3 fail on the response assertion. Jest reported:

```text
Expected: detail "Workflow schema storage is temporarily unavailable.", status 503, title "Service Not Available", type "https://dugate.vn/errors/service-not-available"
Received: detail "The request could not be completed (correlationId ).", status 500, title "Internal Error", type "https://dugate.vn/errors/internal-error"
```

The test file SHA256 before the mutation was `4EFE1219BA7F961CE2F0D7342A6E9BA2BF597AE5461C6F1741E868A28623A360`; after restoring the fixture it was the same. The final run also passed after restoration. Raw output is in `coordination/reports/raw/fix-legacy-503-guard-tests-2026-10-09/` (`01-focused-green.log`, `02-case3-mutation-red.log`, `03-restored-green.log`, `04-final-focused-green.log`).

One attempt to invoke the node path unquoted as `$env:TEMP/du-node24-...` stopped at the PowerShell parser and did not run Jest. The successful runs used the quoted/resolved path above.

## Scope and residual coverage

The three specified 503 branches are now pinned. Other legacy-route failure branches were not inventoried, so this does not claim exhaustive 503 coverage. No product source, plan, or `docs/21-openapi.json` was changed. No gate was ticked; no `git add`, commit, or push was performed.

The test-file diff contains 62 added lines and removes one trailing blank line at EOF; none of the prior test cases or assertions was removed or weakened.
