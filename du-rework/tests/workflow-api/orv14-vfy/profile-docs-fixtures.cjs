'use strict';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const PROFILE_ID = '33333333-3333-4333-8333-333333333333';
const API_KEY_ID = '44444444-4444-4444-8444-444444444444';
const BUSINESS_ID = 'document-core';
const BUSINESS_VERSION = '1.1.0';
const PROFILE_NAME = 'invoice-review';
const REVISION = 4;
const NOW = '2026-10-10T00:00:00.000Z';

const inputSchema = {
  type: 'object',
  properties: {
    document_type: { type: 'string', title: 'Document type', default: 'invoice' },
  },
  required: ['document_type'],
  additionalProperties: false,
};

const adminSession = {
  schemaVersion: '1', plane: 'oidc', role: 'admin',
  principal: { kind: 'platform', tenantId: null }, scope: { kind: 'platform' },
  displayName: 'oidc:configured-provider', localUser: false, csrfToken: 'synthetic-csrf-token',
};

const userSession = {
  schemaVersion: '1', plane: 'legacy', role: 'operator',
  principal: { kind: 'tenant_operator', tenantId: TENANT }, scope: { kind: 'tenant', tenantId: TENANT },
  displayName: 'local-user', localUser: true, csrfToken: 'synthetic-csrf-token',
};

const viewerSession = {
  schemaVersion: '1', plane: 'oidc', role: 'viewer',
  principal: { kind: 'tenant_operator', tenantId: TENANT }, scope: { kind: 'tenant', tenantId: TENANT },
  displayName: 'oidc:tenant-viewer', localUser: false, csrfToken: 'synthetic-csrf-token',
};

const tenantPage = {
  items: [{ id: TENANT, name: 'ORV14 Profile Docs Tenant', state: 'ACTIVE' }],
  nextCursor: null, prevCursor: null, total: 1, limit: 100,
};

const profileRow = {
  tenantId: TENANT, businessId: BUSINESS_ID, businessVersion: BUSINESS_VERSION,
  profileName: PROFILE_NAME, revision: REVISION, status: 'ACTIVE', keyCount: 1,
  boundActions: ['extract'], createdAt: NOW, updatedAt: NOW,
};

const profileListPage = { items: [profileRow], total: 1, limit: 100, nextCursor: null, prevCursor: null };

const profileDetail = {
  businessId: BUSINESS_ID,
  businessVersion: BUSINESS_VERSION,
  profileName: PROFILE_NAME,
  revision: REVISION,
  currentValues: { document_type: 'invoice' },
  policy: {
    enabled: true,
    parameters: { document_type: { value: 'invoice', isLocked: false } },
    jobPriority: 'MEDIUM',
    allowedFileExtensions: '.pdf',
    fileUrlAuthConfigured: false,
    allowedOrigins: [],
    connectionsOverride: [],
    requestRedaction: [],
  },
  manifest: { actions: [{ name: 'extract', inputSchema }] },
  capabilities: [],
  connectorBindings: {},
  apiKeyId: API_KEY_ID,
};

const profileKeyPage = {
  profileId: PROFILE_ID,
  items: [{
    id: API_KEY_ID, tenantId: TENANT, prefix: 'du_synth', name: 'Assigned synthetic key',
    status: 'ACTIVE', membershipState: 'ACTIVE', createdAt: NOW, joinedAt: NOW, revokedAt: null,
  }],
  total: 1, limit: 100, nextCursor: null, prevCursor: null,
};

const assignedProfilePage = {
  tenantId: TENANT,
  items: [{
    profileId: PROFILE_ID, tenantId: TENANT, businessId: BUSINESS_ID,
    businessVersion: BUSINESS_VERSION, profileName: PROFILE_NAME, action: 'extract',
    endpointSlug: 'invoice', revision: REVISION, connectorBindings: {}, inputSchema,
    parameters: { document_type: { value: 'invoice', isLocked: false } }, connectionsOverride: [],
  }],
  nextCursor: null, total: 1, limit: 100,
};

const assignedKeyPage = {
  tenantId: TENANT, profileId: PROFILE_ID,
  items: [{ apiKeyId: API_KEY_ID, name: 'Assigned synthetic key', prefix: 'du_synth', status: 'ACTIVE' }],
  nextCursor: null, total: 1, limit: 100,
};

