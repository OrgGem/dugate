import { createHash } from 'node:crypto';
import {
  UsageIngestBatchSchema,
  aggregateUsageEvents,
  calculateOperationCost,
  canonicalize,
  resolvePricingTier,
  UsageLedgerEventSchema,
  UsageSummarySchema,
  aggregateUsageGroups,
  UsageEventDrilldownCursorSchema,
  UsageEventDrilldownQuerySchema,
  UsageEventExportPageSchema,
  UsageEventSchema,
  ProviderReportedCostSchema,
  USAGE_ATTRIBUTION_ID_PATTERN,
} from '@du/contracts';
import type {
  BudgetConfigInput,
  BudgetEvaluation,
  ModelPricingTier,
  UsageAggregateDimension,
  UsageAggregateFilterInput,
  UsageLedgerEvent,
  UsageSummary as UsageSummaryTotals,
  UsageAggregation,
  UsageEventDrilldownQueryInput,
  UsageEventExportPage,
  ProviderReportedCost,
} from '@du/contracts';
import type { Usage, UsageEvent, UsageIngestAck } from '@du/contracts';
import type { Db } from '../../db/db';
import { HttpError, zodIssuesToProblem } from '../../http/errors';
import { z } from 'zod';
import { validateBudgetEvaluation } from './budget-evaluation-validator';
import { createBudgetReservationService } from './budget-reservations';
import type { BudgetReservationService } from './budget-reservations';
import { appendLocalUserUsageFence, usageReadScopeFingerprint, type LocalUserUsageReadScope } from './read-scope';
import { lockCostUsageSettlement, settleCostReservationGroup } from '../cost-control/reservation-groups';
import { loadEffectiveCharges } from './effective-charges';
import type { BackupSnapshotWriteGate } from '../maintenance/backup-effect-fence';

export interface UsageService {
  /** COST-04 durable pre-call holds and post-call reconciliation. */
  budgetReservations: BudgetReservationService;
  ingest(input: unknown): Promise<UsageIngestAck>;
  project(operationId: string): Promise<Usage>;
  /** Tenant-scoped aggregate of usage by provider/model over a time window. */
  getUsageSummary(
    tenantId: string,
    from: Date,
    to: Date,
    options?: UsageSummaryOptions,
    readScope?: LocalUserUsageReadScope,
  ): Promise<UsageSummary>;
  /** COST-03 reconciliation view over ledger-shaped rows (contracts core). */
  getReconciliationSummary(
    tenantId: string,
    filter?: UsageAggregateFilterInput,
    pricingTiers?: readonly ModelPricingTier[],
    groupBy?: UsageAggregateDimension[],
  ): Promise<UsageReconciliationView>;
  /** Bounded, tenant-scoped keyset page for usage drill-down and export. */
  getUsageEventExportPage(
    tenantId: string,
    query?: UsageEventDrilldownQueryInput,
    readScope?: LocalUserUsageReadScope,
  ): Promise<UsageEventExportPage>;
  /** BASIC_ADMIN_USAGE_V1 page over persisted runtime UsageEvent rows. */
  getAdminUsageEventPage(
    tenantId: string,
    query: AdminUsageEventQueryInput,
    readScope?: LocalUserUsageReadScope,
  ): Promise<AdminUsageEventPage>;
}

export interface UsageServiceOptions {
  /** Shared process gate; ingestion/settlement fails closed when absent. */
  backupSnapshotWriteGate?: BackupSnapshotWriteGate;
}

export const AdminUsageEventQuerySchema = z.object({
  tenantId: z.string().regex(USAGE_ATTRIBUTION_ID_PATTERN).optional(),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  timeField: z.literal('receivedAt').default('receivedAt'),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
  operationId: z.string().uuid().optional(),
  provider: z.string().regex(USAGE_ATTRIBUTION_ID_PATTERN).optional(),
  model: z.string().regex(USAGE_ATTRIBUTION_ID_PATTERN).optional(),
}).strict().superRefine((query, ctx) => {
  const from = Date.parse(query.from);
  const to = Date.parse(query.to);
  if (!(to > from)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'to must be after from', path: ['to'] });
  } else if (to - from > 366 * 24 * 60 * 60 * 1000) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'usage event window cannot exceed 366 days', path: ['to'] });
  }
  if ((query.provider === undefined) !== (query.model === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'provider and model filters must be supplied together',
      path: [query.provider === undefined ? 'provider' : 'model'],
    });
  }
});

