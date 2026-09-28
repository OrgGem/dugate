import {
  assertNoPlaintextSecrets,
  ConnectorRevisionBindingSchema,
  ConnectorRevisionConfigSchema,
  ConnectorRevisionStateSchema,
  matchesVaultRevisionBinding,
  VaultKv2PinSchema,
  VaultKv2RefSchema,
} from '../src/vault';

/**
 * VAULT-01 offline contract tests (Qwen-2, cycle 94) — zero DB/Redis.
 * Positive: valid mount/path/key/version parse.
 * Negative: traversal, encoded separators, invalid characters, missing key,
 * unmasked plaintext headers — ALL must fail closed, and no failure message
 * may echo a secret-shaped VALUE.
 */

const VALID = {
  account: 'du-conn-openai-main',
  mount: 'secret',
  path: 'du/connector/openai/prod',
  key: 'api-key',
  version: 3,
};

describe('VaultKv2RefSchema — positive', () => {
  it('parses a fully qualified v2 pointer', () => {
    const r = VaultKv2RefSchema.safeParse(VALID);
    expect(r.success).toBe(true);
  });

  it('version is optional on a read ref (latest), REQUIRED on a pin', () => {
    const { version, ...noVersion } = VALID;
    void version;
    expect(VaultKv2RefSchema.safeParse(noVersion).success).toBe(true);
    expect(VaultKv2PinSchema.safeParse(noVersion).success).toBe(false);
    expect(VaultKv2PinSchema.safeParse(VALID).success).toBe(true);
  });

  it('dot-containing single segments are fine (only dot-dot / dot-only are not)', () => {
    expect(VaultKv2RefSchema.safeParse({ ...VALID, path: 'a.b/c_d-e/v1.2' }).success).toBe(true);
  });
});

describe('VaultKv2RefSchema — traversal & encoded separators fail closed', () => {
  it.each([
    ['dotdot prefix', { path: '../etc/passwd' }],
    ['dotdot mid', { path: 'du/../../etc' }],
    ['dotdot tail', { path: 'du/kv/..' }],
    ['dotdot in key', { key: '..' }],
    ['dotdot in mount', { mount: 'kv/../admin' }],
    ['dot-only segment', { path: 'du/./prod' }],
    ['backslash path', { path: 'du\\..\\windows' }],
    ['encoded slash lower', { path: 'du%2fconnector' }],
    ['encoded slash upper', { path: 'du%2Fconnector' }],
    ['encoded backslash', { path: 'du%5c..%5cx' }],
    ['encoded dot', { key: '%2e%2e' }],
    ['tilde home', { path: '~/.aws' }],
    ['account traversal', { account: 'du-conn/../vault' }],
  ])('rejects %s', (_label, override) => {
    expect(VaultKv2RefSchema.safeParse({ ...VALID, ...override }).success).toBe(false);
  });
});

describe('VaultKv2RefSchema — characters, shapes, bounds', () => {
  it.each(
    [
      ['space in path', { path: 'du/con n' }],
      ['tab in key', { key: 'api\tkey' }],
      ['newline in mount', { mount: 'secret\nadmin' }],
      ['leading slash', { path: '/du/x' }],
      ['trailing slash', { path: 'du/x/' }],
      ['double slash', { path: 'du//x' }],
      ['empty path', { path: '' }],
      ['empty key', { key: '' }],
      ['empty mount', { mount: '' }],
      ['uppercase account', { account: 'DU-Conn' }],
      ['underscore-start key', { key: '_api' }],
      ['non-ascii key', { key: 'api-kéy' }],
      ['long key', { key: 'k'.repeat(200) }],
      ['too many segments', { path: 'a/'.repeat(20) + 'z' }],
      ['zero version', { version: 0 }],
      ['negative version', { version: -1 }],
      ['fractional version', { version: 1.5 }],
      ['version beyond int32', { version: 2147483648 }],
      ['unknown extra field', { extra: 'x' }],
      ['missing key field', { key: undefined }],
    ] as Array<[string, Record<string, unknown>]>,
  )('rejects %s', (_label, override) => {
    const candidate: Record<string, unknown> = { ...VALID, ...override };
    if ('key' in override && override.key === undefined) delete candidate.key;
    expect(VaultKv2RefSchema.safeParse(candidate).success).toBe(false);
  });

  it('version 1 and INT32_MAX parse', () => {
    expect(VaultKv2RefSchema.safeParse({ ...VALID, version: 1 }).success).toBe(true);
    expect(VaultKv2RefSchema.safeParse({ ...VALID, version: 2147483647 }).success).toBe(true);
  });
});

describe('ConnectorRevisionStateSchema', () => {
  it('accepts the new lifecycle, rejects retired-away DISABLED', () => {
    for (const s of ['PENDING', 'ACTIVE', 'RETIRED']) {
      expect(ConnectorRevisionStateSchema.safeParse(s).success).toBe(true);
    }
    expect(ConnectorRevisionStateSchema.safeParse('DISABLED').success).toBe(false);
    expect(ConnectorRevisionStateSchema.safeParse('active').success).toBe(false);
  });
});

