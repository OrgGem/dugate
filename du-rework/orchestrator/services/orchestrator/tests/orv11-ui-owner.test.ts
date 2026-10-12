import type { PoolClient } from 'pg';
import type { Db } from '../src/db/db';
import type { createSubmissionService } from '../src/modules/operations/submission';
import { updatePromptSetting, EffectiveSettingsSchema } from '../src/modules/settings/settings';
import { submitWorkflowTest } from '../src/modules/workflow-test/workflow-test';
import { resolveLegacyWorkflowSchema } from '../src/modules/workflow-schemas/workflow-schemas';
import { assertRoleActionTenant } from '../src/modules/admin-actions/dispatcher';

jest.mock('../src/modules/workflow-schemas/workflow-schemas', () => ({ resolveLegacyWorkflowSchema: jest.fn() }));
const tenantId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const apiKeyId = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const connectionId = 'cccccccc-3333-4333-8333-cccccccccccc';
const prompt = { tenantId, apiKeyId, connectionId, endpointSlug: 'extract:invoice', stepId: '_default', promptOverride: '  invoice prompt  ', expectedUpdatedAt: null };
afterEach(() => jest.clearAllMocks());

test('settings refuses a foreign or inactive key before reading or writing a prompt', async () => {
  const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  await expect(updatePromptSetting({ query } as unknown as PoolClient, prompt)).rejects.toMatchObject({ status: 404 });
  expect(query).toHaveBeenCalledTimes(1);
});
test('settings stale revision does not overwrite another operator edit', async () => {
  const query = jest.fn().mockResolvedValueOnce({ rows: [{ id: apiKeyId }], rowCount: 1 }).mockResolvedValueOnce({ rows: [{ connector_bindings: { ai: { connectorId: connectionId } } }], rowCount: 1 }).mockResolvedValueOnce({ rows: [{ updated_at: new Date('2026-10-11T01:00:00Z') }], rowCount: 1 });
  await expect(updatePromptSetting({ query } as unknown as PoolClient, prompt)).rejects.toMatchObject({ status: 409 });
  expect(query).toHaveBeenCalledTimes(3);
});
test('settings writes canonical legacy identifiers and trims prompt, returns revision', async () => {
  const query = jest.fn().mockResolvedValueOnce({ rows: [{ id: apiKeyId }], rowCount: 1 }).mockResolvedValueOnce({ rows: [{ connector_bindings: { ai: { connectorId: connectionId } } }], rowCount: 1 }).mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({ rows: [{ updated_at: new Date('2026-10-11T01:00:00Z') }], rowCount: 1 });
  expect(await updatePromptSetting({ query } as unknown as PoolClient, prompt)).toEqual({ updatedAt: '2026-10-11T01:00:00.000Z', appliesTo: 'new submissions only' });
  expect(query.mock.calls[3]![1]).toEqual([tenantId, connectionId, apiKeyId, 'extract:invoice', '_default', 'invoice prompt']);
});
test('effective settings boundary strips credentials', () => {
  const view = EffectiveSettingsSchema.parse({ storage: { backend: 'postgres', bucket: null, region: null, endpoint: null, managedBy: 'deployment', restartRequired: true, secret: 'do-not-echo' }, capabilities: { metadataEncryptionConfigured: false, connectorManagementConfigured: false, credentialManagementConfigured: false, promptOverridesEditable: true }, promptOverrides: [], scope: { tenantId: null, apiKeyId: null, endpointSlug: null }, adminToken: 'do-not-echo' });
  expect(JSON.stringify(view)).not.toContain('do-not-echo');
});
test('workflow test uses active key + exact displayed revision and real submission', async () => {
  (resolveLegacyWorkflowSchema as jest.Mock).mockResolvedValue({ revision: 2, digest: 'sha256:pin' });
  const submit = jest.fn().mockResolvedValue({ operation: { id: 'operation-id' }, replayed: false });
  const db = { query: jest.fn().mockResolvedValue({ rowCount: 1 }) } as unknown as Db;
  const result = await submitWorkflowTest({ db, submission: { submit } as unknown as ReturnType<typeof createSubmissionService>, correlationId: 'test' }, { tenantId, apiKeyId, slug: 'invoice', expectedRevision: 2, variables: { count: 4 } }, 'test-key');
  expect(result.operationId).toBe('operation-id');
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ tenantId, apiKeyId, action: 'schema-workflow', idempotencyKey: 'test-key', workflowSchemaPin: { revision: 2, digest: 'sha256:pin' } }));
});
test('workflow revision conflict never dispatches', async () => {
  (resolveLegacyWorkflowSchema as jest.Mock).mockResolvedValue({ revision: 3 });
  const submit = jest.fn();
  await expect(submitWorkflowTest({ db: { query: jest.fn().mockResolvedValue({ rowCount: 1 }) } as unknown as Db, submission: { submit } as unknown as ReturnType<typeof createSubmissionService>, correlationId: 'test' }, { tenantId, apiKeyId, slug: 'invoice', expectedRevision: 2, variables: {} })).rejects.toMatchObject({ status: 409 });
  expect(submit).not.toHaveBeenCalled();
});
test('viewer/CSRF negative action controls fail closed', () => {
  expect(assertRoleActionTenant({ kind: 'cookie', role: 'viewer', csrfOk: true }, 'workflow.test').ok).toBe(false);
  expect(assertRoleActionTenant({ kind: 'cookie', role: 'admin', csrfOk: false }, 'settings.prompt.update').ok).toBe(false);
});

