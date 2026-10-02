/**
 * P9-03 doc-compare advanced — public surface.
 *
 * Re-exported as a unit so a host can adopt the workflow without reaching into
 * four files. Nothing here is registered anywhere: manifest, recipe and action
 * registration are a follow-up for the owning lane.
 */

export {
  advanceDocCompare,
  compareStructureNow,
  emptyDocCompareState,
  normalizeDocCompareInput,
  runChunkChildren,
  DocCompareError,
  DOC_COMPARE_BUSINESS_ID,
  DOC_COMPARE_BUSINESS_VERSION,
  DOC_COMPARE_RESUME_VERSION,
  DOC_COMPARE_STEP_IDS,
  type DocCompareAdvanceRequest,
  type DocCompareRuntime,
  type DocCompareStep,
} from './doc-compare';

export {
  isChunkStage,
  isTerminateComparison,
  MAX_CHUNK_FANOUT_CONCURRENCY,
  type ChunkJoinSubmission,
  type ChunkOutcome,
  type ChunkTaskSpec,
  type DocCompareContinuation,
  type SpawnChunkChildren,
  type TerminateComparison,
  type WaitForReview,
} from './primitives';

export {
  alignSections,
  bodyDigestOf,
  buildStructureClaim,
  clampChunkBudget,
  DOC_COMPARE_EVIDENCE_VERSION,
  extractSections,
  MAX_CHUNK_CHARS,
  mergeChunkEvidence,
  MIN_CHUNK_CHARS,
  normalizeTitle,
  planChunks,
  sectionIdFor,
} from './chunking';

export {
  DOC_COMPARE_INPUT_VERSION,
  DOC_COMPARE_RESULT_VERSION,
  DOC_COMPARE_STAGE_ORDER,
  DOC_COMPARE_STATE_VERSION,
  type ChunkEvidence,
  type ChunkBoundaryKind,
  type ComparisonEvidence,
  type DocCompareInput,
  type DocCompareResumeInput,
  type DocCompareResult,
  type DocCompareStage,
  type DocCompareState,
  type DocumentChunkRef,
  type DocumentSection,
  type DocumentSideInput,
  type ReferenceClaim,
  type ReferenceVerdict,
  type SectionVerdict,
  type StructureClaim,
  type StructurePlan,
  type StructureSection,
} from './types';
