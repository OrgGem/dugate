import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';

const DATABASE_URL =
  process.env.LOCAL01_TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
const DATABASE_NAME = new URL(DATABASE_URL).pathname.split('/').pop() ?? '';
const LIVE_MIGRATION = process.env.DU_LOCAL01_LIVE_MIGRATION === '1';
const liveDescribe = LIVE_MIGRATION ? describe : describe.skip;

if (!LIVE_MIGRATION) {
  console.warn('admin-local-users-migration.test.ts: SKIPPED - set DU_LOCAL01_LIVE_MIGRATION=1 to run the private-schema migration smoke.');
}

liveDescribe('LOCAL-01 migration in a caller-owned schema', () => {
  it('applies 0023 twice and retains the expected table and unique tenant username constraint', async () => {
    if (!/test/i.test(DATABASE_NAME)) {
      throw new Error(`refusing migration smoke against non-test database "${DATABASE_NAME}"`);
    }
    const schema = `local01_${randomBytes(8).toString('hex')}`;
    const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
    let schemaCreated = false;
    try {
      const client = await pool.connect();
      try {
        await client.query(`CREATE SCHEMA "${schema}"`);
        schemaCreated = true;
        await client.query(`SET search_path TO "${schema}", public`);
        await client.query('CREATE TABLE tenants (id uuid PRIMARY KEY)');
        const tenantId = randomUUID();
        await client.query('INSERT INTO tenants (id) VALUES ($1)', [tenantId]);
        const migration = await readFile(
          resolve(__dirname, '../migrations/0023_admin_local_users.sql'),
          'utf8'
        );

        await client.query(migration);
        await client.query(migration);

        const tables = await client.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = $1 AND table_name = 'admin_local_users'`,
          [schema]
        );
        const uniqueConstraint = await client.query<{ constraint_name: string }>(
          `SELECT constraint_name FROM information_schema.table_constraints
           WHERE table_schema = $1 AND table_name = 'admin_local_users'
             AND constraint_name = 'admin_local_users_tenant_username_unique'`,
          [schema]
        );
        expect(tables.rows).toHaveLength(1);
        expect(uniqueConstraint.rows).toHaveLength(1);
        const validHash = `scrypt$32768$8$1$${randomBytes(16).toString('base64url')}$${randomBytes(32).toString('base64url')}`;
        await client.query(
          `INSERT INTO admin_local_users (tenant_id, username_normalized, password_hash, role)
           VALUES ($1, 'smoke-admin', $2, 'admin')`,
          [tenantId, validHash]
        );
        await expect(
          client.query(
            `INSERT INTO admin_local_users (tenant_id, username_normalized, password_hash, role)
             VALUES ($1, 'plaintext-rejected', 'not-a-password-hash', 'admin')`,
            [tenantId]
          )
        ).rejects.toThrow();
      } finally {
        client.release();
      }
    } finally {
      try {
        if (schemaCreated) {
          await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
          const afterDrop = await pool.query<{ relation: string | null }>(
            'SELECT to_regclass($1) AS relation',
            [`${schema}.admin_local_users`]
          );
          expect(afterDrop.rows[0]?.relation).toBeNull();
        }
      } finally {
        await pool.end();
      }
    }
  }, 30_000);
});
