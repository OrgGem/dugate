import type { AddressInfo } from 'node:net';
import { createMetadataCrypto } from '../../orchestrator/services/orchestrator/src/modules/runtime/metadata-crypto';
import { adaptKeyProviderForMetadata } from '../../orchestrator/services/orchestrator/src/modules/encryption/metadata-key-adapter';
import { documentCoreManifest } from '../../businesses/document-core/src/manifest/document-core.manifest';
import { createProfileService } from '../../orchestrator/services/orchestrator/src/modules/profiles/profiles';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser } from '../browser/node_modules/@playwright/test';
import { createApp, type App } from '../../orchestrator/services/orchestrator/src/server';
import { createDb } from '../../orchestrator/services/orchestrator/src/db/db';
import { signCookie } from '../../orchestrator/services/orchestrator/src/app/admin/shell-auth';
import { createWorkflowApiIsolation, syntheticMetadataKeyProvider } from './isolation';

const isolation = createWorkflowApiIsolation();
const baseDb = createDb(isolation.baseDatabaseUrl);
const cookieSecret = `orv11-vfy-${randomUUID()}`;
const tenantId = randomUUID();
const apiKeyId = randomUUID();
const connectionId = randomUUID();
const outputDir = resolve('reports/raw/orv11/browser');
let app: App | undefined;
let browser: Browser | undefined;
let schemaCreated = false;

beforeAll(async () => {
  mkdirSync(outputDir, { recursive: true });
  process.env.DU_SEED_DEV_FALLBACK = 'false';
  process.env.DU_ADMIN_WEB = '1';
  process.env.DU_ADMIN_WEB_DIST = resolve('orchestrator/apps/admin-web/dist');
  await baseDb.query(`CREATE SCHEMA "${isolation.context.dbSchema}"`);
  schemaCreated = true;
  app = await createApp({
    host: '127.0.0.1', port: 0, internalHost: '127.0.0.1', internalPort: 0,
    databaseUrl: isolation.databaseUrl, redisUrl: isolation.redisUrl,
    autoMigrate: true, autoDispatch: false, leaseRecoveryIntervalMs: 0,
    adminToken: `orv11-vfy-admin-${randomUUID()}`,
    adminShellCookieSecret: cookieSecret, adminShellHost: '127.0.0.1', adminShellPort: 0,
    metadataEncryption: { keyProvider: syntheticMetadataKeyProvider(), keyRef: 'du-orch-metadata-v1' },
  });
  await app.listen();
  await app.db.query('INSERT INTO tenants (id,name) VALUES ($1,$2)', [tenantId, 'ORV11 verification tenant']);
  await app.db.query("INSERT INTO api_keys (id,tenant_id,hash,prefix,status,name) VALUES ($1,$2,$3,'orv11','ACTIVE','Browser legacy key')", [apiKeyId,tenantId,createHash('sha256').update('orv11-browser-test-only').digest('hex')]);
  await app.db.query(`INSERT INTO business_versions (business_id,version,status,is_active,digest,queue,manifest) VALUES ('document-core',$1,'ENABLED',true,'orv11-browser',$2,$3)`, [documentCoreManifest.version,'orv11-browser-core',JSON.stringify(documentCoreManifest)]);
  const profile = await createProfileService(app.db).createRevision({ apiKeyHash: createHash('sha256').update('orv11-browser-test-only').digest('hex'), businessId:'document-core', businessVersion:documentCoreManifest.version, action:'extract', endpointSlug:'extract:invoice', connectorBindings:{reasoning:{connectorId:connectionId,revision:1}} });
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
}, 120000);

afterAll(async () => {
  await browser?.close();
  await app?.close({ timeoutMs: 0, pollIntervalMs: 10 });
  if (schemaCreated) await baseDb.query(`DROP SCHEMA "${isolation.context.dbSchema}" CASCADE`);
  await baseDb.close();
  isolation.context.cleanupArtifactDir();
}, 30000);

