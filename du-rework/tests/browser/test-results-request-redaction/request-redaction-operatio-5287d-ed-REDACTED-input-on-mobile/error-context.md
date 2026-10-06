# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: request-redaction.spec.ts >> operation displays only server-provided REDACTED input on mobile
- Location: admin-web\request-redaction.spec.ts:39:7

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: locator.click: Test timeout of 60000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: /privacy-/ })

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - link "Skip to content" [ref=e4] [cursor=pointer]:
    - /url: "#admin-content"
  - banner [ref=e5]:
    - generic [ref=e6]: DUGate
    - time [ref=e9]: 10/5/2026, 1:49:36 PM Asia/Bangkok
    - generic [ref=e10]:
      - button "Privacy Admin · Profile" [ref=e11]
      - button "Logout" [ref=e14]
  - generic [ref=e16]:
    - complementary [ref=e17]:
      - button "Open navigation" [ref=e19]
    - main [ref=e21]:
      - region [ref=e22]:
        - generic [ref=e23]:
          - heading "Operations" [level=1] [ref=e24]
          - generic [ref=e25]: read-only
        - generic [ref=e27]:
          - generic [ref=e28]:
            - heading "List" [level=3] [ref=e29]
            - paragraph [ref=e30]: GET /admin/api/operations — server-side filter/sort, tenant fenced by the session.
          - generic [ref=e31]:
            - generic [ref=e32]:
              - text: State
              - combobox "State" [ref=e33]:
                - option "ALL" [selected]
                - option "RUNNING"
                - option "COMPLETED"
                - option "FAILED"
                - option "CANCELLED"
            - button "Refresh" [ref=e34]
        - alert [ref=e36]:
          - generic [ref=e40]:
            - heading "Unreadable operations page." [level=4] [ref=e41]
            - generic [ref=e42]: "502"
          - paragraph [ref=e43]: UNREADABLE_RESPONSE
          - button "Try again" [ref=e44]
```

# Test source

```ts
  1  | import { expect, test } from '@playwright/test';
  2  | const BASE = process.env.ADMIN_UI_PREVIEW_URL ?? 'http://127.0.0.1:25173';
  3  | const policy = { enabled: true, parameters: {}, jobPriority: 'MEDIUM', allowedFileExtensions: '', fileUrlAuthConfigured: false, connectionsOverride: [], requestRedaction: [] };
  4  | const profile = { businessId: 'doc-core', businessVersion: 'v1', profileName: 'privacy', apiKeyId: '11111111-1111-4111-8111-111111111111', revision: 1, currentValues: {}, policy, manifest: { actions: [{ name: 'extract' }] }, capabilities: [{ connectorId: 'local', capability: 'upsert' }] };
  5  | 
  6  | test.beforeEach(async ({ page }) => {
  7  |   await page.route('**/admin/api/**', async route => {
  8  |     const path = new URL(route.request().url()).pathname;
  9  |     const data = path.endsWith('/session') ? { schemaVersion: '1', plane: 'legacy', role: 'admin', principal: { kind: 'platform', tenantId: null }, scope: { kind: 'platform' }, displayName: 'Privacy Admin', csrfToken: 'fixture' }
  10 |       : path.endsWith('/businesses') ? { items: [{ businessId: 'doc-core', activeVersion: 'v1', status: 'ACTIVE' }] }
  11 |       : path.endsWith('/versions') ? { rows: [{ version: 'v1', status: 'ACTIVE', isActive: true }] }
  12 |       : path.includes('/profiles/') ? profile : {};
  13 |     await route.fulfill({ json: data });
  14 |   });
  15 | });
  16 | 
  17 | test('profile editor saves regex, replacement and selected flags', async ({ page }) => {
  18 |   let saved: Record<string, unknown> | undefined;
  19 |   await page.route('**/admin/api/profiles/**/upsert', async route => {
  20 |     saved = route.request().postDataJSON() as Record<string, unknown>;
  21 |     await route.fulfill({ json: { revision: 2 } });
  22 |   });
  23 |   await page.goto(`${BASE}/admin/web/profiles`);
  24 |   await page.locator('#profile-business').fill('doc-core');
  25 |   await page.locator('#profile-version').fill('v1');
  26 |   await page.locator('#profile-name').fill('privacy');
  27 |   await page.getByRole('button', { name: 'Load profile', exact: true }).click();
  28 |   await page.getByRole('textbox', { name: 'row profile name', exact: true }).fill('privacy');
  29 |   await page.getByRole('button', { name: 'Add redaction rule', exact: true }).click();
  30 |   await page.getByLabel('Redaction pattern 1', { exact: true }).fill('(090)1234567');
  31 |   await page.getByLabel('Redaction replacement 1', { exact: true }).fill('$1*******');
  32 |   await page.getByLabel('Ignore case', { exact: true }).check();
  33 |   await page.getByRole('button', { name: 'Save privacy', exact: true }).click();
  34 |   await expect.poll(() => saved).toBeTruthy();
  35 |   expect(saved?.policy).toMatchObject({ requestRedaction: [{ pattern: '(090)1234567', replacement: '$1*******', flags: 'i' }] });
  36 |   await page.screenshot({ path: 'artifacts/request-redaction-profile.png', fullPage: true });
  37 | });
  38 | 
  39 | for (const status of ['REDACTED', 'HIDDEN'] as const) {
  40 |   test(`operation displays only server-provided ${status} input on mobile`, async ({ page }) => {
  41 |     await page.setViewportSize({ width: 320, height: 800 });
  42 |     const operation = { id: 'privacy-op', state: 'RUNNING', businessId: 'doc-core', action: 'extract' };
  43 |     await page.route(/\/admin\/api\/operations(?:\?.*)?$/,  route => route.fulfill({ json: { items: [operation] } }));
  44 |     await page.route('**/admin/api/operations/privacy-op', route => route.fulfill({ json: { operation, requestInput: { status, ruleCount: 1, data: status === 'HIDDEN' ? '[REDACTED]' : { phone: '090*******' } } } }));
> 45 |     await page.goto(`${BASE}/admin/web/operations`);
     |                                                          ^ Error: locator.click: Test timeout of 60000ms exceeded.
  46 |     await page.getByRole('button', { name: /privacy-/ }).click();
  47 |     await expect(page.getByLabel('Request input', { exact: true })).toContainText(status === 'HIDDEN' ? '[REDACTED]' : '090*******');
  48 |     await expect(page.locator('body')).not.toContainText('0901234567');
  49 |     expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  50 |     await page.screenshot({ path: `artifacts/request-redaction-${status.toLowerCase()}-mobile.png`, fullPage: true });
  51 |   });
  52 | }
  53 | 
```