import type { PoolClient, QueryResultRow } from 'pg';
import type { BudgetConfigInput, UsageEvent } from '@du/contracts';
import type { Db } from '../src/db/db';
import { HttpError } from '../src/http/errors';
import { createBudgetReservationService } from '../src/modules/usage/budget-reservations';

const TENANT = 'tenant-a';
const API_KEY = 'key-a';
const PROFILE = 'profile-a';
const BUSINESS = 'document-core';
const OPERATION = '3f2a8c9e-1b4d-4a6c-8e2f-9d0c1b2a3f45';
const TASK = 'a1a2a3a4-a5a6-47a8-89aa-a1a2a3a4a5a6';
const NOW = new Date('2026-09-28T12:00:00.000Z');

interface MemoryReservation extends Record<string, unknown> {
  reservation_id: string;
  idempotency_key: string;
  scope_key: string;
  quota_scope: unknown;
  budget_config: unknown;
  period: string;
  window_start: Date;
  window_end: Date;
  request_hash: string;
  operation_id: string;
  task_id: string;
  invocation_id: string;
  attempt: number;
  reserved_tokens: string;
  reserved_cost_micro_usd: string;
  confidence: string;
  status: string;
  hard_cap_enabled: boolean;
  admission_evaluation: unknown;
  usage_event_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface MemoryUsage extends Record<string, unknown> {
  event_id: string;
  operation_id: string;
  task_id: string;
  payload: UsageEvent;
  budget_reservation_id: string | null;
  received_at: Date;
}

interface MemoryState {
  reservations: Map<string, MemoryReservation>;
  usage: Map<string, MemoryUsage>;
}

function result(rows: readonly Record<string, unknown>[]) {
  return { rows: [...rows], rowCount: rows.length };
}

class MemoryDb {
  private state: MemoryState = { reservations: new Map(), usage: new Map() };
  private tail: Promise<void> = Promise.resolve();

  readonly db = {
    pool: {},
    query: async (): Promise<never> => { throw new Error('unexpected non-transactional query'); },
    tx: async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
      const previous = this.tail;
      let release: () => void = () => undefined;
      this.tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      const transaction: MemoryState = {
        reservations: new Map([...this.state.reservations].map(([key, value]) => [key, structuredClone(value)])),
        usage: new Map([...this.state.usage].map(([key, value]) => [key, structuredClone(value)])),
      };
      try {
        const client = { query: (sql: string, params?: unknown[]) => this.query(transaction, sql, params ?? []) } as unknown as PoolClient;
        const value = await fn(client);
        this.state = transaction;
        return value;
      } finally {
        release();
      }
    },
    close: async (): Promise<void> => undefined,
  } as unknown as Db;

