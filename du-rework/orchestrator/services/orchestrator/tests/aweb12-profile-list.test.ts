import type { Db } from '../src/db/db';
import { listAdminProfilePage, parseAdminProfileListQuery } from '../src/modules/admin-read/profile-list';

const TENANT_ID = '123e4567-e89b-42d3-a456-426614174000';

describe('AWEB-12 tenant-fenced profile list', () => {
  test('parses tenant/business filters and rejects repeated or malformed scope values', () => {
    const query = parseAdminProfileListQuery(new URLSearchParams(
      `tenantId=${TENANT_ID}&businessId=document-core&limit=25&sort=updatedAt:desc`,
    ));
    expect(query).toMatchObject({ tenantId: TENANT_ID, businessId: 'document-core', limit: 25, sort: 'updatedAt:desc' });
    expect(() => parseAdminProfileListQuery(new URLSearchParams(`tenantId=${TENANT_ID}&tenantId=${TENANT_ID}`)))
      .toThrow(/tenantId must not be repeated/);
    expect(() => parseAdminProfileListQuery(new URLSearchParams('tenantId=not-a-uuid')))
      .toThrow(/tenantId must be a uuid/);
    expect(() => parseAdminProfileListQuery(new URLSearchParams('businessId=bad%00value')))
      .toThrow(/printable characters/);
  });

  test('always applies tenant and optional business predicates as bound SQL values', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const db = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return {
          rows: sql.startsWith('SELECT count(*)') ? [{ total: '0' }] : [],
          rowCount: 0,
          command: 'SELECT',
          oid: 0,
          fields: [],
        };
      },
    } as unknown as Db;
    const query = parseAdminProfileListQuery(new URLSearchParams(
      `tenantId=${TENANT_ID}&businessId=document-core&limit=25`,
    ));

    const page = await listAdminProfilePage(db, TENANT_ID, query);

    expect(page).toMatchObject({ rows: [], total: 0, nextCursor: null, prevCursor: null });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.sql).toContain('n.tenant_id = $1 AND n.group_id IS NULL AND n.business_id = $2');
    expect(calls[0]?.params).toEqual([TENANT_ID, 'document-core', 26]);
    expect(calls[1]?.sql).toContain('FROM profile_names n');
    expect(calls[1]?.sql).toContain('n.tenant_id = $1 AND n.group_id IS NULL AND n.business_id = $2');
    expect(calls[1]?.params).toEqual([TENANT_ID, 'document-core']);
    expect(calls[0]?.sql).not.toContain('raw_key');
  });
});
