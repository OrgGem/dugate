/**
 * P9-01 disbursement — versioned business schemas.
 *
 * Input, per-stage business data, evidence and the resume payload are all versioned,
 * because a workflow that waits for a human is a workflow whose state outlives the
 * deploy that wrote it. A resume must be able to prove which shape it is answering.
 */

export const DISBURSEMENT_INPUT_VERSION = 'disbursement-input-v1' as const;
export const DISBURSEMENT_RESUME_VERSION = 'disbursement-resume-v1' as const;
export const DISBURSEMENT_RESULT_VERSION = 'disbursement-result-v1' as const;

/** One logical document discovered inside a source file during classification. */
export interface LogicalDocument {
  readonly label: string;
  readonly sourceFile: string;
  readonly category: string;
  readonly confidence: number;
}

export interface FileClassification {
  readonly fileName: string;
  readonly logicalDocuments: readonly LogicalDocument[];
}

export interface ExtractedRecord {
  readonly fileName: string;
  readonly logicalDocumentLabels: readonly string[];
  readonly fields: Readonly<Record<string, unknown>>;
}

/** A reference value a cross-check should try to contradict. Business-owned, not inferred. */
export interface ResolutionDatum {
  readonly key: string;
  readonly expected: unknown;
}

export interface CrosscheckFinding {
  readonly key: string;
  readonly status: 'match' | 'mismatch' | 'unresolved';
  readonly detail: string;
}

export interface CrosscheckResult {
  readonly findings: readonly CrosscheckFinding[];
  readonly matchedCount: number;
  readonly mismatchedCount: number;
}

/** What the approver is shown, and what the resume is checked against. */
export interface ApprovalEvidence {
  readonly filesAnalyzed: number;
  readonly logicalDocumentCount: number;
  readonly extractedRecordCount: number;
  readonly perFile: readonly {
    readonly fileName: string;
    readonly logicalDocumentCount: number;
    readonly extractedCount: number;
  }[];
}

/**
 * The resume payload. `approved` is required and explicit: a human approval that is
 * absent is never treated as consent, and `corrections` is how a human fixes a field
 * instead of re-running the fan-out.
 */
export interface DisbursementResumeInput {
  readonly resumeSchemaVersion: string;
  readonly approved: boolean;
  readonly approvedBy?: string;
  readonly note?: string;
  readonly corrections: readonly {
    readonly fileName: string;
    readonly logicalDocumentLabel: string;
    readonly field: string;
    readonly value: unknown;
  }[];
}

export interface DisbursementInput {
  readonly inputVersion: string;
  /** Artifact references only. No raw bytes, no URLs, no client-supplied identity. */
  readonly artifactIds: readonly string[];
  readonly fileNames: readonly string[];
  readonly referenceData: readonly ResolutionDatum[];
  /** Required and bounded. Bounded fan-out is a P9-01 deliverable, not an optimisation. */
  readonly maxConcurrency: number;
  /** Fail-closed default. See report Δ-P9-01-1 for the deviation from legacy extract. */
  readonly failurePolicy: 'fail-closed' | 'continue-on-partial';
  /** Evidence must be sealed before a human is asked to approve it. */
  readonly requireEncryptedEvidence: boolean;
}

/** Ports the host injects. Business logic never resolves identity and never calls AI itself. */
export interface DisbursementPorts {
  classifyFile(input: { artifactId: string; fileName: string }): Promise<readonly LogicalDocument[]>;
  extractFile(input: {
    artifactId: string;
    fileName: string;
    logicalDocuments: readonly LogicalDocument[];
  }): Promise<readonly ExtractedRecord[]>;
  crosscheck(input: {
    records: readonly ExtractedRecord[];
    referenceData: readonly ResolutionDatum[];
  }): Promise<CrosscheckResult>;
  report(input: {
    classifications: readonly FileClassification[];
    records: readonly ExtractedRecord[];
    crosscheck: CrosscheckResult;
  }): Promise<string>;
}

/** Durable state the orchestrator owns and hands back on every call. */
export interface DisbursementState {
  readonly inputVersion: string;
  readonly completedStages: readonly string[];
  readonly classifications: readonly FileClassification[];
  readonly records: readonly ExtractedRecord[];
  readonly crosscheck?: CrosscheckResult;
  readonly report?: string;
  readonly pendingJoinToken?: string;
  readonly childResults: readonly ChildResultOfBusiness[];
}

export type ChildResultOfBusiness = {
  readonly childId: string;
  readonly status: 'succeeded' | 'failed';
  readonly payload?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
};

export function emptyDisbursementState(inputVersion: string): DisbursementState {
  return {
    inputVersion,
    completedStages: [],
    classifications: [],
    records: [],
    childResults: [],
  };
}