import { randomBytes, randomUUID } from 'node:crypto';
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
    };

    const tenantId = randomUUID();
    const result = await createSecretInDb(mockDb as never, {
      tenantId,
      name: 'prod-api-key',
      purpose: 'connector.credential',
      services: ['orchestrator', 'connector'],
      provider: { kind: 'managed_value' },
      value: { kind: 'literal', value: 'secret-token-to-encrypt' },
    }, 'test-encryption-key-for-secrets');

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
    };

    // Stale expectedRevision throws 409
    await expect(rotateSecretInDb(mockDb as never, secretId, {
      secretId,
      expectedRevision: 99,
      value: { kind: 'literal', value: 'new-val' },
    }, 'test-encryption-key-for-secrets')).rejects.toThrow(/revision conflict/);

    // Matching revision rotates
    const rotated = await rotateSecretInDb(mockDb as never, secretId, {
      secretId,
      expectedRevision: 1,
      value: { kind: 'literal', value: 'new-val' },
    }, 'test-encryption-key-for-secrets');

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
