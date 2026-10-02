/**
 * P9-03 doc-compare advanced — the advance function.
 *
 * One turn per decision. The host only does three mechanical things with the
 * result: run the chunk children, persist a wait, or write a terminal record.
 * Splitting, aligning, merging and reporting all happen here, where they are
 * testable with no queue, no database and no provider.
 *
 * No interpreter: the continuation union in ./primitives is data, and nothing in
 * this file evaluates a graph or a DSL.
 */

import {
  alignSections,
  buildStructureClaim,
  bodyDigestOf,
  clampChunkBudget,
  extractSections,
  mergeChunkEvidence,
  planChunks,
} from './chunking';
import {
  isChunkStage,
  isTerminateComparison,
  MAX_CHUNK_FANOUT_CONCURRENCY,
  type ChunkJoinSubmission,
  type ChunkOutcome,
  type ChunkTaskSpec,
  type DocCompareContinuation,
  type SpawnChunkChildren,
} from './primitives';
import {
  DOC_COMPARE_INPUT_VERSION,
  DOC_COMPARE_RESULT_VERSION,
  DOC_COMPARE_STATE_VERSION,
  DOC_COMPARE_STAGE_ORDER,
  type ChunkEvidence,
  type ComparisonEvidence,
  type DocCompareInput,
  type DocCompareResumeInput,
  type DocCompareResult,
  type DocCompareStage,
  type DocCompareState,
  type DocumentChunkRef,
  type DocumentSection,
  type DocumentSideInput,
  type StructurePlan,
  type StructureSection,
} from './types';

export const DOC_COMPARE_BUSINESS_ID = 'document-core' as const;
export const DOC_COMPARE_BUSINESS_VERSION = '1.0.0' as const;

/**
 * Stable step ids. They must not change across resumes or a checkpoint written
 * by one build is orphaned by the next.
 */
export const DOC_COMPARE_STEP_IDS = {
  extractStructure: 'doc-compare/extract-structure',
  compareStructure: 'doc-compare/compare-structure',
  compareReferences: 'doc-compare/compare-references',
  mergeEvidence: 'doc-compare/merge-evidence',
} as const;

export const DOC_COMPARE_RESUME_VERSION = 'doc-compare-resume-v1' as const;

export type DocCompareErrorCode =
  | 'INPUT_INVALID'
  | 'STATE_VERSION_MISMATCH'
  | 'JOIN_TOKEN_MISMATCH'
  | 'CHUNK_NOT_ISSUED'
  | 'RESUME_INVALID'
  | 'CHUNK_FAILED'
  | 'REVIEW_REJECTED';

export class DocCompareError extends Error {
  constructor(readonly code: DocCompareErrorCode, message: string) {
    super(message);
    this.name = 'DocCompareError';
  }
}

/* ------------------------------------------------------------------ */
/* Runtime port                                                        */
/* ------------------------------------------------------------------ */

/**
 * The only things this workflow needs from the outside world. A test supplies
 * both; nothing here reaches for a provider directly.
 */
export interface DocCompareRuntime {
  /** Run one chunk's comparison. Called once per chunk, never for a restored chunk. */
  readonly runChunk: (spec: ChunkTaskSpec) => Promise<ChunkOutcome>;
  /** Stable checkpoint identity for a stage, so the host can bind state to a key. */
  readonly checkpointKeyFor?: (stepId: string) => string;
  /** True when the deployment can persist checkpoints. Absent => no checkpointing. */
  readonly checkpointsEnabled?: boolean;
}

/* ------------------------------------------------------------------ */
/* Input normalisation                                                 */
/* ------------------------------------------------------------------ */

function assertNoIdentityLeak(input: Record<string, unknown>): void {
  const forbidden = [
    'apiKeyId', 'api_key_id', 'xApiKeyId', 'tenantId', 'tenant_id',
    'userId', 'user_id', 'authorization', 'role',
  ];
  for (const key of forbidden) {
    if (input[key] !== undefined) {
      throw new DocCompareError(
        'INPUT_INVALID',
        `Field '${key}' is not accepted; identity is resolved by the host from x-api-key`,
      );
    }
  }
}

function normalizeSide(raw: unknown, side: DocumentSideInput['side']): DocumentSideInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new DocCompareError('INPUT_INVALID', `The '${side}' side must be an object`);
  }
  const record = raw as Record<string, unknown>;
  assertNoIdentityLeak(record);
  const artifactId = record.artifactId;
  const fileName = record.fileName;
  const text = record.text;
  if (typeof artifactId !== 'string' || artifactId === '') {
    throw new DocCompareError('INPUT_INVALID', `The '${side}' side requires an artifactId`);
  }
  if (typeof fileName !== 'string' || fileName === '') {
    throw new DocCompareError('INPUT_INVALID', `The '${side}' side requires a fileName`);
  }
  if (typeof text !== 'string') {
    throw new DocCompareError('INPUT_INVALID', `The '${side}' side requires text`);
  }
  const sections = extractSections({ side, artifactId, fileName, text, sections: [] });
  return { side, artifactId, fileName, text, sections };
}

