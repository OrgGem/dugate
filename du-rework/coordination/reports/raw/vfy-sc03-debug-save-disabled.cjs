/* debug: why is "Save secret" disabled after filling the vault_reference form? */
const { chromium } = require('D:/Git/dugate/du-rework/tests/browser/node_modules/playwright');
const BASE = process.env.AWEB01B_URL;
const TOKEN = process.env.AWEB01B_TOKEN;
const TENANT = '11111111-1111-4111-8111-111111111111';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(BASE + '/admin/web', { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="token"]', TOKEN);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname === '/admin');

  await page.goto(BASE + '/admin/web/secrets', { waitUntil: 'networkidle' });
  await page.fill('#secrets-tenant', TENANT);
  await page.getByRole('button', { name: 'New secret' }).click();
  await page.getByRole('radio', { name: 'Vault reference' }).click();
  await page.fill('#secret-name', 'f6-probe');
  await page.fill('#vault-connection', 'conn-1');
  await page.fill('#vault-path', 'du/probe');
  await page.fill('#vault-field', 'token');
  await page.waitForTimeout(300);

  const dump = await page.evaluate(() => {
    const val = (id) => {
      const el = document.getElementById(id);
      return el ? `${el.tagName}=${JSON.stringify(el.value)}` : 'MISSING';
    };
    const save = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save secret');
    return {
      tenant: val('secrets-tenant'),
      name: val('secret-name'),
      conn: val('vault-connection'),
      mount: val('vault-mount'),
      path: val('vault-path'),
      field: val('vault-field'),
      version: val('vault-version-number'),
      saveDisabled: save ? save.disabled : 'NO BUTTON',
      modalOpen: document.querySelector('[role="dialog"]') !== null,
    };
  });
  console.log(JSON.stringify(dump, null, 2));
  await browser.close();
}
main().catch((e) => { console.error('DEBUG CRASHED', e); process.exit(1); });
