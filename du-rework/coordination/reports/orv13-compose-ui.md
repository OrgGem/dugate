# UI13 Compose operations UI owner receipt

Status: implementation source freeze for the Compose UI and authorized shell recovery follow-up. Independent mounted-browser verification and the shared final build remain pending; this receipt does not claim acceptance.

The approved architecture is recorded in [`raw/orv13-review/compose-architecture.md`](raw/orv13-review/compose-architecture.md). The UI uses the backend-frozen browser Compose DTOs and methods from `@/lib/api`; the API client/auth latch and its session-scope fingerprint are backend-owned. Explicit recovery calls `getSession({ recoverAuth: true })`. If that response reports `SESSION_CHANGED` (409), the shell keeps protected navigation and content inert, leaves the in-memory draft mounted, and asks the operator to reload under the new role or tenant scope. A successful same-scope check refreshes the Compose projections.

Compose deployment and maintenance panels now use actual host catalog, approved release, observed service and durable job projections. The operator can inspect desired versus observed release/revision/image state and freshness, request a bounded allowlisted preview, review reason/target services/digests/expiry/interruption impact, then confirm an idempotent job submission fenced by observed digest and expected target revision. Job history/details include bounded per-service outcomes and observed before/after state. Unknown execution outcomes are fenced from blind retry and direct the operator to human reconciliation through the deployment runbook. Native Settings restore remains distinct from deployment rollback. The UI identifies the single-server Compose limitation and does not claim full 17-setting runtime parity or a two-replica rollout.

The shell now resolves its session without a platform-health guard, restricts health reads to admin/platform-principal/platform-scope sessions, marks old health samples stale, and exposes a session-recovery alert after the payload-free expiry event. Protected navigation and page content pause while preserving mounted form drafts. The Overview retains one meaningful API-keys link to Profiles after duplicate navigation was removed.

Changed UI paths:

- `orchestrator/apps/admin-web/src/app-shell/app-shell.tsx`
- `orchestrator/apps/admin-web/src/app-shell/session-events.ts`
- `orchestrator/apps/admin-web/src/router.tsx`
- `orchestrator/apps/admin-web/src/routes/system-operations.tsx`
- `orchestrator/apps/admin-web/src/features/overview/overview-screen.tsx`
- `orchestrator/apps/admin-web/src/features/system-operations/state.ts`
- `orchestrator/apps/admin-web/src/features/system-operations/system-operations-screen.tsx`
- `orchestrator/apps/admin-web/src/features/system-operations/compose-state.ts`
- `orchestrator/apps/admin-web/src/features/system-operations/compose-operations-panel.tsx`
- `orchestrator/apps/admin-web/tests/orv13-cockpit-owner.test.mjs`
- `orchestrator/apps/admin-web/tests/orv13-compose-ui-owner.test.mjs`

Owner checks passed:

- `node --experimental-strip-types --test tests/orv13-compose-ui-owner.test.mjs tests/orv13-cockpit-owner.test.mjs`: 11 passed.
- `./node_modules/.bin/tsc --noEmit -p tsconfig.json --pretty false`: exit 0, no diagnostics.
- `node_modules/.bin/jest --runInBand tests/aweb-17-workflow-test-honesty.test.ts`: 6 passed, including the API-keys link regression.
- Scoped `git diff --check` passed. New owner files had no trailing-whitespace matches.

Captured test output, command/exit evidence, environment, HEAD, and source hashes are in [`raw/orv13-compose-ui/`](raw/orv13-compose-ui/). No build artifact was produced. A mounted browser/session-expiry test and the shared final build remain with the independent tester.
