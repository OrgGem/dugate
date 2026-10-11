# Receipt: AWEB-21 Trace and Audit deep-link query

Date: 2026-10-10
Task: AWEB-21-TRACE-AUDIT-DEEP-LINK-QUERY-2026-10-10
Plan: `coordination/reports/survey-workflows-connectors-2026-10-10.md`, sections 5.2 and W-B
Scope: `du-rework`

## Delivered

- Trace reads `operationId`, `correlationId`, and `taskId` from the URL and populates the matching lookup type and value. It also reads `tenantId` and switches to that tenant only when it is present in the signed-in session tenant list. Invalid or unavailable tenant context blocks lookup rather than querying a different tenant.
- Audit hydrates its existing filters from URL parameters, including tenant, severity, action, actor, resource, time bounds, sort, and page size. An `operationId` becomes the supported `operation:<id>` resource filter, including links emitted by Trace. Filters are applied on page load.
- Audit preserves a URL `correlationId` visibly and explains that the current Audit API cannot filter by correlation ID. Trace can populate that identifier, while the existing Trace lookup reports the server API limitation on submit.
- Query navigation within either screen rehydrates the form and resets stale cursor or lookup results without dropping tenant scope.

## Verification

Environment: Node 24.21.0, offline admin-web package checks.

- Command: `node --test tests/*.test.mjs`
  - CWD: `du-rework/orchestrator/apps/admin-web`
  - Result: PASS, 54 tests, 12 suites, exit code 0.
  - Raw output: execution terminal output; no separate raw-output file was created.
- Command: `npm run typecheck`
  - CWD: `du-rework/orchestrator/apps/admin-web`
  - Result: PASS, exit code 0.
- Build digest: not produced; build was not requested.
- No commit was created. No files were staged or pushed.

## Scope note

The exact source lease covered only the Trace and Audit screens. Existing state-helper tests passed, but no test file was changed outside that lease. The new URL hydration is typechecked; the current offline suite does not mount React screens.
