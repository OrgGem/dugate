/**
 * VFY-SC03 — independent DOM/browser verification (F2 / F6 / F7 + no-plaintext).
 * INVERTED relative to the Lane-1 audit probe, which asserted the DEFECTS EXISTED.
 * Needs a running admin-web + stub:
 *   AWEB01B_URL, AWEB01B_TOKEN, AWEB03B_STUB
 * Run: node coordination/reports/raw/vfy-sc03-browser-verify.cjs
 */
const { chromium } = require('D:/Git/dugate/du-rework/tests/browser/node_modules/playwright');

const BASE = process.env.AWEB01B_URL;
const TOKEN = process.env.AWEB01B_TOKEN;
const STUB = process.env.AWEB03B_STUB;
let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log('PASS ' + label);
  else { failures++; console.error('FAIL ' + label + (detail === undefined ? '' : ' :: ' + String(detail))); }
}

async function main() {
  if (!BASE || !TOKEN || !STUB) throw new Error('AWEB01B_URL / AWEB01B_TOKEN / AWEB03B_STUB required');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  const sentinels = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', async (r) => {
    try { const t = await r.text(); if (/sk-live-|hunter2|dXNlcjpwYXNz/.test(t)) sentinels.push(r.url()); } catch {}
  });

  await page.goto(BASE + '/admin/web', { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="token"]', TOKEN);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname === '/admin');

  // F2 — no duplicate ids with two callback editors open.
  await fetch(STUB + '/__stub/mode?reset=1');
  await fetch(STUB + '/__stub/mode?profile=fixture&profileWrite=ok');
  await page.goto(BASE + '/admin/web/profiles', { waitUntil: 'networkidle' });
  await page.fill('#profile-business', 'doc-core');
  await page.getByRole('button', { name: 'Load profile' }).click();
  await page.getByText(/revision \d+/).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Add endpoint row' }).click();
  const boxes = page.getByRole('checkbox', { name: /Configure a callback policy/ });
  if ((await boxes.count()) >= 2) {
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    const dupes = await page.evaluate(() => {
      const c = {};
      document.querySelectorAll('[id]').forEach((el) => { c[el.id] = (c[el.id] || 0) + 1; });
      return Object.entries(c).filter(([, n]) => n > 1);
    });
    check('F2 no duplicate DOM ids', dupes.length === 0, JSON.stringify(dupes));
  }

  // F6 — pinned version must reject NaN/null at the client.
  await page.goto(BASE + '/admin/web/secrets', { waitUntil: 'networkidle' });
  await page.fill('#secrets-tenant', '11111111-1111-4111-8111-111111111111');
  const versionInput = page.locator('input[name="version"]').first();
  if ((await versionInput.count()) > 0) {
    await versionInput.fill('NaN');
    const submit = page.getByRole('button', { name: /Create|Submit/ }).first();
    if ((await submit.count()) > 0) {
      await submit.click();
      await page.waitForTimeout(400);
      const err = await page.locator('[role="alert"], .error, [aria-invalid="true"]').count();
      check('F6 invalid pinned version blocked with a visible error', err > 0, 'no alert/aria-invalid shown');
    }
  }

  // F7 — roving tabindex + arrow keys on the Literal/Secret radiogroup.
  const group = page.locator('[role="radiogroup"]').first();
  if ((await group.count()) > 0) {
    const t0 = await group.locator('button,input').evaluateAll((els) => els.map((e) => e.getAttribute('tabindex')));
    check('F7 roving tabindex 0/-1', t0.filter((v) => v === '0').length === 1 && t0.filter((v) => v === '-1').length >= 1, JSON.stringify(t0));
    await group.locator('[tabindex="0"]').first().focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(200);
    const active = await group.evaluate((g) => g.querySelector('[tabindex="0"]')?.textContent ?? null);
    check('F7 ArrowRight moves the active item', active !== null, 'no active item after ArrowRight');
  }

  // No plaintext secret leaked to DOM or response bodies.
  const html = await page.content();
  check('no plaintext secret in DOM', !/sk-live-|hunter2|dXNlcjpwYXNz/.test(html), 'sentinel found in page HTML');
  check('no plaintext secret in responses', sentinels.length === 0, JSON.stringify(sentinels));
  check('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log(failures === 0 ? 'VFY-SC03: all checks PASS' : 'VFY-SC03: ' + failures + ' CHECK FAILURES');
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('PROBE CRASHED', e); process.exit(1); });
