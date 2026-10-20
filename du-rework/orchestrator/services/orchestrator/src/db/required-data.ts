import type { PoolClient } from 'pg';

export const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';

/** Called in a transaction while the migration session advisory lock is held. */
export async function bootstrapRequiredData(client: PoolClient): Promise<void> {
  const history = await client.query<{ version: number }>(
    "SELECT version FROM required_data_bootstrap WHERE name = 'default-tenant'",
  );
  if (history.rows.some((row) => row.version > 1)) {
    throw new Error('Required data version is newer than this image; refusing startup.');
  }
  // Preserve customized tenants; if the reserved ID is occupied, use a fresh ID.
  await client.query(
    `INSERT INTO tenants (id, name, state)
     SELECT CASE WHEN EXISTS (SELECT 1 FROM tenants WHERE id = $1::uuid)
                 THEN gen_random_uuid() ELSE $1::uuid END, 'default', 'ACTIVE'
     WHERE NOT EXISTS (SELECT 1 FROM tenants WHERE name = 'default')
     ON CONFLICT (id) DO NOTHING`,
    [DEFAULT_TENANT_ID],
  );
  await client.query(
    `INSERT INTO required_data_bootstrap (name, version) VALUES ('default-tenant', 1)
     ON CONFLICT (name) DO NOTHING`,
  );
}
