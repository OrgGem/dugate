import { randomBytes, randomUUID } from 'node:crypto';
import { SecretCatalogCreateSchema } from '@du/contracts';
import {
  createSecretInDb,
  decryptSecretValue,
  disableSecretInDb,
  encryptSecretValue,
  listSecretsFromDb,
  resolveSecretStoreKey,
  rotateSecretInDb,
  testSecretInDb,
} from '../src/modules/secrets/secret-catalog-store';

describe('SecretCatalogStore (SC-01 / SC-03)', () => {
  const testKey = resolveSecretStoreKey('test-encryption-key-for-secrets');
  const writeGate = { assertWriteAllowed: jest.fn(async () => undefined) };

  it('encrypts and decrypts secret value correctly with AES-256-GCM', () => {
    const rawSecret = 'sk-live-synthetic-secret-value-12345';
    const encrypted = encryptSecretValue(rawSecret, testKey);

    expect(encrypted.v).toBe(1);
    expect(encrypted.alg).toBe('aes-256-gcm');
    expect(encrypted.iv).toBeDefined();
    expect(encrypted.tag).toBeDefined();
    expect(encrypted.ct).toBeDefined();
    expect(encrypted.ct).not.toContain(rawSecret);

    const decrypted = decryptSecretValue(encrypted, testKey);
    expect(decrypted).toBe(rawSecret);
  });

  it('throws on tampered ciphertext or wrong key', () => {
    const rawSecret = 'super-secret';
    const encrypted = encryptSecretValue(rawSecret, testKey);
    const wrongKey = resolveSecretStoreKey('wrong-key-value');

    expect(() => decryptSecretValue(encrypted, wrongKey)).toThrow();

    const tampered = { ...encrypted, ct: Buffer.from('tampered').toString('base64') };
    expect(() => decryptSecretValue(tampered, testKey)).toThrow();
  });

  it('createSecretInDb stores encrypted value and never returns plaintext', async () => {
    const rows: unknown[] = [];
    const mockDb = {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes('INSERT INTO secret_catalog')) {
          const row = {
            secret_id: params[0],
            tenant_id: params[1],
            name: params[2],
            purpose: params[3],
            services: params[4],
            provider_kind: params[5],
            provider_config: JSON.parse(params[6] as string),
            state: 'ACTIVE',
            revision: 1,
            encrypted_value: params[7] ? JSON.parse(params[7] as string) : null,
            created_at: new Date(),
            updated_at: new Date(),
          };
          rows.push(row);
          return { rowCount: 1, rows: [row] };
        }
        return { rowCount: 0, rows: [] };
      }),
      tx: async <T>(run: (client: { query: (sql: string, params: unknown[]) => Promise<unknown> }) => Promise<T>) =>
        run({ query: mockDb.query as never }),
    };

    const tenantId = randomUUID();
    const result = await createSecretInDb(mockDb as never, {
      tenantId,
      name: 'prod-api-key',
      purpose: 'connector.credential',
      services: ['orchestrator', 'connector'],
      provider: { kind: 'managed_value' },
      value: { kind: 'literal', value: 'secret-token-to-encrypt' },
    }, 'test-encryption-key-for-secrets', undefined, writeGate as never);

    expect(result.name).toBe('prod-api-key');
    expect(result.valueConfigured).toBe(true);
    expect((result as Record<string, unknown>).value).toBeUndefined();
    expect((result as Record<string, unknown>).plaintext).toBeUndefined();

    // Verify raw inserted row had ciphertext, NOT plaintext
    expect(rows.length).toBe(1);
    const saved = rows[0] as { encrypted_value: { ct: string } };
    expect(saved.encrypted_value.ct).toBeDefined();
    expect(JSON.stringify(saved.encrypted_value)).not.toContain('secret-token-to-encrypt');
  });

  it('fails closed for managed values without a valid default key but stores Vault references as locators', async () => {
    const previous = process.env.ENCRYPTION_KEY;
    const managed = SecretCatalogCreateSchema.parse({
      tenantId: randomUUID(),
      name: 'managed-provider-key',
      purpose: 'connector.credential',
      services: ['connector'],
      provider: { kind: 'managed_value' },
      value: { kind: 'literal', value: 'sensitive-managed-value' },
    });
    const noWriteDb = { tx: jest.fn(), query: jest.fn() };
    try {
      for (const value of [undefined, 'short-legacy-profile-key']) {
        if (value === undefined) delete process.env.ENCRYPTION_KEY;
        else process.env.ENCRYPTION_KEY = value;
        await expect(createSecretInDb(noWriteDb as never, managed, undefined, undefined, writeGate as never))
          .rejects.toMatchObject({ status: 503, code: 'SECRET_KEY_VERSION_UNAVAILABLE' });
      }
      expect(noWriteDb.tx).not.toHaveBeenCalled();

      delete process.env.ENCRYPTION_KEY;
      const vaultInput = SecretCatalogCreateSchema.parse({
        tenantId: randomUUID(),
        name: 'vault-provider-key',
        purpose: 'connector.credential',
        services: ['connector'],
        provider: {
          kind: 'vault_reference',
          connectionId: 'vault-primary',
          mount: 'secret',
          path: 'tenants/example/provider',
          field: 'api_key',
          version: { mode: 'pinned', version: 4 },
        },
      });
      let storedProviderConfig: Record<string, unknown> | undefined;
      const mockDb = {
        query: jest.fn(async (_sql: string, params: unknown[]) => {
          storedProviderConfig = JSON.parse(String(params[6])) as Record<string, unknown>;
          return {
            rowCount: 1,
            rows: [{
              secret_id: params[0], tenant_id: params[1], name: params[2], purpose: params[3], services: params[4],
              provider_kind: params[5], provider_config: storedProviderConfig, state: 'ACTIVE', revision: 1,
              encrypted_value: null, created_at: new Date(), updated_at: new Date(),
            }],
          };
        }),
        tx: async <T>(run: (client: { query: (sql: string, params: unknown[]) => Promise<unknown> }) => Promise<T>) =>
          run({ query: mockDb.query as never }),
      };
      const linked = await createSecretInDb(mockDb as never, vaultInput, undefined, undefined, writeGate as never);
      expect(linked.valueConfigured).toBe(true);
      expect(storedProviderConfig).toMatchObject({
        kind: 'vault_reference', connectionId: 'vault-primary', mount: 'secret',
        path: 'tenants/example/provider', field: 'api_key', version: { mode: 'pinned', version: 4 },
      });
      expect(JSON.stringify(storedProviderConfig)).not.toContain('sensitive-managed-value');
    } finally {
      if (previous === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = previous;
    }
  });

  it('rotateSecretInDb enforces CAS revision matching and re-encrypts', async () => {
    const secretId = randomUUID();
    const tenantId = randomUUID();
    const currentRow = {
      secret_id: secretId,
      tenant_id: tenantId,
      name: 'rotated-key',
      purpose: 'generic',
      services: ['orchestrator'],
      provider_kind: 'managed_value',
      provider_config: {},
      state: 'ACTIVE',
      revision: 1,
      encrypted_value: encryptSecretValue('old-val', testKey),
      created_at: new Date(),
      updated_at: new Date(),
    };

    const mockDb = {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes('SELECT tenant_id::text AS tenant_id FROM secret_catalog')) {
          return { rowCount: 1, rows: [{ tenant_id: tenantId }] };
        }
        if (sql.includes('SELECT * FROM secret_catalog')) {
          return { rowCount: 1, rows: [currentRow] };
        }
        if (sql.includes('UPDATE secret_catalog')) {
          const updated = {
            ...currentRow,
            revision: 2,
            encrypted_value: JSON.parse(params[1] as string),
            rotated_at: new Date(),
          };
          return { rowCount: 1, rows: [updated] };
        }
        return { rowCount: 0, rows: [] };
      }),
      tx: async <T>(run: (client: { query: (sql: string, params: unknown[]) => Promise<unknown> }) => Promise<T>) =>
        run({ query: mockDb.query as never }),
    };

    // Stale expectedRevision throws 409
    await expect(rotateSecretInDb(mockDb as never, secretId, {
      secretId,
      expectedRevision: 99,
      value: { kind: 'literal', value: 'new-val' },
    }, 'test-encryption-key-for-secrets', undefined, writeGate as never)).rejects.toThrow(/revision conflict/);

    // Matching revision rotates
    const rotated = await rotateSecretInDb(mockDb as never, secretId, {
      secretId,
      expectedRevision: 1,
      value: { kind: 'literal', value: 'new-val' },
    }, 'test-encryption-key-for-secrets', undefined, writeGate as never);

    expect(rotated.revision).toBe(2);
  });

  it('testSecretInDb probes available status for valid encrypted value', async () => {
    const secretId = randomUUID();
    const currentRow = {
      secret_id: secretId,
      tenant_id: randomUUID(),
      name: 'probe-key',
      purpose: 'generic',
      services: ['orchestrator'],
      provider_kind: 'managed_value',
      provider_config: {},
      state: 'ACTIVE',
      revision: 1,
      encrypted_value: encryptSecretValue('valid-value', testKey),
      created_at: new Date(),
      updated_at: new Date(),
    };

    const mockDb = {
      query: jest.fn(async () => ({ rowCount: 1, rows: [currentRow] })),
    };

    const probe = await testSecretInDb(mockDb as never, secretId, 'test-encryption-key-for-secrets');
    expect(probe.ok).toBe(true);
    expect(probe.status).toBe('AVAILABLE');
  });
});
