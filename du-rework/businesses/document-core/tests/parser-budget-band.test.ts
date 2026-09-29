import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { MULTIPART_MIN_TOTAL_BYTES } from '@du/contracts';
import { PdfSplitter } from '@du/document-kit';
import type { DocumentParserFactory } from '@du/document-kit';
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

  it('keeps the explicit parser budget below the band ceiling from reaching parse execution', async () => {
    await expect(
      ParserBudgetHelper.safeParseBuffer(bareCtx(), Buffer.from('small input'), 'small.txt', {
        maxBufferSizeBytes: CEILING + 1,
      })
    ).rejects.toMatchObject({ code: 'INVALID_PARSER_BUDGET' });
  });

  it('rejects budgets below the one-byte lower bound without silently clamping them', () => {
    for (const belowMinimum of [0, -1, 0.5]) {
      expect(() =>
        ParserBudgetHelper.resolveParserBudget(bareCtx(), { maxBufferSizeBytes: belowMinimum })
      ).toThrow(expect.objectContaining({ code: 'INVALID_PARSER_BUDGET' }));
    }

    expect(
      ParserBudgetHelper.resolveParserBudget(bareCtx(), { maxBufferSizeBytes: 1 }).maxBufferSizeBytes
    ).toBe(1);
  });

  it('rejects non-finite, non-integral, and malformed budget overrides without invoking a parser', async () => {
    for (const maxBufferSizeBytes of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, '1024' as unknown as number]) {
      expect(() => ParserBudgetHelper.resolveParserBudget(bareCtx(), { maxBufferSizeBytes })).toThrow(
        expect.objectContaining({ code: 'INVALID_PARSER_BUDGET' })
      );
    }

    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1000' as unknown as number]) {
      expect(() => ParserBudgetHelper.resolveParserBudget(bareCtx(), { timeoutMs })).toThrow(
        expect.objectContaining({ code: 'INVALID_PARSER_BUDGET' })
      );
    }

    const parserFactory = { parseBuffer: jest.fn() } as unknown as DocumentParserFactory;
    await expect(
      ParserBudgetHelper.safeParseBuffer(bareCtx(), Buffer.from('content'), 'content.txt', {
        timeoutMs: 0,
        parserFactory,
      })
    ).rejects.toMatchObject({ code: 'INVALID_PARSER_BUDGET' });
    expect(parserFactory.parseBuffer).not.toHaveBeenCalled();
  });

  it('treats explicit null config as absent while preserving the finite defaults', () => {
    const resolved = ParserBudgetHelper.resolveParserBudget(bareCtx(), {
      maxBufferSizeBytes: null as unknown as number,
      timeoutMs: null as unknown as number,
    });

    expect(resolved).toEqual({
      maxBufferSizeBytes: ParserBudgetHelper.DEFAULT_MAX_BUFFER_SIZE_BYTES,
      timeoutMs: ParserBudgetHelper.DEFAULT_PARSER_TIMEOUT_MS,
    });
  });

  it('rejects negative and zero PDF page selectors at the page-count boundary', () => {
    for (const expression of ['-1', '0', '1--2']) {
      expect(() => PdfSplitter.parsePageExpression(expression)).toThrow(/positive|Invalid page range/);
    }
  });

  test.failing('rejects parser metadata that reports a negative page count', async () => {
    const parserFactory = {
      parseBuffer: jest.fn(async () => ({
        text: 'content',
        markdown: 'content',
        metadata: {
          pageCount: -1,
          wordCount: 1,
          characterCount: 7,
          detectedFormat: 'txt' as const,
          parser: 'fixture',
          provenance: 'native_parse' as const,
        },
        warnings: [],
      })),
    } as unknown as DocumentParserFactory;

    const parsed = await ParserBudgetHelper.safeParseBuffer(
      bareCtx(),
      Buffer.from('content'),
      'content.txt',
      { parserFactory }
    );

    expect(parsed.metadata.pageCount).toBeGreaterThanOrEqual(0);
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

  it('rejects a declared artifact above the 64 MiB ceiling before transfer starts', async () => {
    const taskId = randomUUID();
    const stat = jest.fn(async () => ({
      fileName: 'above-ceiling.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: CEILING + 1,
      sha256: undefined,
    }));
    const readStream = jest.fn();
    const ctx = makeCtx({ taskId, stat, readStream });

    await expect(ParserBudgetHelper.readArtifact(ctx, randomUUID())).rejects.toMatchObject({
      code: 'DOCUMENT_TOO_LARGE',
    });
    expect(stat).toHaveBeenCalledTimes(1);
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

  it('stops before starting a transfer when the task deadline expires after stat', async () => {
    const taskId = randomUUID();
    let ctx: TaskContext;
    const stat = jest.fn(async () => {
      (ctx as unknown as { deadlineAt: string }).deadlineAt = new Date(Date.now() - 1).toISOString();
      return {
        fileName: 'deadline.txt',
        mimeType: 'text/plain',
        sizeBytes: 4,
        sha256: sha256(Buffer.from('data')),
      };
    });
    const readStream = jest.fn();
    ctx = makeCtx({ taskId, stat, readStream });
    (ctx as unknown as { deadlineAt: string }).deadlineAt = new Date(Date.now() + 30_000).toISOString();

    await expect(ParserBudgetHelper.readArtifact(ctx, randomUUID())).rejects.toMatchObject({
      code: 'DEADLINE_EXCEEDED',
    });
    expect(stat).toHaveBeenCalledTimes(1);
    expect(readStream).not.toHaveBeenCalled();
    await expectWorkspaceSweep(taskId);
  });

  it('fails closed on empty or truncated disk-backed streams and removes each partial workspace', async () => {
    for (const transferred of [Buffer.alloc(0), Buffer.from('short')]) {
      const taskId = randomUUID();
      const expected = Buffer.from('complete artifact');
      const stat = jest.fn(async () => ({
        fileName: 'truncated.txt',
        mimeType: 'text/plain',
        sizeBytes: expected.length,
        sha256: sha256(expected),
      }));
      const readStream = jest.fn(async () => chunkStream(transferred, 2));
      const ctx = makeCtx({ taskId, stat, readStream });

      await expect(ParserBudgetHelper.readArtifact(ctx, randomUUID())).rejects.toMatchObject({
        code: 'ARTIFACT_SIZE_MISMATCH',
      });
      expect(readStream).toHaveBeenCalledTimes(1);
      await expectWorkspaceSweep(taskId);
    }
  });

  it('reclaims workspaces on repeated mid-stream budget violations', async () => {
    const taskId = randomUUID();
    const oversized = textBytes(ParserBudgetHelper.DEFAULT_MAX_BUFFER_SIZE_BYTES + 1, 'over-budget');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const stat = jest.fn(async () => ({
        fileName: 'unknown-size.txt',
        mimeType: 'text/plain',
        sizeBytes: undefined,
        sha256: undefined,
      }));
      const readStream = jest.fn(async () => chunkStream(oversized, 256 * 1024));
      const ctx = makeCtx({ taskId, stat, readStream });

      await expect(ParserBudgetHelper.readArtifact(ctx, randomUUID())).rejects.toMatchObject({
        code: 'DOCUMENT_TOO_LARGE',
      });
      await expectWorkspaceSweep(taskId);
    }
  });

  it('reclaims workspaces idempotently after repeated caller aborts during transfer', async () => {
    const taskId = randomUUID();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const stat = jest.fn(async () => ({
        fileName: 'aborted.txt',
        mimeType: 'text/plain',
        sizeBytes: 64,
        sha256: undefined,
      }));
      const readStream = jest.fn(async () => {
        let sent = false;
        return new Readable({
          read() {
            if (sent) return;
            sent = true;
            this.push(Buffer.from('partial'));
            setTimeout(() => controller.abort(new Error('lease lost during parser acquisition')), 0);
          },
        });
      });
      const ctx = makeCtx({ taskId, stat, readStream });
      (ctx as unknown as { signal: AbortSignal }).signal = controller.signal;

      await expect(ParserBudgetHelper.readArtifact(ctx, randomUUID())).rejects.toMatchObject({
        code: 'LEASE_LOST',
      });
      expect(controller.signal.aborted).toBe(true);
      await expectWorkspaceSweep(taskId);
    }
  });

  it('aborts an in-progress storage fetch when the parser deadline expires', async () => {
    const taskId = randomUUID();
    const stat = jest.fn(async () => ({
      fileName: 'slow-scan.png',
      mimeType: 'image/png',
      sizeBytes: 4,
      sha256: sha256(Buffer.from('scan')),
    }));
    const readStream = jest.fn(async (_artifactId: string, options: { signal?: AbortSignal }) =>
      new Promise<Readable>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('storage read aborted')), { once: true });
      })
    );
    const ctx = makeCtx({ taskId, stat, readStream });
    (ctx as unknown as { deadlineAt: string }).deadlineAt = new Date(Date.now() + 1_000).toISOString();

    await expect(ParserBudgetHelper.readArtifact(ctx, randomUUID())).rejects.toMatchObject({ code: 'DOCUMENT_TIMEOUT' });
    expect(readStream).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    await expectWorkspaceSweep(taskId);
  });

  it('aborts a stalled stat grant lookup under the acquisition timer', async () => {
    const taskId = randomUUID();
    let statSignal: AbortSignal | undefined;
    const stat = jest.fn((_artifactId: string, options?: { signal?: AbortSignal }) => {
      statSignal = options?.signal;
      return new Promise<{ sizeBytes: number }>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('stat grant aborted')), { once: true });
      });
    });
    const readStream = jest.fn();
    const ctx = makeCtx({ taskId, stat, readStream });

    jest.useFakeTimers();
    try {
      const pending = ParserBudgetHelper.readArtifact(ctx, randomUUID());
      const timeoutAssertion = expect(pending).rejects.toMatchObject({ code: 'DOCUMENT_TIMEOUT' });
      await jest.advanceTimersByTimeAsync(ParserBudgetHelper.DEFAULT_PARSER_TIMEOUT_MS);
      await timeoutAssertion;
      expect(stat).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(statSignal?.aborted).toBe(true);
      expect(readStream).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('aborts a stream after transfer starts when the acquisition timer expires', async () => {
    const taskId = randomUUID();
    const stat = jest.fn(async () => ({
      fileName: 'slow-transfer.png',
      mimeType: 'image/png',
      sizeBytes: 4,
      sha256: sha256(Buffer.from('scan')),
    }));
    let transferSignal: AbortSignal | undefined;
    const readStream = jest.fn(async (_artifactId: string, options?: { signal?: AbortSignal }) => {
      transferSignal = options?.signal;
      return new Readable({ read() {} });
    });
    const ctx = makeCtx({ taskId, stat, readStream });

    jest.useFakeTimers();
    try {
      const pending = ParserBudgetHelper.readArtifact(ctx, randomUUID());
      const timeoutAssertion = expect(pending).rejects.toMatchObject({ code: 'DOCUMENT_TIMEOUT' });
      await jest.advanceTimersByTimeAsync(ParserBudgetHelper.DEFAULT_PARSER_TIMEOUT_MS);
      await timeoutAssertion;
      expect(readStream).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(transferSignal?.aborted).toBe(true);
      await expectWorkspaceSweep(taskId);
    } finally {
      jest.useRealTimers();
    }
  });
});