// The basic projection intentionally skips event IDs longer than the public
// record limit (128), but still needs to carry those stored keys through its
// cursor so scanning can make bounded forward progress. Keep this separate
// from the frozen rich-export cursor schema and bounded by the query's 2 KiB
// cursor limit.
const AdminUsageEventCursorSchema = z.object({
  version: z.literal(1),
  tenantId: z.string().regex(USAGE_ATTRIBUTION_ID_PATTERN),
  queryHash: z.string().regex(/^[a-f0-9]{64}$/),
  after: z.string().datetime({ offset: true }),
  afterEventKey: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type AdminUsageEventQueryInput = z.input<typeof AdminUsageEventQuerySchema>;

export interface AdminUsageEventRecord {
  eventId: string;
  operationId: string;
  taskId: string;
  invocationId: string;
  provider: string | null;
  model: string | null;
  units: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; pages?: number };
  /** Null means this persisted runtime event had no reported cost field. */
  costMicrousd: number | null;
  /** Null means the event predates explicit cost provenance. */
  costStatus: 'measured' | 'estimated' | 'unpriced' | 'pending' | null;
  /** Provider-reported amount is retained for diagnosis only; it never
   * contributes to trusted cost, reservations, or budget evaluation. */
  providerReportedCost?: ProviderReportedCost;
  financialAccounting: {
    rootEventId: string;
    initialChargeMicrousd: number | null;
    grossChargeMicrousd: number | null;
    refundedMicrousd: number | null;
    netChargeMicrousd: number | null;
    adjustmentRevision: number;
    headAdjustmentEventId: string | null;
    semantics: 'initial-charge-plus-direct-root-adjustments-v1';
  };
  measurement: 'measured' | 'estimated';
  occurredAt: string;
  receivedAt: string;
}

export interface AdminUsageEventPage {
  tenantId: string;
  events: AdminUsageEventRecord[];
  limit: number;
  hasMore: boolean;
  nextCursor?: string;
  skippedInvalidEvents: number;
  timeSemantics: { field: 'receivedAt'; order: 'asc'; timezone: 'UTC' };
}

const SAFE_USAGE_AMOUNT = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const AdminUsageEventRecordSchema = z.object({
  eventId: z.string().min(1).max(128),
  operationId: z.string().uuid(),
  taskId: z.string().uuid(),
  invocationId: z.string().min(1).max(128),
  provider: z.string().regex(USAGE_ATTRIBUTION_ID_PATTERN).nullable(),
  model: z.string().regex(USAGE_ATTRIBUTION_ID_PATTERN).nullable(),
  units: z.object({
    inputTokens: SAFE_USAGE_AMOUNT,
    outputTokens: SAFE_USAGE_AMOUNT,
    cachedInputTokens: SAFE_USAGE_AMOUNT.optional(),
    pages: SAFE_USAGE_AMOUNT.optional(),
  }).strict(),
  costMicrousd: SAFE_USAGE_AMOUNT.nullable(),
  costStatus: z.enum(['measured', 'estimated', 'unpriced', 'pending']).nullable(),
  providerReportedCost: ProviderReportedCostSchema.optional(),
  financialAccounting: z.object({
    rootEventId: z.string().min(1).max(128),
    initialChargeMicrousd: SAFE_USAGE_AMOUNT.nullable(),
    grossChargeMicrousd: SAFE_USAGE_AMOUNT.nullable(),
    refundedMicrousd: SAFE_USAGE_AMOUNT.nullable(),
    netChargeMicrousd: SAFE_USAGE_AMOUNT.nullable(),
    adjustmentRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    headAdjustmentEventId: z.string().uuid().nullable(),
    semantics: z.literal('initial-charge-plus-direct-root-adjustments-v1'),
  }).strict(),
  measurement: z.enum(['measured', 'estimated']),
  occurredAt: z.string().datetime({ offset: true }),
  receivedAt: z.string().datetime({ offset: true }),
}).strict();

export const AdminUsageEventPageSchema = z.object({
  tenantId: z.string().regex(USAGE_ATTRIBUTION_ID_PATTERN),
  events: z.array(AdminUsageEventRecordSchema).max(100),
  limit: z.number().int().min(1).max(100),
  hasMore: z.boolean(),
  nextCursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
  skippedInvalidEvents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  timeSemantics: z.object({
    field: z.literal('receivedAt'),
    order: z.literal('asc'),
    timezone: z.literal('UTC'),
  }).strict(),
}).strict().superRefine((page, ctx) => {
  if (page.events.length > page.limit) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'events cannot exceed the requested limit', path: ['events'] });
  }
  if (page.hasMore !== (page.nextCursor !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'nextCursor must be present exactly when hasMore is true', path: ['nextCursor'] });
  }
});

/**
 * Usage summary projection (P2-07, W39-C), aggregated by provider and model.
 *
 * IMPORTANT - schema gap (recorded, not patched): usage_events is an
 * append-only JSONB ledger whose rows carry only event_id, operation_id,
 * task_id, payload (the frozen @du/contracts UsageEvent: units, cost,
 * measurement, occurredAt) and received_at. There is NO provider or model
 * COLUMN - and the frozen wire UsageEventSchema does not define those
 * fields either. Aggregating by provider and model therefore cannot be
 * computed without a schema change to a frozen contract and a new
 * migration, neither of which W39-C was authorized to introduce.
 *
 * The summary is still implemented, but it aggregates by the dimensions the
 * ledger DOES carry: provider/model are surfaced from payload.provider /
 * payload.model when present (a forward-compatible extension that leaves
 * the contract unchanged), and the projection is scoped by tenant via the
 * operation tenant_id (RES-07 tenant isolation) and the [from,to)
 * received_at window. A missing provider/model collapses into a single
 * '(unattributed)' bucket so the function is always well-defined.
 *
 * COST-05 integration (W-COST05-SERVICE-RECON-1): the numeric core moved
 * onto the @du/contracts money law. Group accumulation is BigInt with
 * safe-integer ceilings (no silent float drift in a summary total);
 * per-group totals self-validate through UsageSummarySchema; budget
 * evaluation delegates to evaluateBudgetStatus (COST-04); the new
 * reconciliation method delegates to aggregateUsageEvents (COST-03) via
 * projectLedgerEvent, which never fabricates ledger fields the DB rows
 * do not carry. Wire-shape payloads are reported as rejected rows instead
 * of being coerced - the same boundary-adapter rule as metricsFromProviderUsage.
 */
export interface UsageSummaryRow {
  provider: string;
  model: string;
  operations: number;
  inputTokens: number;
  outputTokens: number;
  pages: number;
  costMicrousd: number;
  measurement: 'measured' | 'estimated' | 'mixed' | 'pending';
  costStatus?: 'measured' | 'estimated' | 'unpriced' | 'pending';
}

export interface UsageSummary {
  tenantId: string;
  from: string;
  to: string;
  rows: UsageSummaryRow[];
  totals: {
    operations: number;
    inputTokens: number;
    outputTokens: number;
    pages: number;
    costMicrousd: number;
    costStatus?: 'measured' | 'estimated' | 'unpriced' | 'pending';
  };
  /** Present only when getUsageSummary was called with options.budget
   * (COST-04 evaluateBudgetStatus result over the window totals). */
  budget?: BudgetEvaluation;
}

/** Optional 4th argument to getUsageSummary; default undefined keeps the
 * response byte-identical to the W39-C shape (routes pass no options). */
export interface UsageSummaryOptions {
  /** Pre-parse caller shape: notificationChannels carries a default;
   * validateBudgetEvaluation checks tenant and supported aggregate scope. */
  budget?: BudgetConfigInput;
  /** COST-04 admission-control view: running/UNKNOWN invocations held
   * against the budget, in the same ledger-summary shape. */
  inFlightReservation?: UsageSummaryTotals;
}

