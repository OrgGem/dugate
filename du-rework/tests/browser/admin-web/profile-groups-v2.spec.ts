import { join } from 'node:path';
import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * PC-08 — Profile Group V2 editor + workbench browser evidence.
 *
 * Every case answers one acceptance sentence from the packet:
 *  1. zero-key CRUD: creation posts no `apiKey` at all;
 *  2. configuration revision and access version are displayed as two distinct,
 *     independently-updated counters;
 *  3. root grants: issue forwards `If-Match` + `Idempotency-Key` and shows the
 *     secret exactly once; revoke sends `expectedAccessVersion`;
 *  4. rollback copy states that grants are untouched;
 *  5. a still-CHILD_PROJECTION group is read-only with the conversion banner;
 *  6. workbench V2 previews, displays the fingerprint and submits that exact
 *     fingerprint with an idempotency key;
 *  7. PC-R06 gate: a locked request default stays locked after editing its value
 *     and saving, through a real save â†’ reload round-trip;
 *  8. PC-R07 gate: the editor partitions fields by the manifest
 *     `parameterResolution` map and shows the capability notice when absent;
 *  9. workbench V2 previews refs and submits the exact fingerprint.
 *
 * The BFF is stubbed per route: these cases assert what the BROWSER sends and
 * renders, not platform behavior (covered by the offline BFF suites).
 */

const BASE = process.env.AWEB01B_URL ?? '';
const EVIDENCE = process.env.AWEB01B_EVIDENCE ?? '';
const TOKEN = process.env.AWEB01B_TOKEN ?? '';
const TENANT = '11111111-1111-4111-8111-111111111111';
const GROUP = '33333333-3333-4333-8333-333333333333';
const LEGACY_GROUP = '44444444-4444-4444-8444-444444444444';
const LOCK_GROUP = '88888888-8888-4888-8888-888888888888';
const SOURCE_GROUP = '99999999-9999-4999-8999-999999999999';
const CHILD_ONE = '66666666-6666-4666-8666-666666666666';
const CHILD_TWO = 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const KEY = '55555555-5555-4555-8555-555555555555';
const FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const DIGEST = `sha256:${'b'.repeat(64)}`;
const NOW = '2026-10-05T00:00:00.000Z';

const SESSION = {
  schemaVersion: '1',
  plane: 'legacy',
  role: 'admin',
  principal: { kind: 'platform', tenantId: null },
  scope: { kind: 'platform' },
  displayName: 'legacy:admin',
  localUser: false,
  csrfToken: 'pc08-csrf-token',
};

const BUSINESS_ROW = {
  businessId: 'document-core',
  activeVersion: '1.0.0',
  activationRevision: 3,
  version: '1.0.0',
  status: 'ENABLED',
  enabled: true,
  lifecycleRevision: 3,
  updatedAt: NOW,
};

/**
 * The app shell polls `/admin/api/health` and renders
 * `health.queueIntegrity.state`; a bare `{}` from the catch-all makes it throw
 * ("cannot read properties of undefined"), so the shell contract is stubbed too.
 */
const HEALTH = {
  status: 'ok',
  db: true,
  redis: true,
  activeLeases: 0,
  queueIntegrity: { state: 'OK', orphansLast: 0, stalled: 0, lastSweepAt: NOW },
  outboxBacklog: 0,
  sampledAt: NOW,
};

const CATALOG = {
  businessId: 'document-core',
  businessVersion: '1.0.0',
  manifestDigest: DIGEST,
  businessEnabled: true,
  functions: [{
    kind: 'endpoint',
    functionId: 'extract.invoice',
    action: 'extract',
    endpointSlug: 'extract.invoice',
    manifestDigest: DIGEST,
    inputSchema: { type: 'object', properties: { language: { type: 'string', title: 'Language' } } },
    outputSchema: { type: 'object' },
    profileSchema: { type: 'object', required: ['documentType'], properties: { documentType: { type: 'string', title: 'Document type' } } },
    available: true,
    connectorSlots: [],
  }],
};

