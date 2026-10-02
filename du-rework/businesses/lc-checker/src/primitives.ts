/**
 * P9-02 typed continuation primitives for the LC checker.
 *
 * These are DATA descriptors, not instructions. The business layer decides what happens
 * next and returns one of these; the orchestrator executes it mechanically (run children,
 * or write a terminal record). There is deliberately no interpreter, no eval and no DSL:
 * a workflow cannot smuggle behaviour through by emitting a shape the orchestrator would
 * have to understand.
 *
 * The legacy workflow had no human-in-the-loop pause, so there is no `wait-for-input`
 * here and no resume schema. Declaring a continuation the code never emits is a promise
 * the type system does not keep; the human sign-off this business needs is expressed in
 * the RESULT (see LcCheckerResult.humanSignOffRequired), not as a pause nobody can skip.
 */

/**
 * Business stages of the LC checker workflow, in dependency order.
 *
 * `screen` and `adjudicate` are both single-document-set examinations and neither fans
 * out. `visual` exists because the screening pass is allowed to name checks the OCR text
 * cannot settle, and honouring them has to be a bounded round of its own rather than a
 * hidden loop inside one provider call.
 */
export type LcCheckerStage = 'ocr' | 'screen' | 'visual' | 'adjudicate' | 'report';

/** Hard ceiling on concurrent OCR children for one fan-out, whatever a caller asks for. */
export const MAX_FANOUT_CONCURRENCY = 8;

/** One unit of bounded fan-out work: OCR of exactly one source file. `childId` is stable. */
export interface ChildTaskSpec<TInput = unknown> {
  readonly childId: string;
  readonly stage: LcCheckerStage;
  readonly input: TInput;
}

/**
 * Outcome of one child. Single canonical shape: the fan-out executor produces it and the
 * join carries it, so a result cannot change shape between the two hops.
 */
export interface ChildOutcome<TPayload = unknown> {
  readonly childId: string;
  readonly status: 'succeeded' | 'failed';
  readonly payload?: TPayload;
  readonly error?: { readonly code: string; readonly message: string };
}

/** Fan out N OCR children with a concurrency ceiling, then come back with a join token. */
export interface SpawnChildren {
  readonly kind: 'spawn-children';
  readonly stage: LcCheckerStage;
  readonly children: readonly ChildTaskSpec[];
  readonly maxConcurrency: number;
  /** Opaque key the orchestrator echoes back so the join can be matched to its fan-out. */
  readonly joinToken: string;
}

/**
 * Terminal. Only SUCCEEDED and FAILED exist — a workflow never *declares* cancellation.
 * An aborted run surfaces as a thrown error and the platform owns the state transition.
 */
export interface Terminate<TData = unknown> {
  readonly kind: 'terminate';
  readonly terminal: 'SUCCEEDED' | 'FAILED';
  readonly data?: TData;
  readonly failure?: { readonly code: string; readonly message: string };
}

/**
 * The complete set of continuations this workflow can emit. A join is an INPUT
 * (`JoinSubmission`), not an outcome: once the OCR results are accepted the workflow
 * continues in the same call, so there is nothing to hand back.
 */
export type LcCheckerContinuation<TData = unknown> = SpawnChildren | Terminate<TData>;

/**
 * A fan-out coming back. The token MUST match the one issued for the pending stage.
 *
 * A join is the one value that can arrive late, twice, or for the wrong stage. Without a
 * token, a host that re-delivered the OCR results twice would merge them as if they were
 * a second examination, and the report would be built on a document set that was never
 * actually read.
 */
export interface JoinSubmission<TResult = unknown> {
  readonly joinToken: string;
  readonly results: readonly ChildOutcome<TResult>[];
}

/** Narrowing helper for the orchestrator side; keeps callers from guessing on `kind`. */
export function isTerminal<TData>(
  outcome: LcCheckerContinuation<TData>
): outcome is Terminate<TData> {
  return outcome.kind === 'terminate';
}
