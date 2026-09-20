import { ArtifactRef } from '@du/contracts';

export type { ArtifactRef };

export interface ConnectorInvocationOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  responseFormat?: 'json' | 'text';
  jsonSchema?: Record<string, unknown>;
}

export interface ConnectorInvocationResult {
  invocationId: string;
  status: 'SUCCESS' | 'ERROR';
  data?: unknown;
  rawText?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  error?: { code: string; message: string; retryable: boolean };
}

export interface StepCheckpointRecord {
  stepKey: string;
  inputHash: string;
  output: unknown;
  savedAt: string;
}

export interface TaskContext {
  readonly taskId: string;
  readonly operationId: string;
  readonly businessId: string;
  readonly businessVersion: string;
  readonly tenantId: string;
  readonly signal?: AbortSignal;

  // Artifact operations
  artifacts: {
    read(artifactId: string): Promise<Buffer>;
    write(content: Buffer | string, fileName: string, mimeType: string): Promise<ArtifactRef>;
  };

  // Connector facade
  connector: {
    invoke(
      slot: 'ocr' | 'reasoning' | 'vision',
      promptOrPayload: string | Record<string, unknown>,
      options?: ConnectorInvocationOptions
    ): Promise<ConnectorInvocationResult>;
  };

  // Durable step checkpoints (Guarantee: full output >500 chars, no truncation)
  step<T>(
    stepKey: string,
    inputHash: string,
    fn: () => Promise<T>
  ): Promise<T>;

  // Checkpoints inquiry
  getCheckpoint(stepKey: string): Promise<StepCheckpointRecord | null>;
}
