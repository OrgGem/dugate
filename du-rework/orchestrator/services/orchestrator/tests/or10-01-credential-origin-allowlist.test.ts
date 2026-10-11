import { join } from 'node:path';
import type { PoolClient } from 'pg';
import type { Db } from '../src/db/db';
import { loadMigrationFiles } from '../src/db/migrations';
import { loadProfileDetail, profileDetailPolicyRead } from '../src/modules/admin-read/profile-detail';
import { loadTenantProfileDetail } from '../src/modules/admin-read/tenant-profile-detail';
import { createProfileService } from '../src/modules/profiles/profiles';

const profileId = '30000000-0000-4000-8000-000000000003';
const apiKeyId = '20000000-0000-4000-8000-000000000002';
const input = {
  profileId,
  apiKeyHash: 'a'.repeat(64),
  businessId: 'document-core',
  businessVersion: '1.0.0',
  action: 'extract',
  connectorBindings: {},
};

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function profileServiceHarness() {
  const writes: { sql: string; params: unknown[] }[] = [];
  const revisions = new Map<number, Record<string, unknown>>();
  let latestRevision = 0;
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      const sql = normalize(text);
      if (sql.includes('SELECT id, tenant_id FROM api_keys')) {
        return { rows: [{ id: apiKeyId, tenant_id: '10000000-0000-4000-8000-000000000001' }], rowCount: 1 };
      }
      if (sql.includes('SELECT max(revision) AS m')) {
        return { rows: [{ m: latestRevision }], rowCount: 1 };
      }
      if (sql.includes('FROM profile_bindings WHERE profile_id=$1 AND revision=$2')) {
        return { rows: revisions.has(Number(params[1])) ? [revisions.get(Number(params[1]))] : [], rowCount: revisions.has(Number(params[1])) ? 1 : 0 };
      }
      if (sql.startsWith('INSERT INTO profile_bindings')) {
        writes.push({ sql, params });
        const revision = Number(params[1]);
        latestRevision = revision;
        revisions.set(revision, {
          enabled: params[8],
          parameters: JSON.parse(String(params[9])),
          job_priority: params[10],
          allowed_file_extensions: params[11],
          file_url_auth_cipher: params[12],
          connections_override: JSON.parse(String(params[13])),
          request_redaction: JSON.parse(String(params[14])),
          callback_policy: params[15],
          allowed_origins: JSON.parse(String(params[16])),
        });
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PoolClient;
  const db = {
    tx: async <T>(work: (transaction: PoolClient) => Promise<T>) => work(client),
    query: client.query,
  } as unknown as Db;
  return { service: createProfileService(db), writes, db };
}

describe('OR10-01 profile binding storage and read wire', () => {
  it('persists canonical allowlists in the new immutable revision column and carries them forward', async () => {
    const harness = profileServiceHarness();
    await harness.service.createRevision({
      ...input,
      policy: { allowedOrigins: ['https://FILES.example:443/', 'https://api.example'] },
    });
    await harness.service.createRevision({ ...input, policy: { enabled: false } });

    expect(harness.writes[0]?.sql).toContain('allowed_origins');
    expect(JSON.parse(String(harness.writes[0]?.params[16]))).toEqual([
      'https://api.example',
      'https://files.example',
    ]);
    expect(JSON.parse(String(harness.writes[1]?.params[16]))).toEqual([
      'https://api.example',
      'https://files.example',
    ]);
  });

  it('rejects canonical duplicates before writing a profile revision', async () => {
    const harness = profileServiceHarness();
    await expect(harness.service.createRevision({
      ...input,
      policy: { allowedOrigins: ['https://FILES.example', 'https://files.example:443/'] },
    })).rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    expect(harness.writes).toHaveLength(0);
  });

  it('reads the pinned binding allowlist into the strict profile detail DTO without exposing malformed data', async () => {
    const row = {
      profile_id: profileId,
      revision: 2,
      api_key_id: apiKeyId,
      enabled: true,
      parameters: {},
      job_priority: 'MEDIUM',
      allowed_file_extensions: '',
      connections_override: [],
      file_url_auth_cipher: null,
      allowed_origins: ['https://FILES.example:443/'],
    };
    let selectedSql = '';
    const db = {
      query: async (sql: string) => {
        selectedSql = normalize(sql);
        return { rows: [row], rowCount: 1 };
      },
    } as unknown as Db;
    const found = await loadProfileDetail(db, 'document-core', '1.0.0', 'extract');
    expect(found.kind).toBe('found');
    expect(selectedSql).toContain('p.allowed_origins');
    if (found.kind !== 'found') throw new Error('expected profile detail row');
    expect(profileDetailPolicyRead(found.row).allowedOrigins).toEqual(['https://files.example']);

    const invalid = profileDetailPolicyRead({ ...row, allowed_origins: 'SECRET_SENTINEL' });
    expect(invalid).toMatchObject({ allowedOrigins: [], allowedOriginsInvalid: true });
    expect(JSON.stringify(invalid)).not.toContain('SECRET_SENTINEL');
  });

  it('tenant-scoped profile reads also select the allowlist from the pinned revision', async () => {
    let selectedSql = '';
    const db = {
      query: async (sql: string) => {
        selectedSql = normalize(sql);
        return { rows: [{ allowed_origins: ['https://files.example'] }], rowCount: 1 };
      },
    } as unknown as Db;
    const found = await loadTenantProfileDetail(db, 'document-core', '1.0.0', 'extract', 'tenant-1');
    expect(found.kind).toBe('found');
    expect(selectedSql).toContain('p.allowed_origins');
    if (found.kind !== 'found') throw new Error('expected tenant profile detail row');
    expect(profileDetailPolicyRead(found.row).allowedOrigins).toEqual(['https://files.example']);
  });

  it('migration 0041 is discovered with additive IF NOT EXISTS DDL', () => {
    const migrations = loadMigrationFiles(join(__dirname, '../migrations'));
    const migration = migrations.find((entry) => entry.sequence === 41);
    expect(migration?.filename).toBe('0041_profile_binding_allowed_origins.sql');
    expect(migration?.sql).toMatch(/ALTER TABLE profile_bindings\s+ADD COLUMN IF NOT EXISTS allowed_origins jsonb NOT NULL DEFAULT '\[\]'::jsonb/i);
  });
});
