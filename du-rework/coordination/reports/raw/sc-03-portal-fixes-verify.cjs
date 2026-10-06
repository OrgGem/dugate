/**
 * Packet-4 SC-03 Portal Fixes — verification probe (owner evidence).
 *
 * Verifies on the real harness shell + built admin-web bundle:
 *  F2 — no duplicate DOM ids with two callback editors on one screen;
 *  F3 — a stored ref to a DISABLED secret stays visible; Replace/Clear work;
 *  F4 — callback secret selects are filtered by frozen purpose;
 *  F8 — unchecked-after-stored sends explicit `callbackPolicy: null`; a policy
 *       never configured is omitted (omitted = preserve, profiles.ts:268-276).
 */
const { chromium } = require('D:/Git/dugate/du-rework/tests/browser/node_modules/playwright');
const fs = require('node:fs');

const BASE = process.env.AWEB01B_URL;
const TOKEN = process.env.AWEB01B_TOKEN;
const STUB = process.env.AWEB03B_STUB;
const EVIDENCE = process.env.AWEB01B_EVIDENCE ?? 'D:/Git/dugate/du-rework/coordination/evidence/sc-03-portal-fixes';

const TENANT = '11111111-1111-4111-8111-111111111111';
const API_KEY = 'aaaaaaaa-1111-4111-8111-111111111111';
const OAUTH_SECRET = 'aaaaaaaa-2222-4222-8222-222222222222';
const HEADER_SECRET = 'bbbbbbbb-2222-4222-8222-222222222222';
const CONNECTOR_SECRET = 'cccccccc-2222-4222-8222-222222222222';
const OLD_OAUTH_SECRET = 'dddddddd-2222-4222-8222-222222222222';

let failures = 0;
function check(label, condition, detail) {
  if (condition) console.log(`PASS ${label}`);
  else {
    failures += 1;
    console.error(`FAIL ${label}${detail === undefined ? '' : ' :: ' + String(detail)}`);
  }
}

function secret(secretId, name, purpose, state = 'ACTIVE') {
  return {
    catalogVersion: 1,
    secretId,
    tenantId: TENANT,
    name,
    purpose,
    services: ['orchestrator'],
    provider: { kind: 'managed_value' },
    state,
    revision: 2,
    rotation: { rotatedAt: null, intervalDays: null },
    valueConfigured: true,
    usageReferences: [],
  };
}

function profileFixture(withCallbackPolicy) {
  return {
    businessId: 'doc-core',
    businessVersion: 'v1',
    profileName: 'extract',
    revision: 7,
    apiKeyId: API_KEY,
    currentValues: {},
    policy: {
      enabled: true,
      parameters: {},
      jobPriority: 'MEDIUM',
      allowedFileExtensions: '.pdf',
      fileUrlAuthConfigured: false,
      connectionsOverride: [],
      ...(withCallbackPolicy
        ? {
            callbackPolicy: {
              version: 1,
              mode: 'notification_with_result',
              auth: {
                method: 'oauth2_client_credentials',
                grantType: 'client_credentials',
                tokenUrl: 'https://provider.example/oauth/token',
                clientId: 'probe-client',
                clientSecretRef: { kind: 'managed-secret', ref: OLD_OAUTH_SECRET },
                clientAuthMethod: 'client_secret_basic',
              },
              destination: { approvedOrigins: ['https://receiver.example'] },
            },
          }
        : {}),
    },
    manifest: { actions: [{ name: 'extract' }] },
    capabilities: [
      { connectorId: 'c1', capability: 'policy' },
      { connectorId: 'c1', capability: 'publish' },
    ],
  };
}

async function loadProfile(page) {
  await page.goto(`${BASE}/admin/web/profiles`, { waitUntil: 'networkidle' });
  await page.fill('#profile-business', 'doc-core');
  await page.getByRole('button', { name: 'Load profile' }).click();
  await page.getByText(/revision \d+/).waitFor({ timeout: 15000 });
}

