import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  encryptSecretValue,
  writeImportedManagedSecret,
} from '../src/modules/secrets/secret-catalog-store';
import {
  parseSecretCatalogKeyring,
  resolveManagedSecretVersion,
  resolveManagedSecretVersionBytes,
  resolveManagedSecretVersionMetadata,
  verifyManagedSecretVersion,
  type SecretCatalogKeyring,
} from '../src/modules/secrets/secret-revision-resolver';

const TENANT = randomUUID();
const SECRET_ID = randomUUID();
const KEY = randomBytes(32);
const KEYRING: SecretCatalogKeyring = { activeVersion: 'k2', keys: { k1: randomBytes(32), k2: KEY } };
const VALUE = '{"accessKeyId":"AKIA-safe-test","secretAccessKey":"private-value"}';

function mockVersionDb(overrides: Record<string, unknown> = {}) {
  const row = {
    secret_id: SECRET_ID,
    tenant_id: TENANT,
    revision: 7,
    purpose: 'storage.credential',
    services: ['orchestrator'],
    provider_kind: 'managed_value',
    state: 'ACTIVE',
    encrypted_value: encryptSecretValue(VALUE, KEY),
    encryption_key_version: 'k2',
    current_state: 'DISABLED',
    ...overrides,
  };
  return {
    row,
    query: jest.fn(async (sql: string) => {
      if (sql.includes('SELECT v.secret_id')) return { rowCount: 1, rows: [row] };
      if (sql.includes('SELECT v.tenant_id')) return { rowCount: 1, rows: [{ tenant_id: row.tenant_id }] };
      return { rowCount: 0, rows: [] };
    }),
  };
}

