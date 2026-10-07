import {
  VaultTransitError,
  VaultTransitProvider,
  type VaultTransitProviderOptions,
} from '../src/modules/encryption/vault-transit-provider';

interface CapturedCall {
  readonly url: string;
  readonly headers: Headers;
  readonly payload: Record<string, unknown>;
}

function makeFetch(handler: (call: CapturedCall, index: number) => Response | Promise<Response>): {
  readonly fetchImpl: typeof fetch;
  readonly calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = init?.body;
    if (typeof body !== 'string') throw new Error('expected a JSON request body');
    const call: CapturedCall = {
      url: String(input),
      headers: new Headers(init?.headers),
      payload: JSON.parse(body) as Record<string, unknown>,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetchImpl, calls };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const DEK = Buffer.from('0123456789abcdef0123456789abcdef');
const WRAPPED = { keyRef: 'storage/main', keyVersion: 2, ciphertext: 'vault:v2:wrappeddek' };

function makeProvider(fetchImpl: typeof fetch, overrides: Partial<VaultTransitProviderOptions> = {}): VaultTransitProvider {
  return new VaultTransitProvider({
    vaultAddress: 'https://vault.example.internal:8200',
    allowedKeyRefs: { 'storage/main': 'dek-main' },
    transitMount: 'transit-app',
    encryptIdentity: { token: () => 'encrypt-machine-token' },
    decryptIdentity: { token: () => 'decrypt-machine-token' },
    rewrapIdentity: { token: () => 'rewrap-machine-token' },
    fetchImpl,
    ...overrides,
  });
}

describe('VaultTransitProvider', () => {
  test('wraps a 256-bit DEK, pins its Transit version, and unwraps with the decrypt identity', async () => {
    const { fetchImpl, calls } = makeFetch((_call, index) => index === 0
      ? jsonResponse({ data: { ciphertext: 'vault:v2:wrappeddek' } })
      : jsonResponse({ data: { plaintext: DEK.toString('base64') } }));
    const provider = makeProvider(fetchImpl);

    const wrapped = await provider.wrapDek({ keyRef: 'storage/main', dek: DEK, keyVersion: 2 });
    const unwrapped = await provider.unwrapDek(wrapped);

    expect(wrapped).toEqual(WRAPPED);
    expect(unwrapped).toEqual(DEK);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://vault.example.internal:8200/v1/transit-app/encrypt/dek-main');
    expect(calls[0]?.payload).toEqual({ plaintext: DEK.toString('base64'), key_version: 2 });
    expect(calls[0]?.headers.get('x-vault-token')).toBe('encrypt-machine-token');
    expect(calls[1]?.url).toBe('https://vault.example.internal:8200/v1/transit-app/decrypt/dek-main');
    expect(calls[1]?.payload).toEqual({ ciphertext: WRAPPED.ciphertext });
    expect(calls[1]?.headers.get('x-vault-token')).toBe('decrypt-machine-token');
  });

  test('uses latest version on wrap by default and reports the version encoded by Vault', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse({ data: { ciphertext: 'vault:v7:latest' } }));
    const provider = makeProvider(fetchImpl);

    await expect(provider.wrapDek({ keyRef: 'storage/main', dek: DEK })).resolves.toEqual({
      keyRef: 'storage/main',
      keyVersion: 7,
      ciphertext: 'vault:v7:latest',
    });
    expect(calls[0]?.payload).toEqual({ plaintext: DEK.toString('base64') });
  });

  test('rewraps using latest by default or a requested version without returning plaintext', async () => {
    const { fetchImpl, calls } = makeFetch((_call, index) => jsonResponse({
      data: { ciphertext: index === 0 ? 'vault:v3:latest' : 'vault:v4:pinned' },
    }));
    const provider = makeProvider(fetchImpl);

    await expect(provider.rewrap(WRAPPED)).resolves.toEqual({
      keyRef: 'storage/main',
      keyVersion: 3,
      ciphertext: 'vault:v3:latest',
    });
    await expect(provider.rewrap(WRAPPED, 4)).resolves.toEqual({
      keyRef: 'storage/main',
      keyVersion: 4,
      ciphertext: 'vault:v4:pinned',
    });
    expect(calls.map((call) => call.url)).toEqual([
      'https://vault.example.internal:8200/v1/transit-app/rewrap/dek-main',
      'https://vault.example.internal:8200/v1/transit-app/rewrap/dek-main',
    ]);
    expect(calls.map((call) => call.payload)).toEqual([
      { ciphertext: WRAPPED.ciphertext },
      { ciphertext: WRAPPED.ciphertext, key_version: 4 },
    ]);
    expect(calls.every((call) => call.headers.get('x-vault-token') === 'rewrap-machine-token')).toBe(true);
  });

  test('rejects refs outside the allowlist and invalid DEK lengths before contacting Vault', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse({ data: { ciphertext: 'vault:v1:never' } }));
    const provider = makeProvider(fetchImpl);

    await expect(provider.wrapDek({ keyRef: 'storage/other', dek: DEK }))
      .rejects.toMatchObject({ code: 'KEY_REF_NOT_ALLOWED' });
    await expect(provider.wrapDek({ keyRef: 'storage/main', dek: Buffer.alloc(31) }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(calls).toHaveLength(0);
  });

  test('rejects malformed or inconsistent wrapped metadata before contacting Vault', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse({ data: { plaintext: DEK.toString('base64') } }));
    const provider = makeProvider(fetchImpl);

    await expect(provider.unwrapDek({ ...WRAPPED, keyVersion: 3 }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(provider.unwrapDek({ ...WRAPPED, ciphertext: 'plaintext-dek' }))
      .rejects.toMatchObject({ code: 'INVALID_VAULT_RESPONSE' });
    await expect(provider.rewrap({ ...WRAPPED, keyRef: 'storage/not-approved' }))
      .rejects.toMatchObject({ code: 'KEY_REF_NOT_ALLOWED' });
    await expect(provider.rewrap(WRAPPED, 1))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(calls).toHaveLength(0);
  });

  test('fails closed on Vault authorization denial, outage, and retired key versions', async () => {
    const denied = makeProvider(makeFetch(() => jsonResponse({ errors: ['secret token must not escape'] }, 403)).fetchImpl);
    await expect(denied.unwrapDek(WRAPPED)).rejects.toMatchObject({ code: 'VAULT_FORBIDDEN', status: 403 });

    const unavailable = makeProvider(makeFetch(() => jsonResponse({ errors: ['offline'] }, 503)).fetchImpl);
    await expect(unavailable.unwrapDek(WRAPPED)).rejects.toMatchObject({ code: 'VAULT_UNAVAILABLE', status: 503 });

    const retiredVersion = makeProvider(makeFetch(() => jsonResponse({ errors: ['old version revoked'] }, 400)).fetchImpl);
    await expect(retiredVersion.unwrapDek(WRAPPED)).rejects.toMatchObject({ code: 'VAULT_REJECTED', status: 400 });
  });

  test('does not include Vault response bodies or tokens in errors', async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({ errors: ['private-vault-detail'] }, 403));
    const provider = makeProvider(fetchImpl);
    let caught: unknown;
    try {
      await provider.unwrapDek(WRAPPED);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(VaultTransitError);
    expect((caught as Error).message).not.toContain('private-vault-detail');
    expect((caught as Error).message).not.toContain('decrypt-machine-token');
  });

  test('validates endpoint security and immutable allowlist configuration', async () => {
    const mutableAllowlist: Record<string, string> = { 'storage/main': 'dek-main' };
    const { fetchImpl, calls } = makeFetch(() => jsonResponse({ data: { ciphertext: 'vault:v1:wrapped' } }));
    const provider = makeProvider(fetchImpl, { allowedKeyRefs: mutableAllowlist });
    mutableAllowlist['storage/main'] = 'redirected-key';
    mutableAllowlist['storage/added'] = 'new-key';

    await provider.wrapDek({ keyRef: 'storage/main', dek: DEK });
    expect(calls[0]?.url).toContain('/encrypt/dek-main');
    await expect(provider.wrapDek({ keyRef: 'storage/added', dek: DEK }))
      .rejects.toMatchObject({ code: 'KEY_REF_NOT_ALLOWED' });
    expect(() => makeProvider(fetchImpl, { vaultAddress: 'http://vault.example.internal:8200' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
  });

  test('requires separate machine identity suppliers for encrypt and decrypt', () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({ data: { ciphertext: 'vault:v1:unused' } }));
    const sharedIdentity = { token: () => 'shared-token' };
    expect(() => makeProvider(fetchImpl, {
      encryptIdentity: sharedIdentity,
      decryptIdentity: sharedIdentity,
    })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
  });
});
