/**
 * Bounded fan-out.
 *
 * The legacy workflow used an unbounded `Promise.all` over every file, so a 200-file
 * upload opened 200 concurrent provider calls. Bounded fan-out is an explicit P9-01
 * deliverable, so the ceiling is enforced here rather than left to the orchestrator.

 * Results are returned in INPUT order regardless of completion order, so a resumed run
 * merges child payloads the same way every time.
 */

import {
  resolveFanoutConcurrency,
  runBoundedFanout as runSharedBoundedFanout,
} from '@du/worker-sdk';
import { MAX_FANOUT_CONCURRENCY, type ChildOutcome, type ChildTaskSpec } from './primitives';

/** Alias for readability at call sites; the definition lives in primitives. */
export type FanoutOutcome<TPayload> = ChildOutcome<TPayload>;

/** Keep disbursement's hard cap local while sharing the common normalization. */
export function resolveConcurrency(requested: number): number {
  return resolveFanoutConcurrency(requested, MAX_FANOUT_CONCURRENCY);
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
  return runSharedBoundedFanout(specs, resolveConcurrency(maxConcurrency), run);
}
