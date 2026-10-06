import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  createRuntimeSecretResolver,
  SecretResolutionError,
  type ManagedValueReference,
  type RuntimeSecretReference,
  type VaultReference,
} from '../src/modules/secrets/vault-resolver';

/**
 * SC-02 (SECRET-CATALOG-20261006) runtime secret resolver tests. Offline:
 * real AES-256-GCM for the managed_value leg, injected reader for the
 * vault_reference leg, virtual clock for cache behaviour.
 */

const KEY = randomBytes(32);
const SECRET_1 = 'managed-secret-SENTINEL-1';
const SECRET_2 = 'managed-secret-SENTINEL-2';
const VAULT_VALUE = 'vault-secret-SENTINEL-3';

function seal(value: string): unknown {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ciphertext.toString('base64'),
  };
}

function open(envelope: unknown): string {
  const record = envelope as { v?: unknown; iv?: string; tag?: string; ct?: string };
  if (record?.v !== 1 || typeof record.iv !== 'string' || typeof record.tag !== 'string' || typeof record.ct !== 'string') {
    throw new Error('bad envelope');
  }
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(record.ct, 'base64')), decipher.final()]).toString('utf8');
}

function managedRef(overrides: Partial<ManagedValueReference> = {}): ManagedValueReference {
  return {
    provider: 'managed_value',
    secretId: 'sec-1',
    tenantId: 'tenant-a',
    purposes: ['connector-credential', 'callback-header'],
    state: 'ACTIVE',
    revision: 1,
    ciphertext: seal(SECRET_1),
    ...overrides,
  };
}

const VALUE_TENANT_PATH = 'du/tenants/tenant-a/apps/openai/api-key';

function vaultRef(overrides: Partial<VaultReference> = {}): VaultReference {
  return {
    provider: 'vault_reference',
    secretId: 'sec-vault',
    tenantId: 'tenant-a',
    purposes: ['connector-credential'],
    state: 'ACTIVE',
    revision: 1,
    mount: 'secret',
    path: VALUE_TENANT_PATH,
    field: 'api-key',
    version: 3,
    ...overrides,
  };
}

describe('SC-02 managed_value resolution (AES-GCM envelope)', () => {
  it('decrypts, validates and caches within the TTL; invalidate forces a fresh resolve', async () => {
    let clock = 1_000;
    let decrypts = 0;
    const resolver = createRuntimeSecretResolver({
      decryptManagedValue: {
        decrypt: async ({ reference }) => { decrypts += 1; return open(reference.ciphertext); },
      },
      cacheTtlMs: 30_000,
      now: () => clock,
    });
    const context = { tenantId: 'tenant-a', purpose: 'connector-credential' };

    expect(await resolver.resolve(managedRef(), context)).toBe(SECRET_1);
    expect(await resolver.resolve(managedRef(), context)).toBe(SECRET_1);
    expect(decrypts).toBe(1);

    clock += 31_000;
    expect(await resolver.resolve(managedRef(), context)).toBe(SECRET_1);
    expect(decrypts).toBe(2);

    resolver.invalidate('sec-1');
    expect(await resolver.resolve(managedRef(), context)).toBe(SECRET_1);
    expect(decrypts).toBe(3);
  });

  it('a revision bump is a distinct cache entry and returns the rotated value', async () => {
    let decrypts = 0;
    const resolver = createRuntimeSecretResolver({
      decryptManagedValue: { decrypt: async ({ reference }) => { decrypts += 1; return open(reference.ciphertext); } },
      cacheTtlMs: 30_000,
    });
    const context = { tenantId: 'tenant-a', purpose: 'connector-credential' };
    expect(await resolver.resolve(managedRef({ ciphertext: seal(SECRET_1) }), context)).toBe(SECRET_1);
    expect(await resolver.resolve(managedRef({ revision: 2, ciphertext: seal(SECRET_2) }), context)).toBe(SECRET_2);
    expect(decrypts).toBe(2);
  });

  it('cross-tenant, wrong-purpose and inactive states fail closed before decryption', async () => {
    let decrypts = 0;
    const resolver = createRuntimeSecretResolver({
      decryptManagedValue: { decrypt: async ({ reference }) => { decrypts += 1; return open(reference.ciphertext); } },
    });
    await expect(resolver.resolve(managedRef(), { tenantId: 'tenant-b', purpose: 'connector-credential' }))
      .rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
    await expect(resolver.resolve(managedRef(), { tenantId: 'tenant-a', purpose: 'oidc-secret' }))
      .rejects.toMatchObject({ code: 'PURPOSE_DENIED' });
    await expect(resolver.resolve(managedRef({ state: 'REVOKED' }), { tenantId: 'tenant-a', purpose: 'connector-credential' }))
      .rejects.toMatchObject({ code: 'SECRET_UNAVAILABLE' });
    await expect(resolver.resolve(managedRef({ state: 'DISABLED' }), { tenantId: 'tenant-a', purpose: 'connector-credential' }))
      .rejects.toMatchObject({ code: 'SECRET_UNAVAILABLE' });
    expect(decrypts).toBe(0);
  });

  it('tampered envelope and empty values fail closed with secret-free errors', async () => {
    const resolver = createRuntimeSecretResolver({
      decryptManagedValue: {
        decrypt: async ({ reference }) => {
          if ((reference.ciphertext as { tag?: string }).tag === 'tampered') throw new Error('auth failed');
          return open(reference.ciphertext);
        },
      },
    });
    const context = { tenantId: 'tenant-a', purpose: 'connector-credential' };
    await expect(resolver.resolve(managedRef({ ciphertext: { v: 1, iv: 'x', tag: 'tampered', ct: 'y' } }), context))
      .rejects.toMatchObject({ code: 'RESOLVE_FAILED' });
    await expect(resolver.resolve(managedRef({ ciphertext: seal(SECRET_1), secretId: 'sec-empty' }), context))
      .resolves.toBe(SECRET_1);

    const emptyResolver = createRuntimeSecretResolver({
      decryptManagedValue: { decrypt: async () => '' },
    });
    let emptyError: SecretResolutionError | null = null;
    try {
      await emptyResolver.resolve(managedRef({ secretId: 'sec-empty' }), context);
    } catch (error) {
      emptyError = error as SecretResolutionError;
    }
    expect(emptyError?.code).toBe('RESOLVE_FAILED');
    expect(emptyError?.message ?? '').not.toContain(SECRET_1);
  });
});

