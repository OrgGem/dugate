import { assertProviderTestRevisionAccess, isPlatformAdminProviderTestActor } from '../src/modules/connectors/provider-test';

describe('pending Connector provider-test role boundary', () => {
  it('admits a validated local ADMIN and a platform bearer', () => {
    expect(isPlatformAdminProviderTestActor({
      kind: 'cookie', role: 'admin', csrfOk: true,
      tenantId: 'aaaaaaaa-1111-4111-8111-111111111111',
      principalId: 'bbbbbbbb-2222-4222-8222-222222222222', issuer: 'du-local', roleVersion: 4,
    })).toBe(true);
    expect(isPlatformAdminProviderTestActor({ kind: 'bearer', principal: { role: 'platform' } })).toBe(true);
  });

  it('denies a local USER, a tenant principal and a viewer', () => {
    expect(isPlatformAdminProviderTestActor({
      kind: 'cookie', role: 'operator', csrfOk: true,
      tenantId: 'aaaaaaaa-1111-4111-8111-111111111111',
      principalId: 'bbbbbbbb-2222-4222-8222-222222222222', issuer: 'du-local', roleVersion: 4,
    })).toBe(false);
    expect(isPlatformAdminProviderTestActor({
      kind: 'bearer', principal: { role: 'tenant_operator', tenantId: 'aaaaaaaa-1111-4111-8111-111111111111' },
    })).toBe(false);
    expect(isPlatformAdminProviderTestActor({ kind: 'cookie', role: 'viewer', csrfOk: true })).toBe(false);
  });

  it('allows a local ADMIN to test a PENDING candidate and denies local USER candidate tests', () => {
    const localAdmin = {
      kind: 'cookie' as const, role: 'admin' as const, csrfOk: true,
      tenantId: 'aaaaaaaa-1111-4111-8111-111111111111',
      principalId: 'bbbbbbbb-2222-4222-8222-222222222222', issuer: 'du-local', roleVersion: 4,
    };
    const localUser = {
      kind: 'cookie' as const, role: 'operator' as const, csrfOk: true,
      tenantId: 'aaaaaaaa-1111-4111-8111-111111111111',
      principalId: 'bbbbbbbb-2222-4222-8222-222222222222', issuer: 'du-local', roleVersion: 4,
    };
    expect(() => assertProviderTestRevisionAccess(localAdmin, { revisionState: 'PENDING', bindingSlot: 'primary' })).not.toThrow();
    expect(() => assertProviderTestRevisionAccess(localUser, { revisionState: 'PENDING', bindingSlot: 'primary' }))
      .toThrow('only platform Admin can test a pending Connector revision');
  });
});
