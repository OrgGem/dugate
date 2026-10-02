/**
 * P9-03 doc-compare advanced — versioned business schemas.
 *
 * Distinct from the `compare` CORE action by construction: a core compare answers
 * "what changed" in one pass over two texts, whereas doc-compare answers "did the
 * STRUCTURE change and do the SEMANTIC references still resolve" across documents
 * too large to hold in one prompt. See the report's BRD section.
 *
 * Everything crossing a resume boundary is versioned, because a workflow that waits
 * for a human, or that checkpoints across several calls, outlives the deploy that
 * wrote its state. A resume must be able to prove which shape it is answering.
 */

export const DOC_COMPARE_INPUT_VERSION = 'doc-compare-input-v1' as const;
export const DOC_COMPARE_STATE_VERSION = 'doc-compare-state-v1' as const;
export const DOC_COMPARE_RESULT_VERSION = 'doc-compare-result-v1' as const;

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

/**
 * How a chunk was cut. Recorded on every chunk so a reviewer can tell a
 * deliberate section split from an emergency size split.
 */
export type ChunkBoundaryKind = 'section' | 'size';

export interface DocumentChunkRef {
  readonly chunkId: string;
  /** Side: which of the two documents this chunk came from. */
  readonly side: 'left' | 'right';
  readonly ordinal: number;
  readonly boundaryKind: ChunkBoundaryKind;
  /** Section heading this chunk covers, when the chunk is a whole section. */
  readonly sectionTitle: string | null;
  /** Zero-based character offset within that side's normalised text. */
  readonly startOffset: number;
  readonly endOffset: number;
  readonly charCount: number;
}

/**
 * One side of the comparison, already normalised into text + sections.
 *
 * Only artifact references and text: no bytes, no URLs, no client identity.
 */
export interface DocumentSideInput {
  readonly side: 'left' | 'right';
  readonly artifactId: string;
  readonly fileName: string;
  readonly text: string;
  readonly sections: readonly DocumentSection[];
}

export interface DocumentSection {
  readonly sectionId: string;
  readonly title: string;
  /** Heading depth, 1 = top level. Used for alignment and ordering claims. */
  readonly level: number;
  /** Position in document order, 0-based. */
  readonly ordinal: number;
  readonly body: string;
}

export interface DocCompareInput {
  readonly inputVersion: string;
  /**
   * Exactly two sides. Legacy checked `fileCount < 2` and proceeded with
   * `filesData[0]`/`[1]`, so a 3-file submit silently compared the first two;
   * this workflow refuses rather than dropping a document.
   */
  readonly left: DocumentSideInput;
  readonly right: DocumentSideInput;
  /** Fail-closed default. Chunking is a P9-03 deliverable, not an optimisation. */
  readonly maxChunkChars: number;
  /** Ceiling on fan-out children issued for one chunk stage. */
  readonly maxConcurrency: number;
  /** Record partial evidence and finish FAILED instead of throwing. */
  readonly continueOnPartialFailure: boolean;
  /** Ask a human to confirm the evidence set before the merge is written. */
  readonly requireHumanReview: boolean;
}

/* ------------------------------------------------------------------ */
/* Stage payloads (typed state between steps)                          */
/* ------------------------------------------------------------------ */

/** A section extracted for alignment. Produced by `extract-structure`. */
export interface StructureSection {
  readonly sectionId: string;
  readonly title: string;
  readonly level: number;
  readonly ordinal: number;
  readonly side: 'left' | 'right';
  readonly bodyDigest: string;
}

/** Ordered list of sections for one side, plus the chunking plan. */
export interface StructurePlan {
  readonly left: readonly StructureSection[];
  readonly right: readonly StructureSection[];
  readonly chunks: readonly DocumentChunkRef[];
}

export type SectionVerdict = 'unchanged' | 'modified' | 'added' | 'removed' | 'moved';

/**
 * A STRUCTURE claim: what a reviewer can check by looking at the outlines.
 * Always carries section references; never carries a score.
 */
export interface StructureClaim {
  readonly claimId: string;
  readonly verdict: SectionVerdict;
  readonly leftSectionId: string | null;
  readonly rightSectionId: string | null;
  readonly leftTitle: string | null;
  readonly rightTitle: string | null;
  readonly detail: string;
  /** Which chunks were read to make this claim. */
  readonly evidenceChunkIds: readonly string[];
}

