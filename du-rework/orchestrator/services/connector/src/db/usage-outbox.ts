import type { SqlClient } from './sql';
import { toContractUsageEvent, type UsageEvent } from '../usage';
import { canonicalize } from '@du/contracts';
import { ConnectorError } from '../errors';

export interface UsageDeliveryEffectControl {
  claimUsageBatch(limit: number, now?: string): Promise<Array<{
    eventId: string; invocationId: string; payload: unknown; attempts: number;
    failedAttempts: number; createdAt: string; nextAttemptAt: string; deliveryToken: string;
  }>>;
  activateUsage(eventId: string, claimToken: string): Promise<boolean>;
  settleUsage(eventId: string, claimToken: string): Promise<boolean>;
  deferUsage(eventId: string, claimToken: string, nextAttemptAt: string): Promise<boolean>;
  markUsageUnknown(eventId: string, claimToken: string, reasonCode?: string): Promise<void>;
}

export interface UsageOutboxRow {
  eventId: string;
  invocationId: string;
  payload: UsageEvent;
  attempts: number;
  failedAttempts?: number;
  createdAt?: string;
  nextAttemptAt: string;
  /** Opaque durable claim token. Never serialize or log it. */
  deliveryToken?: string;
}

export interface UsageOutbox {
  append(event: UsageEvent): Promise<void>;
  claimBatch(limit: number, now?: string): Promise<UsageOutboxRow[]>;
  markDelivered(eventId: string, deliveryToken?: string): Promise<void>;
  defer(eventId: string, nextAttemptAt: string, failureCode?: 'USAGE_SINK_DELIVERY_FAILED', deliveryToken?: string): Promise<void>;
  activateDelivery?(eventId: string, deliveryToken: string): Promise<boolean>;
  markUnknownDelivery?(eventId: string, deliveryToken: string, reasonCode?: string): Promise<void>;
}

export class PostgresUsageOutbox {
  public constructor(
    private readonly db: SqlClient,
    private readonly effectControl?: UsageDeliveryEffectControl,
  ) {}