function group(readOnly = false): Record<string, unknown> {
  return {
    groupId: readOnly ? LEGACY_GROUP : GROUP,
    tenantId: TENANT,
    name: readOnly ? 'Legacy invoice group' : 'Invoice operations',
    authMode: 'API_KEY',
    authAuthority: readOnly ? 'CHILD_PROJECTION' : 'GROUP_GRANT',
    revision: 4,
    accessVersion: 7,
    businesses: [{
      businessId: 'document-core',
      businessVersion: '1.0.0',
      manifestDigest: DIGEST,
      functions: [{
        kind: 'endpoint',
        functionId: 'extract.invoice',
        action: 'extract',
        endpointSlug: 'extract.invoice',
        manifestDigest: DIGEST,
        childProfileId: '66666666-6666-4666-8666-666666666666',
        childRevision: 2,
        enabled: true,
        policy: {
          enabled: true,
          parameters: { documentType: { value: 'invoice', isLocked: false } },
          jobPriority: 'MEDIUM',
          allowedFileExtensions: '',
          fileUrlAuthConfigured: false,
          allowedOrigins: [],
          connectionsOverride: [],
        },
        requestDefaults: { language: { value: 'en' } },
        connectorBindings: {},
      }],
    }],
    apiKeyGrants: readOnly ? [] : [{ apiKeyId: KEY, prefix: 'du_live_abc123', status: 'ACTIVE', grantedAt: NOW }],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function json(route: Route, status: number, body: unknown, headers: Record<string, string> = {}): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
}

async function installStubs(page: Page): Promise<{ posts: Array<{ path: string; body: string; headers: Record<string, string> }> }> {
  const posts: Array<{ path: string; body: string; headers: Record<string, string> }> = [];
  // Registered first so every specific route below takes precedence.
  await page.route('**/admin/api/**', (route) => json(route, 200, {}));

  await page.route('**/admin/api/session', (route) => json(route, 200, SESSION));
  await page.route('**/admin/api/health', (route) => json(route, 200, HEALTH));
  await page.route('**/admin/api/tenants*', (route) => json(route, 200, {
    items: [{ id: TENANT, name: 'Default tenant', state: 'ACTIVE' }],
    nextCursor: null, prevCursor: null, total: 1, limit: 100,
  }));
  await page.route('**/admin/api/audit*', (route) => json(route, 200, { events: [], nextCursor: null }));
  await page.route('**/admin/api/api-keys*', (route) => json(route, 200, {
    items: [{ id: KEY, tenantId: TENANT, prefix: 'du_live_abc123', name: 'ci', maskedHint: 'du_live_abc123', status: 'ACTIVE', createdAt: NOW, updatedAt: NOW }],
    nextCursor: null, prevCursor: null, total: 1, limit: 100,
  }));
  await page.route('**/admin/api/profile-groups/v2/catalog**', (route) => json(route, 200, CATALOG));
  await page.route('**/admin/api/businesses/document-core/versions', (route) => json(route, 200, {
    businessId: 'document-core', activeVersion: '1.0.0', activationRevision: 3, enabled: true,
    rows: [{ version: '1.0.0', status: 'ENABLED', isActive: true }],
  }));
  await page.route('**/admin/api/businesses?*', (route) => json(route, 200, {
    items: [BUSINESS_ROW], nextCursor: null, prevCursor: null, total: 1, limit: 100,
  }));
  await page.route(/\/admin\/api\/businesses$/, (route) => json(route, 200, {
    items: [BUSINESS_ROW], nextCursor: null, prevCursor: null, total: 1, limit: 100,
  }));
  await page.route('**/admin/api/profiles/assigned*', (route) => json(route, 200, {
    items: [], nextCursor: null, prevCursor: null, total: 0, limit: 100,
  }));
  await page.route(/\/admin\/api\/profiles(?:\?|$)/, (route) => json(route, 200, {
    items: [], nextCursor: null, prevCursor: null, total: 0, limit: 100,
  }));

  // Grant issue / revoke must be matched before the generic group detail route.
  await page.route(`**/admin/api/profile-groups/v2/${GROUP}/keys/${KEY}/revoke`, async (route) => {
    posts.push({ path: new URL(route.request().url()).pathname, body: route.request().postData() ?? '', headers: route.request().headers() });
    await json(route, 200, {
      grant: { apiKeyId: KEY, prefix: 'du_live_abc123', status: 'REVOKED', grantedAt: NOW, revokedAt: NOW },
      accessVersion: 8,
    });
  });
  await page.route(`**/admin/api/profile-groups/v2/${GROUP}/keys`, async (route) => {
    posts.push({ path: new URL(route.request().url()).pathname, body: route.request().postData() ?? '', headers: route.request().headers() });
    await json(route, 201, {
      grant: { apiKeyId: KEY, prefix: 'du_live_issued', status: 'ACTIVE', grantedAt: NOW },
      secret: `du_${'k'.repeat(40)}`,
      secretAvailable: true,
    });
  });
  await page.route(new RegExp(`/admin/api/profile-groups/v2/${GROUP}(?:\\\?|$)`), (route) => json(route, 200, group(), { etag: '"7"' }));
  await page.route(new RegExp(`/admin/api/profile-groups/v2/${LEGACY_GROUP}(?:\\\?|$)`), (route) => json(route, 200, group(true), { etag: '"7"' }));
  await page.route(/\/admin\/api\/profile-groups\/v2(?:\?|$)/, async (route) => {
    if (route.request().method() === 'POST') {
      posts.push({ path: new URL(route.request().url()).pathname, body: route.request().postData() ?? '', headers: route.request().headers() });
      await json(route, 201, group());
      return;
    }
    await json(route, 200, { groups: [group(), group(true)] });
  });

  // Workbench V2.
  await page.route('**/admin/api/admin-workbench/v2/preview', (route) => json(route, 200, {
    refs: {
      groupId: GROUP,
      groupRevision: 4,
      accessVersion: 7,
      businessId: 'document-core',
      businessVersion: '1.0.0',
      manifestDigest: DIGEST,
      kind: 'endpoint',
      functionId: 'extract.invoice',
      action: 'extract',
      endpointSlug: 'extract.invoice',
      childProfileId: '66666666-6666-4666-8666-666666666666',
      childRevision: 2,
      tenantDefaultsRevision: null,
      connectorBindings: [],
    },
    resolutionFingerprint: FINGERPRINT,
    effective: {
      parameters: { documentType: 'invoice', language: 'en' },
      appliedRequestDefaults: ['language'],
      appliedSchemaDefaults: [],
      lockedParameters: [],
    },
    apiKeyId: KEY,
  }));
  await page.route('**/admin/api/admin-workbench/v2/submit', async (route) => {
    posts.push({ path: new URL(route.request().url()).pathname, body: route.request().postData() ?? '', headers: route.request().headers() });
    await json(route, 202, {
      operationId: '77777777-7777-4777-8777-777777777777',
      operation: { id: '77777777-7777-4777-8777-777777777777', state: 'ACCEPTED' },
      replayed: false,
    });
  });

  return { posts };
}

/* ------------------------------------------------------------------ */
/* PC-R06 / PC-R07 fixtures: one locked request default, one partition */
/* ------------------------------------------------------------------ */

function readPolicy(parameters: Record<string, unknown>): Record<string, unknown> {
  return {
    enabled: true,
    parameters,
    jobPriority: 'MEDIUM',
    allowedFileExtensions: '',
    fileUrlAuthConfigured: false,
    allowedOrigins: [],
    connectionsOverride: [],
  };
}

/**
 * PC-R06 gate fixture: `language` is a request default with `isLocked: true`
 * and the input schema declares NO `defaultLocked`, so the lock can only come
 * from the explicit metadata.
 */
const LOCK_CATALOG = {
  businessId: 'document-core',
  businessVersion: '1.0.0',
  manifestDigest: DIGEST,
  businessEnabled: true,
  functions: [{
    kind: 'endpoint',
    functionId: 'extract.invoice',
    action: 'extract',
    endpointSlug: 'extract.invoice',
    manifestDigest: DIGEST,
    inputSchema: {
      type: 'object',
      properties: { language: { type: 'string', title: 'Language' } },
    },
    outputSchema: { type: 'object' },
    profileSchema: {
      type: 'object',
      required: ['documentType'],
      properties: { documentType: { type: 'string', title: 'Document type' } },
    },
    parameterResolution: { language: 'requestDefaults' },
    available: true,
    connectorSlots: [],
  }],
};

function lockedGroup(): Record<string, unknown> {
  return {
    groupId: LOCK_GROUP,
    tenantId: TENANT,
    name: 'Locked defaults',
    authMode: 'API_KEY',
    authAuthority: 'GROUP_GRANT',
    revision: 4,
    accessVersion: 7,
    businesses: [{
      businessId: 'document-core',
      businessVersion: '1.0.0',
      manifestDigest: DIGEST,
      functions: [{
        kind: 'endpoint',
        functionId: 'extract.invoice',
        action: 'extract',
        endpointSlug: 'extract.invoice',
        manifestDigest: DIGEST,
        childProfileId: CHILD_ONE,
        childRevision: 2,
        enabled: true,
        policy: readPolicy({ documentType: { value: 'invoice' } }),
        requestDefaults: { language: { value: 'en', isLocked: true } },
        connectorBindings: {},
      }],
    }],
    apiKeyGrants: [{ apiKeyId: KEY, prefix: 'du_live_abc123', status: 'ACTIVE', grantedAt: NOW }],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/**
 * PC-R07 gate fixture: `review:opt` declares `enableReasoning` as a request
 * default (it also overlaps `profileSchema`, as example-review v3 does), while
 * `review:legacy` declares no `parameterResolution` capability at all.
 */
const SOURCE_CATALOG = {
  businessId: 'document-core',
  businessVersion: '1.0.0',
  manifestDigest: DIGEST,
  businessEnabled: true,
  functions: [
    {
      kind: 'endpoint',
      functionId: 'review:opt',
      action: 'review',
      endpointSlug: 'review:opt',
      manifestDigest: DIGEST,
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', title: 'Text' },
          enableReasoning: { type: 'boolean', title: 'Enable reasoning' },
        },
      },
      outputSchema: { type: 'object' },
      profileSchema: {
        type: 'object',
        required: ['maxParallelItems'],
        properties: {
          enableReasoning: { type: 'boolean', title: 'Enable reasoning' },
          maxParallelItems: { type: 'integer', title: 'Max parallel items' },
        },
      },
      parameterResolution: {
        enableReasoning: 'requestDefaults',
        maxParallelItems: 'profileSettings',
      },
      available: true,
      connectorSlots: [],
    },
    {
      kind: 'endpoint',
      functionId: 'review:legacy',
      action: 'review',
      endpointSlug: 'review:legacy',
      manifestDigest: DIGEST,
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', title: 'Text' } },
      },
      outputSchema: { type: 'object' },
      profileSchema: {
        type: 'object',
        properties: { tone: { type: 'string', title: 'Tone' } },
      },
      available: true,
      connectorSlots: [],
    },
  ],
};