export function normalizeDocCompareInput(raw: unknown): DocCompareInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new DocCompareError('INPUT_INVALID', 'Input must be an object');
  }
  const record = raw as Record<string, unknown>;
  assertNoIdentityLeak(record);

  const maxChunkChars = clampChunkBudget(
    typeof record.maxChunkChars === 'number' ? record.maxChunkChars : clampChunkBudget(4000),
  );
  const maxConcurrency = clampConcurrency(
    typeof record.maxConcurrency === 'number' ? record.maxConcurrency : 2,
  );

  return {
    inputVersion: typeof record.inputVersion === 'string' ? record.inputVersion : DOC_COMPARE_INPUT_VERSION,
    left: normalizeSide(record.left, 'left'),
    right: normalizeSide(record.right, 'right'),
    maxChunkChars,
    maxConcurrency,
    continueOnPartialFailure: record.continueOnPartialFailure !== false,
    requireHumanReview: record.requireHumanReview === true,
  };
}

function clampConcurrency(requested: number): number {
  if (!Number.isSafeInteger(requested) || requested < 1) return 1;
  return Math.min(requested, MAX_CHUNK_FANOUT_CONCURRENCY);
}

export function emptyDocCompareState(input: DocCompareInput): DocCompareState {
  return {
    stateVersion: DOC_COMPARE_STATE_VERSION,
    inputVersion: input.inputVersion,
    stage: 'extract-structure',
    left: input.left,
    right: input.right,
    maxChunkChars: input.maxChunkChars,
    maxConcurrency: input.maxConcurrency,
    continueOnPartialFailure: input.continueOnPartialFailure,
    structure: null,
    chunkEvidence: {},
    failedChunks: [],
    joinToken: null,
    pendingStage: null,
    issuedChunkIds: [],
    reviewRequired: input.requireHumanReview,
    resume: null,
  };
}

/* ------------------------------------------------------------------ */
/* Join handling                                                       */
/* ------------------------------------------------------------------ */

function joinTokenFor(stage: DocCompareStage, inputVersion: string): string {
  return `doc-compare:${inputVersion}:${stage}`;
}

/**
 * Validate and absorb a fan-out join.
 *
 * Two rejections are load-bearing:
 *  - the token must match the stage that issued it, so a re-delivered structure
 *    join is not merged as reference findings;
 *  - every result must name a chunk that was ISSUED for this stage, so a stale
 *    or invented chunk cannot inject evidence.
 */
function takeJoin(
  state: DocCompareState,
  join: ChunkJoinSubmission,
): DocCompareState {
  if (state.joinToken === null || join.joinToken !== state.joinToken) {
    throw new DocCompareError(
      'JOIN_TOKEN_MISMATCH',
      `Join token does not match the pending stage (expected ${String(state.joinToken)})`,
    );
  }
  const issuedIds = new Set(state.issuedChunkIds);

  const chunkEvidence: Record<string, ChunkEvidence> = { ...state.chunkEvidence };
  const failedChunks = [...state.failedChunks];
  const stage = state.pendingStage ?? 'unknown';

  for (const outcome of join.results) {
    if (!issuedIds.has(outcome.chunkId)) {
      throw new DocCompareError(
        'CHUNK_NOT_ISSUED',
        `Join names chunk '${outcome.chunkId}', which was not issued for this stage`,
      );
    }
    if (outcome.status === 'succeeded' && outcome.evidence) {
      chunkEvidence[`${stage}:${outcome.chunkId}`] = outcome.evidence;
      continue;
    }
    failedChunks.push({
      chunkId: outcome.chunkId,
      reason: outcome.error?.message ?? 'chunk failed without a reason',
    });
  }

  return {
    ...state,
    chunkEvidence,
    failedChunks,
    joinToken: null,
    pendingStage: null,
    issuedChunkIds: [],
  };
}

/** Chunk ids already carrying evidence for a stage — the resume ledger. */
function completedChunkIds(state: DocCompareState, stage: DocCompareStage): Set<string> {
  const done = new Set<string>();
  for (const key of Object.keys(state.chunkEvidence)) {
    if (key.startsWith(`${stage}:`)) done.add(key.slice(stage.length + 1));
  }
  return done;
}

