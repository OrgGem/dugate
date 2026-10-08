# F-7 browser spec regression — 2026-10-08

Scope: test-only lane. Edited `tests/browser/admin-web/overview.spec.ts` at the single authorized assertion; added this receipt. No product source, service source, OpenAPI, or legacy files edited. No commit or push. No VERIFIED/ACCEPTED status changed.

## Change and assertion decision

- Changed line 80 from `await expect(page.getByText('requires backend')).toHaveCount(2);` to `.toHaveCount(1);`.
- Did not add a real-usage assertion. The harness defaults Usage to `rows`, but its response is `{ tenantId, from, to, requests: 12, tokens: 3456 }`. F-7's `parseUsageRollup` requires `totals` and `rows`, so this fixture cannot verify a successful real rollup; adding a visible-count assertion would be ungrounded.
- The existing 320px document-width assertion was exercised against the rebuilt F-7 app. It passed before and after the spec edit; no horizontal overflow was observed at 320px.

## Commands and results

All Playwright commands below ran from `D:\Git\dugate\du-rework\tests\browser` using the `smoke` script from its `package.json`. Environment: harness at `http://127.0.0.1:64346`, stub at `http://127.0.0.1:64345`, operator/viewer sessions from `admin-web/harness.ts`.

Initial pre-edit command:

```powershell
pnpm run smoke -- admin-web/overview.spec.ts --config admin-web/playwright.config.ts --reporter=list
```

Exit 0, 7 passed. This was **pre-existing green against stale `apps/admin-web/dist`**; it did not exercise F-7's current source. Literal Playwright output:

```text
Running 7 tests using 1 worker
ok 1 admin-web\overview.spec.ts:62:7 › 0. unauth direct /admin/web/overview → login (mount gate)
ok 2 admin-web\overview.spec.ts:69:7 › 1. operator tenant → ready: tenant-fenced rows + honest tiles
ok 3 admin-web\overview.spec.ts:92:7 › 2. empty scope → EmptyState with refresh affordance
ok 4 admin-web\overview.spec.ts:101:7 › 3. upstream failure → 502 error, retry succeeds after recovery
ok 5 admin-web\overview.spec.ts:115:7 › 4. viewer session → denied, upstream untouched
ok 6 admin-web\overview.spec.ts:127:7 › 5. SPA-level 401 → sign-in link (session expired mid-flight)
ok 7 admin-web\overview.spec.ts:147:7 › 6. 320px viewport: no horizontal overflow on Overview
7 passed (6.4s)
PLAYWRIGHT_EXIT=0
```

To make the harness serve current F-7 source, ran from `D:\Git\dugate\du-rework`:

```powershell
pnpm --filter @du/admin-web build
```

Exit 0. `orchestrator/apps/admin-web/dist` is ignored by `orchestrator/apps/admin-web/.gitignore`; the build refreshed that generated test artifact only. The browser spec was still unmodified for the next run.

Pre-edit, rebuilt-app command (same literal command and cwd as above):

```powershell
pnpm run smoke -- admin-web/overview.spec.ts --config admin-web/playwright.config.ts --reporter=list
```

Exit 1, 3 failed / 4 passed. Literal failures:

```text
Running 7 tests using 1 worker
ok 1 ... 0. unauth direct /admin/web/overview → login (mount gate)
x  2 ... 1. operator tenant → ready: tenant-fenced rows + honest tiles
ok 3 ... 2. empty scope → EmptyState with refresh affordance
x  4 ... 3. upstream failure → 502 error, retry succeeds after recovery
ok 5 ... 4. viewer session → denied, upstream untouched
x  6 ... 5. SPA-level 401 → sign-in link (session expired mid-flight)
ok 7 ... 6. 320px viewport: no horizontal overflow on Overview

1) expect(locator).toHaveCount(expected) failed
   Locator:  getByText('requires backend')
   Expected: 2
   Received: 1
   at overview.spec.ts:80

2) expect(locator).toBeVisible() failed
   Locator: getByText('502')
   Error: strict mode violation: getByText('502') resolved to 2 elements
   at overview.spec.ts:106

3) expect(locator).toBeVisible() failed
   Locator: getByRole('link', { name: 'Sign in again' })
   Error: strict mode violation: locator resolved to 2 elements
   at overview.spec.ts:142

3 failed
4 passed (17.7s)
PLAYWRIGHT_EXIT=1
```

After the single assertion edit, ran the same command from the same cwd against the same rebuilt app:

```powershell
pnpm run smoke -- admin-web/overview.spec.ts --config admin-web/playwright.config.ts --reporter=list
```

Exit 1, 2 failed / 5 passed. The count regression is fixed. All remaining red is recorded here and remains unresolved under the one-assert lease:

