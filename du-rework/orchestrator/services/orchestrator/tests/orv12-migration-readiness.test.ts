import type { Db } from '../src/db/db';
import { readMigrationReadiness } from '../src/modules/legacy-migration/readiness';
import { createAdminLocalCredentialReader } from '../src/modules/auth/admin-local/credential-reader';

describe('ORV12 readiness and migrated credential fence', () => {
  test('readiness binds query tenant and strips report bodies/config/credential content', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ source_version:'fixture',source_sha256:'a'.repeat(64),plan_sha256:'b'.repeat(64),created_at:new Date(),source_counts:{User:1},destination_counts:{admin_local_users:1},inventory_sha256:'c'.repeat(64),recorded_at:new Date(),report:{targetCounts:{users:1},issues:[{code:'LOCAL_IDENTITY_ACTIVATION_REQUIRED',secret:'hidden'}],blobChecks:[],password:'hidden',settings:{api_secret_key:'hidden'}} }] });
    const tenant = '10000000-0000-4000-8000-000000000001';
    const result = await readMigrationReadiness({query} as unknown as Db, tenant);
    expect(query.mock.calls[0]?.[1]).toEqual([tenant]);
    expect(result.runs[0]?.status).toBe('RECONCILIATION_REQUIRED');
    expect(result.runs[0]?.cutoverReady).toBe(false);
    expect(JSON.stringify(result)).not.toContain('hidden');
  });
  test('credential reader excludes reset-required identities even if accidentally enabled/unlocked', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const result = await createAdminLocalCredentialReader({query} as unknown as Db).findByLogin('user');
    expect(query.mock.calls[0]?.[0]).toContain('legacy_password_reset_required = false');
    expect(result).toBeNull();
  });
});
