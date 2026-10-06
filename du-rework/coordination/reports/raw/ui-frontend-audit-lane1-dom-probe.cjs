/**
 * Lane-1 UI audit — DOM probe (read-only).
 *
 * 1) Honest-error path: with no SC-01 admin API in the stub, /admin/web/secrets
 *    must render an error state without crashing and without leaking anything.
 * 2) Duplicate DOM ids: two profile rows each rendering the CB-04 editor produce
 *    duplicate field ids (a11y/form association finding).
 */
const { chromium } = require('D:/Git/dugate/du-rework/tests/browser/node_modules/playwright');

const BASE = process.env.AWEB01B_URL;
const TOKEN = process.env.AWEB01B_TOKEN;
const STUB = process.env.AWEB03B_STUB;

let failures = 0;
function check(label, condition, detail) {
  if (condition) console.log(`PASS ${label}`);
  else {
    failures += 1;
    console.error(`FAIL ${label}${detail === undefined ? '' : ' :: ' + String(detail)}`);
  }
}

async function main() {
  if (!BASE || !TOKEN || !STUB) throw new Error('AWEB01B_URL / AWEB01B_TOKEN / AWEB03B_STUB must be set');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(`${BASE}/admin/web`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="token"]', TOKEN);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => url.pathname === '/admin');

  // 1) Honest error path for the secrets screen (upstream catalog absent).
  await page.goto(`${BASE}/admin/web/secrets`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Secrets', exact: true }).waitFor({ timeout: 15000 });
  await page.fill('#secrets-tenant', '11111111-1111-4111-8111-111111111111');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.waitForTimeout(1200);
  const bodyText = await page.locator('body').innerText();
  check('secrets screen renders an honest failure instead of fabricated rows',
    /Failed to load|rejected|could not be loaded|not available|NOT_FOUND|UPSTREAM|Try again/i.test(bodyText), bodyText.slice(0, 200).replace(/\n/g, ' '));
  check('secrets screen shows no plaintext value anywhere', !/AUDIT-LANE1-SENTINEL/.test(bodyText));

  // 2) Duplicate DOM ids across two profile rows.
  await fetch(`${STUB}/__stub/mode?reset=1`);
  await fetch(`${STUB}/__stub/mode?profile=fixture&profileWrite=ok`);
  await page.goto(`${BASE}/admin/web/profiles`, { waitUntil: 'networkidle' });
  await page.fill('#profile-business', 'doc-core');
  await page.getByRole('button', { name: 'Load profile' }).click();
  await page.getByText(/revision \d+/).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Add endpoint row' }).click();
  const checkboxes = page.getByRole('checkbox', { name: /Configure a callback policy/ });
  check('two profile rows each expose a callback toggle', await checkboxes.count() === 2, `count=${await checkboxes.count()}`);
  await checkboxes.nth(0).check();
  await checkboxes.nth(1).check();
  for (const row of [0, 1]) {
    await page.getByLabel('Callback authentication').nth(row).selectOption('oauth2_client_credentials');
  }
  await page.waitForTimeout(300);

  const duplicateReport = await page.evaluate(() => {
    const ids = [
      'callback-token-url',
      'callback-client-id',
      'callback-client-auth',
      'callback-scope',
      'callback-approved-origins',
      'callback-path-prefixes',
      'callback-client-secret-secret',
      'callback-mode-notification_only',
      'callback-auth-oauth2_client_credentials',
    ];
    const counts = {};
    for (const id of ids) counts[id] = document.querySelectorAll(`[id="${id}"]`).length;
    const labelFor = document.querySelectorAll('label[for="callback-token-url"]').length;
    return { counts, labelFor };
  });
  const duplicates = Object.entries(duplicateReport.counts).filter(([, count]) => count > 1);
  check('duplicate ids reproduced with two callback editors', duplicates.length > 0,
    JSON.stringify(duplicateReport));
  console.log('ID-COUNTS ' + JSON.stringify(duplicateReport));

  check('no page errors during the audit path', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\nUI audit probe: done (findings above are evidence)' : `\nUI audit probe: ${failures} CHECK FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UI AUDIT PROBE CRASHED', error);
  process.exit(1);
});
