import type { PoolClient } from 'pg';
import { ProfileCallbackPolicySchema, type ProfileCallbackPolicy } from '@du/contracts';
import type { Db } from '../src/db/db';
import { createProfileService } from '../src/modules/profiles/profiles';

const tenantId = '11111111-1111-4111-8111-111111111111';
const apiKeyId = '22222222-2222-4222-8222-222222222222';
const profileId = '33333333-3333-4333-8333-333333333333';
const policy: ProfileCallbackPolicy = {
  version: 1, mode: 'notification_with_result',
  auth: {
    method: 'oauth2_client_credentials', grantType: 'client_credentials',
    tokenUrl: 'https://idp.example.com/token', clientId: 'client-1',
    clientSecretRef: { kind: 'managed-secret', ref: 'synthetic/client' },
    clientAuthMethod: 'client_secret_post',
  },
  destination: { approvedOrigins: ['https://receiver.example.com'] },
};

interface Statement { sql: string; params: unknown[] }
function harness(stored: unknown = policy, hasPrevious = true) {
  const statements: Statement[] = [];
  const previous = {
    enabled: true, parameters: {}, job_priority: 'MEDIUM', allowed_file_extensions: '',
    connections_override: [], file_url_auth_cipher: null, request_redaction: [], callback_policy: stored,
  };
  const client = { query: async (sql: string, params: unknown[] = []) => {
    statements.push({ sql, params });
    if (sql.includes('SELECT id, tenant_id FROM api_keys')) return { rows: [{ id: apiKeyId, tenant_id: tenantId }], rowCount: 1 };
    if (sql.includes('SELECT max(revision)')) return { rows: [{ m: hasPrevious ? 4 : null }], rowCount: 1 };
    if (sql.includes('SELECT enabled, parameters')) return { rows: hasPrevious ? [previous] : [], rowCount: hasPrevious ? 1 : 0 };
    if (sql.includes('FROM profile_active_revisions')) return { rows: [{ ...previous, profile_id: profileId, revision: 4, connector_bindings: {}, moved_at: new Date(0) }], rowCount: 1 };
    if (sql.includes('INSERT INTO') || sql.includes('UPDATE')) return { rows: [], rowCount: 1 };
    throw new Error('Unexpected SQL: ' + sql);
  } } as unknown as PoolClient;
  const db = {
    query: client.query.bind(client),
    tx: async <T>(run: (c: PoolClient) => Promise<T>): Promise<T> => run(client),
  } as unknown as Db;
  const service = createProfileService(db);
  const publish = (inputPolicy?: Record<string, unknown>) => service.createRevision({
    apiKeyHash: 'a'.repeat(64), profileId, businessId: 'document-core', businessVersion: '1.0.0',
    action: 'extract', connectorBindings: {}, ...(inputPolicy === undefined ? {} : { policy: inputPolicy }),
  });
  const insertedCallback = (): unknown => {
    const insert = statements.find((s) => s.sql.includes('INSERT INTO profile_bindings'));
    if (!insert) throw new Error('Profile INSERT missing');
    const columns = insert.sql.match(/\(([^)]+)\)\s*VALUES/)?.[1]?.split(',').map((s) => s.trim()) ?? [];
    expect(columns[15]).toBe('callback_policy');
    expect(insert.sql).toContain('$16');
    expect(insert.params).toHaveLength(columns.length);
    const value = insert.params[columns.indexOf('callback_policy')];
    return value === null ? null : JSON.parse(String(value)) as unknown;
  };
  return { statements, publish, insertedCallback, service };
}

describe('CB-02b profile publish callback write boundary', () => {
  it.each([undefined, {}, { callbackPolicy: undefined }])('absent callback inherits the previous revision', async (inputPolicy) => {
    const h = harness();
    await expect(h.publish(inputPolicy)).resolves.toMatchObject({ profileId, revision: 5 });
    expect(h.insertedCallback()).toEqual(policy);
    const read = h.statements.find((s) => s.sql.includes('SELECT enabled, parameters'));
    expect(read?.sql).toContain('callback_policy');
    expect(read?.params).toEqual([profileId, 4]);
  });
  it('explicit null clears even a malformed previous value to SQL NULL', async () => {
    const h = harness({ token: 'NEVER_EXPOSE_SECRET' });
    await h.publish({ callbackPolicy: null });
    expect(h.insertedCallback()).toBeNull();
  });
  it('invalid client value rejects with 422 and a callback field pointer before any INSERT', async () => {
    const h = harness();
    await expect(h.publish({ callbackPolicy: { ...policy, mode: 'invalid-mode' } })).rejects.toMatchObject({
      status: 422, code: 'INVALID_SCHEMA', extra: { errors: expect.arrayContaining([
        expect.objectContaining({ pointer: '/callbackPolicy/mode' }),
      ]) },
    });
    expect(h.statements.filter((s) => /INSERT|UPDATE/.test(s.sql))).toEqual([]);
  });
  it('valid client replacement writes validated refs rather than the previous policy', async () => {
    const h = harness({ broken: true });
    await h.publish({ callbackPolicy: policy });
    const stored = h.insertedCallback();
    expect(ProfileCallbackPolicySchema.safeParse(stored).success).toBe(true);
    expect(stored).toEqual(policy);
    expect(JSON.stringify(stored)).not.toMatch(/"(?:clientSecret|accessToken|secretValue)"\s*:/);
  });
  it('first revision with an absent policy writes SQL NULL', async () => {
    const h = harness(undefined, false);
    await h.publish();
    expect(h.insertedCallback()).toBeNull();
  });
  it('invalid inherited policy fails closed before publishing a revision', async () => {
    const h = harness({ broken: true });
    await expect(h.publish()).rejects.toMatchObject({ status: 500, code: 'INVALID_SCHEMA' });
    expect(h.statements.filter((s) => /INSERT|UPDATE/.test(s.sql))).toEqual([]);
  });
  it('effective profile SELECT and decode retain stored refs without secret resolution', async () => {
    const h = harness();
    const effective = await h.service.resolveEffectiveProfile(apiKeyId, 'document-core', '1.0.0', 'extract');
    expect(effective.mode).toBe('pinned');
    if (effective.mode !== 'pinned') throw new Error('Expected a pinned profile');
    expect(effective.policy.callbackPolicy).toEqual(policy);
    expect(h.statements[0]?.sql).toContain('p.callback_policy');
    expect(h.statements[0]?.params).toEqual([apiKeyId, 'document-core', '1.0.0', 'extract']);
  });
});
