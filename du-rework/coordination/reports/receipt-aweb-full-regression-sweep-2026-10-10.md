# Receipt: AWEB admin-web full regression sweep

Date: 2026-10-10  
Task: AWEB-ALL-SUITES-REGRESSION-SWEEP-2026-10-10  
Repository scope: `du-rework` only  
Working directory: `orchestrator/apps/admin-web`

## Verification

- Offline test suites: ran `node --test` against all 9 files matching `tests/*.test.mjs`.
  - Result: PASS, 72 tests, 15 suites, 0 failures, exit code 0.
- Typecheck: `npm run typecheck`.
  - Result: PASS, exit code 0.
- Production build: `npm exec -- vite build`.
  - Result: PASS, exit code 0; 2,698 modules transformed.
  - Vite emitted a non-failing warning that the minified JavaScript bundle exceeds 500 kB.

This was a read-only regression sweep aside from the requested receipt. The build generated the normal Vite output under `apps/admin-web/dist`. No product source was edited. No git add, commit, or push was performed, and no gate was ticked.