  private async query(state: MemoryState, sql: string, params: unknown[]): Promise<unknown> {
    const query = sql.replace(/\s+/g, ' ').trim();
    if (query.startsWith('SELECT pg_advisory_xact_lock')) return result([]);

    if (query.includes('FROM budget_reservations') && query.includes('idempotency_key = $2')) {
      const row = [...state.reservations.values()].find(
        (candidate) => candidate.scope_key === params[0] && candidate.idempotency_key === params[1],
      );
      return result(row ? [row] : []);
    }
    if (query.includes('FROM budget_reservations') && query.includes('reservation_id = $1')) {
      const row = state.reservations.get(String(params[0]));
      return result(row ? [row] : []);
    }
    if (query.includes('FROM operations o')) {
      const operationId = String(params[0]);
      const taskId = String(params[1]);
      if (operationId !== OPERATION || taskId !== TASK) return result([]);
      return result([{
        operation_id: OPERATION,
        task_id: TASK,
        tenant_id: TENANT,
        api_key_id: API_KEY,
        profile_id: PROFILE,
        business_id: BUSINESS,
      }]);
    }
    if (query.includes('FROM usage_events ue')) {
      const [tenantId, apiKeyId, profileId, businessId, fromValue, toValue] = params;
      const from = new Date(String(fromValue));
      const to = new Date(String(toValue));
      const matching = [...state.usage.values()].filter((event) => {
        if (tenantId !== TENANT || (apiKeyId !== null && apiKeyId !== API_KEY) ||
          (profileId !== null && profileId !== PROFILE) || (businessId !== null && businessId !== BUSINESS)) return false;
        if (event.budget_reservation_id) {
          const linked = state.reservations.get(event.budget_reservation_id);
          return linked !== undefined && linked.window_start.getTime() === from.getTime() && linked.window_end.getTime() === to.getTime();
        }
        return event.received_at >= from && event.received_at < to;
      }).map((event) => ({
        ...event,
        tenant_id: TENANT,
        api_key_id: API_KEY,
        profile_id: PROFILE,
        business_id: BUSINESS,
      }));
      return result(matching);
    }
    if (query.includes('FROM budget_reservations') && query.includes("status IN ('RESERVED', 'RUNNING', 'UNKNOWN')")) {
      const [scopeKey, fromValue, toValue] = params;
      const from = new Date(String(fromValue));
      const to = new Date(String(toValue));
      const held = [...state.reservations.values()].filter((reservation) =>
        reservation.scope_key === scopeKey &&
        reservation.window_start.getTime() === from.getTime() &&
        reservation.window_end.getTime() === to.getTime() &&
        ['RESERVED', 'RUNNING', 'UNKNOWN'].includes(reservation.status),
      );
      return result(held);
    }
    if (query.startsWith('INSERT INTO budget_reservations')) {
      const [id, tenantId, scopeKey, scopeJson, configJson, period, fromValue, toValue, idempotencyKey, requestHash,
        operationId, taskId, invocationId, attempt, tokens, cost, confidence, status, hardCapEnabled, evaluationJson] = params;
      const row: MemoryReservation = {
        reservation_id: String(id),
        tenant_id: String(tenantId),
        scope_key: String(scopeKey),
        quota_scope: JSON.parse(String(scopeJson)) as unknown,
        budget_config: JSON.parse(String(configJson)) as unknown,
        period: String(period),
        window_start: new Date(String(fromValue)),
        window_end: new Date(String(toValue)),
        idempotency_key: String(idempotencyKey),
        request_hash: String(requestHash),
        operation_id: String(operationId),
        task_id: String(taskId),
        invocation_id: String(invocationId),
        attempt: Number(attempt),
        reserved_tokens: String(tokens),
        reserved_cost_micro_usd: String(cost),
        confidence: String(confidence),
        status: String(status),
        hard_cap_enabled: Boolean(hardCapEnabled),
        admission_evaluation: JSON.parse(String(evaluationJson)) as unknown,
        usage_event_id: null,
        created_at: new Date(NOW),
        updated_at: new Date(NOW),
      };
      state.reservations.set(row.reservation_id, row);
      return result([row]);
    }
    if (query.startsWith('UPDATE budget_reservations') && query.includes('SET status = $2')) {
      const row = state.reservations.get(String(params[0]));
      if (!row) return result([]);
      row.status = String(params[1]);
      row.updated_at = new Date(NOW);
      return result([row]);
    }
    if (query.startsWith('INSERT INTO usage_events')) {
      const [eventId, operationId, taskId, payloadJson, reservationId] = params;
      if (state.usage.has(String(eventId))) return result([]);
      const row: MemoryUsage = {
        event_id: String(eventId),
        operation_id: String(operationId),
        task_id: String(taskId),
        payload: JSON.parse(String(payloadJson)) as UsageEvent,
        budget_reservation_id: String(reservationId),
        received_at: new Date(NOW),
      };
      state.usage.set(row.event_id, row);
      return result([{ event_id: row.event_id }]);
    }
    if (query.includes('SELECT payload, budget_reservation_id::text AS budget_reservation_id')) {
      const row = state.usage.get(String(params[0]));
      return result(row ? [{ payload: row.payload, budget_reservation_id: row.budget_reservation_id }] : []);
    }
    if (query.startsWith("UPDATE budget_reservations SET status = 'RECONCILED'")) {
      const row = state.reservations.get(String(params[0]));
      if (!row) return result([]);
      row.status = 'RECONCILED';
      row.usage_event_id = String(params[1]);
      row.updated_at = new Date(NOW);
      return result([row]);
    }
    throw new Error(`unhandled SQL in reservation test fixture: ${query}`);
  }