describe('SC-02 vault_reference resolution and tenant/path isolation', () => {
  function makeVault(overrides: { value?: string } = {}) {
    const reads: Array<Record<string, unknown>> = [];
    const resolver = createRuntimeSecretResolver({
      decryptManagedValue: { decrypt: async () => SECRET_1 },
      readVaultReference: {
        read: async (input) => {
          reads.push({ ...input });
          return overrides.value === undefined ? VAULT_VALUE : overrides.value;
        },
      },
      allowedMounts: ['secret'],
      allowedPathRoots: ['du'],
      allowedNamespaces: ['team-a'],
      allowLatestVersion: false,
      cacheTtlMs: 0,
    });
    return { resolver, reads };
  }

  it('resolves an allowed tenant link with mount/path/field/version/namespace forwarded', async () => {
    const { resolver, reads } = makeVault();
    const reference = vaultRef({ namespace: 'team-a' });
    await expect(resolver.resolve(reference, { tenantId: 'tenant-a', purpose: 'connector-credential' }))
      .resolves.toBe(VAULT_VALUE);
    expect(reads).toEqual([{
      mount: 'secret',
      path: VALUE_TENANT_PATH,
      field: 'api-key',
      version: 3,
      namespace: 'team-a',
    }]);
  });

  it.each([
    ['foreign tenant path', vaultRef({ path: 'du/tenants/tenant-b/apps/openai/api-key', namespace: 'team-a' }), 'PATH_DENIED'],
    ['out-of-root path', vaultRef({ path: 'other/tenants/tenant-a/api-key', namespace: 'team-a' }), 'PATH_DENIED'],
    ['traversal segments', vaultRef({ path: 'du/tenants/tenant-a/../tenant-b/key', namespace: 'team-a' }), 'PATH_DENIED'],
    ['unlisted mount', vaultRef({ mount: 'kv-prod', namespace: 'team-a' }), 'MOUNT_DENIED'],
    ['unlisted namespace', vaultRef({ namespace: 'team-b' }), 'NAMESPACE_DENIED'],
    ['missing namespace', vaultRef({}), 'NAMESPACE_DENIED'],
  ])('%s is denied BEFORE any reader call', async (_label, reference, code) => {
    const { resolver, reads } = makeVault();
    await expect(resolver.resolve(reference, { tenantId: 'tenant-a', purpose: 'connector-credential' }))
      .rejects.toMatchObject({ name: 'SecretResolutionError', code });
    expect(reads).toHaveLength(0);
  });

  it('unpinned version requires the explicit latest-read policy', async () => {
    const strict = makeVault();
    await expect(strict.resolver.resolve(vaultRef({ version: undefined, namespace: 'team-a' }), { tenantId: 'tenant-a', purpose: 'connector-credential' }))
      .rejects.toMatchObject({ code: 'VERSION_REQUIRED' });
    expect(strict.reads).toHaveLength(0);

    const reads: Array<Record<string, unknown>> = [];
    const latestAllowed = createRuntimeSecretResolver({
      decryptManagedValue: { decrypt: async () => SECRET_1 },
      readVaultReference: { read: async (input) => { reads.push({ ...input }); return VAULT_VALUE; } },
      allowedMounts: ['secret'],
      allowedPathRoots: ['du'],
      allowLatestVersion: true,
    });
    await expect(latestAllowed.resolve(vaultRef({ version: undefined }), { tenantId: 'tenant-a', purpose: 'connector-credential' }))
      .resolves.toBe(VAULT_VALUE);
    expect(reads[0]!.version).toBeUndefined();
  });

  it('reader outage fails closed without a fallback value', async () => {
    const resolver = createRuntimeSecretResolver({
      decryptManagedValue: { decrypt: async () => SECRET_1 },
      readVaultReference: { read: async () => { throw new Error('vault 503 with body'); } },
      allowedMounts: ['secret'],
      allowedPathRoots: ['du'],
      allowLatestVersion: true,
    });
    const error = await resolver.resolve(vaultRef(), { tenantId: 'tenant-a', purpose: 'connector-credential' })
      .then(() => null, (e: unknown) => e as SecretResolutionError);
    expect(error?.code).toBe('RESOLVE_FAILED');
    expect(error?.message ?? '').not.toContain(VAULT_VALUE);
    expect(error?.message ?? '').not.toContain('503');
  });

  it('no vault reader configured fails closed for vault references', async () => {
    const resolver = createRuntimeSecretResolver({
      decryptManagedValue: { decrypt: async () => SECRET_1 },
      allowedMounts: ['secret'],
    });
    await expect(resolver.resolve(vaultRef(), { tenantId: 'tenant-a', purpose: 'connector-credential' }))
      .rejects.toMatchObject({ code: 'RESOLVE_FAILED' });
  });
});

