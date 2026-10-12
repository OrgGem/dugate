import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import type { BusinessJobV1 } from '@du/contracts';
import { businessQueueName } from '@du/contracts';
import { createBullMQConsumer } from '../src/worker';

const LIVE = process.env.DU_LIVE_INFRA === '1' && process.env.VFY_WOC_LIVE === '1';
const liveDescribe: typeof describe = LIVE ? describe : describe.skip;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for the BullMQ probe condition');
    await delay(20);
  }
}

function makeJob(businessId: string, deliveryId: string): BusinessJobV1 {
  return {
    contractVersion: '1',
    deliveryId,
    taskId: randomUUID(),
    operationId: randomUUID(),
    businessId,
    businessVersion: '1.0.0',
    action: 'extract',
    kind: 'root',
    correlationId: `vfy-woc-${randomUUID()}`,
  };
}

liveDescribe('WOC independent BullMQ adapter against disposable Redis', () => {
  const redisUrl = process.env.REDIS_URL;
  const testRedisPort = process.env.TEST_REDIS_PORT;

  beforeAll(() => {
    if (!redisUrl || !testRedisPort) throw new Error('VFY_WOC_LIVE requires REDIS_URL and TEST_REDIS_PORT');
    const parsed = new URL(redisUrl);
    if (parsed.hostname !== '127.0.0.1' || parsed.port !== testRedisPort || parsed.pathname === '/0') {
      throw new Error('WOC BullMQ tests require the explicitly allowed disposable loopback Redis database');
    }
  });

  it('uses the active BullMQ lock token and DelayedError to defer without losing the delivery', async () => {
    const businessId = `woc-vfy-bullmq-${randomUUID().slice(0, 8)}`;
    const queueName = businessQueueName(businessId, '1.0.0');
    const deliveryId = `vfy-${randomUUID()}`;
    const queue = new Queue(queueName, { connection: { url: redisUrl! } });
    const consumer = createBullMQConsumer({
      queueName,
      redisUrl: redisUrl!,
      concurrency: 1,
      workerInstanceId: `vfy-worker-${randomUUID()}`,
    });
    const handled: string[] = [];
    try {
      const added = await queue.add('business-delivery', makeJob(businessId, deliveryId), {
        jobId: `du-${deliveryId}`,
        removeOnComplete: false,
      });
      consumer.start(async (job, delivery) => {
        handled.push(job.deliveryId);
        if (handled.length === 1) {
          if (!delivery) throw new Error('BullMQ adapter omitted the delivery control');
          await delivery.defer(200);
        }
      });

      await waitFor(() => handled.length >= 2, 8_000);
      const state = await added.getState();
      expect(handled).toEqual([deliveryId, deliveryId]);
      expect(state).toBe('completed');
    } finally {
      await consumer.stop(0);
      await queue.obliterate({ force: true });
      await queue.close();
    }
  }, 15_000);

  it('keeps an admitted queue job waiting while paused and consumes it after resume', async () => {
    const businessId = `woc-vfy-bullmq-${randomUUID().slice(0, 8)}`;
    const queueName = businessQueueName(businessId, '1.0.0');
    const deliveryId = `vfy-${randomUUID()}`;
    const queue = new Queue(queueName, { connection: { url: redisUrl! } });
    const consumer = createBullMQConsumer({
      queueName,
      redisUrl: redisUrl!,
      concurrency: 2,
      workerInstanceId: `vfy-worker-${randomUUID()}`,
    });
    let handled = 0;
    try {
      await queue.add('business-delivery', makeJob(businessId, deliveryId), {
        jobId: `du-${deliveryId}`,
        removeOnComplete: false,
      });
      await consumer.pause?.();
      consumer.start(async () => { handled += 1; });
      await delay(200);
      expect(handled).toBe(0);

      const waiting = await queue.getJobs(['waiting']);
      expect(waiting).toHaveLength(1);
      await consumer.resume?.();
      await waitFor(() => handled === 1, 8_000);
      expect(handled).toBe(1);
    } finally {
      await consumer.stop(0);
      await queue.obliterate({ force: true });
      await queue.close();
    }
  }, 15_000);
});
