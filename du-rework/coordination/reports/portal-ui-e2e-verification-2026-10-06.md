# Portal UI E2E verification — receipt

Date: 2026-10-06. Owner: OpenCode (`oc_1`), write lease `tests/browser/**` + `apps/admin-web/**`.
Scope: comprehensive Playwright UI E2E suite over the Orchestrator Portal, per `docs/portal-ui-e2e-test-plan.md`.
No commit, no tick, no push.

## 1. Result

| Metric | Result |
|---|---|
| Suite command | `node tests/browser/scripts/run-portal-all-features.cjs` (cwd `du-rework`) |
| Final run | **31 passed, 1 skipped (intentional), 0 failed — exit 0** in 43.1s |
| Recorded route checks | **30/30 ok** (14 routes + shell) × (desktop 1440×900 + mobile 390×844) |
| Console errors | **0** across all 30 records |
| Horizontal overflow | **0 px** max across all 30 records (plus 768 px sweep) |
| Accessibility (axe-core, critical/serious) | **0 / 0** across all 30 records (desktop scans; `color-contrast` disabled per existing harness convention) |
| Screenshots | 31 full-page PNGs (30 + responsive-768) |

The single skipped item is the intentional duplicate: the `responsive 768px` sweep is declared to run only in the
desktop project (`test.skip` on mobile).

Routes covered (each asserted for main components, console=0, overflow=0, screenshot, axe on desktop):
`/overview`, `/api-keys`, `/connectors`, `/profiles`, `/operations`, `/businesses`, `/usage`, `/security`,
`/identity`, `/settings`, `/workflows`, `/docs`, `/api-docs`, unknown-path (404) — plus the app shell
(branding "Orchestrator Portal", full navigation, session header, mobile nav toggle).

Key interactions exercised beyond render: API-key revoke confirm dialog open/cancel; connector revision Load
(platform ledger + revision badge); profile Load with fixture (revision 7); operation detail + artifacts table;
business versions table; crypto-config load; API Reference family filter (Public 12), search (`claim` → 1),
operation detail origin 3002, 14 schemas; mobile navigation toggle.

## 2. Environment and how the suite runs

- Real Orchestrator admin shell (`createAdminShellServer`) + real `apps/admin-web/dist` Vite build mounted at
  `/admin/web`, with the scripted upstream stub from `tests/browser/admin-web/harness.ts`.
  No DB, no Redis, no live platform HTTP.
- Session: platform-admin session cookie (`du_session`) added by the suite; upstream fixtures reset per test
  (`/__stub/mode?reset=1` + `profile=fixture&connectorMgmt=composed&connector=ok&connectorWrite=ok&testEndpoint=ok&crypto=ok`).
  Only `/admin/api/identity` has no upstream fixture and is served by a deterministic in-spec response.
- Windows, Node v22.16.0, pnpm 10.18.3, Playwright 1.63.0 (Chromium), desktop + Pixel-7-class mobile projects.
- Run log: `coordination/reports/raw/mig08b-portal-swagger/portal-e2e-final.log` (green) with failure history in
  `portal-e2e-run*.log`.

## 3. Files added/changed by this packet

| File | Change |
|---|---|
| `tests/browser/tests/orchestrator-portal-all-features.spec.ts` | **New** comprehensive suite (14 routes + shell + 768 px sweep; console/overflow/axe/screenshot per record; merged JSON summary) |
| `tests/browser/scripts/run-portal-all-features.cjs` | **New** one-command runner: boots harness (`pnpm dlx tsx`), runs both Playwright projects with `PORTAL_E2E_*`, stops harness |
| `tests/browser/admin-web/harness.ts` | Additive: platform-admin session (`sessions.admin`) beside operator/viewer; existing sessions untouched |
| `apps/admin-web/src/features/api-docs/api-docs-screen.tsx` | a11y fix: `tabIndex={0}` on the scrollable operations list and JSON `<pre>` blocks (`scrollable-region-focusable`), then dist rebuilt |
| `tests/browser/artifacts/portal-all-features-summary.json` | Machine-readable result: 30 records, 0 failed, 0 console errors, 0 overflow, 0 axe critical/serious |
| `tests/browser/artifacts/playwright-report.json` | Playwright JSON reporter (31 passed / 1 skipped) |

