import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type {
  ArtifactRef,
  JoinPolicy,
  InvocationResponse,
  CheckpointRef,
} from '@du/contracts';
import type {
  TaskContext,
  TaskDisposition,
  ChildTaskSpecInput,
} from '@du/worker-sdk';

export interface WrittenArtifact {
  content: Buffer | string;
  fileName: string;
  mimeType: string;
  role?: string;
  artifactId: string;
}

export interface StoredCheckpoint {
  stepKey: string;
  inputHash: string;
  output: unknown;
  status: 'SUCCEEDED' | 'FAILED';
}

export interface MockTaskContextOptions {
  taskId?: string;
  operationId?: string;
  input?: Record<string, unknown>;
  kind?: string;
  taskKey?: string;
  waitResponse?: unknown;
  connectorBindings?: Record<string, string>;
  signal?: AbortSignal;
  cancelRequested?: boolean;
  artifactsMap?: Record<string, Buffer | string>;
  checkpointsStore?: Map<string, StoredCheckpoint>;
  onSpawn?: (children: ChildTaskSpecInput[], joinPolicy?: JoinPolicy, continuationRef?: string) => Promise<TaskDisposition>;
  onWaitInput?: (waitKey: string, inputSchema: unknown, opts?: unknown) => Promise<TaskDisposition>;
  onConnectorInvoke?: (slot: string, input: unknown, options?: unknown) => Promise<InvocationResponse>;
}

