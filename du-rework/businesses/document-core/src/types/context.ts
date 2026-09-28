import { ArtifactRef } from '@du/contracts';
import type { SupportedFormat } from '@du/document-kit';
import type { TaskArtifactCrypto } from '@du/worker-sdk';
import type { Readable } from 'node:stream';

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

/** Format identity for an artifact, canonicalized by document-kit from its bytes. */
export interface ArtifactFormatMetadata {
  canonicalFormat: SupportedFormat;
  canonicalMimeType: string;
  declaredFileName?: string;
  declaredMimeType?: string;
}

/** Grant-scoped read descriptor without bytes (mirrors @du/worker-sdk ArtifactStat). */
export interface ArtifactStat {
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
}

/** Integrity/limits options accepted by a streaming read facade. */
export interface ArtifactReadStreamOptions {
  expectedSha256?: string;
  expectedSizeBytes?: number;
}

/** An artifact buffer and its byte-derived format identity. */
export interface ArtifactReadResult {
  buffer: Buffer;
  formatMetadata: ArtifactFormatMetadata;
}

export interface TaskContext {
  readonly taskId: string;
  readonly operationId: string;
  readonly businessId: string;
  readonly businessVersion: string;
  readonly tenantId: string;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: string | null;
  readonly cancelRequested?: boolean;

  // Artifact operations
  artifacts: {
    read(artifactId: string): Promise<Buffer>;
    /** Optional enriched read for facades that retain source filename/MIME metadata. */
    readWithMetadata?(artifactId: string): Promise<ArtifactReadResult>;
    write(content: Buffer | string, fileName: string, mimeType: string): Promise<ArtifactRef>;
    /**
     * Authorized read descriptor WITHOUT bytes (DATA-04 Step B pre-flight).
     * SDK facades expose it; buffer-only facades keep the legacy in-memory path.
     */
    stat?(artifactId: string): Promise<ArtifactStat>;
    /**
     * Bounded streaming read; the SDK facade enforces grant digest/size and the
     * worker byte cap DURING transfer (Step B disk-backed acquisition).
     */
    readStream?(artifactId: string, options?: ArtifactReadStreamOptions): Promise<Readable>;
  };

  // Connector facade
  connector: {
    invoke(
      slot: 'ocr' | 'reasoning' | 'vision',
      promptOrPayload: string | Record<string, unknown>,
      options?: ConnectorInvocationOptions
    ): Promise<ConnectorInvocationResult>;
  };

  /**
   * W-ENC-04-SEAM: application encryption for this task, already bound to the
   * CLAIM tenant. Present only when the worker was started with a crypto seam;
   * absent means the deployment has encryption OFF, and every caller keeps the
   * plaintext behaviour. It is optional on purpose: a test or embedded context
   * that does not care about encryption must not be forced to fake one.
   */
  readonly crypto?: TaskArtifactCrypto;

  // Durable step checkpoints (Guarantee: full output >500 chars, no truncation)
  step<T>(
    stepKey: string,
    inputHash: string,
    fn: () => Promise<T>
  ): Promise<T>;

  // Checkpoints inquiry
  getCheckpoint(stepKey: string): Promise<StepCheckpointRecord | null>;
}
