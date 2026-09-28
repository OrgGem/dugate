# Follow-up fixes from code/plan review — 2026-09-24

Source and detailed evidence: [code/plan review](../coordination/CODE-PLAN-REVIEW-2026-09-24.md). These are review notes for later allocation, not dispatched work. Existing [MM](PLAN-MISMATCH-FIXES-2026-09-23.md) and [CR](REVIEW-FIXES-2026-09-23.md) tasks retain their IDs and ownership.

| ID | Severity / status | Fix scope | Acceptance |
|---|---|---|---|
| R24-01 | High / SOURCE FIXED, offline verified; DB-backed gate pending | Tenant-scoped reader is now used throughout long-poll (`server.ts:696`, `runtime.ts:884`); focused offline suite passes in the full review. Do not dispatch the same source fix again. | Foreign active/terminal IDs return prompt 404 without polling; authorized poll completes; exact-build DB-backed regression receipt still required for full closure. |
| R24-02 | Medium / SOURCE FIXED, integration verification pending; FIX-CR-13 | Blob rewrite/base64 fallback removed from P5 multi-service test. Remaining customFetch hooks are fault/claim barriers; native blob bytes are checked against finalized SHA-256/size at test lines 649–659. | Full current-build suite exit 0 and native parsing/checkpoint replay without blob rewriting; P5-10 remains partial until its other acceptance gaps also close. |

The earlier [acceptance baseline](../docs/35-acceptance-baseline.md) records 3 failing multi-container cases and a failing P4-08 consumer case. Those are historical run counts, not a fresh rerun after these source changes. See [current review](../coordination/FULL-REWORK-REVIEW-2026-09-24.md) and [follow-up plan](FULL-REWORK-REVIEW-FOLLOWUP-2026-09-24.md). Investigate each failure independently; do not promote P4-08/P5-10/G4 from a narrower artifact test.
