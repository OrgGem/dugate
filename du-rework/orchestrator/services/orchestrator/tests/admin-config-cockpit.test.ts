import { renderBusinessSection } from '../src/app/admin/business-section-renderer';
import { renderProfileSection } from '../src/app/admin/profile-section-renderer';
import { renderConnectorSection } from '../src/app/admin/connector-section-renderer';
import { renderApiKeySection } from '../src/app/admin/api-key-section-renderer';
import { fetchProfileForm } from '../src/app/admin/profile-section-data';
import { fetchConnectorConfig } from '../src/app/admin/connector-section-data';
import { buildApiKeyCreateView, buildApiKeyListView } from '../src/app/admin/api-key-view-models';
import type { BusinessVersionRow } from '../src/app/admin/business-view-models';
import type { ProfileSchemaInput } from '../src/app/admin/types';
import type { ConnectorRevisionCatalogEntry } from '../src/app/admin/connector-section-data';
import type { ApiKeyFetchResult } from '../src/app/admin/api-key-section-data';

const profileFixtures: ProfileSchemaInput[] = [
  {
    businessId: 'review',
    businessVersion: 'v1',
    manifest: { actions: [{ name: 'extract', slots: [{ name: 'source', widget: 'text', required: true }] }] },
    capabilityOptions: [],
    existingProfile: { name: 'default', revision: 1 },
  },
  {
    businessId: 'review',
    businessVersion: 'v2',
    manifest: { actions: [{ name: 'extract', slots: [{ name: 'source', widget: 'textarea' }, { name: 'mode', widget: 'select' }] }] },
    capabilityOptions: [],
    existingProfile: { name: 'default', revision: 2 },
  },
];

const connectorFixtures: ConnectorRevisionCatalogEntry[] = [
  {
    connectorId: 'review-api',
    revision: 1,
    adapter: 'rest',
    endpoint: { kind: 'https', maskedHost: 'api.example.test' },
    capabilities: ['extract'],
    state: 'enabled',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    secretSlots: [{ name: 'apiToken', label: 'API token', hasValue: true, rotatedAt: null }],
    testResult: { kind: 'success', message: 'Connection succeeded.', testedAt: '2026-01-02T00:00:00.000Z' },
    rotateState: 'idle',
  },
  {
    connectorId: 'review-api',
    revision: 2,
    adapter: 'rest-v2',
    endpoint: { kind: 'https', maskedHost: 'v2.example.test' },
    capabilities: ['extract', 'compare'],
    state: 'disabled',
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-02T00:00:00.000Z',
    secretSlots: [{ name: 'apiToken', label: 'API token', hasValue: false, rotatedAt: null }],
    testResult: { kind: 'pending', message: 'No connection test has run.', testedAt: null },
    rotateState: 'idle',
  },
];