function evidenceForStage(state: DocCompareState, stage: DocCompareStage): ChunkEvidence[] {
  const prefix = `${stage}:`;
  const out: ChunkEvidence[] = [];
  for (const key of Object.keys(state.chunkEvidence)) {
    if (key.startsWith(prefix)) out.push(state.chunkEvidence[key]!);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Stages                                                              */
/* ------------------------------------------------------------------ */

/**
 * Stage 1 — extract structure and lay out the chunk plan.
 *
 * Pure and cheap, so it is not checkpointed through the runtime; the plan is
 * stored in the state, which is the checkpoint.
 */
function stageExtractStructure(state: DocCompareState): DocCompareState {
  const leftChunks = planChunks(state.left, state.maxChunkChars);
  const rightChunks = planChunks(state.right, state.maxChunkChars);
  const toStructure = (side: DocumentSideInput): readonly StructureSection[] =>
    side.sections.map((section) => ({
      sectionId: section.sectionId,
      title: section.title,
      level: section.level,
      ordinal: section.ordinal,
      side: side.side,
      bodyDigest: bodyDigestOf(section.body),
    }));
  const structure: StructurePlan = {
    left: toStructure(state.left),
    right: toStructure(state.right),
    chunks: [...leftChunks, ...rightChunks],
  };
  return { ...state, stage: 'compare-structure', structure };
}

/**
 * Emit the fan-out for a chunk stage, skipping chunks already in the ledger.
 *
 * Returns null when every chunk for this stage is already evidenced — a resumed
 * run has nothing to spawn and must advance rather than invent a continuation.
 */
function stageChunkFanout(
  state: DocCompareState,
  stage: 'compare-structure' | 'compare-references',
): SpawnChunkChildren | null {
  const chunks = state.structure?.chunks ?? [];
  const done = completedChunkIds(state, stage);

  // Only chunks whose sections exist on the side they belong to.
  const relevant: DocumentChunkRef[] = chunks.filter((chunk) =>
    chunk.side === 'left'
      ? state.left.sections.some((section) => chunk.sectionTitle === null || section.title === chunk.sectionTitle)
      : state.right.sections.some((section) => chunk.sectionTitle === null || section.title === chunk.sectionTitle),
  );

  const children: ChunkTaskSpec[] = relevant
    .filter((chunk) => !done.has(chunk.chunkId))
    .map((chunk) => ({
      chunkId: chunk.chunkId,
      stage,
      input: {
        chunk,
        left: state.left,
        right: state.right,
        structure: state.structure,
      },
    }));

  if (children.length === 0) return null;

  return {
    kind: 'spawn-chunk-children',
    stage,
    children,
    maxConcurrency: state.maxConcurrency,
    joinToken: joinTokenFor(stage, state.inputVersion),
  };
}

/** Stage 4 — merge every chunk into one evidence record, optionally gating on a human. */
function stageMerge(state: DocCompareState): DocCompareContinuation<DocCompareResult> {
  const structureEvidence = evidenceForStage(state, 'compare-structure');
  const referenceEvidence = evidenceForStage(state, 'compare-references');

  const mergedChunks = [...structureEvidence, ...referenceEvidence].map((chunk, index) => ({
    chunkId: chunk.chunkId,
    side: chunk.side,
    ordinal: chunk.ordinal,
    charCount: chunk.charCount,
    sectionIds: chunk.sectionIds,
    structureClaims: index < structureEvidence.length ? chunk.structureClaims : [],
    referenceClaims: index >= structureEvidence.length ? chunk.referenceClaims : [],
  }));

  const evidence: ComparisonEvidence = mergeChunkEvidence({
    leftFileName: state.left.fileName,
    rightFileName: state.right.fileName,
    chunks: mergedChunks,
    failedChunkIds: state.failedChunks.map((failure) => failure.chunkId),
  });

  const incomplete = evidence.incompleteChunks.length > 0;
  if (incomplete && !state.continueOnPartialFailure) {
    return {
      kind: 'terminate',
      terminal: 'FAILED',
      failure: {
        code: 'CHUNK_FAILED',
        message: `${evidence.incompleteChunks.length} chunk(s) produced no evidence`,
      },
    };
  }

  const result: DocCompareResult = {
    resultVersion: DOC_COMPARE_RESULT_VERSION,
    businessId: DOC_COMPARE_BUSINESS_ID,
    businessVersion: DOC_COMPARE_BUSINESS_VERSION,
    evidence,
    incompleteChunks: evidence.incompleteChunks,
  };

  // Wait for a human only while the review is still OUTSTANDING. A resume that
  // already carries an answer has settled the question; re-raising the wait would
  // loop the operation forever instead of letting it finish.
  const reviewSettled = state.resume !== null;
  if (state.reviewRequired && !reviewSettled) {
    return {
      kind: 'wait-for-review',
      stage: 'merge-evidence',
      prompt: 'Confirm the comparison evidence set before it is written as the result.',
      resumeSchemaVersion: DOC_COMPARE_RESUME_VERSION,
      evidenceRef: `doc-compare-evidence:${state.left.artifactId}:${state.right.artifactId}`,
      chunkCount: mergedChunks.length,
    };
  }

  return { kind: 'terminate', terminal: 'SUCCEEDED', data: result };
}

/* ------------------------------------------------------------------ */
/* Advance                                                             */
/* ------------------------------------------------------------------ */

export interface DocCompareAdvanceRequest {
  readonly input: unknown;
  readonly state?: DocCompareState;
  readonly runtime: DocCompareRuntime;
  /** Present only when answering a wait-for-review. */
  readonly resume?: unknown;
  /** Present only when handing back a completed fan-out. */
  readonly join?: ChunkJoinSubmission;
}

export interface DocCompareStep {
  readonly continuation: DocCompareContinuation<DocCompareResult>;
  readonly state: DocCompareState;
}

function normalizeResume(raw: unknown): DocCompareResumeInput | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DocCompareError('RESUME_INVALID', 'Resume payload must be an object');
  }
  const record = raw as Record<string, unknown>;
  assertNoIdentityLeak(record);
  if (record.resumeSchemaVersion !== DOC_COMPARE_RESUME_VERSION) {
    throw new DocCompareError(
      'RESUME_INVALID',
      `Unsupported resume schema version ${String(record.resumeSchemaVersion)}`,
    );
  }
  if (typeof record.accepted !== 'boolean') {
    throw new DocCompareError(
      'RESUME_INVALID',
      'Resume payload requires an explicit boolean "accepted"',
    );
  }
  return record as unknown as DocCompareResumeInput;
}

