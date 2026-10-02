/**
 * P9-02 LC checker — versioned business schemas.
 *
 * Input, per-stage business data, evidence and the result are all versioned, and every
 * discrepancy must name the rule that produced it. A result that cannot say WHICH rule
 * version it applied is not evidence — it is an opinion, and the P9-02 acceptance
 * explicitly refuses to let a prompt stand in for a legal guarantee.
 */

import type { RuleSetStatus } from './rules/rule-types';

export const LC_CHECKER_INPUT_VERSION = 'lc-checker-input-v1' as const;
export const LC_CHECKER_RESULT_VERSION = 'lc-checker-result-v1' as const;

export type DiscrepancySeverity = 'MAJOR' | 'MINOR' | 'ADVISORY';

export type LcVerdict = 'COMPLIANT' | 'DISCREPANT' | 'PENDING';

export type LcRecommendation = 'ACCEPT' | 'REJECT' | 'RESERVE_FOR_REVIEW';

/** OCR text recovered from one source file, plus how it was obtained. */
export interface OcrDocumentText {
  readonly fileName: string;
  readonly text: string;
  /** False when the OCR child failed and this file has no recovered text. */
  readonly fromOcr: boolean;
  readonly charCount: number;
}

/**
 * One deviation from the credit terms or the rules base.
 *
 * `ruleId` is REQUIRED and must resolve in the rule registry. A discrepancy with no
 * rule behind it is not permitted through: the legacy workflow emitted free-text issues
 * with no traceable basis, which is exactly the failure mode P9-02 was opened to close.
 */
export interface LcDiscrepancy {
  readonly id: string;
  readonly severity: DiscrepancySeverity;
  /** Logical document label the deviation was found on. */
  readonly document: string;
  readonly field: string;
  readonly issue: string;
  /** Must exist in LC_RULE_REGISTRY. Enforced, not advisory. */
  readonly ruleId: string;
  readonly recommendation: string;
}

/**
 * A visual check the TEXT pass says it cannot settle.
 *
 * The connector contract caps one invocation at 4 artifacts and 10 MiB, while a
 * documentary credit set is 6-12 documents. Rather than give up on the ones that do not
 * fit, the first pass states exactly which document, which question, and which rules are
 * at stake. The second pass then opens only those documents, under the same ceiling.
 *
 * `ruleIds` is required and must resolve in the rules base, for the same reason a
 * discrepancy must cite one: a visual check with no rule behind it is a curiosity, and a
 * pass that can ask for arbitrary pages is an unbounded bill.
 */
export interface LcVisualRequest {
  /** Index into LcCheckerInput.fileNames. */
  readonly documentIndex: number;
  /** What has to be looked at, in the examiner's words. */
  readonly purpose: string;
  readonly ruleIds: readonly string[];
}

/** Outcome of the text-only screening pass. */
export interface LcScreenResult {
  readonly visualRequests: readonly LcVisualRequest[];
  /** What the text pass could settle on its own, carried into the adjudication. */
  readonly notes: string;
  readonly ruleSetVersion: string;
}

export interface LcVisualObservation {
  readonly field: string;
  readonly found: boolean;
  readonly evidence: string;
}

/** What the second pass actually managed to read off one document. */
export interface LcVisualDigest {
  readonly documentIndex: number;
  readonly fileName: string;
  readonly purpose: string;
  readonly ruleIds: readonly string[];
  readonly observations: readonly LcVisualObservation[];
}

export interface LcComplianceResult {
  readonly verdict: LcVerdict;
  readonly totalDiscrepancies: number;
  readonly majorDiscrepancies: number;
  readonly minorDiscrepancies: number;
  readonly advisoryCount: number;
  readonly documentsPresent: readonly string[];
  readonly documentsMissing: readonly string[];
  readonly discrepancies: readonly LcDiscrepancy[];
  readonly summary: string;
  readonly recommendation: LcRecommendation;
  /** The rules base this examination was performed against. Carried, not assumed. */
  readonly ruleSetVersion: string;
}

/**
 * Whether every visual check the screening pass asked for actually came back.
 *
 * `requested` counts checks, not documents: one bill of lading may need three separate
 * looks (endorsement on the reverse, on-board notation, carrier signature). A COMPLIANT
 * verdict is refused unless `complete`, because a clean verdict over checks nobody
 * performed is not a finding.
 */
export interface LcVisualVerification {
  readonly requested: number;
  readonly satisfied: number;
  readonly complete: boolean;
}