/** A row whose payload is NOT UsageLedgerEvent-shaped. missingFields lists
 * the required ledger keys absent or wrong-typed - the projector never
 * fabricates them (docs: 0 token is a measured zero, missing stays missing). */
export interface UsageLedgerRejection {
  eventId: string;
  missingFields: string[];
}

export interface UsageReconciliationView {
  /** Contract UsageSummary: eventId-deduped, BigInt-summed totals. */
  summary: UsageSummaryTotals;
  /** Rows whose payload parsed as UsageLedgerEvent (before dedup). */
  projectedEvents: number;
  /** Non-ledger rows (e.g. the frozen wire UsageEvent) with stable field
   * diagnostics; they contribute nothing to the summary. */
  rejectedRows: UsageLedgerRejection[];
  /** Present only when pricing tiers were supplied (COST-02 engine). */
  pricing?: {
    pricedEvents: number;
    unpricedEvents: number;
    costMicrousd: number;
    costStatus?: 'measured' | 'estimated' | 'unpriced' | 'pending';
  };
  /** Present when COST-03 group levels were requested. */
  aggregation?: UsageAggregation;
}

export type LedgerProjection =
  | { ok: true; event: UsageLedgerEvent }
  | { ok: false; eventId: string; missingFields: string[] };

/**
 * Boundary projector DB payload -> COST-01 ledger event. Returns the parsed
 * event when the payload already IS ledger-shaped (future producer wiring
 * per COST-01 persistence), otherwise a typed rejection naming the missing/
 * invalid required fields. Today every wire UsageEvent row lands in the
 * rejection branch; that is the recorded schema seam, not a bug to paper
 * over with invented defaults.
 */
export function projectLedgerEvent(payload: Record<string, unknown>): LedgerProjection {
  const parsed = UsageLedgerEventSchema.safeParse(payload);
  if (parsed.success) return { ok: true, event: parsed.data };
  const eventId = typeof payload['eventId'] === 'string' ? (payload['eventId'] as string) : '';
  const missing = new Set<string>();
  for (const issue of parsed.error.issues) {
    // zod v3 reports missing required keys as invalid_type (received undefined)
    if (issue.code === 'invalid_type') {
      const head: unknown = issue.path[0];
      if (typeof head === 'string') missing.add(head);
    }
  }
  return { ok: false, eventId, missingFields: [...missing].sort() };
}

/** Cross-graph-safe error discriminators (SEC-INT-01 lesson: class identity
 * can split across src/dist module graphs - match on name/message). */
function isLedgerConflictError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'UsageReconciliationConflictError' || err.message.startsWith('USAGE_EVENT_CONFLICT'))
  );
}

function isUnpricedUnitError(err: unknown): boolean {
  return err instanceof Error && err.name === 'PricingUnpricedUnitError';
}

function encodeUsageEventCursor(input: {
  tenantId: string;
  queryHash: string;
  after: string;
  eventId: string;
}): string {
  return Buffer.from(JSON.stringify({ version: 1, ...input }), 'utf8').toString('base64url');
}

function decodeUsageEventCursor(value: string): {
  tenantId: string;
  queryHash: string;
  after: string;
  eventId: string;
} {
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) throw new Error('non-canonical cursor');
    const parsed = UsageEventDrilldownCursorSchema.safeParse(JSON.parse(decoded.toString('utf8')) as unknown);
    if (!parsed.success) throw new Error('invalid cursor payload');
    const { tenantId, queryHash, after, eventId } = parsed.data;
    return { tenantId, queryHash, after, eventId };
  } catch {
    throw new HttpError(422, 'INVALID_ARGUMENT', 'usage event cursor is invalid for this query');
  }
}

function decodeAdminUsageEventCursor(value: string): {
  tenantId: string;
  queryHash: string;
  after: string;
  afterEventKey: string;
} {
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) throw new Error('non-canonical cursor');
    const parsed = AdminUsageEventCursorSchema.safeParse(JSON.parse(decoded.toString('utf8')) as unknown);
    if (!parsed.success) throw new Error('invalid cursor payload');
    const { tenantId, queryHash, after, afterEventKey } = parsed.data;
    return { tenantId, queryHash, after, afterEventKey };
  } catch {
    throw new HttpError(422, 'INVALID_ARGUMENT', 'usage event cursor is invalid for this query');
  }
}

function encodeAdminUsageEventCursor(input: {
  tenantId: string;
  queryHash: string;
  after: string;
  afterEventKey: string;
}): string {
  return Buffer.from(JSON.stringify({ version: 1, ...input }), 'utf8').toString('base64url');
}

function toIsoTimestamp(value: Date | string, field: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(500, 'TEMPORARY_UNAVAILABLE', `usage ledger contains an invalid ${field} timestamp`);
  }
  return date.toISOString();
}

const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Pure reconciliation core (no DB): project -> aggregateUsageEvents ->
 * optional COST-02 pricing pass. Dedup, half-open windows and BigInt sums
 * are the contract function's semantics verbatim; pricing is estimated
 * under the tier effective at each event's occurredAt (docs COST-02:
 * provider-reported and self-computed money stay separate - this block
 * only ever reports the self-computed side).
 */
