import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { MULTIPART_MIN_TOTAL_BYTES } from '@du/contracts';
import { TEMP_WORKSPACE_PREFIX } from '@du/worker-sdk';
import { ParserBudgetHelper } from '../src/pipelines/parser-budget';
import type { TaskContext } from '../src/types/context';

/**
 * DATA-04 (packet W-DATA04-STREAM-1): the parser budget's RSS ceiling, and the
 * disk-backed read that keeps the ceiling honest.
 *
 * T20-D1 closed the 1 MiB - 64 MiB wire gap on the upload side; this suite
 * pins the consumer half of the same policy. A parse budget may not be
 * raised above the direct band ceiling, so no caller can ask this layer to
 * materialize a multipart-band artifact in the heap, and an artifact inside
 * the band is streamed to disk and materialized exactly once.
 *
 * Offline only: fake facades, real temp files, no DB/Redis/S3, no sockets.
 */

jest.setTimeout(180_000);

const MiB = 1024 * 1024;
const CEILING = ParserBudgetHelper.MAX_BUFFER_SIZE_CEILING_BYTES;

function bareCtx(): TaskContext {
  return { taskId: 'budget-policy' } as unknown as TaskContext;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function textBytes(sizeBytes: number, seed: string): Buffer {
  const base = Buffer.from(seed + ':', 'utf8');
  const out = Buffer.alloc(sizeBytes);
  for (let i = 0; i < sizeBytes; i += base.length) {
    base.copy(out, i, 0, Math.min(base.length, sizeBytes - i));
  }
  return out;
}

function chunkStream(buffer: Buffer, chunkBytes: number): Readable {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += chunkBytes) {
    chunks.push(buffer.subarray(offset, Math.min(offset + chunkBytes, buffer.length)));
  }
  return Readable.from(chunks);
}

function makeCtx(init: {
  taskId: string;
  stat: jest.Mock;
  readStream: jest.Mock;
  readWithMetadata?: jest.Mock;
  maxBufferSizeBytes?: number;
}): TaskContext {
  return {
    taskId: init.taskId,
    operationId: randomUUID(),
    businessId: 'document-core',
    businessVersion: '1.0.0',
    tenantId: 'tenant-test',
    artifacts: {
      read: async () => {
        throw new Error('buffer-only read must not be reached');
      },
      write: async () => {
        throw new Error('write must not be reached');
      },
      stat: init.stat,
      readStream: init.readStream,
      ...(init.readWithMetadata ? { readWithMetadata: init.readWithMetadata } : {}),
    },
    profile: { maxBufferSizeBytes: init.maxBufferSizeBytes },
  } as unknown as TaskContext;
}

async function expectWorkspaceSweep(taskId: string): Promise<void> {
  const safeTaskId = taskId.replace(/[^A-Za-z0-9-]/g, '-');
  const entries = await readdir(tmpdir());
  expect(entries.filter((name) => name.startsWith(TEMP_WORKSPACE_PREFIX + safeTaskId + '-'))).toEqual([]);
}

describe('parser budget RSS ceiling (DATA-04 band policy)', () => {
  it('derives the ceiling from the DATA-00-M contract floor', () => {
    expect(CEILING).toBe(MULTIPART_MIN_TOTAL_BYTES - 1);
    expect(CEILING).toBe(64 * MiB);
  });

  it('keeps the default business budget inside the band', () => {
    expect(ParserBudgetHelper.DEFAULT_MAX_BUFFER_SIZE_BYTES).toBeLessThanOrEqual(CEILING);
    expect(ParserBudgetHelper.resolveParserBudget(bareCtx()).maxBufferSizeBytes).toBe(
      ParserBudgetHelper.DEFAULT_MAX_BUFFER_SIZE_BYTES
    );
  });

  it('accepts a caller budget exactly at the ceiling', () => {
    const resolved = ParserBudgetHelper.resolveParserBudget(bareCtx(), {
      maxBufferSizeBytes: CEILING,
    });
    expect(resolved.maxBufferSizeBytes).toBe(CEILING);
  });

  it('refuses a caller budget that would materialize a multipart-band artifact', () => {
    for (const over of [CEILING + 1, 128 * MiB, MULTIPART_MIN_TOTAL_BYTES + 1]) {
      let code: string | undefined;
      try {
        ParserBudgetHelper.resolveParserBudget(bareCtx(), { maxBufferSizeBytes: over });
      } catch (err) {
        code = (err as { code?: string }).code;
      }
      expect([String(over), code]).toEqual([String(over), 'INVALID_PARSER_BUDGET']);
    }
  });
});

