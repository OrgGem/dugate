# VERIFY B — SPA offline `.cjs` harnesses (7) + service typecheck, independent — 2026-10-08

- **Verifier**: oc_3 (independent; disk state re-checked, inventory receipt not
  trusted).
- **Mode**: READ-ONLY — no source/test edits, no `.cjs` created/deleted, no
  commit/add/push, no gate ticks, no `docs/21-openapi.json` hand-edit,
  `.env.live` never read. **Offline only** — no PostgreSQL/Redis, no DB window.
  `du-rework` only.
- **Context claim under test** (`inventory-spa-cjs-harnesses-READONLY-2026-10-08.md`):
  exactly 7 `.cjs` files in `orchestrator/services/orchestrator/tests/`, all run
  with `node` exit 0, and zero automatic invocation (no script/config/package.json
  calls them).

## Command table (cwd = `orchestrator/services/orchestrator`) — literal + exit

| # | Command (`node tests/…`) | Exit | Literal result |
|---|---|---:|---|
| 1 | `admin-toast-error-boundary-offline.cjs` | **0** | `PASS admin toast/error boundary offline harness (14 assertions)` |
| 2 | `api-docs-build-label-offline.cjs` | **0** | `RESULT: PASS (24 passed, 0 failed, 24 total)` (24 individual `PASS` lines) |
| 3 | `f7-overview-usage-tile-offline.cjs` | **0** | `PASS: real OverviewScreen usage tile — 8 scenarios` (all 8 `ok`) |
| 4 | `operations-download-live-offline.cjs` | **0** | `PASS operations-download-live-offline.cjs - 6 assertions (OPU-OPS-1 x2, OPU-OPS-2 x4)` (all 6 `ok`) |
| 5 | `portal-auto-refresh-offline.cjs` | **0** | `PASS: OPU-G2 auto refresh + data age — 9 scenarios` (all 9 `ok`) |
| 6 | `tenant-select-offline.cjs` | **0** | `PASS: real TenantSelect element tree — 8 scenarios` (all 8 `ok`) |
| 7 | `usage-screen-offline.cjs` | **0** | `PASS: platform gating, TenantSelect selection, All tenants guard, forwarding, tenant session prefill and lock` |
| 8 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **0** | no output (0 bytes) |

All 7 harnesses were invoked **with `node` only** — never through jest (jest
`testMatch: ['**/*.test.ts']` excludes `.cjs`; the "No tests found, exit 1" jest
behaviour was deliberately not exercised).

## Re-listing of `.cjs` files (current disk)

`rg --files tests/ -g '*.cjs'` → **exactly 7**, matching the list 1:1, none
missing, none extra:

```
tests/admin-toast-error-boundary-offline.cjs
tests/api-docs-build-label-offline.cjs
tests/f7-overview-usage-tile-offline.cjs
tests/operations-download-live-offline.cjs
tests/portal-auto-refresh-offline.cjs
tests/tenant-select-offline.cjs
tests/usage-screen-offline.cjs
```

## Callsite / automatic-invocation grep

- **Filtered search** for all 7 basenames in `package.json`, `*.config.*`,
  `*.ps1`, `*.sh`, `*.yml`, `*.yaml` across `du-rework` (excluding
  `node_modules`/`.git`): **zero hits** (rg exit 1 = no matches).
- **Broad search** (all file types): the only non-report hits are
  **comments/convention notes**, never invocations —
  - `tests/f4-component-tenant-select.test.ts:6,17` — prose referencing
    `tests/tenant-select-offline.cjs` / `usage-screen-offline.cjs` as the repo
    convention (no `spawn`/`exec`/`require`);
  - the harness files themselves reference sibling harness names in comments
    (e.g. `f7-…:3-4`, `portal-auto-refresh-…:3`, `tenant-select-…:3,7`) plus
    their own `PASS …` message;
  - the remaining hits are coordination reports / raw evidence logs (records,
    not callers).
- **No `node … .cjs` spawn** from any non-`.cjs` test or config file (rg found
  none).
- `package.json` scripts under `du-rework` mentioning “offline” are unrelated
  (document-core integration naming, tests/login description) — none reference
  the 7 harnesses.

**Conclusion:** the inventory claim of **zero automatic invocation is
confirmed** — nothing in scripts/configs/CI/package manifests calls the 7
harnesses; they are manual `node`-run harnesses only.

## FAIL

**None.** All 8 commands exit 0; no harness assertion failed; nothing to report
verbatim.

## Verdict

**PASS — inventory receipt's three claims independently confirmed on the current
disk:** exactly 7 `.cjs` files (1:1 with the listed names), each runs with
`node` at exit 0 with explicit PASS output, and no automatic invocation exists
(no callsite in package.json / config / ps1 / sh / yml; only comment/evidence
references elsewhere). Service typecheck exits 0.

## Constraints confirmation

No source/test edits; no `.cjs` created or deleted; no commit, no `git add`, no
push; no gate ticks; no `docs/21-openapi.json` edits; `.env.live` never read or
printed; offline only. The only file this lane creates in the repo is this
receipt.
