# F-7 browser strict-mode collateral — 2026-10-08

Lease: only `tests/browser/admin-web/overview.spec.ts` selectors at lines 106 and 142; plus this requested receipt. No product source edited. No commit/push and no VERIFIED/ACCEPTED status change.

## Fail-first evidence before selector edits

`orchestrator/apps/admin-web/dist` was rebuilt first because the browser harness serves that directory and a stale bundle gave a pre-existing green. Command from `D:\Git\dugate\du-rework`:

```powershell
pnpm --filter @du/admin-web build
```

Exit code: `0`.

The correct pre-edit overview run used a temporary runner at `%TEMP%\f7-browser-strict-mode-runner.cjs`. The runner followed `tests/browser/scripts/run-portal-all-features.cjs`: it booted `admin-web/harness.ts`, read harness JSON, set `AWEB01B_URL`, `AWEB01B_EVIDENCE`, `AWEB01B_TOKEN`, `AWEB03B_STUB`, `AWEB03B_OPERATOR`, `AWEB03B_VIEWER`, and `AWEB03B_TENANT`, then invoked only the overview spec.

From `D:\Git\dugate\du-rework\tests\browser`, exact Playwright command:

```powershell
pnpm exec playwright test admin-web/overview.spec.ts --config admin-web/playwright.config.ts --reporter=list
```

Pre-edit exit code: `1`; 2 failed / 5 passed. The two reds matched the coordinator's independent reproduction:

```text
Running 7 tests using 1 worker
  x  4 admin-web\overview.spec.ts:101:7 › AWEB-03b Overview browser evidence (harness seam) › 3. upstream failure → 502 error, retry succeeds after recovery (794ms)
  x  6 admin-web\overview.spec.ts:127:7 › AWEB-03b Overview browser evidence (harness seam) › 5. SPA-level 401 → sign-in link (session expired mid-flight) (808ms)

1) Locator: getByText('502')
   Expected: visible
   Error: strict mode violation: getByText('502') resolved to 2 elements
   at overview.spec.ts:106

2) Locator: getByRole('link', { name: 'Sign in again' })
   Expected: visible
   Error: strict mode violation: locator resolved to 2 elements
   at overview.spec.ts:142

  2 failed
  5 passed (6.9s)
PLAYWRIGHT_EXIT=1
```

The captured full runner output is retained at `%TEMP%\f7-browser-strict-before-targeted.log`.

Runner invocation correction: my first temporary-runner attempt forwarded a literal `--` through `pnpm run smoke` on Windows. Playwright consequently ran 120 tests rather than the target spec. That invalid invocation exited `1` (26 failed, 30 did not run, 64 passed); its full output is retained at `%TEMP%\f7-browser-strict-before.log`. This was a runner argument error, not the requested overview run. The 26 unrelated failures were:

- `interactions.spec.ts`: interaction-1, interaction-2, interaction-4 on desktop and mobile (6).
- `journeys.spec.ts`: J3 and J4 across desktop-1440x900, mobile-390x844, and reflow-320css on desktop and mobile projects (12).
- `live-admin-e2e.spec.ts`: LIV-08, LIV-09, LIV-10 on desktop and mobile (6; live URL `127.0.0.1:3001` refused connections).
- `orchestrator-portal-all-features.spec.ts`: overview test on desktop and mobile (2; PORTAL_E2E variables absent).

No files from those suites were edited. The corrected runner calls `pnpm exec playwright test` directly.

## Two selector edits and post-edit run

Only the two leased lines changed:

- Line 106 now scopes `502` to the Audit ledger card: `page.getByRole('heading', { name: 'Audit ledger', exact: true }).locator('xpath=../..').getByText('502')`. The heading is inside `CardHeader`; its second ancestor is the Audit card containing the audit `ProblemPane`. This excludes UsageRollupTile's separate error card. In the post-edit run this assertion passed and execution reached the retry assertion at line 110.
- Line 142 now scopes the sign-in link to the Session card: `page.getByRole('heading', { name: 'Session', exact: true }).locator('xpath=../..').getByRole('link', { name: 'Sign in again' })`. It checks the session pane's sign-in affordance and excludes the Usage tile's duplicate. In the post-edit run this assertion passed and execution reached the next assertion at line 143.
- No `.first()`, timeout increase, or assertion removal was used.

Post-edit runner invocation from `D:\Git\dugate\du-rework\tests\browser`:

```powershell
node %TEMP%\f7-browser-strict-mode-runner.cjs after
```

The runner's literal Playwright command was `pnpm exec playwright test admin-web/overview.spec.ts --config admin-web/playwright.config.ts --reporter=list`. Exit code: `1`, 2 failed / 5 passed. The changed selectors pass; the full spec is still red at later assertions that are outside this lease. Literal output:

