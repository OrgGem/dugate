# Frontend Admin Workspace — delivery summary

**Date:** 2026-10-10  
**Repository scope:** `du-rework`  
**Plan:** [Frontend Admin Workspace plan](../PLAN-FRONTEND-ADMIN-WORKSPACE-2026-10-10.md)

## Summary

The planned admin-web delivery is implemented across Overview, Workflows, Audit, Trace, Operations, Profiles, and Connectors. The main honesty and support gaps were addressed: overview totals no longer treat a recent-page sample as system totals, synthetic worker health was replaced with persisted heartbeat inventory, real workflow failures no longer appear as simulated successes, missing workflow stages no longer display a fabricated count of one, and Profiles rows receive collision-safe render keys.

The latest recorded admin-web offline regression sweep covers all 11 `tests/*.test.mjs` files: **80 tests in 17 suites passed with 0 failures**. The recorded admin-web typecheck and Vite production build also passed. Vite still emits a non-failing advisory because the JavaScript bundle exceeds 500 kB. These results establish offline checks; no browser or live-service acceptance is claimed here.

## Delivery by screen

| Screen | Delivered behavior | Evidence |
|---|---|---|
| **Overview** | KPI totals, success/failure counts, and duration percentiles use server-side aggregation scoped to the selected time window and tenant. The recent operations list remains a sample for recent activity and charts. Worker status comes from stored worker instances and heartbeat observations; empty and unavailable states are distinct. The API keys link points to Profiles. | [AWEB-11C](receipt-aweb-11c-worker-instances-2026-10-10.md), [AWEB-16a](receipt-aweb-16a-2026-10-10.md), [AWEB-16b](receipt-aweb-16b-2026-10-10.md), [metrics display](receipt-aweb-16b-overview-metrics-display-2026-10-10.md) |
| **Workflows** | Backend is the default test source. Only an explicitly selected local simulation reports `SIMULATED_SUCCESS`; backend errors remain failures and do not receive fabricated operation IDs. Completed stage data comes from the backend. Empty simulated stages are labeled as a configuration gap, and missing stage counts display zero. | [AWEB-17](receipt-aweb-17-2026-10-10.md), [simulation honesty](receipt-aweb-workflow-sim-honesty-2026-10-10.md), [stage count](receipt-aweb-workflow-stage-count-2026-10-10.md), [simulation tests](receipt-aweb-workflow-simulation-test-2026-10-10.md) |
| **Audit** | Added `/audit` navigation and screen with tenant scope, keyset pagination, server-side severity/action/actor/resource/time filters, safe CSV export, and URL-based filter hydration. Resource links can open the matching Audit filter; operation resources can also link to Trace. | [AWEB-18](receipt-aweb-18-2026-10-10.md), [AWEB-21](receipt-aweb-21-deep-link-query-2026-10-10.md), [Audit event links test](receipt-aweb-audit-links-unit-test-2026-10-10.md) |
| **Trace** | Added `/trace` lookup for operation, correlation, and task identifiers; a tenant-aware merged timeline; masked payload preview; and links to related screens. Trace and Audit query parameters hydrate their lookup/filter state and reject invalid tenant context. | [AWEB-19](receipt-aweb-19-2026-10-10.md), [AWEB-21](receipt-aweb-21-deep-link-query-2026-10-10.md), [deep-link tests](receipt-aweb-deep-link-test-align-2026-10-10.md) |
| **Operations** | The screen sends inclusive UTC `from`/`to` bounds to the server. Filter population changes invalidate stale cursors. Bulk cancel continues after item failures, reports per-item details and counts, keeps failed items selected, and removes successful items from selection. | [AWEB-20a server filter](receipt-aweb-20a-2026-10-10.md), [AWEB-20a UI](receipt-aweb-20a-ui-2026-10-10.md), [cursor consistency](receipt-aweb-20-filter-consistency-2026-10-10.md), [AWEB-20b](receipt-aweb-20b-2026-10-10.md) |
| **Profiles** | Added a tenant-scoped profile catalog with business filtering and business-owned workflow selection. Profile row identity includes tenant, business, version, and name; occurrence suffixes keep React keys unique when the wire repeats a row. The tenant-operator profile detail authorization mismatch identified during review has a separate scoped fix and independent offline verification. | [AWEB-12](receipt-aweb-12-profiles-table-2026-10-10.md), [AWEB-14](receipt-aweb-14-workflow-business-2026-10-10.md), [unique row keys](receipt-f2-profile-unique-key-2026-10-10.md), [F1 detail authorization fix](receipt-f1-profile-detail-auth-2026-10-10.md), [F1 independent verification](verify-f1-profile-detail-INDEPENDENT-DSH-2026-10-10.md) |
| **Connectors** | The screen reads connector data and capabilities from the API, fails closed when capabilities are unavailable, and labels placeholder projections honestly. Config summaries expose keys and header names without values. The list reader reports malformed records as skipped instead of silently repairing them. | [Connectors honest audit](docs-connectors-screen-honest-audit-2026-10-10.md), [connector state tests](receipt-aweb-connectors-test-2026-10-10.md), [connector fixtures](receipt-aweb-connectors-fixtures-2026-10-10.md) |

