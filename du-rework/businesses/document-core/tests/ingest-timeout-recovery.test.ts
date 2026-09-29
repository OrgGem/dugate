import { createHash, randomUUID } from 'node:crypto';
import { readdir, stat as statFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { TEMP_WORKSPACE_PREFIX } from '@du/worker-sdk';
import { ParserBudgetHelper } from '../src/pipelines/parser-budget';
import type { TaskContext } from '../src/types/context';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeContext(init: {
  taskId: string;
  stat: jest.Mock;
  readStream: jest.Mock;
  deadlineAt: string;
  signal?: AbortSignal;
}): TaskContext {
  return {
    taskId: init.taskId,
    operationId: randomUUID(),
    businessId: 'document-core',
    businessVersion: '1.0.0',
    tenantId: 'tenant-test',
    deadlineAt: init.deadlineAt,
    signal: init.signal,
    artifacts: {
      read: async () => {
        throw new Error('buffer-only read must not be reached');
      },
      write: async () => {
        throw new Error('write must not be reached');
      },
      stat: init.stat,
      readStream: init.readStream,
    },
  } as unknown as TaskContext;
}

async function waitForPartialFile(taskId: string, artifactId: string): Promise<number> {
  const safeTaskId = taskId.replace(/[^A-Za-z0-9-]/g, '-');
  const targetName = `${artifactId}.artifact`;
  const deadline = Date.now() + 500;

  while (Date.now() < deadline) {
    const entries = await readdir(tmpdir());
    const workspace = entries.find((name) => name.startsWith(`${TEMP_WORKSPACE_PREFIX}${safeTaskId}-`));
    if (workspace) {
      try {
        const info = await statFile(join(tmpdir(), workspace, targetName));
        if (info.size > 0) return info.size;
      } catch {
        // The workspace/file may not have been created yet; keep waiting.
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }

  throw new Error('Timed out waiting for the partial artifact file to reach disk');
}

async function waitForArtifactFile(taskId: string, artifactId: string): Promise<number> {
  const safeTaskId = taskId.replace(/[^A-Za-z0-9-]/g, '-');
  const targetName = `${artifactId}.artifact`;
  const deadline = Date.now() + 500;

  while (Date.now() < deadline) {
    const entries = await readdir(tmpdir());
    const workspace = entries.find((name) => name.startsWith(`${TEMP_WORKSPACE_PREFIX}${safeTaskId}-`));
    if (workspace) {
      try {
        return (await statFile(join(tmpdir(), workspace, targetName))).size;
      } catch {
        // The target may not exist until the write stream opens it.
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }

  throw new Error('Timed out waiting for the artifact file to be created');
}

async function expectWorkspaceSweep(taskId: string): Promise<void> {
  const safeTaskId = taskId.replace(/[^A-Za-z0-9-]/g, '-');
  const entries = await readdir(tmpdir());
  expect(entries.filter((name) => name.startsWith(`${TEMP_WORKSPACE_PREFIX}${safeTaskId}-`))).toEqual([]);
}

describe('ingest stream timeout recovery and cleanup', () => {
  it.each([0, -1])('rejects a parser timeout boundary of %d milliseconds', async (timeoutMs) => {
    const context = makeContext({
      taskId: randomUUID(),
      stat: jest.fn(),
      readStream: jest.fn(),
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    });

    await expect(
      ParserBudgetHelper.safeParseBuffer(context, Buffer.from('scan'), 'scan.txt', { timeoutMs })
    ).rejects.toMatchObject({ code: 'INVALID_PARSER_BUDGET' });
  });

  it('fails before parsing when the task lease signal was already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('lease expired before parser start'));
    const parserTaskId = randomUUID();
    const context = makeContext({
      taskId: parserTaskId,
      stat: jest.fn(),
      readStream: jest.fn(),
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
      signal: controller.signal,
    });

    await expect(
      ParserBudgetHelper.safeParseBuffer(context, Buffer.from('scan'), 'scan.txt')
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });

  it('removes partial files, recovers for the next transfer, and handles late stream rejection', async () => {
    const taskId = randomUUID();
    const artifactId = randomUUID();
    const partialBytes = Buffer.from('partially downloaded scan');
    const recoveredBytes = Buffer.from('recovered document bytes');
    const firstDescriptor = {
      fileName: 'timeout.txt',
      mimeType: 'text/plain',
      sizeBytes: partialBytes.length + 32,
      sha256: sha256(Buffer.concat([partialBytes, Buffer.alloc(32, 1)])),
      storageVersionId: 'version-timeout',
    };
    const recoveredDescriptor = {
      fileName: 'recovered.txt',
      mimeType: 'text/plain',
      sizeBytes: recoveredBytes.length,
      sha256: sha256(recoveredBytes),
      storageVersionId: 'version-recovered',
    };
    let statCalls = 0;
    let transferCalls = 0;
    let abortedStream: Readable | undefined;
    const stat = jest.fn(async () => {
      statCalls += 1;
      return statCalls === 1 ? firstDescriptor : recoveredDescriptor;
    });
    const readStream = jest.fn(async (_id: string, options?: { signal?: AbortSignal }) => {
      transferCalls += 1;
      if (transferCalls > 1) return Readable.from([recoveredBytes]);

      const source = Readable.from((async function* () {
        yield partialBytes;
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            // Simulate storage finishing with a rejection after the caller timed out.
            setTimeout(() => reject(new Error('late storage abort rejection')), 10);
          }, { once: true });
        });
      })());
      abortedStream = source;
      return source;
    });
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const timedOutContext = makeContext({
        taskId,
        stat,
        readStream,
        deadlineAt: new Date(Date.now() + 1_200).toISOString(),
      });
      const pendingTimeout = ParserBudgetHelper.readArtifact(timedOutContext, artifactId);
      const timeoutAssertion = expect(pendingTimeout).rejects.toMatchObject({ code: 'DOCUMENT_TIMEOUT' });

      const bytesOnDiskBeforeAbort = await waitForPartialFile(taskId, artifactId);
      expect(bytesOnDiskBeforeAbort).toBeGreaterThan(0);
      await timeoutAssertion;

      expect(abortedStream?.destroyed).toBe(true);
      await expectWorkspaceSweep(taskId);

      const recoveryContext = makeContext({
        taskId,
        stat,
        readStream,
        deadlineAt: new Date(Date.now() + 5_000).toISOString(),
      });
      const recovered = await ParserBudgetHelper.readArtifact(recoveryContext, artifactId);
      expect(recovered.buffer).toEqual(recoveredBytes);
      expect(readStream).toHaveBeenCalledTimes(2);
      await expectWorkspaceSweep(taskId);

      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('does not reuse a timed-out partial file when recovery uses a different task lease ID', async () => {
    const originalTaskId = randomUUID();
    const recoveryTaskId = randomUUID();
    const artifactId = randomUUID();
    const partialBytes = Buffer.from('bytes from the expired lease');
    const recoveredBytes = Buffer.from('bytes fetched under the recovery lease');
    const timedOutDescriptor = {
      fileName: 'expired.txt',
      mimeType: 'text/plain',
      sizeBytes: partialBytes.length + 16,
      sha256: sha256(Buffer.concat([partialBytes, Buffer.alloc(16, 2)])),
      storageVersionId: 'version-expired-lease',
    };
    const recoveredDescriptor = {
      fileName: 'recovered.txt',
      mimeType: 'text/plain',
      sizeBytes: recoveredBytes.length,
      sha256: sha256(recoveredBytes),
      storageVersionId: 'version-recovery-lease',
    };
    let statCalls = 0;
    let transferCalls = 0;
    const stat = jest.fn(async () => {
      statCalls += 1;
      return statCalls === 1 ? timedOutDescriptor : recoveredDescriptor;
    });
    const readStream = jest.fn(async (_id: string, options?: { signal?: AbortSignal }) => {
      transferCalls += 1;
      if (transferCalls > 1) return Readable.from([recoveredBytes]);

      return Readable.from((async function* () {
        yield partialBytes;
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            setTimeout(() => reject(new Error('expired lease stream stopped')), 0);
          }, { once: true });
        });
      })());
    });

    const expiredLeaseRead = ParserBudgetHelper.readArtifact(
      makeContext({
        taskId: originalTaskId,
        stat,
        readStream,
        deadlineAt: new Date(Date.now() + 250).toISOString(),
      }),
      artifactId
    );
    const timeoutAssertion = expect(expiredLeaseRead).rejects.toMatchObject({ code: 'DOCUMENT_TIMEOUT' });

    const bytesOnDiskBeforeAbort = await waitForPartialFile(originalTaskId, artifactId);
    expect(bytesOnDiskBeforeAbort).toBeGreaterThan(0);
    await timeoutAssertion;
    await expectWorkspaceSweep(originalTaskId);

    const recovered = await ParserBudgetHelper.readArtifact(
      makeContext({
        taskId: recoveryTaskId,
        stat,
        readStream,
        deadlineAt: new Date(Date.now() + 5_000).toISOString(),
      }),
      artifactId
    );

    expect(recovered.buffer).toEqual(recoveredBytes);
    expect(recovered.buffer).not.toEqual(partialBytes);
    expect(readStream).toHaveBeenCalledTimes(2);
    await expectWorkspaceSweep(originalTaskId);
    await expectWorkspaceSweep(recoveryTaskId);
  });

  it('disposes partial acquisition when the storage stream drops unexpectedly', async () => {
    const taskId = randomUUID();
    const artifactId = randomUUID();
    const partialBytes = Buffer.from('bytes before network drop');
    const stat = jest.fn(async () => ({
      fileName: 'dropped.txt',
      mimeType: 'text/plain',
      sizeBytes: partialBytes.length + 20,
      sha256: sha256(Buffer.concat([partialBytes, Buffer.alloc(20, 3)])),
      storageVersionId: 'version-network-drop',
    }));
    let droppedStream: Readable | undefined;
    const readStream = jest.fn(async () => {
      const source = Readable.from((async function* () {
        yield partialBytes;
        throw new Error('network connection dropped mid-stream');
      })());
      droppedStream = source;
      return source;
    });
    const context = makeContext({
      taskId,
      stat,
      readStream,
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    });

    await expect(ParserBudgetHelper.readArtifact(context, artifactId)).rejects.toThrow('network connection dropped mid-stream');

    expect(droppedStream?.destroyed).toBe(true);
    await expectWorkspaceSweep(taskId);
  });

  it('refuses a recovery attempt carrying a malformed or mismatched lease token', async () => {
    const controller = new AbortController();
    controller.abort({ leaseToken: 'corrupted-token-from-another-attempt' });
    const taskId = randomUUID();
    const artifactId = randomUUID();
    const stat = jest.fn(async () => ({
      fileName: 'recovery.txt',
      mimeType: 'text/plain',
      sizeBytes: 4,
      sha256: sha256(Buffer.from('data')),
      storageVersionId: 'version-recovery-token',
    }));
    const readStream = jest.fn(async () => Readable.from([Buffer.from('data')]));
    const context = makeContext({
      taskId,
      stat,
      readStream,
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
      signal: controller.signal,
    });

    await expect(ParserBudgetHelper.readArtifact(context, artifactId)).rejects.toMatchObject({ code: 'LEASE_LOST' });

    expect(readStream).not.toHaveBeenCalled();
    await expectWorkspaceSweep(taskId);
  });

  it('removes a zero-byte partial file when the stream stalls through timeout', async () => {
    const taskId = randomUUID();
    const artifactId = randomUUID();
    const stat = jest.fn(async () => ({
      fileName: 'empty-partial.txt',
      mimeType: 'text/plain',
      sizeBytes: 8,
      sha256: sha256(Buffer.from('expected')),
      storageVersionId: 'version-zero-partial',
    }));
    let stalledStream: Readable | undefined;
    const readStream = jest.fn(async () => {
      const source = new Readable({ read() {} });
      stalledStream = source;
      return source;
    });
    const context = makeContext({
      taskId,
      stat,
      readStream,
      deadlineAt: new Date(Date.now() + 800).toISOString(),
    });
    const pending = ParserBudgetHelper.readArtifact(context, artifactId);
    const timeoutAssertion = expect(pending).rejects.toMatchObject({ code: 'DOCUMENT_TIMEOUT' });

    expect(await waitForArtifactFile(taskId, artifactId)).toBe(0);
    await timeoutAssertion;

    expect(stalledStream?.destroyed).toBe(true);
    await expectWorkspaceSweep(taskId);
  });

  it('reclaims workspace idempotently across successive transfer timeouts', async () => {
    const taskId = randomUUID();
    const artifactIds = [randomUUID(), randomUUID()];
    const partialBytes = Buffer.from('partial before repeated timeout');
    const descriptor = {
      fileName: 'repeated-timeout.txt',
      mimeType: 'text/plain',
      sizeBytes: partialBytes.length + 12,
      sha256: sha256(Buffer.concat([partialBytes, Buffer.alloc(12, 4)])),
      storageVersionId: 'version-repeated-timeout',
    };
    const stat = jest.fn(async () => descriptor);
    const streams: Readable[] = [];
    const readStream = jest.fn(async (_id: string, options?: { signal?: AbortSignal }) => {
      const source = Readable.from((async function* () {
        yield partialBytes;
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            setTimeout(() => reject(new Error('repeated timeout stream stopped')), 5);
          }, { once: true });
        });
      })());
      streams.push(source);
      return source;
    });

    for (const artifactId of artifactIds) {
      const context = makeContext({
        taskId,
        stat,
        readStream,
        deadlineAt: new Date(Date.now() + 400).toISOString(),
      });
      const pending = ParserBudgetHelper.readArtifact(context, artifactId);
      const timeoutAssertion = expect(pending).rejects.toMatchObject({ code: 'DOCUMENT_TIMEOUT' });

      expect(await waitForPartialFile(taskId, artifactId)).toBeGreaterThan(0);
      await timeoutAssertion;

      expect(streams[streams.length - 1]?.destroyed).toBe(true);
      await expectWorkspaceSweep(taskId);
    }

    expect(readStream).toHaveBeenCalledTimes(2);
    await expectWorkspaceSweep(taskId);
  });
});
