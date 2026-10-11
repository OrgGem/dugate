# Receipt: AWEB Trace and Audit deep-link hydration tests

- Task: `AWEB-DEEP-LINK-INTEGRATION-TEST-2026-10-10`
- Completed: 2026-10-10
- Scope: `du-rework` only
- Test file: `orchestrator/apps/admin-web/tests/deep-link-query-hydration.test.mjs`

## Change

Added an offline `node:test` suite that executes the actual private hydration helpers from the Trace and Audit screens after extracting their declarations with the TypeScript parser. It verifies Trace operation, correlation, and task identifiers; tenant query parsing and tenant-session fencing; Audit correlation and tenant query values; filter mapping; operation ID resource fallback and explicit resource precedence; and UTC time-bound hydration. Screen wiring assertions ensure initial and changed URLs use those hydration helpers.

## Verification

- `node --test tests/deep-link-query-hydration.test.mjs` from `du-rework/orchestrator/apps/admin-web`: PASS, exit 0; 4 tests, 1 suite.
- `npm run typecheck`: exit 1 due to TS6133, unused `Link` import at `src/features/audit/audit-screen.tsx:3`.
- `npm run typecheck -- --noUnusedLocals false`: PASS, exit 0, no other diagnostics. The default package typecheck remains blocked by the unused import; that source file is outside this task lease and was not changed.
- No external services were used.

No files were staged, committed, or pushed.
