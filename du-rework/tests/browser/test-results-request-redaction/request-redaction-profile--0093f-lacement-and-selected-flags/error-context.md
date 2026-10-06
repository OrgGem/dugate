# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: request-redaction.spec.ts >> profile editor saves regex, replacement and selected flags
- Location: admin-web\request-redaction.spec.ts:17:5

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: locator.click: Test timeout of 60000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'Save privacy', exact: true })

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - link "Skip to content" [ref=e4] [cursor=pointer]:
    - /url: "#admin-content"
  - banner [ref=e5]:
    - generic [ref=e6]: DUGate
    - time [ref=e9]: 10/5/2026, 1:48:36 PM Asia/Bangkok
    - generic [ref=e10]:
      - button "Privacy Admin · Profile" [ref=e11]
      - button "Logout" [ref=e14]
  - generic [ref=e16]:
    - complementary [ref=e17]:
      - navigation "Admin Web Navigation" [ref=e18]:
        - generic [ref=e19]:
          - paragraph [ref=e20]: Workspace
          - link "Overview" [ref=e21] [cursor=pointer]:
            - /url: /admin/web/overview
          - link "Operations" [ref=e22] [cursor=pointer]:
            - /url: /admin/web/operations
          - link "Usage" [ref=e23] [cursor=pointer]:
            - /url: /admin/web/usage
        - generic [ref=e24]:
          - paragraph [ref=e25]: Configuration
          - link "Businesses" [ref=e26] [cursor=pointer]:
            - /url: /admin/web/businesses
          - link "Profiles" [ref=e27] [cursor=pointer]:
            - /url: /admin/web/profiles
          - link "Connectors" [ref=e28] [cursor=pointer]:
            - /url: /admin/web/connectors
          - link "Workflows" [ref=e29] [cursor=pointer]:
            - /url: /admin/web/workflows
        - generic [ref=e30]:
          - paragraph [ref=e31]: Administration
          - link "API keys" [ref=e32] [cursor=pointer]:
            - /url: /admin/web/api-keys
          - link "Security" [ref=e33] [cursor=pointer]:
            - /url: /admin/web/security
          - link "Identity" [ref=e34] [cursor=pointer]:
            - /url: /admin/web/identity
          - link "Settings" [ref=e35] [cursor=pointer]:
            - /url: /admin/web/settings
        - generic [ref=e36]:
          - paragraph [ref=e37]: Resources
          - link "Documentation" [ref=e38] [cursor=pointer]:
            - /url: /admin/web/docs
          - link "Bootstrap" [ref=e39] [cursor=pointer]:
            - /url: /admin/web
        - link "Legacy shell" [ref=e40] [cursor=pointer]:
          - /url: /admin
    - main [ref=e41]:
      - region [ref=e42]:
        - generic [ref=e43]:
          - heading "Profiles" [level=1] [ref=e44]
          - generic [ref=e45]: PAR-12 + PAR-13 slice
        - alert [ref=e47]:
          - generic [ref=e50]:
            - strong [ref=e51]: Wire frozen (Phase-1 contract)
            - generic [ref=e52]:
              - text: Reads use the frozen shape
              - code [ref=e53]: "{revision, currentValues, policy, manifest, capabilities:[{connectorId, capability}]}"
              - text: ; writes ride
              - code [ref=e54]: /admin/api/profiles/…
              - text: → dispatcher (
              - code [ref=e55]: profile.upsert
              - text: /
              - code [ref=e56]: publish
              - text: /
              - code [ref=e57]: rollback
              - text: ). Until T-API-02 lands the dispatcher answers
              - code [ref=e58]: 404 ACTION_NOT_FOUND
              - text: and actions stay disabled — nothing is faked here.
        - generic [ref=e59]:
          - generic [ref=e60]:
            - heading "Profile selector" [level=3] [ref=e61]
            - paragraph [ref=e62]: GET /admin/api/profiles/:businessId/:version/:profile (T-UI-05 fence).
          - generic [ref=e63]:
            - generic [ref=e64]:
              - generic [ref=e65]: Business ID
              - combobox "businessId" [ref=e66]: doc-core
              - paragraph [ref=e67]: Choose a registered business or enter its ID.
            - generic [ref=e68]:
              - generic [ref=e69]: Business version
              - combobox "businessVersion" [ref=e70]: v1
              - paragraph [ref=e71]: Version suggestions unavailable; enter a version or use latest.
            - generic [ref=e73]:
              - generic [ref=e74]: Profile
              - textbox "Profile" [ref=e76]:
                - /placeholder: new
                - text: privacy
            - button "Load profile" [ref=e77]
        - generic [ref=e79]:
          - generic [ref=e81]:
            - heading "doc-core@v1 · privacy" [level=3] [ref=e82]
            - generic [ref=e83]: revision 1
            - generic [ref=e85]: local:upsert
          - generic [ref=e88]:
            - button "Save all endpoints" [ref=e89]
            - button "Publish" [disabled]
            - button "Rollback to v1" [disabled]
            - button "Test Endpoint" [disabled]
            - button "Add endpoint row" [ref=e91]
        - generic [ref=e93]:
          - generic [ref=e94]:
            - generic [ref=e95]:
              - textbox "row profile name" [ref=e96]:
                - /placeholder: profile / endpoint
                - text: extract
              - generic [ref=e97]:
                - checkbox "enabled" [checked] [ref=e98]
                - text: enabled
            - paragraph [ref=e99]: Locked slots are display-only; the server rejects a locked field even when unchanged.
          - generic [ref=e100]:
            - generic [ref=e101]:
              - generic [ref=e103]:
                - generic [ref=e104]: Job priority
                - combobox "Job priority" [ref=e106]:
                  - option "LOW (queue 20)"
                  - option "MEDIUM (queue 10)" [selected]
                  - option "HIGH (queue 1)"
              - generic [ref=e108]:
                - generic [ref=e109]: Allowed file extensions (CSV)
                - textbox "Allowed file extensions (CSV)" [ref=e111]:
                  - /placeholder: .pdf,.docx
            - generic [ref=e112]:
              - strong [ref=e113]: Parameters
              - paragraph [ref=e114]: No parameters in this policy.
            - generic [ref=e115]:
              - strong [ref=e116]: Connections override (ConnectionStep[])
              - generic [ref=e117]:
                - textbox "connection slug" [ref=e118]
                - textbox "step id" [ref=e119]:
                  - /placeholder: stepId (optional)
                - button "Add step" [ref=e120]
            - group "Request input redaction" [ref=e122]:
              - paragraph [ref=e124]: Matches are masked before admins and operators receive request input. Processing uses the original input. No rules means input is visible. Logs always contain metadata only.
              - generic [ref=e125]:
                - generic [ref=e126]:
                  - textbox "Redaction pattern 1" [ref=e127]:
                    - /placeholder: Regex pattern, without / delimiters
                    - text: (090)1234567
                  - textbox "Redaction replacement 1" [ref=e128]:
                    - /placeholder: "[REDACTED]"
                    - text: $1*******
                  - button "Remove rule 1" [ref=e129]
                - generic [ref=e131]:
                  - generic [ref=e132]:
                    - checkbox "Ignore case" [checked] [active] [ref=e133]
                    - text: Ignore case
                  - generic [ref=e134]:
                    - checkbox "Multiline anchors" [ref=e135]
                    - text: Multiline anchors
                  - generic [ref=e136]:
                    - checkbox "Match newlines" [ref=e137]
                    - text: Match newlines
                  - generic [ref=e138]:
                    - checkbox "Unicode" [ref=e139]
                    - text: Unicode
              - button "Add redaction rule" [ref=e140]
              - paragraph [ref=e142]: All matches are replaced. Use $1, $2 in the replacement to keep selected capture groups.
            - generic [ref=e143]:
              - button "Remove row" [disabled]
              - button "Save extract" [ref=e144]
        - generic [ref=e146]:
          - generic [ref=e147]:
            - generic [ref=e148]:
              - heading "fileUrlAuthConfig (write-only)" [level=3] [ref=e149]
              - generic [ref=e150]: write-only · snake_case
            - paragraph [ref=e153]: Encrypted server-side (AES-256-GCM, T-PROF-04); the read wire never returns it. Fields below follow the frozen legacy shape and are sent only when touched — nothing is stored in the browser.
          - generic [ref=e156]:
            - generic [ref=e157]: type
            - combobox "type" [ref=e159]:
              - option "none" [selected]
              - option "bearer"
              - option "header"
              - option "query"
        - generic [ref=e160]:
          - generic [ref=e161]:
            - heading "Prompt override (PAR-13, key-4)" [level=3] [ref=e162]
            - paragraph [ref=e163]:
              - text: Upsert via
              - code [ref=e164]: prompt-override.upsert
              - text: (dispatcher). Errors are shown honestly until the dispatcher case lands.
          - generic [ref=e165]:
            - generic [ref=e166]:
              - textbox "connection id" [ref=e167]:
                - /placeholder: connectionId (uuid)
              - textbox "api key id" [ref=e168]:
                - /placeholder: apiKeyId
              - textbox "endpoint slug" [ref=e169]:
                - /placeholder: endpointSlug
                - text: extract
              - textbox "step id" [ref=e170]:
                - /placeholder: stepId (_default)
                - text: _default
              - generic [ref=e171]:
                - checkbox "active (off = delete)" [checked] [ref=e172]
                - text: active (off = delete)
            - textbox "prompt override" [ref=e173]:
              - /placeholder: Prompt override for this (connection, key, endpoint, step)
            - button "Apply prompt override" [ref=e175]
        - generic [ref=e178]:
          - generic [ref=e179]:
            - heading "Effective config preview" [level=3] [ref=e180]
            - generic [ref=e181]: requires backend
          - paragraph [ref=e184]:
            - text: "Preview requires backend: the frozen read wire carries no"
            - code [ref=e185]: effective
            - text: "field (coordinator decision #2), so the merged preview waits for a dedicated capability — no sample is synthesised."
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
  28 |   await page.getByRole('button', { name: 'Add redaction rule', exact: true }).click();
  29 |   await page.getByLabel('Redaction pattern 1', { exact: true }).fill('(090)1234567');
  30 |   await page.getByLabel('Redaction replacement 1', { exact: true }).fill('$1*******');
  31 |   await page.getByLabel('Ignore case', { exact: true }).check();
