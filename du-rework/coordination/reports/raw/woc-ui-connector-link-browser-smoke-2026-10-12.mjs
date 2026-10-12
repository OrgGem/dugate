import assert from 'node:assert/strict';
import { chromium } from 'file:///C:/Users/Gem/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const baseUrl = 'http://127.0.0.1:4178/admin';
const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--no-sandbox'],
});
const checks = [];
const pageErrors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('Failed to load resource:')) pageErrors.push(message.text());
  });

  await page.goto(`${baseUrl}/profiles`, { waitUntil: 'networkidle' });
  const initialBindingsLink = page.getByRole('link', { name: 'Manage connectors', exact: true });
  await initialBindingsLink.waitFor();
  await initialBindingsLink.click();
  await page.waitForURL((url) => url.pathname === '/admin/connectors');
  await page.locator('section[aria-labelledby="connectors-title"]').waitFor();
  assert.match(await page.locator('#connectors-title').innerText(), /connectors/i);
  checks.push({ source: 'Initial connector bindings', destination: new URL(page.url()).pathname, rendered: 'Connectors screen' });
  await page.screenshot({ path: 'D:/Git/dugate/du-rework/coordination/reports/raw/woc-ui-connector-link-initial-bindings-2026-10-12.png', fullPage: true });

  await page.goto(`${baseUrl}/profiles`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'New profile group', exact: true }).click();
  const editor = page.locator('section[aria-label="Profile group editor"]');
  await editor.waitFor();
  const businessSelection = page.locator('section[aria-labelledby="profile-group-businesses-title"]');
  await businessSelection.locator('label').filter({ hasText: 'document-core' }).locator('input[type="checkbox"]').check();
  const coreSettings = editor.locator('section[aria-label="document-core profile group settings"]');
  await coreSettings.locator('article').filter({ hasText: 'core:extract:invoice' }).locator('input[type="checkbox"]').check();
  const groupEditorLink = coreSettings.getByRole('link', { name: 'Connectors screen', exact: true });
  await groupEditorLink.waitFor();
  await groupEditorLink.click();
  await page.waitForURL((url) => url.pathname === '/admin/connectors');
  await page.locator('section[aria-labelledby="connectors-title"]').waitFor();
  assert.match(await page.locator('#connectors-title').innerText(), /connectors/i);
  checks.push({ source: 'Profile group connector bindings', destination: new URL(page.url()).pathname, rendered: 'Connectors screen' });
  await page.screenshot({ path: 'D:/Git/dugate/du-rework/coordination/reports/raw/woc-ui-connector-link-profile-group-2026-10-12.png', fullPage: true });

  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ result: 'pass', checks, pageErrors }));
} catch (error) {
  console.error(JSON.stringify({ result: 'fail', message: error instanceof Error ? error.stack : String(error), checks, pageErrors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
