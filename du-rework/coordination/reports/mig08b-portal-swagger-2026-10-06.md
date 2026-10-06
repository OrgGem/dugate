# PLAT-MIG-08B (Orchestrator Portal naming) + Swagger UI `/admin/web/api-docs` — receipt

Date: 2026-10-06. Owner: OpenCode (`oc_1`), write lease `apps/admin-web/**` (UI source only).
Coordinator notice: master plan opened PLAT-MIG-08 (naming migration) and the PLAT-MIG-03 Swagger UI slice.
No backend/contracts/root-manifest edit was made. No commit, no tick, no push.

## 1. Outcome

- **Naming (MIG-08B):** displayed product name is now **Orchestrator Portal**; where the UI distinguishes the
  server/runtime it says **Orchestrator Backend** (backend), alongside the existing **Connector Service** naming in
  the spec. Folder `apps/admin-web` and package identity `@du/admin-web` stay frozen for MIG-08C, as do the env keys
  (`DU_ADMIN_WEB*`) and every wire path (`/admin/*`, `/api/v1/admin/*`, BFF `/admin/api/*`).
- **Swagger UI:** new route **`/api-docs`** (mounted at `/admin/web/api-docs`) renders the **generated**
  `docs/21-openapi.json` artifact. The spec is imported as a raw build-time asset, so it ships inside the Portal
  bundle and loads offline from the image — no CDN, no runtime fetch, no second spec source, and no request is ever
  sent by the page. Operations are grouped/filtered by the generator's `tags` / `x-api-family` metadata
  (Public / Admin / Runtime / Connector) and each family shows its PM-M02 `servers` origin
  (3000 public, 3002 admin/management+runtime, 8080 Connector). Try-it-out is intentionally absent.
- No third-party Swagger package was added, so no lockfile/root-manifest change was needed inside this lease; the
  viewer is a dependency-free React screen over the generated spec.

## 2. Changed files (all inside `apps/admin-web/**`)

Created:

| File | Purpose |
|---|---|
| `src/features/api-docs/openapi-types.ts` | Narrow OpenAPI 3.0 types + `parseOpenApiDocument` (parse once; failure renders an honest error panel) |
| `src/features/api-docs/api-docs-screen.tsx` | The API Reference screen: family origin cards, family filter, search, operation list/detail, auth schemes, known-absent list, schemas |
| `src/routes/api-docs.tsx` | Route wrapper registered as `api-docs` |

Edited (naming + registration):

| File | Change |
|---|---|
| `index.html` | `<title>DUGate Admin</title>` → `<title>Orchestrator Portal</title>` |
| `src/app-shell/app-shell.tsx` | Brand `DUGate` → `Orchestrator Portal`; nav aria-label → `Orchestrator Portal Navigation`; nav adds `API Reference` → `/api-docs` under Resources |
| `src/components/ui/app-shell-primitives.tsx` | `AppShellBrand` default title `DUGate Admin` → `Orchestrator Portal`; nav aria-label updated |
| `src/routes/bootstrap-home.tsx` | H1 → `Orchestrator Portal bootstrap is running`; “Orchestrator admin shell” → `Orchestrator Backend` |
| `src/routes/not-found.tsx` | “No Admin Web route…” → “No Orchestrator Portal route…” |
| `src/main.tsx` | Root-missing error string updated |
| `src/features/settings/settings-screen.tsx` | Catalog labels: `Orchestrator Portal mount (DU_ADMIN_WEB)`, `Orchestrator Backend port/host (ADMIN_SHELL_PORT/HOST)` (env keys unchanged) |
| `src/features/overview/overview-screen.tsx` | aria-label → `Orchestrator Portal sections` |
| `src/features/connectors/curl-import.ts` | Comment updated (not displayed) |
| `package.json` | `description` → Orchestrator Portal (name `@du/admin-web` unchanged per MIG-08A freeze) |
| `README.md` | Product name/heading; new “API Reference (`/admin/web/api-docs`)” section + the `DU_ADMIN_WEB_ROUTES` deployment note |
| `src/components/ui/README.md` | Opening line updated |
| `vite.config.ts` | Comment updated (no behaviour change) |

`apps/admin-web/**` is untracked in the current working tree, so there is no git baseline diff; the list above is the
explicit packet change set. Frozen identifiers not renamed: folder, package name, `DU_ADMIN_WEB*` env keys, wire
paths, BFF base `/admin/api/*`.

## 3. Verification (real runs)

Cwd `D:/Git/dugate/du-rework`; evidence in `coordination/reports/raw/mig08b-portal-swagger/`.

