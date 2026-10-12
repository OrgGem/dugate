'use strict';

const { createRequire } = require('node:module');
const fs = require('node:fs');

const REPO = '/workspace/dugate/du-rework';
const APP_REQUIRE = createRequire(`${REPO}/orchestrator/apps/admin-web/package.json`);
const SERVICE_REQUIRE = createRequire(`${REPO}/orchestrator/services/orchestrator/package.json`);
const ts = SERVICE_REQUIRE('typescript');

require.extensions['.ts'] = function compileTypeScript(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      esModuleInterop: true,
    },
  }).outputText;
  module._compile(output, filename);
};

const contract = (name) => require(`${REPO}/orchestrator/packages/contracts/src/${name}.ts`);
const adjustments = contract('cost-adjustments');
const costControl = contract('cost-control');
const alerts = contract('cost-alerts');
const parity = contract('parity');
const publicApi = contract('public-api');
const usageService = require(`${REPO}/orchestrator/services/orchestrator/src/modules/usage/usage.ts`);
const usageUi = APP_REQUIRE(`${REPO}/orchestrator/apps/admin-web/src/features/usage/state.ts`);
const costAdjustmentUi = APP_REQUIRE(`${REPO}/orchestrator/apps/admin-web/src/features/usage/cost-adjustment-state.ts`);

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreignTenantId = '22222222-2222-4222-8222-222222222222';
const rootEventId = 'orv14-finance-root-001';
const eventId = '88888888-8888-4888-8888-888888888881';
const secondEventId = '88888888-8888-4888-8888-888888888882';
const operationId = '66666666-6666-4666-8666-666666666666';
const taskId = '77777777-7777-4777-8777-777777777777';
const evidenceArtifactId = '33333333-3333-4333-8333-333333333333';
const generationId = '44444444-4444-4444-8444-444444444444';
const actorId = '55555555-5555-4555-8555-555555555555';
const initial = 100_000_000;
const sha = `sha256:${'a'.repeat(64)}`;
const objectSha = `sha256:${'b'.repeat(64)}`;
const sidecarSha = `sha256:${'c'.repeat(64)}`;
const eventTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const recordedAt = new Date().toISOString();

