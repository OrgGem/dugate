# W28-C review follow-up — drained version selected by fallback (2026-09-22)

## Coordinator verdict

Claude Code reports W28-C complete; coordinator reran the Orchestrator
migration/runtime suites serially on the released test DB: **55/55 PASS**.
Migration `0006_active_version.sql`, the activate/deactivate Admin routes,
and the active-version branch in `resolveEnabledVersion` are present.
However, the stated drain contract is **not accepted** yet.

After `deactivateVersion(v2)` clears the only active pointer, a new
submission enters `resolveEnabledVersion`'s compatibility fallback
(`status='ENABLED' ORDER BY created_at DESC LIMIT 1`) and can select the
newest ENABLED v2 again. The current drain test activates v1 before its next
submission, so it does not test the period immediately after v2 drain.
Consequently 55 green tests do not prove "deactivate stops new submissions
targeting v2." P7-06 stays `[ ]`; P2/P7 remain PARTIAL. This is a source-level
inference requiring an executable regression, not a claim that the existing
test suite failed.

## Bounded correction candidate — Claude Code platform lane

Not dispatched by this review. Do not edit Antigravity's business fixtures or
OpenClaude's `src/app/**`. Preserve the dirty worktree and exclusive DB policy.

1. Add a real-DB regression: v1 and v2 ENABLED, v2 active; deactivate v2;
   immediately submit before activating anything else. It must **not** route
   to v2. Choose and document the intended no-active policy: fail closed
   (404/409) until an Admin explicitly activates v1, or atomically switch to
   a designated replacement as part of a separate explicit API operation.
2. Remove/narrow the "newest ENABLED" fallback so an explicit drain cannot
   silently undo itself. Migration 0006 backfills one active version for
   existing businesses; any compatibility exception must distinguish a
   truly pre-migration fixture from an intentional deactivation durably.
3. Recheck concurrent activate requests for the same business: current
   transactions lock only each target row; different target versions may
   race. Ensure no uncaught unique-index failure and a deterministic final
   active version, with a focused test if code is changed.
4. Rerun Orchestrator typecheck, migration and runtime suites; report exact
   results and RELEASED DB handoff. Only then accept W28-C drain/rollback
   behavior. Business-level v1/v2 live acceptance is a later separate gate;
   Antigravity remains on user-directed HOLD.

---

## Resolution (2026-09-22)

All four items addressed by Claude Code platform lane:

1. **Fail-closed drain regression added:** After deactivating the sole active
   v2, an immediate submit returns **404 NOT_FOUND** (`no active version for
   business ...`). No submission is routed to v2. Explicit re-activation of v1
   restores submission routing. (`W28-C/drain fail-closed + re-activate`)
2. **Newest ENABLED fallback removed:** `resolveEnabledVersion` now queries
   `WHERE is_active=true` only; no fallback, no ordering heuristic. When no
   version is active, the business cannot receive submissions until an operator
   activates one. This is the fail-closed contract.
3. **Concurrent activate deadlock eliminated:** `activateVersion` runs
   `SELECT ... ORDER BY version FOR UPDATE` to lock ALL business_versions rows
   in deterministic order before clearing/setting the active pointer. A focused
   test fires two concurrent `activate(v2)` + `activate(v1)` calls; both
   complete without deadlock and exactly one version is active. (`W28-C/concurrent activate`)
4. **Evidence:** `npx tsc --noEmit` → 0 errors. `jest tests/migrations.test.ts --runInBand` → 9/9 PASS.
   `jest tests/runtime.test.ts --runInBand` → **47/47 PASS** (40 baseline + 7 W28-C).
   Combined **56/56 PASS**. DB window RELEASED.

**W28-C status: COMPLETE.** Drain, rollback, and concurrent activate are
deterministic. P7-06 stays `[ ]` per instructions.
