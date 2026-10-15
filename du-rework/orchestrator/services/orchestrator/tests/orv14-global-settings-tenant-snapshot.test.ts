import type { Db } from '../src/db/db';
import { createGlobalSettingsService } from '../src/modules/global-settings/service';

const BOOTSTRAP_TENANT = '00000000-0000-0000-0000-000000000001';

function fixture() {
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM global_settings_tenant_heads')) return { rowCount: 0, rows: [] };
    if (sql.includes('SELECT id FROM tenants')) return { rowCount: 1, rows: [{ id: BOOTSTRAP_TENANT }] };
    if (sql.includes('FROM global_settings_tenant_revisions')) return { rowCount: 0, rows: [] };
    throw new Error(`unexpected query in tenant snapshot fixture: ${sql}`);
  });
  const db = { query } as unknown as Db;
  const service = createGlobalSettingsService(db, { record: jest.fn() } as never);
  return { query, service };
}

describe('tenant defaults snapshot tenant identity validation', () => {
  it('accepts the canonical bootstrap tenant UUID that PostgreSQL stores', async () => {
    const { query, service } = fixture();

    const snapshot = await service.getTenantDefaultsSnapshot(BOOTSTRAP_TENANT);

    expect(snapshot).toMatchObject({ aiRevision: null, promptRevision: null });
    expect(query.mock.calls.some(([, params]) => params?.includes(BOOTSTRAP_TENANT))).toBe(true);
  });

  it('rejects malformed tenant IDs before reading tenant settings', async () => {
    const { query, service } = fixture();

    await expect(service.getTenantDefaultsSnapshot('not-a-tenant')).rejects.toMatchObject({
      status: 422,
      code: 'INVALID_SCHEMA',
      message: 'tenantId must be a UUID',
    });

    expect(query).not.toHaveBeenCalled();
  });
});
