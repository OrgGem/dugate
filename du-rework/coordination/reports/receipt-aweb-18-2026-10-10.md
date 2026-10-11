# Receipt — AWEB-18 Audit Console

**Recorded:** 2026-10-10 13:25:52 UTC  
**Scope:** `apps/admin-web/src/router.tsx`, `apps/admin-web/src/app-shell/app-shell.tsx`, `apps/admin-web/src/features/audit/**`, `apps/admin-web/src/routes/audit.tsx`, and the audit offline test.

## Delivered

- Registered `/audit` and added Audit to the Administration navigation.
- Added the route component and Audit Console screen using the existing `listAudit(query)` client method.
- Sent tenant scope, limit, cursor, sort, severity, action, actor, resource, and UTC-converted from/to bounds through the BFF query. The screen requires an active tenant and shows its scope beside the results.
- Added next/previous keyset navigation; query and tenant changes invalidate the prior cursor.
- Restricted CSV export to admin/operator sessions. Export covers only the visible page and allowlisted metadata columns; it omits the message/payload, quotes CSV cells, and prefixes spreadsheet formulas with an apostrophe.
- Added offline tests for query construction, omitted empty filters, cursor parsing, local-to-UTC conversion, and CSV allowlisting/injection protection.

## Verification

| Command | Result |
|---|---|
| `node --test tests/audit-state.test.mjs` (from `apps/admin-web`) | PASS — 5/5 tests |
| `npx vite build` (from `apps/admin-web`) | PASS — production bundle generated; Vite reports the existing main chunk exceeds 500 kB |
| `git diff --check -- <AWEB-18 paths>` | PASS — exit 0 |
| `npm run build` (from `apps/admin-web`) | FAIL — TypeScript stops at the unrelated, out-of-lease mismatch in `src/lib/api/client.ts:385`: `profileKeyAction` returns `ProfileMutationResult` while its interface requires `PostActionResult` (`action` is missing). This packet did not edit that client file. |

The screen and route bundle through Vite. The package build is not fully green until the separate client type mismatch is resolved; no out-of-lease file was changed to work around it.

No files were staged or committed, nothing was pushed, and no gate was ticked.