describe('disk-backed read inside the band', () => {
  it('materializes an 8 MiB artifact exactly once, with the RSS ceiling honored', async () => {
    const taskId = randomUUID();
    const artifactId = randomUUID();
    const bytes = textBytes(8 * MiB, 'band-doc');
    const budget = ParserBudgetHelper.DEFAULT_MAX_BUFFER_SIZE_BYTES;
    const stat = jest.fn(async () => ({
      fileName: 'band.txt',
      mimeType: 'text/plain',
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
    }));
    const readStream = jest.fn(async () => chunkStream(bytes, 256 * 1024));
    const ctx = makeCtx({ taskId, stat, readStream });

    const pre: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      pre.push(process.memoryUsage().external);
    }
    pre.sort((a, b) => a - b);
    const baseline = pre[10] ?? 0;
    let peak = 0;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().external - baseline);
    }, 5);

    const artifact = await ParserBudgetHelper.readArtifact(ctx, artifactId);
    clearInterval(sampler);
    peak = Math.max(peak, process.memoryUsage().external - baseline);

    expect(artifact.buffer.equals(bytes)).toBe(true);
    expect(artifact.formatMetadata.declaredFileName).toBe('band.txt');
    expect(readStream).toHaveBeenCalledTimes(1);
    expect(bytes.length).toBeLessThanOrEqual(budget);
    await expectWorkspaceSweep(taskId);

    const mib = (n: number) => (n / MiB).toFixed(2);
    console.log(
      'PARSER-RSS budget=' + mib(budget) + 'MiB peakMarginalExternal=' + mib(peak) +
      'MiB residentExternal=' + mib(process.memoryUsage().external - baseline) + 'MiB'
    );
    // One materialization of the budget is the design; a pre-buffering
    // regression (stream retained in heap beside the buffer) doubles it.
    expect(peak).toBeLessThanOrEqual(Math.round(budget * 1.75));
  });

  it('moves no byte and materializes nothing for a declared artifact above the budget', async () => {
    const taskId = randomUUID();
    const stat = jest.fn(async () => ({
      fileName: 'oversized.txt',
      mimeType: 'text/plain',
      sizeBytes: 24 * MiB,
      sha256: sha256(Buffer.from('x')),
    }));
    const readStream = jest.fn();
    const ctx = makeCtx({ taskId, stat, readStream });

    await expect(ParserBudgetHelper.readArtifact(ctx, randomUUID())).rejects.toMatchObject({
      code: 'DOCUMENT_TOO_LARGE',
    });
    expect(readStream).not.toHaveBeenCalled();
    await expectWorkspaceSweep(taskId);
  });

  it('refuses a band artifact above the signed business budget, before any byte moves', async () => {
    // DOCUMENT_TOO_LARGE at 12 MiB is the honest boundary of this cycle: the
    // upload band reaches 64 MiB, but the business parse budget is still the
    // PROPOSED 10 MiB and only DATA-00 section 6 can move it. Pinning it here
    // keeps the gap visible instead of silent (see receipt delta D9).
    const taskId = randomUUID();
    const stat = jest.fn(async () => ({
      fileName: 'above-default.txt',
      mimeType: 'text/plain',
      sizeBytes: 12 * MiB,
      sha256: undefined,
    }));
    const readStream = jest.fn();
    const ctx = makeCtx({ taskId, stat, readStream });

    await expect(ParserBudgetHelper.readArtifact(ctx, randomUUID())).rejects.toMatchObject({
      code: 'DOCUMENT_TOO_LARGE',
    });
    expect(readStream).not.toHaveBeenCalled();
    await expectWorkspaceSweep(taskId);
  });

  it('never hands a parser unverified bytes from a tampered grant', async () => {
    const taskId = randomUUID();
    const bytes = textBytes(4 * MiB, 'tampered-band');
    const stat = jest.fn(async () => ({
      fileName: 'tampered.txt',
      mimeType: 'text/plain',
      sizeBytes: bytes.length,
      sha256: '0'.repeat(64),
    }));
    const readStream = jest.fn(async () => chunkStream(bytes, 128 * 1024));
    const ctx = makeCtx({ taskId, stat, readStream });

    await expect(ParserBudgetHelper.readArtifact(ctx, randomUUID())).rejects.toMatchObject({
      code: 'ARTIFACT_INTEGRITY_MISMATCH',
    });
    await expectWorkspaceSweep(taskId);
  });
});