  reservationCount(): number { return this.state.reservations.size; }
  usageCount(): number { return this.state.usage.size; }
}

const BUDGET: BudgetConfigInput = {
  tenantId: TENANT,
  apiKeyId: API_KEY,
  profileId: PROFILE,
  businessId: BUSINESS,
  period: 'daily',
  tokenThreshold: 100,
  usdThresholdMicroUsd: 1_000_000,
  alertThresholdPercent: 80,
  policy: 'block-new-invocations',
  status: 'active',
};

function reserveRequest(idempotencyKey: string, tokens: number, overrides: Record<string, unknown> = {}) {
  return {
    budget: BUDGET,
    quotaScope: { tenantId: TENANT, apiKeyId: API_KEY, profileId: PROFILE, businessId: BUSINESS },
    operationId: OPERATION,
    taskId: TASK,
    invocationId: `inv-${idempotencyKey}`,
    attempt: 1,
    idempotencyKey,
    reserve: { tokens, costMicroUsd: 0 },
    confidence: 'upper-bound',
    ...overrides,
  };
}

function actualUsage(eventId: string, invocationId: string, inputTokens: number, costMicrousd: number): UsageEvent {
  return {
    eventId,
    invocationId,
    operationId: OPERATION,
    taskId: TASK,
    units: { inputTokens, outputTokens: 0 },
    costMicrousd,
    currency: 'USD',
    measurement: 'measured',
    occurredAt: NOW.toISOString(),
  };
}

function expectHttpError(promise: Promise<unknown>, code: string): Promise<void> {
  return expect(promise).rejects.toMatchObject({ code });
}

