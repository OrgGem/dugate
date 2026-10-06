/**
 * SC-01 — secret catalog contracts: strictness, ValueSource integrity and the
 * no-plaintext-readback rules.
 */
import {
  LiteralValueSourceReadSchema,
  SecretCatalogCreateSchema,
  SecretCatalogDisableSchema,
  SecretCatalogEntryReadSchema,
  SecretCatalogEntrySchema,
  SecretCatalogListPageSchema,
  SecretCatalogRotateSchema,
  SecretRefReadMetadataSchema,
  SECRET_LITERAL_MAX_CHARS,
  SecretProviderSchema,
  VaultReferenceProviderSchema,
  ValueSourceParseError,
  ValueSourceReadSchema,
  ValueSourceSchema,
  isValueSource,
  parseValueSourceStrict,
} from '../src/secret-catalog';

const SECRET_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const literal = { kind: 'literal' as const, value: 'super-secret-value' };
const secretRef = { kind: 'secret_ref' as const, secretId: SECRET_ID };

const vaultProvider = {
  kind: 'vault_reference' as const,
  connectionId: 'vault-prod',
  mount: 'kv',
  path: 'tenants/acme/extract/api-key',
  field: 'value',
  version: { mode: 'pinned' as const, version: 3 },
};

const managedEntry = {
  catalogVersion: 1,
  secretId: SECRET_ID,
  tenantId: TENANT_ID,
  name: 'Acme extractor key',
  purpose: 'connector.credential',
  services: ['orchestrator', 'connector'],
  provider: { kind: 'managed_value' },
  state: 'ACTIVE',
  revision: 1,
};

