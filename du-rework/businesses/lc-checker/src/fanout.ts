/**
 * Bounded fan-out.
 *
 * The legacy workflow used an unbounded Promise.all over every file, so a 200-file LC
 * submission opened 200 concurrent OCR calls. Bounded fan-out is an explicit P9-02
 * deliverable, so the ceiling is enforced here rather than left to the orchestrator.
 *
 * Results come back in INPUT order regardless of completion order, so a resumed run merges
 * child payloads the same way every time.
 */

import {
  resolveFanoutConcurrency,
  runBoundedFanout as runSharedBoundedFanout,
} from '@du/worker-sdk';
import { MAX_FANOUT_CONCURRENCY, type ChildOutcome, type ChildTaskSpec } from './primitives';

export type FanoutOutcome<TPayload> = ChildOutcome<TPayload>;

/** Keep LC-checker's hard cap local while sharing the common normalization. */
export function resolveConcurrency(requested: number): number {
  return resolveFanoutConcurrency(requested, MAX_FANOUT_CONCURRENCY);
}

/**
 * Run every spec with at most `maxConcurrency` in flight. One child throwing never
 * cancels its siblings: the failure is recorded on that child and the rest still finish,
 * because an LC set where one scan is unreadable still has to be examined on the rest
 * rather than refused wholesale.
 */
export async function runBoundedFanout<TPayload>(
  specs: readonly ChildTaskSpec[],
  maxConcurrency: number,
  run: (spec: ChildTaskSpec) => Promise<TPayload>
): Promise<readonly FanoutOutcome<TPayload>[]> {
  return runSharedBoundedFanout(specs, resolveConcurrency(maxConcurrency), run);
}
