import { randomBytes } from 'node:crypto';
import {
  InvocationFieldCryptoError,
  canonicalizeInvocationJson,
  createInvocationFieldCrypto,
  createLocalInvocationKekProvider,
  deriveInvocationAad,
  invocationPlaintextHash,
  isSealedInvocationField,
  parseLocalInvocationKekConfig,
  resolveInvocationStorageCryptoFromEnv,
  type InvocationCryptoContext,
  type InvocationDekKeyProvider,
  type SealedInvocationField,
} from '../src/db/invocation-crypto';

/**
 * SEC-ENC-02 (SD-01) — envelope crypto unit pins. Offline: no DB, no Vault.
 * Every failure class the ledger relies on (AAD binding, tamper, key outage,
 * unknown key version, rotation) is exercised at the crypto seam.
 */

const KEY_1 = randomBytes(32).toString('base64');
const KEY_2 = randomBytes(32).toString('base64');
const CONTEXT: InvocationCryptoContext = {
  tenantId: 'tenant-a',
  slot: 'connector_invocations.request',
  refId: 'inv-1',
};

function config(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    keyRef: 'du-connector-invocation-v1',
    activeVersion: 1,
    keys: { '1': KEY_1 },
    ...overrides,
  });
}

function cryptoFor(raw?: string) {
  const parsed = parseLocalInvocationKekConfig(raw ?? config())!;
  return createInvocationFieldCrypto(createLocalInvocationKekProvider(parsed), parsed.keyRef);
}

describe('SEC-ENC-02 local KEK config parsing', () => {
  test('parses a valid versioned key config', () => {
    const parsed = parseLocalInvocationKekConfig(config({ activeVersion: 2, keys: { '1': KEY_1, '2': KEY_2 } }));
    expect(parsed).toEqual({
      keyRef: 'du-connector-invocation-v1',
      activeVersion: 2,
      keysByVersion: { '1': KEY_1, '2': KEY_2 },
    });
  });

  test('unset/blank means "no crypto configured"', () => {
    expect(parseLocalInvocationKekConfig(undefined)).toBeUndefined();
    expect(parseLocalInvocationKekConfig('')).toBeUndefined();
    expect(parseLocalInvocationKekConfig('   ')).toBeUndefined();
  });

  test.each([
    ['malformed JSON', '{not json'],
    ['missing active version', JSON.stringify({ keyRef: 'k1', keys: { '1': KEY_1 } })],
    ['active version without key', JSON.stringify({ keyRef: 'k1', activeVersion: 3, keys: { '1': KEY_1 } })],
    ['bad key length', JSON.stringify({ keyRef: 'k1', activeVersion: 1, keys: { '1': Buffer.alloc(16).toString('base64') } })],
    ['unsafe key ref', JSON.stringify({ keyRef: '../evil', activeVersion: 1, keys: { '1': KEY_1 } })],
    ['bad version label', JSON.stringify({ keyRef: 'k1', activeVersion: 1, keys: { zero: KEY_1 } })],
  ])('rejects %s at configuration time', (_label, raw) => {
    expect(() => parseLocalInvocationKekConfig(raw)).toThrow(InvocationFieldCryptoError);
  });
});