export interface LcEvidence {
  readonly filesSubmitted: number;
  readonly filesOcred: number;
  readonly filesWithoutOcrText: readonly string[];
  readonly totalOcrChars: number;
  readonly ruleSetId: string;
  readonly ruleSetVersion: string;
  readonly ruleSetStatus: RuleSetStatus;
  /** Rule ids actually cited by at least one discrepancy in this run. */
  readonly citedRuleIds: readonly string[];
  readonly visualVerification: LcVisualVerification;
}

export interface LcCheckerInput {
  readonly inputVersion: string;
  /** Artifact references only. No raw bytes, no URLs, no client-supplied identity. */
  readonly artifactIds: readonly string[];
  readonly fileNames: readonly string[];
  /** Must resolve in LC_RULE_SETS. The examination is pinned to one rules base. */
  readonly ruleSetVersion: string;
  /** Required and bounded. Bounded fan-out is a P9-02 deliverable, not an optimisation. */
  readonly maxConcurrency: number;
  /**
   * `fail-closed` refuses to examine a set the OCR stage could not read.
   * `continue-on-partial` examines whatever survived and records the rest as failed
   * children — the legacy behaviour, which silently continued with partial text.
   */
  readonly failurePolicy: 'fail-closed' | 'continue-on-partial';
  /** Evidence must be sealed before it leaves the business. */
  readonly requireEncryptedEvidence: boolean;
}

/** Ports the host injects. Business logic never resolves identity and never calls AI itself. */
export interface LcCheckerPorts {
  /** One file in, one OCR child result out. */
  ocrFile(input: { artifactId: string; fileName: string }): Promise<string>;
  /**
   * Pass 1. Screens the recovered text and names the visual checks the text cannot settle.
   * No original is attached: this pass must work from text alone, otherwise it cannot tell
   * the platform what is missing.
   */
  screen(input: {
    ocrTexts: readonly OcrDocumentText[];
    fileNames: readonly string[];
    ruleSetVersion: string;
  }): Promise<unknown>;
  /**
   * Pass 2, one document per call. Reads a single original and answers one question about
   * it, citing the rules that question serves.
   */
  inspect(input: {
    artifactId: string;
    fileName: string;
    documentIndex: number;
    purpose: string;
    ruleIds: readonly string[];
    ruleSetVersion: string;
  }): Promise<unknown>;
  /**
   * Pass 3. The adjudication: the rules base applied to the recovered text, the screening
   * notes and every visual digest that came back. It is the only pass that may produce a
   * verdict, and it is refused a COMPLIANT result when a visual check is still outstanding.
   */
  adjudicate(input: {
    ocrTexts: readonly OcrDocumentText[];
    visualDigests: readonly LcVisualDigest[];
    /** Screening questions no digest answered, passed in so the prompt can name them. */
    outstandingChecks: readonly LcVisualRequest[];
    screenNotes: string;
    fileNames: readonly string[];
    ruleSetVersion: string;
  }): Promise<unknown>;
  generateReport(input: {
    compliance: LcComplianceResult;
    evidence: LcEvidence;
  }): Promise<string>;
}

export type LcChildResult = {
  readonly childId: string;
  readonly fileName: string;
  readonly status: 'succeeded' | 'failed';
  readonly error?: { readonly code: string; readonly message: string };
};

/** Durable state the orchestrator owns and hands back on every call. */
export interface LcCheckerState {
  readonly inputVersion: string;
  readonly ruleSetVersion: string;
  readonly completedStages: readonly string[];
  readonly ocrTexts: readonly OcrDocumentText[];
  readonly childResults: readonly LcChildResult[];
  readonly screen?: LcScreenResult;
  readonly visualDigests: readonly LcVisualDigest[];
  /** Visual children that failed, so a short second pass is visible rather than silent. */
  readonly visualFailures: readonly { readonly request: string; readonly reason: string }[];
  readonly compliance?: LcComplianceResult;
  readonly report?: string;
  readonly pendingJoinToken?: string;
  /** Recorded when the adjudication ran; undefined before it. */
  readonly visualVerification?: LcVisualVerification;
}

export function emptyLcCheckerState(
  inputVersion: string,
  ruleSetVersion: string
): LcCheckerState {
  return {
    inputVersion,
    ruleSetVersion,
    completedStages: [],
    ocrTexts: [],
    childResults: [],
    visualDigests: [],
    visualFailures: [],
  };
}