Fixes discovered while running the suite:

1. Operator (tenant) sessions are **403 by design** on `/admin/api/businesses` (platform-admin BFF routes), so the
   traversal uses the new admin session; no product bug.
2. Connector revision read returned the stub's `connector=missing` 404 until the fixture mode `connector=ok` was
   set; the harness itself is unchanged in behaviour for other specs.
3. axe-core flagged one **serious** `scrollable-region-focusable` violation on `/api-docs`; fixed in the UI source
   (keyboard-focusable scroll regions), dist rebuilt, re-run green.

## 4. Artifacts and screenshots

Screenshots (full page) live in `tests/browser/artifacts/` and are mirrored under
`coordination/reports/raw/mig08b-portal-swagger/portal-e2e-screenshots/`:

| Group | Files |
|---|---|
| Desktop (15) | `portal-{overview,api-keys,connectors,profiles,operations,businesses,usage,security,identity,settings,workflows,docs,api-docs,not-found,shell}-desktop.png` |
| Mobile (15) | same names with `-mobile.png` |
| Responsive sweep | `portal-responsive-768.png` |

JSON / logs:

| Artifact | Path | SHA-256 |
|---|---|---|
| Result summary | `tests/browser/artifacts/portal-all-features-summary.json` | `136CE77602BB37DE71807CE5465A56C04C77C197801EA3452C574DCB2CE69778` |
| Playwright JSON report | `tests/browser/artifacts/playwright-report.json` | `C1267B2F9AD021B92E7BC7469FD1D2C49D6231F1083A45E5CD4B99681FCD02E2` |
| Final run log (green) | `coordination/reports/raw/mig08b-portal-swagger/portal-e2e-final.log` | `D5C0CDB40663010A257A65F13527C52D82C91D8888C784960CDBA77E69F0CFE2` |
| Harness descriptor | `coordination/reports/raw/mig08b-portal-swagger/portal-harness.json` | `386BFD53D65AD890762FDA970A433D55FB4B6892F079C653EF0A5E757AE92E98` |
| Suite spec | `tests/browser/tests/orchestrator-portal-all-features.spec.ts` | `8C79BE9B7C025DCA48A5DD972A550E4AF492FF1134F6AB1FD5F48784E91B49C6` |
| Runner | `tests/browser/scripts/run-portal-all-features.cjs` | `87FD803EFE3EFB0E95226D4F448254C292EFCE0570E9005492CEFB61682F8C25` |
| Harness | `tests/browser/admin-web/harness.ts` | `20625DF8C2C553124F86AE48C0BD09654B79701BC85BFAC615E0EE777BC63FAA` |
| API docs screen (a11y fix) | `apps/admin-web/src/features/api-docs/api-docs-screen.tsx` | `5CD84AFE19F86CE89BE8586FAAF3343AD8DD6BFF9B437556CEA1196C916DE8AB` |

## 5. Limitations (honest scope)

- Upstream BFF reads are stubbed fixtures (`tests/browser/admin-web/harness.ts`); this suite verifies UI rendering,
  interactions, error-free console and layout, **not** live DB/Redis/provider behaviour.
- Session/CSRF enforcement is server-side (shell/BFF) and is covered by the existing shell/BFF test suites; this
  suite uses an authenticated session and does not re-test the login flow.
- axe runs on the desktop project only and with `color-contrast` disabled, matching the existing W47-O harness
  convention; it is not a full WCAG certification.
- `tests/browser/**` and `apps/admin-web/**` are untracked in the current working tree, so these files have no git
  baseline in this repository state; nothing was committed.
