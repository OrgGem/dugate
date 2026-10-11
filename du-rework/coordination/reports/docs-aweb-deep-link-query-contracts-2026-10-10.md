# Trace and Audit deep-link query contract

Date: 2026-10-10  
Task: AWEB-DEEP-LINK-QUERY-PARAMS-DOCS-2026-10-10  
Scope: `du-rework/orchestrator/apps/admin-web`  
Plan reference: `coordination/reports/receipt-aweb-21-deep-link-query-2026-10-10.md`

This document records the URL query contract currently implemented by the Trace and Audit screens. Query values prefill screen state or select a tenant; they do not grant access. The active signed-in session and server-side authorization remain authoritative.

## Supported parameters by screen

| Parameter | Trace | Audit | Behavior |
| --- | --- | --- | --- |
| `operationId` | Lookup field | Resource shortcut | Trace selects Operation ID lookup and prefills the value. Audit converts it to `resource=operation:<id>` when a valid explicit `resource` is absent. |
| `correlationId` | Lookup field | Informational context | Trace prefills Correlation ID, but the current Admin API has no correlation-ID read filter, so submitting reports that limitation. Audit retains a valid value in a notice and does not send it as a server filter. |
| `taskId` | Lookup field | Not consumed | Trace selects Task ID lookup and searches snapshots in up to 500 recent operations for the active tenant. Audit ignores this parameter. |
| `tenantId` | Tenant selection request | Tenant selection request | A requested tenant is selected only if it appears in the tenant list available to the signed-in session. See Tenant session fencing below. |
| `resource` | Not consumed | Resource filter | Audit applies the value as a server-side resource filter. A valid explicit resource takes precedence over the `operationId` shortcut. |
| `severity` | Not consumed | Severity filter | Audit accepts `info`, `success`, `warning`, or `error`, case-insensitively. An unsupported value falls back to All severities. |
| `from` | Not consumed | Start time filter | Audit parses the timestamp, displays it in the browser-local datetime field, then sends the corresponding UTC instant to the API. Invalid values are ignored. |
| `to` | Not consumed | End time filter | Audit parses the timestamp, displays it in the browser-local datetime field, then sends the corresponding UTC instant to the API. Invalid values are ignored. |
| `action` | Not consumed | Action filter | Audit applies the value as an action substring filter. |
| `actor` | Not consumed | Actor filter | Audit applies the value as an actor substring filter. |
| `sort` | Not consumed | Sort order | Audit accepts `createdAt:asc`; other or absent values use `createdAt:desc`. |
| `limit` | Not consumed | Page size | Audit accepts `25`, `50`, `100`, or `200`; other or absent values use `50`. |

The screens use the router's `URLSearchParams` reader, so normal URL percent-encoding is decoded before validation. Values used as identifiers or text filters are trimmed and reject control characters. Trace identifiers must contain 1 to 200 characters. Audit text filters are limited to 128 characters, the Audit tenant selector to 256 characters, and Audit timestamps to 64 characters. These are input handling limits, not authorization rules.

## Trace behavior

When more than one Trace identifier is present, the first nonempty parameter in this order wins: `operationId`, `correlationId`, then `taskId`. An invalid first nonempty identifier produces a field error; the screen does not silently fall through to a lower-priority identifier. The identifier type and value are populated for the operator to review. Opening a deep link does not automatically submit the lookup.

Operation lookups first query operations with the active tenant and requested operation ID, then load the detail and verify that its tenant matches the active tenant. Task lookup scans at most 500 recent operations in that tenant. Correlation lookup can be prefilled but cannot complete until the Admin API provides the required read filter.

Changing the URL query rehydrates the lookup fields and clears prior lookup results. Changing tenant also clears prior results. Related Audit links include both `tenantId` and `resource=operation:<id>` so the destination can preserve the incident and tenant context. Trace links emitted from an Audit row include `operationId` when the resource is an operation resource.

Examples:

