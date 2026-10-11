# AWEB-16a receipt — 2026-10-10

- **Scope:** `du-rework` — `orchestrator/apps/admin-web`
- **Lease:** `apps/admin-web/src/features/overview/overview-screen.tsx`; related offline test `services/orchestrator/tests/aweb-16a-overview-tenant-operations.test.ts`
- **Finding:** Overview loaded up to 100 recent operations without the selected tenant filter. Its existing loader callback already depends on the global tenant selection and the initial effect depends on that callback, so changing tenant recreates and reruns the loader. The displayed copy overstated that all Overview data was scoped to the active global tenant.
- **Change:** The operations query now includes `tenant: effectiveTenantId` when available. Platform sessions use the active selection; tenant-scoped sessions use their own tenant. Updated the copy to describe this scope accurately.
- **Regression coverage:** Offline Jest test evaluates the actual Overview loader from the TSX with stub APIs. It verifies tenant A and tenant B produce separate filtered operation queries, that tenant selection is a loader/effect dependency, that tenant-scoped sessions retain their session tenant, and that the UI copy describes the scope.
- **Owner smoke:** PASS — `npm test -- --runTestsByPath tests/aweb-16a-overview-tenant-operations.test.ts` from `du-rework/orchestrator/services/orchestrator`; 1 suite passed, 3/3 tests passed, 0 failed, 0 skipped. No network or external services. The adjacent AWEB-17 regression suite also passed in the combined run (2 suites, 9/9 tests).
- **Frontend bundle:** PASS — `npx vite build` from `du-rework/orchestrator/apps/admin-web`; bundle emitted successfully. Vite reported the existing large-chunk advisory.
- **Typecheck/build limitation:** `npm run build` stops during `tsc --noEmit` at `src/lib/api/client.ts:385`: the workspace’s separate uncommitted `profileKeyAction` implementation returns `AdminApiResult<ProfileMutationResult>` while its interface declares `AdminApiResult<PostActionResult>`. This file is outside this lease and was not changed here.
- **State:** IMPLEMENTED; focused offline tests and Vite bundle PASS; full package build remains blocked by the out-of-lease type mismatch above. Gate unchanged.
- **Git actions:** No staging, commit, or push.
