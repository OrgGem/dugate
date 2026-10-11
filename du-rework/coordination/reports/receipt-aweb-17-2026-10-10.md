# AWEB-17 receipt — 2026-10-10

- **Scope:** `du-rework` — `orchestrator/apps/admin-web`
- **Lease:** `apps/admin-web/src/features/workflows/workflows-screen.tsx`; `apps/admin-web/src/features/overview/overview-screen.tsx`; related offline test `services/orchestrator/tests/aweb-17-workflow-test-honesty.test.ts`
- **Finding:** Backend rejections and request exceptions were rendered as `SIMULATED_SUCCESS`, with fabricated `sim-op-*` IDs. The accepted branch also fabricated an operation ID and populated completed stages from the workflow catalog. Overview linked API keys to the unavailable `/api-keys` route.
- **Change:** Backend is the default, explicitly selectable test source. Only the selected local simulation path renders `SIMULATED_SUCCESS`, and it sends no backend request. Backend rejection and exceptions render `FAILED` with a visible error code and message; neither produces an operation ID. Accepted operation IDs and completed stages are shown only when returned by the backend. The Overview API keys link now targets `/profiles`.
- **Regression coverage:** Offline Jest suite executes the actual handler extracted from the TSX with a stub client. It covers backend rejection, thrown exception, selected simulation, server-provided success data, explicit simulation choice, and the Overview route.
- **Owner smoke:** PASS — `npm test -- --runTestsByPath tests/aweb-17-workflow-test-honesty.test.ts` from `du-rework/orchestrator/services/orchestrator`; 1 suite passed, 6/6 tests passed, 0 failed, 0 skipped. No network or external services.
- **Frontend bundle:** PASS — `npx vite build` from `du-rework/orchestrator/apps/admin-web`; bundle emitted successfully. Vite reported the existing large-chunk advisory.
- **Typecheck/build limitation:** `npm run build` stops during `tsc --noEmit` at `src/lib/api/client.ts:385`: the workspace’s separate uncommitted `profileKeyAction` implementation returns `AdminApiResult<ProfileMutationResult>` while its interface declares `AdminApiResult<PostActionResult>`. This file is outside this lease and was not changed here; Vite bundling and the offline regression suite pass.
- **State:** IMPLEMENTED; offline regression tests and Vite bundle PASS; full package build remains blocked by the out-of-lease type mismatch above. Gate unchanged.
- **Git actions:** No staging, commit, or push.