/**
 * Advance doc-compare by exactly one decision.
 *
 * A re-entered chunk stage re-issues ONLY the chunks missing from
 * `state.chunkEvidence`, which is what makes a resume a resume rather than a
 * silent re-run from zero.
 */
export async function advanceDocCompare(request: DocCompareAdvanceRequest): Promise<DocCompareStep> {
  const input = normalizeDocCompareInput(request.input);
  if (typeof request.runtime?.runChunk !== 'function') {
    throw new DocCompareError('INPUT_INVALID', 'runtime.runChunk is required');
  }

  const state = request.state ?? emptyDocCompareState(input);
  if (state.stateVersion !== DOC_COMPARE_STATE_VERSION) {
    throw new DocCompareError(
      'STATE_VERSION_MISMATCH',
      `State was written for ${state.stateVersion}, this build speaks ${DOC_COMPARE_STATE_VERSION}`,
    );
  }

  let current = state;
  const step = (continuation: DocCompareContinuation<DocCompareResult>): DocCompareStep => ({ continuation, state: current });

  /**
   * Issue the fan-out for a stage, or advance past it when nothing is left to
   * spawn. Returns the step to hand back, or null when the caller should keep
   * walking the stage list in this same turn.
   */
  const fanOutOrAdvance = (
    stage: 'compare-structure' | 'compare-references',
    next: DocCompareStage,
  ): DocCompareStep | null => {
    if (current.pendingStage === null && current.joinToken === null) {
      const fanout = stageChunkFanout(current, stage);
      if (fanout !== null) {
        current = {
          ...current,
          pendingStage: stage,
          joinToken: fanout.joinToken,
          issuedChunkIds: fanout.children.map((spec) => spec.chunkId),
        };
        return step(fanout);
      }
      current = { ...current, stage: next };
      return null;
    }
    if (request.join !== undefined) {
      current = takeJoin(current, request.join);
      current = { ...current, stage: next };
      return null;
    }

    // No join was handed back, so this turn is a RESUME: either the host
    // crashed after receiving the fan-out, or it never ran the children. Re-issue
    // the SAME fan-out rather than moving on. Skipping the stage would merge
    // an evidence record with one of its halves missing - a wrong answer that
    // looks like a correct one. Re-issuing is safe because a chunk is a pure
    // function of its plan, and it is what makes resume a resume.
    const fanout = stageChunkFanout(current, stage);
    if (fanout !== null) {
      current = {
        ...current,
        pendingStage: stage,
        joinToken: fanout.joinToken,
        issuedChunkIds: fanout.children.map((spec) => spec.chunkId),
      };
      return step(fanout);
    }
    current = { ...current, stage: next };
    return null;
  };

  // ── Stage 1: structure extraction + chunk plan ──
  if (current.stage === 'extract-structure' && current.structure === null) {
    current = stageExtractStructure(current);
  }

  // ── Stage 2: structure comparison fan-out ──
  if (current.stage === 'compare-structure') {
    const advanced = fanOutOrAdvance('compare-structure', 'compare-references');
    if (advanced !== null) return advanced;
  }

  // ── Stage 3: semantic reference comparison fan-out ──
  if (current.stage === 'compare-references') {
    const advanced = fanOutOrAdvance('compare-references', 'merge-evidence');
    if (advanced !== null) return advanced;
  }


  // ── Stage 4: merge + optional review ──
  const resume = normalizeResume(request.resume);
  if (resume !== undefined) {
    current = { ...current, resume };
  }
  if (current.resume !== null && current.resume.accepted === false) {
    return step({
      kind: 'terminate',
      terminal: 'FAILED',
      failure: {
        code: 'REVIEW_REJECTED',
        message: `Evidence review was rejected${current.resume.acceptedBy !== undefined ? ` by ${current.resume.acceptedBy}` : ''}`,
      },
    });
  }
  return step(stageMerge(current));
}