| Command | Exit | Observed | Evidence |
|---|---|---|---|
| `pnpm --filter @du/admin-web typecheck` | 0 | `tsc --noEmit` clean (strict TS, `noUncheckedIndexedAccess`, no unused) | `portal-typecheck.log` |
| `pnpm --filter @du/admin-web build` | 0 | Vite production build 2678 modules → `dist/assets/index-BFkVsTJy.js` 632.01 kB (gzip 173.38 kB); chunk-size warning only | `portal-build.log` |
| build-output check | — | `dist/index.html` title `Orchestrator Portal`; the emitted JS contains the spec (`PM-M02 Public JSON ingress` ×13, `x-api-family` ×59) → spec is bundled offline | `portal-build.log` (dist paths) |
| Playwright probe (Chromium, against `vite preview` of the built dist at `http://localhost:4173/admin/web/api-docs`) | 0 | **13/13 checks passed**, `externalRequests: []` (zero network beyond the local static assets); screenshots attached | `portal-browser-probe.json`, `portal-api-docs.png`, `portal-api-docs-full.png`, `portal-api-docs-probe.cjs` |

Probe checks that passed: document title; API Reference heading; 57 operation rows; family filter counts
(All 57 / Public 12 / Admin 10 / Runtime 18 / Connector 17); 3000 and 3002 origins rendered; Try-it-out-disabled
note; Admin filter narrows to 10 rows; search `claim` returns the claim operation; selecting
`POST /api/v1/admin/actions` shows the internal 3002 origin, the required-scope row and security JSON;
`Schemas (14)` present.

Probe notes (honest): `vite preview` is a static server with no Orchestrator Backend, so the probe stubs **only**
`/admin/api/session` with the real unauthenticated 401 answer; the single failed response is that stub and the app
renders its normal “Session unavailable” state. Session gating itself is server-side in the shell
(`services/orchestrator/src/app/admin/shell-server.ts`) and was not re-verified here. No live Backend/Portal image
was built or started.

## 4. Blocker recorded for the coordinator (outside this lease)

`DU_ADMIN_WEB_ROUTES` is validated against the hardcoded `ADMIN_WEB_ROUTE_NAMES` list in
`services/orchestrator/src/app/admin/shell-server.ts:335-346`. That list currently contains
`overview, profiles, api-keys, connectors, operations, businesses, usage, security, identity, settings` and does
**not** contain `api-docs` (nor the existing `docs`, `workflows`). Consequence: on any deployment that sets
`DU_ADMIN_WEB_ROUTES`, the new route answers the consistent “Route not enabled on this deployment” 404 before the
app boots. With the env absent (unrestricted mount) the route is served after the usual session gate.

The fix is one name added to that backend list (plus its tests) by the backend/Portal owner — deliberately **not**
done here because the dispatch limits the write lease to `apps/admin-web/**` and forbids backend edits. The
dependency is also documented in `apps/admin-web/README.md` so the MIG-04/08C packaging owner sees it.

## 5. Limitations

- Browser evidence is on the Vite preview build, not on the Orchestrator/Portal image + session gate; packaging
  (MIG-04/MIG-08C) and independent browser verification (VFY-06) remain open.
- No third-party Swagger UI bundle was added; if the Portal owner later prefers upstream `swagger-ui`, that is a
  packaging decision with root manifest/lockfile owners (integrator), not this lease.
- The spec is bundled into the main chunk (632 kB, warning only); code-splitting the route is an optional follow-up.
- The doc screenshot shows values from the current generated artifact (`v1.3.0`, 54 paths / 57 operations /
  14 schemas from the SWAGGER-ORIGIN-DOCS-ALIGNMENT packet). If the artifact changes, the Portal must be rebuilt —
  which is exactly the single-source behaviour intended.

## 6. Evidence index (`coordination/reports/raw/mig08b-portal-swagger/`)

| File | SHA-256 |
|---|---|
| `portal-typecheck.log` | `D6913CAF23028A075C9E711B54E0B81A9BB93D2673B3F949F3C7200F85B3D16A` |
| `portal-build.log` | `F3D9BAE91B14D61C67BCDC672555D23681567AFAC79D23C78D672C5BC4EAE26E` |
| `portal-preview.log` | `C1993109D5161591DFF479604C9BD4E643220240B53556C3F18D5F9172C10893` |
| `portal-browser-probe.json` | `DA85A50E2D22564F2DAC9613B0E6AEC3154D8389834E62FEB056A97749B536B6` |
| `portal-api-docs.png` | `5F7BE45D3E84AA3CE05036EDBF5B5F8C97CE369200AEFF9B8DFC1A7AD1B44FEB` |
| `portal-api-docs-full.png` | `B9E43559452BE7CF2487AE42D1E5F6E9D114561B44F196E089A4D8B5E8E26B8A` |
| `portal-api-docs-probe.cjs` | `E8A825F627C7E1CA1F4986466F65931CF3A0EBFE65BF4D572EEABE3D3863136C` |

## 7. Handoff

- Portal naming slice (MIG-08B UI half): implemented on `apps/admin-web/**`, typecheck/build/browser probe green.
- Swagger UI slice: `/api-docs` implemented and rendered from the generated artifact with PM-M02 family origins;
  Try-it-out off by construction.
- Next owner actions: (a) backend owner adds `api-docs` to `ADMIN_WEB_ROUTE_NAMES` for gated deployments;
  (b) MIG-04/08C integrator packages the Portal (folder rename remains frozen) and VFY-06 runs browser/UI review on
  the exact candidate digest; (c) independent UI review (Antigravity) per current gate before any `[x]`.
