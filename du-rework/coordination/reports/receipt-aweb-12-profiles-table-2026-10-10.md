# AWEB-12 receipt: Profiles table view

Date: 2026-10-10

Implemented a tenant-scoped Profiles catalog in the Admin Web Profiles screen. It supports a business filter, groups rows by business, displays profile name, business version, active/disabled status, active profile-to-key count, and bound actions, and opens a selected profile by its business/version/name identity. Paging uses the BFF cursor; loading, empty, unauthenticated/forbidden, malformed-response, and upstream/network error states are distinct. The client rejects rows returned outside the selected tenant or business.

Added the read path needed by the screen: `GET /admin/api/profiles` forwards only business and pagination filters, derives tenant scope from the authenticated principal, and enforces the tenant-operator fence. `GET /api/v1/admin/profiles` applies a mandatory tenant SQL predicate and optional business predicate, returning safe profile metadata without API key material. Added frontend API types/client support and strict response parsing.

Offline coverage:

- `node --test tests/profiles-state.test.mjs` — 3 passed.
- `npm run test:unit -- --runTestsByPath tests/aweb12-profile-list.test.ts tests/aweb04-bff-profiles.test.ts` — 14 passed.
- Orchestrator `npm run typecheck` — passed.
- Admin Web `npx tsc --noEmit -p tsconfig.json --noUnusedLocals false` — passed; `npx vite build` — passed.
- The final standard Admin Web `npm run typecheck` / `npm run build` attempt reports the unrelated existing strict error `src/features/operations/operations-screen.tsx(134,9): 'applyCursor' is declared but its value is never read`. Vite also reports its existing >500 kB chunk advisory.

No files were staged; no commit or push was made; no gate was ticked.