```text
Running 7 tests using 1 worker
ok 1 ... 0. unauth direct /admin/web/overview → login (mount gate)
ok 2 ... 1. operator tenant → ready: tenant-fenced rows + honest tiles
ok 3 ... 2. empty scope → EmptyState with refresh affordance
x  4 ... 3. upstream failure → 502 error, retry succeeds after recovery
ok 5 ... 4. viewer session → denied, upstream untouched
x  6 ... 5. SPA-level 401 → sign-in link (session expired mid-flight)
ok 7 ... 6. 320px viewport: no horizontal overflow on Overview

1) Locator: getByText('502')
   Error: strict mode violation: locator resolved to 2 elements
   at overview.spec.ts:106

2) Locator: getByRole('link', { name: 'Sign in again' })
   Error: strict mode violation: locator resolved to 2 elements
   at overview.spec.ts:142

2 failed
5 passed (7.0s)
PLAYWRIGHT_EXIT=1
```

The two remaining failures occur because the F-7 Usage tile now renders its own failed pane when the shared harness switches all upstream reads to `error` or intercepts the session as 401. The pre-existing selectors expected exactly one matching 502 badge or sign-in link. They were not edited because the requested lease limits the spec change to the single `requires backend` assertion. The 320px test passed on both rebuilt-app runs.

Node was v22.16.0; packages declare Node >=24.21.0 <25, so pnpm emitted engine warnings. `git diff --check` was run on the spec and receipt.

## Literal failure output excerpts