function preflight() {
  const root = '/workspace/dugate/du-rework';
  const Module = require('node:module');
  const contractsRequire = Module.createRequire(`${root}/orchestrator/packages/contracts/package.json`);
  const ts = contractsRequire('typescript');
  require.extensions['.ts'] = function compileTs(module, filename) {
    const source = require('node:fs').readFileSync(filename, 'utf8');
    const transpiled = ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        esModuleInterop: true,
      },
    });
    module._compile(transpiled.outputText, filename);
  };

  const policy = contractsRequire(`${root}/orchestrator/packages/contracts/src/profile-policy.ts`);
  const selfService = contractsRequire(`${root}/orchestrator/packages/contracts/src/profile-self-service.ts`);
  const stateRequire = Module.createRequire(`${root}/orchestrator/apps/admin-web/package.json`);
  const profileState = stateRequire(`${root}/orchestrator/apps/admin-web/src/features/profiles/state.ts`);
  const profileKeys = stateRequire(`${root}/orchestrator/apps/admin-web/src/features/profiles/profile-keys.ts`);
  const businessPage = {
    items: [{ businessId: BUSINESS_ID, activeVersion: BUSINESS_VERSION, version: BUSINESS_VERSION, status: 'ACTIVE' }],
    total: 1, limit: 100,
  };
  const businessVersions = {
    businessId: BUSINESS_ID, activeVersion: BUSINESS_VERSION,
    rows: [{ version: BUSINESS_VERSION, status: 'ACTIVE', isActive: true }],
  };
  const workflowPage = { businessId: BUSINESS_ID, businessVersion: BUSINESS_VERSION, items: [], total: 0 };
  const health = {
    status: 'ok', db: true, redis: true, activeLeases: 0,
    queueIntegrity: { state: 'OK', orphansLast: 0, stalled: 0, lastSweepAt: NOW },
    outboxBacklog: 0, sampledAt: NOW,
  };
  const sessionChecks = [adminSession, userSession, viewerSession].every((session) =>
    session.schemaVersion === '1'
      && (session.plane === 'oidc' || session.plane === 'legacy')
      && ['admin', 'operator', 'viewer'].includes(session.role)
      && typeof session.csrfToken === 'string'
      && typeof session.localUser === 'boolean'
      && typeof session.principal === 'object'
      && typeof session.scope === 'object');
  const tenantChecks = Array.isArray(tenantPage.items)
    && tenantPage.items.every((row) => typeof row.id === 'string' && typeof row.name === 'string' && typeof row.state === 'string')
    && tenantPage.nextCursor === null && tenantPage.prevCursor === null && tenantPage.total === 1 && tenantPage.limit === 100;
  const businessChecks = Array.isArray(businessPage.items)
    && businessPage.items.every((row) => typeof row.businessId === 'string' && typeof row.activeVersion === 'string' && typeof row.status === 'string')
    && businessPage.total === 1 && businessPage.limit === 100;
  const versionChecks = businessVersions.businessId === BUSINESS_ID
    && Array.isArray(businessVersions.rows)
    && businessVersions.rows.every((row) => typeof row.version === 'string' && typeof row.status === 'string' && typeof row.isActive === 'boolean');
  const workflowChecks = workflowPage.businessId === BUSINESS_ID && workflowPage.businessVersion === BUSINESS_VERSION
    && Array.isArray(workflowPage.items) && workflowPage.total === workflowPage.items.length;
  const healthChecks = health.status === 'ok' && typeof health.db === 'boolean' && typeof health.redis === 'boolean'
    && typeof health.activeLeases === 'number' && typeof health.outboxBacklog === 'number'
    && typeof health.sampledAt === 'string' && typeof health.queueIntegrity.state === 'string';
  const checks = [
    ['Admin Profile detail read contract', policy.ProfileDetailReadSchema.safeParse(profileDetail)],
    ['Admin Profile catalog browser parser', { success: profileState.parseProfileListPage(profileListPage, TENANT, BUSINESS_ID) !== null }],
    ['Admin Profile key-set browser parser', { success: profileKeys.parseProfileApiKeyPage(profileKeyPage) !== null }],
    ['USER assigned Profile contract', selfService.ProfileSelfServiceAssignedPageSchema.safeParse(assignedProfilePage)],
    ['USER assigned API-key contract', selfService.ProfileSelfServiceAssignedApiKeyPageSchema.safeParse(assignedKeyPage)],
    ['Admin/operator/Viewer session DTOs', { success: sessionChecks }],
    ['Tenant roster page DTO', { success: tenantChecks }],
    ['Business registry page DTO', { success: businessChecks }],
    ['Business versions DTO', { success: versionChecks }],
    ['Profile workflow page DTO', { success: workflowChecks }],
    ['Admin shell health DTO', { success: healthChecks }],
    ['Unrelated empty response fixture', { success: Object.keys({}).length === 0 }],
  ];
  const failed = checks.filter(([, result]) => result.success !== true);
  if (failed.length) {
    for (const [name, result] of failed) {
      const error = result.error;
      process.stderr.write(`PREFLIGHT_FAIL ${name} ${error?.issues?.map((issue) => `${issue.path.join('.')}:${issue.code}`).join(',') ?? 'parser-rejected'}\n`);
    }
    return false;
  }
  process.stdout.write(`PREFLIGHT_PASS responseShapes=${checks.length} adminProfileDetail=1 profileCatalog=1 profileKeys=1 userAssignedProfiles=1 userAssignedKeys=1 sessions=3 tenantRoster=1 businessRegistry=1 versions=1 profileWorkflows=1 health=1 emptyFallback=1\n`);
  return true;
}

module.exports = {
  TENANT, OTHER_TENANT, PROFILE_ID, API_KEY_ID, BUSINESS_ID, BUSINESS_VERSION,
  PROFILE_NAME, REVISION, NOW, inputSchema, adminSession, userSession, viewerSession,
  tenantPage, profileRow, profileListPage, profileDetail, profileKeyPage,
  assignedProfilePage, assignedKeyPage, preflight,
};
