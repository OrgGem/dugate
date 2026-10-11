# VERIFY — OPU-G4 toast notifications + global error boundary (independent) — 2026-10-08

- **Verifier**: oc_3 (independent; source read from disk, no lane report trusted).
- **Mode**: READ-ONLY — no source/test edits, no commit, no `git add`, no push,
  no gate ticks, no `docs/21-openapi.json` hand-edit, `.env.live` never read.
  **Offline only** — no PostgreSQL, no Redis, no DB window claimed.
- **Scope**: `du-rework` only.

## Command table (literal + exit code)

| # | Command | cwd | Exit | Literal |
|---|---|---:|---|---|
| 2 | `node tests/admin-toast-error-boundary-offline.cjs` | `orchestrator/services/orchestrator` | **0** | `PASS admin toast/error boundary offline harness (14 assertions)` |
| 4 | `pnpm --filter @du/admin-web typecheck` | `orchestrator/apps/admin-web` | **0** | engine warnings only (`wanted: node >=24.21.0 <25`, current `v22.16.0`) — warnings, not failures; script ran `tsc --noEmit -p tsconfig.json` and exited 0 |
| 5 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | `orchestrator/services/orchestrator` | **0** | no output (0 bytes) |

Full console captures kept outside the repo at `%TEMP%\verify-g4\`.

## Code reading

### `apps/admin-web/src/components/ui/toast.tsx` (new file, 130 lines)

- **Provider**: `ToastProvider` (`:42-66`) — context provider rendering `children`
  plus `<ToastViewport items onDismiss>` (`:63`).
- **Hook**: `useToast` (`:68-72`) — **throws** if used outside the provider
  (`:70`), so misuse fails fast instead of silently dropping messages.
- **Components**: `ToastViewport` (`:74-81`, fixed overlay, `z-[100]`, returns
  `null` when empty), `ToastItem` (`:83-101`, `role="alert"` for errors /
  `role="status"` otherwise, visible **Dismiss** button `:96`),
  `GlobalErrorBoundary` (`:103-123`).
- **External dependencies**: only `react` (`:1-2` — `Component, createContext,
  useCallback, useContext, useEffect, useMemo, useRef, useState` + `ReactNode`
  type). **No third-party dependency added**; `apps/admin-web/package.json` is
  untouched (`git status` clean for it).
- **Dismiss / cleanup**: manual dismiss (`dismiss` `:52-54` + button `:96`) and
  auto-dismiss via `window.setTimeout` — 8 s error / 5 s success (`:85`) — with
  `return () => window.clearTimeout(timeout)` (`:86`). **No `setInterval`
  anywhere in the file** ⇒ **no interval leak**; timeout cleanup is bound to
  item id/variant changes and unmount.

### `apps/admin-web/src/app-shell/app-shell.tsx`

- **Mount points**: `AppShell` (`:20-28`) wraps
  `<GlobalErrorBoundary><ToastProvider><AppShellContent/></ToastProvider></GlobalErrorBoundary>`
  — boundary outermost, provider around the shell content (`:22-26`).
- **Health strip intact**: the existing `<section aria-label="System health">`
  (`:103-116`) is untouched inside `AppShellContent`; every field keeps its
  `'Unavailable'` fallback (`:105-109`), sampling age (`:110-114`) and the
  `Health details` link (`:115`) remain. The toast viewport is a fixed overlay
  (`z-[100]`) rendered as a sibling of the content — it does not replace or
  unmount the strip. Routed screens remain mounted via `<Outlet />` (`:141`).
- Existing intervals are pre-existing and cleaned up (`now` ticker `:47-48`,
  health poll `:73-77`).

### Error boundary behaviour when no message

- `getDerivedStateFromError` stores `errorMessageOf(error)` (`:106-108`);
  `errorMessageOf` returns a **trimmed string or `null`** and only ever reads
  `typeof error === 'string'` or `error.message` (`:125-130`) — no other fields.
- Render shows `{this.state.errorMessage ?? 'Unavailable'}` (`:116`) — i.e.
  **"Unavailable" when there is no message**, never `0` and never a stack. The
  harness pins this (`assertion :24`) and pins the absence of `error.stack` /
  `stackTrace` (`assertion :25`).

## Scope of the change

Exactly 3 files (`git status`): `app-shell.tsx` (`M`), `toast.tsx` (`??`, new),
`tests/admin-toast-error-boundary-offline.cjs` (`??`, new harness). No other
product file carries the G4 change; no dependency files changed.

## FAIL section

**None.** No command failed; no test name/expected/received to report.

## Factual notes (no interpretation)

1. The harness is a **static source-text harness** (14 regex/`fs` assertions on
   `toast.tsx` + `app-shell.tsx`), not a DOM render — it verifies structure and
   mount order, not runtime rendering behaviour. The two typechecks are the
   only compile-level verification here.
2. `useToast` currently has **no consumers** in `apps/admin-web/src` (grep: only
   the definition + the throw). The provider/hook infrastructure exists; no
   screen calls `success`/`error` yet at this revision.

## Verdict

**PASS on the verified scope.** Harness PASS (14/14, exit 0); both typechecks
exit 0; the four design questions check out: provider + hook + components exist
with react-only imports; the shell mounts boundary → provider → content with the
health strip and `<Outlet/>` intact; the boundary falls back to "Unavailable"
with no fake stack; toasts have manual + timed dismiss with proper cleanup and
no interval leak.

## Constraints confirmation

No source/test edits; no commit, no `git add`, no push; no gate ticks; no
`docs/21-openapi.json` edits; `.env.live` never read or printed; offline only
(no PostgreSQL/Redis, no DB window). The only file this lane creates in the repo
is this receipt.
