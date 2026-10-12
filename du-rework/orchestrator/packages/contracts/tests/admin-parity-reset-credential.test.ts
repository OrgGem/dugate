import { IdentityUserSchema } from '../src/identity';
import { ConnectorCredentialChangeSchema } from '../src/parity';

describe('admin parity reset and credential reference contracts', () => {
  const user = {
    id: '22222222-2222-4222-8222-222222222222',
    username: 'legacy-user',
    role: 'USER',
    enabled: false,
    locked: false,
    createdAt: '2026-10-11T00:00:00.000Z',
    updatedAt: '2026-10-11T00:00:00.000Z',
    version: 1,
  };

  it('defaults older Identity payloads to no pending reset and exposes only the safe marker', () => {
    expect(IdentityUserSchema.parse(user).legacyPasswordResetRequired).toBe(false);
    expect(IdentityUserSchema.parse({ ...user, legacyPasswordResetRequired: true }).legacyPasswordResetRequired).toBe(true);
    expect(IdentityUserSchema.safeParse({ ...user, passwordHash: 'secret' }).success).toBe(false);
  });

  it('accepts only an opaque Secret Catalog UUID for an imported Vault credential', () => {
    expect(ConnectorCredentialChangeSchema.safeParse({
      action: 'vault-ref',
      reference: '66666666-6666-4666-8666-666666666666',
    }).success).toBe(true);
    expect(ConnectorCredentialChangeSchema.safeParse({ action: 'vault-ref', reference: 'vault/path/secret' }).success).toBe(false);
  });
});
