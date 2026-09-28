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
    ['non-hex digest', { ...basePin, sha256: 'nope' }],
    ['negative byte count', { ...basePin, sizeBytes: -2 }],
    ['unknown extra field', { ...basePin, checksum: 'md5:x' }],
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
