'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const contracts = require(path.resolve(process.cwd(), 'orchestrator/packages/contracts/dist/index.js'));
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const commonId = 'orv14-vfy-payload-preflight';
const cases = [];
function check(name, schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 8).map((issue) => ({
      path: issue.path.map(String).join('.').slice(0, 120),
      message: String(issue.message).slice(0, 180),
    }));
    throw new Error(`${name} schema preflight failed: ${JSON.stringify(issues)}`);
  }
  cases.push({ name, success: true });
}
for (const [index, provider] of ['openai-compatible', 'gemini'].entries()) {
  const connectorId = `${commonId}-${provider}`;
  const model = `ORV14_PREFLIGHT_${provider.toUpperCase().replaceAll('-', '_')}`;
  const draft = {
    expectedActiveRevision: index === 0 ? null : 1,
    settings: { provider, model, connectorId, connectorRevision: 1 },
    idempotencyKey: `${commonId}-draft-${provider}`,
    reason: 'Validate synthetic provider settings before live test',
  };
  check(`TenantAiDraftRequestSchema/${provider}`, contracts.TenantAiDraftRequestSchema, draft);
  check(`GlobalSettingsPublishRequestSchema/${provider}`, contracts.GlobalSettingsPublishRequestSchema, {
    draftRevision: index + 1,
    expectedActiveRevision: index === 0 ? null : 1,
    idempotencyKey: `${commonId}-publish-${provider}`,
    reason: 'Publish prevalidated synthetic provider settings',
  });
  check(`TenantAiTestRequestSchema/${provider}`, contracts.TenantAiTestRequestSchema, {
    revision: index + 1,
    apiKeyId: uuid(1),
    profileId: uuid(2),
    expectedProfileRevision: 1,
    businessId: 'document-core',
    businessVersion: '1.1.0',
    action: 'generate',
    endpointSlug: 'generate:summary',
    prompt: 'Synthetic provider settings schema preflight',
    parameters: { task: 'summary' },
    artifactIds: [],
    timeoutMs: 30_000,
    idempotencyKey: `${commonId}-test-${provider}`,
  });
  check(`ProfileEndpointPolicySchema/${provider}`, contracts.ProfileEndpointPolicySchema, {
    parameters: { model: { value: model, isLocked: true } },
  });
  check(`ProfileUpsertCommandSchema/${provider}`, contracts.ProfileUpsertCommandSchema, {
    businessId: 'document-core',
    businessVersion: '1.1.0',
    profileName: `${commonId}-${provider}`,
    apiKey: { apiKeyId: uuid(1) },
    action: 'generate',
    expectedRevision: 1,
    endpointSlug: 'generate:summary',
    connectorBindings: { reasoning: { connectorId, revision: 1 } },
    policy: { parameters: { model: { value: model, isLocked: true } } },
  });
}
check('AdminWorkbenchEndpointTestRequestSchema', contracts.AdminWorkbenchEndpointTestRequestSchema, {
  tenantId: uuid(3), apiKeyId: uuid(1), businessId: 'document-core', businessVersion: '1.1.0',
  action: 'generate', profileName: `${commonId}-profile`, expectedProfileRevision: 1,
  parameters: { task: 'summary' }, artifacts: [],
});
check('AdminWorkbenchPromptWizardRequestSchema', contracts.AdminWorkbenchPromptWizardRequestSchema, {
  tenantId: uuid(3), apiKeyId: uuid(1), businessVersion: '1.1.0',
  profileName: `${commonId}-profile`, expectedProfileRevision: 1,
  currentPrompt: 'Return a revised system prompt only.', problem: 'Clarify the requested field extraction.',
  endpointName: 'Generate summary', endpointSlug: 'generate:summary',
  connectorName: 'Synthetic prompt wizard', connectorSlug: 'ext-prompt-wizard', stepId: 'reasoning',
  wizardConnectorId: 'ext-prompt-wizard', wizardConnectorRevision: 1,
});
const manifestPath = 'coordination/reports/raw/orv14-worker-e2e-verification/attempt-16/backend-service-runtime-bootid-contracts-dist-after.sha256';
const manifestHash = crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex');
const out = {
  command: '/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node coordination/reports/raw/orv14-worker-e2e-verification/attempt-16/payload-preflight.cjs',
  cwd: process.cwd(),
  nodeVersion: process.version,
  contractsDistManifest: { path: manifestPath, sha256: manifestHash, entries: fs.readFileSync(manifestPath, 'utf8').trim().split(String.fromCharCode(10)).length },
  scope: 'schema-only payload preflight; no HTTP, database, provider, or Worker call',
  passed: cases.length,
  cases,
};
fs.writeFileSync(path.resolve('coordination/reports/raw/orv14-worker-e2e-verification/attempt-16/payload-preflight.json'), JSON.stringify(out, null, 2) + String.fromCharCode(10));