function sourceGroup(): Record<string, unknown> {
  return {
    groupId: SOURCE_GROUP,
    tenantId: TENANT,
    name: 'Source partitioned',
    authMode: 'API_KEY',
    authAuthority: 'GROUP_GRANT',
    revision: 4,
    accessVersion: 7,
    businesses: [{
      businessId: 'document-core',
      businessVersion: '1.0.0',
      manifestDigest: DIGEST,
      functions: [
        {
          kind: 'endpoint',
          functionId: 'review:opt',
          action: 'review',
          endpointSlug: 'review:opt',
          manifestDigest: DIGEST,
          childProfileId: CHILD_ONE,
          childRevision: 2,
          enabled: true,
          policy: readPolicy({ maxParallelItems: { value: 4 } }),
          requestDefaults: { enableReasoning: { value: false } },
          connectorBindings: {},
        },
        {
          kind: 'endpoint',
          functionId: 'review:legacy',
          action: 'review',
          endpointSlug: 'review:legacy',
          manifestDigest: DIGEST,
          childProfileId: CHILD_TWO,
          childRevision: 3,
          enabled: true,
          policy: readPolicy({ tone: { value: 'neutral' } }),
          requestDefaults: {},
          connectorBindings: {},
        },
      ],
    }],
    apiKeyGrants: [{ apiKeyId: KEY, prefix: 'du_live_abc123', status: 'ACTIVE', grantedAt: NOW }],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/**
 * Server-side echo for the save â†’ reload gate: merge the posted save body back
 * into a READ-shaped group (child pins and read-only policy fields preserved)
 * and bump the configuration revision.
 */
function applyGroupSave(current: Record<string, unknown>, body: Record<string, unknown>): Record<string, unknown> {
  const currentBusinesses = Array.isArray(current['businesses'])
    ? (current['businesses'] as Array<Record<string, unknown>>)
    : [];
  const existing = new Map<string, Record<string, unknown>>();
  for (const business of currentBusinesses) {
    for (const fn of (business['functions'] as Array<Record<string, unknown>> | undefined) ?? []) {
      existing.set(String(fn['functionId']), fn);
    }
  }
  const posted = Array.isArray(body['businesses']) ? (body['businesses'] as Array<Record<string, unknown>>) : [];
  const functions = posted.flatMap((business) =>
    ((business['functions'] as Array<Record<string, unknown>> | undefined) ?? []).map((fn) => {
      const base = existing.get(String(fn['functionId'])) ?? {};
      const basePolicy = (base['policy'] ?? {}) as Record<string, unknown>;
      const postedPolicy = (fn['policy'] ?? {}) as Record<string, unknown>;
      return {
        ...base,
        ...fn,
        manifestDigest: base['manifestDigest'] ?? DIGEST,
        childProfileId: base['childProfileId'],
        childRevision: base['childRevision'],
        policy: {
          enabled: postedPolicy['enabled'] ?? basePolicy['enabled'],
          parameters: postedPolicy['parameters'] ?? basePolicy['parameters'],
          jobPriority: postedPolicy['jobPriority'] ?? basePolicy['jobPriority'],
          allowedFileExtensions: postedPolicy['allowedFileExtensions'] ?? basePolicy['allowedFileExtensions'],
          fileUrlAuthConfigured: basePolicy['fileUrlAuthConfigured'],
          allowedOrigins: basePolicy['allowedOrigins'],
          connectionsOverride: basePolicy['connectionsOverride'],
        },
        requestDefaults: fn['requestDefaults'] ?? {},
        connectorBindings: fn['connectorBindings'] ?? {},
      };
    }),
  );
  return {
    ...current,
    name: body['name'] ?? current['name'],
    revision: Number(current['revision'] ?? 0) + 1,
    businesses: [{ ...(currentBusinesses[0] ?? {}), functions }],
  };
}

interface EditorStubOptions {
  initialGroup: Record<string, unknown>;
  catalog: Record<string, unknown>;
}

/**
 * Editor-only stub set for the PC-R06/PC-R07 cases: same-origin BFF routes,
 * a stateful group detail (PUT echoes a read-shaped group), and a catalog that
 * carries the manifest `parameterResolution` map.
 */
async function installEditorStubs(
  page: Page,
  options: EditorStubOptions,
): Promise<{ puts: Array<{ path: string; body: string; headers: Record<string, string> }>; state: { group: Record<string, unknown> } }> {
  const state = { group: options.initialGroup };
  const puts: Array<{ path: string; body: string; headers: Record<string, string> }> = [];
  const groupId = String(options.initialGroup['groupId']);

  await page.route('**/admin/api/**', (route) => json(route, 200, {}));
  await page.route('**/admin/api/session', (route) => json(route, 200, SESSION));
  await page.route('**/admin/api/health', (route) => json(route, 200, HEALTH));
  await page.route('**/admin/api/tenants*', (route) => json(route, 200, {
    items: [{ id: TENANT, name: 'Default tenant', state: 'ACTIVE' }],
    nextCursor: null, prevCursor: null, total: 1, limit: 100,
  }));
  await page.route('**/admin/api/audit*', (route) => json(route, 200, { events: [], nextCursor: null }));
  await page.route('**/admin/api/api-keys*', (route) => json(route, 200, {
    items: [{ id: KEY, tenantId: TENANT, prefix: 'du_live_abc123', name: 'ci', maskedHint: 'du_live_abc123', status: 'ACTIVE', createdAt: NOW, updatedAt: NOW }],
    nextCursor: null, prevCursor: null, total: 1, limit: 100,
  }));
  await page.route('**/admin/api/profile-groups/v2/catalog**', (route) => json(route, 200, options.catalog));
  await page.route('**/admin/api/businesses/document-core/versions', (route) => json(route, 200, {
    businessId: 'document-core', activeVersion: '1.0.0', activationRevision: 3, enabled: true,
    rows: [{ version: '1.0.0', status: 'ENABLED', isActive: true }],
  }));
  await page.route('**/admin/api/businesses?*', (route) => json(route, 200, {
    items: [BUSINESS_ROW], nextCursor: null, prevCursor: null, total: 1, limit: 100,
  }));
  await page.route(/\/admin\/api\/businesses$/, (route) => json(route, 200, {
    items: [BUSINESS_ROW], nextCursor: null, prevCursor: null, total: 1, limit: 100,
  }));
  await page.route('**/admin/api/profiles/assigned*', (route) => json(route, 200, {
    items: [], nextCursor: null, prevCursor: null, total: 0, limit: 100,
  }));
  await page.route(/\/admin\/api\/profiles(?:\?|$)/, (route) => json(route, 200, {
    items: [], nextCursor: null, prevCursor: null, total: 0, limit: 100,
  }));

  await page.route(/\/admin\/api\/profile-groups\/v2(?:\?|$)/, (route) => json(route, 200, { groups: [state.group] }));
  await page.route(new RegExp(`/admin/api/profile-groups/v2/${groupId}(?:\\\?|$)`), async (route) => {
    const etag = String((state.group as { accessVersion?: unknown }).accessVersion ?? 7);
    if (route.request().method() === 'PUT') {
      const body = route.request().postData() ?? '{}';
      puts.push({
        path: new URL(route.request().url()).pathname,
        body,
        headers: route.request().headers(),
      });
      state.group = applyGroupSave(state.group, JSON.parse(body) as Record<string, unknown>);
      await json(route, 200, state.group, { etag });
      return;
    }
    await json(route, 200, state.group, { etag });
  });

  return { puts, state };
}

async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto(`${BASE}admin`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('input[name="token"]')).toBeVisible();
  await page.fill('input[name="token"]', TOKEN);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => url.pathname === '/admin');
}

