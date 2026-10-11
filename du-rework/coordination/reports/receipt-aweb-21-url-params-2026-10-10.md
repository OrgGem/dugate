# Receipt: AWEB-21 Trace and Audit URL parameters

Date: 2026-10-11  
Task: AWEB-21-TRACE-AUDIT-DEEP-LINK-QUERY-2026-10-10  
Scope: `du-rework`  
Canonical plan: `coordination/reports/survey-workflows-connectors-2026-10-10.md`, sections 5.2 and W-B

## Existing implementation checked

- Trace reads `operationId`, `correlationId`, `taskId`, and `tenantId` from the URL. The identifier initializes the lookup type and field; an available requested tenant is selected only from the signed-in session tenant list. Trace requires the operator to submit the populated lookup.
- Audit reads tenant, severity, action, actor, resource, time bounds, sort, and page size. It applies URL-derived filters on page load. An `operationId` becomes the supported `operation:<id>` resource filter.
- Both screens rehydrate after URL query changes and retain tenant fencing. Invalid or unavailable tenant context blocks data access.
- Audit retains `correlationId` as visible context because the current Audit API does not expose that filter. Trace can prefill the lookup, but the current API does not support correlation-ID lookup.
- No product files were changed in this run; the implementation and dedicated hydration test were already present in the shared tree.

## Verification

- Command: `node --test tests/deep-link-query-hydration.test.mjs`
- Working directory: `du-rework/orchestrator/apps/admin-web`
- Result: PASS, 8 tests, 1 suite, 0 failures, exit code 0.
- Additional check: `npm run typecheck` returned exit code 1 due to six existing diagnostics in `src/features/profiles/api-keys-panel.tsx` and `src/features/profiles/profile-keys.ts`: missing `ProfileApiKeyPage` and `ProfileApiKeyRow` exports, plus two implicit-any parameters. These paths are outside the Trace and Audit task scope.
- No git add, commit, or push was performed. No gate was ticked.