export function createMockTaskContext(opts: MockTaskContextOptions = {}): {
  ctx: TaskContext;
  writtenArtifacts: WrittenArtifact[];
  readArtifactCalls: string[];
  spawnCalls: Array<{ children: ChildTaskSpecInput[]; joinPolicy?: JoinPolicy; continuationRef?: string }>;
  waitCalls: Array<{ waitKey: string; inputSchema: unknown; opts?: unknown }>;
  connectorCalls: Array<{ slot: string; input: unknown; options?: unknown }>;
  stepCalls: Array<{ stepKey: string; inputHash: string; replayed: boolean }>;
  artifactsMap: Record<string, Buffer | string>;
  checkpointsStore: Map<string, StoredCheckpoint>;
  abortController: AbortController;
} {
  const taskId = opts.taskId ?? randomUUID();
  const operationId = opts.operationId ?? randomUUID();
  const writtenArtifacts: WrittenArtifact[] = [];
  const readArtifactCalls: string[] = [];
  const spawnCalls: Array<{ children: ChildTaskSpecInput[]; joinPolicy?: JoinPolicy; continuationRef?: string }> = [];
  const waitCalls: Array<{ waitKey: string; inputSchema: unknown; opts?: unknown }> = [];
  const connectorCalls: Array<{ slot: string; input: unknown; options?: unknown }> = [];
  const stepCalls: Array<{ stepKey: string; inputHash: string; replayed: boolean }> = [];
  const abortController = new AbortController();

  const artifactsMap: Record<string, Buffer | string> = {
    'art-1': Buffer.from('Valid document content for review analysis.'),
    'art-empty': Buffer.alloc(0),
    ...(opts.artifactsMap ?? {}),
  };

  const checkpointsStore: Map<string, StoredCheckpoint> =
    opts.checkpointsStore ?? new Map<string, StoredCheckpoint>();

  const ctx: TaskContext = {
    taskId,
    operationId,
    tenantId: 'tenant-example',
    businessId: 'example-review',
    businessVersion: '1.0.0',
    action: 'review',
    kind: opts.kind ?? 'review',
    taskKey: opts.taskKey ?? 'root',
    attempt: 1,
    leaseEpoch: 1,
    deadlineAt: null,
    signal: opts.signal ?? abortController.signal,
    cancelRequested: opts.cancelRequested ?? false,
    input: opts.input ?? {
      reviewId: 'rev-default',
      artifacts: [{ artifactId: 'art-1', fileName: 'doc1.txt' }],
    },
    waitResponse: opts.waitResponse,
    connectorBindings: opts.connectorBindings ?? {},
    step: {
      run: async <T>(stepKey: string, inputHash: string, fn: () => Promise<T>): Promise<T> => {
        const existing = checkpointsStore.get(stepKey);
        if (existing) {
          if (existing.status === 'SUCCEEDED') {
            if (existing.inputHash !== inputHash) {
              throw new Error(`InputHashMismatchError for step ${stepKey}`);
            }
            stepCalls.push({ stepKey, inputHash, replayed: true });
            return existing.output as T;
          }
        }

        stepCalls.push({ stepKey, inputHash, replayed: false });
        const output = await fn();
        checkpointsStore.set(stepKey, {
          stepKey,
          inputHash,
          output,
          status: 'SUCCEEDED',
        });
        return output;
      },
      peek: async (stepKey: string): Promise<CheckpointRef | null> => {
        const found = checkpointsStore.get(stepKey);
        if (!found) return null;
        return {
          stepKey,
          generation: 1,
          inputHash: found.inputHash,
          status: found.status,
          outputRef: `checkpoint://${stepKey}`,
        };
      },
    },
    spawn: {
      spawnAndWait: async (children, joinPolicy, continuationRef): Promise<TaskDisposition> => {
        spawnCalls.push({ children, joinPolicy, continuationRef });
        if (opts.onSpawn) {
          return opts.onSpawn(children, joinPolicy, continuationRef);
        }
        return { kind: 'waiting-children' };
      },
    },
    wait: {
      waitForInput: async (waitKey, inputSchema, options): Promise<TaskDisposition> => {
        waitCalls.push({ waitKey, inputSchema, opts: options });
        if (opts.onWaitInput) {
          return opts.onWaitInput(waitKey, inputSchema, options);
        }
        return { kind: 'waiting-input', waitId: `wait-${randomUUID()}` };
      },
    },
    progress: {
      report: async () => undefined,
    },
    artifacts: {
      read: async (id: string): Promise<Buffer> => {
        readArtifactCalls.push(id);
        const cleanId = id.startsWith('artifact://') ? id.slice('artifact://'.length) : id;
        const found = artifactsMap[cleanId];
        if (found !== undefined) {
          return typeof found === 'string' ? Buffer.from(found, 'utf8') : found;
        }
        return Buffer.from(`Default content for artifact ${cleanId}`);
      },
      readWithMetadata: async (id) => {
        const cleanId = id.startsWith('artifact://') ? id.slice('artifact://'.length) : id;
        const found = artifactsMap[cleanId];
        const buffer =
          found === undefined
            ? Buffer.from(`Default content for artifact ${cleanId}`)
            : typeof found === 'string'
              ? Buffer.from(found, 'utf8')
              : found;
        return {
          buffer,
          sizeBytes: buffer.length,
          sha256: createHash('sha256').update(buffer).digest('hex'),
        };
      },
      readStream: async (id) => {
        readArtifactCalls.push(id);
        const cleanId = id.startsWith('artifact://') ? id.slice('artifact://'.length) : id;
        const found = artifactsMap[cleanId];
        const buffer =
          found === undefined
            ? Buffer.from(`Default content for artifact ${cleanId}`)
            : typeof found === 'string'
              ? Buffer.from(found, 'utf8')
              : found;
        return Readable.from(buffer);
      },
      writeStream: async (content, fileName, mimeType, sizeBytes, purpose) => {
        const chunks: Buffer[] = [];
        for await (const chunk of content as AsyncIterable<Uint8Array>) {
          chunks.push(Buffer.from(chunk));
        }
        const buffer = Buffer.concat(chunks);
        if (buffer.length !== sizeBytes) {
          throw new Error(`writeStream size mismatch: declared ${sizeBytes} bytes, received ${buffer.length}`);
        }
        const artifactId = randomUUID();
        writtenArtifacts.push({ content: buffer, fileName, mimeType, role: purpose ?? 'output', artifactId });
        artifactsMap[artifactId] = buffer;
        return {
          artifactId,
          role: purpose ?? 'output',
          fileName,
          mimeType,
          sizeBytes: buffer.length,
        };
      },
      write: async (content, fileName, mimeType, purpose): Promise<ArtifactRef> => {
        const artifactId = randomUUID();
        writtenArtifacts.push({
          content,
          fileName,
          mimeType,
          role: purpose ?? 'output',
          artifactId,
        });
        artifactsMap[artifactId] = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
        return {
          artifactId,
          role: purpose ?? 'output',
          fileName,
          mimeType,
          sizeBytes: typeof content === 'string' ? Buffer.byteLength(content) : content.length,
        };
      },
      accessGrant: async () => ({ expiresAt: '2099-01-01T00:00:00.000Z' }),
    },
    connector: {
      invoke: async (slot, input, options): Promise<InvocationResponse> => {
        connectorCalls.push({ slot, input, options });
        if (opts.onConnectorInvoke) {
          return opts.onConnectorInvoke(slot, input, options);
        }
        return {
          invocationId: `inv-${randomUUID()}`,
          state: 'SUCCEEDED',
          result: {
            content: 'Compliance review completed: all standard rules passed.',
            data: { status: 'COMPLIANT' },
          },
          usage: {
            inputTokens: 50,
            outputTokens: 25,
            costMicrousd: 75,
            measurement: 'measured',
          },
        };
      },
    },
    checkpoints: () => {
      return Array.from(checkpointsStore.values()).map((c) => ({
        stepKey: c.stepKey,
        generation: 1,
        inputHash: c.inputHash,
        status: c.status,
        outputRef: `checkpoint://${c.stepKey}`,
      }));
    },
    grantFor: async () => ({
      grant: 'mock-grant-token',
      invocationId: 'inv-grant-1',
      connectorId: 'mock-connector',
      connectorRevision: 1,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      allowedOptions: {},
    }),
  };

  return {
    ctx,
    writtenArtifacts,
    readArtifactCalls,
    spawnCalls,
    waitCalls,
    connectorCalls,
    stepCalls,
    artifactsMap,
    checkpointsStore,
    abortController,
  };
}