test('ORV11 live backend renders settings, workflows and operations at desktop/mobile sizes', async () => {
  if (!app?.adminShell || !browser) throw new Error('Live app/browser unavailable');
  const url = app.adminShell.url;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const cookie = signCookie(cookieSecret, { iss: 'du-admin-shell', role: 'admin', iat: Date.now(), exp: Date.now() + 300000 });
  if (!cookie) throw new Error('Synthetic cookie could not be signed');
  await context.addCookies([{ name: 'du_admin', value: cookie, url, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  const errors: string[] = [];
  const responses: { path: string; status: number }[] = [];
  const scripts: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (/assets\/index-.*\.js/.test(response.url())) scripts.push(new URL(response.url()).pathname);
    if (response.url().includes('/admin/api/')) responses.push({ path: new URL(response.url()).pathname, status: response.status() });
  });
  const screens: { route: string; viewport: string; text: string; overflow: boolean }[] = [];
  for (const route of ['settings', 'workflows', 'operations']) {
    const response = await page.goto(`${url}/admin/${route}`, { waitUntil: 'networkidle' });
    expect(response?.status()).toBe(200);
    await page.locator('#global-tenant-select').waitFor();
    await page.locator('#global-tenant-select').selectOption(tenantId);
    await page.waitForLoadState('networkidle');
    for (const [label, width] of [['desktop', 1440], ['mobile', 390]] as const) {
      await page.setViewportSize({ width, height: 1000 });
      await page.screenshot({ path: resolve(outputDir, `${route}-${label}.png`), fullPage: true });
      screens.push({ route, viewport: label, text: await page.locator('body').innerText(), overflow: await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  writeFileSync(resolve(outputDir, 'journey.json'), JSON.stringify({ scripts: [...new Set(scripts)], screens, responses, errors }, null, 2));
  expect(errors).toEqual([]);
  expect(responses.some(r => r.path === '/admin/api/tenants' && r.status === 200)).toBe(true);
  expect(screens.every(screen => !screen.overflow)).toBe(true);
  await context.close();
}, 120000);


test('ORV11 browser saves prompt setting through real BFF/action/PG and reloads persisted value', async () => {
  if (!app?.adminShell || !browser) throw new Error('Live app/browser unavailable');
  const url = app.adminShell.url;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const cookie = signCookie(cookieSecret, { iss: 'du-admin-shell', role: 'admin', iat: Date.now(), exp: Date.now() + 300000 });
  if (!cookie) throw new Error('cookie unavailable');
  await context.addCookies([{ name: 'du_admin', value: cookie, url, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  await page.goto(`${url}/admin/settings`, { waitUntil: 'networkidle' });
  await page.locator('label').filter({ hasText: /^API key/ }).locator('select').selectOption(apiKeyId);
  await page.getByRole('button', { name: 'Load current overrides', exact: true }).click();
  await page.screenshot({path:resolve(outputDir,'settings-before-connection.png'),fullPage:true});
  writeFileSync(resolve(outputDir,'settings-before-connection.txt'),await page.locator('body').innerText());
  await page.locator('label').filter({ hasText: /^Profile connection/ }).locator('select').selectOption(connectionId);
  await page.locator('label').filter({hasText:/^Prompt/}).locator('textarea').fill('ORV11 independently saved prompt');
  const action = page.waitForResponse(r => r.url().includes('/admin/api/actions') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save prompt override', exact: true }).click();
  const response = await action;
  const responseBody = await response.text();
  if(response.status() !== 200) throw new Error(`settings save ${response.status()}: ${responseBody}`);
  await page.getByText('Prompt saved.', { exact: false }).waitFor();
  const stored = await app.db.query('SELECT prompt_override FROM connector_prompt_overrides WHERE api_key_id=$1 AND connection_id=$2', [apiKeyId,connectionId]);
  expect(stored.rows[0]?.prompt_override).toBe('ORV11 independently saved prompt');
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('label').filter({ hasText: /^API key/ }).locator('select').selectOption(apiKeyId);
  await page.getByRole('button', { name: 'Load current overrides', exact: true }).click();
  await page.getByRole('button', { name: `Edit ${connectionId} / _default`, exact: true }).click();
  expect(await page.locator('label').filter({hasText:/^Prompt/}).locator('textarea').inputValue()).toBe('ORV11 independently saved prompt');
  await page.screenshot({ path: resolve(outputDir, 'settings-saved-reloaded.png'), fullPage: true });
  const audit = await app.db.query("SELECT action FROM admin_audit_events WHERE action='settings.prompt.update'");
  expect(audit.rowCount).toBe(1);
  const form=new FormData();form.append('type','invoice');form.append('text','fixture invoice');
  const publicUrl=`http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const admitted=await fetch(`${publicUrl}/api/v1/docs/extract`,{method:'POST',headers:{'x-api-key':'orv11-browser-test-only'},body:form});
  const admittedBody=await admitted.json() as {name?:string};
  expect(admitted.status).toBe(202);
  const operationId=admittedBody.name!.replace('operations/','');
  const row=await app.db.query('SELECT prompt_overrides_ref FROM operations WHERE id=$1',[operationId]);
  const crypto=createMetadataCrypto(adaptKeyProviderForMetadata(syntheticMetadataKeyProvider()),'du-orch-metadata-v1');
  const pinned=await crypto.open(row.rows[0]!.prompt_overrides_ref,{tenantId,slot:'operations.prompt_overrides_ref',refId:operationId});
  expect(JSON.stringify(pinned)).toContain('ORV11 independently saved prompt');
  expect(JSON.stringify(row.rows[0]!.prompt_overrides_ref)).not.toContain('ORV11 independently saved prompt');

  await context.close();
}, 120000);
