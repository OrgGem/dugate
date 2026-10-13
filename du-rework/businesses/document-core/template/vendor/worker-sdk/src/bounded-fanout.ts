/** A child identifier is the only business-specific field the executor needs. */
export interface FanoutChildIdentity {
  readonly childId: string;
}

/**
 * Per-child outcome shared by bounded in-process fan-out consumers.
 * Optional fields retain compatibility with persisted business join payloads.
 */
export interface FanoutChildOutcome<TPayload = unknown> {
  readonly childId: string;
  readonly status: 'succeeded' | 'failed';
  readonly payload?: TPayload;
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * Normalize a requested concurrency under the caller's hard ceiling.
 * Invalid/non-positive requests fail closed to one worker; fractions floor.
 */
export function resolveFanoutConcurrency(requested: number, hardLimit: number): number {
  if (!Number.isFinite(requested) || !Number.isFinite(hardLimit)) return 1;
  const floored = Math.floor(requested);
  const ceiling = Math.floor(hardLimit);
  if (floored < 1 || ceiling < 1) return 1;
  return Math.min(floored, ceiling);
}

/**
 * Execute an already-normalized concurrency of work items in input order.
 * Callers retain ownership of the hard ceiling and input validation, then pass
 * the result of resolveFanoutConcurrency here. One rejected child is captured
 * as an outcome and does not cancel its siblings.
 */
export async function runBoundedFanout<
  TSpec extends FanoutChildIdentity,
  TPayload,
>(
  specs: readonly TSpec[],
  maxConcurrency: number,
  run: (spec: TSpec) => Promise<TPayload>,
): Promise<readonly FanoutChildOutcome<TPayload>[]> {
  const outcomes: (FanoutChildOutcome<TPayload> | undefined)[] = new Array(specs.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const spec = specs[index];
      if (!spec) return;
      try {
        const payload = await run(spec);
        outcomes[index] = { childId: spec.childId, status: 'succeeded', payload };
      } catch (err) {
        const code =
          err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string'
            ? (err as { code: string }).code
            : 'CHILD_FAILED';
        const message = err instanceof Error ? err.message : String(err);
        outcomes[index] = { childId: spec.childId, status: 'failed', error: { code, message } };
      }
    }
  };

  const workers: Promise<void>[] = [];
  const workerCount = Math.min(maxConcurrency, Math.max(specs.length, 1));
  for (let index = 0; index < workerCount; index += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // Array.from visits sparse slots too, ensuring defensive fallback outcomes
  // are materialized even when an input slot was never scheduled.
  return Array.from(outcomes, (outcome, index) =>
    outcome ?? {
      childId: specs[index]?.childId ?? `unknown-${index}`,
      status: 'failed',
      error: { code: 'CHILD_NOT_SCHEDULED', message: 'Fan-out slot was never executed' },
    }
  );
}
