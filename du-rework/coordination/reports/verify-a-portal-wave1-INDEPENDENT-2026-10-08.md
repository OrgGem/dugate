# VERIFY-A (independent) — Portal Wave 1 — 2026-10-08

- Verifier: Agent A — OpenCode (`oc_4`). **Read-only**: no source/test edits, no commit/add/push, no gate tick, no `docs/21-openapi.json` edit, no `.env.live` read, offline (no PG/Redis started), `du-rework` only.
- Tree: HEAD `72e225a`, working tree dirty (wave-1 lanes). All results below were run by me on the current disk; no receipt was trusted.
- Scope of this pass: typecheck admin-web + the 5 offline harnesses + orchestrator tsc, plus the requested variable-usage check on `overview-screen.tsx`.

## Command matrix (literal)

| # | cwd | Command | Exit | Literal result |
|---|---|---|---:|---|
| 1 | `du-rework/orchestrator/apps/admin-web` | `pnpm --filter @du/admin-web typecheck` | **0** | `> tsc --noEmit -p tsconfig.json` — no output after it; **0 lines matching `error TS`** |
| 2 | `du-rework/orchestrator/services/orchestrator` | `node tests/portal-auto-refresh-offline.cjs` | **0** | `PASS: OPU-G2 auto refresh + data age — 9 scenarios …` (9/9 ok) |
| 3 | `du-rework/orchestrator/services/orchestrator` | `node tests/admin-toast-error-boundary-offline.cjs` | **0** | `PASS admin toast/error boundary offline harness (14 assertions)` |
| 4 | `du-rework/orchestrator/services/orchestrator` | `node tests/operations-download-live-offline.cjs` | **0** | `PASS operations-download-live-offline.cjs - 6 assertions (OPU-OPS-1 x2, OPU-OPS-2 x4)` |
| 5 | `du-rework/orchestrator/services/orchestrator` | `node tests/api-docs-build-label-offline.cjs` | **0** | `RESULT: PASS (24 passed, 0 failed, 24 total)` |
| 6 | `du-rework/orchestrator/services/orchestrator` | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** | no output (clean) |

## Literal outputs

### 1. admin-web typecheck — exit 0

```
cwd: D:\Git\dugate\du-rework\orchestrator\apps\admin-web
command: pnpm --filter @du/admin-web typecheck
exit: 0
--- output ---

> @du/admin-web@0.0.0 typecheck D:\Git\dugate\du-rework\orchestrator\apps\admin-web
> tsc --noEmit -p tsconfig.json
```

Note on the prior receipt: the earlier report of **exit 2 with 10 TS6133 errors in `overview-screen.tsx`** is **not reproducible on the current disk** — this run exits 0 and has zero `error TS` lines (raw kept at `raw/…/01-admin-web-typecheck.txt`).

### 2. portal-auto-refresh-offline.cjs — exit 0

```
  ok  usage-1: a failed first load shows Unavailable, never a zero age, and never polls
  ok  usage-2: a successful load shows an age derived from when it completed
  ok  usage-3: polling starts only after the operator opts in, on the declared cadence
  ok  usage-4: a failed refresh keeps the last good data and marks it stale
  ok  usage-5: turning the toggle off and unmounting both clear the interval
  ok  overview-1: a failed first load shows Unavailable and never polls
  ok  overview-2: a successful load is fresh; opt-in registers one interval that polls
  ok  overview-3: a failed refresh keeps the last good rollup and marks it stale
  ok  overview-4: unmount clears the interval (no leak)
PASS: OPU-G2 auto refresh + data age — 9 scenarios (opt-in only, age from last success, stale-on-failure retention, cleanup on toggle-off/unmount)
```

### 3. admin-toast-error-boundary-offline.cjs — exit 0

```
PASS admin toast/error boundary offline harness (14 assertions)
```

### 4. operations-download-live-offline.cjs — exit 0

