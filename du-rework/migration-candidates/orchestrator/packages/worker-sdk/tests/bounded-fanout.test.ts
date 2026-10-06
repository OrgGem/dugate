import {
  resolveFanoutConcurrency,
  runBoundedFanout,
  type FanoutChildIdentity,
} from '../src/bounded-fanout';

interface Spec extends FanoutChildIdentity {
  readonly index: number;
}

function specs(count: number): readonly Spec[] {
  return Array.from({ length: count }, (_, index) => ({ childId: `child-${index}`, index }));
}

describe('bounded in-process fan-out', () => {
  it('resolves invalid, fractional, and over-limit concurrency under the caller cap', () => {
    expect(resolveFanoutConcurrency(999, 8)).toBe(8);
    expect(resolveFanoutConcurrency(3.9, 8)).toBe(3);
    expect(resolveFanoutConcurrency(1.9, 8)).toBe(1);
    expect(resolveFanoutConcurrency(0, 8)).toBe(1);
    expect(resolveFanoutConcurrency(-5, 8)).toBe(1);
    expect(resolveFanoutConcurrency(Number.NaN, 8)).toBe(1);
    expect(resolveFanoutConcurrency(Number.POSITIVE_INFINITY, 8)).toBe(1);
    expect(resolveFanoutConcurrency(4, 2)).toBe(2);
  });

  it('bounds in-flight work and returns outcomes in input order', async () => {
    let inFlight = 0;
    let peak = 0;
    const input = specs(8);

    const outcomes = await runBoundedFanout(input, 3, async (spec) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, (input.length - spec.index) * 2));
      inFlight -= 1;
      return spec.index;
    });

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
    expect(outcomes.map((outcome) => outcome.childId)).toEqual(input.map((spec) => spec.childId));
    expect(outcomes.map((outcome) => outcome.payload)).toEqual(input.map((spec) => spec.index));
  });

  it('records a failed child and continues running its siblings', async () => {
    const outcomes = await runBoundedFanout(specs(4), 4, async (spec) => {
      if (spec.index === 1) {
        throw Object.assign(new Error('provider rejected child'), { code: 'CHILD_REJECTED' });
      }
      return spec.index;
    });

    expect(outcomes).toHaveLength(4);
    expect(outcomes.filter((outcome) => outcome.status === 'succeeded')).toHaveLength(3);
    expect(outcomes[1]).toEqual({
      childId: 'child-1',
      status: 'failed',
      error: { code: 'CHILD_REJECTED', message: 'provider rejected child' },
    });
  });

  it('uses the standard fallback when an error has no code or is not an Error', async () => {
    const outcomes = await runBoundedFanout(specs(2), 2, async (spec) => {
      if (spec.index === 0) throw new Error('plain failure');
      throw 'string failure';
    });

    expect(outcomes[0]?.status).toBe('failed');
    expect(outcomes[0]?.error).toEqual({ code: 'CHILD_FAILED', message: 'plain failure' });
    expect(outcomes[1]?.error).toEqual({ code: 'CHILD_FAILED', message: 'string failure' });
  });

  it('returns an empty list for empty input and fails closed for unscheduled sparse slots', async () => {
    const empty: readonly Spec[] = [];
    await expect(runBoundedFanout(empty, 1, async (spec) => spec.index)).resolves.toEqual([]);

    const sparse = new Array<Spec>(2);
    await expect(runBoundedFanout(sparse, 1, async (spec) => spec.index)).resolves.toEqual([
      {
        childId: 'unknown-0',
        status: 'failed',
        error: { code: 'CHILD_NOT_SCHEDULED', message: 'Fan-out slot was never executed' },
      },
      {
        childId: 'unknown-1',
        status: 'failed',
        error: { code: 'CHILD_NOT_SCHEDULED', message: 'Fan-out slot was never executed' },
      },
    ]);
  });
});