test('workflow test rejects inactive/foreign key before schema resolution or admission', async () => {
  const submit = jest.fn();
  await expect(submitWorkflowTest({ db: { query: jest.fn().mockResolvedValue({ rowCount: 0 }) } as unknown as Db, submission: { submit } as unknown as ReturnType<typeof createSubmissionService>, correlationId: 'test' }, { tenantId, apiKeyId, slug: 'invoice', expectedRevision: 2, variables: {} })).rejects.toMatchObject({ status: 404 });
  expect(resolveLegacyWorkflowSchema).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
});

test('prompt edit rejects a connection not pinned by the active profile', async () => {
  const query = jest.fn().mockResolvedValueOnce({ rows: [{ id: apiKeyId }], rowCount: 1 }).mockResolvedValueOnce({ rows: [{ connector_bindings: { ai: { connectorId: 'other' } } }], rowCount: 1 });
  await expect(updatePromptSetting({ query } as unknown as PoolClient, prompt)).rejects.toMatchObject({ status: 422 });
  expect(query).toHaveBeenCalledTimes(2);
});

test('disabled winning exact profile does not fall back to generic enabled profile', async () => {
  const query = jest.fn().mockResolvedValueOnce({ rows: [{ id: apiKeyId }], rowCount: 1 }).mockResolvedValueOnce({ rows: [{ enabled: false, connector_bindings: { ai: { connectorId: connectionId } } }], rowCount: 1 });
  await expect(updatePromptSetting({ query } as unknown as PoolClient, prompt)).rejects.toMatchObject({ status: 422 });
  expect(query.mock.calls[1]![0]).not.toContain('p.enabled=true');
  expect(query).toHaveBeenCalledTimes(2);
});
test.each([{ stepId: 'unused-step' }, { endpointSlug: 'workflows:doc-compare' }])('unsupported prompt target rejected before DB access %p', async patch => {
  const query = jest.fn();
  await expect(updatePromptSetting({ query } as unknown as PoolClient, { ...prompt, ...patch })).rejects.toMatchObject({ status: 422 });
  expect(query).not.toHaveBeenCalled();
});

test('workflow file test resolves server filenames in caller order and satisfies worker contract', async () => {
  (resolveLegacyWorkflowSchema as jest.Mock).mockResolvedValue({ revision: 2, digest: 'sha256:pin' });
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  const query = jest.fn().mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rows: [{ id: second, file_name: 'second.pdf' }, { id: first, file_name: 'first.txt' }] });
  const submit = jest.fn().mockResolvedValue({ operation: { id: 'operation-id' }, replayed: false });
  await submitWorkflowTest({ db: { query } as unknown as Db, submission: { submit } as unknown as ReturnType<typeof createSubmissionService>, correlationId: 'test' }, { tenantId, apiKeyId, slug: 'invoice', expectedRevision: 2, variables: {}, artifacts: [{ artifactId: first, role: 'files-1' }, { artifactId: second, role: 'files-2' }] });
  expect(submit.mock.calls[0]![0].submission.input).toEqual({ variables: {}, artifactIds: [first, second], fileNames: ['first.txt', 'second.pdf'], artifacts: [{ artifactId: first, role: 'files-1' }, { artifactId: second, role: 'files-2' }] });
  expect(query.mock.calls[1]![1]).toEqual([[first, second], tenantId, apiKeyId]);
});

test('workflow file test rejects missing or foreign artifact metadata before submission', async () => {
  (resolveLegacyWorkflowSchema as jest.Mock).mockResolvedValue({ revision: 2 });
  const submit = jest.fn();
  const query = jest.fn().mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rows: [] });
  await expect(submitWorkflowTest({ db: { query } as unknown as Db, submission: { submit } as unknown as ReturnType<typeof createSubmissionService>, correlationId: 'test' }, { tenantId, apiKeyId, slug: 'invoice', expectedRevision: 2, variables: {}, artifacts: [{ artifactId: connectionId, role: 'files-1' }] })).rejects.toMatchObject({ status: 404 });
  expect(submit).not.toHaveBeenCalled();
});