```
ok   OPS-2: a 1s tick interval exists while a non-terminal op is shown
ok   OPS-2: unknown start renders Unknown, never a fabricated 0
ok   OPS-2: clock ticks without a manual refresh (the interval drives the elapsed text)
ok   OPS-1: artifact with downloadUrl renders a real download link
ok   OPS-1: artifact without downloadUrl renders unavailable text, never a broken anchor
ok   OPS-2: no interval starts when every op is terminal
PASS operations-download-live-offline.cjs - 6 assertions (OPU-OPS-1 x2, OPU-OPS-2 x4)
```

### 5. api-docs-build-label-offline.cjs — exit 0

```
PASS screen imports docs/21-openapi.json with ?raw
PASS build label marker data-api-docs-build-label
PASS label exposes data-spec-source
PASS label exposes data-spec-bytes
PASS label exposes data-spec-fingerprint
PASS label text mentions bytes
PASS label text mentions fingerprint
PASS build-state attribute rendered
PASS state 'ok' present
PASS state 'parse-error' present
PASS state 'missing-artifact' present
PASS empty import detected before parsing (trim length check)
PASS parse-error and missing-artifact render distinct cards
PASS empty-filter marker data-api-docs-empty-filter
PASS empty-filter message shows filtered vs total operations
PASS no fetch(
PASS no XMLHttpRequest
PASS no axios
PASS docs/21-openapi.json parses
PASS spec declares openapi 3.x
PASS spec declares a non-empty info.version
PASS spec carries at least one path
PASS fingerprint derived from specRaw
PASS fingerprint helper is deterministic (FNV loop present)
RESULT: PASS (24 passed, 0 failed, 24 total)
```

### 6. orchestrator tsc — exit 0

```
cwd: D:\Git\dugate\du-rework\orchestrator\services\orchestrator
command: node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
exit: 0
--- output ---
(no output)
```

## FAIL list

**None.** All six commands exited 0. No test was skipped, edited, or reported green while failing; no assertion was weakened; nothing was fixed to make anything green.

## Variable-usage check — `orchestrator/apps/admin-web/src/features/overview/overview-screen.tsx`

| Identifier | Declaration | Usage (file:line) | Status |
|---|---|---|---|
| `Button` | import `:4` | toggle JSX `:321-329` | used |
| `AUTO_REFRESH_MS` | const `:161` | `setInterval(…, AUTO_REFRESH_MS)` `:310` | used |
| `DataAgeLabel` | function `:177` | rendered `:330` | used |
| `autoRefresh` | state `:197` | effect guard `:307`, effect deps `:312`, toggle `:323,324,326,328` | used |
| `setAutoRefresh` | state setter `:197` | `onClick` `:326` | used |
| `stale` | state `:198` | label prop `:330`, label body `:182,187` (via prop) | used |
| `setStale` | state setter `:198` | `:291` (failure→stale), `:297` (success→fresh) | used |
| `lastSuccessAt` | state `:199` | label prop `:330`; label body `:177,182,184,186` | used |
| `setLastSuccessAt` | state setter `:199` | `:296` (stamp on success) | used |
| `lastSuccess` | stable box state `:203` | read `:211,291`; write `:295`; callback deps `:298` | used |

Conclusion: **no declared-but-unused variable among the requested list** (and no other unused declaration in the file — the admin-web typecheck exits 0, and the config demonstrably flags unused locals given the historical TS6133 class).

## Raw evidence

`du-rework/coordination/reports/raw/verify-a-portal-wave1-2026-10-08/`:
- `01-admin-web-typecheck.txt`
- `02-portal-auto-refresh.txt`
- `03-admin-toast-error-boundary.txt`
- `04-operations-download-live.txt`
- `05-api-docs-build-label.txt`
- `06-orchestrator-tsc.txt`

## Not covered (explicit)

- No live/browser verification, no BFF/HTTP round trip; the harnesses are offline element-tree/static checks.
- No PostgreSQL/Redis started; no DB window claimed.
- No mutation/negative probes beyond what the harnesses themselves run.
- No gate tick (`VERIFIED`/`ACCEPTED`) — coordinator/user decision. No commit, no push.
