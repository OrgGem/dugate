import { hashInvocationInput, type InvocationResponse } from '@du/contracts';
import { OPEN_DEADLINE_SENTINEL } from './types';
import type { ConnectorInvokeInput, TaskContext } from './types';

/**
 * Invocation outcome classification + session-ref step orchestration (P4-07).
 *
 * Acceptance (tasks/P4-worker-sdk.md P4-07):
 *
 * 1. **Same logical step → stable invocation.** The canonical inputHash is
 *    derived deterministically (fixed sentinel when the task carries no
 *    operation deadline), so a redelivery recomputes the SAME hash; the
 *    runtime's grant service keys the invocationId by (taskId, stepKey,
 *    bindingSlot) and replays the stored grant for an identical hash —
 *    one provider execution per logical step even across yields/retries.
 *    A drifted hash for the same logical key is a 409 the SDK surfaces,
 *    never a blind re-invocation.
 *
 * 2. **Pending results yield instead of spin.** A PENDING/NEW/IN_FLIGHT
 *    response classifies to `pending-yield`; `runConnectorStep` throws
 *    `PendingInvocationError` (code PROVIDER_PENDING, retryable, with a
 *    retryAfterMs derived from `nextPollAt`). The worker's existing
 *    failure classification maps it onto `failTask(retryable: true,
 *    retryAfterMs)` → runtime RETRY_PENDING → fresh delivery later. The
 *    slot is released immediately; there is no polling loop and no
 *    in-memory wait anywhere in this path. Crucially the step checkpoint
 *    is NOT persisted on pending, so the resume re-enters the step, the
 *    grant replay hands back the same invocationId, and the connector
 *    ledger dedupes to the original provider execution.
 *
 * 3. **Session refs.** `runConnectorStep` sends a continuation
 *    `sessionRef` on the wire (included in the canonical hash), persists
 *    it on the step checkpoint via `step.run(..., { sessionRef })`, and
 *    returns the result-side sessionRef so multi-turn provider sessions
 *    survive yields and process restarts.
 *
 *    CR06-04: a provider may also offer a sessionRef in an async 202 body
 *    (`pending-yield`). That value is carried on the pending outcome and on
 *    `PendingInvocationError` (never dropped), and the connector ledger
 *    keeps it on the pending record — the resume replays the same stable
 *    invocationId, and the connector re-attaches the stored session to the
 *    provider. No checkpoint is written on pending (the resume must
 *    re-enter the step), so the typed error is the SDK-level carrier.
 *
 * UNKNOWN classifies to `reconcile` (non-retryable): per docs 09 an
 * unknown invocation outcome is reconciled via the connector ledger
 * using the stable invocationId — never blind-retried.
 */

/* -------------------------------------------------------------------- */
/* Outcome classification                                                */
/* -------------------------------------------------------------------- */

export type InvocationOutcome =
  | {
      kind: 'result';
      invocationId: string;
      result: NonNullable<InvocationResponse['result']>;
      usage: NonNullable<InvocationResponse['usage']> | null;
      /** Session continuation offered by the provider (may be null). */
      sessionRef: string | null;
    }
  | {
      kind: 'pending-yield';
      invocationId: string;
      /** Delay hint for the runtime retry (from nextPollAt, clamped). */
      retryAfterMs: number;
      nextPollAt: string | null;
      /**
       * CR06-04: continuation session offered by the provider in the async
       * accept response (top-level wire `sessionRef`), or null when absent.
       * The connector pending record is the durable custodian; this field
       * keeps the value visible to the yield path and the typed error.
       */
      sessionRef: string | null;
    }
  | {
      kind: 'failed';
      invocationId: string;
      code: string;
      message: string;
      retryable: boolean;
      retryAfterMs?: number;
    }
  | { kind: 'reconcile'; invocationId: string; message: string }
  | { kind: 'cancelled'; invocationId: string };

export const DEFAULT_PENDING_RETRY_MS = 5_000;
export const MIN_PENDING_RETRY_MS = 1_000;
export const MAX_PENDING_RETRY_MS = 120_000;