/**
 * Resolve how many children may run at once.
 *
 * Mirrors `clampConcurrency` in the input normaliser: anything that is not a
 * safe integer at or above 1 collapses to 1, so a malformed ceiling serialises
 * the fan-out instead of fanning out without limit. The module constant stays
 * the hard ceiling.
 *
 * Omitted means the hard ceiling. The workflow-level default of 2 is applied
 * earlier, by `normalizeDocCompareInput`, so a fan-out issued by
 * `advanceDocCompare` always carries an explicit `maxConcurrency`; this fallback
 * only governs callers that drive the executor directly.
 */
export function resolveFanoutConcurrency(requested: number | undefined): number {
  if (requested === undefined) return MAX_CHUNK_FANOUT_CONCURRENCY;
  if (!Number.isSafeInteger(requested) || requested < 1) return 1;
  return Math.min(requested, MAX_CHUNK_FANOUT_CONCURRENCY);
}

/**
 * Fan-out executor entry point.
 *
 * The host calls this with the children it was handed and returns the join.
 * Concurrency is bounded here as well as in the spec, because a host that ignores
 * the ceiling must not be able to fan out without limit.
 *
 * `maxConcurrency` is the ceiling the caller asked for, clamped by
 * `resolveFanoutConcurrency`. It used to be ignored entirely: the limit was
 * computed as `Math.max(1, Math.min(runtime ? CAP : 1, CAP))`, which simplifies
 * to the cap whatever the caller passed, so a caller requesting 1 still had 8
 * chunks in flight against the provider.
 *
 * `joinToken` is required, not defaulted. This helper used to return a
 * hard-coded `''`, which no state could ever accept, so every caller had to
 * throw the returned token away and substitute `state.joinToken` — a silent
 * footgun that reads like the helper had produced a usable submission. Making
 * it a parameter makes the wrong submission unrepresentable.
 */
export async function runChunkChildren(
  specs: readonly ChunkTaskSpec[],
  runtime: DocCompareRuntime,
  joinToken: string,
  maxConcurrency?: number,
): Promise<ChunkJoinSubmission> {
  if (typeof joinToken !== 'string' || joinToken.trim().length === 0) {
    throw new DocCompareError(
      'JOIN_TOKEN_MISMATCH',
      'runChunkChildren requires the join token issued for this fan-out',
    );
  }
  const outcomes: ChunkOutcome[] = [];
  const limit = resolveFanoutConcurrency(maxConcurrency);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= specs.length) return;
      const spec = specs[index]!;
      try {
        outcomes.push(await runtime.runChunk(spec));
      } catch (error: unknown) {
        outcomes.push({
          chunkId: spec.chunkId,
          status: 'failed',
          error: {
            code: 'CHUNK_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, specs.length); i += 1) workers.push(worker());
  await Promise.all(workers);

  return { joinToken, results: outcomes };
}

/** Test/simplification helper: align two sides directly. */
export function compareStructureNow(input: {
  left: DocumentSideInput;
  right: DocumentSideInput;
}): readonly ReturnType<typeof buildStructureClaim>[] {
  const pairs = alignSections(input.left.sections, input.right.sections);
  return pairs.map((pair) =>
    buildStructureClaim({ pair, chunkIds: ['inline'] }),
  );
}

export { isChunkStage, isTerminateComparison, DOC_COMPARE_STAGE_ORDER, bodyDigestOf };
