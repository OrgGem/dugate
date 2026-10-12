import type { PoolClient, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { createApiKeyLifecycleService } from '../src/modules/identity/api-keys';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PROFILE = '33333333-3333-4333-8333-333333333333';
const ACTOR = { actor: 'platform-admin', role: 'ADMIN' as const, issuer: 'du-local', sub: 'admin-1', correlationId: 'key-test' };

function issuingService() {
  const writes: string[] = [];
  const audit = { record: jest.fn(async () => undefined) };
  let mutation: Record<string, unknown> | undefined;
  let key: Record<string, unknown> | undefined;
  let memberships: Array<{ profile_id: string }> = [];
  const execute = async <T extends QueryResultRow>(sql: string, params: unknown[] = []) => {
    const query = sql.replace(/\s+/g, ' ').trim();
    if (/INSERT INTO api_keys|INSERT INTO profile_api_keys|INSERT INTO admin_api_key_mutations/.test(query)) writes.push(query);
    let rows: Record<string, unknown>[] = [];
    if (/SELECT operation,request_hash,api_key_id FROM admin_api_key_mutations/.test(query)) rows = mutation ? [mutation] : [];
    else if (/INSERT INTO api_keys/.test(query)) {
      key = { id: params[0], tenant_id: params[1], prefix: params[3], name: params[4], status: 'ACTIVE',
        created_at: new Date('2026-10-11T00:00:00Z'), updated_at: new Date('2026-10-11T00:00:00Z'), version: 1, protected: false };
      rows = [key];
    } else if (/SELECT id,tenant_id,prefix,name,status,created_at,updated_at,version,\(lower/.test(query)) rows = key ? [key] : [];
    else if (/SELECT profile_id FROM profile_names/.test(query)) rows = (params[1] as string[]).map((profile_id) => ({ profile_id }));
    else if (/SELECT profile_id FROM profile_api_keys/.test(query)) rows = memberships;
    else if (/INSERT INTO profile_api_keys/.test(query)) {
      const ids = params[0] as string[];
      memberships = ids.map((profile_id) => ({ profile_id }));
    } else if (/INSERT INTO admin_api_key_mutations/.test(query)) {
      mutation = { tenant_id: params[0], idempotency_hash: params[1], operation: 'issue', request_hash: params[2], api_key_id: params[3] };
    }
    return { rows, rowCount: rows.length } as unknown as { rows: T[]; rowCount: number };
  };
  const db = {
    query: (sql: string, params?: unknown[]) => execute(sql, params),
    tx: <T>(work: (client: PoolClient) => Promise<T>) => work({ query: execute } as unknown as PoolClient),
  } as unknown as Db;
  return { service: createApiKeyLifecycleService({ db, audit: audit as never }), audit, writes };
}

describe('API-key lifecycle parity', () => {
  it('returns issued key material once and suppresses it on exact idempotent replay', async () => {
    const { service, audit } = issuingService();
    const input = { tenantId: TENANT, note: 'worker', profileIds: [PROFILE], idempotencyKey: 'issue-key-once-0001' };
    const issued = await service.issue(input, ACTOR);
    expect(issued).toMatchObject({ key: { tenantId: TENANT, note: 'worker', profileIds: [PROFILE] }, secretAvailable: true });
    const oneTimeSecret = 'secret' in issued ? issued.secret : undefined;
    expect(oneTimeSecret).toMatch(/^du_[A-Za-z0-9_-]{40,}$/);

    const replay = await service.issue(input, ACTOR);
    expect(replay).toMatchObject({ key: { id: issued.key.id }, secretAvailable: false });
    expect(replay).not.toHaveProperty('secret');
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('rejects a reserved Global label before storing a new key', async () => {
    const { service, writes } = issuingService();
    await expect(service.issue({ tenantId: TENANT, note: '  Global  ', idempotencyKey: 'issue-global-0001' }, ACTOR))
      .rejects.toMatchObject({ code: 'GLOBAL_KEY_PROTECTED' });
    expect(writes).toHaveLength(0);
  });
});