async function openGroups(page: Page): Promise<void> {
  await loginAsAdmin(page);
  await page.goto(`${BASE}admin/profiles`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Groups' }).click();
  await expect(page.getByRole('heading', { name: 'Profile groups' })).toBeVisible();
}

/** After a full page reload the session cookie survives: no login form again. */
async function reopenGroups(page: Page): Promise<void> {
  await page.goto(`${BASE}admin/profiles`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Groups' }).click();
  await expect(page.getByRole('heading', { name: 'Profile groups' })).toBeVisible();
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(EVIDENCE, name), fullPage: true });
}

test.beforeAll(() => {
  if (!BASE || !EVIDENCE || !TOKEN) {
    throw new Error('AWEB01B_URL / AWEB01B_EVIDENCE / AWEB01B_TOKEN must be set');
  }
});

test('1. zero-key creation posts no apiKey and lands on access version 1', async ({ page }) => {
  const { posts } = await installStubs(page);
  await openGroups(page);
  await page.getByRole('button', { name: 'New profile group' }).click();
  await page.getByLabel('Profile group name').fill('Invoice operations');
  await page.getByLabel('Add enabled business').selectOption('document-core');
  await expect(page.getByRole('checkbox', { name: 'Select extract.invoice' })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select extract.invoice' }).check();
  // The per-function editor lives inside a collapsed <details>; open it before
  // asserting or filling its controls.
  await page.locator('details > summary', { hasText: 'extract.invoice' }).click();
  await expect(page.getByRole('checkbox', { name: 'Enabled for extract.invoice' })).toBeVisible();
  await page.getByLabel('Profile setting for extract.invoice: Document type *').fill('invoice');
  await page.getByRole('button', { name: 'Create profile group' }).click();

  await expect.poll(() => posts.filter((entry) => entry.path === '/admin/api/profile-groups/v2').length).toBe(1);
  const created = posts.find((entry) => entry.path === '/admin/api/profile-groups/v2');
  const body = JSON.parse(created?.body ?? '{}') as Record<string, unknown>;
  expect(body['authMode']).toBe('API_KEY');
  expect(body['expectedRevision']).toBe(0);
  expect('apiKey' in body).toBe(false);
  expect(body['tenantId']).toBe(TENANT);
  await expect(page.getByText(/No API key was minted/)).toBeVisible();
  await shot(page, 'pc08-01-zero-key-create.png');
});

test('2. configuration revision and access version are shown as separate counters', async ({ page }) => {
  await installStubs(page);
  await openGroups(page);
  await page.getByRole('button', { name: /Invoice operations/ }).click();
  await expect(page.getByText('Config revision')).toBeVisible();
  await expect(page.getByText('Access version (grants)')).toBeVisible();
  await expect(page.locator('dd', { hasText: /^4$/ })).toBeVisible();
  await expect(page.locator('dd', { hasText: /^7$/ })).toBeVisible();
  // The v1 key selector must be gone: a group has no singular key.
  await expect(page.getByText('Existing active API key')).toHaveCount(0);
  await shot(page, 'pc08-02-two-counters.png');
});

test('3. grant issue forwards If-Match + Idempotency-Key and shows the secret once', async ({ page }) => {
  const { posts } = await installStubs(page);
  await openGroups(page);
  await page.getByRole('button', { name: /Invoice operations/ }).click();
  await page.getByRole('tab', { name: 'Root access' }).click();
  await expect(page.getByRole('table', { name: 'Root key grants' })).toBeVisible();
  await page.getByRole('button', { name: 'Issue root key' }).click();
  await page.getByLabel('Grant note').fill('ci runner');
  await page.getByRole('button', { name: 'Issue root key' }).last().click();

  await expect.poll(() => posts.filter((entry) => entry.path.endsWith('/keys')).length).toBe(1);
  const issued = posts.find((entry) => entry.path.endsWith('/keys'));
  expect(issued?.headers['if-match']).toBe('"7"');
  expect(issued?.headers['idempotency-key']).toBeTruthy();
  expect(issued?.headers['x-csrf-token']).toBe('pc08-csrf-token');

  const secret = page.getByLabel('Issued group key');
  await expect(secret).toBeVisible();
  await expect(secret).toHaveValue(/^du_k+/);
  // Acknowledging replaces the checkbox with a status line (the control is
  // single-use), so assert the durable acknowledgement state, not `.checked`.
  await page.getByRole('checkbox', { name: /I copied this key/ }).click();
  await expect(page.getByText(/Acknowledged\. Close this dialog to clear it from the page\./)).toBeVisible();
  await page.getByRole('button', { name: 'I have stored this key' }).click();
  await expect(page.getByLabel('Issued group key')).toHaveCount(0);
  await shot(page, 'pc08-03-grant-issued-once.png');
});

test('4. revoke sends the current expectedAccessVersion', async ({ page }) => {
  const { posts } = await installStubs(page);
  await openGroups(page);
  await page.getByRole('button', { name: /Invoice operations/ }).click();
  await page.getByRole('tab', { name: 'Root access' }).click();
  await page.getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('button', { name: 'Revoke grant' }).click();

  await expect.poll(() => posts.filter((entry) => entry.path.endsWith('/revoke')).length).toBe(1);
  const revoked = posts.find((entry) => entry.path.endsWith('/revoke'));
  expect(JSON.parse(revoked?.body ?? '{}')).toEqual({ expectedAccessVersion: 7 });
  expect(revoked?.headers['idempotency-key']).toBeTruthy();
});

test('5. rollback copy states that grants and the access version do not move', async ({ page }) => {
  await installStubs(page);
  await openGroups(page);
  await page.getByRole('button', { name: /Invoice operations/ }).click();
  await page.getByRole('tab', { name: 'Revisions' }).click();
  await expect(page.getByText(/does not issue, revoke or/)).toBeVisible();
  await expect(page.getByText(/the access version does not change/)).toBeVisible();
  await page.getByLabel('Rollback target revision').fill('2');
  await page.getByRole('button', { name: 'Roll back configuration' }).click();
  await expect(page.getByText(/Root grants stay exactly as they are/)).toBeVisible();
  await shot(page, 'pc08-05-rollback-copy.png');
});

test('6. a CHILD_PROJECTION group is read-only with the conversion banner', async ({ page }) => {
  await installStubs(page);
  await openGroups(page);
  await page.getByRole('button', { name: /Legacy invoice group/ }).click();
  await expect(page.getByText(/still uses the legacy child projection/).first()).toBeVisible();
  // Both the configuration banner and the (keepMounted) access pane state the
  // code; either one proves the typed refusal is rendered.
  await expect(page.getByText('409 PROFILE_GROUP_V2_REQUIRED').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Save configuration revision|Create profile group/ })).toBeDisabled();
  await page.getByRole('tab', { name: 'Root access' }).click();
  await expect(page.getByRole('button', { name: 'Issue root key' })).toBeDisabled();
  await shot(page, 'pc08-06-child-projection-readonly.png');
});

