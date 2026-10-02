/**
 * Bounded fan-out.
 *
 * The legacy workflow used an unbounded `Promise.all` over every file, so a 200-file
 * upload opened 200 concurrent provider calls. Bounded fan-out is an explicit P9-01
 * deliverable, so the ceiling is enforced here rather than left to the orchestrator.

 * Results are returned in INPUT order regardless of completion order, so a resumed run
 * merges child payloads the same way every time.
 */

import { MAX_FANOUT_CONCURRENCY, type ChildOutcome, type ChildTaskSpec } from './primitives';

/** Alias for readability at call sites; the definition lives in primitives. */
export type FanoutOutcome<TPayload> = ChildOutcome<TPayload>;

/** Normalise a requested ceiling: positive, integral, and never above the hard cap. */
export function resolveConcurrency(requested: number): number {
  if (!Number.isFinite(requested)) return 1;
  const floored = Math.floor(requested);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_FANOUT_CONCURRENCY);
}

function toFailure(childId: string, err: unknown): FanoutOutcome<never> {
  const code =
    err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string'
      ? (err as { code: string }).code
      : 'CHILD_FAILED';
  const message = err instanceof Error ? err.message : String(err);
  return { childId, status: 'failed', error: { code, message } };
}

/**
 * Run every spec with at most `maxConcurrency` in flight. One child throwing never
 * cancels its siblings: the failure is recorded on that child and the rest still
 * finish, because losing 180 of 200 results to one bad file is worse than reporting
 * that file as failed.
 */
export async function runBoundedFanout<TPayload>(
  specs: readonly ChildTaskSpec[],
  maxConcurrency: number,
  run: (spec: ChildTaskSpec) => Promise<TPayload>
): Promise<readonly FanoutOutcome<TPayload>[]> {
  const outcomes: (FanoutOutcome<TPayload> | undefined)[] = new Array(specs.length);
  const ceiling = resolveConcurrency(maxConcurrency);
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
        outcomes[index] = toFailure(spec.childId, err);
      }
    }
  };

  const workers: Promise<void>[] = [];
  const workerCount = Math.min(ceiling, Math.max(specs.length, 1));
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // `noUncheckedIndexedAccess`: every slot is written by exactly one worker above, but
  // the compiler cannot see that, so an unfilled slot becomes an explicit failure
  // rather than a silent hole in the result list.
  return outcomes.map((outcome, index) =>
    outcome ??
    ({
      childId: specs[index]?.childId ?? `unknown-${index}`,
      status: 'failed',
      error: { code: 'CHILD_NOT_SCHEDULED', message: 'Fan-out slot was never executed' },
    })
  );
}