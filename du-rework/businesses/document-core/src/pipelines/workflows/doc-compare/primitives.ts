/**
 * P9-03 typed continuation primitives.
 *
 * These are DATA descriptors, not instructions. The business layer decides what
 * happens next and returns one of these; the orchestrator executes it mechanically
 * (fan out, join, persist a wait, finish). There is deliberately no interpreter,
 * no eval and no DSL here: a workflow cannot smuggle behaviour through by emitting
 * a shape the orchestrator would have to interpret.
 *
 * Sibling of `../disbursement/primitives.ts` and intentionally NOT shared with it.
 * doc-compare fans out over CHUNKS rather than files, and its stages differ, so a
 * common union would force one workflow's stage vocabulary onto the other.
 */

import type { ChunkEvidence, DocCompareResult, DocCompareStage } from './types';

/** Hard ceiling on concurrent children for one fan-out, whatever a caller asks. */
export const MAX_CHUNK_FANOUT_CONCURRENCY = 8;

/**
 * One bounded unit of work: a single chunk, compared for structure or for
 * references. `chunkId` is stable across resumes, which is what makes a resumed
 * fan-out reuse completed children instead of redoing them.
 */
export interface ChunkTaskSpec<TPayload = unknown> {
  readonly chunkId: string;
  readonly stage: 'compare-structure' | 'compare-references';
  readonly input: TPayload;
}

/** Outcome of one chunk. One canonical shape for both the executor and the join. */
export interface ChunkOutcome {
  readonly chunkId: string;
  readonly status: 'succeeded' | 'failed';
  readonly evidence?: ChunkEvidence;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface SpawnChunkChildren {
  readonly kind: 'spawn-chunk-children';
  readonly stage: 'compare-structure' | 'compare-references';
  readonly children: readonly ChunkTaskSpec[];
  readonly maxConcurrency: number;
  /** Opaque key the orchestrator echoes back so the join matches its fan-out. */
  readonly joinToken: string;
}

/**
 * Human review of the accumulated evidence BEFORE the merge is written.
 * The evidence arrives as an artifact reference, never as live handles.
 */
export interface WaitForReview {
  readonly kind: 'wait-for-review';
  readonly stage: 'merge-evidence';
  readonly prompt: string;
  readonly resumeSchemaVersion: string;
  readonly evidenceRef: string;
  readonly chunkCount: number;
}

/** Terminal. A workflow never DECLARES cancellation; only SUCCEEDED and FAILED. */
export interface TerminateComparison<TData = unknown> {
  readonly kind: 'terminate';
  readonly terminal: 'SUCCEEDED' | 'FAILED';
  readonly data?: TData;
  readonly failure?: { readonly code: string; readonly message: string };
}

export type DocCompareContinuation<TData = unknown> =
  | SpawnChunkChildren
  | WaitForReview
  | TerminateComparison<TData>;

/**
 * A fan-out coming back. The token MUST match the one issued for the pending
 * stage, and the results MUST only name chunks that were actually issued —
 * otherwise a re-delivered join for the structure stage could be merged as if it
 * were reference findings.
 */
export interface ChunkJoinSubmission {
  readonly joinToken: string;
  readonly results: readonly ChunkOutcome[];
}

/** Narrowing helper; keeps callers from guessing on `kind`. */
export function isTerminateComparison<TData>(
  outcome: DocCompareContinuation<TData>,
): outcome is TerminateComparison<TData> {
  return outcome.kind === 'terminate';
}

/** Stage that consumes a fan-out join, used only for error messages. */
export function isChunkStage(stage: DocCompareStage): stage is 'compare-structure' | 'compare-references' {
  return stage === 'compare-structure' || stage === 'compare-references';
}