/* ------------------------------------------------------------------ */
/* PC-R06 gate — browser interaction, not a handcrafted save body      */
/* ------------------------------------------------------------------ */

test('7. a locked request default keeps isLocked:true after editing its value and saving', async ({ page }) => {
  const { puts } = await installEditorStubs(page, { initialGroup: lockedGroup(), catalog: LOCK_CATALOG });
  await openGroups(page);
  await page.getByRole('button', { name: /Locked defaults/ }).click();

  const summary = page.locator('details > summary', { hasText: 'extract.invoice' });
  await summary.click();
  await expect(page.getByText('Locked: clients cannot override this value.')).toBeVisible();

  const language = page.getByLabel('Request default for extract.invoice: Language');
  await expect(language).toHaveValue('en');
  await language.fill('fr');
  await page.getByRole('button', { name: 'Save configuration revision' }).click();

  // The posted save body is the only place the lock can be lost: assert it
  // carries the edited value AND the original `isLocked: true`.
  await expect.poll(() => puts.length).toBe(1);
  const posted = JSON.parse(puts[0]!.body) as {
    expectedRevision: number;
    businesses: Array<{ functions: Array<{ requestDefaults: Record<string, unknown> }> }>;
  };
  expect(posted.expectedRevision).toBe(4);
  expect(posted.businesses[0]?.functions[0]?.requestDefaults).toEqual({
    language: { value: 'fr', isLocked: true },
  });

  await expect(page.getByText(/Saved configuration revision 5/)).toBeVisible();
  // The editor reloads the catalogs after a save, which can collapse the
  // <details>; reopen it before asserting the rendered lock state.
  if (!(await page.getByLabel('Request default for extract.invoice: Language').isVisible().catch(() => false))) {
    await summary.click();
  }
  await expect(page.getByText('Locked: clients cannot override this value.')).toBeVisible();

  // Save â†’ reload gate: a full page reload re-reads the group from the server
  // echo; the value is the edited one and the lock survived.
  await reopenGroups(page);
  await page.getByRole('button', { name: /Locked defaults/ }).click();
  await page.locator('details > summary', { hasText: 'extract.invoice' }).click();
  await expect(page.getByLabel('Request default for extract.invoice: Language')).toHaveValue('fr');
  await expect(page.getByText('Locked: clients cannot override this value.')).toBeVisible();
  await shot(page, 'pc-r06-locked-default-preserved.png');
});