> 32 |   await page.getByRole('button', { name: 'Save privacy', exact: true }).click();
     |                                                                         ^ Error: locator.click: Test timeout of 60000ms exceeded.
  33 |   await expect.poll(() => saved).toBeTruthy();
  34 |   expect(saved?.policy).toMatchObject({ requestRedaction: [{ pattern: '(090)1234567', replacement: '$1*******', flags: 'i' }] });
  35 |   await page.screenshot({ path: 'artifacts/request-redaction-profile.png', fullPage: true });
  36 | });
  37 | 
  38 | for (const status of ['REDACTED', 'HIDDEN'] as const) {
  39 |   test(`operation displays only server-provided ${status} input on mobile`, async ({ page }) => {
  40 |     await page.setViewportSize({ width: 320, height: 800 });
  41 |     const operation = { id: 'privacy-op', state: 'RUNNING', businessId: 'doc-core', action: 'extract' };
  42 |     await page.route('**/admin/api/operations', route => route.fulfill({ json: { items: [operation] } }));
  43 |     await page.route('**/admin/api/operations/privacy-op', route => route.fulfill({ json: { operation, requestInput: { status, ruleCount: 1, data: status === 'HIDDEN' ? '[REDACTED]' : { phone: '090*******' } } } }));
  44 |     await page.goto(`${BASE}/admin/web/operations`);
  45 |     await page.getByRole('button', { name: /privacy-/ }).click();
  46 |     await expect(page.getByLabel('Request input', { exact: true })).toContainText(status === 'HIDDEN' ? '[REDACTED]' : '090*******');
  47 |     await expect(page.locator('body')).not.toContainText('0901234567');
  48 |     expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  49 |     await page.screenshot({ path: `artifacts/request-redaction-${status.toLowerCase()}-mobile.png`, fullPage: true });
  50 |   });
  51 | }
  52 | 
```