const problems = [];
let checked = 0;
function check(name, schema, value) {
  checked += 1;
  const result = schema.safeParse(value);
  if (result.success) {
    process.stdout.write(`PASS ${name}\n`);
    return;
  }
  const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}:${issue.message}`).join('|');
  problems.push(`${name}: ${issues}`);
  process.stdout.write(`FAIL ${name} ${issues}\n`);
}

function checkUi(name, parser, value, scope) {
  checked += 1;
  const result = parser(value, ...(scope === undefined ? [] : [scope]));
  if (result !== null) process.stdout.write(`PASS ${name}\n`);
  else {
    problems.push(`${name}: UI parser rejected fixture`);
    process.stdout.write(`FAIL ${name} UI parser rejected fixture\n`);
  }
}

function checkManual(name, valid) {
  checked += 1;
  if (valid) process.stdout.write(`PASS ${name}\n`);
  else {
    problems.push(`${name}: fixture shape did not match the current browser contract`);
    process.stdout.write(`FAIL ${name} fixture shape did not match the current browser contract\n`);
  }
}

function originalAttribution() {
  return {
    tenantId,
    apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    profileId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    profileRevision: 4,
    businessId: 'document-core',
    businessVersion: '1.0.0',
    action: 'extract',
    operationId,
    taskId,
    invocationId: 'orv14-invocation-opaque-001',
    attempt: 1,
    connectorId: 'synthetic-provider',
    connectorRevision: 3,
    provider: 'openai',
    model: 'gpt-4o',
    occurredAt: eventTime,
    quotaWindowPins: [],
    priceRevision: 9,
    priceSnapshotDigest: sha,
    provenanceDigest: objectSha,
    costStatus: 'measured',
    inputTokens: 1200,
    outputTokens: 320,
    cachedInputTokens: 0,
    pages: 1,
    durationMs: 850,
  };
}

function historyEntry(revision, previousAdjustmentEventId, kind, gross, refunded) {
  const correction = kind === 'correction';
  return {
    adjustmentEventId: revision === 1 ? eventId : secondEventId,
    rootEventId,
    adjustmentRevision: revision,
    previousAdjustmentEventId,
    kind,
    targetChargeMicrousd: correction ? gross : null,
    refundMicrousd: correction ? null : refunded,
    initialChargeMicrousd: initial,
    grossChargeMicrousd: gross,
    refundedMicrousd: refunded,
    netChargeMicrousd: gross - refunded,
    effectiveAt: eventTime,
    quotaWindowPins: [],
    recordedAt,
    evidenceArtifactId,
    evidenceStorageGenerationId: generationId,
    evidenceSizeBytes: 640,
    evidenceSha256: sha,
    evidenceObjectSizeBytes: 692,
    evidenceObjectSha256: objectSha,
    evidenceObjectProofComplete: true,
    evidenceObjectVersionId: `object-version-${revision}`,
    evidenceSidecarSizeBytes: 512,
    evidenceSidecarVersionId: `sidecar-version-${revision}`,
    evidenceSidecarSha256: sidecarSha,
    authority: 'platform-admin-approved',
    actorPrincipalId: actorId,
    actorKind: 'oidc-admin',
    reason: correction ? 'Correct invoice total after review' : 'Issue verified customer credit',
  };
}

function historyPage(revision = 0) {
  const items = revision === 0 ? [] : [
    historyEntry(2, eventId, 'refund', 80_000_000, 30_000_000),
    historyEntry(1, null, 'correction', 80_000_000, 0),
  ];
  return {
    tenantId,
    rootEventId,
    adjustmentRevision: revision,
    headAdjustmentEventId: items[0]?.adjustmentEventId ?? null,
    eligible: true,
    blockers: [],
    initialChargeMicrousd: initial,
    grossChargeMicrousd: revision === 0 ? initial : 80_000_000,
    refundedMicrousd: revision === 0 ? 0 : 30_000_000,
    netChargeMicrousd: revision === 0 ? initial : 50_000_000,
    originalAttribution: originalAttribution(),
    items,
    limit: 50,
    nextCursor: null,
  };
}

const evidencePage = {
  tenantId,
  items: [{
    artifactId: evidenceArtifactId,
    fileName: 'synthetic-invoice-evidence.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 640,
    sha256: sha,
    createdAt: eventTime,
  }],
  limit: 50,
  nextCursor: null,
};
const eventPage = {
  tenantId,
  events: [{
    eventId: rootEventId,
    operationId,
    taskId,
    invocationId: 'orv14-invocation-opaque-001',
    provider: 'openai',
    model: 'gpt-4o',
    units: { inputTokens: 1200, outputTokens: 320, pages: 1 },
    costMicrousd: initial,
    costStatus: 'measured',
    providerReportedCost: { costMicrousd: 102_000_000, currency: 'USD', source: 'provider-response', status: 'unverified' },
    financialAccounting: {
      rootEventId,
      initialChargeMicrousd: initial,
      grossChargeMicrousd: initial,
      refundedMicrousd: 0,
      netChargeMicrousd: initial,
      adjustmentRevision: 0,
      headAdjustmentEventId: null,
      semantics: 'initial-charge-plus-direct-root-adjustments-v1',
    },
    measurement: 'measured',
    occurredAt: eventTime,
    receivedAt: eventTime,
  }],
  limit: 50,
  hasMore: false,
  skippedInvalidEvents: 0,
  timeSemantics: { field: 'receivedAt', order: 'asc', timezone: 'UTC' },
};
const summary = {
  tenantId,
  from: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  to: new Date().toISOString(),
  rows: [{ provider: 'openai', model: 'gpt-4o', operations: 1, inputTokens: 1200, outputTokens: 320, pages: 1, costMicrousd: initial, measurement: 'measured', costStatus: 'measured' }],
  totals: { operations: 1, inputTokens: 1200, outputTokens: 320, pages: 1, costMicrousd: initial, costStatus: 'measured' },
};
const mutationResult = {
  outcome: 'ADJUSTED',
  adjustmentEventId: eventId,
  rootEventId,
  adjustmentRevision: 1,
  initialChargeMicrousd: initial,
  grossChargeMicrousd: 80_000_000,
  refundedMicrousd: 0,
  netChargeMicrousd: 80_000_000,
  effectiveAt: eventTime,
  recordedAt,
  replayed: false,
};

check('tenant-list', publicApi.AdminTenantsPageSchema, {
  items: [{ id: tenantId, name: 'ORV14 Synthetic Tenant', state: 'ACTIVE' }],
  nextCursor: null, prevCursor: null, total: 1, limit: 100,
});
check('usage-event-page-server-wire', usageService.AdminUsageEventPageSchema, eventPage);
checkUi('usage-event-page-admin-parser', usageUi.parseAdminUsageEventPage, eventPage, tenantId);
checkUi('usage-summary-admin-parser', usageUi.parseUsageSummary, summary);
check('adjustment-evidence-page', adjustments.CostAdjustmentEvidencePageSchema, evidencePage);
check('adjustment-history-empty-page', adjustments.CostAdjustmentHistoryPageSchema, historyPage(0));
check('adjustment-history-after-correction-refund', adjustments.CostAdjustmentHistoryPageSchema, historyPage(2));
const foreignHistoryPage = { ...historyPage(0), tenantId: foreignTenantId };
check('foreign-adjustment-history-shape', adjustments.CostAdjustmentHistoryPageSchema, foreignHistoryPage);
checkManual('foreign-adjustment-history-scope-rejected', !costAdjustmentUi.adjustmentHistoryMatchesScope(foreignHistoryPage, tenantId, rootEventId));
check('adjustment-mutation-result', adjustments.CostAdjustmentCommandResultSchema, mutationResult);
check('budget-list', costControl.CostControlBudgetListSchema, { tenantId, budgets: [] });
check('price-list', costControl.CostControlPriceListSchema, { headRevision: 0, activeRevision: null, revisions: [] });
check('alert-channel-list', alerts.CostAlertChannelListSchema, { tenantId, channels: [] });
check('alert-recipient-catalog', alerts.CostAlertRecipientCatalogSchema, { tenantId, items: [], limit: 50, hasMore: false, nextCursor: null });
check('alert-list', alerts.CostAlertListSchema, { tenantId, items: [], limit: 25, hasMore: false, nextCursor: null });
check('alert-inbox', alerts.CostAlertInboxPageSchema, { tenantId, items: [], limit: 25, hasMore: false, nextCursor: null });
for (const kind of ['api-keys', 'profiles', 'businesses']) {
  check(`cost-scope-catalog-${kind}`, alerts.CostPolicyScopeCatalogSchema, { tenantId, kind, items: [], limit: 50, hasMore: false, nextCursor: null });
}
check('identity-assignable-users', parity.IdentityAssignableUserPageSchema, { items: [], nextCursor: null, prevCursor: null, total: 0, limit: 100 });

const platformSession = {
  schemaVersion: '1', plane: 'oidc', role: 'admin',
  principal: { kind: 'platform', tenantId: null }, scope: { kind: 'platform' },
  displayName: 'oidc:configured-provider', localUser: false, csrfToken: 'synthetic-csrf-token',
};
const tenantUserSession = {
  schemaVersion: '1', plane: 'oidc', role: 'operator',
  principal: { kind: 'tenant_operator', tenantId }, scope: { kind: 'tenant', tenantId },
  displayName: 'local-user', localUser: true, csrfToken: 'synthetic-csrf-token',
};
checkManual('platform-session-wire', platformSession.schemaVersion === '1' && ['oidc', 'legacy'].includes(platformSession.plane)
  && ['admin', 'operator', 'viewer'].includes(platformSession.role) && platformSession.principal.kind === 'platform'
  && platformSession.principal.tenantId === null && platformSession.scope.kind === 'platform'
  && typeof platformSession.displayName === 'string' && platformSession.localUser === false && typeof platformSession.csrfToken === 'string');
checkManual('tenant-USER-session-wire', tenantUserSession.schemaVersion === '1' && ['oidc', 'legacy'].includes(tenantUserSession.plane)
  && ['admin', 'operator', 'viewer'].includes(tenantUserSession.role) && tenantUserSession.principal.kind === 'tenant_operator'
  && tenantUserSession.principal.tenantId === tenantId && tenantUserSession.scope.kind === 'tenant'
  && tenantUserSession.scope.tenantId === tenantId && typeof tenantUserSession.displayName === 'string'
  && tenantUserSession.localUser === true && typeof tenantUserSession.csrfToken === 'string');
const health = {
  status: 'ok', db: true, redis: true, activeLeases: 0,
  queueIntegrity: { state: 'OK', orphansLast: 0, stalled: 0, lastSweepAt: recordedAt },
  outboxBacklog: 0, sampledAt: recordedAt,
};
checkManual('admin-health-wire', ['ok', 'degraded', 'unknown'].includes(health.status)
  && typeof health.db === 'boolean' && typeof health.redis === 'boolean'
  && Number.isSafeInteger(health.activeLeases) && health.queueIntegrity.state === 'OK'
  && Number.isSafeInteger(health.queueIntegrity.orphansLast) && Number.isSafeInteger(health.queueIntegrity.stalled)
  && typeof health.queueIntegrity.lastSweepAt === 'string' && Number.isSafeInteger(health.outboxBacklog)
  && Number.isFinite(Date.parse(health.sampledAt)));
for (const problem of [
  { type: 'urn:du:error:backup_effect_fence_active', title: 'Financial writes are held by an active backup', status: 409, code: 'BACKUP_EFFECT_FENCE_ACTIVE' },
  { type: 'urn:du:error:cost_adjustment_cas_conflict', title: 'Adjustment head changed', status: 409, code: 'COST_ADJUSTMENT_CAS_CONFLICT' },
  { type: 'urn:du:error:upstream_unavailable', title: 'Adjustment acknowledgement unavailable', status: 503, code: 'UPSTREAM_UNAVAILABLE' },
]) {
  checkManual(`problem-${problem.code}`, typeof problem.type === 'string' && typeof problem.title === 'string'
    && Number.isInteger(problem.status) && typeof problem.code === 'string');
}

const failures = problems.length;
process.stdout.write(`ORV14_UI_RESPONSE_PREFLIGHT failed=${failures} checked=${checked}\n`);
if (failures > 0) process.exitCode = 1;