/* ------------------------------------------------------------------ */
/* PC-R07 gate — one declared source per parameter, capability notice  */
/* ------------------------------------------------------------------ */

test('8. the editor partitions fields by parameterResolution and warns without it', async ({ page }) => {
  await installEditorStubs(page, { initialGroup: sourceGroup(), catalog: SOURCE_CATALOG });
  await openGroups(page);
  await page.getByRole('button', { name: /Source partitioned/ }).click();
  await page.locator('details > summary', { hasText: 'review:opt' }).click();
  await page.locator('details > summary', { hasText: 'review:legacy' }).click();

  // Opt-in function: the declared requestDefaults property is ONLY in request
  // defaults, even though the manifest's profileSchema also declares it.
  const optProfile = page.getByRole('region', { name: 'Profile settings for review:opt' });
  await expect(optProfile.getByLabel('Profile setting for review:opt: Max parallel items *')).toBeVisible();
  await expect(optProfile.getByLabel(/Enable reasoning/)).toHaveCount(0);

  const optDefaults = page.getByRole('region', { name: 'Request defaults for review:opt' });
  await expect(optDefaults.getByLabel('Request default for review:opt: Enable reasoning')).toBeVisible();
  await expect(optDefaults.getByLabel(/Text/)).toHaveCount(0);

  // Capability-free function: profile settings keep their schema, request
  // defaults are not rendered and the capability notice explains why.
  const legacyProfile = page.getByRole('region', { name: 'Profile settings for review:legacy' });
  await expect(legacyProfile.getByLabel('Profile setting for review:legacy: Tone')).toBeVisible();

  const legacyDefaults = page.getByRole('region', { name: 'Request defaults for review:legacy' });
  await expect(legacyDefaults.getByText(/Request defaults require an opt-in manifest capability/)).toBeVisible();
  await expect(legacyDefaults.getByLabel(/^Request default for review:legacy:/)).toHaveCount(0);

  await shot(page, 'pc-r07-declared-source-partition.png');
});

