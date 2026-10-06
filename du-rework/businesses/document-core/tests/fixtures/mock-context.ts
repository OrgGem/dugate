import { createHash, randomUUID } from 'node:crypto';
import { DocumentFormatDetector } from '@du/document-kit';
import {
  TaskContext,
  ArtifactFormatMetadata,
  ArtifactReadResult,
  ArtifactRef,
  ConnectorInvocationOptions,
  ConnectorInvocationResult,
  StepCheckpointRecord,
} from '../../src/types/context';

export interface MockTaskContextInit {
  taskId?: string;
  operationId?: string;
  tenantId?: string;
  deadlineAt?: string | null;
  signal?: AbortSignal;
  cancelRequested?: boolean;
  action?: string;
  kind?: string;
  input?: Record<string, unknown>;
}

export class MockTaskContext implements TaskContext {
  public taskId: string;
  public operationId: string;
  public businessId: string = 'document-core';
  public businessVersion: string = '1.0.0';
  public tenantId: string = 'tenant-test-default';

  // SdkTaskContext-compatible fields
  public action: string = 'ingest';
  public kind: string = 'root';
  public taskKey: string = 'task-1';
  public attempt: number = 1;
  public leaseEpoch: number = 1;
  public deadlineAt: string | null = null;
  public signal: AbortSignal;
  public cancelRequested: boolean = false;
  public input: Record<string, unknown> = {};
  public connectorBindings: Record<string, string> = {};

  public artifactsStore: Map<string, Buffer> = new Map();
  public deniedArtifactReadIds = new Set<string>();
  public artifactFormatMetadataStore: Map<string, ArtifactFormatMetadata> = new Map();
  public artifactReadIdentityStore = new Map<string, {
    storageVersionId: string;
    grantExpiresAt: string;
    sizeBytes: number;
    sha256: string;
  }>();
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

  constructor(initOrTaskId?: string | MockTaskContextInit, operationId?: string) {
    if (typeof initOrTaskId === 'object' && initOrTaskId !== null) {
      this.taskId = initOrTaskId.taskId ?? randomUUID();
      this.operationId = initOrTaskId.operationId ?? randomUUID();
      this.tenantId = initOrTaskId.tenantId ?? 'tenant-test-default';
      this.deadlineAt = initOrTaskId.deadlineAt ?? null;
      this.signal = initOrTaskId.signal ?? new AbortController().signal;
      this.cancelRequested = initOrTaskId.cancelRequested ?? false;
      this.action = initOrTaskId.action ?? 'ingest';
      this.kind = initOrTaskId.kind ?? 'root';
      this.input = initOrTaskId.input ?? {};
    } else {
      this.taskId = typeof initOrTaskId === 'string' ? initOrTaskId : randomUUID();
      this.operationId = operationId ?? randomUUID();
      this.signal = new AbortController().signal;
    }
  }

  public artifacts = {
    read: async (artifactId: string): Promise<Buffer> => {
      if (this.deniedArtifactReadIds.has(artifactId)) {
        throw new Error('artifact read grant denied');
      }
      const buf = this.artifactsStore.get(artifactId);
      if (!buf) {
        throw new Error(`Artifact "${artifactId}" not found`);
      }
      return buf;
    },
    readWithMetadata: async (artifactId: string): Promise<ArtifactReadResult> => {
      const buffer = await this.artifacts.read(artifactId);
      const storedMetadata = this.artifactFormatMetadataStore.get(artifactId);
      const identity = this.artifactReadIdentityStore.get(artifactId);
      if (storedMetadata) {
        return { buffer, formatMetadata: { ...storedMetadata }, ...(identity ? { identity: { ...identity } } : {}) };
      }

      const detection = DocumentFormatDetector.detect(buffer);
      return {
        buffer,
        formatMetadata: {
          canonicalFormat: detection.format,
          canonicalMimeType: detection.mimeType,
        },
        ...(identity ? { identity: { ...identity } } : {}),
      };
    },
    write: async (content: Buffer | string, fileName: string, mimeType: string): Promise<ArtifactRef> => {
      const id = randomUUID();
      const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
      this.artifactsStore.set(id, buf);
      const detection = DocumentFormatDetector.detect(buf, fileName, mimeType);
      this.artifactFormatMetadataStore.set(id, {
        canonicalFormat: detection.format,
        canonicalMimeType: detection.mimeType,
        declaredFileName: fileName,
        declaredMimeType: mimeType,
      });
      const digest = createHash('sha256').update(buf).digest('hex');
      this.artifactReadIdentityStore.set(id, {
        storageVersionId: digest,
        grantExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        sizeBytes: buf.length,
        sha256: digest,
      });
      return {
        artifactId: id,
        role: 'output',
        fileName,
        mimeType,
        sizeBytes: buf.length,
      };
    },
    accessGrant: async (_artifactId: string, _mode: 'read' | 'write') => ({
      downloadUrl: 'http://storage/download',
      uploadUrl: 'http://storage/upload',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    }),
  };

  public storeArtifact(
    artifactId: string,
    buffer: Buffer,
    declaredFileName?: string,
    declaredMimeType?: string
  ): ArtifactReadResult {
    this.artifactsStore.set(artifactId, buffer);
    const detection = DocumentFormatDetector.detect(buffer, declaredFileName, declaredMimeType);
    const formatMetadata: ArtifactFormatMetadata = {
      canonicalFormat: detection.format,
      canonicalMimeType: detection.mimeType,
      declaredFileName,
      declaredMimeType,
    };
    this.artifactFormatMetadataStore.set(artifactId, formatMetadata);
    const digest = createHash('sha256').update(buffer).digest('hex');
    const identity = {
      storageVersionId: digest,
      grantExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      sizeBytes: buffer.length,
      sha256: digest,
    };
    this.artifactReadIdentityStore.set(artifactId, identity);
    return { buffer, formatMetadata: { ...formatMetadata }, identity: { ...identity } };
  }

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

  public async step<T>(
    stepKey: string,
    inputHash: string,
    fn: () => Promise<T>,
    options?: { sessionRef?: string | null }
  ): Promise<T> {
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
      ...(options?.sessionRef !== undefined ? { sessionRef: options.sessionRef } : {}),
    });

    return output;
  }

  public async getCheckpoint(stepKey: string): Promise<StepCheckpointRecord | null> {
    return this.checkpointsStore.get(stepKey) || null;
  }
}
