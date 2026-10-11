import type { UsageOutbox, UsageOutboxRow } from '../src/db/usage-outbox';
import type { UsageEvent } from '../src/usage';
import { InMemoryUsageOutbox, UsageOutboxDispatcher, appendUsageEvent } from '../src';

// CR10-02 (CODE-REVIEW-FOLLOWUP-2026-10-10, section 2): the usage dispatcher runs
// on a fire-and-forget timer. Before the fix a rejection from the outbox (for
// example a database outage in claimBatch) escaped the timer callback and
// surfaced as an unhandledRejection, which terminates the Connector under
// Node's default policy. These tests pin the containment at the scheduler
// boundary: no unhandled rejection, cadence preserved, shutdown still stops the
// timer, and no event is ever marked delivered when the database did not accept
// the acknowledgement.

class FaultInjectingOutbox implements UsageOutbox {
  public claimCalls = 0;
  public markDeliveredCalls = 0;
  public deferCalls = 0;
  public claimFailuresRemaining = 0;
  public markDeliveredFailuresRemaining = 0;
  public deferFailuresRemaining = 0;

  private readonly inner = new InMemoryUsageOutbox();

  public append(event: UsageEvent): Promise<void> {
    return this.inner.append(event);
  }

  public async claimBatch(limit: number, now?: string): Promise<UsageOutboxRow[]> {
    this.claimCalls += 1;
    if (this.claimFailuresRemaining > 0) {
      this.claimFailuresRemaining -= 1;
      throw new Error('database unavailable');
    }
    return this.inner.claimBatch(limit, now);
  }

  public async markDelivered(eventId: string): Promise<void> {
    this.markDeliveredCalls += 1;
    if (this.markDeliveredFailuresRemaining > 0) {
      this.markDeliveredFailuresRemaining -= 1;
      throw new Error('database unavailable');
    }
    return this.inner.markDelivered(eventId);
  }

  public async defer(eventId: string, nextAttemptAt: string): Promise<void> {
    this.deferCalls += 1;
    if (this.deferFailuresRemaining > 0) {
      this.deferFailuresRemaining -= 1;
      throw new Error('database unavailable');
    }
    return this.inner.defer(eventId, nextAttemptAt);
  }

  public size(): number {
    return this.inner.size();
  }
}

function captureUnhandledRejections(): { reasons: unknown[]; stop: () => void } {
  const reasons: unknown[] = [];
  const handler = (reason: unknown): void => {
    reasons.push(reason);
  };
  process.on('unhandledRejection', handler);
  return {
    reasons,
    stop: () => {
      process.off('unhandledRejection', handler);
    },
  };
}

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const usageContext = {
  operationId: '11111111-1111-4111-8111-111111111111',
  taskId: '22222222-2222-4222-8222-222222222222',
};

test('CR10-02: a claimBatch rejection at the scheduler boundary stays contained and the cadence continues', async () => {
  const capture = captureUnhandledRejections();
  const outbox = new FaultInjectingOutbox();
  const delivered: string[] = [];
  const event = appendUsageEvent('cr10-02-claim', 1, { inputTokens: 3, measurement: 'measured' }, usageContext)!;
  await outbox.append(event);
  outbox.claimFailuresRemaining = 2;

  const dispatcher = new UsageOutboxDispatcher(
    outbox,
    { send: async (evt) => { delivered.push(evt.eventId); } },
    { pollIntervalMs: 5, baseRetryMs: 0, maxRetryMs: 0, random: () => 0 },
  );

  try {
    dispatcher.start();
    await settle(120);
    await dispatcher.drain();

    expect(capture.reasons).toEqual([]);
    expect(outbox.claimCalls).toBeGreaterThanOrEqual(3);
    expect(delivered).toEqual([event.eventId]);
    expect(outbox.markDeliveredCalls).toBe(1);
    expect(outbox.size()).toBe(0);
  } finally {
    await dispatcher.drain();
    capture.stop();
  }
});

test('CR10-02: a claimBatch rejection is contained for a direct dispatch cycle', async () => {
  const capture = captureUnhandledRejections();
  const outbox = new FaultInjectingOutbox();
  const event = appendUsageEvent('cr10-02-direct', 1, { inputTokens: 4, measurement: 'measured' }, usageContext)!;
  await outbox.append(event);
  outbox.claimFailuresRemaining = 1;

  const dispatcher = new UsageOutboxDispatcher(outbox, { send: async () => undefined }, { pollIntervalMs: 1000 });
  try {
    await expect(dispatcher.dispatchOnce()).resolves.toBeUndefined();
    expect(capture.reasons).toEqual([]);
    expect(outbox.size()).toBe(1);
  } finally {
    await dispatcher.drain();
    capture.stop();
  }
});

test('CR10-02: markDelivered and defer rejections are contained and the event is not marked delivered', async () => {
  const capture = captureUnhandledRejections();
  const outbox = new FaultInjectingOutbox();
  const event = appendUsageEvent('cr10-02-mark', 1, { inputTokens: 5, measurement: 'measured' }, usageContext)!;
  await outbox.append(event);
  outbox.markDeliveredFailuresRemaining = 1;
  outbox.deferFailuresRemaining = 1;

  const dispatcher = new UsageOutboxDispatcher(outbox, { send: async () => undefined }, { pollIntervalMs: 1000 });
  try {
    await expect(dispatcher.dispatchOnce()).resolves.toBeUndefined();
    expect(capture.reasons).toEqual([]);
    expect(outbox.markDeliveredCalls).toBe(1);
    expect(outbox.size()).toBe(1);
  } finally {
    await dispatcher.drain();
    capture.stop();
  }
});

test('CR10-02: a defer rejection is contained and the event stays queued for retry', async () => {
  const capture = captureUnhandledRejections();
  const outbox = new FaultInjectingOutbox();
  const event = appendUsageEvent('cr10-02-defer', 1, { inputTokens: 6, measurement: 'measured' }, usageContext)!;
  await outbox.append(event);
  outbox.deferFailuresRemaining = 1;

  const dispatcher = new UsageOutboxDispatcher(
    outbox,
    { send: async () => { throw new Error('sink down'); } },
    { pollIntervalMs: 1000, baseRetryMs: 0, maxRetryMs: 0, random: () => 0 },
  );
  try {
    await expect(dispatcher.dispatchOnce()).resolves.toBeUndefined();
    expect(capture.reasons).toEqual([]);
    expect(outbox.size()).toBe(1);
  } finally {
    await dispatcher.drain();
    capture.stop();
  }
});

test('CR10-02: drain stops the timer even when every poll fails', async () => {
  const capture = captureUnhandledRejections();
  const outbox = new FaultInjectingOutbox();
  outbox.claimFailuresRemaining = 10000;

  const dispatcher = new UsageOutboxDispatcher(outbox, { send: async () => undefined }, { pollIntervalMs: 5 });
  try {
    dispatcher.start();
    await settle(60);
    expect(outbox.claimCalls).toBeGreaterThanOrEqual(1);

    await dispatcher.drain();
    const claimsAtDrain = outbox.claimCalls;
    await settle(60);

    expect(capture.reasons).toEqual([]);
    expect(outbox.claimCalls).toBe(claimsAtDrain);
  } finally {
    await dispatcher.drain();
    capture.stop();
  }
});