describe('SEC-ENC-02 envelope seal/open', () => {
  test('round-trips a JSON value and carries the canonical plaintext hash', async () => {
    const crypto = cryptoFor();
    const value = {
      invocationId: 'inv-1',
      input: { prompt: 'SENTINEL-PROMPT', text: 'SENTINEL-TEXT' },
      options: { temperature: 0 },
    };
    const sealed = await crypto.seal(value, CONTEXT);

    expect(sealed.version).toBe(1);
    expect(sealed.algorithm).toBe('aes-256-gcm');
    expect(sealed.keyRef).toBe('du-connector-invocation-v1');
    expect(sealed.plaintextSha256).toBe(invocationPlaintextHash(value));
    expect(crypto.isSealed(sealed)).toBe(true);
    expect(isSealedInvocationField(sealed)).toBe(true);
    // The envelope itself contains no plaintext sentinel.
    expect(JSON.stringify(sealed)).not.toContain('SENTINEL-PROMPT');
    expect(JSON.stringify(sealed)).not.toContain('SENTINEL-TEXT');

    await expect(crypto.open(sealed, CONTEXT)).resolves.toEqual(value);
  });

  test('canonical JSON is key-order independent, so stored values round-trip byte-stably', async () => {
    const crypto = cryptoFor();
    const a = { b: { d: 1, c: 2 }, a: 3 };
    const b = { a: 3, b: { c: 2, d: 1 } };
    expect(canonicalizeInvocationJson(a).equals(canonicalizeInvocationJson(b))).toBe(true);
    expect(invocationPlaintextHash(a)).toBe(invocationPlaintextHash(b));

    const sealed = await crypto.seal(a, CONTEXT);
    await expect(crypto.open(sealed, CONTEXT)).resolves.toEqual(b);
  });

  test('a fixed plaintext yields different envelopes (fresh DEK + nonce)', async () => {
    const crypto = cryptoFor();
    const one = await crypto.seal({ prompt: 'same' }, CONTEXT);
    const two = await crypto.seal({ prompt: 'same' }, CONTEXT);
    expect(one.ciphertext).not.toBe(two.ciphertext);
    expect(one.dek.wrappedKey).not.toBe(two.dek.wrappedKey);
    expect(one.plaintextSha256).toBe(two.plaintextSha256);
  });

  test.each([
    ['tenant', { ...CONTEXT, tenantId: 'tenant-b' }],
    ['slot', { ...CONTEXT, slot: 'connector_invocations.result' as const }],
    ['row', { ...CONTEXT, refId: 'inv-2' }],
  ] as const)('refuses a %s transplant with CONTEXT_MISMATCH before touching a key', async (_label, context) => {
    const crypto = cryptoFor();
    const sealed = await crypto.seal({ prompt: 'bound' }, CONTEXT);
    await expect(crypto.open(sealed, context)).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });
  });

  test('AAD derivation differs per tenant/slot/row but is stable', () => {
    expect(deriveInvocationAad(CONTEXT).equals(deriveInvocationAad({ ...CONTEXT }))).toBe(true);
    expect(deriveInvocationAad(CONTEXT).equals(deriveInvocationAad({ ...CONTEXT, tenantId: 'tenant-b' }))).toBe(false);
    expect(deriveInvocationAad(CONTEXT).equals(deriveInvocationAad({ ...CONTEXT, slot: 'connector_invocations.result' }))).toBe(false);
    expect(deriveInvocationAad(CONTEXT).equals(deriveInvocationAad({ ...CONTEXT, refId: 'inv-2' }))).toBe(false);
  });

  test.each([
    ['ciphertext', (sealed: SealedInvocationField) => ({ ...sealed, ciphertext: flipBase64(sealed.ciphertext) })],
    ['tag', (sealed: SealedInvocationField) => ({ ...sealed, tag: flipBase64(sealed.tag) })],
    ['aad', (sealed: SealedInvocationField) => ({ ...sealed, aad: flipBase64(sealed.aad) })],
    ['nonce', (sealed: SealedInvocationField) => ({ ...sealed, nonce: flipBase64(sealed.nonce) })],
    ['plaintext hash', (sealed: SealedInvocationField) => ({ ...sealed, plaintextSha256: 'a'.repeat(64) })],
  ])('rejects a tampered %s', async (_label, tamper) => {
    const crypto = cryptoFor();
    const sealed = await crypto.seal({ prompt: 'do not tamper' }, CONTEXT);
    const broken = tamper(sealed) as SealedInvocationField;
    await expect(crypto.open(broken, CONTEXT)).rejects.toMatchObject({
      // aad is compared before decryption; the rest fail authenticated decryption
      code: _label === 'aad' ? 'CONTEXT_MISMATCH' : 'AUTHENTICATION_FAILED',
    });
  });

  test('a value that is not an envelope is NOT_SEALED, not silently accepted', async () => {
    const crypto = cryptoFor();
    expect(crypto.isSealed({ invocationId: 'plain' })).toBe(false);
    await expect(
      crypto.open({ invocationId: 'plain' } as unknown as SealedInvocationField, CONTEXT),
    ).rejects.toMatchObject({ code: 'NOT_SEALED' });
  });

  test('wrap outage fails KEY_PROVIDER_FAILED and never emits an envelope', async () => {
    const provider: InvocationDekKeyProvider = {
      wrapDek: async () => { throw new Error('vault transit down'); },
      unwrapDek: async () => { throw new Error('unreachable'); },
    };
    const crypto = createInvocationFieldCrypto(provider, 'du-connector-invocation-v1');
    await expect(crypto.seal({ prompt: 'x' }, CONTEXT)).rejects.toMatchObject({ code: 'KEY_PROVIDER_FAILED' });
  });

  test('unwrap outage fails KEY_PROVIDER_FAILED after the AAD check', async () => {
    const real = cryptoFor();
    const sealed = await real.seal({ prompt: 'x' }, CONTEXT);
    const provider: InvocationDekKeyProvider = {
      wrapDek: async () => { throw new Error('unreachable'); },
      unwrapDek: async () => { throw new Error('vault transit down'); },
    };
    const crypto = createInvocationFieldCrypto(provider, 'du-connector-invocation-v1');
    await expect(crypto.open(sealed, CONTEXT)).rejects.toMatchObject({ code: 'KEY_PROVIDER_FAILED' });
  });

  test('an unknown DEK key version is refused (no latest-version guessing)', async () => {
    const real = cryptoFor();
    const sealed = await real.seal({ prompt: 'x' }, CONTEXT);
    const other = parseLocalInvocationKekConfig(config({ keys: { '2': KEY_2 }, activeVersion: 2 }))!;
    const crypto = createInvocationFieldCrypto(createLocalInvocationKekProvider(other), other.keyRef);
    await expect(crypto.open(sealed, CONTEXT)).rejects.toMatchObject({ code: 'KEY_PROVIDER_FAILED' });
  });

  test('key rotation: v1 envelopes stay readable while new wraps use the active v2', async () => {
    const v1 = cryptoFor();
    const oldEnvelope = await v1.seal({ prompt: 'turn one' }, CONTEXT);

    const rotated = cryptoFor(config({ activeVersion: 2, keys: { '1': KEY_1, '2': KEY_2 } }));
    await expect(rotated.open(oldEnvelope, CONTEXT)).resolves.toEqual({ prompt: 'turn one' });

    const newEnvelope = await rotated.seal({ prompt: 'turn two' }, CONTEXT);
    expect(newEnvelope.dek.keyVersion).toBe(2);
    await expect(rotated.open(newEnvelope, CONTEXT)).resolves.toEqual({ prompt: 'turn two' });
  });
});

describe('SEC-ENC-02 environment resolution', () => {
  test('no env = no crypto and strict reads', () => {
    expect(resolveInvocationStorageCryptoFromEnv({})).toEqual({ legacyPlaintextReads: false });
  });

  test('valid env builds a crypto seam; the migration window is explicit', () => {
    const options = resolveInvocationStorageCryptoFromEnv({
      CONNECTOR_INVOCATION_ENCRYPTION_KEYS: config(),
      CONNECTOR_INVOCATION_LEGACY_PLAINTEXT_READS: 'true',
    });
    expect(options.fieldCrypto).toBeDefined();
    expect(options.legacyPlaintextReads).toBe(true);
  });

  test('malformed env fails loudly instead of silently disabling encryption', () => {
    expect(() => resolveInvocationStorageCryptoFromEnv({
      CONNECTOR_INVOCATION_ENCRYPTION_KEYS: '{"keyRef":"k","activeVersion":1,"keys":{"1":"AAAA"}}',
    })).toThrow(InvocationFieldCryptoError);
  });
});

function flipBase64(value: string): string {
  const bytes = Buffer.from(value, 'base64');
  bytes[0] = (bytes[0]! ^ 0xff) & 0xff;
  return bytes.toString('base64');
}
