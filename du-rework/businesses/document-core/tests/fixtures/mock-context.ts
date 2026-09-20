import { randomUUID } from 'node:crypto';
import {
  TaskContext,
  ArtifactRef,
  ConnectorInvocationOptions,
  ConnectorInvocationResult,
  StepCheckpointRecord,
} from '../../src/types/context';

export class MockTaskContext implements TaskContext {
  public readonly taskId: string;
  public readonly operationId: string;
  public readonly businessId: string = 'document-core';
  public readonly businessVersion: string = '1.0.0';
  public readonly tenantId: string = 'tenant-test-default';

  // SdkTaskContext-compatible fields
  public readonly action: string = 'ingest';
  public readonly kind: string = 'root';
  public readonly taskKey: string = 'task-1';
  public readonly attempt: number = 1;
  public readonly leaseEpoch: number = 1;
  public readonly deadlineAt: string | null = null;
  public readonly signal: AbortSignal = new AbortController().signal;
  public readonly cancelRequested: boolean = false;
  public readonly input: Record<string, unknown> = {};
  public readonly connectorBindings: Readonly<Record<string, string>> = {};

  public artifactsStore: Map<string, Buffer> = new Map();
  public checkpointsStore: Map<string, StepCheckpointRecord> = new Map();
  public connectorInvocations: Array<{
    slot: string;
    payload: unknown;
    options?: ConnectorInvocationOptions;
  }> = [];

  public mockConnectorResponses: Map<string, ConnectorInvocationResult> = new Map();
  public defaultConnectorResponse: ConnectorInvocationResult = {
    invocationId: 'inv-mock-default',
    status: 'SUCCESS',
    data: { result: 'default mock data' },
  };

  constructor(taskId: string = randomUUID(), operationId: string = randomUUID()) {
    this.taskId = taskId;
    this.operationId = operationId;
  }

  public artifacts = {
    read: async (artifactId: string): Promise<Buffer> => {
      const buf = this.artifactsStore.get(artifactId);
      if (!buf) {
        throw new Error(`Artifact "${artifactId}" not found`);
      }
      return buf;
    },
    write: async (content: Buffer | string, fileName: string, mimeType: string): Promise<ArtifactRef> => {
      const id = randomUUID();
      const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
      this.artifactsStore.set(id, buf);
      return {
        artifactId: id,
        role: 'output',
        fileName,
        mimeType,
        sizeBytes: buf.length,
      };
    },
  };

  public connector = {
    invoke: async (
      slot: 'ocr' | 'reasoning' | 'vision',
      promptOrPayload: string | Record<string, unknown>,
      options?: ConnectorInvocationOptions
    ): Promise<ConnectorInvocationResult> => {
      this.connectorInvocations.push({ slot, payload: promptOrPayload, options });
      const custom = this.mockConnectorResponses.get(slot);
      if (custom) return custom;
      return this.defaultConnectorResponse;
    },
  };

  public async step<T>(stepKey: string, inputHash: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.checkpointsStore.get(stepKey);
    if (existing && existing.inputHash === inputHash) {
      return existing.output as T;
    }

    const output = await fn();
    this.checkpointsStore.set(stepKey, {
      stepKey,
      inputHash,
      output,
      savedAt: new Date().toISOString(),
    });

    return output;
  }

  public async getCheckpoint(stepKey: string): Promise<StepCheckpointRecord | null> {
    return this.checkpointsStore.get(stepKey) || null;
  }
}