async function lastUpsert() {
  const writes = (await (await fetch(`${STUB}/__stub/writes`)).json()).writes;
  return writes.filter((write) => write.action === 'profile.upsert').pop();
}

async function main() {
  if (!BASE || !TOKEN || !STUB) throw new Error('AWEB01B_URL / AWEB01B_TOKEN / AWEB03B_STUB must be set');
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  let storedPolicyEnabled = true;
  await page.route('**/admin/api/secrets**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const items = [
      secret(OAUTH_SECRET, 'oauth secret', 'profile.callback_oauth2_client_secret'),
      secret(HEADER_SECRET, 'header secret', 'profile.callback_header'),
      secret(CONNECTOR_SECRET, 'connector secret', 'connector.credential'),
      secret(OLD_OAUTH_SECRET, 'old oauth secret', 'profile.callback_oauth2_client_secret', 'DISABLED'),
    ];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items, nextCursor: null }) });
  });
  await page.route('**/admin/api/profiles/**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(profileFixture(storedPolicyEnabled)),
    });
  });

  await page.goto(`${BASE}/admin/web`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="token"]', TOKEN);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => url.pathname === '/admin');

  await fetch(`${STUB}/__stub/mode?reset=1`);
  await fetch(`${STUB}/__stub/mode?profile=fixture&profileWrite=ok`);

  /* ---------------- Phase 1: stored policy + stale disabled ref ---------------- */
  await loadProfile(page);
  const checkbox = page.getByRole('checkbox', { name: /Configure a callback policy/ });
  check('stored policy seeds the editor as configured', await checkbox.isChecked());
  const storedBlock = page.locator('[data-value-source-stored="secret_ref"]');
  check('stale DISABLED ref renders the stored block', await storedBlock.count() === 1);
  check('stale ref shows its name + DISABLED state',
    (await storedBlock.innerText()).includes('old oauth secret') && (await storedBlock.innerText()).includes('DISABLED'),
    (await storedBlock.innerText()).replace(/\n/g, ' '));

  /* ---------------- Phase 2: duplicate ids with two editors ---------------- */
  await page.getByRole('button', { name: 'Add endpoint row' }).click();
  await page.getByRole('checkbox', { name: /Configure a callback policy/ }).nth(1).check();
  const idReport = await page.evaluate(() => {
    const ids = Array.from(document.querySelectorAll('[id]')).map((element) => element.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    return { duplicates: Array.from(new Set(duplicates)), total: ids.length };
  });
  check('no duplicate DOM ids across two callback editors', idReport.duplicates.length === 0, JSON.stringify(idReport));
  check('row-scoped ids exist for both rows',
    await page.locator('#profile-0-callback-mode').count() === 1
    && await page.locator('#profile-1-callback-mode').count() === 1,
    `row0=${await page.locator('#profile-0-callback-mode').count()} row1=${await page.locator('#profile-1-callback-mode').count()}`);
  await page.screenshot({ path: `${EVIDENCE}/01-stored-ref-and-two-rows.png`, fullPage: true });
  await page.getByRole('button', { name: 'Remove row' }).nth(1).click();

  /* ---------------- Phase 3: Replace → purpose-filtered options → Clear ---------------- */
  await storedBlock.getByRole('button', { name: 'Replace' }).click();
  const select = page.locator('#profile-0-callback-client-secret-secret');
  await select.waitFor({ timeout: 10000 });
  const optionValues = await select.locator('option').evaluateAll((options) => options.map((option) => option.value));
  check('oauth2 select lists ONLY active oauth-purpose secrets + current ref',
    optionValues.includes(OAUTH_SECRET)
    && optionValues.includes(OLD_OAUTH_SECRET)
    && !optionValues.includes(HEADER_SECRET)
    && !optionValues.includes(CONNECTOR_SECRET),
    optionValues.join(','));
  const optionTexts = await select.locator('option').allTextContents();
  check('disabled current ref keeps its DISABLED label visible',
    optionTexts.some((text) => text.includes('old oauth secret') && text.includes('DISABLED')),
    optionTexts.join(' | '));

  await page.getByRole('button', { name: 'Clear reference' }).click();
  check('Clear empties the reference',
    (await select.inputValue()) === '', await select.inputValue());
  await page.getByText('client secret reference is required').waitFor({ timeout: 10000 });
  check('cleared credential surfaces the validation error', true);

  await select.selectOption(OAUTH_SECRET);
  await page.getByText('valid on client').waitFor({ timeout: 10000 });
  check('selecting an oauth-purpose secret validates', true);

  /* ---------------- Phase 4: explicit clear semantics (F8) ---------------- */
  await checkbox.uncheck();
  await page.getByText(/explicit clear/).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Save extract' }).click();
  await page.getByText(/saved \(revision/).waitFor({ timeout: 15000 });
  const clearUpsert = await lastUpsert();
  check('unchecking a stored policy sends explicit callbackPolicy:null',
    clearUpsert !== undefined
    && Object.prototype.hasOwnProperty.call(clearUpsert.params.policy, 'callbackPolicy')
    && clearUpsert.params.policy.callbackPolicy === null,
    JSON.stringify(clearUpsert && clearUpsert.params.policy));

  /* ---------------- Phase 5: header purpose filter + omitted-preserve ---------------- */
  storedPolicyEnabled = false;
  await loadProfile(page);
  check('policy without stored value starts unchecked', !(await checkbox.isChecked()));
  await page.getByRole('button', { name: 'Save extract' }).click();
  await page.getByText(/saved \(revision/).waitFor({ timeout: 15000 });
  const omittedUpsert = await lastUpsert();
  check('untouched policy omits the callbackPolicy key (omitted = preserve)',
    omittedUpsert !== undefined
    && !Object.prototype.hasOwnProperty.call(omittedUpsert.params.policy, 'callbackPolicy'),
    JSON.stringify(omittedUpsert && omittedUpsert.params.policy));

  await checkbox.check();
  await page.getByLabel('Callback authentication').selectOption('configured_headers');
  const headerSelect = page.locator('#profile-0-callback-header-secret-0-secret');
  await headerSelect.waitFor({ timeout: 10000 });
  const headerOptionValues = await headerSelect.locator('option').evaluateAll((options) => options.map((option) => option.value));
  check('header select lists ONLY active header-purpose secrets',
    headerOptionValues.includes(HEADER_SECRET)
    && !headerOptionValues.includes(OAUTH_SECRET)
    && !headerOptionValues.includes(CONNECTOR_SECRET)
    && !headerOptionValues.includes(OLD_OAUTH_SECRET),
    headerOptionValues.join(','));
  await page.screenshot({ path: `${EVIDENCE}/02-purpose-filtered-headers.png`, fullPage: true });

  await headerSelect.selectOption(HEADER_SECRET);
  await page.locator('#profile-0-callback-header-name-0').fill('X-Api-Key');
  await page.fill('#profile-0-callback-approved-origins', 'https://receiver.example');
  await page.getByRole('button', { name: 'Save extract' }).click();
  await page.getByText(/saved \(revision/).waitFor({ timeout: 15000 });
  const headerUpsert = await lastUpsert();
  const headerPolicy = headerUpsert && headerUpsert.params.policy.callbackPolicy;
  check('configured_headers saves the header-purpose ref',
    headerPolicy && headerPolicy.auth.method === 'configured_headers'
    && headerPolicy.auth.headers[0].secretRef.ref === HEADER_SECRET,
    JSON.stringify(headerPolicy));

  check('no page errors during the verification', pageErrors.length === 0, pageErrors.join(' | '));
  await browser.close();
  console.log(failures === 0 ? '\nPacket-4 verification: ALL CHECKS PASSED' : `\nPacket-4 verification: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('PACKET-4 PROBE CRASHED', error);
  process.exit(1);
});
