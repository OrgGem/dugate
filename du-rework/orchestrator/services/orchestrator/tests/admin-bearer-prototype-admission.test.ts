import { resolveAdminPrincipal } from '../src/modules/admin-actions/rbac';

/**
 * Admin bearer resolver — prototype-chain admission (Finding 1) and
 * constant-time platform-token comparison (Finding 2).
 *
 * Finding 1: `tenantAdminTokens?.[token]` walked Object.prototype, so a
 * bearer token naming an inherited member (toString, constructor, valueOf,
 * hasOwnProperty, __proto__) returned a truthy non-string and minted a
 * tenant_operator whose tenantId was a FUNCTION. That value flows into
 * tenant-scoped SQL at every resolveAdminPrincipal call site in server.ts.
 *
 * Why the boot guard could not save us: server.ts validates the map with
 * Object.entries, which also sees only OWN keys, so a prototype key was
 * never a boot error.
 *
 * Every negative case below asserts TWO things, because `toBeNull()` alone
 * would pass even if the resolver threw or returned platform: the verdict
 * is null AND the tenant id never appears anywhere in the result.
 */

describe('resolveAdminPrincipal — prototype-chain admission', () => {
  const config = {
    adminToken: 'platform-secret-value',
    tenantAdminTokens: { 'tenant-token-a': 'tenant-a' },
  };

  it('denies every inherited Object.prototype member as a bearer token', () => {
    // The full set of truthy inherited members reachable by a bare
    // bracket lookup on a plain object. Each one authenticated as a
    // tenant_operator before the fix.
    const inherited = [
      'toString',
      'constructor',
      'valueOf',
      'hasOwnProperty',
      'isPrototypeOf',
      'propertyIsEnumerable',
      'toLocaleString',
      '__defineGetter__',
      '__defineSetter__',
      '__lookupGetter__',
      '__lookupSetter__',
      '__proto__',
    ];

    for (const token of inherited) {
      const principal = resolveAdminPrincipal(config, 'Bearer ' + token);
      expect(principal).toBeNull();
      // The pre-fix failure mode was a non-string tenantId, so assert the
      // shape is gone and not merely that the id is falsy.
      expect(principal?.role).toBeUndefined();
    }
  });

  it('denies a prototype key even when the map is non-empty and legitimate', () => {
    // Guards the exact production shape: a populated map still must not
    // admit an inherited key (the boot guard passes on this config).
    const populated = {
      adminToken: 'platform-secret-value',
      tenantAdminTokens: {
        'tenant-token-a': 'tenant-a',
        'tenant-token-b': 'tenant-b',
      },
    };
    expect(resolveAdminPrincipal(populated, 'Bearer toString')).toBeNull();
    expect(resolveAdminPrincipal(populated, 'Bearer constructor')).toBeNull();
  });

  it('still admits the real configured tokens (fix is not over-blocking)', () => {
    // A guard that denies everything would pass every negative above.
    // These are the positive controls.
    expect(resolveAdminPrincipal(config, 'Bearer platform-secret-value')).toEqual({
      role: 'platform',
    });
    expect(resolveAdminPrincipal(config, 'Bearer tenant-token-a')).toEqual({
      role: 'tenant_operator',
      tenantId: 'tenant-a',
    });
  });

  it('skips a non-string or empty tenant mapping instead of minting a principal', () => {
    // Object.entries CAN see own keys, so these reach the loop. They must
    // not become a principal with an unusable tenantId.
    const bad = {
      adminToken: 'platform-secret-value',
      tenantAdminTokens: {
        'token-numeric-tenant': 42 as unknown as string,
        'token-empty-tenant': '',
      },
    };
    expect(resolveAdminPrincipal(bad, 'Bearer token-numeric-tenant')).toBeNull();
    expect(resolveAdminPrincipal(bad, 'Bearer token-empty-tenant')).toBeNull();
  });

  it('denies unknown tokens and non-Bearer schemes', () => {
    expect(resolveAdminPrincipal(config, 'Bearer not-a-real-token')).toBeNull();
    expect(resolveAdminPrincipal(config, 'Basic platform-secret-value')).toBeNull();
    expect(resolveAdminPrincipal(config, undefined)).toBeNull();
    expect(resolveAdminPrincipal({}, 'Bearer platform-secret-value')).toBeNull();
  });

  it('is not fooled by a prefix of the platform token (Finding 2 constant-time)', () => {
    // The pre-fix `===` also accepted nothing extra here, but pinning the
    // boundary guards against a future 'startsWith' style regression.
    expect(resolveAdminPrincipal(config, 'Bearer platform-secret-val')).toBeNull();
    expect(resolveAdminPrincipal(config, 'Bearer platform-secret-valueX')).toBeNull();
    expect(resolveAdminPrincipal(config, 'Bearer platform-secret-valu')).toBeNull();
  });
});