export type ReferenceVerdict = 'resolved' | 'unresolved' | 'contradicted' | 'not-applicable';

/**
 * A SEMANTIC-REFERENCE claim. `reference` is the literal text the reference
 * pointed at, so a reviewer can find it without trusting the verdict.
 */
export interface ReferenceClaim {
  readonly claimId: string;
  readonly verdict: ReferenceVerdict;
  /** Literal reference as it appears in the source chunk. */
  readonly reference: string;
  /** Section the reference was found in. */
  readonly sectionId: string;
  readonly side: 'left' | 'right';
  /** Resolved target, when the reference resolved. */
  readonly target: string | null;
  readonly detail: string;
  readonly evidenceChunkIds: readonly string[];
}

/** Per-chunk findings, keyed by chunk so a merge can be re-run without re-reading. */
export interface ChunkEvidence {
  readonly chunkId: string;
  readonly side: 'left' | 'right';
  readonly ordinal: number;
  readonly charCount: number;
  readonly sectionIds: readonly string[];
  readonly structureClaims: readonly StructureClaim[];
  readonly referenceClaims: readonly ReferenceClaim[];
}

/** The merged, single evidence record. */
export interface ComparisonEvidence {
  readonly evidenceVersion: string;
  readonly leftFileName: string;
  readonly rightFileName: string;
  readonly chunkCount: number;
  readonly structureClaims: readonly StructureClaim[];
  readonly referenceClaims: readonly ReferenceClaim[];
  readonly verdictCounts: Readonly<Record<SectionVerdict, number>>;
  /** Chunks that produced no claims because the child failed. */
  readonly incompleteChunks: readonly string[];
}

/* ------------------------------------------------------------------ */
/* Resume + state                                                      */
/* ------------------------------------------------------------------ */

export interface DocCompareResumeInput {
  readonly resumeSchemaVersion: string;
  /** Required and explicit: an absent approval is never consent. */
  readonly accepted: boolean;
  readonly acceptedBy?: string;
  readonly note?: string;
}

/**
 * Durable workflow state. `completedStageChunks` is the resume ledger: a stage
 * re-entered after a crash re-runs only the chunks missing from it.
 */
export interface DocCompareState {
  readonly stateVersion: string;
  readonly inputVersion: string;
  readonly stage: DocCompareStage;
  readonly left: DocumentSideInput;
  readonly right: DocumentSideInput;
  readonly maxChunkChars: number;
  readonly maxConcurrency: number;
  readonly continueOnPartialFailure: boolean;
  readonly structure: StructurePlan | null;
  /** Chunk id -> evidence, accumulated across calls. */
  readonly chunkEvidence: Readonly<Record<string, ChunkEvidence>>;
  readonly failedChunks: readonly { readonly chunkId: string; readonly reason: string }[];
  readonly joinToken: string | null;
  readonly pendingStage: DocCompareStage | null;
  /**
   * Chunk ids actually issued for `pendingStage`. A join is validated against
   * THIS list, so a stale or invented chunk cannot inject evidence.
   */
  readonly issuedChunkIds: readonly string[];
  readonly reviewRequired: boolean;
  readonly resume: DocCompareResumeInput | null;
}

/**
 * Business stages. Structure extraction and semantic-reference comparison are
 * DISTINCT stages with their own typed state: the legacy workflow collapsed both
 * into one `ext-doc-compare` call, so a reference finding could not be traced
 * back to a structure finding.
 */
export type DocCompareStage =
  | 'extract-structure'
  | 'compare-structure'
  | 'compare-references'
  | 'merge-evidence'
  | 'done';

export const DOC_COMPARE_STAGE_ORDER: readonly DocCompareStage[] = [
  'extract-structure',
  'compare-structure',
  'compare-references',
  'merge-evidence',
];

export interface DocCompareResult {
  readonly resultVersion: string;
  readonly businessId: string;
  readonly businessVersion: string;
  readonly evidence: ComparisonEvidence;
  readonly incompleteChunks: readonly string[];
}
