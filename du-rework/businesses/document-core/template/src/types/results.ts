/**
 * Result envelope, error taxonomy, and profile types.
 */

export interface ProvenanceInfo {
  method: 'native_parse' | 'llm_extraction' | 'llm_evaluation' | 'llm_translation' | 'grounded_qa' | 'diff' | 'ocr';
  modelSlot?: 'ocr' | 'reasoning' | 'vision';
  parserUsed?: string;
  sourceArtifactIds?: string[];
  executionDurationMs?: number;
}

export interface ResultEnvelope<T = unknown> {
  status: 'COMPLETED' | 'FAILED';
  data: T;
  provenance: ProvenanceInfo;
  warnings: string[];
}

export interface ValidationErrorDetail {
  field: string;
  code: string;
  message: string;
}

export class ValidationError extends Error {
  public readonly code: string;
  public readonly fieldErrors: ValidationErrorDetail[];

  constructor(message: string, code: string = 'VALIDATION_ERROR', fieldErrors: ValidationErrorDetail[] = []) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

export class BusinessExecutionError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  constructor(message: string, code: string, retryable: boolean = false) {
    super(message);
    this.name = 'BusinessExecutionError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface ProfileSnapshot {
  profileId: string;
  revision: number;
  parameters: Record<string, unknown>;
  slots: Record<string, { connectorId: string; revision: number; model?: string }>;
  limits?: {
    maxExecutionTimeMs?: number;
    maxTokens?: number;
    temperature?: number;
  };
}
