# AWEB audit event links unit test receipt

- Closed GAP 1 from section 4 bullet 1 of the independent DSH2 audit simulation metrics review.
- Added a standalone offline suite at `orchestrator/apps/admin-web/tests/audit-event-links.test.mjs`.
- The suite extracts and executes the production `safeQueryValue` and `auditEventLinks` helpers from the Audit screen through the TypeScript AST.
- Coverage includes operation resources linking to Trace, valid non-operation resources linking only to Audit, trimming and URL encoding of special characters, invalid and empty resources returning null links, and operation identifiers over the Trace limit retaining only the Audit link.
- Verification from `du-rework/orchestrator/apps/admin-web`: `node --test tests/audit-event-links.test.mjs` passed all 5 tests with exit code 0.
- No files were staged, committed, or pushed.
