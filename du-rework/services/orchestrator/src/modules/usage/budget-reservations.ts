import { createHash, randomUUID } from 'node:crypto';
import {
  BudgetConfigSchema,
  BudgetReservationAdmissionSchema,
  BudgetReservationReconcileSchema,
  BudgetReservationRequestSchema,
  BudgetReservationSchema,
  BudgetReservationStatusSchema,
  BudgetReservationTransitionSchema,
  BudgetQuotaScopeSchema,
  UsageEventSchema,
  UsageLedgerEventSchema,
  UsageSummarySchema,
  budgetQuotaScopeKey,
  budgetReservationCountsAsHeld,
  canonicalize,
  evaluateBudgetStatus,
  isBudgetReservationTrusted,
  quotaScopeForBudget,
  resolveBudgetQuotaWindow,
} from '@du/contracts';
import type {
  BudgetReservation,
  BudgetReservationAdmission,
  BudgetReservationReconcile,
  BudgetReservationRequest,
  BudgetReservationStatus,
  BudgetReservationTransition,
  BudgetQuotaScope,
  UsageEvent,
} from '@du/contracts';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Db } from '../../db/db';
import { HttpError, zodIssuesToProblem } from '../../http/errors';

export interface BudgetReservationService {
  /** Persist a quota hold before any provider call is made. */
  reserve(input: unknown): Promise<BudgetReservationAdmission>;
  markRunning(input: unknown): Promise<BudgetReservation>;
  markUnknown(input: unknown): Promise<BudgetReservation>;
  /** Only RESERVED holds can be released, and only with an explicit no-call proof. */
  releaseBeforeCall(input: unknown): Promise<BudgetReservation>;
  /** Store actual usage and close the hold atomically; a replay returns the same row. */
  reconcile(input: unknown): Promise<{ reservation: BudgetReservation; duplicate: boolean }>;
}

interface OperationScopeRow extends QueryResultRow {
  operation_id: string;
  task_id: string;
  tenant_id: string;
  api_key_id: string | null;
  profile_id: string | null;
  business_id: string;
}

interface BudgetReservationDbRow extends QueryResultRow {
  reservation_id: string;
  idempotency_key: string;
  scope_key: string;
  quota_scope: unknown;
  budget_config: unknown;
  period: string;
  window_start: Date | string;
  window_end: Date | string;
  request_hash: string;
  operation_id: string;
  task_id: string;
  invocation_id: string;
  attempt: number;
  reserved_tokens: string | number;
  reserved_cost_micro_usd: string | number;
  confidence: string;
  status: string;
  hard_cap_enabled: boolean;
  admission_evaluation: unknown;
  usage_event_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface UsageDbRow extends QueryResultRow {
  event_id: string;
  operation_id: string;
  task_id: string;
  payload: unknown;
  tenant_id: string;
  api_key_id: string | null;
  profile_id: string | null;
  business_id: string;
}

interface ActiveReservationDbRow extends QueryResultRow {
  reserved_tokens: string | number;
  reserved_cost_micro_usd: string | number;
  status: string;
  confidence: string;
}

const RESERVATION_COLUMNS = `
  reservation_id::text AS reservation_id,
  idempotency_key,
  scope_key,
  quota_scope,
  budget_config,
  period,
  window_start,
  window_end,
  request_hash,
  operation_id::text AS operation_id,
  task_id::text AS task_id,
  invocation_id,
  attempt,
  reserved_tokens::text AS reserved_tokens,
  reserved_cost_micro_usd::text AS reserved_cost_micro_usd,
  confidence,
  status,
  hard_cap_enabled,
  admission_evaluation,
  usage_event_id,
  created_at,
  updated_at`;

function safeFailure(): HttpError {
  return new HttpError(503, 'BUDGET_RESERVATION_UNAVAILABLE', 'quota reservation could not be completed safely');
}

function conflict(message: string): HttpError {
  return new HttpError(409, 'BUDGET_RESERVATION_CONFLICT', message);
}

function parseRequest(input: unknown): BudgetReservationRequest {
  const parsed = BudgetReservationRequestSchema.safeParse(input);
  if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
  return parsed.data;
}

function parseScope(input: unknown): BudgetQuotaScope {
  const parsed = BudgetQuotaScopeSchema.safeParse(input);
  if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
  return parsed.data;
}

function requestDigest(request: BudgetReservationRequest): string {
  const comparable = {
    budget: request.budget,
    quotaScope: request.quotaScope,
    operationId: request.operationId,
    taskId: request.taskId,
    invocationId: request.invocationId,
    attempt: request.attempt,
    idempotencyKey: request.idempotencyKey,
    reserve: request.reserve,
    confidence: request.confidence,
  };
  return createHash('sha256').update(canonicalize(comparable)).digest('hex');
}

function timestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw safeFailure();
  return date.toISOString();
}