/** Pure classification of a wire InvocationResponse — no I/O. */
export function classifyInvocation(response: InvocationResponse): InvocationOutcome {
  switch (response.state) {
    case 'SUCCEEDED':
      return {
        kind: 'result',
        invocationId: response.invocationId,
        // A SUCCEEDED response without a result envelope is a connector
        // contract violation; surface an empty object rather than crash.
        result: response.result ?? {},
        usage: response.usage ?? null,
        // CR06-04: prefer the result-side session; fall back to the top-level
        // continuation (the connector keeps the pending 202 session when the
        // provider's final response omitted it).
        sessionRef: response.result?.sessionRef ?? response.sessionRef ?? null,
      };
    case 'NEW':
    case 'IN_FLIGHT':
    case 'PENDING':
      return {
        kind: 'pending-yield',
        invocationId: response.invocationId,
        retryAfterMs: pendingRetryDelayMs(response.nextPollAt ?? null),
        nextPollAt: response.nextPollAt ?? null,
        // CR06-04: async providers may offer the session on the 202 body.
        sessionRef: response.sessionRef ?? null,
      };
    case 'FAILED':
      return {
        kind: 'failed',
        invocationId: response.invocationId,
        code: response.error?.code ?? 'PROVIDER_UNAVAILABLE',
        message: response.error?.message ?? 'connector invocation failed',
        retryable: response.error?.retryable ?? false,
        retryAfterMs: response.error?.retryAfterMs,
      };
    case 'UNKNOWN':
      return {
        kind: 'reconcile',
        invocationId: response.invocationId,
        message: response.error?.message ?? 'invocation outcome unknown; reconcile via ledger',
      };
    case 'CANCELLED':
      return { kind: 'cancelled', invocationId: response.invocationId };
  }
}

/**
 * Derive the yield delay from the connector's poll hint. A missing or
 * already-past hint falls back to the default; values are clamped into
 * [MIN, MAX] so a hostile/broken hint can neither hot-loop nor stall the
 * retry budget.
 */
export function pendingRetryDelayMs(nextPollAt: string | null, now: number = Date.now()): number {
  if (nextPollAt === null) return DEFAULT_PENDING_RETRY_MS;
  const at = Date.parse(nextPollAt);
  if (!Number.isFinite(at)) return DEFAULT_PENDING_RETRY_MS;
  const delta = at - now;
  if (delta <= 0) return MIN_PENDING_RETRY_MS;
  return Math.min(Math.max(delta, MIN_PENDING_RETRY_MS), MAX_PENDING_RETRY_MS);
}

/* -------------------------------------------------------------------- */
/* Typed errors (shaped for the existing classifyFailure seam)           */
/* -------------------------------------------------------------------- */

/**
 * Provider work is still in flight. Throwing this from a handler makes
 * the worker report `failTask(retryable: true, retryAfterMs)` → runtime
 * RETRY_PENDING → the slot is released and the task is redelivered later.
 * That is the yield: no polling loop, no held slot, no spin.
 *
 * CR06-04: `sessionRef` carries the provider's async acceptance session
 * (when the connector response offered one). It is a property, NOT part of
 * the message: the token must not leak into logs. The durable copy lives on
 * the connector's pending record, so the resume keeps the session even when
 * the redelivered handler does not (yet) know it.
 */
export class PendingInvocationError extends Error {
  readonly code = 'PROVIDER_PENDING';
  readonly retryable = true;
  constructor(
    readonly invocationId: string,
    readonly retryAfterMs: number,
    readonly nextPollAt: string | null,
    readonly sessionRef: string | null = null
  ) {
    super(
      `invocation ${invocationId} is pending; yielding slot for ${retryAfterMs}ms` +
        (nextPollAt ? ` (nextPollAt ${nextPollAt})` : '')
    );
    this.name = 'PendingInvocationError';
  }
}

/**
 * Outcome unknown (transport ambiguity after the provider may have run).
 * Non-retryable by design: the runtime/business reconciles via the
 * connector ledger using the stable invocationId (docs 09) instead of
 * risking a second provider execution.
 */
export class ReconcileRequiredError extends Error {
  readonly code = 'INVOCATION_UNKNOWN';
  readonly retryable = false;
  constructor(readonly invocationId: string, message?: string) {
    super(message ?? `invocation ${invocationId} outcome unknown; reconciliation required`);
    this.name = 'ReconcileRequiredError';
  }
}

/** Connector returned a typed FAILED envelope. */
export class ConnectorInvocationFailedError extends Error {
  constructor(
    readonly invocationId: string,
    readonly code: string,
    readonly retryable: boolean,
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = 'ConnectorInvocationFailedError';
  }
}

/** The invocation was cancelled (operation cancel propagated). */
export class InvocationCancelledError extends Error {
  readonly code = 'CANCELLED';
  readonly retryable = false;
  constructor(readonly invocationId: string) {
    super(`invocation ${invocationId} was cancelled`);
    this.name = 'InvocationCancelledError';
  }
}

export interface InvocationResultPayload {
  invocationId: string;
  result: NonNullable<InvocationResponse['result']>;
  usage: NonNullable<InvocationResponse['usage']> | null;
  sessionRef: string | null;
}

