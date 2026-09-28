# W-DOCS-SYNC-1 -- Publish T200-D1 + fix T200-E1 anchors + sync README pointer

**Owner:** Docs and Evidence (term_8ba9a7d5, qwen-code qwen3.8-flash)
**Priority:** P2 -- closes documentation/contract drift from Turn 200
**Due:** after 0019 decision or in parallel (docs only, no DB)

## Objective
- T200-D1: Publish wire-visible 422 UNSUPPORTED_STORAGE_BACKEND (submission.ts:119) into contract enum + docs/06 (backend condition for sourceUrl) + update docs/28:705 and docs/35-acceptance-baseline rows (PostgreSQL case now rejected at admission, not parked); decide capability-gating vs 422.
- T200-E1: Repoint qwen-docs.md:2226 anchors from review.md#L1006/#L1007 to actual 993/994 (inbound-anchor content assertion).
- README pointer: move tasks/README.md:3 canonical pointer from Turn 190 (#L977) to Turn 200 (#L1018) (lane-owned file).
- Acceptance: grep UNSUPPORTED_STORAGE_BACKEND appears in contracts + docs/06; docs/28+35 rows reworded; anchors correct; README points at Turn 200; BROKEN=0 link check.

## Read first
- coordination/reports/review.md T200-D1 + T200-E1 text
- packages/contracts/src/operations.ts:232 sourceUrl decl
- docs/06, docs/28, docs/35, docs/20 link-check docs
- qwen-docs.md:2226 anchor lines
- tasks/README.md:3 pointer line

## Ownership
- Allowed write: docs/06, docs/19, docs/20, docs/22, docs/28, docs/35, docs/admin-ops-monitoring-cost.md, tasks/README.md, qwen-docs.md Sec 22
- Shared: packages/contracts/src/operations.ts needs Platform/Core review (contract bump)
- Non-goal: product source beyond contract enum, live verification

## Work sequence
- [ ] Contract enum add
- [ ] docs/06 publish backend condition
- [ ] docs/28 + docs/35 resync
- [ ] Fix qwen-docs.md anchors
- [ ] Move tasks/README.md pointer to Turn 200 #L1018
- [ ] Link-check BROKEN=0

## Handoff format
Outcome; changed paths; contract version; BROKEN count; remaining: none for this scope.
