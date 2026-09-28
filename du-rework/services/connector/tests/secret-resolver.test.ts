import { createVaultDevFixture, VaultError, type VaultDevFixture } from '../../../packages/contracts/tests/stubs/vault-dev-fixture';
import {
  applyCredentialSlot,
  parseCredentialSource,
  SecretResolver,
  type CredentialSource,
  type VaultKv2SecretReader,
} from '../src/vault/resolver';
import { ConnectorError } from '../src/errors';
import { DurableConnectorManagement } from '../src/services';
import type { ConnectorConfigRepository, ConnectorRevision } from '../src/db/repository';
import type { AdapterRegistry } from '../src/adapters/registry';
import type { AdapterConfig } from '../src/types';
import { AesCredentialCipher } from '../src/services';
import { randomBytes } from 'node:crypto';

/**
 * VAULT-05 offline unit tests (Qwen-2, cycle 96) — zero DB/Redis/network.
 * Uses the VAULT-02 VaultDevFixture as the KV v2 backend behind a
 * connector-reader machine identity, plus a Map-based fake legacy store.
 * Provider calls are modeled as "executed only after resolve() succeeds",
 * so every CREDENTIAL_INVALID case asserts call count === 0 (SEC-05).
 */

const ALLOW = { mount: 'secret', path: 'du/tenants/tenant-a/connectors/openai/accounts/du-conn-openai-main' };
const TEST_SCOPES = [{ mount: 'secret', pathPrefix: 'du/tenants/tenant-a/connectors/openai/accounts' }];
const V1 = 'sk-live-V1a-vaultunit-' + 'a'.repeat(16);
const V2 = 'sk-live-V2b-vaultunit-' + 'b'.repeat(16);
const ALT = 'sk-live-ALT-vaultunit-' + 'c'.repeat(16);

function bridgeReader(fx: VaultDevFixture, actor: 'connector-reader' | 'orchestrator-writer'): VaultKv2SecretReader {
  let token = fx.login(actor);
  const raw = async (input: { account: string; mount: string; path: string; key: string; version: number }): Promise<unknown> => {
    const call = () =>
      fx.read({
        token,
        mount: input.mount,
        path: input.path,
        key: input.key,
        ...(input.version === undefined ? {} : { version: input.version }),
      });
    try {
      const r = await call();
      return (r as { value: unknown }).value;
    } catch (err) {
      if (err instanceof VaultError && err.code === 'TOKEN_EXPIRED') {
        token = fx.login(actor); // re-auth on expiry (SEC-05 renewal handling)
        const r2 = await call();
        return (r2 as { value: unknown }).value;
      }
      if (err instanceof VaultError) {
        throw { code: err.code, retryable: err.retryable } as unknown as Error;
      }
      throw err;
    }
  };
  return { readSecret: raw };
}

function vaultSource(over: Partial<{ path: string; key: string; version: number }> = {}): CredentialSource {
  return {
    kind: 'vault-kv2',
    account: 'du-conn-openai-main',
    mount: ALLOW.mount,
    path: over.path ?? ALLOW.path,
    key: over.key ?? 'api-key',
    version: over.version ?? 2,
  };
}

describe('parseCredentialSource — explicit, fail-closed', () => {
  it('undefined/null and an unreferenced legacy source fail closed', () => {
    expect(() => parseCredentialSource(undefined)).toThrow(ConnectorError);
    expect(() => parseCredentialSource(null)).toThrow(ConnectorError);
    expect(parseCredentialSource({ kind: 'legacy-db', credentialRef: 'cred-1' })).toEqual({
      kind: 'legacy-db', credentialRef: 'cred-1',
    });
  });
  it('vault source is version-pinned and canonicalizes the early spelling alias', () => {
    const source = { kind: 'vault-kv2', account: 'du-conn-openai-main', ...ALLOW, key: 'api-key', version: 2 };
    expect(parseCredentialSource(source)).toEqual(source);
    expect(parseCredentialSource({ ...source, kind: 'vault-kv-v2' })).toEqual(source);
  });
  it('malformed vault ref and unknown kinds fail CLOSED', () => {
    for (const bad of [
      { kind: 'vault-kv2', account: 'a', mount: 'secret', path: '../etc/x', key: 'api-key', version: 1 },
      { kind: 'vault-kv2', account: 'a', mount: 'secret', path: 'du/ok', key: '', version: 1 },
      { kind: 'vault-kv2', account: 'a', mount: 'secret', path: 'du/ok', key: 'api-key', version: 0 },
      { kind: 'vault-kv2', account: 'a', mount: 'secret', path: 'du/ok', key: 'api-key' },
      { kind: 'legacy-db' },
      { kind: 'aws-smithy', bucket: 'x' },
      'not-an-object',
    ]) {
      expect(() => parseCredentialSource(bad)).toThrow(ConnectorError);
      try {
        parseCredentialSource(bad);
      } catch (e) {
        expect((e as ConnectorError).code).toBe('CREDENTIAL_INVALID');
      }
    }
  });
});

