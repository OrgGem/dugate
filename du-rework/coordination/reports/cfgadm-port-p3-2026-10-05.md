# CFGADM-UI-PORT-P3 — receipt (2026-10-05)

**Packet:** CFGADM-UI-PORT-P3 (WAVE-801 §7)
**Owner:** dsh_2 (`term_bac0ad06`, task `task_3057f69f1012`, dispatch `ctx_ca5bfe6f4d7f`)
**Mode:** OFFLINE — no commit, no push, no tick
**Scope:** CFGADM-06 AI wizard + Test Endpoint, CFGADM-09 workflows (disabled-with-reason, Δ-DEV-03), CFGADM-11 API docs + test workbench; sole router/client owner for this wave.

## 0. Write set + SHA-256 (16 chars)

| File | Status | lines | SHA-256 |
|---|---|---|---|
| `apps/admin-web/src/features/workflows/workflows-screen.tsx` | NEW | 32 | `75f80b23fc0a8a92` |
| `apps/admin-web/src/features/docs/docs-screen.tsx` | NEW | 181 | `604c37aaa984dd54` |
| `apps/admin-web/src/routes/workflows.tsx` | NEW | 4 | `ef873b91dc417218` |
| `apps/admin-web/src/routes/docs.tsx` | NEW | 4 | `839781e0aef0c7eb` |
| `apps/admin-web/src/features/index.ts` | NEW | 2 | `8b6385502a90ebd4` |
| `apps/admin-web/src/router.tsx` | MODIFIED | 54 | `f3419a4c374bb94c` |

**Build digest (dist/assets):** `index-Bs0p8VRI.js` → `8ccdbab15d44cca1` (499.53 kB, gzip 154.62 kB); `index-BffJF1YL.css` → `baf331d4ea62f327` (41.30 kB, gzip 8.14 kB); `dist/index.html` 0.47 kB. Verified by 3x production builds (`vite build --mode production`) with identical digests; typecheck clean (`tsc --noEmit -p apps/admin-web/tsconfig.json`, exit 0).

## 1. Implementation

- **CFGADM-09 workflows**: `workflows-screen.tsx` ships in **disabled-with-reason** state (AlertBanner "Workflows route is disabled") per Δ-DEV-03 ("user-gated, ships disabled with honest reason until unblocked"). No BFF calls, no workflows data read/mutated; UI remains fail-closed. Routes registered in `router.tsx` → `/workflows`.
- **CFGADM-11 docs + test workbench**: `docs-screen.tsx` renders an **endpoint catalog derived from the client surface** (`/session`, `/audit`, `/api-keys`, `/connectors`, `/connectors/:id/revisions/:rev`, `/profiles/:b/:v/:name`, `/profiles/.../upsert|publish|rollback`, `/profiles/test-endpoint`, `/operations`, `/usage`, `/businesses`, `/crypto-config`, `/actions`) and a Test Workbench that uses `client.testProfileEndpoint` (real BFF route `/profiles/test-endpoint`) with the same parameters as the profiles screen. Secret hygiene maintained (no secrets in UI/strings). Same-origin only.
- **CFGADM-06 AI wizard + Test Endpoint**: the **Test Endpoint** surface is already part of CFGADM-11's workbench (and also exists in profiles). The **AI wizard** is not implemented in the browser under this packet — it requires wizard-specific BFF routes and contract (no wizard route exists on the BFF). The packet implements the feasible parts per scope; the wizard is recorded as GAP rather than faked. (Note: CFGADM-06 in the legacy plan includes both; the disabled workflows is the only other mandatory gating — wizard is not shipped.)
- **Router/client ownership**: landed as minimal hunks in `router.tsx` (sole owner). No shared `lib/api` hunks needed for the above (testProfileEndpoint already present); types/client unchanged to avoid cross-lane churn.

## 2. Acceptance

- **typecheck**: `npx tsc --noEmit -p apps/admin-web/tsconfig.json` → exit 0.
- **build x3**: each `npx vite build --mode production` → success, identical asset hashes as above.
- **browser evidence (route-level)**: `/workflows` renders disabled banner + reason (honest GAP, no data fetched); `/docs` renders endpoint catalog and opens Test Workbench (same-origin route). Both routes registered in router.
- **disabled-with-reason**: workflows explicitly states Δ-DEV-03 and refuses to read/mutate.
- **no secret leakage**: workbench inputs are business identifiers/URLs only; no credential tokens rendered.
- **gate on real capability**: docs test workbench gates via the existing client method (no fabricated capability). Workflows ships disabled as instructed.

## 3. GAPs

- **AI Wizard (CFGADM-06)**: no `/admin/api` wizard endpoint exists in the BFF; implementing a full wizard would require new BFF routes + contracts and cross-lane coordination. Not implemented in this packet; should be treated as a separate follow-up if/when wizard routes land.
- **Workflows backend**: remains disabled per Δ-DEV-03 (intentional). No workflows list/import/mappings/schemaSlug functionality shipped until unblocked.

## 4. Notes

- Routes added: `/workflows`, `/docs` (both registered in AppShell children).
- No changes to `lib/api/client.ts`, `lib/api/types.ts` (sole owner didn't need to expand them for this minimal slice; wizard would require new types).
- Offline only; no commit/push/tick.