describe('SC-02 probe and cache invalidation surface', () => {
  it('probe never returns the value and reports typed error codes', async () => {
    const resolver = createRuntimeSecretResolver({
      decryptManagedValue: { decrypt: async () => SECRET_1 },
      readVaultReference: { read: async () => VAULT_VALUE },
      allowedMounts: ['secret'],
      allowedPathRoots: ['du'],
    });
    expect(await resolver.probe(managedRef(), { tenantId: 'tenant-a', purpose: 'connector-credential' })).toEqual({ ok: true });
    const denied = await resolver.probe(managedRef(), { tenantId: 'tenant-b', purpose: 'connector-credential' });
    expect(denied).toEqual({ ok: false, errorCode: 'TENANT_MISMATCH' });
    expect(await resolver.probe(vaultRef({ namespace: 'team-a' }), { tenantId: 'tenant-a', purpose: 'connector-credential' }))
      .toEqual({ ok: true });

    const noVault = createRuntimeSecretResolver({
      decryptManagedValue: { decrypt: async () => SECRET_1 },
      allowedMounts: ['secret'],
      allowedPathRoots: ['du'],
    });
    const unconfigured = await noVault.probe(vaultRef(), { tenantId: 'tenant-a', purpose: 'connector-credential' });
    expect(unconfigured).toEqual({ ok: false, errorCode: 'RESOLVE_FAILED' });
  });

  it('invalidateAll drops every cached generation after a global revocation sweep', async () => {
    let decrypts = 0;
    const resolver = createRuntimeSecretResolver({
      decryptManagedValue: { decrypt: async ({ reference }) => { decrypts += 1; return open(reference.ciphertext); } },
      cacheTtlMs: 60_000,
    });
    const context = { tenantId: 'tenant-a', purpose: 'connector-credential' };
    await resolver.resolve(managedRef(), context);
    await resolver.resolve(managedRef({ secretId: 'sec-2', ciphertext: seal(SECRET_2) }), context);
    resolver.invalidateAll();
    await resolver.resolve(managedRef(), context);
    await resolver.resolve(managedRef({ secretId: 'sec-2', ciphertext: seal(SECRET_2) }), context);
    expect(decrypts).toBe(4);
  });
});

describe('SC-02 reference validation', () => {
  it('malformed references fail with INVALID_REFERENCE', async () => {
    const resolver = createRuntimeSecretResolver({ decryptManagedValue: { decrypt: async () => SECRET_1 } });
    const context = { tenantId: 'tenant-a', purpose: 'connector-credential' };
    await expect(resolver.resolve({ provider: 'managed_value', secretId: '', tenantId: 'tenant-a', purposes: ['x'], state: 'ACTIVE', revision: 1, ciphertext: {} } as RuntimeSecretReference, context))
      .rejects.toMatchObject({ code: 'INVALID_REFERENCE' });
    await expect(resolver.resolve({ ...managedRef(), revision: 0 }, context))
      .rejects.toMatchObject({ code: 'INVALID_REFERENCE' });
    await expect(resolver.resolve({ ...managedRef(), state: 'BROKEN' as never }, context))
      .rejects.toMatchObject({ code: 'INVALID_REFERENCE' });
  });
});
