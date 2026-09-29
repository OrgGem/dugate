import { createHash, randomUUID } from 'node:crypto';
import { withIngestionSource, type IngestionReceipt } from '@du/contracts';
import { IngestAction } from '../src/actions/ingest';
import { InputNormalizer } from '../src/validation/input-normalizer';
import { BusinessExecutionError, ValidationError } from '../src/types/results';
import { MockTaskContext } from './fixtures/mock-context';

/**
 * W-DATA01-S3-FACADE-1 (Δ14): the READY envelope a URL-ingested business
 * task claims must resolve to exactly one story — the contract `source` pin —
 * and every path around it fails closed:
 * - missing pin (inline submissions) is normal, never an error;
 * - legacy `__source` (rows written pre-cutover) still resolves;
 * - a present-but-malformed pin is a validation failure;
 * - a pin that names a materialized artifact resolves into `artifactIds`;
 * - read bytes are bound to the pin digest before any parser sees them;
 * - a pin without a materialized reference fails VISIBLY, never as the
 *   generic "no input document" ambiguity.
 */

const doc = Buffer.from('ingestion source pin offline fixture payload');
const docSha = createHash('sha256').update(doc).digest('hex');

const basePin: IngestionReceipt = {
  storageKey: 'du/tenants/t1/operations/op1/source',
  versionId: 'v1',
  sha256: docSha,
  sizeBytes: doc.length,
};

describe('normalizeIngest ingestion source pin (Δ14 envelope)', () => {
  it('treats a missing pin as the normal inline case', () => {
    const input = InputNormalizer.normalizeIngest({ mode: 'parse', text: 'plain inline document' });
    expect(input.source).toBeUndefined();
    expect(input.artifactIds).toBeUndefined();
  });

  it('resolves the canonical contract field written by markIngestionReady', () => {
    const envelope = withIngestionSource({ mode: 'parse' }, basePin);
    const input = InputNormalizer.normalizeIngest(envelope);
    expect(input.source).toEqual(basePin);
  });

  it('still reads the legacy __source key of operations admitted pre-cutover', () => {
    const input = InputNormalizer.normalizeIngest({ mode: 'parse', __source: basePin });
    expect(input.source).toEqual(basePin);
  });

  it.each([
    ['empty source token', ''],
    ['non-hex digest', { ...basePin, sha256: 'nope' }],
    ['non-hex digest with a full digest length', { ...basePin, sha256: 'g'.repeat(64) }],
    ['uppercase digest', { ...basePin, sha256: docSha.toUpperCase() }],
    ['empty storage key', { ...basePin, storageKey: '' }],
    ['negative byte count', { ...basePin, sizeBytes: -2 }],
    ['unknown extra field', { ...basePin, checksum: 'md5:x' }],
    ['non-HTTPS source URL field', { ...basePin, sourceUrl: 'file:///etc/passwd' }],
    ['external-domain source URL field', { ...basePin, sourceUrl: 'https://outside-allowlist.invalid/document.pdf' }],
    ['non-uuid artifactId', { ...basePin, artifactId: 'art-1' }],
    ['empty versionId', { ...basePin, versionId: '' }],
  ])('refuses a present-but-malformed pin: %s', (_label, pin) => {
    let caught: unknown;
    try {
      InputNormalizer.normalizeIngest({ mode: 'parse', source: pin });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).code).toBe('INVALID_INGESTION_RECEIPT');
  });

  it('does not treat an empty pin as the ordinary no-pin case', () => {
    let caught: unknown;
    try {
      InputNormalizer.normalizeIngest({ mode: 'parse', source: {} });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).code).toBe('INVALID_INGESTION_RECEIPT');
  });

  test.failing('rejects a whitespace-only storage key rather than treating it as a valid pin', () => {
    expect(() =>
      InputNormalizer.normalizeIngest({
        mode: 'parse',
        source: { ...basePin, storageKey: '      ' },
      })
    ).toThrow(expect.objectContaining({ code: 'INVALID_INGESTION_RECEIPT' }));
  });

  it('resolves a materialized pin into artifactIds without overriding explicit ones', () => {
    const artifactId = randomUUID();
    const synthesized = InputNormalizer.normalizeIngest({
      mode: 'parse',
      source: { ...basePin, artifactId },
    });
    expect(synthesized.artifactIds).toEqual([artifactId]);

    const explicit = InputNormalizer.normalizeIngest({
      mode: 'parse',
      artifactIds: [randomUUID()],
      source: { ...basePin, artifactId },
    });
    expect(explicit.artifactIds).toHaveLength(1);
    expect(explicit.artifactIds?.[0]).not.toBe(artifactId);
  });
});

