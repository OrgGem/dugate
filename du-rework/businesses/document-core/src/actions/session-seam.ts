import type { PinnedProfilePolicy } from '@du/contracts';
import type { TaskContext } from '../types/context';

/**
 * P745-SESSION-CONSUME — the capture/inject session seam for document-core
 * action consumers, built on the existing ctx.connector.invoke path (no
 * runConnectorStep migration, per the DELTA-D adjudication).
 *
 * The pinned admission policy (ctx.profilePolicy, carried by the W1b pin)
 * holds connectionsOverride: ConnectionStep[], where each step may declare
 * captureSession / injectSession — a NAMED session slot (legacy ConnectionStep
 * semantics: the name identifies the slot, not a value).
 *
 *   capture: after the invoke, the provider-offered sessionRef is persisted
 *            under that slot (a `p745:session:<slot>` checkpoint) so a later
 *            step — or a resumed delivery of this task — can continue it.
 *   inject:  before the invoke, the slot's stored sessionRef is passed as
 *            options.sessionRef (wire + canonical hash).
 *
 * Δ-2 MAPPING RULE (settled by CR06-03, 2026-10-06) — the official contract:
 * - `connectionsOverride[].stepId` MUST be the document-core step key emitted
 *   by src/recipes/step-keys.ts (e.g. `ingest:execute-ocr`,
 *   `extract:connector-inference`). Matching is EXACT.
 * - Legacy/abbreviated ids (`ocr`, `extract`, …) have NO alias table and are
 *   NOT guessed: such a step declares no session config and the seam skips it
 *   (fail-loud, pre-P745 behaviour). Adding an alias table requires a separate
 *   lease/decision with an authoritative producer of the legacy mapping.
 * - Session values are addressed by SLOT NAME, so the capture step and the
 *   inject step do not need to know each other's step ids.
 *
 * Honest limits (flagged, not hidden):
 * - The slot store is a task checkpoint (`p745:session:<slot>`). A resumed
 *   delivery reads it from the claim's checkpoint refs; a DIFFERENT task does
 *   not inherit it. Once the runtime drops the checkpoint ref the value is
 *   gone and the next inject starts a fresh provider session.
 * - Capture is FIRST-WRITE-WINS: a step that recaptures an existing slot keeps
 *   the stored value. Re-capturing a different session needs a new slot name.
 * - Multi-invocation steps (the transform chunk loop) inject the same session
 *   into every call of that step and capture the first offered session once.
 * - profilePolicy === null (admitted-without-policy) means NO session config
 *   exists: the seam returns null and never fabricates a session.
 */

export interface StepSessionConfig {
  /** Slot name whose stored sessionRef should be injected into this step. */
  injectSession?: string | null;
  /** Slot name under which this step's offered sessionRef is captured. */
  captureSession?: string | null;
}

/**
 * Deterministic checkpoint key for a named session slot. Both capture and
 * inject use the same key so the slot is the only cross-step contract.
 */
export function sessionSlotStepKey(slot: string): string {
  return `p745:session:${slot}`;
}

/**
 * The session config declared for stepId in the pinned policy, or null when
 * the operation was admitted without a policy / the step declares none.
 * null policy and undefined policy behave identically (no config).
 * Exact-match only: no legacy stepId alias is invented here (Δ-2 rule).
 */
export function findStepSessionConfig(
  ctx: TaskContext,
  stepId: string
): StepSessionConfig | null {
  const policy: PinnedProfilePolicy | null | undefined = ctx.profilePolicy;
  if (policy == null) return null;
  const steps = policy.connectionsOverride;
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const hit = steps.find((s) => s && s.stepId === stepId);
  if (!hit) return null;
  return {
    injectSession: hit.injectSession ?? null,
    captureSession: hit.captureSession ?? null,
  };
}

/**
 * The sessionRef to continue on this invocation: the caller's explicit value
 * wins; otherwise fall back to the session stored on this step's checkpoint
 * (the SDK keeps it on the row; step.peek returns it). Returns null when there
 * is nothing to continue — never a fabricated value.
 */
export async function resolveInjectSessionRef(
  ctx: TaskContext,
  stepKey: string,
  requested?: string | null
): Promise<string | null> {
  if (typeof requested === 'string' && requested.trim().length > 0) {
    return requested;
  }
  return awaitCheckpointSessionRef(ctx, stepKey);
}

