# Claude — follow-up 07: artifact hardening and runtime handoff

User authorized implementation and fixes on 2026-09-21. Continue unfinished wave-06 work after reading the current source and lane reports. Preserve the shared dirty checkout; no reset/clean/stash/rebase, broad staging, or new agents.

## Ownership

Write: services/orchestrator/**, packages/worker-sdk/**, tests/integration/**, infra/**, central tasks/gates/status, coordination/reports/claude.md, and du-rework root dependency files only when needed. Antigravity owns businesses/example-review/** and its own report/requests. Do not edit its implementation or Connector/document-core lanes.

## Required work, in order

1. **C07-01 — finish P2-03/P4-05 artifact hardening.** Current artifacts.ts finalize trusts supplied size/hash, blob tokens have advertised expiration without enforced expiry, and orphan cleanup evidence is absent. Verify current code before fixing. Enforce actual hash/size/MIME policy, tenant/task/active lease authorization, grant expiry and read/write scope, immutable finalized content, bounded transfers and temp cleanup. Implement staging TTL cleanup preserving active checkpoint/result references. Keep frozen contracts compatible; document any unavoidable contract gap before broadening the interface.
2. **C07-02 — acceptance tests.** Add real PG/Redis tests for altered content/hash/size, expired grants, wrong tenant/task/stale lease, write after finalize, oversized transfers and orphan cleanup with active refs retained. Re-run artifact/grant/usage and document-core cross-service regression tests. Do not claim the entire ART matrix complete from one round-trip.
3. **C07-03 — P2-06/P4-04 continuation boundary.** Once the artifact packet is green, implement or explicitly report remaining children/join and human wait/resume endpoints. Prove persisted continuation with concurrency=1, crash/restart, duplicate/stale resume and cancellation. Publish the exact public SDK mechanism for restoring child outputs and approval context so example-review can integrate without invented input fields. Do not edit the business package.
4. **C07-04 — reconcile status and blockers.** Replace the obsolete wave-05 Claude report with current evidence and remaining work. Admin enable already exists in server.ts; verify and remove that stale blocker from central status. Antigravity's 29 local tests/image are verified, but P7-01/02 must not be promoted until its follow-up fixes pass. Update plan/task rows only against full acceptance.
5. **C07-05 — reproducible totals.** At a stable checkpoint, run build/lint and relevant workspace tests, record per-package suites/pass/skip/fail counts and correct totals. Separate prior reports from freshly executed results. Coordinate via the existing lane request/report files; preserve Antigravity's concurrent edits.

## Handoff

Report each C07 ID as DONE/PARTIAL/BLOCKED, exact paths and test commands/results, available endpoints/SDK contracts, and what Antigravity can adopt. Publish READY gates only for the scope actually proved. No production deployment or Git push is requested.
