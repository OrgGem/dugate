import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { createAdminApiClient } from '../src/lib/api/client.ts';
import { activationRevisionMatches, parseBusinessPage, parseBusinessVersions } from '../src/features/businesses/state.ts';
import { parseProfileWorkflowPage } from '../src/features/profiles/state.ts';

const businessScreen = await readFile(new URL('../src/features/businesses/businesses-screen.tsx', import.meta.url), 'utf8');
const businessDetail = await readFile(new URL('../src/features/businesses/business-detail-cockpit.tsx', import.meta.url), 'utf8');
const profileScreen = await readFile(new URL('../src/features/profiles/profiles-screen.tsx', import.meta.url), 'utf8');
const profileGroupEditor = await readFile(new URL('../src/features/profiles/profile-group-editor.tsx', import.meta.url), 'utf8');

const businessPageWire = {
  items: [{
    businessId: 'document-core',
    activeVersion: '3.2.1',
    activationRevision: 9,
    admissionEligible: true,
    admissionReason: 'ELIGIBLE',
    submissionsPaused: false,
    preDrainVersion: null,
    version: '3.2.1',
    status: 'ENABLED',
    updatedAt: '2026-10-11T08:00:00.000Z',
    enabled: true,
    lifecycleRevision: 8,
  }],
  total: 1,
  limit: 50,
  nextCursor: null,
};

const businessVersionsWire = {
  businessId: 'document-core',
  activeVersion: '3.2.1',
  activationRevision: 9,
  submissionsPaused: false,
  preDrainVersion: null,
  remainingOperations: null,
  enabled: true,
  lifecycleRevision: 8,
  rows: [
    { version: '3.2.1', status: 'ENABLED', isActive: true, admissionEligible: true, admissionReason: 'ELIGIBLE', parkedTaskCount: 0, drainingTaskCount: 0, parkedReasons: {}, updatedAt: '2026-10-11T08:00:00.000Z' },
    { version: '3.1.0', status: 'RETIRED', isActive: false, admissionEligible: false, admissionReason: 'VERSION_NOT_ACTIVE', parkedTaskCount: 2, drainingTaskCount: 1, parkedReasons: { VERSION_NOT_ACTIVE: 2 }, updatedAt: '2026-10-09T08:00:00.000Z' },
  ],
};