describe('SecretResolver — vault-kv2 via VAULT-02 fixture', () => {
  let fx: VaultDevFixture;
  let resolver: SecretResolver;
  const legacyHits: string[] = [];

  const fakeLegacy = {
    store: {
      getActiveCredential: async (ref: string): Promise<Uint8Array | undefined> => {
        legacyHits.push(ref);
        return new Uint8Array([1, 2, 3]);
      },
    },
    decrypt: (): string => 'LEGACY-SECRET',
  };

  beforeAll(async () => {
    fx = createVaultDevFixture({ tokenTtlMs: 120_000, scopes: TEST_SCOPES });
    const writer = fx.login('orchestrator-writer');
    await fx.write({ ...ALLOW, token: writer, key: 'api-key', value: V1 });
    await fx.write({ ...ALLOW, token: writer, key: 'api-key', value: V2, cas: 1 });
    await fx.write({ ...ALLOW, token: writer, key: 'alt-key', value: ALT, cas: 2 });
    resolver = new SecretResolver({
      kv2: bridgeReader(fx, 'connector-reader'),
      legacy: fakeLegacy,
      retry: { maxAttempts: 3, baseDelayMs: 10, sleep: async () => undefined },
    });
  });

  it('two keys, two pinned versions: exact values reach the provider slot', async () => {
    const calls: { auth: string | undefined; extra: string | undefined }[] = [];
    const provider = (config: AdapterConfig) => {
      calls.push({ auth: config.headers?.['authorization'], extra: config.headers?.['x-provider-key'] });
      return 'ok';
    };
    const configs: AdapterConfig[] = [];
    for (const source of [
      vaultSource({ version: 1 }),
      vaultSource({ version: 2 }),
      vaultSource({ key: 'alt-key', version: 3 }),
    ]) {
      const secret = (await resolver.resolve(source)).value;
      const config = applyCredentialSlot(
        { baseUrl: 'https://api.openai.com', path: '/v1', timeoutMs: 5000, credentialSlot: 'header:x-provider-key' },
        secret,
      );
      configs.push(config);
      provider(config);
    }
    expect(calls).toHaveLength(3);
    expect(calls[0]!.extra).toBe(V1);
    expect(calls[1]!.extra).toBe(V2);
    expect(calls[2]!.extra).toBe(ALT);
    // pinned v1 still returns v1 after rotation to v2 — immutable history
    expect(calls[0]!.extra).not.toBe(calls[1]!.extra);
    // header slot honored; NO hardcoded authorization
    expect(calls[0]!.auth).toBeUndefined();
  });

  it("default slot remains 'bearer' (byte-compatible with the old withCredential)", () => {
    const config = applyCredentialSlot({ baseUrl: 'https://x.test', path: '/v1', timeoutMs: 1000 }, 's3cr3t');
    expect(config.headers?.['authorization']).toBe('Bearer s3cr3t');
  });

  it.each([
    ['missing key in payload', vaultSource({ key: 'nope' })],
    ['missing path', vaultSource({ path: 'du/tenants/tenant-a/connectors/openai/accounts/du-conn-openai-absent' })],
    ['pinned version absent', vaultSource({ version: 7 })],
    ['path outside allowed prefix', vaultSource({ path: 'other-team/x' })],
    ['wrong mount', { ...vaultSource(), mount: 'kv-prod' } as CredentialSource],
  ])('%s → CREDENTIAL_INVALID with provider call count 0 and zero legacy hits', async (_label, source) => {
    let providerCalls = 0;
    const before = legacyHits.length;
    await expect(
      (async () => {
        const s = await resolver.resolve(source);
        providerCalls += 1; // unreachable on rejection
        return s;
      })(),
    ).rejects.toThrow(ConnectorError).catch(() => undefined);
    await resolver.resolve(source).then(
      () => undefined,
      (err: unknown) => expect((err as ConnectorError).code).toBe('CREDENTIAL_INVALID'),
    );
    expect(providerCalls).toBe(0);
    expect(legacyHits.length).toBe(before); // SEC-05: no fallback to legacy on deny
  });

  it('writer identity cannot read through the resolver (policy read-denied)', async () => {
    const writerResolver = new SecretResolver({ kv2: bridgeReader(fx, 'orchestrator-writer'), retry: { sleep: async () => undefined } });
    await expect(writerResolver.resolve(vaultSource())).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
  });

  it('outage: bounded retry (3 attempts, 2 backoffs) → PROVIDER_UNAVAILABLE safeToRetry, never legacy', async () => {
    const sleeps: number[] = [];
    fx.setOutage('unavailable');
    const flaky = new SecretResolver({
      kv2: bridgeReader(fx, 'connector-reader'),
      legacy: fakeLegacy,
      retry: { maxAttempts: 3, baseDelayMs: 10, sleep: async (ms: number) => { sleeps.push(ms); } },
    });
    const before = legacyHits.length;
    await expect(flaky.resolve(vaultSource())).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      safeToRetry: true,
    });
    expect(sleeps).toEqual([10, 20]);
    expect(legacyHits.length).toBe(before);
    fx.setOutage('off');
    const ok = await flaky.resolve(vaultSource());
    expect(ok.value).toBe(V2);
  });

  it('token expiry is survived via re-auth (renewal handling)', async () => {
    fx.advance(121_000); // past the reader token TTL
    const r = await resolver.resolve(vaultSource({ version: 2 }));
    expect(r.value).toBe(V2);
  });

  it('empty-string secret value is CREDENTIAL_INVALID (non-empty string rule)', async () => {
    const writer = fx.login('orchestrator-writer');
    await fx.write({
      mount: ALLOW.mount,
      path: 'du/tenants/tenant-a/connectors/openai/accounts/du-conn-openai-empty',
      token: writer,
      key: 'api-key',
      value: '',
    });
    await expect(
      resolver.resolve(vaultSource({ path: 'du/tenants/tenant-a/connectors/openai/accounts/du-conn-openai-empty', version: 1 })),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
  });

  it('failure messages never carry the secret value', async () => {
    const errs: unknown[] = [];
    await resolver.resolve(vaultSource({ key: 'nope' })).catch((e: unknown) => errs.push(e));
    await resolver.resolve(vaultSource({ path: 'du/x/y' })).catch((e: unknown) => errs.push(e));
    const dump = JSON.stringify(errs.map((e) => (e as Error).message));
    expect(dump).not.toContain(V1.slice(0, 20));
    expect(dump).not.toContain(V2.slice(0, 20));
    expect(dump).not.toContain('LEGACY-SECRET');
  });
});

