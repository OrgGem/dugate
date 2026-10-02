/**
 * P9-03 doc-compare advanced — public surface.
 *
 * Re-exported as a unit so a host can adopt the workflow without reaching into
 * five files. `./runner` is re-exported here so the production
 * `createDocCompareRuntime` reaches the worker without a deep-path import; it
 * used to be reachable only by importing `./runner` directly.
 */

export {
  advanceDocCompare,
  compareStructureNow,
  emptyDocCompareState,
  normalizeDocCompareInput,
  resolveFanoutConcurrency,
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

export {
  assertNoIdentityLeak,
  createDocCompareRuntime,
  DEFAULT_DOC_COMPARE_BINDING,
  DEFAULT_DOC_COMPARE_CHUNK_TIMEOUT_MS,
  DocCompareChunkError,
  extractInvocationPayload,
  parseReferenceClaims,
  parseStructureClaims,
  sliceChunkText,
  type DocCompareChunkErrorCode,
  type DocCompareChunkInput,
  type DocCompareConnectorBinding,
  type DocCompareConnectorPort,
  type DocCompareRunnerOptions,
} from './runner';
