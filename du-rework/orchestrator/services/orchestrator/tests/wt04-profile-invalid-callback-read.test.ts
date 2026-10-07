import { ProfileEndpointPolicyReadSchema, ProfileEndpointPolicySchema } from '@du/contracts';
import { profileDetailPolicyRead, type ProfileDetailDbRow } from '../src/modules/admin-read/profile-detail';
import type { PoolClient } from 'pg';
import type { Db } from '../src/db/db';
import { createProfileService } from '../src/modules/profiles/profiles';

const row: ProfileDetailDbRow = {
  profile_id: '30000000-0000-4000-8000-000000000003', revision: 1,
  api_key_id: '20000000-0000-4000-8000-000000000002', enabled: true,
  parameters: {}, job_priority: 'MEDIUM', allowed_file_extensions: '',
  connections_override: [], file_url_auth_cipher: null,
};

describe('WT-04: invalid stored callback is visible and clearable without readback', () => {
  it.each([{}, 'broken-json', { version: 1, auth: { token: 'SENSITIVE_SENTINEL' } }])(
    'projects invalid stored value as null plus a read-only marker', (invalid) => {
      const policy = profileDetailPolicyRead({ ...row, callback_policy: invalid });
      expect(policy).toMatchObject({ callbackPolicy: null, callbackPolicyInvalid: true });
      expect(ProfileEndpointPolicyReadSchema.safeParse(policy).success).toBe(true);
      expect(JSON.stringify(policy)).not.toContain('SENSITIVE_SENTINEL');
    }
  );
  it.each([null, undefined])('does not confuse absent policy with invalid policy', (stored) => {
    const policy = profileDetailPolicyRead({ ...row, callback_policy: stored });
    expect(policy.callbackPolicy).toBeNull();
    expect(policy).not.toHaveProperty('callbackPolicyInvalid');
  });
  it('preserves a valid pin and emits no invalid marker', () => {
    const stored = { version: 1, mode: 'notification_only', auth: { method: 'none' } };
    expect(profileDetailPolicyRead({ ...row, callback_policy: stored }).callbackPolicy).toEqual(stored);
  });
  it('keeps explicit null clear valid and prevents the read marker entering write DTOs', () => {
    expect(ProfileEndpointPolicySchema.safeParse({ callbackPolicy: null }).success).toBe(true);
    expect(ProfileEndpointPolicySchema.safeParse({ callbackPolicy: null, callbackPolicyInvalid: true }).success).toBe(false);
  });
  it('keeps admission fail-closed for a malformed stored pin', async () => {
    const db = { query: async () => ({ rows: [{ ...row, callback_policy: {}, connector_bindings: {}, moved_at: new Date() }], rowCount: 1 }) } as unknown as Db;
    await expect(createProfileService(db).resolveEffectiveProfile(row.api_key_id, 'document-core', '1.0.0', 'extract'))
      .rejects.toMatchObject({ status: 500, code: 'INVALID_SCHEMA' });
  });
  it('real profile writer clears a malformed previous pin instead of parsing it again', async () => {
    let written: unknown[] | undefined;
    const client = { query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT id, tenant_id FROM api_keys')) return { rows: [{ id: row.api_key_id, tenant_id: '10000000-0000-4000-8000-000000000001' }], rowCount: 1 };
      if (sql.includes('SELECT max(revision)')) return { rows: [{ m: 1 }], rowCount: 1 };
      if (sql.includes('SELECT enabled, parameters')) return { rows: [{ ...row, callback_policy: { token: 'SENSITIVE_SENTINEL' } }], rowCount: 1 };
      if (sql.includes('INSERT INTO profile_bindings')) written = params;
      return { rows: [], rowCount: 1 };
    } } as unknown as PoolClient;
    const db = { tx: async (work: (c: PoolClient) => Promise<unknown>) => work(client) } as unknown as Db;
    await createProfileService(db).createRevision({ apiKeyHash: 'a'.repeat(64), profileId: row.profile_id,
      businessId: 'document-core', businessVersion: '1.0.0', action: 'extract', connectorBindings: {}, policy: { callbackPolicy: null } });
    expect(written).toBeDefined();
    expect(written?.[15]).toBeNull();
    expect(JSON.stringify(written)).not.toContain('SENSITIVE_SENTINEL');
  });
});