describe('SC-01 ValueSource union', () => {
  it('accepts only tagged objects and both branches parse', () => {
    expect(ValueSourceSchema.safeParse(literal).success).toBe(true);
    expect(ValueSourceSchema.safeParse(secretRef).success).toBe(true);
    expect(ValueSourceSchema.safeParse({ ...literal, extra: 1 }).success).toBe(false);
    expect(ValueSourceSchema.safeParse({ kind: 'secret_ref' }).success).toBe(false);
    expect(isValueSource(literal)).toBe(true);
    expect(isValueSource('vault://kv/tenants/acme')).toBe(false);
  });

  it('rejects ambiguous strings and implicit vault:// parsing with a typed error', () => {
    for (const ambiguous of ['vault://kv/tenants/acme/extract', 'plain-looking-secret', '']) {
      try {
        parseValueSourceStrict(ambiguous);
        throw new Error('expected parseValueSourceStrict to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ValueSourceParseError);
        expect((error as ValueSourceParseError).code).toBe('AMBIGUOUS_STRING');
      }
    }
    expect(parseValueSourceStrict(literal)).toEqual(literal);
    let invalid: unknown;
    try {
      parseValueSourceStrict({ kind: 'literal', value: '' });
    } catch (error) {
      invalid = error;
    }
    expect((invalid as ValueSourceParseError).code).toBe('INVALID_VALUE_SOURCE');
  });

  it('bounds literal values and rejects NUL', () => {
    expect(ValueSourceSchema.safeParse({ kind: 'literal', value: 'x'.repeat(SECRET_LITERAL_MAX_CHARS) }).success).toBe(true);
    expect(ValueSourceSchema.safeParse({ kind: 'literal', value: 'x'.repeat(SECRET_LITERAL_MAX_CHARS + 1) }).success).toBe(false);
    expect(ValueSourceSchema.safeParse({ kind: 'literal', value: 'a\u0000b' }).success).toBe(false);
  });
});

describe('SC-01 no plaintext readback', () => {
  it('literal readback carries configured=true and never a value', () => {
    expect(LiteralValueSourceReadSchema.safeParse({ kind: 'literal', configured: true }).success).toBe(true);
    expect(LiteralValueSourceReadSchema.safeParse({ kind: 'literal', configured: false }).success).toBe(false);
    expect(LiteralValueSourceReadSchema.safeParse({ kind: 'literal', value: 'leaked' }).success).toBe(false);
  });

  it('secret-ref readback is safe metadata only (name/state/revision)', () => {
    const read = { kind: 'secret_ref', secretId: SECRET_ID, name: 'Acme key', state: 'ACTIVE', revision: 2 };
    expect(SecretRefReadMetadataSchema.safeParse(read).success).toBe(true);
    expect(SecretRefReadMetadataSchema.safeParse({ ...read, value: 'leaked' }).success).toBe(false);
    expect(SecretRefReadMetadataSchema.safeParse({ ...read, secret: 'leaked' }).success).toBe(false);
    expect(ValueSourceReadSchema.safeParse({ kind: 'secret_ref', secretId: SECRET_ID }).success).toBe(false);
  });

  it('entry read projection refuses a payload carrying a value key', () => {
    const read = {
      ...managedEntry,
      valueConfigured: true,
      usageReferences: [{ kind: 'connector_credential', refId: 'connector-1@3' }],
    };
    expect(SecretCatalogEntryReadSchema.safeParse(read).success).toBe(true);
    expect(SecretCatalogEntryReadSchema.safeParse({ ...read, value: 'leaked' }).success).toBe(false);
    expect(SecretCatalogEntryReadSchema.safeParse({ ...read, plaintext: 'leaked' }).success).toBe(false);
  });

  it('the stored entry itself has no value member', () => {
    expect(SecretCatalogEntrySchema.safeParse(managedEntry).success).toBe(true);
    expect(SecretCatalogEntrySchema.safeParse({ ...managedEntry, value: 'leaked' }).success).toBe(false);
  });
});

describe('SC-01 Vault reference locator', () => {
  it('accepts pinned and latest version modes', () => {
    expect(VaultReferenceProviderSchema.safeParse(vaultProvider).success).toBe(true);
    expect(
      SecretProviderSchema.safeParse({ ...vaultProvider, version: { mode: 'latest' } }).success,
    ).toBe(true);
    expect(SecretProviderSchema.safeParse({ ...vaultProvider, version: { mode: 'newest' } }).success).toBe(false);
  });

  it('rejects scheme strings, traversal, absolute or empty paths and bad segments', () => {
    for (const path of [
      'vault://kv/tenants/acme',
      '/absolute/path',
      'tenants/../platform',
      'tenants//acme',
      'tenants/acme//value',
      'tenants/\u0000/acme',
    ]) {
      expect(VaultReferenceProviderSchema.safeParse({ ...vaultProvider, path }).success).toBe(false);
    }
    expect(VaultReferenceProviderSchema.safeParse({ ...vaultProvider, field: 'a/b' }).success).toBe(false);
    expect(VaultReferenceProviderSchema.safeParse({ ...vaultProvider, mount: 'kv/prod' }).success).toBe(false);
    expect(VaultReferenceProviderSchema.safeParse({ ...vaultProvider, connectionId: '' }).success).toBe(false);
  });
});

describe('SC-01 catalog entry rules', () => {
  it('requires tenant/purpose/services/state/revision and unique services', () => {
    expect(SecretCatalogEntrySchema.safeParse({ ...managedEntry, tenantId: 'tenant-a' }).success).toBe(false);
    expect(SecretCatalogEntrySchema.safeParse({ ...managedEntry, purpose: 'root' }).success).toBe(false);
    expect(SecretCatalogEntrySchema.safeParse({ ...managedEntry, services: [] }).success).toBe(false);
    expect(SecretCatalogEntrySchema.safeParse({ ...managedEntry, services: ['orchestrator', 'orchestrator'] }).success).toBe(false);
    expect(SecretCatalogEntrySchema.safeParse({ ...managedEntry, state: 'EXPIRED' }).success).toBe(false);
    expect(SecretCatalogEntrySchema.safeParse({ ...managedEntry, revision: 0 }).success).toBe(false);
    expect(SecretCatalogEntrySchema.safeParse({ ...managedEntry, name: 'bad\nname' }).success).toBe(false);
  });

  it('represents a vault link and rotation metadata without any value', () => {
    const linked = {
      ...managedEntry,
      provider: vaultProvider,
      rotation: { rotatedAt: null, intervalDays: 90 },
    };
    expect(SecretCatalogEntrySchema.safeParse(linked).success).toBe(true);
  });
});

describe('SC-01 create / rotate / disable / list DTOs', () => {
  it('managed_value create requires the write-only literal; vault link forbids it', () => {
    const createManaged = {
      tenantId: TENANT_ID,
      name: 'Acme key',
      purpose: 'connector.credential',
      services: ['connector'],
      provider: { kind: 'managed_value' },
      value: literal,
    };
    expect(SecretCatalogCreateSchema.safeParse(createManaged).success).toBe(true);
    expect(SecretCatalogCreateSchema.safeParse({ ...createManaged, value: undefined }).success).toBe(false);
    const link = {
      tenantId: TENANT_ID,
      name: 'Linked key',
      purpose: 'source.auth',
      services: ['orchestrator'],
      provider: vaultProvider,
    };
    expect(SecretCatalogCreateSchema.safeParse(link).success).toBe(true);
    expect(SecretCatalogCreateSchema.safeParse({ ...link, value: literal }).success).toBe(false);
  });

  it('rotation is CAS-guarded and literal-only; disable carries a reason', () => {
    expect(
      SecretCatalogRotateSchema.safeParse({ secretId: SECRET_ID, expectedRevision: 2, value: literal }).success,
    ).toBe(true);
    expect(
      SecretCatalogRotateSchema.safeParse({ secretId: SECRET_ID, expectedRevision: 0, value: literal }).success,
    ).toBe(false);
    expect(
      SecretCatalogRotateSchema.safeParse({ secretId: SECRET_ID, expectedRevision: 1, value: secretRef }).success,
    ).toBe(false);
    expect(
      SecretCatalogRotateSchema.safeParse({ secretId: SECRET_ID, expectedRevision: 1, value: literal, plaintext: 'x' }).success,
    ).toBe(false);
    expect(
      SecretCatalogDisableSchema.safeParse({ secretId: SECRET_ID, expectedRevision: 1, reason: 'key leaked' }).success,
    ).toBe(true);
    expect(SecretCatalogDisableSchema.safeParse({ secretId: SECRET_ID, expectedRevision: 1 }).success).toBe(false);
  });

  it('list pages are bounded and cursor-only', () => {
    expect(
      SecretCatalogListPageSchema.safeParse({ items: [], nextCursor: null }).success,
    ).toBe(true);
    const tooMany = Array.from({ length: 201 }, () => ({
      ...managedEntry,
      valueConfigured: true,
      usageReferences: [],
    }));
    expect(SecretCatalogListPageSchema.safeParse({ items: tooMany, nextCursor: null }).success).toBe(false);
    expect(SecretCatalogListPageSchema.safeParse({ items: [], nextCursor: null, total: 0 }).success).toBe(false);
  });
});
