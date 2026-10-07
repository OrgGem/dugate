import type { PoolClient } from 'pg';
import type { Db } from '../src/db/db';
import { createProfileService } from '../src/modules/profiles/profiles';

const rules = [{ pattern: 'secret', replacement: '[REDACTED]' }];
const input = { profileId: 'profile-privacy', apiKeyHash: 'hash', businessId: 'doc-core', businessVersion: 'v1', action: 'extract', connectorBindings: {} };

function harness(previous: unknown) {
  const writes: unknown[][] = [];
  const client = { query: async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM api_keys')) return { rows: [{ id: 'key', tenant_id: 'tenant' }], rowCount: 1 };
    if (sql.includes('max(revision)')) return { rows: [{ m: previous ? 1 : 0 }], rowCount: 1 };
    if (sql.includes('SELECT enabled')) return { rows: previous ? [previous] : [], rowCount: previous ? 1 : 0 };
    if (sql.includes('INSERT INTO profile_bindings')) writes.push(params);
    return { rows: [], rowCount: 0 };
  } } as unknown as PoolClient;
  const db = { tx: async <T>(fn: (c: PoolClient) => Promise<T>) => fn(client) } as unknown as Db;
  return { service: createProfileService(db), writes };
}

describe('profile privacy revision persistence', () => {
  test('new profile defaults to no rules', async () => {
    const h = harness(undefined);
    await h.service.createRevision(input);
    expect(JSON.parse(String(h.writes[0]![14]))).toEqual([]);
  });
  test('unrelated edits preserve previous privacy rules', async () => {
    const h = harness({ request_redaction: rules });
    await h.service.createRevision({ ...input, policy: { enabled: false } });
    expect(JSON.parse(String(h.writes[0]![14]))).toEqual(rules);
  });
  test('explicit empty rules clear the policy', async () => {
    const h = harness({ request_redaction: rules });
    await h.service.createRevision({ ...input, policy: { requestRedaction: [] } });
    expect(JSON.parse(String(h.writes[0]![14]))).toEqual([]);
  });
  test('invalid regex never inserts a revision', async () => {
    const h = harness(undefined);
    await expect(h.service.createRevision({ ...input, policy: { requestRedaction: [{ pattern: '(' }] } })).rejects.toMatchObject({ status: 422 });
    expect(h.writes).toEqual([]);
  });
});
