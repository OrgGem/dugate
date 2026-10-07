/**
 * CONTROL-PLANE-IMPL-818: the plaintext-read policy contract.
 *
 * Pins the whole decision table in one place: the closed mode set, the
 * bounded window, the reader facade, and the env parser. Every assertion
 * here is a property the production boot depends on — a typo must fail the
 * boot, a window must close, and no path may spell `allowPlaintext: true`.
 */
import {
  METADATA_PLAINTEXT_READ_MODE,
  createCompatibilityMetadataReadPolicy,
  createMetadataReadPolicy,
  createMetadataReader,
  compatibilityMetadataReader,
  decidePlaintextRead,
  isMetadataPlaintextReadMode,
  isMetadataReader,
  MetadataReadPolicyError,
} from '../src/modules/encryption/metadata-read-policy';
import { createBoundedDualReadWindow } from '../src/modules/encryption/legacy-payload-migration';
import {
  buildMetadataReadPolicy,
  EncryptionBootConfigError,
  METADATA_READ_MODE_ENV,
  METADATA_WINDOW_END_ENV,
  METADATA_WINDOW_START_ENV,
} from '../src/modules/encryption/boot-options';
import type { MetadataContext, MetadataCrypto } from '../src/modules/runtime/metadata-crypto';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

const ctx: MetadataContext = { tenantId: 'tenant-1', slot: 'operations.input_ref', refId: 'op-1' };

function windowPolicy(startsAtMs: number, expiresAtMs: number) {
  return createMetadataReadPolicy('window', createBoundedDualReadWindow(startsAtMs, expiresAtMs), startsAtMs);
}

describe('METADATA_PLAINTEXT_READ_MODE (closed enum)', () => {
  it('is exactly window and forbid — no third value', () => {
    expect([...METADATA_PLAINTEXT_READ_MODE]).toEqual(['window', 'forbid']);
  });

  it('accepts the two modes and rejects everything else', () => {
    expect(isMetadataPlaintextReadMode('window')).toBe(true);
    expect(isMetadataPlaintextReadMode('forbid')).toBe(true);
    expect(isMetadataPlaintextReadMode('Window')).toBe(false);
    expect(isMetadataPlaintextReadMode('')).toBe(false);
    expect(isMetadataPlaintextReadMode(undefined)).toBe(false);
    expect(isMetadataPlaintextReadMode(null)).toBe(false);
    expect(isMetadataPlaintextReadMode(1)).toBe(false);
  });
});

describe('createMetadataReadPolicy', () => {
  it('rejects an unknown mode', () => {
    expect(() => createMetadataReadPolicy('Window' as never, null)).toThrow(MetadataReadPolicyError);
  });

  it("requires a window for 'window' and forbids one for 'forbid'", () => {
    const window = createBoundedDualReadWindow(NOW, NOW + DAY_MS);
    expect(() => createMetadataReadPolicy('window', null)).toThrow(MetadataReadPolicyError);
    expect(() => createMetadataReadPolicy('forbid', window)).toThrow(MetadataReadPolicyError);
  });

  it('rejects a non-finite startedAtMs', () => {
    expect(() => createMetadataReadPolicy('forbid', null, Number.NaN)).toThrow(MetadataReadPolicyError);
  });

  it('freezes the returned policy', () => {
    expect(Object.isFrozen(createMetadataReadPolicy('forbid', null))).toBe(true);
  });
});

describe('the allowPlaintext decision table', () => {
  it('window: true inside, false after expiry', () => {
    const policy = windowPolicy(NOW - DAY_MS, NOW + DAY_MS);
    expect(policy.allowPlaintext(NOW)).toBe(true);
    expect(policy.allowPlaintext(NOW + DAY_MS)).toBe(false);
    expect(policy.allowPlaintext(NOW + 2 * DAY_MS)).toBe(false);
    expect(decidePlaintextRead(policy, NOW)).toBe('allow');
    expect(decidePlaintextRead(policy, NOW + DAY_MS)).toBe('not_sealed');
  });

  it('window: false before the window opens', () => {
    const policy = windowPolicy(NOW + DAY_MS, NOW + 2 * DAY_MS);
    expect(policy.allowPlaintext(NOW)).toBe(false);
    expect(decidePlaintextRead(policy, NOW)).toBe('not_sealed');
  });

  it('forbid: never true, and carries no window', () => {
    const policy = createMetadataReadPolicy('forbid', null);
    expect(policy.window).toBeNull();
    expect(policy.allowPlaintext(NOW)).toBe(false);
    expect(policy.allowPlaintext(NOW + 365 * DAY_MS)).toBe(false);
    expect(decidePlaintextRead(policy, NOW)).toBe('not_sealed');
  });
});

