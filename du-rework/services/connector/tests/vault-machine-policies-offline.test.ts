import { SecretResolver, assertVaultAccountPrefix, type CredentialSource } from '../src/vault/resolver';
import { ConnectorError } from '../src/errors';
import { createVaultDevFixture, type VaultDevFixture, type VaultToken } from '../../../packages/contracts/tests/stubs/vault-dev-fixture';

const TENANT = 'tenant-a';
const CONNECTOR = 'openai';
const ACCOUNT = 'acct-openai-main';
const PATH = `du/tenants/${TENANT}/connectors/${CONNECTOR}/accounts/${ACCOUNT}`;
const SCOPE = [{ mount: 'secret', pathPrefix: PATH }] as const;

function source(overrides: Partial<Extract<CredentialSource, { kind: 'vault-kv2' }>> = {}): Extract<CredentialSource, { kind: 'vault-kv2' }> {
  return {
    kind: 'vault-kv2',
    account: ACCOUNT,
    mount: 'secret',
    path: PATH,
    key: 'api-key',
    version: 1,
    ...overrides,
  };
}

function fixture(): VaultDevFixture {
  return createVaultDevFixture({ scopes: SCOPE, tokenTtlMs: 1_000 });
}

describe('VAULT-02 machine identity policy separation', () => {
  it('writer can CAS write and metadata-read but cannot read plaintext; reader is read-only', async () => {
    const fx = fixture();
    const writer = fx.login('orchestrator-writer');
    const reader = fx.login('connector-reader');

    await expect(fx.write({ token: writer, ...source(), value: 'secret-value', cas: 0 })).resolves.toEqual({ version: 1 });
    await expect(fx.readMetadata({ token: writer, mount: 'secret', path: PATH })).resolves.toMatchObject({ current_version: 1 });
    await expect(fx.read({ token: writer, mount: 'secret', path: PATH, version: 1, key: 'api-key' }))
      .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(fx.read({ token: reader, mount: 'secret', path: PATH, version: 1, key: 'api-key' }))
      .resolves.toMatchObject({ value: 'secret-value', version: 1 });
    await expect(fx.write({ token: reader, ...source(), value: 'reader-must-not-write', cas: 1 }))
      .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it.each([
    ['foreign tenant', `du/tenants/tenant-b/connectors/${CONNECTOR}/accounts/${ACCOUNT}`],
    ['foreign account', `du/tenants/${TENANT}/connectors/${CONNECTOR}/accounts/acct-other`],
    ['sibling prefix', `${PATH}-foreign`],
    ['traversal', `${PATH}/../acct-other`],
    ['nested traversal', `du/tenants/${TENANT}/connectors/${CONNECTOR}/accounts/../other`],
  ])('denies %s for both machine identities', async (_label, path) => {
    const fx = fixture();
    const writer = fx.login('orchestrator-writer');
    const reader = fx.login('connector-reader');
    await expect(fx.write({ token: writer, mount: 'secret', path, key: 'api-key', value: 'x', cas: 0 }))
      .rejects.toMatchObject({ code: 'PREFIX_DENIED' });
    await expect(fx.read({ token: reader, mount: 'secret', path, version: 1, key: 'api-key' }))
      .rejects.toMatchObject({ code: 'PREFIX_DENIED' });
  });

  it('rejects foreign/traversal sources before a connector Vault read or provider call', async () => {
    const fx = fixture();
    const reader = fx.login('connector-reader');
    let vaultReads = 0;
    let providerCalls = 0;
    const resolver = new SecretResolver({
      kv2: {
        async readSecret(input) {
          vaultReads += 1;
          const result = await fx.read({ token: reader, ...input });
          return 'value' in result ? result.value : undefined;
        },
      },
    });
    const resolveForConnector = async (candidate: CredentialSource) => {
      if (candidate.kind !== 'vault-kv2') throw new ConnectorError('CREDENTIAL_INVALID', 'not vault');
      assertVaultAccountPrefix(candidate, { tenantId: TENANT, connectorId: CONNECTOR });
      const resolved = await resolver.resolve(candidate);
      providerCalls += 1;
      return resolved;
    };

    await expect(resolveForConnector(source({ path: `du/tenants/tenant-b/connectors/${CONNECTOR}/accounts/${ACCOUNT}` })))
      .rejects.toMatchObject({ code: 'BINDING_DENIED' });
    await expect(resolveForConnector(source({ path: `${PATH}/../acct-other` })))
      .rejects.toMatchObject({ code: 'BINDING_DENIED' });
    expect(vaultReads).toBe(0);
    expect(providerCalls).toBe(0);
  });

  it('expired or revoked machine tokens fail closed and renewal requires a fresh lease', async () => {
    const fx = fixture();
    const token: VaultToken = fx.login('connector-reader');
    fx.advance(1_001);
    expect(() => fx.renew(token.id)).toThrow(expect.objectContaining({ code: 'TOKEN_EXPIRED' }));
    await expect(fx.read({ token, mount: 'secret', path: PATH, version: 1, key: 'api-key' }))
      .rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
    const fresh = fx.login('connector-reader');
    fx.revoke(fresh.id);
    await expect(fx.read({ token: fresh, mount: 'secret', path: PATH, version: 1, key: 'api-key' }))
      .rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('worker and browser identities cannot obtain Vault tokens', () => {
    const fx = fixture();
    expect(() => fx.login('worker')).toThrow(expect.objectContaining({ code: 'NO_VAULT_IDENTITY' }));
    expect(() => fx.login('browser')).toThrow(expect.objectContaining({ code: 'NO_VAULT_IDENTITY' }));
  });
});
