# UI13-COCKPIT owner receipt — 2026-10-11

**State: IMPLEMENTED, source frozen for the first cockpit slice; independent build/browser verification pending.** This receipt does not claim UI13 or AOPS acceptance.

## Source freeze

Changed product paths:

- `orchestrator/apps/admin-web/src/app-shell/app-shell.tsx`
- `orchestrator/apps/admin-web/src/router.tsx`
- `orchestrator/apps/admin-web/src/routes/system-operations.tsx`
- `orchestrator/apps/admin-web/src/features/system-operations/system-operations-screen.tsx`
- `orchestrator/apps/admin-web/src/features/system-operations/state.ts`
- `orchestrator/apps/admin-web/src/features/overview/overview-screen.tsx`
- `orchestrator/apps/admin-web/src/features/overview/operations-monitor-dashboard.tsx`
- `orchestrator/apps/admin-web/tests/orv13-cockpit-owner.test.mjs`

The existing logout CSRF field in `app-shell.tsx` was preserved. No API client, types, backend, usage-screen, operations-screen, workflow-screen, shared tenant-selector, deployment, or mutation paths were changed.

## Delivered behavior

- The shell exposes Cockpit, Services, Workers & Queues, Incidents, Deployments, and Maintenance routes. The mobile drawer closes on navigation, supports Escape, and returns focus to its toggle.
- The System Operations route reads the existing server operations metrics, operations page, health snapshot, and persisted worker heartbeat inventory. It fences late responses by selected tenant and resets the view when the selection changes.
- Operations metrics and list queries use the authenticated tenant scope, with the selected tenant applied only for platform sessions. Aggregate health and worker inventory are requested only for platform administrators; tenant sessions see an explicit scope reason.
- Health, worker, operations, and aggregate metric samples show unknown or stale state instead of inventing zeroes. The cockpit calls out that the latest 100 operation rows are a sample, and it links actual UNKNOWN and waiting-input operations through the operation detail deep link.
- Deployments and Maintenance state the missing projection/adapter contract and provide no synthetic restart, drain, rollout, recovery, or cleanup controls.
- Existing Overview reads now fence responses against tenant changes and gate platform-only health/worker reads. Failed refreshes retain last-good samples with stale status. Missing workers, DB/Redis probes, queue counts, and outbox values no longer render as zero or healthy. The nine-link duplicate Overview nav was removed.
- The Overview’s local time-bucket chart is keyboard-focusable and explicitly describes its latest-page sample; it does not claim full-history throughput. The usage tile preserves cost completeness and uses the shared `usageCostState` helper; its badge no longer says `live` after a failed refresh.

## Owner smoke and source checks

- Task/test: `UI13-COCKPIT` / `orv13-cockpit-owner.test.mjs`
- Command: `node --test tests/orv13-cockpit-owner.test.mjs`
- CWD: `du-rework/orchestrator/apps/admin-web`
- HEAD observed: `7e36a1e4460d88661a2a74b4ad39296c9d5f68f3`
- Environment: local Node test runner; no network or database used.
- Result: exit 0, 5 passed, 0 failed, 0 skipped.
- Raw output: `coordination/reports/raw/orv13-cockpit/owner-smoke.log`
- Whitespace check: the command run was repo-wide `git diff --check` (combined in the shell invocation with `git status --short`), and it returned non-zero because the workspace contains trailing-whitespace findings in unrelated dirty files, including historical reports and the journeys-owned operations screen. No targeted diff check was run for this lane, so this is not recorded as a pass for the changed cockpit paths.
- Shared admin-web typecheck/build was deferred by the coordinator to the independent final-build slot. No bundle digest or browser receipt exists yet.

## Remaining capability gaps

- The current Admin BFF has no desired/observed Compose deployment inventory, per-replica image/version state, rollout history, or rollback adapter.
- No maintenance preview/job/status/history adapter exists for recovery, cleanup, drain, or reconciliation. Existing health and worker reads are not substitutes for those capabilities.
- No incident ledger, alert threshold revision, assignment/acknowledge/resolve workflow, provider health projection, per-queue runnable/delayed/failed counts, or queue age/throughput projection is available. The cockpit derives triage signals from health and the returned operation page only and labels that scope.
- UNKNOWN and HITL counts in the cockpit cover only the latest 100 operation rows. The full-window server metrics do not currently expose UNKNOWN or waiting-input totals.
- Source is frozen pending independent typecheck/build, browser/mobile/keyboard review, and any required backend adapter packet. Findings from those gates return to the owning lane; this first slice does not satisfy full AOPS-01..09 acceptance.
