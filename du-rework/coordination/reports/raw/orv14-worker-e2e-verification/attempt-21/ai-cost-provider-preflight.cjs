'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const contracts = require(path.resolve(process.cwd(), 'orchestrator/packages/contracts/dist/index.js'));
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const root = path.resolve('coordination/reports/raw/orv14-worker-e2e-verification/attempt-21');
const manifestPath = path.join(root, 'contracts-dist.sha256');
const sourceManifestPath = path.join(root, 'contracts-source.sha256');
const tenantId = uuid(1);
const apiKeyId = uuid(2);
const profileId = uuid(3);
const operationId = uuid(4);
const taskId = uuid(5);
const invocationId = uuid(6);
const reservationGroupId = uuid(7);
const connectorId = 'orv14-vfy-preflight-openai';
const idempotencyKey = 'orv14-vfy-attempt21-provider-test-preflight';
const invocationGrant = 'synthetic-short-lived-signed-grant';
const cases = [];

function check(name, schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 8).map((issue) => ({
      path: issue.path.map(String).join('.').slice(0, 120),
      message: String(issue.message).slice(0, 180),
    }));
    throw new Error(`${name} preflight failed: ${JSON.stringify(issues)}`);
  }
  cases.push({ name, success: true });
}

const recipe = {
  adapter: 'openai-compatible',
  method: 'POST',
  endpointUrl: 'http://127.0.0.1:12345/provider',
  auth: { kind: 'none' },
  headers: [],
  request: { promptField: 'prompt', modelField: 'model', fields: [] },
  response: { contentPath: 'content', inputTokensPath: 'usage.inputTokens', outputTokensPath: 'usage.outputTokens' },
  session: { capture: [], inject: [] },
  timeoutMs: 30_000,
  responseBytes: 2_000_000,
};
check('ConnectorRecipeSchema/openai-compatible-auth-none', contracts.ConnectorRecipeSchema, recipe);
check('ConnectorDraftUpsertSchema/openai-compatible-auth-none', contracts.ConnectorDraftUpsertSchema, {
  tenantId,
  expectedHeadRevision: 0,
  recipe,
  credentialChange: { action: 'clear', confirm: true },
  idempotencyKey,
});

const model = 'ORV14_OPENAI_MODEL_A';
const aiSettings = { provider: 'openai-compatible', model, connectorId, connectorRevision: 1 };
check('TenantAiDraftRequestSchema/openai-compatible', contracts.TenantAiDraftRequestSchema, {
  expectedActiveRevision: null,
  settings: aiSettings,
  idempotencyKey: `${idempotencyKey}-draft`,
  reason: 'Synthetic provider settings preflight',
});
check('GlobalSettingsPublishRequestSchema/openai-compatible', contracts.GlobalSettingsPublishRequestSchema, {
  draftRevision: 1,
  expectedActiveRevision: null,
  idempotencyKey: `${idempotencyKey}-publish`,
  reason: 'Synthetic provider settings publish preflight',
});
check('TenantAiTestRequestSchema/openai-compatible', contracts.TenantAiTestRequestSchema, {
  revision: 1,
  apiKeyId,
  profileId,
  expectedProfileRevision: 1,
  businessId: 'document-core',
  businessVersion: '1.1.0',
  action: 'generate',
  endpointSlug: 'generate:summary',
  prompt: 'ORV14 synthetic tenant AI provider test',
  parameters: { task: 'summary' },
  artifactIds: [],
  timeoutMs: 30_000,
  idempotencyKey: `${idempotencyKey}-test`,
});
check('ProfileUpsertCommandSchema/openai-compatible', contracts.ProfileUpsertCommandSchema, {
  businessId: 'document-core',
  businessVersion: '1.1.0',
  profileName: `${idempotencyKey}-profile`,
  apiKey: { apiKeyId },
  action: 'generate',
  expectedRevision: 1,
  endpointSlug: 'generate:summary',
  connectorBindings: { reasoning: { connectorId, revision: 1 } },
  policy: { parameters: { model: { value: 'ORV14_PROFILE_MODEL_WINS', isLocked: true } } },
});

const costContext = {
  selectionState: 'DEFERRED',
  apiKeyId,
  profileId,
  profileRevision: 1,
  businessId: 'document-core',
  businessVersion: '1.1.0',
  action: 'generate',
  attempt: 1,
  priceRevision: null,
  budgetReservationGroupId: reservationGroupId,
  budgetPins: [],
};
const providerTestClaims = {
  audience: 'connector',
  purpose: 'admin-provider-test',
  tenantId,
  apiKeyId,
  profileId,
  businessId: 'document-core',
  businessVersion: '1.1.0',
  endpointSlug: 'generate:summary',
  connectorId,
  connectorRevision: 1,
  revisionState: 'ACTIVE',
  operationId,
  taskId,
  invocationId,
  inputHash: `sha256:${'a'.repeat(64)}`,
  bindingSlot: 'reasoning',
  reservationGroupId,
  costContext,
  allowedModel: model,
  artifactIds: [],
  artifactPins: [],
  iat: 1_900_000_000,
  exp: 1_900_000_120,
};
check('ProviderTestGrantClaimsSchema/real-deferred-cost-context', contracts.ProviderTestGrantClaimsSchema, providerTestClaims);
check('ProviderTestInvocationRequestSchema', contracts.ProviderTestInvocationRequestSchema, {
  grant: invocationGrant,
  input: { prompt: 'ORV14 synthetic provider-test prompt', parameters: { task: 'summary' } },
  deadlineAt: '2030-03-17T17:48:00.000Z',
});

