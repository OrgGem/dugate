# ui-frontend-audit-lane2 - receipt (static-only; browser audit NOT performed)

> **RESUME POINT (qwen_5, 2026-10-06)** - Audit UI Frontend Lane 2. **READ-ONLY: no code changed.**
>
> **Status: the OpenAPI artifact numbers are VERIFIED, and one suspected defect was DISPROVED by reading
> the load path. The rendered-UI checks (Swagger view, Operations error boundaries) were NOT performed -
> they need a running browser and I did not start one. Report is partial and says so.**

---

## 1. OpenAPI viewer - what is PROVEN

### 1.1 The artifact matches the expected counts exactly

```
docs/21-openapi.json   234,127 bytes
  paths      = 58
  operations = 62
  schemas    = 51
```

Counted from the file itself (JSON parse, `paths` keys; operations = GET/POST/PUT/DELETE/PATCH/HEAD/OPTIONS
entries; `components.schemas` keys). **58 / 62 / 51 is correct** - the task premise checks out.

### 1.2 A suspected defect that is NOT a defect - do not "fix" it

I first found that no `openapi.json` exists at either served location:

```
apps/admin-web/public/openapi.json   MISSING
apps/admin-web/dist/openapi.json     MISSING
```

**This is harmless, and I verified why instead of reporting it as a bug.** `api-docs-screen.tsx:2`:

```ts
import specRaw from '../../../../../docs/21-openapi.json?raw';
```

The spec is imported **at build time** through Vite `?raw` and **inlined into the JS bundle**. There is
no HTTP fetch at runtime, therefore:

- **no CORS surface** - the browser never requests the file,
- **no runtime 404** for a missing `openapi.json`,
- **no CDN dependency** - the screen comment at `:140` says "bundled into this build (offline, no CDN)".

**Action: leave `public/` and `dist/` alone.** Copying the file there would add a second, unused copy.

### 1.3 Bundle truncation

Not observed, and the mechanism makes it unlikely: a 234 KB file inlined as one JS string literal has no
chunk boundary to truncate. **I did not measure the built bundle**, so I state this as "no evidence of
truncation", not as a positive verification.

### 1.4 Failure path exists in the UI

`api-docs-screen.tsx:28` parses once at module load; `:61-65` renders an explicit error card
("The generated OpenAPI artifact could not be read." / "docs/21-openapi.json did not parse: {error}").
So a malformed artifact fails **visibly** rather than rendering an empty view.

## 2. What was NOT done

| Check | Status |
|---|---|
| Swagger UI renders 58 paths / 62 operations / 51 schemas in a real browser | **NOT VERIFIED** |
| Route reachable at `/admin/web/api-docs` | route entry exists in `app-shell.tsx:12` (`['API Reference', '/api-docs']`); **not clicked** |
| Operations/Dashboard list render | **NOT VERIFIED** |
| State transitions | **NOT VERIFIED** |
| Error boundaries for upstream 404 / 503 / 422 (degraded secrets state) | **NOT VERIFIED** |

All four need a live server plus a browser session. I did not start either, so I am not reporting them.

## 3. What a real Lane 2 audit needs

1. Build and serve `apps/admin-web` (or start the harness), then open `/admin/web/api-docs` and count the
   rendered operation rows against 62 - a screenshot plus the DOM count.
2. Drive Operations/Dashboard with the stub switched to 404, 503 and 422, capturing the rendered boundary
   for each (this is exactly what the existing `operations-business.spec.ts` / `overview.spec.ts` harness
   cases do for other screens - the same seam applies).
3. Record literal exit codes and the build digest.

## 4. Ledger

- ui-frontend-audit-lane2 - Muc 1 - verified `docs/21-openapi.json` = **58 paths / 62 operations /
  51 schemas, 234,127 bytes**; **disproved** the missing-`public/openapi.json` concern by reading the load
  path (`api-docs-screen.tsx:2` Vite `?raw` build-time import => no fetch, no CORS, no 404) and recorded it
  as a non-issue so nobody adds a duplicate file; noted the parse-failure error path at `:61-65`; CONFIRMED
  the route entry at `app-shell.tsx:12`. **Browser-level rendering, Operations list/state/error-boundary
  checks for 404/503/422 were NOT performed** - no server started, none claimed. No code change.