/**
 * Read the sessionRef a prior delivery stored on this checkpoint, without
 * executing the step. Works on both context shapes:
 * - SDK path: step.peek exposes CheckpointRef.sessionRef (the runtime column);
 * - internal/test path: getCheckpoint's record exposes the same column, and a
 *   payload-shaped `{ sessionRef }` output is accepted as the legacy fallback.
 */
export async function awaitCheckpointSessionRef(
  ctx: TaskContext,
  stepKey: string,
): Promise<string | null> {
  const sdk = ctx as unknown as {
    step?: { peek?: (key: string) => Promise<{ sessionRef?: string | null } | null> };
  };
  if (sdk.step && typeof sdk.step.peek === 'function') {
    const peeked = await sdk.step.peek(stepKey);
    const value = peeked?.sessionRef;
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
  }
  const internal = ctx as unknown as {
    getCheckpoint?: (key: string) => Promise<{ sessionRef?: string | null; output?: unknown } | null>;
  };
  if (internal.getCheckpoint && typeof internal.getCheckpoint === 'function') {
    const record = await internal.getCheckpoint(stepKey);
    const columnValue = record?.sessionRef;
    if (typeof columnValue === 'string' && columnValue.trim().length > 0) return columnValue;
    const value = (record?.output as { sessionRef?: string | null } | null)?.sessionRef;
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
  }
  return null;
}

/**
 * The sessionRef a step should persist when it declares captureSession, or
 * null when the provider offered none / the step does not capture.
 */
export function captureSessionRef(
  config: StepSessionConfig | null,
  result: { sessionRef?: string | null } | null | undefined,
): string | null {
  if (!config || !config.captureSession) return null;
  const value = result?.sessionRef;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Resolve the sessionRef to INJECT for `stepId` from the pinned policy:
 * the `injectSession` slot's checkpoint, with the step's own checkpoint as the
 * same-step resume fallback. Returns null when the policy declares no inject
 * slot or nothing was captured yet — never a fabricated value.
 */
export async function resolveStepSessionRef(
  ctx: TaskContext,
  stepId: string,
): Promise<string | null> {
  const config = findStepSessionConfig(ctx, stepId);
  const slot = config?.injectSession;
  if (!slot) return null;
  const fromSlot = await awaitCheckpointSessionRef(ctx, sessionSlotStepKey(slot));
  if (fromSlot !== null) return fromSlot;
  // Same-step resume: a previous delivery of THIS step may carry the session
  // on its own checkpoint (capture and inject declared on the same step).
  return resolveInjectSessionRef(ctx, stepId);
}

/**
 * Persist the provider-offered sessionRef of a capture step into its named
 * slot checkpoint. No capture config, no offered value, or an existing slot
 * (first-write-wins replay) => no write. Returns the stored value or null.
 */
export async function persistStepSessionCapture(
  ctx: TaskContext,
  stepId: string,
  offered: string | null | undefined,
): Promise<string | null> {
  const config = findStepSessionConfig(ctx, stepId);
  if (!config?.captureSession) return null;
  const captured = captureSessionRef(config, { sessionRef: offered });
  if (captured === null) return null;
  const slotKey = sessionSlotStepKey(config.captureSession);
  // First-write-wins: an existing slot (replayed delivery / earlier capture)
  // keeps the stored session; never overwrite with a later value.
  const existing = await awaitCheckpointSessionRef(ctx, slotKey);
  if (existing !== null) return existing;
  // The constant inputHash + saveStep opts make this record durable across
  // redeliveries (checkpoint list on the SDK path, checkpoint store on the
  // internal/test path) and replay-idempotent.
  await ctx.step(
    slotKey,
    `session-slot:${config.captureSession}`,
    async () => ({ sessionRef: captured }),
    { sessionRef: captured },
  );
  return captured;
}

/**
 * Capture/inject wrapped around one connector invoke call:
 *   1. resolve the inject slot (if the pinned policy declares one),
 *   2. run the invoke with `sessionRef` when a value exists,
 *   3. persist a provider-offered session when the step declares capture.
 * Without a matching policy step this is a pass-through: the invoke receives
 * `null` and no checkpoint is written — the pre-P745 single-shot path.
 */
export async function invokeWithStepSession<T extends { sessionRef?: string | null }>(
  ctx: TaskContext,
  stepId: string,
  invoke: (sessionRef: string | null) => Promise<T>,
): Promise<T> {
  const injectSessionRef = await resolveStepSessionRef(ctx, stepId);
  const result: T = await invoke(injectSessionRef);
  await persistStepSessionCapture(ctx, stepId, result?.sessionRef ?? null);
  return result;
}
