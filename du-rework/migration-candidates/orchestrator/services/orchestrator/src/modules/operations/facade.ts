/**
 * P2-08 — Public Operation Status & Result Facade
 *
 * Canonical OperationView shape and synchronous long-poll support for
 * `GET /api/v1/operations/:id` and `GET /api/v1/operations/:id/result`.
 */
import { HttpError } from '../../http/errors';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TERMINAL_STATES = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as const;
type TerminalState = (typeof TERMINAL_STATES)[number];

const MAX_WAIT_SECONDS = 30;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isTerminal(state: string): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * Map a raw operations row to the canonical OperationView envelope returned by
 * `GET /api/v1/operations/:id`.  The shape is a strict superset of the minimal
 * `{ id, name, state, progress, links }` described in docs 06, including
 * business metadata needed by the SDK and admin view models.
 */
export function toOperationView(r: Record<string, unknown>) {
  const id = r.id as string;
  return {
    id,
    name: `operations/${id}`,
    businessId: r.business_id,
    businessVersion: r.business_version,
    action: r.action,
    state: r.state,
    stateVersion: r.state_version,
    createdAt: r.created_at ? new Date(r.created_at as string).toISOString() : new Date().toISOString(),
    updatedAt: r.updated_at ? new Date(r.updated_at as string).toISOString() : new Date().toISOString(),
    startedAt: r.started_at ? new Date(r.started_at as string).toISOString() : null,
    completedAt: r.completed_at ? new Date(r.completed_at as string).toISOString() : null,
    retryOf: r.retry_of ?? null,
    errorCode: r.error_code ?? null,
    deadlineAt: r.deadline_at ? new Date(r.deadline_at as string).toISOString() : null,
    progress: { percent: 0, message: r.state as string },
    links: {
      self: `/api/v1/operations/${id}`,
      result: `/api/v1/operations/${id}/result`,
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Synchronous long-poll (docs 06 `?sync=true` / packet `?wait=<seconds>`).
 *
 * Polls the DB via `getOp` every 500 ms until the operation reaches a
 * terminal state or the timeout expires.  The timeout never cancels the
 * underlying operation — the caller receives the latest view at expiry.
 *
 * `waitSeconds` is clamped to [0, MAX_WAIT_SECONDS].
 */
export async function waitForTerminal(
  getOp: (id: string) => Promise<Record<string, unknown>>,
  operationId: string,
  waitSeconds: number,
): Promise<Record<string, unknown>> {
  const clamped = Math.min(MAX_WAIT_SECONDS, Math.max(0, Math.trunc(waitSeconds)));
  if (clamped <= 0) return getOp(operationId);

  const deadline = Date.now() + clamped * 1000;
  let op = await getOp(operationId);

  while (!isTerminal(op.state as string) && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(500, remaining));
    op = await getOp(operationId);
  }

  return op;
}

/**
 * Map the operation state to the correct HTTP status for
 * `GET /api/v1/operations/:id/result`.
 *
 * - SUCCEEDED  → 200  (ResultEnvelope)
 * - TIMED_OUT  → 410  (expired — docs 06)
 * - anything else → 409 STATE_CONFLICT
 */
export function resultHttpStatus(state: string): number {
  if (state === 'SUCCEEDED') return 200;
  if (state === 'TIMED_OUT') return 410;
  return 409;
}