- `/trace?tenantId=6c6f0c68-9ef3-4e1e-9dc4-100000000001&operationId=op-123`
- `/trace?tenantId=6c6f0c68-9ef3-4e1e-9dc4-100000000001&correlationId=corr-123`
- `/trace?tenantId=6c6f0c68-9ef3-4e1e-9dc4-100000000001&taskId=task-123`

## Audit behavior

Audit initializes its draft and applied filters from the URL and loads the matching page automatically. Navigating to a different query rehydrates the filters and resets the cursor so a cursor from an earlier filter set is not reused. The active tenant is included in every Audit list query.

If `resource` contains a valid nonempty value, it is used as supplied. Otherwise, a valid `operationId` becomes `operation:<id>`. This shortcut matches the Audit API's resource filter; `operationId` is not a direct API filter. Audit sends `severity`, `action`, `actor`, `resource`, `from`, and `to` as supported filters, alongside `tenantId`, `sort`, `limit`, and cursor pagination. It does not send `correlationId` or `taskId` as filters.

Audit accepts browser-parseable time values in `from` and `to`; ISO 8601 timestamps with an explicit UTC offset are recommended for stable links. Values are converted to browser-local datetime fields and then normalized back to UTC when the request is built. Applying edited filters validates the time window and rejects a start time later than the end time. If a query parameter cannot be parsed during hydration, that field starts empty rather than applying an ambiguous value.

Examples:

- `/audit?tenantId=6c6f0c68-9ef3-4e1e-9dc4-100000000001&operationId=op-123&severity=warning&from=2026-10-10T00%3A00%3A00.000Z&to=2026-10-10T12%3A00%3A00.000Z`
- `/audit?tenantId=6c6f0c68-9ef3-4e1e-9dc4-100000000001&resource=operation%3Aop-123`
- `/audit?tenantId=6c6f0c68-9ef3-4e1e-9dc4-100000000001&correlationId=corr-123`

The last example retains the correlation ID as visible context only. Use Trace for correlation-ID lookup, with the limitation that the current API cannot execute that lookup.

## Tenant session fencing

`tenantId` in a URL is a requested screen selection, never proof of identity, membership, or permission. Each screen waits for the tenant options associated with the signed-in session and changes the shared tenant context only when the requested ID is present in that list. A malformed or unavailable tenant ID produces a visible error and blocks the data request instead of falling back to whichever tenant happens to be selected.

If the URL has no `tenantId`, each screen uses the current tenant selected in the application navigation. If it has a valid, available `tenantId` different from the current selection, the screen switches to that tenant and waits for the active context to match before querying. While the URL tenant and active tenant differ, Trace disables lookup and Audit suppresses the list request. If an operator later changes the navigation tenant while the URL still requests the previous tenant, the mismatch remains blocked until the URL is updated or the screen is opened without that tenant parameter.

Trace scopes operation-list and task-scan requests to the active tenant and checks the returned operation detail against that same tenant before rendering it. Audit builds its list request from the active tenant context, not from an untrusted query string. The BFF and server authorization checks still enforce session and tenant access on every request. A deep link cannot bypass those checks, and a tenant absent from the signed-in tenant list cannot be selected by editing the URL.

## API boundary and limitations

These are screen-level URL contracts. Audit's server query supports tenant, severity, action, actor, resource, time bounds, sort, page size, and cursor. Audit `operationId` is only a UI shortcut that maps to `resource`; Audit `correlationId` and `taskId` are not server filters. Trace supports operation and task lookup within a tenant, while correlation lookup remains unavailable until the server exposes a tenant-scoped correlation filter. The screens preserve useful context without treating unsupported parameters as successful filters.

## Source references

- `orchestrator/apps/admin-web/src/features/trace/trace-screen.tsx`
- `orchestrator/apps/admin-web/src/features/trace/state.ts`
- `orchestrator/apps/admin-web/src/features/audit/audit-screen.tsx`
- `orchestrator/apps/admin-web/src/features/audit/state.ts`
- `coordination/reports/receipt-aweb-21-deep-link-query-2026-10-10.md`
