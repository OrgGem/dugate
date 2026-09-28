# W-INGEST-0019-1 -- Migration 0019 COALESCE expression index for deadline_at (T180-A1/T190-A1 answer)

**Owner:** Platform Core (term_40f7f60f, qwen-code qwen3.8-max) -- orchestrator runtime
**Priority:** P2 -- answers live-FALSIFIED deadline branch from T-35
**Due:** after T-37 sweep or in parallel if no file conflict
**Prerequisite:** Turn 190/200 decision: 0019 as NEW migration, never edit applied 0018 (Delta 24)

## Objective
- Task: Create migrations/0019_operations_deadline_coalesce_index.sql with COALESCE expression index(es) that match the route ORDER BY COALESCE(deadline_at, sentinel).
- Acceptance: migration file correct (IF NOT EXISTS, no DROP/ALTER, header cites why 0018 not edited and sentinel semantics); reviewed for non-concurrent CREATE INDEX write-lock impact (note in header); accompanied EXPLAIN plan shows Index Scan without Sort on deadline branch (to be live-verified by Tester in later window).
- Evidence: migration SQL file + tsc lint 0 + offline guard if any; handoff notes write-lock review decision.

## Read first
- services/orchestrator/src/server.ts deadline ORDER BY at :2547 / :2593
- services/orchestrator/migrations/0018_operations_sort_keyset_indexes.sql (do not edit)
- coordination/reports/tester.md T-35 deadline_at FAIL evidence (Sort->Seq Scan)
- coordination/reports/review.md Turn 190 T180-A1 + Turn 200 roadmap item 4
- coordination/reports/qwen-admin.md Sec 17-18 (deadline caveat)

## Ownership
- Allowed write: services/orchestrator/migrations/0019*.sql
- Read-only: 0018, server.ts, contracts
- Shared: needs Tester live EXPLAIN verification (separate packet)
- Non-goal: editing 0018, deploying, data migration

## Work sequence
- [ ] Design expression index(es) matching COALESCE sentinel form
- [ ] Write 0019 migration file with header (Delta 24, write-lock note, sentinel choice)
- [ ] Local tsc/lint check (no DB needed for file creation)
- [ ] Handoff; Tester will live-verify via EXPLAIN in claimed window

## Handoff format
Outcome; changed path; write-lock review note; remaining: Tester live EXPLAIN + multi-tenant seed.
