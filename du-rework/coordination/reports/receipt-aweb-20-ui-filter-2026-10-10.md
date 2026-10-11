# Receipt: AWEB-20-UI Operations date filter

## Scope and result

- Task: AWEB-20-UI
- Status: IMPLEMENTED with owner smoke evidence
- Operations list requests carry the selected date window as inclusive ISO UTC instants through the server query builder.
- The list callback refreshes when either date changes. A stale cursor is detected against the selected tenant and filter population before the API request; stale paging state is cleared and pending list/detail responses are invalidated.
- Offline regression coverage executes the Operations screen load callback and checks the outgoing date bounds and stale-cursor short circuit.

## Verification evidence

- Run time: 2026-10-10 17:12 UTC, 2026-10-11 00:12 Asia/Bangkok
- Environment: Windows workspace, Node v24.21.0, npm 11.19.0, Vite 6.4.3; offline local run
- Working directory: `D:\Git\dugate\du-rework\orchestrator\apps\admin-web`
- Command: `node --test`
- Result: 18 suites, 82 passed, 0 failed, 0 skipped; exit code 0
- Raw output: `du-rework/scratch/aweb-20-ui-filter-node-test-2026-10-11.log`
- Command: `npm exec -- vite build`
- Result: 2698 modules transformed; build completed; exit code 0
- Build output: JavaScript bundle 1,054.26 kB, gzip 260.25 kB. Vite emitted its advisory that a minified chunk exceeds 500 kB.
- Raw output: `du-rework/scratch/aweb-20-ui-filter-vite-build-2026-10-11.log`

## Coordination boundary

- Git add, commit, and push were not run.
- No gate was changed or ticked. Independent UI review and acceptance remain separate from this implementation smoke.
