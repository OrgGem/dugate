# Receipt: Overview live worker inventory

Date: 2026-10-10

## Delivered

- Overview now requests worker instances through `listWorkerInstances`, validates the response, and feeds the returned records directly to the dashboard. Empty inventories stay empty, while failed/unavailable requests render an unavailable state.
- Worker rows show the API-provided instance ID, health status, capacity, active lease count, business/version, and last heartbeat. `computeWorkerTelemetry` no longer infers workers or queue metrics from businesses and operations.
- Queue Integrity no longer defaults to `OK` or a fixed green dot when health data is missing; its label and indicator now follow the health API state.
- Added an offline assertion that an empty inventory creates no synthetic worker rows.

## Verification

- `node --test tests/worker-instance-state.test.mjs` — PASS, 6 tests.
- `npm run typecheck` in `apps/admin-web` — PASS.
- `npm run build` in `apps/admin-web` — PASS. Vite reports the existing large-chunk advisory (1,048.50 kB).
- `npm run test:unit -- --runTestsByPath tests/aweb11c-worker-instances.test.ts` in `services/orchestrator` — PASS, 7 tests.
- Scoped `git diff --check` for the Overview files and worker inventory test — PASS.

Repository-wide `git diff --check` also reports a trailing blank line in the unrelated `services/orchestrator/tests/admin-api-keys.test.ts` at line 767; that file was left untouched.

No files were staged, committed, or pushed.