function safeDbInteger(value: string | number, field: string): number {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new HttpError(503, 'BUDGET_RESERVATION_UNAVAILABLE', `quota reservation contains an invalid ${field}`);
  }
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HttpError(503, 'BUDGET_RESERVATION_UNAVAILABLE', `quota reservation ${field} is outside the supported range`);
  }
  return Number(parsed);
}

function addSafe(left: bigint, right: number, field: string): bigint {
  const next = left + BigInt(right);
  if (next > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HttpError(503, 'BUDGET_RESERVATION_UNAVAILABLE', `quota ${field} exceeds the supported range`);
  }
  return next;
}

function summary(tokens: bigint, costMicroUsd: bigint, eventCount: number) {
  return UsageSummarySchema.parse({
    inputTokens: Number(tokens),
    outputTokens: 0,
    totalTokens: Number(tokens),
    totalCostMicrousd: Number(costMicroUsd),
    eventCount,
  });
}

function mapReservation(row: BudgetReservationDbRow): BudgetReservation {
  const status = BudgetReservationStatusSchema.safeParse(row.status);
  if (!status.success) throw safeFailure();
  const budget = BudgetConfigSchema.parse(row.budget_config);
  const parsed = BudgetReservationSchema.safeParse({
    reservationId: row.reservation_id,
    idempotencyKey: row.idempotency_key,
    quotaScope: row.quota_scope,
    window: { period: row.period, from: timestamp(row.window_start), to: timestamp(row.window_end) },
    operationId: row.operation_id,
    taskId: row.task_id,
    invocationId: row.invocation_id,
    attempt: row.attempt,
    reserve: {
      tokens: safeDbInteger(row.reserved_tokens, 'reserved tokens'),
      costMicroUsd: safeDbInteger(row.reserved_cost_micro_usd, 'reserved cost'),
    },
    confidence: row.confidence,
    status: status.data,
    ...(row.usage_event_id !== null ? { usageEventId: row.usage_event_id } : {}),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
  if (!parsed.success || budget.tenantId !== parsed.data.quotaScope.tenantId) throw safeFailure();
  return parsed.data;
}

async function acquireScopeLock(client: PoolClient, scopeKey: string, from: string, to: string): Promise<void> {
  const lockKey = `${scopeKey}\u0000${from}\u0000${to}`;
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);
}

async function findOperationScope(
  client: PoolClient,
  operationId: string,
  taskId: string,
): Promise<OperationScopeRow> {
  const result = await client.query<OperationScopeRow>(
    `SELECT o.id::text AS operation_id,
            t.id::text AS task_id,
            o.tenant_id::text AS tenant_id,
            o.api_key_id::text AS api_key_id,
            o.profile_id::text AS profile_id,
            o.business_id
     FROM operations o
     JOIN tasks t ON t.operation_id = o.id AND t.id = $2
     WHERE o.id = $1`,
    [operationId, taskId],
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'budget invocation operation or task was not found');
  return row;
}

function assertOperationInScope(operation: OperationScopeRow, scope: BudgetQuotaScope): void {
  if (operation.tenant_id !== scope.tenantId) {
    throw new HttpError(403, 'PERMISSION_DENIED', 'budget must belong to the operation tenant');
  }
  if (
    (scope.apiKeyId !== undefined && operation.api_key_id !== scope.apiKeyId) ||
    (scope.profileId !== undefined && operation.profile_id !== scope.profileId) ||
    (scope.businessId !== undefined && operation.business_id !== scope.businessId)
  ) {
    throw new HttpError(422, 'BUDGET_SCOPE_MISMATCH', 'operation does not belong to the configured budget scope');
  }
}

function usageAmounts(row: UsageDbRow): { tokens: number; costMicroUsd: number } {
  const checked = (inputTokens: number, outputTokens: number, costMicroUsd: number) => {
    const tokens = inputTokens + outputTokens;
    if (
      !Number.isSafeInteger(inputTokens) || inputTokens < 0 ||
      !Number.isSafeInteger(outputTokens) || outputTokens < 0 ||
      !Number.isSafeInteger(tokens) || tokens < 0 ||
      !Number.isSafeInteger(costMicroUsd) || costMicroUsd < 0
    ) throw safeFailure();
    return { tokens, costMicroUsd };
  };
  const wire = UsageEventSchema.safeParse(row.payload);
  if (wire.success) {
    if (
      wire.data.eventId !== row.event_id || wire.data.operationId !== row.operation_id || wire.data.taskId !== row.task_id
    ) throw safeFailure();
    return checked(wire.data.units.inputTokens, wire.data.units.outputTokens, wire.data.costMicrousd);
  }
  const ledger = UsageLedgerEventSchema.safeParse(row.payload);
  if (ledger.success) {
    if (
      ledger.data.eventId !== row.event_id || ledger.data.operationId !== row.operation_id || ledger.data.taskId !== row.task_id ||
      ledger.data.tenantId !== row.tenant_id
    ) throw safeFailure();
    return checked(ledger.data.units.inputTokens, ledger.data.units.outputTokens, ledger.data.costMicrousd);
  }
  throw safeFailure();
}

async function readCommittedUsage(
  client: PoolClient,
  scope: BudgetQuotaScope,
  from: string,
  to: string,
): Promise<{ total: ReturnType<typeof summary>; validated: boolean }> {
  const rows = await client.query<UsageDbRow>(
    `SELECT ue.event_id,
            ue.operation_id::text AS operation_id,
            ue.task_id::text AS task_id,
            ue.payload,
            o.tenant_id::text AS tenant_id,
            o.api_key_id::text AS api_key_id,
            o.profile_id::text AS profile_id,
            o.business_id
     FROM usage_events ue
     JOIN operations o ON o.id = ue.operation_id
     WHERE o.tenant_id::text = $1
       AND ($2::text IS NULL OR o.api_key_id::text = $2)
       AND ($3::text IS NULL OR o.profile_id::text = $3)
       AND ($4::text IS NULL OR o.business_id = $4)
       AND (
         (ue.budget_reservation_id IS NULL AND ue.received_at >= $5 AND ue.received_at < $6)
         OR EXISTS (
           SELECT 1 FROM budget_reservations br
           WHERE br.reservation_id = ue.budget_reservation_id
             AND br.window_start = $5 AND br.window_end = $6
         )
       )`,
    [scope.tenantId, scope.apiKeyId ?? null, scope.profileId ?? null, scope.businessId ?? null, from, to],
  );
  let tokens = 0n;
  let cost = 0n;
  for (const row of rows.rows) {
    if (
      row.tenant_id !== scope.tenantId ||
      (scope.apiKeyId !== undefined && row.api_key_id !== scope.apiKeyId) ||
      (scope.profileId !== undefined && row.profile_id !== scope.profileId) ||
      (scope.businessId !== undefined && row.business_id !== scope.businessId)
    ) throw safeFailure();
    const amount = usageAmounts(row);
    tokens = addSafe(tokens, amount.tokens, 'tokens');
    cost = addSafe(cost, amount.costMicroUsd, 'cost');
  }
  return { total: summary(tokens, cost, rows.rows.length), validated: true };
}

async function readHeldReservations(
  client: PoolClient,
  scopeKey: string,
  from: string,
  to: string,
): Promise<{ total: ReturnType<typeof summary>; bounded: boolean }> {
  const rows = await client.query<ActiveReservationDbRow>(
    `SELECT reserved_tokens::text AS reserved_tokens,
            reserved_cost_micro_usd::text AS reserved_cost_micro_usd,
            status,
            confidence
     FROM budget_reservations
     WHERE scope_key = $1
       AND window_start = $2
       AND window_end = $3
       AND status IN ('RESERVED', 'RUNNING', 'UNKNOWN')
     ORDER BY reservation_id
     FOR UPDATE`,
    [scopeKey, from, to],
  );
  let tokens = 0n;
  let cost = 0n;
  let held = 0;
  let bounded = true;
  for (const row of rows.rows) {
    const status = BudgetReservationStatusSchema.safeParse(row.status);
    if (!status.success || !budgetReservationCountsAsHeld(status.data)) throw safeFailure();
    tokens = addSafe(tokens, safeDbInteger(row.reserved_tokens, 'reserved tokens'), 'tokens');
    cost = addSafe(cost, safeDbInteger(row.reserved_cost_micro_usd, 'reserved cost'), 'cost');
    held += 1;
    if (row.confidence !== 'upper-bound') bounded = false;
  }
  return { total: summary(tokens, cost, held), bounded };
}

function parseReservationQueryResult(row: BudgetReservationDbRow | undefined): BudgetReservationDbRow {
  if (!row) throw safeFailure();
  return row;
}

function safeAdmittedResult(
  decision: 'ADMITTED' | 'BLOCKED',
  hardCapEnabled: boolean,
  evaluation: unknown,
  reservation: BudgetReservation,
): BudgetReservationAdmission {
  const parsed = BudgetReservationAdmissionSchema.safeParse({ decision, hardCapEnabled, evaluation, reservation });
  if (!parsed.success) throw safeFailure();
  return parsed.data;
}

async function runTx<T>(db: Db, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  try {
    return await db.tx(fn);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw safeFailure();
  }
}

export function createBudgetReservationService(db: Db, clock: () => Date = () => new Date()): BudgetReservationService {
  async function transition(input: unknown, target: BudgetReservationTransition['target']): Promise<BudgetReservation> {
    const parsed = BudgetReservationTransitionSchema.safeParse({
      ...(typeof input === 'object' && input !== null ? input : {}),
      target,
    });
    if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
    const request: BudgetReservationTransition = parsed.data;
    return runTx(db, async (client) => {
      const initial = await client.query<BudgetReservationDbRow>(
        `SELECT ${RESERVATION_COLUMNS}
         FROM budget_reservations
         WHERE reservation_id = $1`,
        [request.reservationId],
      );
      const initialRow = initial.rows[0];
      if (!initialRow) throw new HttpError(404, 'NOT_FOUND', 'budget reservation was not found');
      const initialReservation = mapReservation(initialRow);
      if (budgetQuotaScopeKey(request.quotaScope) !== budgetQuotaScopeKey(initialReservation.quotaScope)) {
        throw conflict('reservation scope does not match the original quota scope');
      }
      await acquireScopeLock(client, initialRow.scope_key, initialReservation.window.from, initialReservation.window.to);
      const selected = await client.query<BudgetReservationDbRow>(
        `SELECT ${RESERVATION_COLUMNS}
         FROM budget_reservations
         WHERE reservation_id = $1
         FOR UPDATE`,
        [request.reservationId],
      );
      const row = selected.rows[0];
      if (!row) throw new HttpError(404, 'NOT_FOUND', 'budget reservation was not found');
      const reservation = mapReservation(row);
      const current = reservation.status;
      let next: BudgetReservationStatus = current;
      if (target === 'RUNNING') {
        if (current === 'RESERVED') next = 'RUNNING';
        else if (current !== 'RUNNING') throw conflict('only a reserved provider call may enter RUNNING');
      } else if (target === 'UNKNOWN') {
        if (current === 'RESERVED' || current === 'RUNNING') next = 'UNKNOWN';
        else if (current !== 'UNKNOWN') throw conflict('only an unresolved provider call may enter UNKNOWN');
      } else {
        if (current === 'RESERVED') next = 'RELEASED';
        else if (current !== 'RELEASED') throw conflict('a running or UNKNOWN provider call must stay reserved until reconciliation');
      }
      if (next === current) return reservation;
      const updated = await client.query<BudgetReservationDbRow>(
        `UPDATE budget_reservations
         SET status = $2, updated_at = now()
         WHERE reservation_id = $1
         RETURNING ${RESERVATION_COLUMNS}`,
        [request.reservationId, next],
      );
      return mapReservation(parseReservationQueryResult(updated.rows[0]));
    });
  }

  return {
    async reserve(input) {
      const request = parseRequest(input);
      const scope = quotaScopeForBudget(request.budget);
      const scopeKey = budgetQuotaScopeKey(scope);
      const window = resolveBudgetQuotaWindow(request.budget.period, clock());
      const digest = requestDigest(request);
      return runTx(db, async (client) => {
        await acquireScopeLock(client, scopeKey, window.from, window.to);
        const existingResult = await client.query<BudgetReservationDbRow>(
          `SELECT ${RESERVATION_COLUMNS}
           FROM budget_reservations
           WHERE scope_key = $1 AND idempotency_key = $2
           FOR UPDATE`,
          [scopeKey, request.idempotencyKey],
        );
        const existing = existingResult.rows[0];
        if (existing) {
          if (existing.request_hash !== digest) throw conflict('idempotency key was already used for a different reservation');
          const reservation = mapReservation(existing);
          BudgetConfigSchema.parse(existing.budget_config);
          const evaluation = existing.admission_evaluation;
          return safeAdmittedResult(
            reservation.status === 'BLOCKED' ? 'BLOCKED' : 'ADMITTED',
            existing.hard_cap_enabled,
            evaluation,
            reservation,
          );
        }

        const operation = await findOperationScope(client, request.operationId, request.taskId);
        assertOperationInScope(operation, scope);
        const usage = await readCommittedUsage(client, scope, window.from, window.to);
        const held = await readHeldReservations(client, scopeKey, window.from, window.to);
        const boundedReservation = request.confidence === 'upper-bound' && held.bounded;
        const hardCapRequested = request.budget.status === 'active' && request.budget.policy === 'block-new-invocations';
        const trust = {
          durableAtomicStore: true,
          sharedQuotaScope: true,
          validatedUsageLedger: usage.validated,
          boundedReservation,
        };
        const hardCapEnabled = hardCapRequested && isBudgetReservationTrusted(trust);
        if (hardCapRequested && !hardCapEnabled) throw safeFailure();

        const reservedWithRequest = summary(
          BigInt(held.total.totalTokens) + BigInt(request.reserve.tokens),
          BigInt(held.total.totalCostMicrousd) + BigInt(request.reserve.costMicroUsd),
          held.total.eventCount + 1,
        );
        const evaluation = evaluateBudgetStatus(request.budget, usage.total, reservedWithRequest);
        const decision = evaluation.action === 'BLOCK' ? 'BLOCKED' : 'ADMITTED';
        const reservationId = randomUUID();
        const status: BudgetReservationStatus = decision === 'BLOCKED' ? 'BLOCKED' : 'RESERVED';
        const inserted = await client.query<BudgetReservationDbRow>(
          `INSERT INTO budget_reservations (
             reservation_id, tenant_id, scope_key, quota_scope, budget_config, period,
             window_start, window_end, idempotency_key, request_hash,
             operation_id, task_id, invocation_id, attempt,
             reserved_tokens, reserved_cost_micro_usd, confidence, status,
             hard_cap_enabled, admission_evaluation
           ) VALUES (
             $1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,
             $11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb
           )
           RETURNING ${RESERVATION_COLUMNS}`,
          [
            reservationId,
            scope.tenantId,
            scopeKey,
            JSON.stringify(scope),
            JSON.stringify(request.budget),
            window.period,
            window.from,
            window.to,
            request.idempotencyKey,
            digest,
            request.operationId,
            request.taskId,
            request.invocationId,
            request.attempt,
            String(request.reserve.tokens),
            String(request.reserve.costMicroUsd),
            request.confidence,
            status,
            hardCapEnabled,
            JSON.stringify(evaluation),
          ],
        );
        const reservation = mapReservation(parseReservationQueryResult(inserted.rows[0]));
        return safeAdmittedResult(decision, hardCapEnabled, evaluation, reservation);
      });
    },
    markRunning(input) {
      return transition(input, 'RUNNING');
    },
    markUnknown(input) {
      return transition(input, 'UNKNOWN');
    },
    releaseBeforeCall(input) {
      return transition(input, 'RELEASED');
    },
    async reconcile(input) {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw zodIssuesToProblem([{ path: [], message: 'request must be an object' }]);
      }
      const raw = input as Record<string, unknown>;
      const eventResult = UsageEventSchema.safeParse(raw['usageEvent']);
      if (!eventResult.success) throw zodIssuesToProblem(eventResult.error.issues);
      const event: UsageEvent = eventResult.data;
      const scope = parseScope(raw['quotaScope']);
      const attempt = raw['attempt'];
      const command: BudgetReservationReconcile = (() => {
        const parsed = BudgetReservationReconcileSchema.safeParse({
          reservationId: raw['reservationId'],
          quotaScope: scope,
          operationId: event.operationId,
          taskId: event.taskId,
          invocationId: event.invocationId,
          attempt,
          eventId: event.eventId,
          actual: {
            tokens: event.units.inputTokens + event.units.outputTokens,
            costMicroUsd: event.costMicrousd,
          },
        });
        if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
        return parsed.data;
      })();
      return runTx(db, async (client) => {
        const initial = await client.query<BudgetReservationDbRow>(
          `SELECT ${RESERVATION_COLUMNS}
           FROM budget_reservations
           WHERE reservation_id = $1`,
          [command.reservationId],
        );
        const initialRow = initial.rows[0];
        if (!initialRow) throw new HttpError(404, 'NOT_FOUND', 'budget reservation was not found');
        const initialReservation = mapReservation(initialRow);
        const storedScope = budgetQuotaScopeKey(initialReservation.quotaScope);
        if (
          storedScope !== budgetQuotaScopeKey(command.quotaScope) ||
          initialReservation.operationId !== command.operationId ||
          initialReservation.taskId !== command.taskId ||
          initialReservation.invocationId !== command.invocationId ||
          initialReservation.attempt !== command.attempt
        ) throw conflict('actual usage does not match the reserved invocation and quota scope');
        await acquireScopeLock(client, initialRow.scope_key, initialReservation.window.from, initialReservation.window.to);
        const selected = await client.query<BudgetReservationDbRow>(
          `SELECT ${RESERVATION_COLUMNS}
           FROM budget_reservations
           WHERE reservation_id = $1
           FOR UPDATE`,
          [command.reservationId],
        );
        const row = selected.rows[0];
        if (!row) throw new HttpError(404, 'NOT_FOUND', 'budget reservation was not found');
        const reservation = mapReservation(row);
        const operation = await findOperationScope(client, command.operationId, command.taskId);
        assertOperationInScope(operation, reservation.quotaScope);
        if (reservation.status === 'RECONCILED') {
          if (reservation.usageEventId !== command.eventId) throw conflict('reservation was reconciled with a different usage event');
          const existing = await client.query<{ payload: UsageEvent; budget_reservation_id: string | null } & QueryResultRow>(
            `SELECT payload, budget_reservation_id::text AS budget_reservation_id
             FROM usage_events WHERE event_id = $1`,
            [command.eventId],
          );
          const payload = existing.rows[0]?.payload;
          if (
            !payload || canonicalize(payload) !== canonicalize(event) ||
            existing.rows[0]?.budget_reservation_id !== command.reservationId
          ) throw conflict('reconciliation replay does not match the committed usage event');
          return { reservation, duplicate: true };
        }
        if (reservation.status === 'RELEASED' || reservation.status === 'BLOCKED') {
          throw conflict('a released or blocked reservation cannot be reconciled');
        }

        const inserted = await client.query(
          `INSERT INTO usage_events (event_id, operation_id, task_id, payload, budget_reservation_id)
           VALUES ($1,$2,$3,$4::jsonb,$5)
           ON CONFLICT (event_id) DO NOTHING
           RETURNING event_id`,
          [command.eventId, command.operationId, command.taskId, JSON.stringify(event), command.reservationId],
        );
        if (!inserted.rowCount) {
          const existing = await client.query<{ payload: UsageEvent; budget_reservation_id: string | null } & QueryResultRow>(
            `SELECT payload, budget_reservation_id::text AS budget_reservation_id
             FROM usage_events WHERE event_id = $1`,
            [command.eventId],
          );
          const existingRow = existing.rows[0];
          if (
            !existingRow || canonicalize(existingRow.payload) !== canonicalize(event) ||
            existingRow.budget_reservation_id !== command.reservationId
          ) throw conflict('usage event ID is already linked to different data or reservation');
        }
        const updated = await client.query<BudgetReservationDbRow>(
          `UPDATE budget_reservations
           SET status = 'RECONCILED', usage_event_id = $2, updated_at = now()
           WHERE reservation_id = $1
           RETURNING ${RESERVATION_COLUMNS}`,
          [command.reservationId, command.eventId],
        );
        return {
          reservation: mapReservation(parseReservationQueryResult(updated.rows[0])),
          duplicate: !inserted.rowCount,
        };
      });
    },
  };
}