describe('createMetadataReader', () => {
  it('is recognised by isMetadataReader', () => {
    const reader = createMetadataReader(undefined, createMetadataReadPolicy('forbid', null));
    expect(isMetadataReader(reader)).toBe(true);
    expect(isMetadataReader(undefined)).toBe(false);
    expect(isMetadataReader({})).toBe(false);
    expect(isMetadataReader(null)).toBe(false);
  });

  // CONTROL-PLANE-POLICY-FIX-822: the no-seam branch used to return raw
  // plaintext without ever asking the policy. These four cases are the
  // regression net for that bypass; both read paths must answer identically.
  const SEALED_TEXT = JSON.stringify({
    version: 1, algorithm: 'aes-256-gcm', ciphertext: 'x', dek: {}, nonce: 'n', tag: 't',
  });

  it('forbid + no seam: unsealed plaintext is refused on both paths', async () => {
    const reader = createMetadataReader(undefined, createMetadataReadPolicy('forbid', null));
    await expect(reader.readStored({ a: 1 }, ctx)).rejects.toMatchObject({ code: 'NOT_SEALED' });
    await expect(reader.readStoredText('legacy-ref', ctx)).rejects.toMatchObject({ code: 'NOT_SEALED' });
  });

  it('forbid + no seam: a sealed envelope still fails as KEY_PROVIDER_FAILED', async () => {
    const reader = createMetadataReader(undefined, createMetadataReadPolicy('forbid', null));
    await expect(reader.readStored(JSON.parse(SEALED_TEXT), ctx)).rejects.toMatchObject({ code: 'KEY_PROVIDER_FAILED' });
    await expect(reader.readStoredText(SEALED_TEXT, ctx)).rejects.toMatchObject({ code: 'KEY_PROVIDER_FAILED' });
  });

  it('expired window + no seam: unsealed plaintext is refused on both paths', async () => {
    const reader = createMetadataReader(undefined, windowPolicy(NOW - 2 * DAY_MS, NOW - DAY_MS));
    await expect(reader.readStored({ a: 1 }, ctx)).rejects.toMatchObject({ code: 'NOT_SEALED' });
    await expect(reader.readStoredText('legacy-ref', ctx)).rejects.toMatchObject({ code: 'NOT_SEALED' });
  });

  it('open window + no seam: unsealed plaintext passes verbatim on both paths', async () => {
    const wall = Date.now();
    const reader = createMetadataReader(undefined, windowPolicy(wall - DAY_MS, wall + DAY_MS));
    await expect(reader.readStored({ a: 1 }, ctx)).resolves.toEqual({ a: 1 });
    await expect(reader.readStoredText('legacy-ref', ctx)).resolves.toBe('legacy-ref');
    await expect(reader.readStoredText(null, ctx)).resolves.toBeUndefined();
  });

  it('open window + no seam: a sealed envelope still fails closed', async () => {
    const wall = Date.now();
    const reader = createMetadataReader(undefined, windowPolicy(wall - DAY_MS, wall + DAY_MS));
    await expect(reader.readStored(JSON.parse(SEALED_TEXT), ctx)).rejects.toMatchObject({ code: 'KEY_PROVIDER_FAILED' });
    await expect(reader.readStoredText(SEALED_TEXT, ctx)).rejects.toMatchObject({ code: 'KEY_PROVIDER_FAILED' });
  });

  it('forwards the policy decision to the seam, not a literal', async () => {
    const seen: boolean[] = [];
    const stub = {
      isSealed: () => false,
      readStored: async (value: unknown, _context: unknown, allowPlaintext: boolean) => {
        seen.push(allowPlaintext);
        return { opened: value, allowPlaintext };
      },
      seal: async () => ({}),
      open: async () => ({}),
    } as unknown as MetadataCrypto;

    // The reader asks the policy at CALL time with no timestamp, so these two
    // windows are anchored on the wall clock: one still open, one expired.
    const wall = Date.now();
    const open = createMetadataReader(stub, windowPolicy(wall - DAY_MS, wall + DAY_MS));
    await expect(open.readStored('plain', ctx)).resolves.toEqual({ opened: 'plain', allowPlaintext: true });
    await expect(open.readStoredText('plain', ctx)).resolves.toBe('plain');

    const closed = createMetadataReader(stub, windowPolicy(wall - 2 * DAY_MS, wall - DAY_MS));
    await expect(closed.readStored('plain', ctx)).resolves.toEqual({ opened: 'plain', allowPlaintext: false });
    await expect(closed.readStoredText('plain', ctx)).rejects.toMatchObject({ code: 'NOT_SEALED' });

    expect(seen).toEqual([true, false]);
  });

  it('exposes the mode it was built with', () => {
    expect(createMetadataReader(undefined, createMetadataReadPolicy('forbid', null)).mode).toBe('forbid');
    expect(createMetadataReader(undefined, windowPolicy(NOW, NOW + DAY_MS)).mode).toBe('window');
  });
});