```text
Running 7 tests using 1 worker
  ok 1 admin-web\overview.spec.ts:62:7 › AWEB-03b Overview browser evidence (harness seam) › 0. unauth direct /admin/web/overview → login (mount gate) (200ms)
  ok 2 admin-web\overview.spec.ts:69:7 › AWEB-03b Overview browser evidence (harness seam) › 1. operator tenant → ready: tenant-fenced rows + honest tiles (857ms)
  ok 3 admin-web\overview.spec.ts:92:7 › AWEB-03b Overview browser evidence (harness seam) › 2. empty scope → EmptyState with refresh affordance (802ms)
  x  4 admin-web\overview.spec.ts:101:7 › AWEB-03b Overview browser evidence (harness seam) › 3. upstream failure → 502 error, retry succeeds after recovery (858ms)
  ok 5 admin-web\overview.spec.ts:115:7 › AWEB-03b Overview browser evidence (harness seam) › 4. viewer session → denied, upstream untouched (844ms)
  x  6 admin-web\overview.spec.ts:127:7 › AWEB-03b Overview browser evidence (harness seam) › 5. SPA-level 401 → sign-in link (session expired mid-flight) (811ms)
  ok 7 admin-web\overview.spec.ts:147:7 › AWEB-03b Overview browser evidence (harness seam) › 6. 320px viewport: no horizontal overflow on Overview (863ms)

1) Error: locator.click: Error: strict mode violation: getByRole('button', { name: 'Try again' }) resolved to 2 elements:
   1) ... aka getByRole('alert').filter({ hasText: 'The admin API failed to' }).getByRole('button')
   2) ... aka getByRole('alert').filter({ hasText: 'The admin API returned an' }).getByRole('button')
   at overview.spec.ts:110

2) Error: expect(locator).toBeVisible() failed
   Locator: getByText('UNAUTHENTICATED')
   Error: strict mode violation: getByText('UNAUTHENTICATED') resolved to 2 elements
   at overview.spec.ts:143

  2 failed
  5 passed (6.9s)
[f7-browser-strict] playwright exit 1
RUNNER_EXIT=1
```

The width check at `overview.spec.ts:147-158` passed on the rebuilt app. The unresolved line-110 duplicate retry buttons and line-143 duplicate `UNAUTHENTICATED` text are reported without edits, as required by the two-selector lease. No fully green post-edit spec result is claimed.

## Retry and session error selector follow-up

This is the continuation of the prior strict-mode fix. Immediately before these two edits, the targeted spec was still red (the two remaining strict-mode failures previously reported by the coordinator): 2 failed / 5 passed, Playwright exit code `1`.

From `D:\Git\dugate\du-rework\tests\browser`, I invoked the temporary runner `node %TEMP%\f7-browser-strict-mode-runner.cjs continuation-before`. It booted `admin-web/harness.ts` through `pnpm dlx tsx`, read its JSON output, set `AWEB01B_URL`, `AWEB01B_EVIDENCE`, `AWEB01B_TOKEN`, `AWEB03B_STUB`, `AWEB03B_OPERATOR`, `AWEB03B_VIEWER`, and `AWEB03B_TENANT`, then ran this literal Playwright command:

```powershell
pnpm exec playwright test admin-web/overview.spec.ts --config admin-web/playwright.config.ts --reporter=list
```

Fail-first output (full captured output retained at `%TEMP%\f7-browser-strict-continuation-before.log`):

```text
Running 7 tests using 1 worker
  x  4 admin-web\overview.spec.ts:101:7 › 3. upstream failure → 502 error, retry succeeds after recovery
  x  6 admin-web\overview.spec.ts:127:7 › 5. SPA-level 401 → sign-in link (session expired mid-flight)
  2 failed
  5 passed (6.5s)
[f7-browser-strict] playwright exit 1
RUNNER_EXIT=1
```

I changed exactly the two leased selectors. The retry button now starts from the exact `Audit ledger` heading and scopes through `xpath=../..` to its card. The `UNAUTHENTICATED` assertion similarly starts from the exact `Session` heading and scopes to its card. These containers identify the intended error panes, excluding the duplicate Usage tile content. No `.first()` was used.

After-edit invocation: `node %TEMP%\f7-browser-strict-mode-runner.cjs continuation-after`; same harness boot, environment variables, cwd, and literal Playwright command as above. Full captured output is retained at `%TEMP%\f7-browser-strict-continuation-after.log`.

Post-edit output:

```text
Running 7 tests using 1 worker
  ok 1 admin-web\overview.spec.ts:62:7 › 0. unauth direct /admin/web/overview → login (mount gate)
  ok 2 admin-web\overview.spec.ts:69:7 › 1. operator tenant → ready: tenant-fenced rows + honest tiles
  ok 3 admin-web\overview.spec.ts:92:7 › 2. empty scope → EmptyState with refresh affordance
  ok 4 admin-web\overview.spec.ts:101:7 › 3. upstream failure → 502 error, retry succeeds after recovery
  ok 5 admin-web\overview.spec.ts:115:7 › 4. viewer session → denied, upstream untouched
  ok 6 admin-web\overview.spec.ts:127:7 › 5. SPA-level 401 → sign-in link (session expired mid-flight)
  ok 7 admin-web\overview.spec.ts:147:7 › 6. 320px viewport: no horizontal overflow on Overview
  7 passed (5.8s)
[f7-browser-strict] playwright exit 0
RUNNER_EXIT=0
```

The Playwright command exited `1` before the edits and `0` after. The 320px overflow test passed. This follow-up resolves the two remaining strict-mode failures described above; no other spec or product source was changed.
