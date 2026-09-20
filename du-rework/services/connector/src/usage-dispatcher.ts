import type { UsageEvent } from './usage';
import type { UsageOutbox, UsageOutboxRow } from './db/usage-outbox';
import { UsageEventSchema } from '@du/contracts';
import { toContractUsageEvent } from './usage';
import { ConnectorError } from './errors';

export interface UsageSink {
  send(event: UsageEvent): Promise<void>;
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

  public async send(event: UsageEvent): Promise<void> {
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
  random?: () => number;
}

export class UsageOutboxDispatcher {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private draining: Promise<void> | undefined;
  private readonly options: Required<UsageDispatcherOptions>;

  public constructor(
    private readonly outbox: UsageOutbox,
    private readonly sink: UsageSink,
    options: UsageDispatcherOptions = {},
  ) {
    this.options = {
      batchSize: options.batchSize ?? 25,
      pollIntervalMs: options.pollIntervalMs ?? 1000,
      maxAttempts: options.maxAttempts ?? 8,
      baseRetryMs: options.baseRetryMs ?? 250,
      maxRetryMs: options.maxRetryMs ?? 60_000,
      poisonRetryMs: options.poisonRetryMs ?? 86_400_000,
      random: options.random ?? Math.random,
    };
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  public async drain(timeoutMs = 30_000): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    const work = this.draining ?? Promise.resolve();
    await Promise.race([work, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
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
    try {
      await this.sink.send(row.payload);
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
    }
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.dispatchOnce().finally(() => this.schedule(this.options.pollIntervalMs));
    }, delay);
  }
}