/**
 * Narrow a classified outcome to its result payload or throw the typed
 * error for the non-result kinds (pending → yield; failed/reconcile/
 * cancelled → classification-mapped failure).
 */
export function assertInvocationResult(outcome: InvocationOutcome): InvocationResultPayload {
  switch (outcome.kind) {
    case 'result':
      return {
        invocationId: outcome.invocationId,
        result: outcome.result,
        usage: outcome.usage,
        sessionRef: outcome.sessionRef,
      };
    case 'pending-yield':
      throw new PendingInvocationError(
        outcome.invocationId,
        outcome.retryAfterMs,
        outcome.nextPollAt,
        outcome.sessionRef
      );
    case 'failed':
      throw new ConnectorInvocationFailedError(
        outcome.invocationId,
        outcome.code,
        outcome.retryable,
        outcome.message,
        outcome.retryAfterMs
      );
    case 'reconcile':
      throw new ReconcileRequiredError(outcome.invocationId, outcome.message);
    case 'cancelled':
      throw new InvocationCancelledError(outcome.invocationId);
  }
}

/* -------------------------------------------------------------------- */
/* Stable deadline derivation                                            */
/* -------------------------------------------------------------------- */

/**
 * Resolve the canonical-hash deadline deterministically:
 * explicit override → operation deadline → fixed sentinel. Never a
 * wall-clock value: the hash must survive redelivery (see module docs).
 */
export function deriveStableDeadline(
  ctx: { deadlineAt: string | null },
  override?: string
): string {
  return override ?? ctx.deadlineAt ?? OPEN_DEADLINE_SENTINEL;
}

/* -------------------------------------------------------------------- */
/* runConnectorStep — the recommended P4-07 handler path                 */
/* -------------------------------------------------------------------- */

export interface RunConnectorStepParams {
  /** Checkpoint + invocation identity key (deterministic per business def). */
  stepKey: string;
  /** Connector binding slot declared by the action manifest. */
  slot: string;
  input: ConnectorInvokeInput;
  options?: Record<string, unknown>;
  /**
   * Continuation session. When omitted, `runConnectorStep` falls back to
   * the sessionRef stored on an existing checkpoint for this stepKey
   * (multi-turn conversations resume across yields/restarts).
   */
  sessionRef?: string | null;
  /** Stable deadline override (see deriveStableDeadline). */
  deadlineAt?: string;
}

export interface ConnectorStepResult extends InvocationResultPayload {}

/**
 * Execute one connector call as a durable, replay-safe step:
 *
 *   stable inputHash → ctx.step.run(checkpoint) → ctx.connector.invoke
 *   (grant replay ⇒ stable invocationId) → classifyInvocation →
 *   result | PendingInvocationError (yield) | typed failure
 *
 * On pending the checkpoint is NOT written, so the redelivery re-enters
 * the step and the connector ledger dedupes the provider call via the
 * stable invocationId. On success the checkpoint stores the full output
 * (RUN-04 no re-inference) plus the sent sessionRef for fast recovery.
 *
 * CR06-04: on pending the provider's async session (if any) is preserved on
 * the connector's pending record and surfaced through PendingInvocationError.
 * After resume, the provider continuation is the result-side sessionRef —
 * the connector falls back to the stored pending session when the final
 * provider response omits one, so the multi-turn session is not dropped by
 * the yield.
 */
export async function runConnectorStep(
  ctx: TaskContext,
  params: RunConnectorStepParams
): Promise<ConnectorStepResult> {
  const deadlineAt = deriveStableDeadline(ctx, params.deadlineAt);
  const prior = await ctx.step.peek(params.stepKey);
  const sessionRef = params.sessionRef ?? prior?.sessionRef ?? null;

  const inputHash = hashInvocationInput({
    contractVersion: '1',
    tenantId: ctx.tenantId,
    operationId: ctx.operationId,
    taskId: ctx.taskId,
    stepKey: params.stepKey,
    bindingSlot: params.slot,
    input: params.input,
    options: params.options,
    sessionRef,
    deadlineAt,
  });

  return ctx.step.run(
    params.stepKey,
    inputHash,
    async () => {
      const response = await ctx.connector.invoke(params.slot, params.input, params.options, {
        sessionRef,
        deadlineAt,
      });
      // Throws PendingInvocationError (yield), ReconcileRequiredError,
      // ConnectorInvocationFailedError or InvocationCancelledError for
      // every non-result state; only SUCCEEDED returns.
      return assertInvocationResult(classifyInvocation(response));
    },
    { sessionRef }
  );
}