export function reconcileUsageRows(
  payloads: readonly Record<string, unknown>[],
  filter?: UsageAggregateFilterInput,
  pricingTiers?: readonly ModelPricingTier[],
  groupBy?: UsageAggregateDimension[],
): UsageReconciliationView {
  const events: UsageLedgerEvent[] = [];
  const rejectedRows: UsageLedgerRejection[] = [];
  for (const payload of payloads) {
    const projection = projectLedgerEvent(payload ?? {});
    if (projection.ok) events.push(projection.event);
    else rejectedRows.push({ eventId: projection.eventId, missingFields: projection.missingFields });
  }
  const view: UsageReconciliationView = {
    summary: aggregateUsageEvents(events, filter),
    projectedEvents: events.length,
    rejectedRows,
    ...(groupBy !== undefined
      ? { aggregation: aggregateUsageGroups(events, { filter: filter ?? {}, groupBy }) }
      : {}),
  };
  if (pricingTiers !== undefined) {
    // Price each unique eventId exactly once (money law). Safe to key by
    // last-wins here: a divergent duplicate already made aggregateUsageEvents
    // throw above, so all remaining same-id entries carry equal content.
    const uniqueEvents = [...new Map(events.map((event) => [event.eventId, event])).values()];
    let cost = 0n;
    let pricedEvents = 0;
    let unpricedEvents = 0;
    for (const event of uniqueEvents) {
      const tier = resolvePricingTier(pricingTiers, {
        modelId: event.model,
        at: event.occurredAt,
        provider: event.provider,
      });
      if (tier === undefined) {
        unpricedEvents += 1;
        continue;
      }
      try {
        cost += BigInt(
          calculateOperationCost(
            {
              operationId: event.operationId,
              inputTokens: event.units.inputTokens,
              outputTokens: event.units.outputTokens,
              cachedInputTokens: event.units.cachedInputTokens ?? 0,
              totalTokens: event.units.inputTokens + event.units.outputTokens,
              ...(event.units.pages !== undefined ? { pages: event.units.pages } : {}),
              costMicrousd: 0,
              costStatus: 'estimated',
              durationMs: event.durationMs,
            },
            tier,
          ),
        );
        pricedEvents += 1;
      } catch (err) {
        if (isUnpricedUnitError(err)) {
          unpricedEvents += 1;
          continue;
        }
        throw err;
      }
    }
    if (cost > MAX_SAFE_BIG) {
      throw new RangeError('USAGE_PRICED_TOTAL_OVERFLOW: priced total exceeds the safe integer range in micro-USD');
    }
    view.pricing = { pricedEvents, unpricedEvents, costMicrousd: Number(cost) };
  }
  return view;
}

const UNATTRIBUTED = '(unattributed)';

function summarizedCostStatus(statuses: ReadonlySet<string>): UsageSummaryRow['costStatus'] | undefined {
  if (statuses.has('pending')) return 'pending';
  if (statuses.has('unpriced')) return 'unpriced';
  if (statuses.has('estimated')) return 'estimated';
  return statuses.has('measured') ? 'measured' : undefined;
}