## Findings closed

- **Fabricated Overview data:** removed the synthetic one-worker-per-business status row. Only recorded worker instances are shown, with health derived from heartbeat age and worker state.
- **Sample presented as a total:** Overview headline metrics use the server aggregate. Recent list-derived values are labeled as sample data.
- **False workflow success:** backend rejection and exceptions stay failures. Simulation success requires an explicit local simulation choice; operation identifiers and completed stages are not invented for backend failures.
- **Fabricated stage fallback:** a workflow with no stage count now displays zero, and an empty simulation result explains that no stage ran.
- **Duplicate React keys in Profiles:** collision-prone joined keys were replaced by structured row identity plus occurrence indexing. Repeated wire rows remain visible but receive unique, stable keys.
- **Profiles detail authorization:** tenant operators now have a tenant-scoped detail path rather than being sent to a platform-only authorization guard; the fix has an independent offline verification record.
- **Dead API keys link:** Overview now navigates to Profiles.

## Verification record

| Check | Recorded result | Scope and note |
|---|---|---|
| Admin-web Node test sweep | **80/80 tests passed**, 17 suites, 11 `*.test.mjs` files, exit 0 | Latest updated sweep receipt. Earlier independent DSH2 sweep verified a 9-file baseline at 72/72; later additions also have focused receipts. |
| Admin-web typecheck | **PASS**, exit 0 | `npm run typecheck` in the updated sweep and focused screen receipts. |
| Vite production build | **PASS**, exit 0; 2,698 modules transformed | Non-failing large-chunk advisory remains. |
| Focused implementation checks | **PASS** across the listed receipts | Includes Overview aggregation, workflow simulation, Audit/Trace hydration, Operations filters and recovery, Profiles identity, and Connectors fixtures. |

The test and build evidence is offline. It does not demonstrate browser rendering, live API behavior, or database execution of the Overview percentile query. The implementation receipts distinguish owner checks from independent verification; no gate is marked accepted by this summary.

## Remaining limits

- Trace reports that the current API cannot search by correlation ID. Task lookup is bounded to 500 recent operations; available operation detail does not include full transition history or webhook delivery rows.
- Profile row keys are unique, but duplicate backend rows are intentionally preserved. The profile detail route still identifies a row by business, version, and profile name; a distinct server-side row identifier would be needed to disambiguate records that share that visible tuple.
- Independent Operations review recorded a possible single request using the previous tenant cursor before the tenant-change reset takes effect. A sequence guard protects the displayed result; browser-level behavior was not tested.
- Overview uses the same stale indicator for a slow aggregate query and an aggregate request failure. The server stale condition describes query duration, so the UI label can be clarified in a later focused change.
- Vite bundle-size advisory remains; build exit status is successful.

## Scope and status

This is a delivery summary for the frontend plan and directly related AWEB work. It records implementation and offline verification evidence, not browser acceptance or live deployment readiness. No source code was changed for this report, and no gate was ticked.
