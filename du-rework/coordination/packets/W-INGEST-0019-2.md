# W-INGEST-0019-2 -- Fix param-vs-literal mismatch for deadline_at COALESCE (F01, Turn 219)

**Owner:** Platform Core (term_40f7f60f, qwen-code qwen3.8-max) -- services/orchestrator/src/server.ts
**Priority:** P1 -- HIGH MISMATCH blocking T180-A1/T190-A1 live verification; predecessor W-INGEST-0019-1 landed 0019 indexes but query will not use them
**Due:** Next coding turn after Verify confirms F01 (or immediately -- F01 is deterministic, no live DB needed to fix)
**Prerequisite:** Hourly review Turn 219 (wf_ca9b3cce-616 review:0019 F01 HIGH + F07 MEDIUM) -- findings already in journal, Verify phase will confirm isReal

## Objective
- Fix `services/orchestrator/src/server.ts:bindOperationsListSortKey` (and cursor path that reuses its `sortKeySql`) so the ORDER BY / cursor predicate COALESCE matches the 0019 expression indexes character-identically. Today query binds sentinel as `$n::timestamptz` Param node while index bakes `'0001-01-01T00:00:00.000Z'::timestamptz` Const literal -- Postgres planner treats Param != Const and will not select `operations_*_deadline_coalesce_*_id_idx`, reproducing T-35 falsification (Sort->Seq Scan).
- Acceptance: `pnpm --filter @du/orchestrator typecheck` exit 0 (or `npx tsc --noEmit` if typecheck alias missing -- see T200-P1), grep shows ORDER BY contains inline `'0001...'::timestamptz` / `'9999...'::timestamptz` literals (not `$n`) for deadline_at sort; cursor predicates still bind only boundary values (`$::timestamptz`, `$::uuid`), not sentinel; existing suites still pass.
- Evidence: diff of server.ts + typecheck literal + before/after SQL snippet in packet receipt.

## Read first
- `services/orchestrator/src/server.ts:2526-2595` -- `OPERATIONS_LIST_NULL_SORT_BOUND_SQL`, `bindOperationsListSortKey`, `bindOperationsCursor`, `listOperationsPage` (note sortKeySql reused for ORDER BY + cursor predicate)
- `services/orchestrator/migrations/0019_operations_deadline_coalesce_index.sql:66-79` -- target Const literals to match
- `coordination/reports/coordinator-claude.md` Turn 219 -- F01/F07 context, sentinel direction mapping
- `subagents/workflows/wf_ca9b3cce-616/journal.jsonl` -- review:0019 F01 detail (Param vs Const, bindOperationsCursor:2593 same mismatch)

## Ownership
- Allowed write: `services/orchestrator/src/server.ts` (only `bindOperationsListSortKey` and minimal cursor plumbing if sentinel currently counted in params length)
- Read-only: migrations 0017/0018/0019 (do not edit -- Delta 24), contracts, docs
- Non-goal: editing migrations, changing sentinel values, changing index names, adding CONCURRENTLY

## Work sequence
- [ ] Change `bindOperationsListSortKey(sort, params)` to return `COALESCE(deadline_at, '0001-01-01T00:00:00.000Z'::timestamptz)` / `'9999-12-31T23:59:59.999Z'::timestamptz` inline per direction, WITHOUT `params.push`. Signature may drop `params` arg or keep it unused for nullable branch -- keep minimal diff; cursor boundary `$::timestamptz` / `$::uuid` stays param-bound.
- [ ] If `params.length` was used to name sentinel placeholder, remove that coupling so filter placeholders do not renumber. Verify `listOperationsPage` pageParams still orders: filter params -> cursor boundary params -> limit.
- [ ] `npx tsc --noEmit -p tsconfig.json` (services/orchestrator) exit 0.
- [ ] Optional local smoke: construct a sample ORDER BY string and assert it contains the literal and no `$` for sentinel.

## Handoff format
Outcome; changed path + diff summary; typecheck exit code; SQL snippet before/after; remaining: Tester live EXPLAIN (COSTS OFF, both directions, tenant-scoped + cross-tenant) must show Index Scan on `operations_*_deadline_coalesce_*_id_idx` without Sort.

## Re-plan note
This is a re-plan of W-INGEST-0019-1. The migration (4 indexes, IF NOT EXISTS, NOT CONCURRENTLY, sentinel-identical) is correct; only the query side was incomplete. Applying 0019 without this fix would leave indexes dead code -- live EXPLAIN would falsify identically to T-35. Reviewer merged mode: coordinator authored 0019, so cross-check via Tester live EXPLAIN before ACCEPTED per AGENTS.md.
