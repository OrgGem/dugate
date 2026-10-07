import {
  IngestionReceiptError,
  IngestionReceiptSchema,
  assertIngestionReceipt,
  resolveIngestionSource,
  withIngestionSource,
  INGESTION_SOURCE_FIELD,
  LEGACY_INGESTION_SOURCE_FIELD,
  type IngestionReceipt,
} from '../src';

const SHA = 'a'.repeat(64);
const ARTIFACT_ID = '3f1a9c2e-5b7d-4e61-9c08-2d4f6a8b0c1e';

const receipt: IngestionReceipt = {
  storageKey: 'du/tenants/t1/operations/op1/source',
  versionId: 'v1',
  sha256: SHA,
  sizeBytes: 10,
};

describe('IngestionReceiptSchema (DATA-03 canonical pin, Δ14)', () => {
  it('accepts the canonical shape, with and without the materialization handle', () => {
    expect(IngestionReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(IngestionReceiptSchema.safeParse({ ...receipt, artifactId: ARTIFACT_ID }).success).toBe(true);
  });

  it.each([
    ['uppercase digest (producers must hand over measured lowercase hex)', { ...receipt, sha256: 'A'.repeat(64) }],
    ['short digest', { ...receipt, sha256: 'a'.repeat(63) }],
    ['non-hex digest', { ...receipt, sha256: 'nope' }],
    ['empty storageKey', { ...receipt, storageKey: '' }],
    ['control characters in versionId', { ...receipt, versionId: 'v\n1' }],
    ['fractional byte count', { ...receipt, sizeBytes: 1.5 }],
    ['negative byte count', { ...receipt, sizeBytes: -1 }],
    ['unsafe integer byte count', { ...receipt, sizeBytes: Number.MAX_SAFE_INTEGER + 10 }],
    ['non-uuid artifactId', { ...receipt, artifactId: 'art-1' }],
    ['unknown extra field (strict)', { ...receipt, checksum: 'md5:deadbeef' }],
    ['missing storageKey', { versionId: 'v1', sha256: SHA, sizeBytes: 10 }],
  ])('refuses %s', (_label, value) => {
    expect(IngestionReceiptSchema.safeParse(value).success).toBe(false);
    expect(() => assertIngestionReceipt(value)).toThrow(IngestionReceiptError);
  });

  it('assertIngestionReceipt returns the validated pin unchanged', () => {
    expect(assertIngestionReceipt(receipt)).toEqual(receipt);
  });
});

describe('READY payload envelope', () => {
  it('withIngestionSource fails closed and never mutates the caller input', () => {
    const input = { mode: 'parse', artifactIds: [ARTIFACT_ID] };
    const frozen = JSON.parse(JSON.stringify(input));
    expect(() => withIngestionSource(input, { ...receipt, sha256: 'nope' })).toThrow(IngestionReceiptError);
    expect(input).toEqual(frozen);
    expect(Object.keys(input)).not.toContain(INGESTION_SOURCE_FIELD);
  });

  it('drops the pre-contract __source key so one envelope tells one story', () => {
    const stale: IngestionReceipt = { ...receipt, storageKey: 'stale/key', versionId: 'v0' };
    const envelope = withIngestionSource(
      { mode: 'parse', [LEGACY_INGESTION_SOURCE_FIELD]: stale },
      receipt
    );
    expect(LEGACY_INGESTION_SOURCE_FIELD in envelope).toBe(false);
    expect(envelope[INGESTION_SOURCE_FIELD]).toEqual(receipt);
  });

  it('survives the JSON round trip exactly as both DB rows store it', () => {
    const envelope = JSON.parse(JSON.stringify(withIngestionSource({ mode: 'parse' }, receipt)));
    expect(resolveIngestionSource(envelope)).toEqual(receipt);
  });

  it('resolveIngestionSource returns null — never an error — when no pin exists', () => {
    expect(resolveIngestionSource({ mode: 'parse', text: 'inline document' })).toBeNull();
    expect(resolveIngestionSource({})).toBeNull();
    expect(resolveIngestionSource(null)).toBeNull();
    expect(resolveIngestionSource(undefined)).toBeNull();
    expect(resolveIngestionSource(['not', 'an', 'object'])).toBeNull();
  });

  it('reads the legacy __source key so operations admitted pre-cutover still resolve', () => {
    expect(resolveIngestionSource({ mode: 'parse', [LEGACY_INGESTION_SOURCE_FIELD]: receipt })).toEqual(receipt);
  });

  it('prefers the canonical key when both are present', () => {
    const canonical = { ...receipt, versionId: 'v-new' };
    const legacy = { ...receipt, versionId: 'v-old' };
    const payload = {
      [INGESTION_SOURCE_FIELD]: canonical,
      [LEGACY_INGESTION_SOURCE_FIELD]: legacy,
    };
    expect(resolveIngestionSource(payload)?.versionId).toBe('v-new');
  });

  it('refuses a present-but-malformed pin instead of downgrading to no-source', () => {
    expect(() => resolveIngestionSource({ mode: 'parse', [INGESTION_SOURCE_FIELD]: { storageKey: 'k' } })).toThrow(
      IngestionReceiptError
    );
  });
});