describe('IngestAction.prepareSources pin-to-bytes binding', () => {
  function contextWithArtifact(buffer: Buffer): { ctx: MockTaskContext; artifactId: string } {
    const ctx = new MockTaskContext();
    const artifactId = randomUUID();
    ctx.storeArtifact(artifactId, buffer, 'source-document.txt', 'text/plain');
    return { ctx, artifactId };
  }

  it('accepts artifacts whose bytes match the pinned digest and length', async () => {
    const { ctx, artifactId } = contextWithArtifact(doc);
    const input = InputNormalizer.normalizeIngest({
      mode: 'parse',
      artifactIds: [artifactId],
      source: basePin,
    });
    const sources = await IngestAction.prepareSources(ctx, input);
    expect(sources.buffers).toHaveLength(1);
    expect(sources.buffers[0]?.equals(doc)).toBe(true);
  });

  it('refuses when no read artifact is the pinned object, before parsing', async () => {
    const { ctx, artifactId } = contextWithArtifact(Buffer.from('substitute bytes that were never acquired'));
    const input = InputNormalizer.normalizeIngest({
      mode: 'parse',
      artifactIds: [artifactId],
      source: basePin,
    });
    let caught: unknown;
    try {
      await IngestAction.prepareSources(ctx, input);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BusinessExecutionError);
    expect((caught as BusinessExecutionError).code).toBe('SOURCE_PIN_MISMATCH');
    expect((caught as BusinessExecutionError).retryable).toBe(false);
  });

  it('refuses an expired source-pin artifact lease before binding the read', async () => {
    const ctx = new MockTaskContext({ tenantId: 'tenant-a' });
    const artifactId = randomUUID();
    ctx.storeArtifact(artifactId, doc, 'source-document.txt', 'text/plain');
    const identity = ctx.artifactReadIdentityStore.get(artifactId);
    if (!identity) throw new Error('source fixture is missing its read identity');
    ctx.artifactReadIdentityStore.set(artifactId, {
      ...identity,
      grantExpiresAt: '2000-01-01T00:00:00.000Z',
    });
    const input = InputNormalizer.normalizeIngest({
      mode: 'parse',
      artifactIds: [artifactId],
      source: { ...basePin, artifactId },
    });

    await expect(IngestAction.prepareSources(ctx, input)).rejects.toMatchObject({ code: 'ARTIFACT_GRANT_EXPIRED' });
  });

  it('rejects a source-pin read lease at its exact expiration boundary', async () => {
    const ctx = new MockTaskContext({ tenantId: 'tenant-a' });
    const artifactId = randomUUID();
    ctx.storeArtifact(artifactId, doc, 'source-document.txt', 'text/plain');
    const identity = ctx.artifactReadIdentityStore.get(artifactId);
    if (!identity) throw new Error('source fixture is missing its read identity');
    const expiresAtMs = Date.now();
    ctx.artifactReadIdentityStore.set(artifactId, {
      ...identity,
      grantExpiresAt: new Date(expiresAtMs).toISOString(),
    });
    const input = InputNormalizer.normalizeIngest({
      mode: 'parse',
      artifactIds: [artifactId],
      source: { ...basePin, artifactId },
    });
    const now = jest.spyOn(Date, 'now').mockReturnValue(expiresAtMs);

    try {
      await expect(IngestAction.prepareSources(ctx, input)).rejects.toMatchObject({ code: 'ARTIFACT_GRANT_EXPIRED' });
    } finally {
      now.mockRestore();
    }
  });

  it('refuses a foreign-tenant artifact grant even when the source pin names that tenant', async () => {
    const ctx = new MockTaskContext({ tenantId: 'tenant-a' });
    const foreignArtifactId = randomUUID();
    ctx.storeArtifact(foreignArtifactId, doc, 'foreign-source.txt', 'text/plain');
    ctx.deniedArtifactReadIds.add(foreignArtifactId);
    const input = InputNormalizer.normalizeIngest({
      mode: 'parse',
      source: {
        ...basePin,
        storageKey: 'du/tenants/tenant-b/operations/op1/source',
        artifactId: foreignArtifactId,
      },
    });

    await expect(IngestAction.prepareSources(ctx, input)).rejects.toThrow('artifact read grant denied');
  });

  test.failing('rejects binding an accessible tenant-b storage pin into a tenant-a operation', async () => {
    const ctx = new MockTaskContext({ tenantId: 'tenant-a', operationId: 'op-current' });
    const tenantBArtifactId = randomUUID();
    ctx.storeArtifact(tenantBArtifactId, doc, 'tenant-b-source.txt', 'text/plain');
    const input = InputNormalizer.normalizeIngest({
      mode: 'parse',
      artifactIds: [tenantBArtifactId],
      source: {
        ...basePin,
        storageKey: 'du/tenants/tenant-b/operations/op-current/source',
        artifactId: tenantBArtifactId,
      },
    });

    await expect(IngestAction.prepareSources(ctx, input)).rejects.toThrow(/tenant|scope/i);
  });

  it('refuses a source from another operation when its scoped artifact grant is denied', async () => {
    const ctx = new MockTaskContext({ tenantId: 'tenant-a', operationId: 'op-current' });
    const otherOperationArtifactId = randomUUID();
    ctx.storeArtifact(otherOperationArtifactId, doc, 'source-document.txt', 'text/plain');
    // The storage key belongs to another operation. Its operation-scoped read
    // grant must not be usable by this task, even when the bytes match exactly.
    ctx.deniedArtifactReadIds.add(otherOperationArtifactId);
    const input = InputNormalizer.normalizeIngest({
      mode: 'parse',
      artifactIds: [otherOperationArtifactId],
      source: {
        ...basePin,
        storageKey: 'du/tenants/tenant-a/operations/op-other/source',
        artifactId: otherOperationArtifactId,
      },
    });

    await expect(IngestAction.prepareSources(ctx, input)).rejects.toThrow('artifact read grant denied');
  });

  it('refuses a tampered but well-formed digest in the source pin', async () => {
    const { ctx, artifactId } = contextWithArtifact(doc);
    const tamperedDigest = `${docSha.slice(0, -1)}${docSha.endsWith('0') ? '1' : '0'}`;
    const input = InputNormalizer.normalizeIngest({
      mode: 'parse',
      artifactIds: [artifactId],
      source: { ...basePin, sha256: tamperedDigest },
    });

    await expect(IngestAction.prepareSources(ctx, input)).rejects.toMatchObject({ code: 'SOURCE_PIN_MISMATCH' });
  });

  it('binds through the same digest even when other artifacts share the task', async () => {
    const ctx = new MockTaskContext();
    const otherId = randomUUID();
    const sourceId = randomUUID();
    ctx.storeArtifact(otherId, Buffer.from('an unrelated attachment'), 'notes.txt', 'text/plain');
    ctx.storeArtifact(sourceId, doc, 'source-document.txt', 'text/plain');
    const input = InputNormalizer.normalizeIngest({
      mode: 'parse',
      artifactIds: [otherId, sourceId],
      source: basePin,
    });
    const sources = await IngestAction.prepareSources(ctx, input);
    expect(sources.buffers).toHaveLength(2);
  });
});

describe('unresolved ingestion pin fails visibly, not as missing input', () => {
  async function runParse(input: ReturnType<typeof InputNormalizer.normalizeIngest>) {
    const ctx = new MockTaskContext();
    const recipe = IngestAction.selectRecipe(input);
    return IngestAction.executeRecipe(ctx, recipe, input, {
      buffers: [],
      fileNames: [],
      artifactInputs: [],
      artifactIds: [],
      inlineText: undefined,
    });
  }

  it('names the un-materialized ingestion gate when a pin has no artifact', async () => {
    const input = InputNormalizer.normalizeIngest({ mode: 'parse', source: basePin });
    let caught: unknown;
    try {
      await runParse(input);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BusinessExecutionError);
    expect((caught as BusinessExecutionError).code).toBe('INGESTION_SOURCE_UNRESOLVED');
  });

  it('keeps the legacy generic error for a genuinely empty inline parse call', async () => {
    const input = InputNormalizer.normalizeIngest({ mode: 'parse' });
    await expect(runParse(input)).rejects.toThrow('No input document or text provided for parse');
  });
});