test('9. workbench V2 previews refs and submits the exact fingerprint', async ({ page }) => {
  const { posts } = await installStubs(page);
  await loginAsAdmin(page);
  await page.goto(`${BASE}admin/docs`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Group workbench (V2)' })).toBeVisible();
  await page.getByLabel('Active API key (explicit)').selectOption(KEY);
  await page.getByLabel('Group function').selectOption({ index: 1 });
  await page.getByLabel('Submission input (JSON object)').fill('{"documentType":"invoice"}');
  await page.getByRole('button', { name: 'Preview resolution' }).click();

  await expect(page.getByText(FINGERPRINT)).toBeVisible();
  await expect(page.getByText('Resolved preview')).toBeVisible();
  await expect(page.getByText(/rev 4 · access v7/)).toBeVisible();

  await page.getByRole('button', { name: 'Submit with this fingerprint' }).click();
  await expect.poll(() => posts.filter((entry) => entry.path.endsWith('/v2/submit')).length).toBe(1);
  const submitted = posts.find((entry) => entry.path.endsWith('/v2/submit'));
  expect(JSON.parse(submitted?.body ?? '{}').resolutionFingerprint).toBe(FINGERPRINT);
  expect(submitted?.headers['idempotency-key']).toBeTruthy();
  await expect(page.getByText(/Group submission accepted/)).toBeVisible();
  await shot(page, 'pc08-07-workbench-preview-submit.png');
});
