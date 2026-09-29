import { createHash, randomUUID } from 'node:crypto';
import { readdir, stat as statFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { DocumentFormatDetector } from '@du/document-kit';
import { TEMP_WORKSPACE_PREFIX } from '@du/worker-sdk';
import { ParserBudgetHelper } from '../src/pipelines/parser-budget';
import { ArtifactReadResult, TaskContext } from '../src/types/context';

/**
 * DATA-04 Step B — disk-backed streaming acquisition (offline unit tests).
 * Covers: large-doc disk path with identity propagation, zero-byte size
 * pre-flight, mid-stream cap, declared-size/digest mismatch, inline exception,
 * cancel/lease fences mid-stream, buffer-only legacy path, and bounded file
 * lifetime (every outcome leaves no du-worker-<taskId> temp dir behind).
 */

const BUDGET_MAX = ParserBudgetHelper.DEFAULT_MAX_BUFFER_SIZE_BYTES;

interface FakeFacade {
  stat?: jest.Mock;
  readStream?: jest.Mock;
  read?: jest.Mock;
  readWithMetadata?: jest.Mock;
}

function makeCtx(init: {
  taskId: string;
  facade: FakeFacade;
  signal?: AbortSignal;
  cancelRequested?: boolean;
}) {
  const mustNotBeCalled = (name: string) =>
    jest.fn(async () => { throw new Error(`${name} must not be reached`); });
  return {
    taskId: init.taskId,
    operationId: randomUUID(),
    businessId: 'document-core',
    businessVersion: '1.0.0',
    tenantId: 'tenant-test',
    signal: init.signal,
    cancelRequested: init.cancelRequested,
    artifacts: {
      read: init.facade.read ?? mustNotBeCalled('read'),
      write: mustNotBeCalled('write'),
      ...(init.facade.stat ? { stat: init.facade.stat } : {}),
      ...(init.facade.readStream ? { readStream: init.facade.readStream } : {}),
      ...(init.facade.readWithMetadata ? { readWithMetadata: init.facade.readWithMetadata } : {}),
    },
  } as unknown as TaskContext;
}

async function expectWorkspaceSweep(taskId: string): Promise<void> {
  const safeTaskId = taskId.replace(/[^A-Za-z0-9-]/g, '-');
  const entries = await readdir(tmpdir());
  expect(entries.filter((name) => name.startsWith(`${TEMP_WORKSPACE_PREFIX}${safeTaskId}-`))).toEqual([]);
}

async function waitForPartialFile(taskId: string, artifactId: string): Promise<void> {
  const safeTaskId = taskId.replace(/[^A-Za-z0-9-]/g, '-');
  const prefix = `${TEMP_WORKSPACE_PREFIX}${safeTaskId}-`;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const workspaceName = (await readdir(tmpdir())).find((name) => name.startsWith(prefix));
    if (workspaceName) {
      try {
        const file = await statFile(join(tmpdir(), workspaceName, `${artifactId}.artifact`));
        if (file.size > 0) return;
      } catch {
        // The workspace or target can briefly be absent while acquisition starts.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('stream did not flush its first chunk to the temporary artifact file');
}

function textBytes(sizeBytes: number, seed: string): Buffer {
  const base = Buffer.from(`${seed}:`, 'utf8');
  const repeats = Math.ceil(sizeBytes / base.length);
  return Buffer.concat(Array.from({ length: repeats }, () => base), sizeBytes);
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function chunkStream(buffer: Buffer, chunkBytes: number): Readable {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += chunkBytes) {
    chunks.push(buffer.subarray(offset, Math.min(offset + chunkBytes, buffer.length)));
  }
  return Readable.from(chunks);
}

describe('ParserBudgetHelper.readArtifact — Step B disk-backed acquisition', () => {
  it('streams a large artifact to disk, verifies integrity, and propagates declared identity', async () => {
    const taskId = randomUUID();
    const artifactId = randomUUID();
    const bytes = textBytes(2 * 1024 * 1024, 'step-b-large-doc');
    const stat = jest.fn(async () => ({
      fileName: 'notes.txt',
      mimeType: 'text/plain',
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
    }));
    const readStream = jest.fn(async (_id: string, options?: {
      expectedSizeBytes?: number;
      expectedSha256?: string;
      expectedVersionId?: string;
    }) => {
      expect(options).toMatchObject({ expectedSha256: sha256(bytes), expectedSizeBytes: bytes.length });
      expect(options?.expectedVersionId).toBeUndefined();
      return chunkStream(bytes, 64 * 1024);
    });
    const ctx = makeCtx({ taskId, facade: { stat, readStream } });

    const artifact = await ParserBudgetHelper.readArtifact(ctx, artifactId);

    expect(artifact.buffer.equals(bytes)).toBe(true);
    expect(artifact.formatMetadata.declaredFileName).toBe('notes.txt');
    expect(artifact.formatMetadata.declaredMimeType).toBe('text/plain');
    const canonical = DocumentFormatDetector.detect(bytes, 'notes.txt', 'text/plain');
    expect(artifact.formatMetadata.canonicalFormat).toBe(canonical.format);
    expect(artifact.formatMetadata.canonicalMimeType).toBe(canonical.mimeType);
    expect(stat).toHaveBeenCalledWith(
      artifactId,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    await expectWorkspaceSweep(taskId);
  });

  it('rejects an over-budget declared size BEFORE any byte transfer', async () => {
    const taskId = randomUUID();
    const stat = jest.fn(async () => ({ sizeBytes: BUDGET_MAX + 1, sha256: sha256(Buffer.from('x')) }));
    const readStream = jest.fn();
    const ctx = makeCtx({ taskId, facade: { stat, readStream } });

    await expect(
      ParserBudgetHelper.readArtifact(ctx, randomUUID())
    ).rejects.toMatchObject({ code: 'DOCUMENT_TOO_LARGE' });
    expect(readStream).not.toHaveBeenCalled();
  });

  it('aborts mid-stream when bytes exceed the parser budget', async () => {
    const taskId = randomUUID();
    const stat = jest.fn(async () => ({ fileName: 'huge.txt', mimeType: 'text/plain' }));
    const readStream = jest.fn(async () => chunkStream(textBytes(BUDGET_MAX + 1, 'bomb'), 512 * 1024));
    const ctx = makeCtx({ taskId, facade: { stat, readStream } });

    await expect(
      ParserBudgetHelper.readArtifact(ctx, randomUUID())
    ).rejects.toMatchObject({ code: 'DOCUMENT_TOO_LARGE' });
    await expectWorkspaceSweep(taskId);
  });

  it('detects a lying declared size against the bytes that actually landed', async () => {
    const taskId = randomUUID();
    const bytes = textBytes(2 * 1024 * 1024, 'lying-size');
    const stat = jest.fn(async () => ({ sizeBytes: 1024 * 1024 + 100, sha256: undefined }));
    const readStream = jest.fn(async () => chunkStream(bytes, 256 * 1024));
    const ctx = makeCtx({ taskId, facade: { stat, readStream } });

    await expect(
      ParserBudgetHelper.readArtifact(ctx, randomUUID())
    ).rejects.toMatchObject({ code: 'ARTIFACT_SIZE_MISMATCH' });
    await expectWorkspaceSweep(taskId);
  });

  it('detects digest mismatch against the authorized grant hash', async () => {
    const taskId = randomUUID();
    const bytes = textBytes(1024 * 1024 + 16, 'tampered');
    const stat = jest.fn(async () => ({ sizeBytes: bytes.length, sha256: '0'.repeat(64) }));
    const readStream = jest.fn(async () => chunkStream(bytes, 64 * 1024));
    const ctx = makeCtx({ taskId, facade: { stat, readStream } });

    await expect(
      ParserBudgetHelper.readArtifact(ctx, randomUUID())
    ).rejects.toMatchObject({ code: 'ARTIFACT_INTEGRITY_MISMATCH' });
    await expectWorkspaceSweep(taskId);
  });

  it('rejects a stream whose bytes are corrupted after a valid SHA-256 was pinned', async () => {
    const taskId = randomUUID();
    const artifactId = randomUUID();
    const expectedBytes = textBytes(1024 * 1024 + 17, 'pinned-digest');
    const corruptedBytes = Buffer.from(expectedBytes);
    corruptedBytes.writeUInt8(corruptedBytes.readUInt8(corruptedBytes.length - 1) ^ 0xff, corruptedBytes.length - 1);
    const stat = jest.fn(async () => ({
      sizeBytes: expectedBytes.length,
      sha256: sha256(expectedBytes),
    }));
    const readStream = jest.fn(async () => chunkStream(corruptedBytes, 64 * 1024));
    const ctx = makeCtx({ taskId, facade: { stat, readStream } });

    await expect(ParserBudgetHelper.readArtifact(ctx, artifactId)).rejects.toMatchObject({
      code: 'ARTIFACT_INTEGRITY_MISMATCH',
    });
    await expectWorkspaceSweep(taskId);
  });

  it('surfaces disk-full write errors and removes the partial acquisition workspace', async () => {
    const taskId = randomUUID();
    const bytes = Buffer.from('bytes rejected by the disk writer');
    const stat = jest.fn(async () => ({ sizeBytes: bytes.length, sha256: sha256(bytes) }));
    const readStream = jest.fn(async () => Readable.from([bytes]));
    const ctx = makeCtx({ taskId, facade: { stat, readStream } });
    const fsModule = jest.requireActual<typeof import('node:fs')>('node:fs');
    const diskFullWriter = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('ENOSPC: no space left on device'));
      },
    });
    const writerSpy = jest.spyOn(fsModule, 'createWriteStream').mockReturnValue(
      diskFullWriter as unknown as ReturnType<typeof fsModule.createWriteStream>
    );

    try {
      await expect(ParserBudgetHelper.readArtifact(ctx, randomUUID())).rejects.toThrow('ENOSPC');
      expect(writerSpy).toHaveBeenCalledTimes(1);
      await expectWorkspaceSweep(taskId);
    } finally {
      writerSpy.mockRestore();
    }
  });

  it('returns a zero-byte streamed artifact through the disk-backed path with a large budget', async () => {
    const taskId = randomUUID();
    const artifactId = randomUUID();
    const empty = Buffer.alloc(0);
    const stat = jest.fn(async () => ({
      fileName: 'empty.txt',
      mimeType: 'text/plain',
      sizeBytes: 0,
      sha256: sha256(empty),
    }));
    const readStream = jest.fn(async () => Readable.from([]));
    const ctx = makeCtx({ taskId, facade: { stat, readStream } });

    const artifact = await ParserBudgetHelper.readArtifact(ctx, artifactId);

    expect(artifact.buffer).toEqual(empty);
    expect(readStream).toHaveBeenCalledWith(artifactId, expect.objectContaining({ expectedSizeBytes: 0 }));
    await expectWorkspaceSweep(taskId);
  });

  it('maps lease loss after the first chunk is flushed and cleans the partial file', async () => {
    const taskId = randomUUID();
    const artifactId = randomUUID();
    const controller = new AbortController();
    let source: Readable | undefined;
    let chunkSent = false;
    const stat = jest.fn(async () => ({ sizeBytes: undefined as number | undefined }));
    const readStream = jest.fn(async () => {
      source = new Readable({
        read() {
          if (chunkSent) return;
          chunkSent = true;
          this.push(Buffer.alloc(64 * 1024, 0x61));
        },
      });
      return source;
    });
    const ctx = makeCtx({ taskId, facade: { stat, readStream }, signal: controller.signal });
    const pending = ParserBudgetHelper.readArtifact(ctx, artifactId);

    await waitForPartialFile(taskId, artifactId);
    controller.abort(new Error('lease lost while flushing artifact bytes'));

    await expect(pending).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(source?.destroyed).toBe(true);
    await expectWorkspaceSweep(taskId);
  });

  it('preserves a cleanup failure after attempting to dispose the artifact workspace', async () => {
    const taskId = randomUUID();
    const bytes = Buffer.from('cleanup error characterization');
    const stat = jest.fn(async () => ({ sizeBytes: bytes.length, sha256: sha256(bytes) }));
    const readStream = jest.fn(async () => Readable.from([bytes]));
    const ctx = makeCtx({ taskId, facade: { stat, readStream } });
    const workerSdk = jest.requireActual<typeof import('@du/worker-sdk')>('@du/worker-sdk');
    const createWorkspace = workerSdk.createTempWorkspace;
    const workspaceSpy = jest.spyOn(workerSdk, 'createTempWorkspace').mockImplementation(async (id) => {
      const workspace = await createWorkspace(id);
      return {
        ...workspace,
        async dispose() {
          await workspace.dispose();
          throw new Error('workspace cleanup failed');
        },
      };
    });

    try {
      await expect(ParserBudgetHelper.readArtifact(ctx, randomUUID())).rejects.toThrow('workspace cleanup failed');
      await expectWorkspaceSweep(taskId);
    } finally {
      workspaceSpy.mockRestore();
    }
  });

  it('keeps the quantified inline exception: sub-1MiB artifacts stay on the memory path', async () => {
    const taskId = randomUUID();
    const bytes = Buffer.from('tiny config payload');
    const stat = jest.fn(async () => ({ sizeBytes: bytes.length, mimeType: 'text/plain' }));
    const readStream = jest.fn();
    const readWithMetadata = jest.fn(async (): Promise<ArtifactReadResult> => ({
      buffer: bytes,
      formatMetadata: {
        canonicalFormat: 'txt',
        canonicalMimeType: 'text/plain',
        declaredFileName: 'tiny.txt',
        declaredMimeType: 'text/plain',
      },
    }));
    const ctx = makeCtx({ taskId, facade: { stat, readStream, readWithMetadata } });

    const artifact = await ParserBudgetHelper.readArtifact(ctx, randomUUID());
    expect(artifact.buffer.equals(bytes)).toBe(true);
    expect(readStream).not.toHaveBeenCalled();
    expect(readWithMetadata).toHaveBeenCalled();
  });

  it('aborts a slow inline metadata read when its whole-read timeout expires', async () => {
    const taskId = randomUUID();
    const stat = jest.fn(async () => ({ sizeBytes: 32, mimeType: 'image/png' }));
    let readSignal: AbortSignal | undefined;
    const readWithMetadata = jest.fn((_id: string, options?: { signal?: AbortSignal }) => {
      readSignal = options?.signal;
      return new Promise<ArtifactReadResult>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('inline read aborted')), { once: true });
      });
    });
    const ctx = makeCtx({
      taskId,
      facade: {
        stat,
        readStream: jest.fn(),
        readWithMetadata,
      },
    });

    jest.useFakeTimers();
    try {
      const pending = ParserBudgetHelper.readArtifact(ctx, randomUUID());
      const timeoutAssertion = expect(pending).rejects.toMatchObject({ code: 'DOCUMENT_TIMEOUT' });
      await jest.advanceTimersByTimeAsync(ParserBudgetHelper.DEFAULT_PARSER_TIMEOUT_MS);
      await timeoutAssertion;
      expect(readWithMetadata).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(readSignal?.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('maps a mid-stream lease abort to LEASE_LOST and a cancel reason to OPERATION_CANCELLED', async () => {
    for (const [reason, code] of [
      [undefined, 'LEASE_LOST'],
      ['cancel', 'OPERATION_CANCELLED'],
    ] as const) {
      const taskId = randomUUID();
      const controller = new AbortController();
      const stat = jest.fn(async () => ({ sizeBytes: undefined as number | undefined }));
      const readStream = jest.fn(async () =>
        Readable.from((async function* () {
          yield Buffer.from('first chunk');
          controller.abort(reason);
          yield Buffer.from('never');
        })())
      );
      const ctx = makeCtx({
        taskId,
        facade: { stat, readStream },
        signal: controller.signal,
        cancelRequested: reason === 'cancel',
      });

      await expect(
        ParserBudgetHelper.readArtifact(ctx, randomUUID())
      ).rejects.toMatchObject({ code });
      await expectWorkspaceSweep(taskId);
    }
  });

  it('destroys the active transfer and removes its workspace when the task aborts mid-stream', async () => {
    const taskId = randomUUID();
    const controller = new AbortController();
    let transferSignal: AbortSignal | undefined;
    let source: Readable | undefined;
    const stat = jest.fn(async () => ({ sizeBytes: undefined as number | undefined }));
    const readStream = jest.fn(async (_artifactId: string, options?: { signal?: AbortSignal }) => {
      transferSignal = options?.signal;
      source = Readable.from((async function* () {
        yield Buffer.from('partial transfer bytes');
        controller.abort(new Error('task lease was lost'));
        yield Buffer.from('bytes after abort');
      })());
      return source;
    });
    const ctx = makeCtx({
      taskId,
      facade: { stat, readStream },
      signal: controller.signal,
    });

    await expect(ParserBudgetHelper.readArtifact(ctx, randomUUID())).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(transferSignal?.aborted).toBe(true);
    expect(source?.destroyed).toBe(true);
    await expectWorkspaceSweep(taskId);
  });

  it('cleans its temporary workspace when the source stream closes before completion', async () => {
    const taskId = randomUUID();
    let source: Readable | undefined;
    let chunkSent = false;
    const stat = jest.fn(async () => ({
      fileName: 'unexpected-close.txt',
      mimeType: 'text/plain',
      sizeBytes: 100,
    }));
    const readStream = jest.fn(async () => {
      source = new Readable({
        read() {
          if (chunkSent) return;
          chunkSent = true;
          this.push(Buffer.from('partial data before abrupt close'));
          const activeSource = this;
          setTimeout(() => activeSource.destroy(), 10);
        },
      });
      return source;
    });
    const ctx = makeCtx({ taskId, facade: { stat, readStream } });

    await expect(ParserBudgetHelper.readArtifact(ctx, randomUUID())).rejects.toMatchObject({
      code: 'ERR_STREAM_PREMATURE_CLOSE',
    });
    expect(source?.destroyed).toBe(true);
    await expectWorkspaceSweep(taskId);
  });

  it('buffer-only facades keep the legacy path byte-identically', async () => {
    const taskId = randomUUID();
    const bytes = Buffer.from('legacy buffer read still works');
    const read = jest.fn(async () => bytes);
    const ctx = makeCtx({ taskId, facade: { read } });

    const artifact = await ParserBudgetHelper.readArtifact(ctx, randomUUID());
    expect(artifact.buffer.equals(bytes)).toBe(true);
    expect(artifact.formatMetadata.canonicalMimeType).toBe('text/plain');
  });
});
