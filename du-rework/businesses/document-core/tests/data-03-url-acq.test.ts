/**
 * W-DATA-03-URL-ACQ: a URL-sourced task must not be runnable until its source is READY.
 *
 * The gap pinned here: the source-pin check used to run only when at least one
 * artifact had been read. A URL task whose acquisition never reached READY has no
 * materialized artifact, so the check was SKIPPED — and when the task also carried
 * inline text, parse mode consumed that text and reported success for bytes the
 * platform had never fetched.
 *
 * Asserted: pin + no artifact => unresolved (step body never runs); pin +
 * non-matching artifacts => mismatch; pin + matching artifact => parses the PINNED
 * bytes and ignores inline text; no pin => the ordinary inline path is untouched;
 * a failed acquisition leaves no partial bytes behind.
 */

import { createHash } from 'node:crypto';
import { IngestAction } from '../src/actions/ingest';
import { MockTaskContext } from './fixtures/mock-context';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const PINNED = Buffer.from('item,total' + String.fromCharCode(10) + 'widget,10', 'utf8');

// The canonical pin shape is IngestionReceiptSchema (strict): storageKey,
// versionId, sha256, sizeBytes, and an OPTIONAL artifactId handle. There is no
// url field on purpose — the pin names stored bytes, not a location to re-fetch.
function pinFor(bytes: Buffer) {
  return {
    storageKey: 'art-pinned',
    versionId: 'v1',
    sha256: sha256(bytes),
    sizeBytes: bytes.length,
  };
}

describe('W-DATA-03: a URL task is not runnable before its source is READY', () => {
  it('refuses a pin with no materialized artifact, even with inline text present', async () => {
    const ctx = new MockTaskContext();
    const input = IngestAction.validateInput({
      mode: 'parse',
      source: pinFor(PINNED),
      text: 'inline text that is NOT the pinned document',
    });
    let caught: unknown;
    try {
      await IngestAction.prepareSources(ctx, input);
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe('INGESTION_SOURCE_UNRESOLVED');
  });

  it('refuses a pin whose artifacts were read but do not match', async () => {
    const ctx = new MockTaskContext();
    const other = Buffer.from('completely different bytes', 'utf8');
    const ref = await ctx.artifacts.write(other, 'other.csv', 'text/csv');
    const input = IngestAction.validateInput({
      mode: 'parse',
      source: pinFor(PINNED),
      artifactIds: [ref.artifactId],
    });
    let caught: unknown;
    try {
      await IngestAction.prepareSources(ctx, input);
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe('SOURCE_PIN_MISMATCH');
  });
  it('parses the PINNED bytes and ignores attached inline text', async () => {
    const ctx = new MockTaskContext();
    const ref = await ctx.artifacts.write(PINNED, 'invoice.csv', 'text/csv');
    const input = IngestAction.validateInput({
      mode: 'parse',
      source: pinFor(PINNED),
      artifactIds: [ref.artifactId],
      text: 'inline text that is NOT the pinned document',
    });
    const sources = await IngestAction.prepareSources(ctx, input);
    // The inline text is dropped: only the pinned object may satisfy the task.
    expect(sources.inlineText).toBeUndefined();
    expect(sha256(sources.buffers[0] as Buffer)).toBe(sha256(PINNED));
  });
});

describe('W-DATA-03: the inline path is untouched when there is no pin', () => {
  it('accepts inline text with no source pin (ordinary case)', async () => {
    const ctx = new MockTaskContext();
    const input = IngestAction.validateInput({ mode: 'parse', text: 'plain inline document' });
    const sources = await IngestAction.prepareSources(ctx, input);
    expect(sources.inlineText).toBe('plain inline document');
    const result = await IngestAction.executeRecipe(ctx, IngestAction.selectRecipe(input), input, sources);
    expect(result.text).toBe('plain inline document');
  });
});

describe('W-DATA-03: a failed acquisition leaves nothing parseable', () => {
  it('a pin with zero materialized bytes yields no buffers to parse', async () => {
    const ctx = new MockTaskContext();
    const input = IngestAction.validateInput({
      mode: 'parse',
      source: pinFor(PINNED),
      text: 'leftover text from a failed acquisition',
    });
    let caught: unknown;
    try {
      await IngestAction.prepareSources(ctx, input);
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe('INGESTION_SOURCE_UNRESOLVED');
    // Nothing partial was written into the context store either.
    expect(ctx.artifactsStore.size).toBe(0);
    expect(ctx.checkpointsStore.size).toBe(0);
  });
});