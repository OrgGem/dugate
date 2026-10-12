# ORV13 UI13-JOURNEYS receipt

Implemented the Operations, callback, and workflow operator journeys within the `operations/**` and `workflows/**` UI lease.

## Changes

- `orchestrator/apps/admin-web/src/features/operations/operations-screen.tsx` now syncs operation detail selection and list filters/pagination with URL search parameters, including the `?operation=` drilldown used by the cockpit. It fences detail and action responses by tenant/request generation, gives failed detail loads an explicit retry, retains the review draft on same-operation refresh, and submits human review with the server's `expectedStateVersion`. Cancel, retry, bulk cancel, and terminal delete use accessible confirmations, pending-action guards, role checks, and idempotency keys. Delete uses the typed BFF helper and describes the backend's soft-hide behavior.
- `orchestrator/apps/admin-web/src/features/operations/callback-deliveries.tsx` provides explicit loading, empty, load-error, action-error, and success states. It clears old delivery rows on reload, fences responses across operation changes, and confirms a single bounded retry with attempt count, same delivery ID/payload, and recipient-deduplication warning before calling the existing backend action.
- `orchestrator/apps/admin-web/src/features/workflows/workflows-screen.tsx` fences catalog requests and mutations by tenant, supplies retryable catalog loading/error states, searches the catalog, and gates create/import/retire/edit/test controls to the platform administrator session accepted by the current BFF. Import stays JSON-only under the existing workflow schema contract. Active revisions can be edited, reviewed, and published using `expectedRevision`; conflict handling preserves the draft and can load a new active compare-and-swap base for review.
- `orchestrator/apps/admin-web/src/features/workflows/revision-editor.ts` contains the editor's schema checks, nested connector-reference discovery/update, and bounded diff helper.
- `orchestrator/services/orchestrator/tests/orv13-journeys-owner.test.ts` covers the editor helpers and focused source assertions for operator journey guarantees. Existing untracked ORV12 review-schema source under `operations/` was preserved.

## Verification

- `apps/admin-web/node_modules/.bin/tsc --noEmit -p apps/admin-web/tsconfig.json` (from `orchestrator/`): passed; raw output is in `coordination/reports/raw/orv13-journeys/admin-web-typecheck.txt`.
- `node_modules/.bin/jest --runInBand tests/orv13-journeys-owner.test.ts tests/orv12-ui-review-schema.test.ts` (from `orchestrator/services/orchestrator/`): 2 suites, 12 tests passed; see `coordination/reports/raw/orv13-journeys/jest-owner-orv12.txt`.
- `node_modules/.bin/jest --runInBand tests/aweb-17-workflow-test-honesty.test.ts`: 1 suite, 6 tests passed, including the Overview API-keys link regression; see `coordination/reports/raw/orv13-journeys/jest-aweb17-full.txt`.

The package-manager typecheck path was previously blocked by PNPM's `ERR_PNPM_IGNORED_BUILDS` guard for ignored dependency build scripts, so verification used the already-installed TypeScript binary directly. No build was run because the shared build slot is coordinated with the root worker. No browser end-to-end test or real callback retry was run; tests do not claim provider execution or charges.

## Limits

The current workflow schema contract accepts JSON. XML import is not advertised as supported. Workflow test remains gated to the platform administrator session consistent with the current BFF policy. Callback retry remains the existing backend operation, with no provider calls made during verification.

## IR13-10 mobile follow-up

Reviewed the reported served-bundle capture at `reports/raw/orv13-vfy/admin-ui/callback-delivered-mobile-320.png`. The operation detail header action group now wraps at constrained widths, and the download link is non-shrinking and stays on one readable line. Only `operations-screen.tsx` and the uniquely owned journey test were changed for this follow-up.

- `node_modules/.bin/jest --runInBand tests/orv13-journeys-owner.test.ts`: 1 suite, 5 tests passed; see `coordination/reports/raw/orv13-journeys/mobile-owner-jest.txt`.
- `apps/admin-web/node_modules/.bin/tsc --noEmit -p apps/admin-web/tsconfig.json` (from `orchestrator/`): exit code 0 with no diagnostics; see `coordination/reports/raw/orv13-journeys/mobile-admin-web-typecheck.txt`.
- Frozen-source SHA-256 values are recorded in `coordination/reports/raw/orv13-journeys/mobile-source-sha256.txt`.

No build or screenshot recapture was run under this narrow task. The independent tester is rebuilding the final bundle and checking the populated operation-detail controls at 320px and 390px; that visual result remains pending their report.
