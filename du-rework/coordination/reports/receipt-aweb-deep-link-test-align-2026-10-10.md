# Receipt: AWEB deep-link hydration boundary coverage

- Task: `AWEB-DEEP-LINK-INTEGRATION-TEST-SUITE-ALIGN-2026-10-10`
- Completed: 2026-10-10 16:13 UTC
- Scope: `du-rework` only
- Changed file: `orchestrator/apps/admin-web/tests/deep-link-query-hydration.test.mjs`

## Added boundary coverage

- Missing query parameters yield the Trace default lookup and Audit default filters.
- Malformed and overlong tenant IDs are rejected; syntactically valid tenant IDs unavailable to the signed-in session are blocked by the Trace and Audit tenant guards.
- Invalid and overlong UTC time bounds are omitted from Audit hydration.
- URL-encoded spaces, plus signs, slashes, question marks, hashes, colons, and percent signs round-trip through Trace IDs and Audit filters.

The tests execute the screen hydration helpers extracted from the actual TSX sources and evaluate the actual tenant guard expressions. No screen or other product source was changed.

## Verification

- Command: `node --test tests/deep-link-query-hydration.test.mjs`
- Working directory: `du-rework/orchestrator/apps/admin-web`
- Result: PASS, exit 0; 8 tests, 1 suite, 0 failures.
- Offline; no external services used.

No files were staged, committed, or pushed.