describe('createCompatibilityMetadataReadPolicy', () => {
  it('is a bounded window, not an unbounded literal', () => {
    const policy = createCompatibilityMetadataReadPolicy(NOW);
    expect(policy.mode).toBe('window');
    expect(policy.allowPlaintext(NOW)).toBe(true);
    expect(policy.allowPlaintext(NOW + 14 * DAY_MS)).toBe(false);
  });

  it('compatibilityMetadataReader is memoized per seam', () => {
    const stub = { isSealed: () => false } as unknown as MetadataCrypto;
    expect(compatibilityMetadataReader(stub)).toBe(compatibilityMetadataReader(stub));
    expect(compatibilityMetadataReader(undefined)).toBe(compatibilityMetadataReader(undefined));
  });
});

describe('buildMetadataReadPolicy (env)', () => {
  it('fails the boot when the mode is absent', () => {
    expect(() => buildMetadataReadPolicy({})).toThrow(EncryptionBootConfigError);
    expect(() => buildMetadataReadPolicy({})).toThrow(/DU_METADATA_PLAINTEXT_READ_MODE/);
  });

  it('fails the boot on a typo', () => {
    expect(() => buildMetadataReadPolicy({ [METADATA_READ_MODE_ENV]: 'Window' })).toThrow(EncryptionBootConfigError);
  });

  it('forbid takes no window and refuses window vars', () => {
    const policy = buildMetadataReadPolicy({ [METADATA_READ_MODE_ENV]: 'forbid' });
    expect(policy.mode).toBe('forbid');
    expect(policy.allowPlaintext(NOW)).toBe(false);
    expect(() => buildMetadataReadPolicy({
      [METADATA_READ_MODE_ENV]: 'forbid',
      [METADATA_WINDOW_START_ENV]: String(NOW),
    })).toThrow(EncryptionBootConfigError);
  });

  it('window requires both bounds and accepts ISO or epoch', () => {
    const iso = buildMetadataReadPolicy({
      [METADATA_READ_MODE_ENV]: 'window',
      [METADATA_WINDOW_START_ENV]: new Date(NOW).toISOString(),
      [METADATA_WINDOW_END_ENV]: new Date(NOW + DAY_MS).toISOString(),
    });
    expect(iso.allowPlaintext(NOW)).toBe(true);
    expect(iso.allowPlaintext(NOW + DAY_MS)).toBe(false);

    const epoch = buildMetadataReadPolicy({
      [METADATA_READ_MODE_ENV]: 'window',
      [METADATA_WINDOW_START_ENV]: String(NOW),
      [METADATA_WINDOW_END_ENV]: String(NOW + DAY_MS),
    });
    expect(epoch.allowPlaintext(NOW)).toBe(true);
  });

  it('window fails on a missing bound, an inverted window, and an over-cap window', () => {
    const base = { [METADATA_READ_MODE_ENV]: 'window' };
    expect(() => buildMetadataReadPolicy({ ...base, [METADATA_WINDOW_START_ENV]: String(NOW) }))
      .toThrow(EncryptionBootConfigError);
    expect(() => buildMetadataReadPolicy({
      [METADATA_READ_MODE_ENV]: 'window',
      [METADATA_WINDOW_START_ENV]: String(NOW + DAY_MS),
      [METADATA_WINDOW_END_ENV]: String(NOW),
    })).toThrow(EncryptionBootConfigError);
    expect(() => buildMetadataReadPolicy({
      [METADATA_READ_MODE_ENV]: 'window',
      [METADATA_WINDOW_START_ENV]: String(NOW),
      [METADATA_WINDOW_END_ENV]: String(NOW + 15 * DAY_MS),
    })).toThrow(EncryptionBootConfigError);
    expect(() => buildMetadataReadPolicy({
      [METADATA_READ_MODE_ENV]: 'window',
      [METADATA_WINDOW_START_ENV]: 'not-a-date',
      [METADATA_WINDOW_END_ENV]: String(NOW + DAY_MS),
    })).toThrow(EncryptionBootConfigError);
  });
});
