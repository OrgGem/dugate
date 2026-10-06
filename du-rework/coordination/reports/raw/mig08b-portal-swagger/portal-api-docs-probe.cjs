/* Browser probe for the Orchestrator Portal API Reference route (read-only). */
const path = require('node:path');
const { chromium } = require('D:/Git/dugate/du-rework/tests/browser/node_modules/@playwright/test');

const BASE = 'http://localhost:4173/admin/web/api-docs';
const OUT = 'D:/Git/dugate/du-rework/coordination/reports/raw/mig08b-portal-swagger';

async function waitForServer(url, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status >= 200 && response.status < 500) return true;
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

(async () => {
  const report = { url: BASE, checks: [], consoleErrors: [], externalRequests: [], passed: false };
  if (!(await waitForServer(BASE))) {
    report.error = 'preview server not reachable';
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  // The static preview has no BFF; stub ONLY the session read with the real
  // unauthenticated answer the Orchestrator Backend gives (401). Session gating
  // itself is server-side and is not what this probe verifies.
  await page.route('**/admin/api/session', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{"code":"UNAUTHENTICATED"}' }),
  );
  page.on('pageerror', (error) => report.consoleErrors.push('pageerror: ' + String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') report.consoleErrors.push('console: ' + message.text());
  });
  page.on('request', (request) => {
    try {
      const parsed = new URL(request.url());
      if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') report.externalRequests.push(request.url());
    } catch {
      /* non-URL request target (data:) is same-document */
    }
  });
  report.failedResponses = [];
  page.on('response', (response) => {
    if (response.status() >= 400) report.failedResponses.push(response.status() + ' ' + response.url());
  });
  const isStubbedSessionRead = (entry) => /\/admin\/api\/session$/.test(entry) || /favicon\.ico$/.test(entry);

  const checks = [];
  const check = (name, value, expected) => {
    checks.push({ name, value, expected, ok: value === expected });
  };

  await page.goto(BASE, { waitUntil: 'networkidle' });
  check('document.title', await page.title(), 'Orchestrator Portal');
  check('api reference heading', await page.getByText('API Reference', { exact: true }).count() > 0, true);
  check('operation rows (All)', await page.locator('ul[aria-label="OpenAPI operations"] li').count(), 57);
  const familyText = (await page.locator('[aria-label="Filter by API family"] button').allTextContents()).join(' | ');
  check(
    'family filters',
    [
      familyText.includes('All (57)'),
      familyText.includes('Public API (12)'),
      familyText.includes('Admin / Management (10)'),
      familyText.includes('Runtime (18)'),
      familyText.includes('Connector (17)'),
    ].every(Boolean),
    true,
  );
  check('public origin 3000 shown', await page.getByText('http://localhost:3000', { exact: false }).count() > 0, true);
  check('internal origin 3002 shown', await page.getByText('http://localhost:3002', { exact: false }).count() > 0, true);
  check(
    'try-it-out disabled note',
    await page.getByText('Try-it-out is intentionally disabled', { exact: false }).count() > 0,
    true,
  );

  try {
    await page.getByRole('button', { name: /Admin \/ Management/ }).click();
  } catch (error) {
    const names = await page.locator('[aria-label="Filter by API family"] button').allTextContents();
    await page.screenshot({ path: path.join(OUT, 'portal-api-docs-debug.png'), fullPage: true });
    throw new Error('admin filter click failed; buttons=' + JSON.stringify(names));
  }
  check('admin filter rows', await page.locator('ul[aria-label="OpenAPI operations"] li').count(), 10);
  await page.getByRole('button', { name: /^All \(57\)$/ }).click();

  await page.getByLabel('Search operations').fill('claim');
  const searchRows = await page.locator('ul[aria-label="OpenAPI operations"] li').count();
  checks.push({ name: 'search "claim" rows', value: searchRows, expected: '>= 1', ok: searchRows >= 1 });
  await page.getByLabel('Search operations').fill('');

  await page.getByRole('button', { name: /POST \/api\/v1\/admin\/actions/ }).click();
  const detail = page.getByRole('region', { name: 'Operation detail' });
  check('detail shows internal origin', await detail.getByText('http://localhost:3002', { exact: false }).count() > 0, true);
  check('detail shows required scope row', await detail.getByText('Required scope', { exact: false }).count() > 0, true);
  check('detail shows security', await detail.getByText('Security', { exact: false }).count() > 0, true);
  check('schemas heading', await page.getByText('Schemas (14)', { exact: false }).count() > 0, true);

  await page.screenshot({ path: path.join(OUT, 'portal-api-docs.png'), fullPage: false });
  await page.screenshot({ path: path.join(OUT, 'portal-api-docs-full.png'), fullPage: true });

  report.checks = checks;
  report.passed =
    checks.every((entry) => entry.ok) &&
    report.externalRequests.length === 0 &&
    report.failedResponses.filter((entry) => !isStubbedSessionRead(entry)).length === 0;
  await browser.close();
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.passed ? 0 : 1);
})().catch((error) => {
  console.error('PROBE-ERROR', error);
  process.exit(2);
});
