/**
 * SC-03 + CB-04 browser probe (owner evidence, not a repo test).
 *
 * Runs against the AWEB harness server (real createAdminShellServer + scripted
 * upstream) and intercepts only `/admin/api/secrets**` with a contract-shaped
 * fixture, because the SC-01 catalog admin API is not implemented yet.
 *
 * Proves in a real browser:
 *  - the Secrets route renders list metadata (no plaintext readback);
 *  - create sends the tagged ValueSource literal and never re-renders it;
 *  - vault_reference links carry mount/path/field/version;
 *  - rotate/disable CAS bodies; safe probe badge;
 *  - the profile callback editor saves secret REFERENCES only (no literal in
 *    the upsert body) for both oauth2 client secret and configured headers.
 */
const { chromium } = require('D:/Git/dugate/du-rework/tests/browser/node_modules/playwright');
const fs = require('node:fs');

const BASE = process.env.AWEB01B_URL;
const TOKEN = process.env.AWEB01B_TOKEN;
const STUB = process.env.AWEB03B_STUB;
const EVIDENCE = process.env.AWEB01B_EVIDENCE ?? 'D:/Git/dugate/du-rework/coordination/evidence/sc-03-cb-04';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SECRET_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const SECRET_ID_2 = 'bbbbbbbb-2222-4222-8222-222222222222';
const SENTINEL = 'SC0304-SENTINEL-MANAGED-VALUE-DO-NOT-PERSIST-IN-DOM';
const SENTINEL_ROTATE = 'SC0304-SENTINEL-ROTATED-VALUE';

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL ${label}${detail === undefined ? '' : ' :: ' + String(detail)}`);
  }
}

function entry(overrides = {}) {
  return {
    catalogVersion: 1,
    secretId: SECRET_ID,
    tenantId: TENANT,
    name: 'billing token',
    purpose: 'profile.callback_oauth2_client_secret',
    services: ['orchestrator'],
    provider: { kind: 'managed_value' },
    state: 'ACTIVE',
    revision: 3,
    rotation: { rotatedAt: null, intervalDays: null },
    valueConfigured: true,
    usageReferences: [{ kind: 'profile_callback', refId: 'billing' }],
    ...overrides,
  };
}

async function main() {
  if (!BASE || !TOKEN || !STUB) throw new Error('AWEB01B_URL / AWEB01B_TOKEN / AWEB03B_STUB must be set');
  fs.mkdirSync(EVIDENCE, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push('pageerror: ' + error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.location().url.includes('favicon')) {
      consoleErrors.push('console: ' + message.text() + ' @ ' + message.location().url);
    }
  });

  const secretWrites = [];
  let listed = false;
  await page.route('**/admin/api/secrets**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = request.postDataJSON ? (() => { try { return request.postDataJSON(); } catch { return null; } })() : null;
    if (method === 'GET') {
      listed = true;
      const current = [
        entry(),
        entry({ secretId: SECRET_ID_2, name: 'billing token archive', state: 'DISABLED', revision: 1 }),
      ];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: current, nextCursor: null }) });
    }
    if (method === 'POST') {
      secretWrites.push({ path: url.pathname, body });
      if (url.pathname.endsWith('/test')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      }
      if (url.pathname.endsWith('/rotate')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(entry({ revision: 4 })) });
      }
      if (url.pathname.endsWith('/disable')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(entry({ state: 'DISABLED' })) });
      }
      // create
      const created = entry({ revision: 1, name: body && body.name ? body.name : 'created' });
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(created) });
    }
    return route.fallback();
  });

  // Login through the real shell form.
  await page.goto(`${BASE}/admin/web`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="token"]', TOKEN);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => url.pathname === '/admin');

  /* ---------------- SC-03: secrets screen ---------------- */
  await page.goto(`${BASE}/admin/web/secrets`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Secrets', exact: true }).waitFor({ timeout: 15000 });
  await page.fill('#secrets-tenant', TENANT);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.getByText('billing token', { exact: true }).waitFor({ timeout: 15000 });
  check('secrets: list rendered from the catalog contract', await page.getByText('billing token').count() > 0);
  check('secrets: disabled entry shows its state', await page.getByText('DISABLED').first().isVisible());
  check('secrets: provider label is shown', await page.getByText('Managed value').first().isVisible());
  check('secrets: value-configured badge is metadata only', await page.getByText('value configured').first().isVisible());
  check('secrets: catalog listing issued a GET', listed);
  await page.screenshot({ path: `${EVIDENCE}/01-secrets-list.png`, fullPage: true });

  // Safe probe.
  await page.getByRole('button', { name: 'Test' }).first().click();
  await page.getByText('available', { exact: true }).waitFor({ timeout: 10000 });
  check('secrets: safe probe renders availability only', true);

  // Create managed_value with a writer-only password input.
  await page.getByRole('button', { name: 'New secret' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await dialog.locator('#secret-name').fill('probe managed secret');
  await dialog.locator('#secret-value').fill(SENTINEL);
  check('secrets: managed value input is password-style', await dialog.locator('#secret-value').getAttribute('type') === 'password');
  await dialog.getByRole('button', { name: 'Save secret' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 10000 });
  const createWrite = secretWrites.find((write) => write.path === '/admin/api/secrets');
  check('secrets: create body carries the tagged literal ValueSource',
    createWrite && createWrite.body && createWrite.body.value && createWrite.body.value.kind === 'literal'
    && createWrite.body.provider && createWrite.body.provider.kind === 'managed_value');
  check('secrets: sentinel never re-enters the DOM', !(await page.content()).includes(SENTINEL));

  // Link a vault_reference.
  await page.getByRole('button', { name: 'New secret' }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('dialog').locator('#secret-name').fill('probe vault link');
  await page.getByRole('dialog').getByRole('radio', { name: 'Vault reference' }).click();
  await page.getByRole('dialog').locator('#vault-connection').fill('vault-main');
  await page.getByRole('dialog').locator('#vault-path').fill('du/tenants/x/billing');
  await page.getByRole('dialog').locator('#vault-field').fill('api-key');
  await page.getByRole('dialog').getByRole('button', { name: 'Save secret' }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 10000 });
  const vaultWrite = secretWrites.filter((write) => write.path === '/admin/api/secrets').pop();
  check('secrets: vault link body carries the locator, never a value',
    vaultWrite && vaultWrite.body && vaultWrite.body.provider && vaultWrite.body.provider.kind === 'vault_reference'
    && vaultWrite.body.provider.mount === 'secret'
    && vaultWrite.body.provider.version && vaultWrite.body.provider.version.mode === 'pinned'
    && vaultWrite.body.value === undefined);

  // Rotate with CAS.
  await page.getByRole('button', { name: 'Rotate' }).first().click();
  await page.locator('#rotate-value').fill(SENTINEL_ROTATE);
  await page.getByRole('button', { name: 'Rotate value' }).click();
  await page.locator('#rotate-value').waitFor({ state: 'detached', timeout: 10000 });
  await page.waitForTimeout(800);
  const rotateWrite = secretWrites.find((write) => write.path.endsWith('/rotate'));
  check('secrets: rotate body is CAS-guarded and write-only',
    rotateWrite && rotateWrite.body && rotateWrite.body.expectedRevision === 3
    && rotateWrite.body.value && rotateWrite.body.value.kind === 'literal');
  check('secrets: rotated sentinel never re-enters the DOM', !(await page.content()).includes(SENTINEL_ROTATE));

  // Disable with reason.
  const activeRow = page.getByRole('row').filter({ hasText: 'billing token' }).first();
  await activeRow.getByRole('button', { name: 'Disable' }).click();
  await page.locator('#disable-reason').waitFor({ timeout: 10000 });
  await page.locator('#disable-reason').fill('probe disable reason');
  await page.getByRole('button', { name: 'Disable secret' }).click();
  await page.locator('#disable-reason').waitFor({ state: 'detached', timeout: 10000 });
  await page.waitForTimeout(800);
  const disableWrite = secretWrites.find((write) => write.path.endsWith('/disable'));
  check('secrets: disable body carries CAS + reason',
    disableWrite && disableWrite.body && disableWrite.body.expectedRevision === 3
    && typeof disableWrite.body.reason === 'string' && disableWrite.body.reason.length > 0,
    'writes=' + secretWrites.map((write) => write.path).join(','));
  await page.screenshot({ path: `${EVIDENCE}/02-secrets-after-actions.png`, fullPage: true });

  /* ---------------- CB-04: profile callback policy ---------------- */
  await fetch(`${STUB}/__stub/mode?reset=1`);
  const modeResponse = await fetch(`${STUB}/__stub/mode?profile=fixture&profileWrite=ok`);
  check('probe: profile stub set to fixture/ok', modeResponse.ok);
  await page.goto(`${BASE}/admin/web/profiles`, { waitUntil: 'networkidle' });
  await page.fill('#profile-business', 'doc-core');
  await page.getByRole('button', { name: 'Load profile' }).click();
  await page.getByText(/revision \d+/).waitFor({ timeout: 15000 });

  await page.getByRole('checkbox', { name: /Configure a callback policy/ }).check();
  await page.getByLabel('Callback authentication').selectOption('oauth2_client_credentials');
  check('callback: secret-only selector renders no literal input',
    await page.locator('#callback-client-secret-literal').count() === 0);
  await page.fill('#callback-token-url', 'https://provider.example/oauth/token');
  await page.fill('#callback-client-id', 'probe-client');
  await page.selectOption('#callback-client-secret-secret', SECRET_ID);
  check('callback: selected secret shows the Secret badge',
    await page.locator('[data-value-source-selected="secret_ref"]').first().isVisible());
  await page.fill('#callback-approved-origins', 'https://receiver.example');
  await page.getByRole('button', { name: 'Save extract' }).click();
  await page.getByText(/saved \(revision/).waitFor({ timeout: 15000 });
  const writesResponse = await fetch(`${STUB}/__stub/writes`);
  const writes = (await writesResponse.json()).writes;
  const upsert = writes.filter((write) => write.action === 'profile.upsert').pop();
  const callbackPolicy = upsert && upsert.params && upsert.params.policy && upsert.params.policy.callbackPolicy;
  check('callback: oauth2 policy stores a secret reference, not a value',
    callbackPolicy && callbackPolicy.version === 1
    && callbackPolicy.mode === 'notification_only'
    && callbackPolicy.auth && callbackPolicy.auth.method === 'oauth2_client_credentials'
    && callbackPolicy.auth.clientSecretRef && callbackPolicy.auth.clientSecretRef.kind === 'managed-secret'
    && callbackPolicy.auth.clientSecretRef.ref === SECRET_ID);
  check('callback: upsert body contains no literal secret material',
    !JSON.stringify(writes).includes(SENTINEL) && !JSON.stringify(writes).includes(SENTINEL_ROTATE));
  await page.screenshot({ path: `${EVIDENCE}/03-profile-callback-oauth2.png`, fullPage: true });

  // Configured headers path (the save reloads the persisted draft, so
  // re-enable the policy on the reloaded revision first).
  await page.getByRole('checkbox', { name: /Configure a callback policy/ }).waitFor({ timeout: 15000 });
  await page.getByRole('checkbox', { name: /Configure a callback policy/ }).check();
  await page.getByLabel('Callback authentication').selectOption('configured_headers');
  await page.locator('#callback-header-name-0').fill('X-Api-Key');
  await page.locator('#callback-header-prefix-0').fill('Bearer ');
  await page.selectOption('#callback-header-secret-0-secret', SECRET_ID);
  await page.fill('#callback-approved-origins', 'https://receiver.example');
  await page.getByRole('button', { name: 'Save extract' }).click();
  await page.getByText(/saved \(revision/).waitFor({ timeout: 15000 });
  const writes2 = (await (await fetch(`${STUB}/__stub/writes`)).json()).writes;
  const upsert2 = writes2.filter((write) => write.action === 'profile.upsert').pop();
  const policy2 = upsert2 && upsert2.params && upsert2.params.policy && upsert2.params.policy.callbackPolicy;
  check('callback: configured_headers stores header + secret reference',
    policy2 && policy2.auth && policy2.auth.method === 'configured_headers'
    && policy2.auth.headers && policy2.auth.headers[0]
    && policy2.auth.headers[0].name === 'X-Api-Key'
    && policy2.auth.headers[0].secretRef && policy2.auth.headers[0].secretRef.ref === SECRET_ID
    && policy2.auth.headers[0].prefix === 'Bearer ');
  await page.screenshot({ path: `${EVIDENCE}/04-profile-callback-headers.png`, fullPage: true });

  check('probe: no page/console errors beyond expected BFF 404s', consoleErrors.length === 0, consoleErrors.join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\nSC-03/CB-04 browser probe: ALL CHECKS PASSED' : `\nSC-03/CB-04 browser probe: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('PROBE CRASHED', error);
  process.exit(1);
});
