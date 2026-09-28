# W-TYPECHECK-ALIAS-1 -- Fix T200-P1 typecheck no-op (STEP 1 roadmap)

**Owner:** Coordinator (claude-code-session) -- root package ownership per AGENTS.md
**Priority:** P0 -- blocks all future packet STEP6A verification
**Due:** next tick
**Prerequisite:** Turn 200 finding T200-P1

## Objective
- Task: Add typecheck alias to services/orchestrator/package.json so pnpm --filter @du/orchestrator typecheck executes real check.
- Acceptance: pnpm --filter @du/orchestrator typecheck exits 0 and runs tsc --noEmit -p tsconfig.json (same as lint); every past receipt quoting that command becomes non-void; no other behavior change.
- Evidence: one pnpm --filter @du/orchestrator typecheck run with literal exit 0 + file diff of package.json scripts.

## Read first
- services/orchestrator/package.json scripts section
- coordination/reports/review.md T200-P1 text
- coordination/reports/tester.md T-CODEX-TEST-36 deviation note

## Ownership
- Allowed write: services/orchestrator/package.json
- Shared: none
- Non-goal: packet template fix (separate coordinator decision)

## Work sequence
- [ ] Add typecheck script to package.json
- [ ] Run pnpm --filter @du/orchestrator typecheck -> exit 0
- [ ] Run pnpm --filter @du/orchestrator run lint still 0
- [ ] Handoff with command/cwd/exit/raw paths

## Handoff format
Outcome; changed path; tests+command/cwd/exit; raw receipt path; next: unblocks W-T37.
