/**
 * AWEB-02b — focused test for `TENANT_ADMIN_TOKENS_BY_TENANT` parsing in main.ts.
 *
 * The env is a JSON object keyed by TENANT ID with the bearer token as value
 * (mirrors WORKER_IDENTITY_TOKENS_BY_BUSINESS); ServerConfig consumes the
 * REVERSE map (token -> tenantId). Importing `../src/main` must NOT boot the
 * orchestrator: its entry is `require.main`-guarded, so if that guard
 * regresses this suite would die on the missing DATABASE_URL — the import
 * below is itself an assertion of that property.
 */
import { tenantAdminTokensFromEnv } from '../src/main';

const ENV = 'TENANT_ADMIN_TOKENS_BY_TENANT';

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env[ENV];
  if (value === undefined) delete process.env[ENV];
  else process.env[ENV] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  }
}

describe('AWEB-02b TENANT_ADMIN_TOKENS_BY_TENANT', () => {
  it('missing env -> undefined (feature stays off, no default changes)', () => {
    withEnv(undefined, () => {
      expect(tenantAdminTokensFromEnv()).toBeUndefined();
    });
    withEnv('', () => {
      expect(tenantAdminTokensFromEnv()).toBeUndefined();
    });
  });

  it('valid map -> reversed token -> tenantId map (ServerConfig contract)', () => {
    withEnv('{"tenant-a":"tok-a","tenant-b":"tok-b"}', () => {
      expect(tenantAdminTokensFromEnv()).toEqual({ 'tok-a': 'tenant-a', 'tok-b': 'tenant-b' });
    });
  });

  it('empty object -> {} (no tenants configured, no throw)', () => {
    withEnv('{}', () => {
      expect(tenantAdminTokensFromEnv()).toEqual({});
    });
  });

  it('malformed JSON -> throws naming the env var', () => {
    withEnv('{"tenant-a":', () => {
      expect(() => tenantAdminTokensFromEnv()).toThrow(/TENANT_ADMIN_TOKENS_BY_TENANT/);
    });
  });

  it('non-object JSON (array / string / null / number) -> throws', () => {
    for (const raw of ['["tenant-a"]', '"tenant-a"', 'null', '42']) {
      withEnv(raw, () => {
        expect(() => tenantAdminTokensFromEnv()).toThrow(/must be a JSON object/);
      });
    }
  });

  it('empty tenant id or empty/non-string token -> throws', () => {
    withEnv('{"":"tok"}', () => {
      expect(() => tenantAdminTokensFromEnv()).toThrow(/tenant IDs must be non-empty/);
    });
    withEnv('{"tenant-a":""}', () => {
      expect(() => tenantAdminTokensFromEnv()).toThrow(/non-empty string/);
    });
    withEnv('{"tenant-a":123}', () => {
      expect(() => tenantAdminTokensFromEnv()).toThrow(/non-empty string/);
    });
    withEnv('{"tenant-a":{"nested":true}}', () => {
      expect(() => tenantAdminTokensFromEnv()).toThrow(/non-empty string/);
    });
  });

  it('same token for two tenants -> throws, without echoing the token', () => {
    withEnv('{"tenant-a":"shared-secret","tenant-b":"shared-secret"}', () => {
      let message = '';
      try {
        tenantAdminTokensFromEnv();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/same token to multiple tenants/);
      expect(message).not.toContain('shared-secret');
    });
  });

  it('a __proto__ token becomes an own entry and does not pollute the prototype', () => {
    withEnv('{"tenant-x":"__proto__"}', () => {
      const result = tenantAdminTokensFromEnv();
      expect(result).toBeDefined();
      const entries = Object.entries(result!);
      expect(entries).toContainEqual(['__proto__', 'tenant-x']);
      expect(Object.getPrototypeOf(result!)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>)['tenant-x']).toBeUndefined();
    });
  });
});
