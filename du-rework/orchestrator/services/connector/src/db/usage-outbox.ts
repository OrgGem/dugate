import type { SqlClient } from './sql';
import type { UsageEvent } from '../usage';

export interface UsageOutboxRow {
  eventId: string;
  invocationId: string;
  payload: UsageEvent;
  attempts: number;
  nextAttemptAt: string;
}

export interface UsageOutbox {
  append(event: UsageEvent): Promise<void>;
  claimBatch(limit: number, now?: string): Promise<UsageOutboxRow[]>;
  markDelivered(eventId: string): Promise<void>;
  defer(eventId: string, nextAttemptAt: string): Promise<void>;
}

export class PostgresUsageOutbox {
  public constructor(private readonly db: SqlClient) {}

  public async append(event: UsageEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO connector_usage_outbox (event_id, invocation_id, payload)
       VALUES ($1, $2, $3::jsonb) ON CONFLICT (event_id) DO NOTHING`,
      [event.eventId, event.invocationId, JSON.stringify(event)],
    );
  }

  public async claimBatch(limit: number, now = new Date().toISOString()): Promise<UsageOutboxRow[]> {
    return this.db.transaction(async (tx) => {
      const result = await tx.query<{
        event_id: string;
        invocation_id: string;
        payload: UsageEvent;
        attempts: number;
        next_attempt_at: string;
      }>(
        `SELECT event_id, invocation_id, payload, attempts, next_attempt_at
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
        nextAttemptAt: row.next_attempt_at,
      }));
    });
  }

  public async markDelivered(eventId: string): Promise<void> {
    await this.db.query(
      'UPDATE connector_usage_outbox SET delivered_at = now() WHERE event_id = $1',
      [eventId],
    );
  }

  public async defer(eventId: string, nextAttemptAt: string): Promise<void> {
    await this.db.query(
      'UPDATE connector_usage_outbox SET next_attempt_at = $2::timestamptz WHERE event_id = $1 AND delivered_at IS NULL',
      [eventId, nextAttemptAt],
    );
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

  public async markDelivered(eventId: string): Promise<void> {
    this.events.delete(eventId);
  }

  public async defer(eventId: string, nextAttemptAt: string): Promise<void> {
    const event = this.events.get(eventId);
    if (event) this.events.set(eventId, { ...event, nextAttemptAt });
  }

  public size(): number {
    return this.events.size;
  }
}
