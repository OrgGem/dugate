# W47-O Browser Harness

Playwright + @axe-core/playwright browser harness for the Admin shell.
Boots `createAdminShellServer` (from `services/orchestrator/src/app/admin`)
on an OS-assigned port, logs in with the harness admin token, and drives
seven sections × two viewports through a real Chromium plus four real
interactions.

## Run

```bash
cd du-rework/tests/browser
npm install
npx playwright install chromium            # ~170 MB; one-time per machine
npm run browser:smoke                      # full matrix
npm run browser:smoke -- --section=overview  # filter to one section
```

The script lives in this package — `pnpm --filter @du/browser-tests
browser:smoke` also works once the workspace is installed at the root.

## Output

```
artifacts/
  admin-root-desktop.png
  admin-root-mobile.png
  businesses-desktop.png
  ...
  api-keys-mobile.png
  artifacts-summary.json   ← single evidence file (counts + per-(section,viewport) records)
  playwright-report.json
```

`artifacts-summary.json` carries, per `(section, viewport)` pair:

- screenshot path + byte size
- axe violation list with `id`, `impact`, `nodes`
- cumulative counts (`critical`, `serious`, `moderate`, `minor`)

## Invariants

- NO DB, NO Redis, NO platform HTTP. The shell listens in-process on
  `127.0.0.1:0` and every section fetcher is stubbed by
  `src/stubs.ts`.
- axe runs the standard WCAG 2.1 AA rules. `color-contrast` is
  disabled because the synthetic DOM has no theme color — all other
  critical/serious findings fail the test.
- Headless chromium only; `--with-deps` is intentionally not used
  (the user approved engine + chromium download at 01:15).
- Two viewports: 1440×900 desktop + 390×844 mobile.

## Layout

| File | Purpose |
|---|---|
| `package.json` | pinned deps, `browser:smoke` script |
| `playwright.config.ts` | chromium-only, headless, two projects |
| `tsconfig.json` | strict TS, DOM lib, node types |
| `src/harness-server.ts` | boots `createAdminShellServer` with stubs |
| `src/stubs.ts` | six section fetchers, rich `ok` panes only |
| `tests/sections.spec.ts` | 7 sections × 2 viewports, screenshots + axe |
| `tests/interactions.spec.ts` | 4 real interactions |
| `tests/a11y-summary.ts` | in-memory aggregator + `artifacts-summary.json` writer |
| `.gitignore` | excludes `artifacts/`, `node_modules/`, reports |
