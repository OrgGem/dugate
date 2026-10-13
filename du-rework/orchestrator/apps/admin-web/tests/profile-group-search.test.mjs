import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildProfileGroupSearchSuggestions,
  createBoundedSearchRequestScheduler,
  filterProfileGroupBusinesses,
  profileGroupFunctionLabel,
} from '../src/features/profiles/profile-group-search.ts';

const businesses = [
  { businessId: 'document-core', activeVersion: '1.4.0', version: '1.4.0', status: 'ACTIVE', updatedAt: null, enabled: true, lifecycleRevision: 2 },
  { businessId: 'claims-workflow', activeVersion: '2.0.1', version: '2.0.1', status: 'ACTIVE', updatedAt: null, enabled: true, lifecycleRevision: 4 },
  { businessId: 'disabled-business', activeVersion: '1.0.0', version: '1.0.0', status: 'DISABLED', updatedAt: null, enabled: false, lifecycleRevision: 1 },
];

const catalogs = [
  {
    businessId: 'document-core', businessVersion: '1.4.0', businessEnabled: true, manifestDigest: 'core-v1',
    functions: [
      { kind: 'endpoint', functionId: 'core:extract:invoice', action: 'extract', endpointSlug: 'extract.invoice', available: true },
      { kind: 'endpoint', functionId: 'core:analyze:claim', action: 'analyze', endpointSlug: 'analyze.claim', available: true },
    ],
  },
  {
    businessId: 'claims-workflow', businessVersion: '2.0.1', businessEnabled: true, manifestDigest: 'claims-v2',
    functions: [
      { kind: 'workflow', functionId: 'claims:action:review', action: 'manual-review', available: true },
    ],
  },
  {
    businessId: 'disabled-business', businessVersion: '1.0.0', businessEnabled: true, manifestDigest: 'disabled-v1',
    functions: [{ kind: 'endpoint', functionId: 'disabled:extract:invoice', action: 'extract', endpointSlug: 'extract.invoice', available: true }],
  },
];

describe('profile group business and endpoint search', () => {
  it('matches business IDs, endpoint paths, workflow actions, and function IDs with the catalog version', () => {
    const endpoint = buildProfileGroupSearchSuggestions(businesses, catalogs, 'EXTRACT.INVOICE');
    assert.equal(endpoint[0]?.type, 'function');
    if (endpoint[0]?.type !== 'function') assert.fail('Expected an endpoint match');
    assert.equal(endpoint[0].businessId, 'document-core');
    assert.equal(endpoint[0].businessVersion, '1.4.0');
    assert.equal(profileGroupFunctionLabel(endpoint[0].descriptor), 'extract.invoice');

    const action = buildProfileGroupSearchSuggestions(businesses, catalogs, 'manual-review');
    assert.equal(action[0]?.type, 'function');
    if (action[0]?.type !== 'function') assert.fail('Expected a workflow action match');
    assert.equal(action[0].businessId, 'claims-workflow');
    assert.equal(action[0].businessVersion, '2.0.1');

    const functionId = buildProfileGroupSearchSuggestions(businesses, catalogs, 'core:analyze:claim');
    assert.equal(functionId[0]?.type, 'function');
  });

  it('filters out disabled registry entries and catalogs that are not enabled', () => {
    assert.deepEqual(buildProfileGroupSearchSuggestions(businesses, catalogs, 'disabled-business'), []);
    const disabledCatalog = catalogs.map((catalog) => catalog.businessId === 'claims-workflow'
      ? { ...catalog, businessEnabled: false }
      : catalog);
    assert.deepEqual(buildProfileGroupSearchSuggestions(businesses, disabledCatalog, 'manual-review'), []);
  });

  it('shows an endpoint match in the business table even when that business is not in a draft group', () => {
    const matchingBusinesses = filterProfileGroupBusinesses(businesses, catalogs, 'analyze.claim');
    assert.deepEqual(matchingBusinesses.map((business) => business.businessId), ['document-core']);
  });

  it('bounds suggestions to the requested list size', () => {
    const manyCatalogs = Array.from({ length: 12 }, (_, index) => ({
      businessId: 'document-core',
      businessVersion: '1.4.0',
      businessEnabled: true,
      manifestDigest: 'core-v1',
      functions: [{ kind: 'endpoint', functionId: `core:lookup:${index}`, action: 'lookup', endpointSlug: `lookup.${index}`, available: true }],
    }));
    assert.equal(buildProfileGroupSearchSuggestions(businesses, manyCatalogs, 'lookup', 5).length, 5);
  });

  it('keeps discovery capped and lets the newest index finish after two stale generations', async () => {
    const scheduler = createBoundedSearchRequestScheduler(4);
    let generation = 'A';
    let active = 0;
    let maxActive = 0;
    const started = { A: 0, B: 0, C: 0 };
    const releases = { A: [], B: [], C: [] };
    const startBatch = (batch) => Promise.all(Array.from({ length: 4 }, () => scheduler.run(async () => {
      started[batch] += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => releases[batch].push(() => {
        active -= 1;
        resolve();
      }));
      return batch;
    }, () => generation === batch)));
    const waitFor = async (predicate) => {
      for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(predicate(), true, 'expected scheduled requests to reach the next generation');
    };

    const first = startBatch('A');
    await waitFor(() => started.A === 4);
    generation = 'B';
    const stale = startBatch('B');
    generation = 'C';
    const latest = startBatch('C');
    releases.A.forEach((release) => release());
    await waitFor(() => started.C === 4);
    assert.equal(started.B, 0);
    assert.equal(maxActive, 4);
    releases.C.forEach((release) => release());

    const [firstResults, staleResults, latestResults] = await Promise.all([first, stale, latest]);
    assert.deepEqual(firstResults, ['A', 'A', 'A', 'A']);
    assert.deepEqual(staleResults, [null, null, null, null]);
    assert.deepEqual(latestResults, ['C', 'C', 'C', 'C']);
    assert.equal(maxActive, 4);
  });
});
