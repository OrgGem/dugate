# Operations list density receipt

Date: 2026-10-12  
Scope: `src/features/operations/operations-screen.tsx`; validation-only fixture follow-up in `tests/operations-state.test.mjs`.

## Changes

- The operations list shows the business identifier as a one-line ellipsized summary and the action on a second line, bounding row height even for unusually long identifiers. The full business/action value remains in the cell text and native hover title; operation detail continues to show the full business identifier.
- The Actions column and cell stay non-wrapping, with buttons prevented from shrinking. When needed, the existing bounded `TableContainer` provides horizontal scrolling to reach every action.
- The short operation ID link and the `ID`, `Finished`, and `Total elapsed` headers stay on one line at narrow widths; the existing horizontal table scroll keeps their full labels reachable.
- Operations-state test fixtures now provide the current required filter fields (`sort`, text filters, and usage/reservation/attention flags) and the current load callback binding. Existing assertions and their meanings are unchanged.
- No API, filter, cursor, permission, action, shared UI, or operations-state behavior changed.

## Validation

- `npm run typecheck` — passed for admin-web after the operations screen density change.
- `npm run typecheck` — passed for admin-web after the final narrow-width no-wrap adjustment.
- `git diff --check HEAD` from `D:\Git\dugate\du-rework` — passed after the final adjustment (exit 0; Git printed the existing CRLF normalization warning for `src/components/ui/README.md`).
- Browser recheck of the narrow-width layout is pending the browser worker's final rebuild; no browser result is claimed here.
- `node --test tests/orv15-frontend-navigation-owner.test.mjs` — passed, 4/4.
- `node --test tests/operations-state.test.mjs` — passed, 24/24 after fixture synchronization.
- `git diff --check -- orchestrator/apps/admin-web/src/features/operations/operations-screen.tsx` — passed before the validation-only test fixture follow-up.
- Earlier `operations-state.test.mjs` failures were caused by fixtures missing required current filter inputs and callback bindings; the test now exercises the existing state/query behavior successfully. No `src/features/operations/state.ts` changes were made.

Exact final operations-state test command: `node --test tests/operations-state.test.mjs`  
Working directory: `D:\Git\dugate\du-rework\orchestrator\apps\admin-web`  
Exit code: 0; 24 tests passed, 0 failed.  
Raw output: `rawfrontend-operations-state-focused-test.txt`.

Raw navigation-owner test output: `rawfrontend-operations-density-focused-test.txt`.

## SHA-256

| File | SHA-256 |
|---|---|
| `src/features/operations/operations-screen.tsx` | `FF3C537C09FDD931B498ED142DE57EDAA1173FB593F9E0DCCB9F352CDF50F58B` |
| `tests/operations-state.test.mjs` | `38A87D15C274B936A0BF3BF1D20F4ED6C300F19ECDF487A079D45B0FD46897E5` |
