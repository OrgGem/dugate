# Receipt — AWEB-20b Operations Recovery

**Recorded:** 2026-10-10 13:44:43 UTC  
**Lease:** `apps/admin-web/src/features/operations/operations-screen.tsx` and related offline tests.

## Delivered

- Bulk cancel continues to the remaining targets after either an API rejection or a thrown transport error.
- Only successful operation IDs are removed from the current selection. Failed IDs retain their selection and their idempotency key for another attempt.
- The screen reports exact succeeded and failed counts. A separate alert lists each failed operation ID with its title, error code, and HTTP status when available. Unexpected transport exceptions receive a safe generic message rather than exposing the raw exception.
- The offline harness now covers a three-item batch with one success, one API failure, and one thrown transport failure. It verifies all targets were attempted, only the success was deselected, and the summary and per-item details are visible. The harness also matches the current checkbox event and timeline label.

## Verification

| Command | Result |
|---|---|
| `node tests/operations-timeline-filters-offline.cjs` from `services/orchestrator` | PASS — 17/17 assertions |
| `npx vite build` from `apps/admin-web` | PASS — bundle generated; Vite reports the main chunk exceeds 500 kB |
| `git diff --check` for the leased source and test paths | PASS — exit 0 |
| `npm run build` from `apps/admin-web` | FAIL — TypeScript reports the unrelated out-of-lease mismatch at `src/lib/api/client.ts:385`: `profileKeyAction` returns `ProfileMutationResult` while its interface requires `PostActionResult`. This packet did not edit that file. |

No files were staged or committed, nothing was pushed, and no gate was ticked.