const proof = {
  version: 'cost-bound-v1',
  capabilityId: null,
  connectorId,
  connectorRevision: 1,
  provider: '127.0.0.1',
  model,
  requestDigest: `sha256:${'b'.repeat(64)}`,
  inputUpperBoundTokens: null,
  outputLimit: null,
  outputLimitField: null,
  artifactCount: 0,
  hasSession: false,
  hasTools: false,
  hasUnknownUnits: true,
  retryCount: 0,
};
check('CostBoundProofSchema/unbounded-loopback-test-provider', contracts.CostBoundProofSchema, proof);
check('CostPreflightRequestSchema/authenticated-real-client-wire', contracts.CostPreflightRequestSchema, {
  grant: invocationGrant,
  proof,
});
check('CostReservationGroupTransitionSchema/running', contracts.CostReservationGroupTransitionSchema, {
  grant: invocationGrant,
  reservationGroupId,
  operationId,
  taskId,
  invocationId,
  attempt: 1,
  target: 'RUNNING',
});
check('CostPreflightResponseSchema/real-no-policy-best-effort-shape', contracts.CostPreflightResponseSchema, {
  decision: 'ADMITTED',
  selection: {
    state: 'FROZEN',
    reservationGroupId,
    selectedAt: '2030-03-17T17:47:00.000Z',
    priceRevision: null,
    pricingTier: null,
    budgetPins: [],
  },
  confidence: 'best-effort',
  hardCapEnabled: false,
  evaluations: [],
});
check('CostReservationGroupAckSchema/running', contracts.CostReservationGroupAckSchema, {
  reservationGroupId,
  state: 'RUNNING',
  updatedAt: '2030-03-17T17:47:05.000Z',
});
check('ConnectorProviderTestEvidenceQuerySchema/exact-persisted-pin', contracts.ConnectorProviderTestEvidenceQuerySchema, {
  tenantId, operationId, taskId, invocationId, connectorId, revision: 1,
});
check('ConnectorProviderTestEvidenceSchema/safe-unknown-ledger-evidence', contracts.ConnectorProviderTestEvidenceSchema, {
  tenantId, operationId, taskId, invocationId, connectorId, revision: 1,
  state: 'UNKNOWN', stateVersion: 3, updatedAt: '2030-03-17T17:47:10.000Z', errorCode: 'PROVIDER_TRANSPORT_AMBIGUOUS',
  result: null, usageEvent: null, evidenceDigest: `sha256:${'c'.repeat(64)}`, recoveryReady: false,
});
check('AdminWorkbenchPromptWizardRequestSchema', contracts.AdminWorkbenchPromptWizardRequestSchema, {
  tenantId,
  apiKeyId,
  businessVersion: '1.1.0',
  profileName: `${idempotencyKey}-profile`,
  expectedProfileRevision: 1,
  currentPrompt: 'Return a revised system prompt only.',
  problem: 'Clarify the requested field extraction.',
  endpointName: 'Generate summary',
  endpointSlug: 'generate:summary',
  connectorName: 'Synthetic prompt wizard',
  connectorSlug: 'ext-prompt-wizard',
  stepId: 'reasoning',
  wizardConnectorId: 'ext-prompt-wizard',
  wizardConnectorRevision: 1,
});

const out = {
  command: '/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node coordination/reports/raw/orv14-worker-e2e-verification/attempt-21/ai-cost-provider-preflight.cjs',
  cwd: process.cwd(),
  nodeVersion: process.version,
  contractsSourceManifestSha256: crypto.createHash('sha256').update(fs.readFileSync(sourceManifestPath)).digest('hex'),
  contractsDistManifestSha256: crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex'),
  contractsDistEntries: fs.readFileSync(manifestPath, 'utf8').trim().split('\n').length,
  scope: 'schema-only payload preflight using actual compiled @du/contracts; no HTTP, database, Vault, Connector or Worker call',
  passed: cases.length,
  cases,
};
fs.writeFileSync(path.join(root, 'ai-cost-provider-preflight.json'), JSON.stringify(out, null, 2) + '\n');
process.stdout.write(JSON.stringify({ passed: cases.length, contractsDistManifestSha256: out.contractsDistManifestSha256 }));