The following are the Playwright reporter lines and assertion messages copied from the actual runs (pnpm's engine-warning preamble omitted).

Fresh-build pre-edit run:

```text
Running 7 tests using 1 worker
  ok 1 admin-web\overview.spec.ts:62:7 › AWEB-03b Overview browser evidence (harness seam) › 0. unauth direct /admin/web/overview → login (mount gate) (240ms)
  x  2 admin-web\overview.spec.ts:69:7 › AWEB-03b Overview browser evidence (harness seam) › 1. operator tenant → ready: tenant-fenced rows + honest tiles (10.9s)
  ok 3 admin-web\overview.spec.ts:92:7 › AWEB-03b Overview browser evidence (harness seam) › 2. empty scope → EmptyState with refresh affordance (921ms)
  x  4 admin-web\overview.spec.ts:101:7 › AWEB-03b Overview browser evidence (harness seam) › 3. upstream failure → 502 error, retry succeeds after recovery (835ms)
  ok 5 admin-web\overview.spec.ts:115:7 › AWEB-03b Overview browser evidence (harness seam) › 4. viewer session → denied, upstream untouched (854ms)
  x  6 admin-web\overview.spec.ts:127:7 › AWEB-03b Overview browser evidence (harness seam) › 5. SPA-level 401 → sign-in link (session expired mid-flight) (852ms)
  ok 7 admin-web\overview.spec.ts:147:7 › AWEB-03b Overview browser evidence (harness seam) › 6. 320px viewport: no horizontal overflow on Overview (829ms)

  1) admin-web\overview.spec.ts:69:7 › AWEB-03b Overview browser evidence (harness seam) › 1. operator tenant → ready: tenant-fenced rows + honest tiles

    Error: expect(locator).toHaveCount(expected) failed
    Locator:  getByText('requires backend')
    Expected: 2
    Received: 1
    Timeout:  10000ms
    Call log:
      - Expect "toHaveCount" getByText('requires backend') with timeout 10000ms
      - waiting for getByText('requires backend')
        23 × locator resolved to 1 element

      78 |     await expect(page.getByRole('cell', { name: 'admin.profile.publish', exact: true })).toBeVisible();
      79 |     await expect(page.getByRole('cell', { name: 'admin.connector.rotate_credential', exact: true })).toBeVisible();
    > 80 |     await expect(page.getByText('requires backend')).toHaveCount(2);
         |                                                      ^
      81 |     await expect(page.getByText('Usage rollup')).toBeVisible();

  2) admin-web\overview.spec.ts:101:7 › AWEB-03b Overview browser evidence (harness seam) › 3. upstream failure → 502 error, retry succeeds after recovery

    Error: expect(locator).toBeVisible() failed
    Locator: getByText('502')
    Expected: visible
    Error: strict mode violation: getByText('502') resolved to 2 elements:
        1) <span class="text-xs font-mono font-bold px-1.5 py-0.5 rounded-sm bg-[var(--badge-danger-border)] text-[var(--badge-danger-text)]">502</span> aka getByText('502').first()
        2) <span class="text-xs font-mono font-bold px-1.5 py-0.5 rounded-sm bg-[var(--badge-danger-border)] text-[var(--badge-danger-text)]">502</span> aka getByText('502').nth(1)

  3) admin-web\overview.spec.ts:127:7 › AWEB-03b Overview browser evidence (harness seam) › 5. SPA-level 401 → sign-in link (session expired mid-flight)

    Error: expect(locator).toBeVisible() failed
    Locator: getByRole('link', { name: 'Sign in again' })
    Expected: visible
    Error: strict mode violation: locator resolved to 2 elements:
        1) <a href="/admin/login" class="underline text-[var(--cf-blue)]">Sign in again</a> aka getByRole('link', { name: 'Sign in again' }).first()
        2) <a href="/admin/login" class="underline text-[var(--cf-blue)]">Sign in again</a> aka getByRole('link', { name: 'Sign in again' }).nth(1)

  3 failed
    admin-web\overview.spec.ts:69:7 › AWEB-03b Overview browser evidence (harness seam) › 1. operator tenant → ready: tenant-fenced rows + honest tiles
    admin-web\overview.spec.ts:101:7 › AWEB-03b Overview browser evidence (harness seam) › 3. upstream failure → 502 error, retry succeeds after recovery
    admin-web\overview.spec.ts:127:7 › AWEB-03b Overview browser evidence (harness seam) › 5. SPA-level 401 → sign-in link (session expired mid-flight)
  4 passed (17.7s)
PLAYWRIGHT_EXIT=1
```

After-edit run:

```text
Running 7 tests using 1 worker
  ok 1 admin-web\overview.spec.ts:62:7 › AWEB-03b Overview browser evidence (harness seam) › 0. unauth direct /admin/web/overview → login (mount gate) (189ms)
  ok 2 admin-web\overview.spec.ts:69:7 › AWEB-03b Overview browser evidence (harness seam) › 1. operator tenant → ready: tenant-fenced rows + honest tiles (874ms)
  ok 3 admin-web\overview.spec.ts:92:7 › AWEB-03b Overview browser evidence (harness seam) › 2. empty scope → EmptyState with refresh affordance (771ms)
  x  4 admin-web\overview.spec.ts:101:7 › AWEB-03b Overview browser evidence (harness seam) › 3. upstream failure → 502 error, retry succeeds after recovery (748ms)
  ok 5 admin-web\overview.spec.ts:115:7 › AWEB-03b Overview browser evidence (harness seam) › 4. viewer session → denied, upstream untouched (849ms)
  x  6 admin-web\overview.spec.ts:127:7 › AWEB-03b Overview browser evidence (harness seam) › 5. SPA-level 401 → sign-in link (session expired mid-flight) (830ms)
  ok 7 admin-web\overview.spec.ts:147:7 › AWEB-03b Overview browser evidence (harness seam) › 6. 320px viewport: no horizontal overflow on Overview (860ms)

  1) admin-web\overview.spec.ts:101:7 › AWEB-03b Overview browser evidence (harness seam) › 3. upstream failure → 502 error, retry succeeds after recovery
    Error: expect(locator).toBeVisible() failed
    Locator: getByText('502')
    Expected: visible
    Error: strict mode violation: getByText('502') resolved to 2 elements:
        1) <span class="text-xs font-mono font-bold px-1.5 py-0.5 rounded-sm bg-[var(--badge-danger-border)] text-[var(--badge-danger-text)]">502</span> aka getByText('502').first()
        2) <span class="text-xs font-mono font-bold px-1.5 py-0.5 rounded-sm bg-[var(--badge-danger-border)] text-[var(--badge-danger-text)]">502</span> aka getByText('502').nth(1)

  2) admin-web\overview.spec.ts:127:7 › AWEB-03b Overview browser evidence (harness seam) › 5. SPA-level 401 → sign-in link (session expired mid-flight)
    Error: expect(locator).toBeVisible() failed
    Locator: getByRole('link', { name: 'Sign in again' })
    Expected: visible
    Error: strict mode violation: locator resolved to 2 elements:
        1) <a href="/admin/login" class="underline text-[var(--cf-blue)]">Sign in again</a> aka getByRole('link', { name: 'Sign in again' }).first()
        2) <a href="/admin/login" class="underline text-[var(--cf-blue)]">Sign in again</a> aka getByRole('link', { name: 'Sign in again' }).nth(1)

  2 failed
    admin-web\overview.spec.ts:101:7 › AWEB-03b Overview browser evidence (harness seam) › 3. upstream failure → 502 error, retry succeeds after recovery
    admin-web\overview.spec.ts:127:7 › AWEB-03b Overview browser evidence (harness seam) › 5. SPA-level 401 → sign-in link (session expired mid-flight)
  5 passed (7.0s)
PLAYWRIGHT_EXIT=1
```
