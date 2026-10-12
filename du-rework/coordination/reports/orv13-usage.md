# ORV13-USAGE implementation receipt

**Task:** UI13-USAGE operator UI (`Usage & Cost`). **Owner:** `/root/orv13_usage`. **Source freeze:** 2026-10-11 17:07 UTC. Shared working tree; no commit, push, browser build, deployment, database/provider call, destructive action, or shared build slot used.

## Delivered

- Replaced the raw summary JSON with validated window totals and provider/model rows. Operations, input/output tokens, pages, known accrued USD, unit measurement, and cost status are readable fields. Measured, estimated, pending, unpriced, and unavailable cost states remain distinct; an absent amount or zero is not presented as proof of free usage.
- Bound the page to the backend `BASIC_ADMIN_USAGE_V1` seam: `listUsageEvents` / `GET /admin/api/usage/events`, using the page envelope tenant fence, bounded received-time window, provider+model pair, optional operation UUID, page limit and opaque cursor. The basic projection keeps provider/model/cost nullable and includes only persisted fields; the UI does not imply API-key/business/profile/connector revisions, attempt pricing, duration, or other rich COST provenance.
- Added a received-time event ledger with visible-page CSV, cursor navigation, operation links, UTC timestamps, and an explicit skipped-row message. Export is labeled and limited to the page currently shown.
- Fenced summary and event responses by tenant/query/refresh generation. A tenant switch or deselection immediately hides the previous scope; a late response cannot repaint it. Failed refreshes retain data only for the same tenant and query and mark it stale.
- Preserved the UTC window and local provider/model/operation/page-size filters in the URL. Tenant scope remains from the authorized global tenant context and is removed from this screen’s query string. Added loading, denied, error, empty, stale and invalid-filter feedback, keyboard-focusable table scroll regions, and narrow responsive layout.
- No budget editor was added because no persisted management DTO exists.

## Owner checks

Environment: `/workspace/dugate/du-rework/orchestrator`, Node `v24.21.0`, pnpm `10.18.3`, PATH prefix `/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin:/workspace/scratch/orv11-toolchain/node_modules/.bin`.

| Check | Result | Raw output |
|---|---|---|
| `pnpm --filter @du/orchestrator exec jest --runInBand tests/orv13-usage-owner.test.ts` | **PASS**, 1 suite, 6 tests, 0 skipped, exit 0 | [owner-tests.log](raw/orv13-usage/owner-tests.log) |
| `git diff --check -- orchestrator/apps/admin-web/src/features/usage/usage-screen.tsx orchestrator/apps/admin-web/src/features/usage/state.ts orchestrator/services/orchestrator/tests/orv13-usage-owner.test.ts` | **PASS**, exit 0 | [diff-check.log](raw/orv13-usage/diff-check.log) |
| `pnpm --filter @du/admin-web typecheck` | **BLOCKED**, exit 2 before a clean package result: TypeScript reported syntax error `src/lib/tenant-context.tsx(55,7): 'while' expected` in a concurrently edited, non-leased shared file. It was reported to its owner; this lane did not edit that file or retry during the shared edit. | [admin-web-typecheck.log](raw/orv13-usage/admin-web-typecheck.log) |

Owner tests exercise summary/event runtime parsing, missing attribution/cost, tenant mismatch, cursor-envelope validation, query construction and range checks, URL scope handling, current-page CSV/formula safety, and same-scope request fencing for tenant switch, deselection, and newer refresh.

## Verification boundary

Implementation is source-complete for this lane, but no clean Admin Web typecheck, mounted browser evidence, 320px/keyboard browser run, or independent UI review is claimed. The independent tester should typecheck after all shared owners freeze, then verify the current build and the tenant-switch/deselection race, page/export boundaries, empty/skipped-row distinction, and narrow/keyboard behavior. COST-03 and AOPS-09 acceptance remain open.
