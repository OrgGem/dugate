/**
 * P9-01 typed continuation primitives.
 *
 * These are DATA descriptors, not instructions. The business layer decides what should
 * happen next and returns one of these; the orchestrator executes it mechanically
 * (fan out, join, persist a wait, or finish). There is deliberately no interpreter,
 * no eval, and no DSL here: a workflow cannot smuggle behaviour through by emitting
 * a shape the orchestrator would have to interpret. Adding a new workflow means adding
 * a new typed outcome, never teaching the orchestrator a new language.
 */

/** Business stages of the disbursement workflow, in dependency order. */
export type DisbursementStage = 'classify' | 'extract' | 'crosscheck' | 'report';

/** Hard ceiling on concurrent children for one fan-out, whatever a caller asks for. */
export const MAX_FANOUT_CONCURRENCY = 8;

/** One unit of bounded fan-out work. `childId` is stable across resumes. */
export interface ChildTaskSpec<TInput = unknown> {
  readonly childId: string;
  readonly stage: DisbursementStage;
  readonly input: TInput;
}

/**
 * Outcome of one child. This is the single canonical shape: the fan-out executor produces
 * it and the join carries it, so a result cannot change shape between the two hops.
 */
export interface ChildOutcome<TPayload = unknown> {
  readonly childId: string;
  readonly status: 'succeeded' | 'failed';
  readonly payload?: TPayload;
  readonly error?: { readonly code: string; readonly message: string };
}

/** Fan out N children with a concurrency ceiling, then come back with a join token. */
export interface SpawnChildren {
  readonly kind: 'spawn-children';
  readonly stage: DisbursementStage;
  readonly children: readonly ChildTaskSpec[];
  readonly maxConcurrency: number;
  /** Opaque key the orchestrator echoes back so the join can be matched to its fan-out. */
  readonly joinToken: string;
}

/** Human approval. Persist the state, expose `resumeSchemaVersion`, come back on input. */
export interface WaitForInput {
  readonly kind: 'wait-for-input';
  readonly stage: DisbursementStage;
  readonly prompt: string;
  readonly resumeSchemaVersion: string;
  /** Everything the approver needs to decide, as evidence — never as live handles. */
  readonly evidenceRef: string;
}

/** Terminal. Only SUCCEEDED and FAILED exist — a workflow never *declares* cancellation. */
export interface Terminate<TData = unknown> {
  readonly kind: 'terminate';
  readonly terminal: 'SUCCEEDED' | 'FAILED';
  readonly data?: TData;
  readonly failure?: { readonly code: string; readonly message: string };
}

/**
 * The complete set of continuations this workflow can emit: run the children, persist a
 * wait, or write a terminal record. A join is an INPUT (`JoinSubmission`), not an outcome —
 * once results are accepted the workflow keeps going in the same call, so there is nothing to
 * hand back.
 */
export type DisbursementContinuation<TData = unknown> = SpawnChildren | WaitForInput | Terminate<TData>;

/**
 * A fan-out coming back. The token MUST match the one issued for the pending stage.
 *
 * This exists because a join is the one value that can arrive late, twice, or for the wrong
 * stage. Without a token, a host that re-delivered the classify results would have them merged
 * as if they were extract results, and the workflow would report on documents it never
 * classified.
 */
export interface JoinSubmission<TResult = unknown> {
  readonly joinToken: string;
  readonly results: readonly ChildOutcome<TResult>[];
}
/** Narrowing helper for the orchestrator side; keeps callers from guessing on `kind`. */
export function isTerminal<TData>(outcome: DisbursementContinuation<TData>): outcome is Terminate<TData> {
  return outcome.kind === 'terminate';
}