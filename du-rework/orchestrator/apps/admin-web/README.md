# @du/admin-web — Orchestrator Portal

React + TypeScript (strict) + Vite + React Router (Data Mode) + Tailwind CSS v4
Orchestrator Portal for DU Platform, served by the Orchestrator Backend under
`admin/` behind a **per-route server flag** (default off; the legacy
rendered shell keeps serving every other route). The package/folder identity
(`@du/admin-web`, `apps/admin-web`) is frozen until the MIG-08C rename.

## Commands

```bash
pnpm --filter @du/admin-web dev        # Vite dev server (proxying not wired yet)
pnpm --filter @du/admin-web typecheck  # tsc --noEmit
pnpm --filter @du/admin-web build      # typecheck + static build to dist/
```

## Layout

| Path | Purpose |
|---|---|
| `src/styles/tokens.css` | **Single token source** — mirrors the rendered shell palette (`shell-render.ts`); see AWEB-00 §4 for the mapping table. |
| `src/styles/app.css` | Tailwind v4 entry; `@theme inline` maps tokens to utilities (`bg-canvas`, `text-ink`, …). |
| `src/app-shell/` | Minimal header/nav/footer shell. No auth or tenant decisions here. |
| `src/routes/` | One trial read-only route (bootstrap) + 404. Real screens land in AWEB-03+. |
| `components.json` | shadcn/ui config. Primitives are owned by AWEB-03 (Antigravity) — this lane only creates the skeleton. |

## Decisions recorded at bootstrap

- Primitive base for shadcn/ui: **Base UI** (`@base-ui/react`, chosen via
  `shadcn init -b base -p nova`; `components.json` style `base-nova`). The
  primitive set is installed by AWEB-03 when the first component lands — this
  lane created the skeleton only (the CLI-generated `button.tsx` was removed to
  respect the AWEB-03 lease).
- Typography: **Inter** only; CTA colour: **`--cf-blue`** (`text-action`/`bg-action`).
  Brand accent stays `--cf-orange`.
- Theme: the token file follows the OS preference (`prefers-color-scheme`), the
  same mechanism as the rendered shell. A user-facing theme toggle is a later
  decision (`dark:` utilities compile but stay inert).
- One palette: shadcn semantic variables (`--primary`, `--background`, …) are
  mapped onto the `--cf-*` tokens in `src/styles/app.css`; no oklch palette of
  its own.
- No `adminToken`/Vault credential ever reaches this app; the browser talks to
  the future BFF (`/admin/api/*`) with the session cookie only (AWEB-02).

## Serving

`vite build` emits `dist/` with content-hashed assets (`assets/*-<hash>.js|css`).
The Orchestrator serves them when `DU_ADMIN_WEB` is enabled — see the mount in
`services/orchestrator/src/app/admin/shell-server.ts`:

- `DU_ADMIN_WEB` unset/empty → mount disabled (route falls through to the legacy
  404, exactly as today).
- `DU_ADMIN_WEB=1` or `=true` → mount at `admin` (default path).
- `DU_ADMIN_WEB=/custom/path` → mount at a custom path.
- `DU_ADMIN_WEB_DIST=<dir>` → override the bundle directory (default resolution:
  `apps/admin-web/dist` relative to the working directory, then relative to the
  compiled server location).
- **`DU_ADMIN_WEB_ROUTES` (per-route rollout allow-list, AWEB-08-prep)** —
  comma-separated SPA route names:
  `overview, profiles, api-keys, connectors, operations, businesses, usage,
  security, identity, settings`.

  | Env | Behaviour |
  |---|---|
  | absent / blank | unchanged: every route is served (today's behaviour) |
  | `overview,security` | those two routes render; every other route answers one consistent 404 document |
  | `overview,bogus` | unknown names are dropped (logged), `overview` still applies |
  | `,` (present, empty after parse) | only the shell root `admin` stays reachable |

  Decision for a route outside the allow-list: the **server answers the same
  404 document for every gated route** (“Route not enabled on this deployment”)
  with a link to `/admin`. We deliberately do **not** auto-redirect and do not
  touch the legacy renderer — the contract rule is “a route that has not been
  migrated keeps using the current renderer”, and the legacy shell already
  serves it at `/admin/<section>`. No client-side filtering is needed, and the
  gate fails closed (a route is only reachable when explicitly listed).

Every mount request passes the existing admin-shell session gate; unauthenticated
browsers are redirected to `/admin/login`. Assets are immutable-cached; the shell
document is `no-store`.

### API Reference (`admin/api-docs`)

The Portal renders the generated OpenAPI artifact `docs/21-openapi.json` at
`/api-docs` (mounted as `admin/api-docs`). The spec is imported as a raw
string at build time, so it ships inside the Portal bundle and loads offline
from the image — no CDN, no runtime fetch, no second spec source. Operations
are grouped/filtered by the `tags` / `x-api-family` metadata the generator
emits (Public / Admin / Runtime / Connector) and each family shows its PM-M02
origin (`servers`). Try-it-out is intentionally absent: the page never sends a
request or a credential.

> **Deployment note (backend allow-list):** `DU_ADMIN_WEB_ROUTES` is validated
> against a hardcoded route-name list in
> `services/orchestrator/src/app/admin/shell-server.ts` (`ADMIN_WEB_ROUTE_NAMES`).
> That list does not yet contain `api-docs` (nor `docs`/`workflows`), so a
> deployment that sets `DU_ADMIN_WEB_ROUTES` will gate this route with the
> consistent 404 document until the backend owner adds the name. With the env
> absent (unrestricted mount) the route is served after the usual session gate.
> This note records the dependency; the backend list is outside the UI lease.

Notes:

- The built asset URLs are fixed to the Vite `base` (`admin/`). A custom
  `DU_ADMIN_WEB` path therefore only works for the environment flag format
  (`1`/`true`); a non-default path needs a rebuild with a matching `base`.
- Dev loops: `pnpm --filter @du/admin-web dev` serves the UI on its own port for
  fast iteration (no session/API — BFF is AWEB-02); the Orchestrator mount is
  the integration surface and needs a rebuild + flag.