describe('ADM-UX-06 configuration detail cockpit', () => {
  test('business versions have list links, explicit lifecycle, comparison and native action confirmation', () => {
    const rows: BusinessVersionRow[] = [
      { businessId: 'review', version: 'v1', status: 'ENABLED', isActive: true, queue: 'review-v1' },
      { businessId: 'review', version: 'v2', status: 'REGISTERED_DISABLED', queue: 'review-v2' },
      { businessId: 'review', version: 'v3', status: 'DRAINING', queue: 'review-v3' },
      { businessId: 'review', version: 'v0', status: 'RETIRED' },
    ];
    const rendered = renderBusinessSection({
      fetch: { kind: 'ok', businessId: 'review', rows, activeVersion: 'v1' },
      knownBusinessIds: ['review'],
      selectedVersion: 'v3',
      compareVersion: 'v2',
    });

    expect(rendered.html).toContain('aria-label="Business version list"');
    expect(rendered.html).toContain('/admin/businesses?businessId=review&amp;version=v2');
    expect(rendered.html).toContain('data-lifecycle="active"');
    expect(rendered.html).toContain('data-lifecycle="draft"');
    expect(rendered.html).toContain('data-lifecycle="retired"');
    expect(rendered.html).toContain('aria-label="Version comparison"');
    expect(rendered.html).toContain('onsubmit="return confirm(\'Retire this version permanently?\')"');
  });

  test('unknown selected business version renders an honest not-found state without detail data', () => {
    const rendered = renderBusinessSection({
      fetch: {
        kind: 'ok',
        businessId: 'review',
        activeVersion: 'v1',
        rows: [{ businessId: 'review', version: 'v1', status: 'ENABLED', isActive: true }],
      },
      selectedVersion: 'missing',
    });

    expect(rendered.isReady).toBe(false);
    expect(rendered.html).toContain('requested business version was not found');
    expect(rendered.html).not.toContain('data-version="missing"');
  });

  test('profiles navigate action details and compare only manifest schema metadata', async () => {
    const fetch = await fetchProfileForm({
      businessId: 'review',
      businessVersion: 'v1',
      profileName: 'default',
      jsonBaseUrl: '',
      adminToken: '',
      manifestCatalog: profileFixtures,
    });
    const compareFetch = await fetchProfileForm({
      businessId: 'review',
      businessVersion: 'v2',
      profileName: 'default',
      jsonBaseUrl: '',
      adminToken: '',
      manifestCatalog: profileFixtures,
    });
    const rendered = renderProfileSection({
      fetch,
      compareFetch,
      compareVersion: 'v2',
      knownBusinessIds: ['review'],
      selectedBusinessId: 'review',
    });

    expect(rendered.html).toContain('aria-label="Profile action list"');
    expect(rendered.html).toContain('aria-label="Profile schema comparison"');
    expect(rendered.html).toContain('data-diff="changed"');
    expect(rendered.html).toContain('data-diff="added-in-comparison"');
    expect(rendered.html).toContain('data-lifecycle="active"');
    expect(rendered.html).toContain('configured values and secrets are not shown');
  });

  test('an unknown explicit profile version does not reuse another revision fixture', async () => {
    const result = await fetchProfileForm({
      businessId: 'review',
      businessVersion: 'v99',
      profileName: 'default',
      jsonBaseUrl: '',
      adminToken: '',
      manifestCatalog: profileFixtures,
    });

    expect(result.kind).toBe('not-found');
  });

  test('connector comparison contains only credential metadata and latest test, with confirmations', async () => {
    const current = await fetchConnectorConfig({
      connectorId: 'review-api', revision: 1, jsonBaseUrl: '', adminToken: '', manifestCatalog: connectorFixtures,
    });
    const comparison = await fetchConnectorConfig({
      connectorId: 'review-api', revision: 2, jsonBaseUrl: '', adminToken: '', manifestCatalog: connectorFixtures,
    });
    const rendered = renderConnectorSection({
      fetch: current,
      compareFetch: comparison,
      compareRevision: 2,
      selectedRevision: 1,
      selectedConnectorId: 'review-api',
      knownConnectorIds: ['review-api'],
    });

    expect(rendered.html).toContain('aria-label="Connector revision comparison"');
    expect(rendered.html).toContain('data-lifecycle="active"');
    expect(rendered.html).toContain('data-secret-state="configured"');
    expect(rendered.html).toContain('<td>Not configured</td>');
    expect(rendered.html).toContain('Connection succeeded.');
    expect(rendered.html).toContain('onsubmit="return confirm(\'Rotate this credential? The current value will stop working.\')"');
    expect(rendered.html).toContain('onsubmit="return confirm(\'Run a connection test against this connector?\')"');
    expect(rendered.html).not.toContain('value="<');
  });

  test('a revision response for a different connector revision resolves as not-found', async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
      connectorId: 'review-api',
      revision: 2,
      adapter: 'rest',
      endpoint: { kind: 'https', maskedHost: 'masked.example.test' },
      state: 'enabled',
      secretSlots: [],
    }), { status: 200 });
    const result = await fetchConnectorConfig({
      connectorId: 'review-api', revision: 3, jsonBaseUrl: 'https://platform.example.test', adminToken: 'token', fetchImpl,
    });

    expect(result.kind).toBe('not-found');
  });

  test('an unknown connector catalog revision does not fall back to another revision', async () => {
    const result = await fetchConnectorConfig({
      connectorId: 'review-api', revision: 99, jsonBaseUrl: '', adminToken: '', manifestCatalog: connectorFixtures,
    });

    expect(result.kind).toBe('not-found');
  });

  test('API key detail is list-linked, revocation uses native confirmation, and copy-once view omits raw value', () => {
    const [key] = buildApiKeyListView([{
      id: 'key-1', tenantId: 'tenant-1', maskedHint: 'du_a…', prefix: 'du_a', status: 'ACTIVE',
      createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: null, label: 'CI', revokedAt: null,
    }]).rows;
    if (!key) throw new Error('fixture key missing');
    const createCopyOnce = buildApiKeyCreateView({
      id: 'key-2', tenantId: 'tenant-1', prefix: 'du_b', label: 'Deploy',
      createdAt: '2026-03-01T00:00:00.000Z', rawKey: 'du_b-this-is-the-raw-secret',
    });
    const fetch: ApiKeyFetchResult = {
      kind: 'ok', rows: [key], total: 1, selected: key, grants: [], createCopyOnce, selectedKeyId: key.id,
    };
    const rendered = renderApiKeySection({ fetch, knownKeyIds: [key.id], selectedKeyId: key.id });

    expect(rendered.html).toContain('aria-label="API key detail"');
    expect(rendered.html).toContain('data-lifecycle="active"');
    expect(rendered.html).toContain('Back to API key list');
    expect(rendered.html).toContain('onsubmit="return confirm(\'Revoke this API key? It cannot be used after revocation.\')"');
    expect(rendered.html).toContain('data-copy-once-available="true"');
    expect(rendered.html).not.toContain('du_b-this-is-the-raw-secret');
  });
});