  public async append(event: UsageEvent): Promise<void> {
    toContractUsageEvent(event);
    // The outbox contains billing metadata only, never arbitrary provider fields.
    const usage = event.usage;
    event = { eventId: event.eventId, invocationId: event.invocationId, operationId: event.operationId, taskId: event.taskId, createdAt: event.createdAt,
      usage: usage && {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        pages: usage.pages,
        costMicrousd: usage.costMicrousd,
        costStatus: usage.costStatus,
        costProvenance: usage.costProvenance,
        providerReportedCost: usage.providerReportedCost,
        measurement: usage.measurement,
        provider: usage.provider,
        model: usage.model,
      } };
    const inserted = await this.db.query(
      `INSERT INTO connector_usage_outbox (event_id, invocation_id, payload)
       VALUES ($1, $2, $3::jsonb) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [event.eventId, event.invocationId, JSON.stringify(event)],
    );
    if (!inserted.rows.length) {
      const prior = await this.db.query<{ payload: UsageEvent }>('SELECT payload FROM connector_usage_outbox WHERE event_id=$1', [event.eventId]);
      if (prior.rows[0] && usageIdentity(prior.rows[0].payload) !== usageIdentity(event)) {
        throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Usage event identity conflicts with its recorded settlement.');
      }
    }
  }

  public async claimBatch(limit: number, now = new Date().toISOString()): Promise<UsageOutboxRow[]> {
    if (this.effectControl) {
      return (await this.effectControl.claimUsageBatch(limit, now)).map((row) => ({
        ...row,
        payload: row.payload as UsageEvent,
      }));
    }
    return this.db.transaction(async (tx) => {
      const result = await tx.query<{
        event_id: string;
        invocation_id: string;
        payload: UsageEvent;
        attempts: number;
        next_attempt_at: string;
        failed_attempts: number;
        created_at: Date | string;
      }>(
        `SELECT event_id, invocation_id, payload, attempts, failed_attempts, created_at, next_attempt_at
         FROM connector_usage_outbox
         WHERE delivered_at IS NULL AND next_attempt_at <= $1
         ORDER BY next_attempt_at
         FOR UPDATE SKIP LOCKED LIMIT $2`,
        [now, limit],
      );
      if (result.rows.length > 0) {
        await tx.query(
          `UPDATE connector_usage_outbox SET attempts = attempts + 1
           WHERE event_id = ANY($1::text[])`,
          [result.rows.map((row) => row.event_id)],
        );
      }
      return result.rows.map((row) => ({
        eventId: row.event_id,
        invocationId: row.invocation_id,
        payload: row.payload,
        attempts: row.attempts + 1,
        failedAttempts: row.failed_attempts,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
        nextAttemptAt: row.next_attempt_at,
      }));
    });
  }

  public async markDelivered(eventId: string, deliveryToken?: string): Promise<void> {
    if (deliveryToken !== undefined) {
      if (!this.effectControl || !(await this.effectControl.settleUsage(eventId, deliveryToken))) {
        throw new ConnectorError('INVOCATION_UNKNOWN', 'Usage delivery claim could not be settled.');
      }
      return;
    }
    await this.db.query(
      'UPDATE connector_usage_outbox SET delivered_at = now() WHERE event_id = $1',
      [eventId],
    );
  }

  public async defer(
    eventId: string,
    nextAttemptAt: string,
    failureCode: 'USAGE_SINK_DELIVERY_FAILED' = 'USAGE_SINK_DELIVERY_FAILED',
    deliveryToken?: string,
  ): Promise<void> {
    if (deliveryToken !== undefined) {
      if (!this.effectControl || !(await this.effectControl.deferUsage(eventId, deliveryToken, nextAttemptAt))) {
        throw new ConnectorError('INVOCATION_UNKNOWN', 'Usage delivery cannot be retried without pre-send proof.');
      }
      return;
    }
    await this.db.query(
      `UPDATE connector_usage_outbox
       SET next_attempt_at = $2::timestamptz, failed_attempts = failed_attempts + 1, last_failure_code = $3
       WHERE event_id = $1 AND delivered_at IS NULL`,
      [eventId, nextAttemptAt, failureCode],
    );
  }

  public async activateDelivery(eventId: string, deliveryToken: string): Promise<boolean> {
    if (!this.effectControl) return false;
    return this.effectControl.activateUsage(eventId, deliveryToken);
  }

  public async markUnknownDelivery(eventId: string, deliveryToken: string, reasonCode?: string): Promise<void> {
    if (!this.effectControl) throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Usage effect control is not configured.');
    await this.effectControl.markUsageUnknown(eventId, deliveryToken, reasonCode);
  }
}

export class InMemoryUsageOutbox {
  private readonly events = new Map<string, UsageOutboxRow>();

  public async append(event: UsageEvent): Promise<void> {
    if (!this.events.has(event.eventId)) {
      this.events.set(event.eventId, {
        eventId: event.eventId,
        invocationId: event.invocationId,
        payload: event,
        attempts: 0,
        failedAttempts: 0,
        createdAt: new Date().toISOString(),
        nextAttemptAt: new Date(0).toISOString(),
      });
    }
  }

  public async claimBatch(limit: number, now = new Date().toISOString()): Promise<UsageOutboxRow[]> {
    return [...this.events.values()]
      .filter((event) => event.nextAttemptAt <= now)
      .slice(0, limit)
      .map((event) => {
        const claimed = { ...event, attempts: event.attempts + 1 };
        this.events.set(event.eventId, claimed);
        return claimed;
      });
  }

  public async markDelivered(eventId: string, _deliveryToken?: string): Promise<void> {
    this.events.delete(eventId);
  }

  public async defer(eventId: string, nextAttemptAt: string, _failureCode?: 'USAGE_SINK_DELIVERY_FAILED', _deliveryToken?: string): Promise<void> {
    const event = this.events.get(eventId);
    if (event) this.events.set(eventId, { ...event, failedAttempts: (event.failedAttempts ?? 0) + 1, nextAttemptAt });
  }

  public size(): number {
    return this.events.size;
  }
}

function usageIdentity(event: UsageEvent): string {
  const { occurredAt: _occurredAt, ...identity } = toContractUsageEvent(event);
  return canonicalize(identity);
}