describe('Vault source and independent revision binding', () => {
  const binding = {
    tenantId: 'tenant-a',
    connectorId: 'openai',
    accountId: 'acct-main',
  };
  const source = {
    kind: 'vault-kv2',
    account: 'acct-main',
    mount: 'secret',
    path: 'du/tenants/tenant-a/connectors/openai/accounts/acct-main',
    key: 'api-key',
    version: 3,
  };

  it('accepts only a source matching the separately supplied revision binding', () => {
    expect(ConnectorRevisionBindingSchema.safeParse(binding).success).toBe(true);
    expect(matchesVaultRevisionBinding(source, binding)).toBe(true);
    expect(matchesVaultRevisionBinding({ ...source, kind: 'vault-kv-v2' }, binding)).toBe(true);
    expect(matchesVaultRevisionBinding(source, { ...binding, accountId: 'acct-other' })).toBe(false);
    expect(matchesVaultRevisionBinding(source, { ...binding, tenantId: 'tenant-b' })).toBe(false);
    expect(matchesVaultRevisionBinding(source, { ...binding, connectorId: 'anthropic' })).toBe(false);
    expect(matchesVaultRevisionBinding({ ...source, path: `${source.path}/nested` }, binding)).toBe(false);
  });
});

describe('ConnectorRevisionConfigSchema — plaintext secret guard', () => {
  const SECRET_VALUE = 'sk-live-' + 'Za9dKx'.repeat(4); // sentinel, must never echo
  it('accepts a benign config', () => {
    const ok = {
      baseUrl: 'https://api.example.com',
      path: '/v1/chat',
      headers: { 'content-type': 'application/json', 'x-app-tag': 'du' },
      timeoutMs: 5000,
    };
    const r = ConnectorRevisionConfigSchema.safeParse(ok);
    expect(r.success).toBe(true);
  });

  it.each([
    ['authorization', 'Bearer abc.def'],
    ['Authorization', 'bearer abc.def'],
    ['AUTHORIZATION', 'anything'],
    ['x-api-key', SECRET_VALUE],
    ['X-API-KEY', 'anything'],
    ['api-key', 'anything'],
    ['my-secret', 'anything'],
    ['token_expiry', 'anything'],
    ['password', 'anything'],
  ])('rejects header name %s', (name) => {
    const r = ConnectorRevisionConfigSchema.safeParse({
      baseUrl: 'https://api.example.com',
      headers: { [name]: SECRET_VALUE },
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    const dump = JSON.stringify(r.error.issues);
    // Fail closed WITHOUT echoing the secret-shaped value. The issue path
    // keeps the ORIGINAL header casing (names are safe to echo).
    expect(dump).not.toContain(SECRET_VALUE);
    expect(dump.toLowerCase()).toContain(name.toLowerCase());
  });

  it.each([
    ['scheme bearer', 'Bearer ' + SECRET_VALUE],
    ['openai style', SECRET_VALUE],
    ['stripe style', 'sk_test_' + 'a'.repeat(24)],
    ['github pat', 'ghp_' + 'a'.repeat(36)],
    ['aws key', 'AKIA' + 'ABCDEFGHIJKLMNOP'],
    ['pem block', '-----BEGIN RSA PRIVATE KEY-----'],
    ['inline k=v', 'user=admin password=hunter2'],
    ['jwt shaped', ('a'.repeat(48) + '.' + 'b'.repeat(24))],
  ])('rejects credential-shaped value on benign header (%s)', (_l, value) => {
    const r = ConnectorRevisionConfigSchema.safeParse({
      baseUrl: 'https://api.example.com',
      headers: { 'x-request-context': value },
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(JSON.stringify(r.error.issues)).not.toContain(value.slice(0, 12));
  });

  it('strict object blocks smuggled root-level apiKey', () => {
    const r = ConnectorRevisionConfigSchema.safeParse({
      baseUrl: 'https://api.example.com',
      apiKey: SECRET_VALUE,
    });
    expect(r.success).toBe(false);
  });

  it('assertNoPlaintextSecrets throws stable code listing names only', () => {
    expect(() =>
      assertNoPlaintextSecrets({ baseUrl: 'https://api.example.com', headers: { authorization: SECRET_VALUE } }),
    ).toThrow(/PLAINTEXT_SECRET_IN_CONFIG/);
    try {
      assertNoPlaintextSecrets({ baseUrl: 'https://api.example.com', headers: { authorization: SECRET_VALUE } });
    } catch (err) {
      const msg = String((err as Error).message);
      expect(msg).toContain('authorization');
      expect(msg).not.toContain(SECRET_VALUE);
    }
    expect(() =>
      assertNoPlaintextSecrets({ baseUrl: 'https://api.example.com', headers: { 'x-app-tag': 'ok' } }),
    ).not.toThrow();
  });
});
