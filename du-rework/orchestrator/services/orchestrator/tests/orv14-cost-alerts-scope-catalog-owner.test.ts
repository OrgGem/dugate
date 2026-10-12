import type { Db } from '../src/db/db';
import { createCostAlertService } from '../src/modules/cost-alerts/service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const API_KEY_A = '22222222-2222-4222-8222-222222222222';
const API_KEY_B = '33333333-3333-4333-8333-333333333333';
const PROFILE_A = '44444444-4444-4444-8444-444444444444';

function testDb(rowsPerCall: Array<Array<Record<string, unknown>>>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      return { rows: rowsPerCall[calls.length - 1] ?? [], rowCount: 0 };
    },
  };
  return { db: db as unknown as Db, calls };
}

describe('ORV14 guided cost policy scope catalog', () => {
  test('searches and pages beyond the first bounded API key result set with a tenant/query-bound keyset cursor', async () => {
    const { db, calls } = testDb([
      [
        { id: API_KEY_A, prefix: 'du_alpha' },
        { id: API_KEY_B, prefix: 'du_beta' },
        { id: PROFILE_A, prefix: 'du_gamma' },
      ],
      [{ id: PROFILE_A, prefix: 'du_gamma' }],
    ]);
    const service = createCostAlertService(db);
    const first = await service.listScopeCatalog({ tenantId: TENANT, kind: 'api-keys', q: 'du_', limit: 2 });
    expect(first).toMatchObject({
      kind: 'api-keys', limit: 2, hasMore: true,
      items: [{ id: API_KEY_A, label: 'Key · du_alpha' }, { id: API_KEY_B, label: 'Key · du_beta' }],
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(calls[0]?.sql).toContain('position($2 in lower(prefix))');
    expect(calls[0]?.params.slice(0, 2)).toEqual([TENANT, 'du_']);

    const second = await service.listScopeCatalog({ tenantId: TENANT, kind: 'api-keys', q: 'du_', limit: 2, cursor: first.nextCursor! });
    expect(second).toMatchObject({ kind: 'api-keys', hasMore: false, items: [{ id: PROFILE_A, label: 'Key · du_gamma' }] });
    expect(calls[1]?.sql).toContain('(lower(prefix),id::text)>(lower($3),$4)');
    await expect(service.listScopeCatalog({ tenantId: TENANT, kind: 'api-keys', q: 'other', limit: 2, cursor: first.nextCursor! }))
      .rejects.toMatchObject({ status: 422 });
    expect(calls).toHaveLength(2);
  });

  test('filters profile pages by their selected API key and business pages by the exact selected profile/key pair', async () => {
    const { db, calls } = testDb([
      [{
        id: PROFILE_A, api_key_id: API_KEY_A, api_key_prefix: 'du_scope',
        business_id: 'billing', business_version: 'v2', action: 'lookup', profile_name: 'Billing profile',
      }],
      [{ id: 'billing' }],
    ]);
    const service = createCostAlertService(db);
    const profiles = await service.listScopeCatalog({ tenantId: TENANT, kind: 'profiles', q: 'billing', apiKeyId: API_KEY_A, limit: 10 });
    expect(profiles).toMatchObject({
      kind: 'profiles', items: [{ id: PROFILE_A, apiKeyId: API_KEY_A, apiKeyLabel: 'Key · du_scope', businessId: 'billing' }],
    });
    expect(calls[0]?.sql).toContain('m.api_key_id=$3::uuid');
    expect(calls[0]?.params.slice(0, 3)).toEqual([TENANT, 'billing', API_KEY_A]);

    const businesses = await service.listScopeCatalog({
      tenantId: TENANT, kind: 'businesses', q: '', profileId: PROFILE_A, apiKeyId: API_KEY_A, limit: 10,
    });
    expect(businesses).toMatchObject({ kind: 'businesses', items: [{ id: 'billing', label: 'billing' }] });
    expect(calls[1]?.sql).toContain('scoped.profile_id=$2::uuid');
    expect(calls[1]?.sql).toContain('scoped.api_key_id=$3::uuid');
    expect(calls[1]?.params.slice(0, 3)).toEqual([TENANT, PROFILE_A, API_KEY_A]);
  });
});