describe('COST-04 durable quota reservations', () => {
  test('serializes concurrent same-scope admissions and persists a blocked idempotent result', async () => {
    const memory = new MemoryDb();
    const service = createBudgetReservationService(memory.db, () => NOW);
    const [first, second] = await Promise.all([
      service.reserve(reserveRequest('reserve-1', 60)),
      service.reserve(reserveRequest('reserve-2', 60)),
    ]);
    expect(first).toMatchObject({ decision: 'ADMITTED', hardCapEnabled: true, reservation: { status: 'RESERVED' } });
    expect(second).toMatchObject({ decision: 'BLOCKED', hardCapEnabled: true, reservation: { status: 'BLOCKED' } });
    expect(memory.reservationCount()).toBe(2);
    const replay = await service.reserve(reserveRequest('reserve-2', 60));
    expect(replay).toStrictEqual(second);
    await expectHttpError(service.reserve(reserveRequest('reserve-2', 50)), 'BUDGET_RESERVATION_CONFLICT');
  });

  test.each(['RUNNING', 'UNKNOWN'] as const)('%s reservations remain held against concurrent calls', async (state) => {
    const memory = new MemoryDb();
    const service = createBudgetReservationService(memory.db, () => NOW);
    const first = await service.reserve(reserveRequest('reserve-held', 60));
    const transition = { reservationId: first.reservation.reservationId, quotaScope: first.reservation.quotaScope };
    if (state === 'RUNNING') {
      await service.markRunning(transition);
      await service.markUnknown(transition);
    } else {
      await service.markUnknown(transition);
    }
    const next = await service.reserve(reserveRequest('reserve-next', 50));
    expect(next.decision).toBe('BLOCKED');
    expect(first.reservation.status).toBe('RESERVED');
  });

  test('reconciliation is atomic, idempotent, and replaces the hold in the original quota window', async () => {
    const memory = new MemoryDb();
    const service = createBudgetReservationService(memory.db, () => NOW);
    const admission = await service.reserve(reserveRequest('reserve-reconcile', 90));
    await service.markRunning({ reservationId: admission.reservation.reservationId, quotaScope: admission.reservation.quotaScope });
    const input = {
      reservationId: admission.reservation.reservationId,
      quotaScope: admission.reservation.quotaScope,
      attempt: 1,
      usageEvent: actualUsage('event-actual', 'inv-reserve-reconcile', 70, 800),
    };
    const first = await service.reconcile(input);
    expect(first).toMatchObject({ duplicate: false, reservation: { status: 'RECONCILED', usageEventId: 'event-actual' } });
    expect(memory.usageCount()).toBe(1);
    const replay = await service.reconcile(input);
    expect(replay).toMatchObject({ duplicate: true, reservation: first.reservation });
    expect(memory.usageCount()).toBe(1);
    const next = await service.reserve(reserveRequest('reserve-after-actual', 31));
    expect(next.decision).toBe('BLOCKED');
    await expectHttpError(service.reconcile({
      ...input,
      usageEvent: actualUsage('event-other', 'inv-reserve-reconcile', 70, 800),
    }), 'BUDGET_RESERVATION_CONFLICT');
  });

  test('same-scope checks fence reservation and reconciliation from another budget', async () => {
    const memory = new MemoryDb();
    const service = createBudgetReservationService(memory.db, () => NOW);
    await expectHttpError(service.reserve(reserveRequest('bad-scope', 1, {
      quotaScope: { tenantId: TENANT, apiKeyId: 'foreign-key', profileId: PROFILE, businessId: BUSINESS },
    })), 'INVALID_SCHEMA');
    const admitted = await service.reserve(reserveRequest('good-scope', 1));
    await expectHttpError(service.reconcile({
      reservationId: admitted.reservation.reservationId,
      quotaScope: { tenantId: TENANT, apiKeyId: 'foreign-key', profileId: PROFILE, businessId: BUSINESS },
      attempt: 1,
      usageEvent: actualUsage('event-scope-mismatch', 'inv-good-scope', 1, 1),
    }), 'BUDGET_RESERVATION_CONFLICT');
  });

  test('hard cap fails closed unless estimates and current usage are trustworthy; alert-only may proceed softly', async () => {
    const memory = new MemoryDb();
    const service = createBudgetReservationService(memory.db, () => NOW);
    await expectHttpError(service.reserve(reserveRequest('unbounded', 1, { confidence: 'best-effort' })), 'BUDGET_RESERVATION_UNAVAILABLE');
    const soft = await service.reserve(reserveRequest('soft', 1, {
      budget: { ...BUDGET, policy: 'alert-only' },
      confidence: 'best-effort',
    }));
    expect(soft).toMatchObject({ decision: 'ADMITTED', hardCapEnabled: false });
  });

  test('only an unstarted hold with an explicit no-call proof can be released', async () => {
    const memory = new MemoryDb();
    const service = createBudgetReservationService(memory.db, () => NOW);
    const released = await service.reserve(reserveRequest('release-me', 80));
    await expectHttpError(service.releaseBeforeCall({
      reservationId: released.reservation.reservationId,
      quotaScope: released.reservation.quotaScope,
    }), 'INVALID_SCHEMA');
    const resultAfterRelease = await service.releaseBeforeCall({
      reservationId: released.reservation.reservationId,
      quotaScope: released.reservation.quotaScope,
      confirmedNotSent: true,
    });
    expect(resultAfterRelease.status).toBe('RELEASED');

    const running = await service.reserve(reserveRequest('cannot-release', 20));
    await service.markRunning({ reservationId: running.reservation.reservationId, quotaScope: running.reservation.quotaScope });
    await expectHttpError(service.releaseBeforeCall({
      reservationId: running.reservation.reservationId,
      quotaScope: running.reservation.quotaScope,
      confirmedNotSent: true,
    }), 'BUDGET_RESERVATION_CONFLICT');
  });

  test('reservation store failure never turns a hard cap into an unreserved provider call', async () => {
    const broken = {
      pool: {},
      query: async (): Promise<never> => { throw new Error('not used'); },
      tx: async (): Promise<never> => { throw new Error('database offline'); },
      close: async (): Promise<void> => undefined,
    } as unknown as Db;
    const service = createBudgetReservationService(broken, () => NOW);
    await expectHttpError(service.reserve(reserveRequest('db-down', 10)), 'BUDGET_RESERVATION_UNAVAILABLE');
  });
});
