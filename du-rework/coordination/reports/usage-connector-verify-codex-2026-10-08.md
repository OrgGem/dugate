# Independent verification — usage 422 and connector knownConnectorIds

- Date: 2026-10-08 (Asia/Bangkok, UTC+7)
- Scope: `du-rework/` only
- Mode: read-only code review and tests; no product source/test edits, commit, or push
- Raw test transcript: `coordination/reports/raw/usage-connector-verify-codex-2026-10-08.txt`

## Test results

| Target | Command (cwd: `orchestrator/services/orchestrator`) | Exit | Result |
|---|---|---:|---|
| Usage 422 | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --silent tests/aweb06-bff-operations.test.ts` | 0 | 1 suite; 12 passed, 0 failed |
| Connector capabilities | same Jest options, `tests/admin-config-cockpit.test.ts` | 0 | 1 suite; 8 passed, 0 failed |
| Connector render | same Jest options, `tests/admin-connector-render.test.ts` | 0 | 1 suite; 16 passed, 0 failed |
| Connector BFF | same Jest options, `tests/bff-connectors-actions.test.ts` | 0 | 1 suite; 17 passed, 0 failed |
| Connector route/schema | same Jest options, `tests/p745-connector-management-proxy.test.ts` | 0 | 1 suite; 12 passed, 0 failed |

Connector test discovery used the requested `grep -rln 'knownConnectorIds' orchestrator/services/orchestrator/tests/`, which exited 1 because `grep` is unavailable in this PowerShell environment. Equivalent `rg -l 'knownConnectorIds' orchestrator/services/orchestrator/tests/` exited 0 and found the four files listed above; all four were run. No test was red or skipped in these runs.

## Code semantics checked

- `src/app/admin/bff/operations.ts:199-225` has one `usage` route branch. It validates `from`/`to`, resolves tenant scope, and returns 422 `INVALID_SCHEMA` with `usage requires a tenantId for platform sessions` when `scope === ''` at `:216-218`. URL construction and the only usage `callUpstream` are below that return at `:220-224`, so a platform request without `tenantId` cannot reach upstream.
- `src/modules/admin-actions/rbac.ts:71-82` returns the requested tenant for platform principals. For a tenant operator, an omitted query tenant resolves to the operator's own `principal.tenantId`; a foreign tenant is rejected. This preserves the intended tenant-session behavior while the platform's missing scope fails closed.
- `src/http/routes/admin.ts:573-583` returns `knownConnectorIds: Object.keys(ctx.config.connectorBaseUrls ?? {})`; no configured URL values, headers, or credentials are projected.
- The relevant schema is named `ConnectorCapabilitiesSchema` in this checkout (there is no `AdminCapabilitiesSchema` symbol). `orchestrator/packages/contracts/src/connector-management.ts:49-56` declares the four fields, `knownConnectorIds` as non-empty strings, and ends with `.strict()`.
- `tests/p745-connector-management-proxy.test.ts:175-200` injects a URL containing userinfo, a private host, and a query token. It asserts the exact ID-only response and checks the serialized response excludes `private.example` and `do-not-leak`.
- `tests/aweb06-bff-operations.test.ts:279-285` asserts the platform request gets 422 with the requested code/message and that the upstream stub has zero requests.

## Result

The requested behavior is verified by the focused tests and source inspection. The only command failure was the unavailable `grep` executable; its `rg` equivalent succeeded. All test commands exited 0. No product files were changed.