describe('SecretResolver — legacy-db path unchanged', () => {
  it('reads + decrypts via the store', async () => {
    let decrypts = 0;
    const resolver = new SecretResolver({
      legacy: {
        store: { getActiveCredential: async () => new Uint8Array([9]) },
        decrypt: () => { decrypts += 1; return 'old-secret'; },
      },
    });
    const r = await resolver.resolve({ kind: 'legacy-db', credentialRef: 'cred-1' });
    expect(r).toEqual({ value: 'old-secret', via: 'legacy-db', attempts: 1 });
    expect(decrypts).toBe(1);
  });
  it('inactive credential → CREDENTIAL_INVALID', async () => {
    const resolver = new SecretResolver({
      legacy: { store: { getActiveCredential: async () => undefined }, decrypt: () => 'x' },
    });
    await expect(resolver.resolve({ kind: 'legacy-db', credentialRef: 'cred-1' })).rejects.toMatchObject({
      code: 'CREDENTIAL_INVALID',
    });
  });
});

describe('management.test(connectorId) — real ref + read capability check (VAULT-05)', () => {
  const revision = (over: Partial<ConnectorRevision>): ConnectorRevision => {
    const credentialSource = over.credentialSource ?? { kind: 'legacy-db' as const, credentialRef: 'cred-openai-3' };
    const isVault = credentialSource.kind === 'vault-kv2';
    return {
      connectorId: 'openai',
      revision: 3,
      adapter: 'openai-http',
      config: { baseUrl: 'https://api.openai.com', path: '/v1', timeoutMs: 5000 },
      credentialRef: 'cred-openai-3',
      state: 'ACTIVE',
      credentialSource,
      // Unbound (pre-008) legacy row: empty tenant binding.
      tenantId: isVault ? 'tenant-a' : '',
      ...(isVault ? { accountId: credentialSource.account } : {}),
      ...over,
    };
  };
  const fakeRegistry = { get: (name: string): unknown => ({ id: name }) } as unknown as AdapterRegistry;
  const cipher = new AesCredentialCipher(randomBytes(32));

  function management(opts: {
    revision: ConnectorRevision | undefined;
    legacyBytes?: Uint8Array;
    resolver?: SecretResolver;
  }): DurableConnectorManagement {
    const repo = {
      get: async () => opts.revision,
      getRevision: async () => opts.revision,
      list: async () => [],
      createRevision: async () => opts.revision!,
      disable: async () => undefined,
      getActiveCredential: async () => opts.legacyBytes,
      put: async () => '',
      revoke: async () => undefined,
    } as unknown as ConnectorConfigRepository;
    return new DurableConnectorManagement(repo, cipher, fakeRegistry, opts.resolver);
  }

  it('vault revision probes an ACTUAL read (ok)', async () => {
    const fx = createVaultDevFixture({ scopes: TEST_SCOPES });
    const writer = fx.login('orchestrator-writer');
    await fx.write({ ...ALLOW, token: writer, key: 'api-key', value: V1 });
    const resolver = new SecretResolver({ kv2: bridgeReader(fx, 'connector-reader') });
    const m = management({ revision: revision({ credentialSource: vaultSource({ version: 1 }) }), resolver });
    await expect(m.test('openai')).resolves.toEqual({ ok: true });
  });

  it('vault revision with dead ref fails test() with CREDENTIAL_INVALID', async () => {
    const fx = createVaultDevFixture({ scopes: TEST_SCOPES });
    const resolver = new SecretResolver({ kv2: bridgeReader(fx, 'connector-reader') });
    const m = management({ revision: revision({ credentialSource: vaultSource() }), resolver });
    await expect(m.test('openai')).resolves.toEqual({ ok: false, errorCode: 'CREDENTIAL_INVALID' });
  });

  it('vault revision WITHOUT resolver → fail closed (no adapter-only pass)', async () => {
    const m = management({ revision: revision({ credentialSource: vaultSource() }) });
    await expect(m.test('openai')).resolves.toEqual({ ok: false, errorCode: 'CREDENTIAL_INVALID' });
  });

  it('legacy revision now checks the credential EXISTS (was: adapter-only)', async () => {
    const noCred = management({ revision: revision({}) });
    await expect(noCred.test('openai')).resolves.toEqual({ ok: false, errorCode: 'CREDENTIAL_INVALID' });
    const withCred = management({ revision: revision({}), legacyBytes: cipher.encrypt('live') });
    await expect(withCred.test('openai')).resolves.toEqual({ ok: true });
  });

  it('vault revision bound to another tenant returns BINDING_DENIED with zero resolver probes', async () => {
    let reads = 0;
    const resolver = new SecretResolver({
      kv2: { readSecret: async () => { reads += 1; return undefined; } },
    });
    const m = management({
      revision: revision({ credentialSource: vaultSource({ version: 1 }), tenantId: 'tenant-b' }),
      resolver,
    });
    await expect(m.test('openai')).resolves.toEqual({ ok: false, errorCode: 'BINDING_DENIED' });
    expect(reads).toBe(0);
  });

  it('vault revision whose account column disagrees with the ref returns BINDING_DENIED with zero resolver probes', async () => {
    let reads = 0;
    const resolver = new SecretResolver({
      kv2: { readSecret: async () => { reads += 1; return undefined; } },
    });
    const m = management({
      revision: revision({ credentialSource: vaultSource({ version: 1 }), accountId: 'du-conn-other-main' }),
      resolver,
    });
    await expect(m.test('openai')).resolves.toEqual({ ok: false, errorCode: 'BINDING_DENIED' });
    expect(reads).toBe(0);
  });
});
