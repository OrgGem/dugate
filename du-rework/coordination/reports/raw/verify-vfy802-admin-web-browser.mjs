import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [harnessJson, evidenceDir] = process.argv.slice(2);
assert.ok(harnessJson && evidenceDir, 'usage: node verify-vfy802-admin-web-browser.mjs <harness.json> <evidence-dir>');

const playwrightEntry = resolve('tests/browser/node_modules/playwright/index.mjs');
const { chromium } = await import(pathToFileURL(playwrightEntry).href);
const harness = JSON.parse(readFileSync(harnessJson, 'utf8'));
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const requests = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === harness.url && url.pathname.startsWith('/admin/api/')) {
      requests.push(`${request.method()} ${url.pathname}`);
    }
  });

  await page.goto(`${harness.url}/admin/web`, { waitUntil: 'domcontentloaded' });
  assert.equal(new URL(page.url()).pathname, '/admin/login', 'unauthenticated route must use the shell login gate');
  await page.locator('input[name="token"]').fill(harness.token);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname === '/admin');

  await page.goto(`${harness.url}/admin/web/workflows`, { waitUntil: 'networkidle' });
  const workflowText = await page.locator('#root').innerText();
  assert.match(workflowText, /Workflows route is disabled/i);
  assert.match(workflowText, /disabled by deployment policy/i);
  assert.match(workflowText, /No workflows data is read or mutated/i);
  assert.equal(requests.length, 0, `workflows route called an admin wire: ${requests.join(', ')}`);
  await page.screenshot({ path: resolve(evidenceDir, 'vfy802-workflows-disabled.png'), fullPage: true });

  await page.goto(`${harness.url}/admin/web/docs`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'API Docs + Test Workbench' }).waitFor();
  assert.match(await page.locator('#root').innerText(), /Profile Test Endpoint/);
  await page.getByRole('button', { name: 'Open Test Workbench' }).click();
  await page.getByRole('heading', { name: 'Test Workbench (CFGADM-11)' }).waitFor();

  const workbench = await page.locator('body').innerText();
  const inputs = await page.locator('input, textarea').evaluateAll((elements) =>
    elements.map((element) => ({
      type: element instanceof HTMLInputElement ? element.type : 'textarea',
      name: element.getAttribute('aria-label') ?? '',
      placeholder: element.getAttribute('placeholder') ?? '',
    })),
  );
  assert.deepEqual(inputs.map((item) => item.name), ['businessId', 'businessVersion', 'profileName', 'endpointSlug', 'file urls']);
  assert.ok(inputs.every((item) => !/secret|password|token|credential/i.test(`${item.name} ${item.placeholder}`)));
  assert.ok(!/aweb01b-browser-secret|du-live-kek|vault:\/\//i.test(workbench), 'known harness credential sentinels leaked into workbench');
  assert.equal(requests.length, 0, `opening docs/workbench called an admin wire: ${requests.join(', ')}`);
  await page.screenshot({ path: resolve(evidenceDir, 'vfy802-docs-workbench.png'), fullPage: true });

  console.log('WORKFLOWS: PASS; disabled reason rendered; no data-read/mutation text; admin-wire requests=0');
  console.log('DOCS: PASS; endpoint catalog + workbench rendered; inputs contain business/profile/url fields only; known-secret sentinels absent; admin-wire requests=0');
  console.log(`SCREENSHOTS: ${resolve(evidenceDir, 'vfy802-workflows-disabled.png')}; ${resolve(evidenceDir, 'vfy802-docs-workbench.png')}`);
} finally {
  await browser.close();
}
