# Receipt: updated admin-web regression sweep

Date: 2026-10-10  
Task: AWEB-ALL-SUITES-UPDATED-SWEEP-2026-10-10  
Repository scope: `du-rework` only  
Working directory: `orchestrator/apps/admin-web`

## Test inventory and results

- Counted 11 files matching `tests/*.test.mjs`, including `connectors-state-honesty.test.mjs` and `connectors-fixtures.test.mjs`.
- Ran the Node test runner against all 11 files.
- Result: PASS, 80 tests, 17 suites, 0 failures, exit code 0.
- Typecheck: `npm run typecheck` — PASS, exit code 0.
- Vite production build: `npm exec -- vite build` — PASS, exit code 0; 2,698 modules transformed.
- Build emitted a non-failing warning that the minified JavaScript bundle exceeds 500 kB.

This was a read-only regression sweep aside from the requested receipt. The build generated normal output under `apps/admin-web/dist`. No product source was edited. No git add, commit, or push was performed, and no gate was ticked.