export function createUsageService(db: Db, options: UsageServiceOptions = {}): UsageService {
  const budgetReservations = createBudgetReservationService(db, {
    backupSnapshotWriteGate: options.backupSnapshotWriteGate,
  });
  return {
    budgetReservations,
    async ingest(input) {
      // HttpUsageSink sends one event; the runtime contract also supports batches.
      const single = UsageEventSchema.safeParse(input);
      const batch = UsageIngestBatchSchema.safeParse(single.success ? { events: [single.data] } : input);
      if (!batch.success) throw zodIssuesToProblem(batch.error.issues);
      for (const event of batch.data.events) {
        const amounts = [event.units.inputTokens, event.units.outputTokens, event.units.pages ?? 0, event.costMicrousd];
        if ((event.costStatus === 'unpriced' && event.costMicrousd !== 0) || amounts.some((value) => !Number.isSafeInteger(value)) || !Number.isFinite(Date.parse(event.occurredAt))) {
          throw new HttpError(422, 'INVALID_SCHEMA', 'usage requires safe integer amounts and a valid timestamp');
        }
      }
      // Stable lock order prevents overlapping batches from deadlocking. A failed
      // event rolls back the entire batch, so an ACK always describes durable data.
      return db.tx(async (tx) => {
        const ack: UsageIngestAck = { accepted: [], duplicates: [] };
        const events = [...batch.data.events].sort((a, b) => a.eventId.localeCompare(b.eventId));
        let trustedTenantId: string | null = null;
        for (const event of events) {
          const task = await tx.query<{ tenant_id: string }>(
            `SELECT o.tenant_id::text AS tenant_id FROM operations o
              JOIN tasks t ON t.operation_id=o.id WHERE o.id=$1 AND t.id=$2`,
            [event.operationId, event.taskId],
          );
          const rowTenantId = task.rows[0]?.tenant_id;
          if (!rowTenantId) throw new HttpError(422, 'INVALID_ARGUMENT', 'usage task does not belong to operation');
          if (event.costProvenance && event.costProvenance.tenantId !== rowTenantId) {
            throw new HttpError(422, 'INVALID_ARGUMENT', 'usage provenance tenant does not match its operation');
          }
          if (trustedTenantId !== null && trustedTenantId !== rowTenantId) {
            throw new HttpError(422, 'INVALID_ARGUMENT', 'usage batch must contain one tenant only');
          }
          trustedTenantId = rowTenantId;
        }
        if (!trustedTenantId || !options.backupSnapshotWriteGate) {
          throw new HttpError(503, 'BACKUP_WRITE_GATE_UNAVAILABLE', 'usage settlement is disabled because its backup write gate is unavailable');
        }
        await options.backupSnapshotWriteGate.assertWriteAllowed(tx, {
          tenantId: trustedTenantId,
          domain: 'usage-settlement',
          requestKey: createHash('sha256').update(canonicalize({
            purpose: 'usage-ingest', tenantId: trustedTenantId,
            events: events.map((event) => ({ eventId: event.eventId, payloadDigest: createHash('sha256').update(canonicalize(event)).digest('hex') })),
          })).digest('hex'),
        });
        for (const event of events) {
          // Enter the same tenant quota-population fence before an event INSERT
          // can take its reservation-group FK KEY SHARE lock. Otherwise a
          // concurrent preflight could hold the tenant fence and wait on this
          // group's row while this transaction waits on the tenant fence.
          // Append and settle remain in one transaction, so alert evaluation
          // can read the immutable event row before commit.
          await lockCostUsageSettlement(tx, event);
          const inserted = await tx.query(
            `INSERT INTO usage_events (event_id, operation_id, task_id, payload, cost_reservation_group_id)
             VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
            [event.eventId, event.operationId, event.taskId, JSON.stringify(event), event.costProvenance?.reservationGroupId ?? null]
          ).catch((error: unknown) => {
            const pgError = error as { code?: unknown; constraint?: unknown };
            if (pgError.code === '23505' && pgError.constraint === 'usage_events_cost_group_settled_unique') {
              throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'reservation group already has a different settled usage event');
            }
            throw error;
          });
          if (inserted.rowCount) {
            await settleCostReservationGroup(tx, event);
            ack.accepted.push(event.eventId);
          } else {
            const existing = await tx.query<{ payload: UsageEvent; cost_reservation_group_id: string | null }>(
              'SELECT payload,cost_reservation_group_id::text AS cost_reservation_group_id FROM usage_events WHERE event_id=$1', [event.eventId]);
            if (canonicalize(existing.rows[0]!.payload) !== canonicalize(event)
                || (existing.rows[0]!.cost_reservation_group_id ?? null) !== (event.costProvenance?.reservationGroupId ?? null)) {
              throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'usage event ID already has a different payload');
            }
            await settleCostReservationGroup(tx, event);
            ack.duplicates.push(event.eventId);
          }
        }
        return ack;
      });
    },
    async project(operationId) {
      const result = await db.query<{ event_id: string; tenant_id: string; payload: unknown; model: string | null }>(
        `SELECT ue.event_id,o.tenant_id::text AS tenant_id,ue.payload,ue.payload->>'model' AS model
           FROM usage_events ue JOIN operations o ON o.id=ue.operation_id
          WHERE ue.operation_id=$1 ORDER BY ue.event_id`,
        [operationId],
      );
      const charges = await loadEffectiveCharges(db, result.rows.map((row) => ({
        event_id: row.event_id, tenant_id: row.tenant_id, payload: row.payload,
      })));
      let inputTokens = 0n;
      let outputTokens = 0n;
      let pages = 0n;
      let costMicrousd = 0n;
      const measurements = new Set<string>();
      const statuses = new Set<string>();
      const models = new Set<string>();
      for (const row of result.rows) {
        const parsed = UsageEventSchema.safeParse(row.payload);
        if (!parsed.success || parsed.data.eventId !== row.event_id || parsed.data.operationId !== operationId) {
          throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'usage row is invalid for operation projection');
        }
        const event = parsed.data;
        inputTokens += BigInt(event.units.inputTokens);
        outputTokens += BigInt(event.units.outputTokens);
        pages += BigInt(event.units.pages ?? 0);
        const projected = charges.get(row.event_id);
        const amount = projected?.netChargeMicrousd ?? event.costMicrousd;
        if (amount !== null) costMicrousd += BigInt(amount);
        measurements.add(event.measurement ?? (event.costStatus === 'estimated' ? 'estimated' : 'measured'));
        statuses.add(projected?.costStatus ?? event.costStatus ?? (event.costMicrousd === undefined ? 'pending' : 'measured'));
        if (typeof event.model === 'string') models.add(event.model);
      }
      for (const amount of [inputTokens, outputTokens, pages, costMicrousd]) {
        if (amount > MAX_SAFE_BIG) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'usage totals exceed the wire integer range');
      }
      const status = summarizedCostStatus(statuses);
      const measurement = measurements.has('estimated')
        ? (measurements.has('measured') ? 'estimated' : 'estimated')
        : measurements.size === 0 ? 'pending' : 'measured';
      return {
        inputTokens: Number(inputTokens), outputTokens: Number(outputTokens), costMicrousd: Number(costMicrousd),
        measurement: result.rows.length === 0 ? 'pending' : measurement,
        costStatus: result.rows.length === 0 ? 'pending' : status ?? 'pending',
        pages: Number(pages),
        ...(models.size === 1 ? { model: [...models][0] } : {}),
      };
    },
    async getUsageSummary(tenantId, from, to, options, readScope) {
      if (!(from instanceof Date) || Number.isNaN(from.getTime()) || !(to instanceof Date) || Number.isNaN(to.getTime())) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'getUsageSummary requires valid from/to dates');
      }
      if (from > to) {
        throw new HttpError(422, 'INVALID_ARGUMENT', 'getUsageSummary requires from <= to');
      }
      if (readScope && readScope.tenantId !== tenantId) {
        throw new HttpError(403, 'PERMISSION_DENIED', 'local-user usage scope does not match tenant');
      }
      const params: unknown[] = [tenantId, from.toISOString(), to.toISOString()];
      const where = ['o.tenant_id = $1', 'ue.received_at >= $2', 'ue.received_at < $3'];
      const add = (value: unknown): string => {
        params.push(value);
        return `$${params.length}`;
      };
      appendLocalUserUsageFence(where, add, readScope);
      const result = await db.query<{
        event_id: string;
        tenant_id: string;
        payload: Record<string, unknown>;
        operation_id: string;
      }>(
        `SELECT ue.event_id, o.tenant_id::text AS tenant_id, ue.payload, ue.operation_id
         FROM usage_events ue
         JOIN operations o ON o.id = ue.operation_id
         WHERE ${where.join(' AND ')}`,
        params
      );
      const charges = await loadEffectiveCharges(db, result.rows.map((row) => ({
        event_id: row.event_id, tenant_id: row.tenant_id, payload: row.payload,
      })));
      // Money law (contracts): every group sums in BigInt with safe-integer
      // ceilings. Absent/non-number values are skipped exactly as the legacy
      // loop did; a PRESENT but non-integer/negative/unsafe amount is corrupt
      // ledger data and fails closed instead of silently poisoning a total.
      const safeAmount = (value: unknown, field: string): number => {
        if (value === undefined || value === null || typeof value !== 'number') return 0;
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'usage ledger contains an unusable amount in ' + field);
        }
        return value;
      };
      const groups = new Map<string, {
        provider: string; model: string; operations: Set<string>;
        inputTokens: bigint; outputTokens: bigint; pages: bigint; costMicrousd: bigint;
        events: number; measurements: Set<string>; costStatuses: Set<string>;
      }>();
      for (const row of result.rows) {
        const payload = row.payload ?? {};
        const provider = typeof payload['provider'] === 'string' && payload['provider'].length > 0
          ? (payload['provider'] as string)
          : UNATTRIBUTED;
        const model = typeof payload['model'] === 'string' && payload['model'].length > 0
          ? (payload['model'] as string)
          : UNATTRIBUTED;
        const units = (payload['units'] as { inputTokens?: unknown; outputTokens?: unknown; pages?: unknown } | undefined) ?? {};
        const key = `${provider}${String.fromCharCode(0)}${model}`;
        let group = groups.get(key);
        if (!group) {
          group = { provider, model, operations: new Set(), inputTokens: 0n, outputTokens: 0n, pages: 0n, costMicrousd: 0n, events: 0, measurements: new Set(), costStatuses: new Set() };
          groups.set(key, group);
        }
        group.operations.add(row.operation_id);
        group.events += 1;
        group.inputTokens += BigInt(safeAmount(units.inputTokens, 'inputTokens'));
        group.outputTokens += BigInt(safeAmount(units.outputTokens, 'outputTokens'));
        group.pages += BigInt(safeAmount(units.pages, 'pages'));
        const charge = charges.get(row.event_id);
        const unavailableCharge = charge?.costStatus === 'pending' || charge?.costStatus === 'unpriced';
        const effectiveCost = charge?.netChargeMicrousd ?? (unavailableCharge ? undefined : payload['costMicrousd']);
        group.costMicrousd += BigInt(safeAmount(effectiveCost, 'costMicrousd'));
        if (typeof payload['measurement'] === 'string') group.measurements.add(payload['measurement'] as string);
        const status = charge?.costStatus ?? payload['costStatus'];
        if (typeof status === 'string') group.costStatuses.add(status);
        else if (!Object.hasOwn(payload, 'costMicrousd')) group.costStatuses.add('pending');
      }
      const toInt = (value: bigint, field: string): number => {
        if (value > MAX_SAFE_BIG) {
          throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'usage summary totals exceed the wire integer range in ' + field);
        }
        return Number(value);
      };
      const rows: UsageSummaryRow[] = [...groups.values()]
        .map((g) => {
          const est = g.measurements.has('estimated');
          const hasMeasured = [...g.measurements].some((m) => m !== 'estimated' && m !== 'pending');
          const inputTokens = toInt(g.inputTokens, 'inputTokens');
          const outputTokens = toInt(g.outputTokens, 'outputTokens');
          const costMicrousd = toInt(g.costMicrousd, 'costMicrousd');
          // Self-check against the contract schema the aggregator enforces.
          UsageSummarySchema.parse({
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            totalCostMicrousd: costMicrousd,
            eventCount: g.events,
          });
          return {
            provider: g.provider,
            model: g.model,
            ...(summarizedCostStatus(g.costStatuses) ? { costStatus: summarizedCostStatus(g.costStatuses) } : {}),
            operations: g.operations.size,
            inputTokens,
            outputTokens,
            pages: toInt(g.pages, 'pages'),
            costMicrousd,
            measurement: (g.measurements.size === 0 ? 'pending' : est && hasMeasured ? 'mixed' : est ? 'estimated' : 'measured') as UsageSummaryRow['measurement'],
          };
        })
        .sort((a, b) => (a.provider === b.provider ? a.model.localeCompare(b.model) : a.provider.localeCompare(b.provider)));
      const totals = rows.reduce(
        (acc, r) => ({
          operations: acc.operations + r.operations,
          inputTokens: acc.inputTokens + r.inputTokens,
          outputTokens: acc.outputTokens + r.outputTokens,
          pages: acc.pages + r.pages,
          costMicrousd: acc.costMicrousd + r.costMicrousd,
        }),
        { operations: 0, inputTokens: 0, outputTokens: 0, pages: 0, costMicrousd: 0 },
      );
      for (const [field, value] of Object.entries(totals)) {
        if (!Number.isSafeInteger(value)) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'usage window exceeds the wire integer range in ' + field);
      }
      const statuses = new Set(rows.flatMap(row => row.costStatus ? [row.costStatus] : []));
      const totalsStatus = summarizedCostStatus(statuses);
      const totalsWithStatus = { ...totals, ...(totalsStatus ? { costStatus: totalsStatus } : {}) };
      let budget: BudgetEvaluation | undefined;
      if (options?.budget !== undefined) {
        const windowSummary = UsageSummarySchema.parse({
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          totalTokens: totals.inputTokens + totals.outputTokens,
          totalCostMicrousd: totals.costMicrousd,
          eventCount: [...groups.values()].reduce((n, g) => n + g.events, 0),
        });
        budget = validateBudgetEvaluation({
          tenantId,
          budget: options.budget,
          usage: windowSummary,
          inFlightReservation: options.inFlightReservation,
        });
      }
      return {
        tenantId,
        from: from.toISOString(),
        to: to.toISOString(),
        rows,
        totals: totalsWithStatus,
        ...(budget !== undefined ? { budget } : {}),
      };
    },
    async getReconciliationSummary(tenantId, filter, pricingTiers, groupBy) {
      // Read is tenant-scoped (RES-07) but NOT time-bounded in SQL: the window
      // belongs to the contract filter so the published occurredAt/receivedAt
      // rule decides, never a silent SQL pre-filter on one clock. Bounded
      // reads/pagination arrive with the COST-03 service projection packet.
      const result = await db.query<{ payload: Record<string, unknown> }>(
        `SELECT ue.payload
         FROM usage_events ue
         JOIN operations o ON o.id = ue.operation_id
         WHERE o.tenant_id = $1`,
        [tenantId],
      );
      try {
        return reconcileUsageRows(result.rows.map((r) => r.payload ?? {}), filter, pricingTiers, groupBy);
      } catch (err) {
        if (isLedgerConflictError(err)) {
          throw new HttpError(500, 'USAGE_LEDGER_CONFLICT', 'usage ledger contains the same eventId with divergent payloads');
        }
        if (err instanceof RangeError) {
          throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'usage reconciliation totals exceed the wire integer range');
        }
        throw err;
      }
    },
    async getUsageEventExportPage(tenantId, queryInput, readScope) {
      const parsed = UsageEventDrilldownQuerySchema.safeParse(queryInput ?? {});
      if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
      const query = parsed.data;
      if (query.tenantId !== undefined && query.tenantId !== tenantId) {
        throw new HttpError(403, 'PERMISSION_DENIED', 'tenantId does not match authorized usage scope');
      }
      if (readScope && readScope.tenantId !== tenantId) {
        throw new HttpError(403, 'PERMISSION_DENIED', 'local-user usage scope does not match tenant');
      }

      // Cursor reuse with another tenant, filter, time window, sort clock, or
      // page size is rejected before SQL construction. Tenant SQL predicates
      // remain mandatory even when a cursor was originally issued here.
      const binding = {
        apiKeyId: query.apiKeyId ?? null,
        businessId: query.businessId ?? null,
        action: query.action ?? null,
        profileRevision: query.profileRevision ?? null,
        provider: query.provider ?? null,
        model: query.model ?? null,
        operationId: query.operationId ?? null,
        from: query.from ?? null,
        to: query.to ?? null,
        timeField: query.timeField,
        limit: query.limit,
        readScope: usageReadScopeFingerprint(readScope),
      };
      const queryHash = createHash('sha256').update(JSON.stringify({ tenantId, binding })).digest('hex');
      const cursor = query.cursor === undefined ? undefined : decodeUsageEventCursor(query.cursor);
      if (cursor && (cursor.tenantId !== tenantId || cursor.queryHash !== queryHash)) {
        throw new HttpError(422, 'INVALID_ARGUMENT', 'usage event cursor is invalid for this query');
      }

      const sortExpression = query.timeField === 'occurredAt'
        ? `(ue.payload->>'occurredAt')::timestamptz`
        : 'ue.received_at';
      const params: unknown[] = [tenantId];
      const where = ['o.tenant_id = $1', `ue.payload->>'tenantId' = $1`];
      const add = (value: unknown): string => {
        params.push(value);
        return `$${params.length}`;
      };
      appendLocalUserUsageFence(where, add, readScope);
      for (const [field, value] of [
        ['apiKeyId', query.apiKeyId],
        ['businessId', query.businessId],
        ['action', query.action],
        ['profileRevision', query.profileRevision],
        ['provider', query.provider],
        ['model', query.model],
        ['operationId', query.operationId],
      ] as const) {
        if (value !== undefined) where.push(`ue.payload->>'${field}' = ${add(String(value))}`);
      }
      if (query.from !== undefined) where.push(`${sortExpression} >= ${add(query.from)}::timestamptz`);
      if (query.to !== undefined) where.push(`${sortExpression} < ${add(query.to)}::timestamptz`);
      if (cursor) {
        const after = add(cursor.after);
        const eventId = add(cursor.eventId);
        where.push(`(${sortExpression}, ue.event_id) > (${after}::timestamptz, ${eventId}::text)`);
      }
      const limit = add(query.limit + 1);
      const result = await db.query<{
        event_id: string;
        operation_id: string;
        payload: Record<string, unknown>;
        received_at: Date | string;
        sort_value: Date | string;
      }>(
        `SELECT ue.event_id, ue.operation_id, ue.payload, ue.received_at, ${sortExpression} AS sort_value
         FROM usage_events ue
         JOIN operations o ON o.id = ue.operation_id
         WHERE ${where.join(' AND ')}
         ORDER BY ${sortExpression} ASC, ue.event_id ASC
         LIMIT ${limit}`,
        params,
      );

      const hasMore = result.rows.length > query.limit;
      const scanned = result.rows.slice(0, query.limit);
      const events: UsageLedgerEvent[] = [];
      let skippedInvalidEvents = 0;
      for (const row of scanned) {
        const projected = projectLedgerEvent(row.payload ?? {});
        if (!projected.ok) {
          skippedInvalidEvents += 1;
          continue;
        }
        if (
          projected.event.eventId !== row.event_id ||
          projected.event.operationId !== row.operation_id ||
          projected.event.tenantId !== tenantId
        ) {
          throw new HttpError(500, 'USAGE_LEDGER_CONFLICT', 'usage ledger row identity does not match its stored key');
        }
        events.push({ ...projected.event, receivedAt: toIsoTimestamp(row.received_at, 'receivedAt') });
      }
      const lastScanned = scanned[scanned.length - 1];
      const nextCursor = hasMore && lastScanned
        ? encodeUsageEventCursor({
          tenantId,
          queryHash,
          after: toIsoTimestamp(lastScanned.sort_value, query.timeField),
          eventId: lastScanned.event_id,
        })
        : undefined;
      return UsageEventExportPageSchema.parse({
        tenantId,
        events,
        limit: query.limit,
        hasMore,
        ...(nextCursor !== undefined ? { nextCursor } : {}),
        skippedInvalidEvents,
        timeSemantics: { field: query.timeField, order: 'asc', timezone: 'UTC' },
      });
    },
    async getAdminUsageEventPage(tenantId, queryInput, readScope) {
      const parsed = AdminUsageEventQuerySchema.safeParse(queryInput);
      if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
      const query = parsed.data;
      if (query.tenantId !== undefined && query.tenantId !== tenantId) {
        throw new HttpError(403, 'PERMISSION_DENIED', 'tenantId does not match authorized usage scope');
      }
      if (readScope && readScope.tenantId !== tenantId) {
        throw new HttpError(403, 'PERMISSION_DENIED', 'local-user usage scope does not match tenant');
      }

      // The summary window is based on received_at, so this basic Admin view
      // uses that same persisted clock. Unlike the rich COST exporter, this
      // projection reads the actual UsageEvent wire records without claiming
      // attribution fields those records do not contain.
      const binding = {
        from: query.from,
        to: query.to,
        timeField: query.timeField,
        limit: query.limit,
        operationId: query.operationId ?? null,
        provider: query.provider ?? null,
        model: query.model ?? null,
        readScope: usageReadScopeFingerprint(readScope),
      };
      const queryHash = createHash('sha256').update(JSON.stringify({ tenantId, binding })).digest('hex');
      const cursor = query.cursor === undefined ? undefined : decodeAdminUsageEventCursor(query.cursor);
      if (cursor && (cursor.tenantId !== tenantId || cursor.queryHash !== queryHash)) {
        throw new HttpError(422, 'INVALID_ARGUMENT', 'usage event cursor is invalid for this query');
      }

      const params: unknown[] = [tenantId, query.from, query.to];
      const where = ['o.tenant_id = $1', 'ue.received_at >= $2::timestamptz', 'ue.received_at < $3::timestamptz'];
      const add = (value: unknown): string => {
        params.push(value);
        return `$${params.length}`;
      };
      appendLocalUserUsageFence(where, add, readScope);
      if (query.operationId !== undefined) where.push(`ue.operation_id = ${add(query.operationId)}::uuid`);
      if (query.provider !== undefined) {
        where.push(`ue.payload->>'provider' = ${add(query.provider)}`);
        where.push(`ue.payload->>'model' = ${add(query.model)}`);
      }
      if (cursor) {
        const after = add(cursor.after);
        const eventKey = add(cursor.afterEventKey);
        where.push(`(ue.received_at, encode(sha256(convert_to(ue.event_id, 'UTF8')), 'hex')) > (${after}::timestamptz, ${eventKey}::text)`);
      }
      const limit = add(query.limit + 1);
      const result = await db.query<{
        event_id: string;
        operation_id: string;
        task_id: string;
        matched_task_id: string | null;
        tenant_id: string;
        payload: Record<string, unknown> | null;
        received_at: Date | string;
        cursor_received_at: string;
      }>(
        `SELECT ue.event_id, ue.operation_id, ue.task_id, o.tenant_id::text AS tenant_id, ue.payload, ue.received_at,
                t.id AS matched_task_id,
                to_char(ue.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_received_at
         FROM usage_events ue
         JOIN operations o ON o.id = ue.operation_id
         LEFT JOIN tasks t ON t.id = ue.task_id AND t.operation_id = ue.operation_id
         WHERE ${where.join(' AND ')}
         ORDER BY ue.received_at ASC, encode(sha256(convert_to(ue.event_id, 'UTF8')), 'hex') ASC
         LIMIT ${limit}`,
        params,
      );

      const charges = await loadEffectiveCharges(db, result.rows.map((row) => ({
        event_id: row.event_id, tenant_id: row.tenant_id, payload: row.payload,
      })));

      const hasMore = result.rows.length > query.limit;
      const scanned = result.rows.slice(0, query.limit);
      const events: AdminUsageEventRecord[] = [];
      let skippedInvalidEvents = 0;
      for (const row of scanned) {
        const raw = row.payload;
        const projected = UsageEventSchema.safeParse(raw);
        if (!projected.success || row.matched_task_id !== row.task_id) {
          skippedInvalidEvents += 1;
          continue;
        }
        const event = projected.data;
        const charge = charges.get(row.event_id);
        if (!charge) throw new HttpError(503, 'FINANCIAL_ACCOUNTING_UNAVAILABLE', 'usage accounting projection is missing a selected event');
        if (
          event.eventId !== row.event_id ||
          event.operationId !== row.operation_id ||
          event.taskId !== row.task_id ||
          (raw && typeof raw['tenantId'] === 'string' && raw['tenantId'] !== tenantId) ||
          !Number.isSafeInteger(event.units.inputTokens) ||
          !Number.isSafeInteger(event.units.outputTokens) ||
          (event.units.pages !== undefined && !Number.isSafeInteger(event.units.pages)) ||
          (Object.prototype.hasOwnProperty.call(raw, 'costMicrousd') && !Number.isSafeInteger(event.costMicrousd))
        ) {
          skippedInvalidEvents += 1;
          continue;
        }
        const receivedAt = toIsoTimestamp(row.received_at, 'receivedAt');
        const record = AdminUsageEventRecordSchema.safeParse({
          eventId: event.eventId,
          operationId: event.operationId,
          taskId: event.taskId,
          invocationId: event.invocationId,
          provider: event.provider ?? null,
          model: event.model ?? null,
          units: event.units,
          // `costMicrousd` remains the immutable initial charge. Adjusted
          // gross/refund/net values are a separate, explicit projection.
          costMicrousd: charge.initialChargeMicrousd,
          costStatus: event.costStatus ?? null,
          ...(event.providerReportedCost !== undefined ? { providerReportedCost: event.providerReportedCost } : {}),
          financialAccounting: {
            rootEventId: charge.rootEventId,
            initialChargeMicrousd: charge.initialChargeMicrousd,
            grossChargeMicrousd: charge.grossChargeMicrousd,
            refundedMicrousd: charge.refundedMicrousd,
            netChargeMicrousd: charge.netChargeMicrousd,
            adjustmentRevision: charge.adjustmentRevision,
            headAdjustmentEventId: charge.headAdjustmentEventId,
            semantics: 'initial-charge-plus-direct-root-adjustments-v1',
          },
          measurement: event.measurement,
          occurredAt: event.occurredAt,
          receivedAt,
        });
        if (!record.success) {
          skippedInvalidEvents += 1;
          continue;
        }
        events.push(record.data);
      }
      const lastScanned = scanned[scanned.length - 1];
      const nextCursor = hasMore && lastScanned
        ? encodeAdminUsageEventCursor({
          tenantId,
          queryHash,
          after: lastScanned.cursor_received_at,
          afterEventKey: createHash('sha256').update(lastScanned.event_id, 'utf8').digest('hex'),
        })
        : undefined;
      return AdminUsageEventPageSchema.parse({
        tenantId,
        events,
        limit: query.limit,
        hasMore,
        ...(nextCursor !== undefined ? { nextCursor } : {}),
        skippedInvalidEvents,
        timeSemantics: { field: 'receivedAt', order: 'asc', timezone: 'UTC' },
      });
    },
  };
}