describe('ORV14 exact managed secret revisions', () => {
  it('requires an explicit active key version and canonical 32-byte keyring', () => {
    expect(parseSecretCatalogKeyring({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(() => parseSecretCatalogKeyring({
      DU_SECRET_CATALOG_ACTIVE_KEY_VERSION: 'k1',
    } as NodeJS.ProcessEnv)).toThrow(/configured together/);
    expect(() => parseSecretCatalogKeyring({
      DU_SECRET_CATALOG_ACTIVE_KEY_VERSION: 'k1',
      DU_SECRET_CATALOG_KEYRING_JSON: JSON.stringify({ k1: randomBytes(16).toString('base64') }),
    } as NodeJS.ProcessEnv)).toThrow(/32-byte/);
  });

  it('derives a retained production keyring from ENCRYPTION_KEY and lets explicit versions win', () => {
    const master = 'retained-orchestrator-master-key'.padEnd(64, 'x');
    const derived = parseSecretCatalogKeyring({ ENCRYPTION_KEY: master } as NodeJS.ProcessEnv);
    const expected = createHmac('sha256', Buffer.from(master, 'utf8'))
      .update('du-secret-catalog/encryption-key/v1', 'utf8')
      .digest();
    expect(derived?.activeVersion).toBe('encryption-key-v1');
    expect(derived?.keys['encryption-key-v1']).toEqual(expected);

    const explicitKey = randomBytes(32);
    const explicit = parseSecretCatalogKeyring({
      ENCRYPTION_KEY: master,
      DU_SECRET_CATALOG_ACTIVE_KEY_VERSION: 'catalog-k7',
      DU_SECRET_CATALOG_KEYRING_JSON: JSON.stringify({ 'catalog-k7': explicitKey.toString('base64') }),
    } as NodeJS.ProcessEnv);
    expect(explicit?.activeVersion).toBe('catalog-k7');
    expect(explicit?.keys['catalog-k7']).toEqual(explicitKey);
    expect(Object.keys(explicit?.keys ?? {})).toEqual(['catalog-k7']);
  });

  it('does not synthesize a managed-value key from a weak legacy profile key', () => {
    expect(parseSecretCatalogKeyring({ ENCRYPTION_KEY: 'short-key' } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('resolves a pinned old revision after current disable and returns owner metadata only', async () => {
    const db = mockVersionDb();
    const ref = `${SECRET_ID}@7`;
    await expect(resolveManagedSecretVersion(db as never, KEYRING, ref, {
      tenantId: TENANT, purpose: 'storage.credential', service: 'orchestrator',
    })).resolves.toBe(VALUE);
    await expect(resolveManagedSecretVersionBytes(db as never, KEYRING, ref, {
      tenantId: TENANT, purpose: 'storage.credential', service: 'orchestrator',
    })).resolves.toEqual(Buffer.from(VALUE));
    await expect(resolveManagedSecretVersionMetadata(db as never, KEYRING, ref, {
      purpose: 'storage.credential', service: 'orchestrator',
    })).resolves.toEqual({ ownerTenantId: TENANT });
    await expect(verifyManagedSecretVersion(db as never, KEYRING, ref, {
      tenantId: TENANT, purpose: 'storage.credential', service: 'orchestrator',
    })).resolves.toBeUndefined();
  });

  it('accepts the canonical default tenant sentinel for tenant-fenced resolution', async () => {
    const tenantId = '00000000-0000-0000-0000-000000000001';
    const db = mockVersionDb({ tenant_id: tenantId });
    await expect(resolveManagedSecretVersion(db as never, KEYRING, `${SECRET_ID}@7`, {
      tenantId, purpose: 'storage.credential', service: 'orchestrator',
    })).resolves.toBe(VALUE);
  });

  it('rejects cross-tenant, wrong-purpose, wrong-service, revoked and missing-key reads', async () => {
    const db = mockVersionDb();
    const ref = `${SECRET_ID}@7`;
    await expect(resolveManagedSecretVersion(db as never, KEYRING, ref, {
      tenantId: randomUUID(), purpose: 'storage.credential', service: 'orchestrator',
    })).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
    await expect(resolveManagedSecretVersion(db as never, KEYRING, ref, {
      tenantId: TENANT, purpose: 'maintenance.backup_encryption', service: 'orchestrator',
    })).rejects.toMatchObject({ code: 'PURPOSE_DENIED' });
    await expect(resolveManagedSecretVersion(db as never, KEYRING, ref, {
      tenantId: TENANT, purpose: 'storage.credential', service: 'connector',
    })).rejects.toMatchObject({ code: 'SERVICE_DENIED' });
    const revoked = mockVersionDb({ current_state: 'REVOKED' });
    await expect(resolveManagedSecretVersion(revoked as never, KEYRING, ref, {
      tenantId: TENANT, purpose: 'storage.credential', service: 'orchestrator',
    })).rejects.toMatchObject({ code: 'SECRET_REVOKED' });
    await expect(resolveManagedSecretVersion(db as never, undefined, ref, {
      tenantId: TENANT, purpose: 'storage.credential', service: 'orchestrator',
    })).rejects.toMatchObject({ code: 'SECRET_KEY_VERSION_UNAVAILABLE' });
    await expect(resolveManagedSecretVersion(db as never, KEYRING, 'latest', {
      tenantId: TENANT, purpose: 'storage.credential', service: 'orchestrator',
    })).rejects.toMatchObject({ code: 'INVALID_SCHEMA' });
  });

  it('imports global values only for a trusted platform actor and returns an opaque exact ref', async () => {
    const db = mockVersionDb();
    const audit = { record: jest.fn(async () => undefined) };
    const input = {
      tenantId: TENANT,
      name: 'backup-key',
      purpose: 'maintenance.backup_encryption' as const,
      services: ['orchestrator'] as const,
      value: 'sensitive-import-value',
      sourceSystem: 'legacy-import',
      sourceRecordRef: 'legacy:backup:1',
      idempotencyKey: 'legacy-import-run-001',
    };
    await expect(writeImportedManagedSecret(db as never, audit as never, input, {
      keyring: KEYRING,
      actor: { actor: 'admin', actorRole: 'tenant_operator' },
    })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(db.query).not.toHaveBeenCalled();

    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const txDb = {
      tx: async <T>(run: (client: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<T>) => run({
        query: async (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params });
          if (sql.includes('FROM secret_catalog_imports')) return { rowCount: 0, rows: [] };
          if (sql.includes('INSERT INTO secret_catalog(')) return { rowCount: 1, rows: [{
            secret_id: params[0], tenant_id: params[1], name: params[2], purpose: params[3], services: params[4],
            provider_kind: 'managed_value', provider_config: {}, state: 'ACTIVE', revision: 1,
            encrypted_value: JSON.parse(params[5] as string), encryption_key_version: params[6],
            created_at: new Date(), updated_at: new Date(),
          }] };
          return { rowCount: 1, rows: [] };
        },
      }),
    };
    const result = await writeImportedManagedSecret(txDb as never, audit as never, input, {
      keyring: KEYRING,
      actor: { actor: 'platform-admin', actorRole: 'platform' },
      backupSnapshotWriteGate: { assertWriteAllowed: jest.fn(async () => undefined) } as never,
    });
    expect(result).toEqual({ secretId: expect.any(String), revision: 1, versionRef: `${result.secretId}@1` });
    expect(JSON.stringify(calls)).not.toContain(input.value);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });
});
