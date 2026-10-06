/**
 * VFY-SC03 supplement (2026-10-07) — exercises the checks the main probe
 * (vfy-sc03-browser-verify.cjs) silently SKIPS:
 *  - F6: its selector `input[name="version"]` never matches the real DOM
 *    (the input is `#vault-version-number`, inside the "New secret" modal),
 *  - F7: the secrets page exposes no radiogroup until the modal opens.
 *
 * F6 asserts invalid pinned versions are blocked client-side with a visible
 * INVALID_VERSION banner and ZERO `POST /admin/api/secrets` on the wire, plus
 * a positive control (a valid pinned version must pass the client guard).
 *
 * F7 asserts the WAI-ARIA roving-tabindex radio pattern on the ONLY live
 * radiogroup ("Secret provider"). The fixed ValueSourceSelector radiogroup
 * is currently unreachable in the app: both callers pass `secretOnly`.
 *
 * Run: AWEB01B_URL=.. AWEB01B_TOKEN=.. node coordination/reports/raw/vfy-sc03-f6-f7-supplement-2026-10-07.cjs
 */
const { chromium } = require('D:/Git/dugate/du-rework/tests/browser/node_modules/playwright');

const BASE = process.env.AWEB01B_URL;
const TOKEN = process.env.AWEB01B_TOKEN;
const TENANT = '11111111-1111-4111-8111-111111111111';
let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log('PASS ' + label);
  else { failures++; console.error('FAIL ' + label + (detail === undefined ? '' : ' :: ' + String(detail))); }
}
function info(label, detail) {
  console.log('INFO ' + label + (detail === undefined ? '' : ' :: ' + String(detail)));
}

async function openSecretsModal(page) {
  await page.goto(BASE + '/admin/web/secrets', { waitUntil: 'networkidle' });
  await page.fill('#secrets-tenant', TENANT);
  await page.getByRole('button', { name: 'New secret' }).click();
  await page.getByRole('radio', { name: 'Vault reference' }).click();
  await page.fill('#secret-name', 'f6-probe');
  await page.fill('#vault-connection', 'conn-1');
  await page.fill('#vault-path', 'du/probe');
  await page.fill('#vault-field', 'token');
}

async function main() {
  if (!BASE || !TOKEN) throw new Error('AWEB01B_URL / AWEB01B_TOKEN required');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  const posts = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/admin\/api\/secrets/.test(r.url())) posts.push(r.url());
  });

  await page.goto(BASE + '/admin/web', { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="token"]', TOKEN);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname === '/admin');

  // ---- F6 — invalid pinned versions blocked client-side ----
  // Final implementation: Save is DISABLED + inline FormField error + aria-invalid
  // while the pinned version is invalid (plus a defense-in-depth submit guard).
  await openSecretsModal(page);
  const versionInput = page.locator('#vault-version-number');
  const saveButton = page.getByRole('button', { name: 'Save secret' });
  const inlineError = page.locator('text=Enter a whole number of 1 or more.');
  for (const bad of ['', '1.5', '0']) {
    await versionInput.fill(bad);
    await page.waitForTimeout(150);
    const ariaInvalid = await versionInput.getAttribute('aria-invalid');
    const errShown = (await inlineError.count()) > 0;
    const disabled = await saveButton.isDisabled();
    // Dispatch requirement: visible form error OR blocked submit — both must hold.
    check(`F6 invalid pinned ${JSON.stringify(bad)}: inline error + Save disabled`,
      errShown && disabled,
      `errorShown=${errShown} disabled=${disabled}`);
    // a11y nicety (not part of the dispatch acceptance): the composite
    // FormField child (select+input div) does not receive aria-invalid.
    info(`F6 aria-invalid on #vault-version-number for ${JSON.stringify(bad)}`, `aria-invalid=${ariaInvalid}`);
  }
  check('F6 zero create POST for invalid versions', posts.length === 0, JSON.stringify(posts));

  // ---- F7 — roving tabindex on the live "Secret provider" radiogroup ----
  const group = page.locator('[role="radiogroup"][aria-label="Secret provider"]');
  check('F7 provider radiogroup present', (await group.count()) === 1);
  if ((await group.count()) === 1) {
    const radios = group.locator('[role="radio"]');
    const tabs = await radios.evaluateAll((els) => els.map((e) => e.getAttribute('tabindex')));
    check('F7 roving tabindex (exactly one 0, rest -1)',
      tabs.filter((v) => v === '0').length === 1 && tabs.filter((v) => v === '-1').length === tabs.length - 1,
      JSON.stringify(tabs));
    await radios.nth(0).focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(200);
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? `${el.getAttribute('role')}:${el.textContent}` : 'none';
    });
    check('F7 ArrowRight moves focus to the other radio', /radio:Vault reference/.test(focused), focused);
  }

  // ---- F6 positive control — valid pinned version passes the client guard ----
  await versionInput.fill('3');
  await page.waitForTimeout(150);
  const enabledAgain = await saveButton.isEnabled();
  const errorCleared = (await inlineError.count()) === 0;
  await saveButton.click();
  await page.waitForTimeout(800);
  check('F6 valid pinned version not blocked (Save enabled, no inline error, request fired)',
    enabledAgain && errorCleared && posts.length === 1,
    `enabled=${enabledAgain} errorCleared=${errorCleared} posts=${posts.length}`);

  check('no page errors during supplement', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();
  console.log(failures === 0 ? 'VFY-SC03-SUPPLEMENT: all checks PASS' : 'VFY-SC03-SUPPLEMENT: ' + failures + ' CHECK FAILURES');
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('SUPPLEMENT CRASHED', e); process.exit(1); });
