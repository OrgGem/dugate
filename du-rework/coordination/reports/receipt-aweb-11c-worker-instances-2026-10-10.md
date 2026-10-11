# Receipt — AWEB-11C worker instances — 2026-10-10

Status: PASS (offline validation)

Implemented the approved additive `worker_instances` migration (`0042`), persisted runtime heartbeats under the authenticated business identity, and refreshed each row's active lease count from live, unexpired RUNNING tasks. Added platform-admin `GET /api/v1/admin/worker-instances` with optional `businessId` and bounded `limit`, plus the BFF forwarding route and browser client types.

The read model returns only stored worker instances. It reports a fresh heartbeat as `HEALTHY` through 60 seconds, `DEGRADED` through 5 minutes (also for draining or zero-capacity instances), and `OFFLINE` after that or for an explicitly offline row. The Overview now renders each instance's ID, business/version, health, active leases, capacity, and last-seen time; it no longer synthesizes one worker per business or a green status. Empty and unavailable inventory have separate UI states.

Validation:

- Orchestrator `npm run typecheck` — PASS, exit 0.
- Orchestrator `npm run test:unit -- --runTestsByPath tests/aweb11c-worker-instances.test.ts tests/aweb06-bff-operations.test.ts tests/br12-isolation-offline.test.ts tests/rfx11-12-route-hardening.test.ts` — PASS, 4 suites / 48 tests.
- Admin Web `npm run typecheck` — PASS, exit 0.
- Admin Web `node --test tests/worker-instance-state.test.mjs` — PASS, 5 tests.
- Admin Web `npm run build` — PASS; Vite emitted its existing large-chunk warning (largest JS chunk: 1,048.40 kB).
- `git diff --check` on the changed implementation and test paths — PASS.

No git add, commit, push, or gate update was run.