const workflowPageWire = {
  businessId: 'document-core',
  businessVersion: '3.2.1',
  items: [{
    slug: 'invoice-review',
    revision: 4,
    status: 'active',
    enabled: false,
    createdAt: '2026-10-11T07:00:00.000Z',
  }],
  total: 1,
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Business Services offline integration harness', () => {
  it('loads the real business registry response and selected business versions through the BFF client', async () => {
    const calls = [];
    const client = createAdminApiClient({
      basePath: '/admin/api',
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), method: init.method });
        if (String(input) === '/admin/api/businesses?limit=50') return jsonResponse(businessPageWire);
        if (String(input) === '/admin/api/businesses/document-core/versions') return jsonResponse(businessVersionsWire);
        return jsonResponse({ code: 'NOT_FOUND', title: 'Unexpected path.' }, 404);
      },
    });

    const listed = await client.listBusinesses({ limit: '50' });
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    const page = parseBusinessPage(listed.data);
    assert.deepEqual(page, businessPageWire);

    const selectedBusiness = page?.items[0]?.businessId;
    assert.equal(selectedBusiness, 'document-core');
    const versionsResult = await client.getBusinessVersions(selectedBusiness);
    assert.equal(versionsResult.ok, true);
    if (!versionsResult.ok) return;
    const versions = parseBusinessVersions(versionsResult.data);
    assert.deepEqual(versions, businessVersionsWire);
    assert.equal(versions?.rows.find((row) => row.isActive)?.version, '3.2.1');
    assert.equal(versions?.rows.find((row) => row.version === '3.1.0')?.parkedTaskCount, 2);
    assert.equal(versions?.rows.find((row) => row.version === '3.1.0')?.drainingTaskCount, 1);
    assert.deepEqual(versions?.rows.find((row) => row.version === '3.1.0')?.parkedReasons, { VERSION_NOT_ACTIVE: 2 });
    assert.deepEqual(calls, [
      { url: '/admin/api/businesses?limit=50', method: 'GET' },
      { url: '/admin/api/businesses/document-core/versions', method: 'GET' },
    ]);
  });

  it('does not invent an activation revision when an older read model omits it', () => {
    const versions = parseBusinessVersions({ ...businessVersionsWire, activationRevision: undefined });
    assert.equal(versions?.activationRevision, null);
  });

  it('keeps missing or invalid parked visibility unknown and parses only nonnegative reason counts', () => {
    const parsed = parseBusinessVersions({
      ...businessVersionsWire,
      rows: [
        { version: 'old-server', parkedTaskCount: undefined, drainingTaskCount: -1, parkedReasons: { VERSION_NOT_ACTIVE: 2, BAD: -1, '': 4 } },
      ],
    });
    assert.equal(parsed?.rows[0]?.parkedTaskCount, null);
    assert.equal(parsed?.rows[0]?.drainingTaskCount, null);
    assert.deepEqual(parsed?.rows[0]?.parkedReasons, { VERSION_NOT_ACTIVE: 2 });
  });

  it('sends the activation revision supplied by the confirmed version action', async () => {
    const calls = [];
    const client = createAdminApiClient({
      basePath: '/admin/api',
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push({ url, method: init.method, headers: init.headers, body: init.body });
        if (url === '/admin/api/session') return jsonResponse({ csrfToken: 'csrf-proof' });
        if (url === '/admin/api/businesses/document-core/versions/3.3.0/activate') {
          return jsonResponse({ activationRevision: 10, activeVersion: '3.3.0' });
        }
        return jsonResponse({ code: 'NOT_FOUND', title: 'Unexpected path.' }, 404);
      },
    });

    const result = await client.businessVersionAction('document-core', '3.3.0', 'activate', {
      expectedActivationRevision: 9,
    });
    assert.equal(result.ok, true);
    const write = calls.at(-1);
    assert.equal(write?.method, 'PUT');
    assert.equal(write?.url, '/admin/api/businesses/document-core/versions/3.3.0/activate');
    assert.deepEqual(JSON.parse(write?.body), { expectedActivationRevision: 9 });
    assert.equal(write?.headers['x-csrf-token'], 'csrf-proof');
  });

  it('requires a new confirmation when the displayed activation revision is stale', () => {
    const displayedRevision = 5;
    let mutations = 0;
    const confirmAfterRefresh = (serverRevision) => {
      if (!activationRevisionMatches(displayedRevision, serverRevision)) return 'REVIEW_REQUIRED';
      mutations += 1;
      return 'MUTATED';
    };

    assert.equal(confirmAfterRefresh(6), 'REVIEW_REQUIRED');
    assert.equal(mutations, 0);
    assert.equal(confirmAfterRefresh(5), 'MUTATED');
    assert.equal(mutations, 1);
  });

  it('keeps workflow binding reads and writes fenced to the selected profile business, version, and tenant', async () => {
    const calls = [];
    const client = createAdminApiClient({
      basePath: '/admin/api',
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push({ url, method: init.method, headers: init.headers, body: init.body });
        if (init.method === 'GET' && url === '/admin/api/profiles/document-core/3.2.1/default/workflows?tenantId=tenant-a') {
          return jsonResponse(workflowPageWire);
        }
        if (url === '/admin/api/session') return jsonResponse({
          schemaVersion: '1', plane: 'oidc', role: 'admin', principal: { kind: 'platform', tenantId: null },
          scope: { kind: 'platform' }, displayName: 'Test admin', localUser: false, csrfToken: 'csrf-proof',
        });
        if (init.method === 'POST' && url === '/admin/api/profiles/document-core/3.2.1/default/workflows?tenantId=tenant-a') {
          return jsonResponse({ businessId: 'document-core', businessVersion: '3.2.1', workflowSlug: 'invoice-review', workflowRevision: 4, enabled: true });
        }
        return jsonResponse({ code: 'NOT_FOUND', title: 'Unexpected path.' }, 404);
      },
    });

    const listed = await client.listProfileWorkflows('document-core', '3.2.1', 'default', 'tenant-a');
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    const workflows = parseProfileWorkflowPage(listed.data, 'document-core', '3.2.1');
    assert.deepEqual(workflows, workflowPageWire);
    assert.equal(parseProfileWorkflowPage(workflowPageWire, 'another-business', '3.2.1'), null);
    assert.equal(parseProfileWorkflowPage(workflowPageWire, 'document-core', '9.9.9'), null);

    await client.getSession();
    const saved = await client.setProfileWorkflow(
      'document-core',
      '3.2.1',
      'default',
      'tenant-a',
      { workflowSlug: 'invoice-review', workflowRevision: 4, enabled: true },
      'workflow-binding-test-1',
    );
    assert.equal(saved.ok, true);
    assert.equal(calls[0]?.url, '/admin/api/profiles/document-core/3.2.1/default/workflows?tenantId=tenant-a');
    assert.equal(calls.at(-1)?.method, 'POST');
    assert.deepEqual(JSON.parse(calls.at(-1)?.body), {
      workflowSlug: 'invoice-review',
      workflowRevision: 4,
      enabled: true,
    });
    assert.equal(calls.at(-1)?.headers['x-csrf-token'], 'csrf-proof');
    assert.equal(calls.at(-1)?.headers['idempotency-key'], 'workflow-binding-test-1');
  });

  it('wires Business version detail and profile workflow ownership into the actual screens', () => {
    assert.match(businessScreen, /client\.listBusinesses\(\{ limit: '20'/);
    assert.match(businessScreen, /client\.getBusinessVersions\(businessId\)/);
    assert.match(businessScreen, /parseBusinessVersions\(result\.data\)/);
    assert.match(businessScreen, /Parked tasks/);
    assert.match(businessScreen, /Draining leases/);
    assert.match(businessScreen, /row\.parkedTaskCount\?\.toLocaleString\(\)/);
    assert.match(businessScreen, /row\.drainingTaskCount\?\.toLocaleString\(\)/);
    assert.match(businessScreen, /row\.parkedReasons/);
    assert.match(businessScreen, /Versions — \{versions\.data\.businessId\}/);
    assert.match(businessScreen, /versions\.data\.rows\.map\(\(row\)/);
    assert.match(businessScreen, /client\.setBusinessEnabled\(businessId, \{ enabled, expectedLifecycleRevision: lifecycleRevision \}\)/);
    assert.match(businessScreen, /session\?\.role === 'admin' && !session\.localUser && session\.principal\.kind === 'platform'/);
    assert.match(businessScreen, /Activate for submissions/);
    assert.match(businessScreen, /expectedActivationRevision,\s*\}/);
    assert.match(businessScreen, /businessVersionAction\(pending\.businessId, pending\.version, 'enable', \{[\s\S]*expectedActivationRevision,/);
    assert.match(businessScreen, /interface PendingVersionAction \{[\s\S]*expectedActivationRevision: number \| null/);
    assert.match(businessScreen, /queueVersionAction\('activate', versions\.data\.businessId, row\.version, versions\.data\.activationRevision \?\? null\)/);
    const revisionGuard = businessScreen.indexOf('if (!activationRevisionMatches(displayedRevision, current.activationRevision))');
    const firstVersionMutation = businessScreen.indexOf('client.businessVersionAction(pending.businessId');
    assert.ok(revisionGuard >= 0 && revisionGuard < firstVersionMutation, 'the current revision must be compared before any version mutation');
    assert.match(businessScreen, /strict version switch/);
    assert.match(businessScreen, /remainingOperations/);
    assert.match(businessScreen, /Pre-drain/);
    assert.match(businessScreen, /Disable business/);
    assert.match(businessDetail, /versions\.data\.rows\.map\(\(version\)/);
    assert.match(businessDetail, /loadedWorkers\.filter\(\(worker\) => worker\.businessVersion === version\.version\)/);
    assert.match(businessDetail, /acceptedTaskCountSince/);
    assert.match(businessDetail, /worker\.durableLeases\} \/ \{worker\.capacity/);
    assert.match(businessDetail, /Worker report/);
    assert.match(profileScreen, /<ProfileGroupEditor tenantId=\{globalTenantId\} \/>/);
    assert.match(profileScreen, /businessFunctionCatalog\?\.functions\.filter\(\(fn\) => fn\.kind === 'endpoint'\)/);
    assert.doesNotMatch(profileScreen, /coreEndpoints/);
    assert.match(profileGroupEditor, /Registered enabled businesses/);
    assert.match(profileGroupEditor, /Save full group revision/);
    assert.match(profileGroupEditor, /Rollback complete group/);
    assert.match(profileGroupEditor, /disabled=\{\(!available && !checked\)/);

    assert.match(profileScreen, /client\.listProfileWorkflows\(/);
    assert.match(profileScreen, /detail\.businessId,\s*detail\.businessVersion,\s*targetName,\s*globalTenantId/s);
    assert.match(profileScreen, /parseProfileWorkflowPage\(result\.data, detail\.businessId, detail\.businessVersion\)/);
    assert.match(profileScreen, /client\.setProfileWorkflow\(/);
    assert.match(profileScreen, /detail\.businessId,\s*detail\.businessVersion,\s*loadedAs\.profileName,\s*globalTenantId/s);
    assert.match(profileScreen, /workflowSlug: item\.slug, workflowRevision: item\.revision, enabled/);
  });
});
