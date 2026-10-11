# Receipt — AWEB-19 Trace / Support Incident Workspace

**Recorded:** 2026-10-10 14:10 UTC  
**Lease:** `du-rework/orchestrator/apps/admin-web/src/features/trace/**`, `src/routes/trace.tsx`, `src/router.tsx`, `src/app-shell/app-shell.tsx`, and `tests/trace-state.test.mjs`.

## Delivered

- Registered `/trace` and added Trace to the Workspace navigation. Existing Audit changes in the shared router and shell were preserved.
- Added an identifier form for operation ID, correlation ID, and task ID. Operation reads first verify the exact ID through the selected-tenant operations list before loading detail. Task lookup scans at most 500 recent operations, always with the selected tenant filter, and checks details in bounded batches.
- Added a time-ordered timeline combining operation timestamps, task-attempt snapshots, the operation usage summary, and related audit records (up to 100 newest audit rows). Audit requests carry both `tenantId` and the operation resource filter.
- Added Operations and Audit route links that include operation/tenant query context. The current destination screens do not consume those query parameters to preselect/filter their content, so the links open the right screens but do not yet focus the matching row.
- Payload preview retains only generic field positions and shape; every scalar value is masked before rendering. Raw request/result values are never shown.

## API limits

- The current frontend client and Admin API do not expose a correlation-ID search filter. The form accepts it and reports this limitation instead of guessing a match.
- Task ID lookup is bounded to 500 recent operations to avoid an unbounded sequence of detail reads. The UI reports when that cap is reached.
- The available operation detail contains current task snapshots and aggregate usage, not full operation transition history or webhook delivery rows. The timeline labels snapshots and does not imply historical transitions.

## Verification

| Command | Result |
|---|---|
| `node --test tests/*.test.mjs` (from `apps/admin-web`) | PASS — 12/12 tests, including trace tenant scoping, task lookup, timeline merge, payload masking, links, and route/navigation registration |
| `npx tsc --noEmit -p tsconfig.json` (from `apps/admin-web`) | PASS |
| `npx vite build` (from `apps/admin-web`) | PASS — production bundle generated; Vite reports the main chunk exceeds 500 kB |
| `npm run build` (from `apps/admin-web`) | PASS — TypeScript check and Vite production build completed |
| `git diff --check -- src/router.tsx src/app-shell/app-shell.tsx` (from `apps/admin-web`) | PASS |

No files were staged or committed, nothing was pushed, and no gate was ticked.
