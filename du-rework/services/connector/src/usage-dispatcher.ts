import type { UsageEvent } from './usage';
import type { UsageOutbox, UsageOutboxRow } from './db/usage-outbox';
import { UsageEventSchema } from '@du/contracts';
import { toContractUsageEvent } from './usage';
import { ConnectorError } from './errors';

const DEFAULT_USAGE_BATCH_SIZE = 25;
const MAX_USAGE_BATCH_SIZE = 25;
const DEFAULT_USAGE_SEND_TIMEOUT_MS = 10_000;
const MAX_USAGE_SEND_TIMEOUT_MS = 30_000;
const DEFAULT_USAGE_DRAIN_TIMEOUT_MS = 30_000;
const MAX_USAGE_DRAIN_TIMEOUT_MS = 30_000;

export interface UsageSink {
  send(event: UsageEvent, signal?: AbortSignal): Promise<void>;
}

export class HttpUsageSink implements UsageSink {
  private readonly endpoint: URL;
  private readonly fetcher: typeof fetch;

  public constructor(
    endpoint: string,
    private readonly credential: string,
    fetcher: typeof fetch = fetch,
  ) {
    this.endpoint = new URL(endpoint);
    if (!['http:', 'https:'].includes(this.endpoint.protocol) || this.endpoint.username || this.endpoint.password) {
      throw new Error('Usage sink URL must be an HTTP(S) URL without userinfo.');
    }
    this.fetcher = fetcher;
  }

  public async send(event: UsageEvent, signal?: AbortSignal): Promise<void> {
    const contract = UsageEventSchema.parse(toContractUsageEvent(event));
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.credential}`,
          'content-type': 'application/json',
          'idempotency-key': contract.eventId,
        },
        body: JSON.stringify(contract),
        signal,
      });
    } catch {
      throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Usage sink is unavailable.');
    }
    if (!response.ok) throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Usage sink rejected the event.');
  }
}

export interface UsageDispatcherOptions {
  batchSize?: number;
  pollIntervalMs?: number;
  maxAttempts?: number;
  baseRetryMs?: number;
  maxRetryMs?: number;
  poisonRetryMs?: number;
  sendTimeoutMs?: number;
  random?: () => number;
}

export class UsageOutboxDispatcher {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private draining: Promise<void> | undefined;
  private readonly activeSends = new Set<{ controller: AbortController; cancel: () => void }>();
  private readonly options: Required<UsageDispatcherOptions>;

  public constructor(
    private readonly outbox: UsageOutbox,
    private readonly sink: UsageSink,
    options: UsageDispatcherOptions = {},
  ) {
    this.options = {
      batchSize: clampPositiveInteger(options.batchSize, DEFAULT_USAGE_BATCH_SIZE, MAX_USAGE_BATCH_SIZE),
      pollIntervalMs: options.pollIntervalMs ?? 1000,
      maxAttempts: options.maxAttempts ?? 8,
      baseRetryMs: options.baseRetryMs ?? 250,
      maxRetryMs: options.maxRetryMs ?? 60_000,
      poisonRetryMs: options.poisonRetryMs ?? 86_400_000,
      sendTimeoutMs: clampPositiveInteger(
        options.sendTimeoutMs,
        DEFAULT_USAGE_SEND_TIMEOUT_MS,
        MAX_USAGE_SEND_TIMEOUT_MS,
      ),
      random: options.random ?? Math.random,
    };
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  public async drain(timeoutMs = DEFAULT_USAGE_DRAIN_TIMEOUT_MS): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const work = this.draining;
    if (!work) return;
    if (timeoutMs === 0) {
      for (const activeSend of this.activeSends) {
        activeSend.controller.abort();
        activeSend.cancel();
      }
      return;
    }
    const boundedTimeoutMs = clampPositiveInteger(
      timeoutMs,
      DEFAULT_USAGE_DRAIN_TIMEOUT_MS,
      MAX_USAGE_DRAIN_TIMEOUT_MS,
    );

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            for (const activeSend of this.activeSends) {
              activeSend.controller.abort();
              activeSend.cancel();
            }
            resolve();
          }, boundedTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  public async dispatchOnce(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.processBatch();
    try {
      await this.draining;
    } finally {
      this.draining = undefined;
    }
  }

  private async processBatch(): Promise<void> {
    const rows = await this.outbox.claimBatch(this.options.batchSize);
    await Promise.all(rows.map((row) => this.deliver(row)));
  }

  private async deliver(row: UsageOutboxRow): Promise<void> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let rejectCancelled!: (error: Error) => void;
    const cancelled = new Promise<void>((_resolve, reject) => { rejectCancelled = reject; });
    const activeSend = {
      controller,
      cancel: () => rejectCancelled(new ConnectorError('PROVIDER_TIMEOUT', 'Usage sink delivery was cancelled during drain.')),
    };
    this.activeSends.add(activeSend);
    try {
      await Promise.race([
        this.sink.send(row.payload, controller.signal),
        new Promise<void>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new ConnectorError('PROVIDER_TIMEOUT', 'Usage sink request timed out.'));
          }, this.options.sendTimeoutMs);
        }),
        cancelled,
      ]);
      await this.outbox.markDelivered(row.eventId);
    } catch {
      const delay = Math.min(
        this.options.maxRetryMs,
        this.options.baseRetryMs * 2 ** Math.max(0, Math.min(row.attempts - 1, 16)),
      );
      const jitter = Math.floor(delay * 0.2 * this.options.random());
      const next = new Date(Date.now() + delay + jitter);
      const retryAt = row.attempts >= this.options.maxAttempts
        ? new Date(Date.now() + this.options.poisonRetryMs)
        : next;
      await this.outbox.defer(row.eventId, retryAt.toISOString());
    } finally {
      if (timeout) clearTimeout(timeout);
      this.activeSends.delete(activeSend);
    }
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.dispatchOnce().finally(() => this.schedule(this.options.pollIntervalMs));
    }, delay);
  }
}

function clampPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}
