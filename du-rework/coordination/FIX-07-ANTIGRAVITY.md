# Antigravity — follow-up 07: repair example-review before P7 acceptance

User authorized these fixes on 2026-09-21. The 7 suites / 29 tests, package build/lint and local image ID have been independently verified. P7-01/02 completion remains under review because the current tests do not exercise the failures below.

## Ownership

Write only businesses/example-review/**, coordination/reports/antigravity.md and coordination/requests/antigravity.md. Claude owns Orchestrator/SDK/contracts, infra, root dependency files and central tasks/gates. Preserve concurrent edits; no reset/clean/stash/rebase, broad staging, or new agents.

## Required fixes

1. **A07-01 — durable approval context and child join.** mainReviewHandler computes items, then waits without persisting them; resume reads input.childReviews or an empty array. Persist and restore actual review context through documented public SDK checkpoint/artifact surfaces. Test initial run -> wait -> fresh context/process -> approval using unchanged original input, without injecting childReviews from the test. Restore authoritative child results on join through the actual SDK contract; if unavailable, report that exact platform gap and keep live join blocked. Client-provided childReviews must not bypass document review.
2. **A07-02 — valid persisted references.** aggregate.reviewsRef is assigned after JSON serialization/write, leaving the stored output empty. Define a valid non-circular reference layout (for example a separate persisted item-review artifact referenced by the output) compatible with the documented output contract. Test the downloaded persisted bytes, not just in-memory objects. Check itemArtifactRef for the same issue.
3. **A07-03 — provider failures and fencing.** Reasoning exceptions currently become notes and may produce approved=true. Distinguish optional unbound reasoning from a configured call that fails, is pending, UNKNOWN, or loses its lease. Never silently approve on an unresolved required check or blind-retry UNKNOWN. Honor configured profile behavior and use stable step/checkpoint identity to avoid duplicate inference after resume. Add failure/pending/UNKNOWN/cancel/lease-loss regression cases; record platform gaps instead of faking continuation.
4. **A07-04 — strict validation and replay.** Reject malformed approval (Boolean('false') must not approve), malformed child results, invalid boolean fields and caller-supplied internal continuation state. Validate resumed data using the declared schema. Ensure timestamp fields do not make repeated logical work nondeterministic: persist them in checkpoints or use a documented stable source. Test realistic replay with a fresh context.
5. **A07-05 — package/image evidence.** Run package tests/lint/build. Rebuild the image from the corrected source and record the new image ID, distinguishing it from a registry RepoDigest. Verify build does not depend on copied host dist/node_modules artifacts; build required workspace dependencies explicitly. Smoke-test a valid configured entrypoint where infrastructure permits; a missing-env rejection alone does not prove worker operation.
6. **A07-06 — honest report.** Correct the outdated claim that admin enable is absent: the route exists in services/orchestrator/src/server.ts. Check current Claude report/gates for children/wait/resume availability. Record exact remaining blockers. Reconcile the internally inconsistent 450-test/47-suite workspace claim; report package counts actually executed and leave workspace aggregation to Claude if not rerun. Do not declare P7-03..07 complete from local mocks.

## Handoff

Report each A07 ID as DONE/PARTIAL/BLOCKED with exact commands/results and unresolved contract requests. Read coordination/FIX-07-CLAUDE.md for the peer boundary. Do not edit central task checkboxes; report evidence for the platform owner to reconcile. No production deployment or Git push is requested.
