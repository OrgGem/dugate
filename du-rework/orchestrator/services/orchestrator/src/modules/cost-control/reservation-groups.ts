import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  BudgetConfigSchema,
  COST_BOUND_CAPABILITIES,
  CostBudgetAlertEnqueueFactsSchema,
  CostPreflightRequestSchema,
  CostPreflightResponseSchema,
  CostReservationGroupAckSchema,
  CostReservationGroupTransitionSchema,
  InvocationGrantClaimsSchema,
  ModelPricingTableSchema,
  ModelPricingTierSchema,
  ProviderTestGrantClaimsSchema,
  UsageEventSchema,
  budgetQuotaScopeKey,
  canonicalize,
  evaluateBudgetStatus,
  quotaScopeForBudget,
  resolveBudgetQuotaWindow,
  resolvePricingTier,
  type CostPreflightRequest,
  type CostPreflightResponse,
  type CostReservationGroupAck,
  type CostReservationGroupTransition,
  type CostBudgetAlertEnqueueFacts,
  type EffectiveBudgetPin,
  type InvocationCostContext,
  type ModelPricingTier,
  type UsageEvent,
} from '@du/contracts';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Db } from '../../db/db';
import { HttpError } from '../../http/errors';
import { enqueueCostBudgetAlerts } from '../cost-alerts/enqueue';
import type { BackupSnapshotWriteGate } from '../maintenance/backup-effect-fence';
import { loadEffectiveCharges } from '../usage/effective-charges';

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface GrantScope {
  tenantId: string;
  operationId: string;
  taskId: string;
  invocationId: string;
  stepKey: string;
  bindingSlot: string;
  connectorId: string;
  connectorRevision: number;
  exp: number;
  iat: number;
  costContext: InvocationCostContext;
}

interface OperationRow extends QueryResultRow {
  tenant_id: string;
  api_key_id: string | null;
  profile_id: string | null;
  profile_revision: number | null;
  business_id: string;
  business_version: string;
  action: string;
  attempt: number;
}

interface BudgetHeadRow extends QueryResultRow {
  tenant_id: string;
  budget_id: string;
  active_revision: number;
  config: unknown;
}

interface PriceRevisionRow extends QueryResultRow {
  revision: number;
  tiers: unknown;
}

interface GroupRow extends QueryResultRow {
  reservation_group_id: string;
  tenant_id: string;
  operation_id: string;
  task_id: string;
  invocation_id: string;
  attempt: number;
  request_hash: string;
  decision: 'ADMITTED' | 'BLOCKED';
  state: 'RESERVED' | 'RUNNING' | 'UNKNOWN' | 'RELEASED' | 'BLOCKED' | 'SETTLED' | 'PENDING';
  confidence: 'upper-bound' | 'best-effort';
  hard_cap_enabled: boolean;
  frozen_response: unknown;
  usage_event_id: string | null;
  reserved_tokens: string | number;
  reserved_cost_micro_usd: string | number;
  reservation_bounded: boolean;
  updated_at: Date | string;
};

interface UsageRow extends QueryResultRow {
  event_id: string;
  operation_id: string;
  task_id: string;
  payload: unknown;
  tenant_id: string;
  api_key_id: string | null;
  profile_id: string | null;
  profile_revision: number | null;
  business_id: string;
}

interface HoldRow extends QueryResultRow {
  identity_key: string;
  reserved_tokens: string | number;
  reserved_cost_micro_usd: string | number;
  confidence: string;
  bounded: boolean;
}

interface GroupBudgetHoldRow extends QueryResultRow {
  budget_id: string;
  budget_revision: number;
  scope_key: string;
  quota_scope: unknown;
  budget_config: unknown;
  window_start: Date | string;
  window_end: Date | string;
}

function problem(status: number, code: string, message: string): HttpError {
  return new HttpError(status, code, message);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function lock(client: PoolClient, key: string): Promise<unknown> {
  return client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

function quotaWindowLockKey(scopeKey: string, from: string, to: string): string {
  // Keep this byte-identical to the legacy budget reservation service so
  // preflight, settlement, and old reservations serialize on one stable key.
  return JSON.stringify([scopeKey, from, to]);
}

async function lockGroupWindows(client: PoolClient, reservationGroupId: string): Promise<void> {
  const rows = await client.query<{ scope_key: string; window_start: Date | string; window_end: Date | string } & QueryResultRow>(
    `SELECT DISTINCT scope_key,window_start,window_end
       FROM cost_budget_holds WHERE reservation_group_id=$1
      ORDER BY scope_key,window_start,window_end`, [reservationGroupId]);
  const keys = rows.rows.map((row) => quotaWindowLockKey(
    row.scope_key,
    row.window_start instanceof Date ? row.window_start.toISOString() : new Date(row.window_start).toISOString(),
    row.window_end instanceof Date ? row.window_end.toISOString() : new Date(row.window_end).toISOString(),
  )).sort();
  for (const key of [...new Set(keys)]) await lock(client, `cost-quota:${key}`);
}

/**
 * Lock the tenant quota population before Usage inserts an event that carries
 * a reservation-group foreign key. PostgreSQL takes a KEY SHARE row lock for
 * that FK; inserting first can deadlock with preflight, which already holds
 * the tenant fence and later locks unresolved group rows while evaluating
 * held amounts. Call this before the INSERT, then settleCostReservationGroup
 * may safely repeat the idempotent advisory locks in the same transaction.
 */
export async function lockCostUsageSettlement(client: PoolClient, eventInput: UsageEvent): Promise<void> {
  const event = UsageEventSchema.parse(eventInput);
  const provenance = event.costProvenance;
  if (!provenance) return;
  const group = await client.query<{ tenant_id: string } & QueryResultRow>(
    'SELECT tenant_id::text AS tenant_id FROM cost_reservation_groups WHERE reservation_group_id=$1',
    [provenance.reservationGroupId],
  );
  if (group.rows[0]?.tenant_id !== provenance.tenantId) {
    throw problem(409, 'COST_RESERVATION_CONFLICT', 'usage event does not match a frozen reservation group');
  }
  await lock(client, `cost-policy-selection:${provenance.tenantId}`);
  await lock(client, `cost-group:${provenance.reservationGroupId}`);
}

function safeInteger(value: string | number, field: string): number {
  let parsed: bigint;
  try { parsed = BigInt(value); } catch { throw problem(503, 'COST_CONTROL_UNAVAILABLE', `stored ${field} is invalid`); }
  if (parsed < 0n || parsed > MAX_SAFE) throw problem(503, 'COST_CONTROL_UNAVAILABLE', `stored ${field} exceeds the supported range`);
  return Number(parsed);
}

function checkedAdd(left: bigint, right: number, field: string): bigint {
  const result = left + BigInt(right);
  if (result > MAX_SAFE) throw problem(503, 'COST_CONTROL_UNAVAILABLE', `cost-control ${field} exceeds the supported range`);
  return result;
}

function usageTotals(tokens = 0n, cost = 0n, count = 0) {
  if (tokens > MAX_SAFE || cost > MAX_SAFE) throw problem(503, 'COST_CONTROL_UNAVAILABLE', 'cost-control total exceeds the safe integer range');
  return {
    inputTokens: Number(tokens), outputTokens: 0, totalTokens: Number(tokens),
    totalCostMicrousd: Number(cost), eventCount: count,
  };
}

function verifyGrant(token: string, secret: Uint8Array, now: Date): GrantScope {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw problem(401, 'GRANT_INVALID', 'Connector cost grant is invalid');
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as unknown;
    payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as unknown;
  } catch { throw problem(401, 'GRANT_INVALID', 'Connector cost grant is invalid'); }
  if (!header || typeof header !== 'object' || (header as Record<string, unknown>)['alg'] !== 'HS256'
      || (header as Record<string, unknown>)['typ'] !== 'JWT') {
    throw problem(401, 'GRANT_INVALID', 'Connector cost grant is invalid');
  }
  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  let actual: Buffer;
  try { actual = Buffer.from(parts[2]!, 'base64url'); } catch { throw problem(401, 'GRANT_INVALID', 'Connector cost grant is invalid'); }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw problem(401, 'GRANT_INVALID', 'Connector cost grant is invalid');

  const providerTest = ProviderTestGrantClaimsSchema.safeParse(payload);
  const invocation = providerTest.success ? null : InvocationGrantClaimsSchema.safeParse(payload);
  const claims = providerTest.success ? providerTest.data : invocation?.success ? invocation.data : null;
  if (!claims || !claims.costContext || claims.audience !== 'connector') throw problem(401, 'GRANT_INVALID', 'Connector cost grant lacks a trusted deferred cost context');
  const context = claims.costContext;
  if (context.selectionState !== 'DEFERRED' || context.budgetPins.length !== 0 || context.priceRevision !== null) {
    throw problem(409, 'COST_CONTEXT_STALE', 'Connector grant must defer policy and price selection to preflight');
  }
  const exp = claims.exp;
  const iat = claims.iat;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (exp <= nowSeconds || iat > nowSeconds + 60 || iat < nowSeconds - 60 * 60) throw problem(401, 'GRANT_INVALID', 'Connector cost grant is expired or not yet valid');
  if (providerTest.success) {
    const test = providerTest.data;
    if (test.reservationGroupId !== context.budgetReservationGroupId) throw problem(401, 'GRANT_INVALID', 'Connector cost grant reservation group is invalid');
    return {
      tenantId: test.tenantId,
      operationId: test.operationId,
      taskId: test.taskId,
      invocationId: test.invocationId,
      stepKey: `admin-provider-test:${test.endpointSlug}`,
      bindingSlot: test.bindingSlot,
      connectorId: test.connectorId,
      connectorRevision: test.connectorRevision,
      exp, iat, costContext: context,
    };
  }
  const normal = invocation?.success ? invocation.data : null;
  if (!normal) throw problem(401, 'GRANT_INVALID', 'Connector cost grant is invalid');
  return {
    tenantId: normal.tenantId,
    operationId: normal.operationId,
    taskId: normal.taskId,
    invocationId: normal.invocationId,
    stepKey: normal.stepKey,
    bindingSlot: normal.bindingSlot,
    connectorId: normal.connectorId,
    connectorRevision: normal.connectorRevision,
    exp, iat, costContext: context,
  };
}

function assertOperationMatches(scope: GrantScope, row: OperationRow): void {
  const cost = scope.costContext;
  if (row.tenant_id !== scope.tenantId || row.api_key_id !== cost.apiKeyId || row.profile_id !== cost.profileId
      || (row.profile_revision === null ? null : Number(row.profile_revision)) !== cost.profileRevision
      || row.business_id !== cost.businessId || row.business_version !== cost.businessVersion || row.action !== cost.action
      || Number(row.attempt) !== cost.attempt) {
    throw problem(409, 'COST_CONTEXT_STALE', 'signed cost scope no longer matches the locked operation and task');
  }
}

function matchesConfig(config: ReturnType<typeof BudgetConfigSchema.parse>, scope: GrantScope['costContext'], tenantId: string): boolean {
  return config.status === 'active' && config.tenantId === tenantId
    && (config.apiKeyId === undefined || config.apiKeyId === scope.apiKeyId)
    && (config.profileId === undefined || config.profileId === scope.profileId)
    && (config.businessId === undefined || config.businessId === scope.businessId);
}

function validateBoundProof(request: CostPreflightRequest, grant: GrantScope) {
  const proof = request.proof;
  const capability = COST_BOUND_CAPABILITIES.find((item) => item.capabilityId === proof.capabilityId);
  if (!capability) return { capability: undefined, bounded: false };
  const bounded = proof.connectorId === grant.connectorId
    && proof.connectorRevision === grant.connectorRevision
    && proof.provider === capability.provider
    && proof.model === capability.model
    && proof.inputUpperBoundTokens === capability.inputContextTokens
    && proof.outputLimit !== null && proof.outputLimit > 0 && proof.outputLimit <= capability.maxOutputTokens
    && proof.outputLimitField === capability.outputLimitField
    && proof.artifactCount === 0 && !proof.hasSession && !proof.hasTools && !proof.hasUnknownUnits && proof.retryCount === 0;
  return { capability, bounded };
}

function snapshotRequest(scope: GrantScope, proof: CostPreflightRequest['proof']) {
  return {
    tenantId: scope.tenantId,
    operationId: scope.operationId,
    taskId: scope.taskId,
    invocationId: scope.invocationId,
    attempt: scope.costContext.attempt,
    connectorId: scope.connectorId,
    connectorRevision: scope.connectorRevision,
    stepKey: scope.stepKey,
    bindingSlot: scope.bindingSlot,
    proof,
  };
}

async function enqueueBudgetAlert(
  client: PoolClient,
  input: CostBudgetAlertEnqueueFacts,
): Promise<void> {
  await enqueueCostBudgetAlerts(client, CostBudgetAlertEnqueueFactsSchema.parse(input));
}

async function readCommittedUsage(
  client: PoolClient,
  scope: ReturnType<typeof quotaScopeForBudget>,
  from: string,
  to: string,
): Promise<{ totals: ReturnType<typeof usageTotals>; bounded: boolean }> {
  const rows = await client.query<UsageRow>(
    `SELECT ue.event_id,ue.operation_id::text AS operation_id,ue.task_id::text AS task_id,ue.payload,
            o.tenant_id::text AS tenant_id,o.api_key_id::text AS api_key_id,o.profile_id::text AS profile_id,
            o.profile_revision,o.business_id
       FROM usage_events ue JOIN operations o ON o.id=ue.operation_id
      WHERE o.tenant_id::text=$1 AND ($2::text IS NULL OR o.api_key_id::text=$2)
        AND ($3::text IS NULL OR o.profile_id::text=$3) AND ($4::text IS NULL OR o.business_id=$4)
        AND ((ue.payload->>'occurredAt')::timestamptz >= $5::timestamptz
          AND (ue.payload->>'occurredAt')::timestamptz < $6::timestamptz
          OR EXISTS (SELECT 1 FROM cost_budget_holds h WHERE h.usage_event_id=ue.event_id
            AND h.scope_key=$7 AND h.window_start=$5::timestamptz AND h.window_end=$6::timestamptz))
        AND NOT (ue.cost_reservation_group_id IS NOT NULL
          AND ue.payload->>'costStatus' IN ('pending','unpriced')
          AND EXISTS (SELECT 1 FROM usage_events settled
            WHERE settled.cost_reservation_group_id=ue.cost_reservation_group_id
              AND settled.payload->>'costStatus' IN ('measured','estimated')))
      ORDER BY ue.event_id`,
    [scope.tenantId, scope.apiKeyId ?? null, scope.profileId ?? null, scope.businessId ?? null, from, to, budgetQuotaScopeKey(scope)],
  );
  const effectiveCharges = await loadEffectiveCharges(client, rows.rows.map((row) => ({
    event_id: row.event_id, tenant_id: row.tenant_id, payload: row.payload,
  })));
  let tokens = 0n;
  let cost = 0n;
  let bounded = true;
  for (const row of rows.rows) {
    if (row.tenant_id !== scope.tenantId || (scope.apiKeyId !== undefined && row.api_key_id !== scope.apiKeyId)
        || (scope.profileId !== undefined && row.profile_id !== scope.profileId)
        || (scope.businessId !== undefined && row.business_id !== scope.businessId)) {
      throw problem(503, 'COST_CONTROL_UNAVAILABLE', 'usage history scope does not match its owning operation');
    }
    const parsed = UsageEventSchema.safeParse(row.payload);
    const event: UsageEvent | null = parsed.success
      ? parsed.data
      : null;
    if (!event || event.eventId !== row.event_id || event.operationId !== row.operation_id || event.taskId !== row.task_id) {
      throw problem(503, 'COST_CONTROL_UNAVAILABLE', 'usage history contains an invalid event');
    }
    const units = event.units.inputTokens + event.units.outputTokens;
    if (!Number.isSafeInteger(units)) throw problem(503, 'COST_CONTROL_UNAVAILABLE', 'usage history token total exceeds the safe range');
    tokens = checkedAdd(tokens, units, 'committed tokens');
    const effectiveCharge = effectiveCharges.get(row.event_id);
    const unknownCost = effectiveCharge?.costStatus === 'pending' || effectiveCharge?.costStatus === 'unpriced';
    const costMicrousd = effectiveCharge?.netChargeMicrousd ?? (unknownCost ? 0 : event.costMicrousd);
    cost = checkedAdd(cost, costMicrousd, 'committed cost');
    if (event.costProvenance?.confidence !== 'upper-bound' || event.costStatus === 'pending' || event.costStatus === 'unpriced') bounded = false;
  }
  return { totals: usageTotals(tokens, cost, rows.rows.length), bounded };
}

async function readHeld(
  client: PoolClient,
  scope: ReturnType<typeof quotaScopeForBudget>,
  scopeKey: string,
  from: string,
  to: string,
): Promise<{ totals: ReturnType<typeof usageTotals>; bounded: boolean }> {
  const groupRows = await client.query<HoldRow>(
    `SELECT jsonb_build_array(g.operation_id::text,g.task_id::text,g.invocation_id,g.attempt)::text AS identity_key,
            g.reserved_tokens::text AS reserved_tokens,g.reserved_cost_micro_usd::text AS reserved_cost_micro_usd,
            g.confidence,g.reservation_bounded AS bounded
       FROM cost_reservation_groups g
      WHERE g.tenant_id=$1 AND g.state IN ('RESERVED','RUNNING','UNKNOWN','PENDING')
        AND ($2::text IS NULL OR g.scope_snapshot->>'apiKeyId'=$2)
        AND ($3::text IS NULL OR g.scope_snapshot->>'profileId'=$3)
        AND ($4::text IS NULL OR g.scope_snapshot->>'businessId'=$4)
      ORDER BY g.operation_id,g.task_id,g.invocation_id,g.attempt,g.reservation_group_id
      FOR UPDATE OF g`,
    [scope.tenantId, scope.apiKeyId ?? null, scope.profileId ?? null, scope.businessId ?? null],
  );
  const legacyRows = await client.query<HoldRow>(
    `SELECT jsonb_build_array(operation_id::text,task_id::text,invocation_id,attempt)::text AS identity_key,
            reserved_tokens::text AS reserved_tokens,reserved_cost_micro_usd::text AS reserved_cost_micro_usd,
            confidence,(confidence='upper-bound') AS bounded
       FROM budget_reservations WHERE scope_key=$1 AND window_start=$2 AND window_end=$3
        AND status IN ('RESERVED','RUNNING','UNKNOWN')
      ORDER BY operation_id,task_id,invocation_id,attempt,reservation_id FOR UPDATE`,
    [scopeKey, from, to],
  );
  let tokens = 0n;
  let cost = 0n;
  let bounded = true;
  const logicalHolds = new Map<string, { tokens: number; cost: number; confidence: string; bounded: boolean }>();
  for (const row of [...groupRows.rows, ...legacyRows.rows]) {
    const rowTokens = safeInteger(row.reserved_tokens, 'held tokens');
    const rowCost = safeInteger(row.reserved_cost_micro_usd, 'held cost');
    const previous = logicalHolds.get(row.identity_key);
    if (previous) {
      if (previous.tokens !== rowTokens || previous.cost !== rowCost || previous.confidence !== row.confidence || previous.bounded !== row.bounded) {
        throw problem(503, 'COST_CONTROL_UNAVAILABLE', 'overlapping held reservations disagree for one invocation');
      }
      continue;
    }
    logicalHolds.set(row.identity_key, { tokens: rowTokens, cost: rowCost, confidence: row.confidence, bounded: row.bounded });
  }
  for (const row of logicalHolds.values()) {
    tokens = checkedAdd(tokens, row.tokens, 'held tokens');
    cost = checkedAdd(cost, row.cost, 'held cost');
    if (!row.bounded || row.confidence !== 'upper-bound') bounded = false;
  }
  return { totals: usageTotals(tokens, cost, logicalHolds.size), bounded };
}

function costReserve(inputTokens: number, outputTokens: number, tier: ModelPricingTier): number {
  try {
    const ceilBill = (units: number, rate: number) => (BigInt(units) * BigInt(rate) + 999_999n) / 1_000_000n;
    const inputRate = Math.max(tier.inputMicrousdPerMillion, tier.cachedInputMicrousdPerMillion ?? 0);
    const total = ceilBill(inputTokens, inputRate) + ceilBill(outputTokens, tier.outputMicrousdPerMillion);
    if (total > MAX_SAFE) throw new RangeError('reservation estimate exceeds safe integer range');
    return Number(total);
  } catch {
    throw problem(422, 'BUDGET_BOUND_UNSUPPORTED', 'the selected pricing tier cannot safely price this invocation bound');
  }
}

/** Resolve an exact provider tier first, then a genuinely provider-agnostic
 * tier. The returned snapshot always carries the actual provider so later
 * usage settlement can compare exact attribution without re-reading prices. */
export function resolvePricingTierForActualProvider(
  tiers: readonly ModelPricingTier[],
  query: { modelId: string; provider: string; at: string },
): ModelPricingTier | undefined {
  const exact = resolvePricingTier(tiers, query);
  if (exact) return exact;
  const providerAgnostic = resolvePricingTier(
    tiers.filter((tier) => tier.provider === undefined),
    { modelId: query.modelId, at: query.at },
  );
  if (!providerAgnostic) return undefined;
  return ModelPricingTierSchema.parse({ ...providerAgnostic, provider: query.provider });
}

function timestampForAlert(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw problem(503, 'COST_CONTROL_UNAVAILABLE', 'stored quota window timestamp is invalid');
  return parsed.toISOString();
}

async function enqueueSettlementAlerts(
  client: PoolClient,
  event: UsageEvent,
  group: GroupRow,
  frozen: CostPreflightResponse,
): Promise<void> {
  const holds = await client.query<GroupBudgetHoldRow>(
    `SELECT budget_id::text AS budget_id,budget_revision,scope_key,quota_scope,budget_config,window_start,window_end
       FROM cost_budget_holds WHERE reservation_group_id=$1 ORDER BY scope_key,window_start,window_end,budget_id`,
    [group.reservation_group_id],
  );
  for (const hold of holds.rows) {
    const config = BudgetConfigSchema.safeParse(hold.budget_config);
    if (!config.success) throw problem(503, 'COST_CONTROL_UNAVAILABLE', 'pinned budget config is invalid during settlement');
    const scope = quotaScopeForBudget(config.data);
    const windowStart = timestampForAlert(hold.window_start);
    const windowEnd = timestampForAlert(hold.window_end);
    const committed = await readCommittedUsage(client, scope, windowStart, windowEnd);
    const held = await readHeld(client, scope, hold.scope_key, windowStart, windowEnd);
    const evaluated = evaluateBudgetStatus(config.data, committed.totals, held.totals);
    const original = frozen.evaluations.find((item) => item.budgetId === hold.budget_id && item.revision === Number(hold.budget_revision));
    if (!original) throw problem(503, 'COST_CONTROL_UNAVAILABLE', 'settlement budget does not match its frozen preflight evaluation');
    const trustReasonCode = !committed.bounded
      ? 'USAGE_BASIS_UNBOUNDED'
      : !held.bounded
        ? 'RESERVATION_BASIS_UNBOUNDED'
        : original.trustReasonCode;
    const hardCapEnabled = config.data.policy === 'block-new-invocations'
      && original.hardCapEnabled && committed.bounded && held.bounded;
    const confidence = trustReasonCode === null ? group.confidence : 'best-effort';
    await enqueueBudgetAlert(client, {
      tenantId: group.tenant_id,
      budgetId: hold.budget_id,
      budgetRevision: Number(hold.budget_revision),
      quotaScopeKey: hold.scope_key,
      windowStart,
      windowEnd,
      source: 'settlement',
      sourceEventKey: `settlement:${group.reservation_group_id}:${event.eventId}:${hold.budget_id}:${hold.budget_revision}`,
      reservationGroupId: group.reservation_group_id,
      operationId: group.operation_id,
      taskId: group.task_id,
      invocationId: group.invocation_id,
      attempt: Number(group.attempt),
      usageEventId: event.eventId,
      evaluation: {
        action: evaluated.action,
        hardCapEnabled,
        warnThresholdExceeded: evaluated.warnThresholdExceeded,
        usagePercent: evaluated.usagePercent,
        limitExceeded: evaluated.limitExceeded,
        remainingTokens: evaluated.remainingTokens,
        remainingCostMicrousd: evaluated.remainingCostMicrousd,
      },
      trust: { confidence, reasonCode: trustReasonCode },
    });
  }
}

export interface CostReservationGroupService {
  preflight(input: unknown): Promise<CostPreflightResponse>;
  transitionGroup(input: unknown): Promise<CostReservationGroupAck>;
}

export function createCostReservationGroupService(
  db: Db,
  options: {
    invocationGrantSecret: string | Uint8Array;
    backupSnapshotWriteGate?: BackupSnapshotWriteGate;
    now?: () => Date;
  },
): CostReservationGroupService {
  const grantSecret = typeof options.invocationGrantSecret === 'string'
    ? Buffer.from(options.invocationGrantSecret, 'utf8')
    : Buffer.from(options.invocationGrantSecret);
  if (grantSecret.byteLength < 32) throw new Error('INVOCATION_GRANT_SECRET must contain at least 32 bytes for cost preflight.');
  const now = options.now ?? (() => new Date());
  const assertWriteGate = async (client: PoolClient, tenantId: string, identity: unknown): Promise<void> => {
    if (!options.backupSnapshotWriteGate) {
      throw problem(503, 'BACKUP_WRITE_GATE_UNAVAILABLE', 'usage settlement requires the backup snapshot write gate');
    }
    await options.backupSnapshotWriteGate.assertWriteAllowed(client, {
      tenantId,
      domain: 'usage-settlement',
      requestKey: sha256(identity),
    });
  };

  return {
    async preflight(input) {
      const parsed = CostPreflightRequestSchema.safeParse(input);
      if (!parsed.success) throw new HttpError(422, 'INVALID_SCHEMA', 'cost preflight request is invalid');
      const request = parsed.data;
      const selectedAt = now();
      if (!Number.isFinite(selectedAt.getTime())) throw problem(503, 'COST_CONTROL_UNAVAILABLE', 'cost preflight clock is invalid');
      const grant = verifyGrant(request.grant, grantSecret, selectedAt);
      const context = grant.costContext;
      const groupId = context.budgetReservationGroupId;
      const proofCheck = validateBoundProof(request, grant);
      const requestHash = sha256(snapshotRequest(grant, request.proof));

      return db.tx(async (client) => {
        await assertWriteGate(client, grant.tenantId, {
          purpose: 'cost-preflight', reservationGroupId: groupId, requestHash,
        });
        // This tenant-scoped fence is the first lock used by every mutation
        // which can change the quota population (publication, preflight,
        // settlement, release, and UNKNOWN transitions). Acquiring it before
        // the group lock keeps the lock order consistent with settlement and
        // prevents a group↔policy lock cycle under concurrent admission.
        await lock(client, `cost-policy-selection:${grant.tenantId}`);
        await lock(client, `cost-group:${groupId}`);
        const existing = await client.query<GroupRow>(
          `SELECT reservation_group_id::text AS reservation_group_id,tenant_id::text AS tenant_id,
                  operation_id::text AS operation_id,task_id::text AS task_id,invocation_id,attempt,
                  request_hash,decision,state,frozen_response,updated_at
             FROM cost_reservation_groups WHERE reservation_group_id=$1 FOR UPDATE`, [groupId]);
        if (existing.rows[0]) {
          const row = existing.rows[0];
          if (row.tenant_id !== grant.tenantId || row.request_hash !== requestHash || row.operation_id !== grant.operationId || row.task_id !== grant.taskId
              || row.invocation_id !== grant.invocationId || Number(row.attempt) !== context.attempt) {
            throw problem(409, 'COST_RESERVATION_CONFLICT', 'reservation group was already frozen for different invocation proof');
          }
          return CostPreflightResponseSchema.parse(row.frozen_response);
        }

        const operationResult = await client.query<OperationRow>(
          `SELECT o.tenant_id::text AS tenant_id,o.api_key_id::text AS api_key_id,o.profile_id::text AS profile_id,
                  o.profile_revision,o.business_id,o.business_version,o.action,t.attempt
             FROM operations o JOIN tasks t ON t.operation_id=o.id
            WHERE o.id=$1 AND t.id=$2 FOR UPDATE OF o,t`, [grant.operationId, grant.taskId]);
        const operation = operationResult.rows[0];
        if (!operation) throw problem(404, 'NOT_FOUND', 'cost invocation operation or task was not found');
        assertOperationMatches(grant, operation);

        // Publish/retire and preflight serialize at tenant and global price-book
        // scope. Thus the stored selection is one immutable current snapshot.
        await lock(client, 'cost-price:head');
        const budgetRows = await client.query<BudgetHeadRow>(
          `SELECT h.tenant_id::text AS tenant_id,h.budget_id::text AS budget_id,h.active_revision,r.config
             FROM cost_budget_heads h JOIN cost_budget_revisions r
               ON r.tenant_id=h.tenant_id AND r.budget_id=h.budget_id AND r.revision=h.active_revision
            WHERE h.tenant_id=$1 AND h.active_revision IS NOT NULL AND r.state='PUBLISHED'
            ORDER BY h.budget_id FOR SHARE OF h,r`, [grant.tenantId]);
        const budgets: EffectiveBudgetPin[] = [];
        for (const row of budgetRows.rows) {
          const config = BudgetConfigSchema.safeParse(row.config);
          if (!config.success || config.data.tenantId !== grant.tenantId) throw problem(503, 'COST_CONTROL_UNAVAILABLE', 'published budget revision is invalid');
          if (!matchesConfig(config.data, context, grant.tenantId)) continue;
          const quotaScope = quotaScopeForBudget(config.data);
          const window = resolveBudgetQuotaWindow(config.data.period, selectedAt);
          budgets.push({
            budgetId: row.budget_id,
            revision: Number(row.active_revision),
            config: config.data,
            quotaScopeKey: budgetQuotaScopeKey(quotaScope),
            periodStart: window.from,
            periodEnd: window.to,
          });
        }
        budgets.sort((a, b) => a.quotaScopeKey.localeCompare(b.quotaScopeKey) || a.budgetId.localeCompare(b.budgetId));
        const blockPolicies = budgets.filter((pin) => pin.config.policy === 'block-new-invocations');

        const priceHead = await client.query<{ active_revision: number | null }>(
          'SELECT active_revision FROM cost_price_heads WHERE singleton=true FOR SHARE');
        const priceRevisionValue = priceHead.rows[0]?.active_revision;
        let priceRevision: number | null = null;
        let pricingTier: ModelPricingTier | null = null;
        if (priceRevisionValue !== null && priceRevisionValue !== undefined) {
          const row = await client.query<PriceRevisionRow>(
            `SELECT revision,tiers FROM cost_price_revisions WHERE revision=$1 AND state='PUBLISHED' FOR SHARE`, [priceRevisionValue]);
          if (!row.rows[0]) throw problem(503, 'COST_CONTROL_UNAVAILABLE', 'active price head has no published revision');
          const tiers = ModelPricingTableSchema.safeParse(row.rows[0].tiers);
          if (!tiers.success) throw problem(503, 'COST_CONTROL_UNAVAILABLE', 'published price revision is invalid');
          pricingTier = resolvePricingTierForActualProvider(tiers.data, {
            modelId: request.proof.model,
            provider: request.proof.provider,
            at: selectedAt.toISOString(),
          }) ?? null;
          if (pricingTier) priceRevision = Number(row.rows[0].revision);
        }

        const fullyBound = proofCheck.bounded && proofCheck.capability !== undefined && pricingTier !== null;
        if (blockPolicies.length > 0 && !fullyBound) {
          throw problem(422, 'BUDGET_BOUND_UNSUPPORTED', 'block policy requires a trusted exact-provider input/output and price bound');
        }
        const confidence: 'upper-bound' | 'best-effort' = fullyBound ? 'upper-bound' : 'best-effort';
        // The top-level flag means this selected set has an enforceable
        // blocking policy and the current invocation can be fully reserved.
        // A per-budget flag below additionally checks its committed/held basis.
        const hardCapEnabled = blockPolicies.length > 0 && fullyBound;
        const reservedTokens = proofCheck.bounded && proofCheck.capability && request.proof.outputLimit !== null
          ? proofCheck.capability.inputContextTokens + request.proof.outputLimit
          : 0;
        const reservedCost = fullyBound && pricingTier && request.proof.outputLimit !== null
          ? costReserve(proofCheck.capability!.inputContextTokens, request.proof.outputLimit, pricingTier)
          : 0;

        // Stable lock order across every matching parent/child policy.
        const quotaLockKeys = [...new Set(budgets.map((pin) => quotaWindowLockKey(pin.quotaScopeKey, pin.periodStart, pin.periodEnd)))].sort();
        for (const key of quotaLockKeys) {
          await lock(client, `cost-quota:${key}`);
        }
        const evaluations: CostPreflightResponse['evaluations'][number][] = [];
        let decision: 'ADMITTED' | 'BLOCKED' = 'ADMITTED';
        for (const pin of budgets) {
          const scope = quotaScopeForBudget(pin.config);
          const usage = await readCommittedUsage(client, scope, pin.periodStart, pin.periodEnd);
          // Logical groups are matched against the newly selected policy scope,
          // even if they began with no budget/child hold or under an older
          // policy window. Child rows remain immutable audit pins; they are not
          // the only source of the current unresolved held basis.
          const held = await readHeld(client, scope, pin.quotaScopeKey, pin.periodStart, pin.periodEnd);
          if (pin.config.policy === 'block-new-invocations' && (!usage.bounded || !held.bounded || !fullyBound)) {
            throw problem(422, 'BUDGET_BOUND_UNSUPPORTED', 'existing usage or reservations do not provide a verified hard-cap basis');
          }
          const reservation = usageTotals(
            BigInt(held.totals.totalTokens) + BigInt(reservedTokens),
            BigInt(held.totals.totalCostMicrousd) + BigInt(reservedCost),
            held.totals.eventCount + (reservedTokens > 0 || reservedCost > 0 ? 1 : 0),
          );
          const evaluation = evaluateBudgetStatus(pin.config, usage.totals, reservation);
          if (evaluation.action === 'BLOCK') decision = 'BLOCKED';
          evaluations.push({
            budgetId: pin.budgetId,
            revision: pin.revision,
            action: evaluation.action,
            hardCapEnabled: pin.config.policy === 'block-new-invocations' && fullyBound && usage.bounded && held.bounded,
            warnThresholdExceeded: evaluation.warnThresholdExceeded,
            usagePercent: evaluation.usagePercent,
            limitExceeded: evaluation.limitExceeded,
            remainingTokens: evaluation.remainingTokens,
            remainingCostMicrousd: evaluation.remainingCostMicrousd,
            trustReasonCode: !fullyBound
              ? (!proofCheck.bounded || !proofCheck.capability ? 'BOUND_UNSUPPORTED' : 'PRICE_UNAVAILABLE')
              : !usage.bounded
                ? 'USAGE_BASIS_UNBOUNDED'
                : !held.bounded
                  ? 'RESERVATION_BASIS_UNBOUNDED'
                  : null,
          });
        }
        const frozen = CostPreflightResponseSchema.parse({
          decision,
          selection: {
            state: 'FROZEN',
            reservationGroupId: groupId,
            selectedAt: selectedAt.toISOString(),
            priceRevision,
            pricingTier,
            budgetPins: budgets.map(({ budgetId, revision }) => ({ budgetId, revision })),
          },
          confidence,
          hardCapEnabled,
          evaluations,
        });
        const state = decision === 'BLOCKED' ? 'BLOCKED' : 'RESERVED';
        const scopeSnapshot = {
          tenantId: operation.tenant_id,
          apiKeyId: operation.api_key_id,
          profileId: operation.profile_id,
          profileRevision: operation.profile_revision === null ? null : Number(operation.profile_revision),
          businessId: operation.business_id,
          businessVersion: operation.business_version,
          action: operation.action,
          attempt: Number(operation.attempt),
        };
        await client.query(
          `INSERT INTO cost_reservation_groups
            (reservation_group_id,tenant_id,operation_id,task_id,invocation_id,attempt,scope_snapshot,
             reserved_tokens,reserved_cost_micro_usd,reservation_bounded,request_hash,decision,state,confidence,
             hard_cap_enabled,price_revision,pricing_tier,selected_at,evaluations,frozen_response)
           VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19::jsonb,$20::jsonb)`,
          [groupId, grant.tenantId, grant.operationId, grant.taskId, grant.invocationId, context.attempt,
            JSON.stringify(scopeSnapshot), String(reservedTokens), String(reservedCost), fullyBound,
            requestHash, decision, state, confidence, hardCapEnabled, priceRevision, JSON.stringify(pricingTier),
            selectedAt.toISOString(), JSON.stringify(evaluations), JSON.stringify(frozen)]);
        if (decision === 'ADMITTED' && (reservedTokens > 0 || reservedCost > 0)) {
          for (const pin of budgets) {
            const config = pin.config;
            const quotaScope = quotaScopeForBudget(config);
            await client.query(
              `INSERT INTO cost_budget_holds
                (reservation_group_id,tenant_id,budget_id,budget_revision,scope_key,quota_scope,budget_config,period,
                 window_start,window_end,reserved_tokens,reserved_cost_micro_usd,state)
               VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,'RESERVED')`,
              [groupId, grant.tenantId, pin.budgetId, pin.revision, pin.quotaScopeKey, JSON.stringify(quotaScope),
                JSON.stringify(config), config.period, pin.periodStart, pin.periodEnd, String(reservedTokens), String(reservedCost)]);
          }
        }
        for (const evaluation of evaluations) {
          const pin = budgets.find((item) => item.budgetId === evaluation.budgetId && item.revision === evaluation.revision);
          if (!pin) throw problem(503, 'COST_CONTROL_UNAVAILABLE', 'cost alert evaluation lost its selected budget pin');
          await enqueueBudgetAlert(client, {
            tenantId: grant.tenantId,
            budgetId: pin.budgetId,
            budgetRevision: pin.revision,
            quotaScopeKey: pin.quotaScopeKey,
            windowStart: pin.periodStart,
            windowEnd: pin.periodEnd,
            source: 'preflight',
            sourceEventKey: `preflight:${groupId}:${pin.budgetId}:${pin.revision}`,
            reservationGroupId: groupId,
            operationId: grant.operationId,
            taskId: grant.taskId,
            invocationId: grant.invocationId,
            attempt: context.attempt,
            evaluation: {
              action: evaluation.action,
              hardCapEnabled: evaluation.hardCapEnabled,
              warnThresholdExceeded: evaluation.warnThresholdExceeded,
              usagePercent: evaluation.usagePercent,
              limitExceeded: evaluation.limitExceeded,
              remainingTokens: evaluation.remainingTokens,
              remainingCostMicrousd: evaluation.remainingCostMicrousd,
            },
            trust: {
              confidence: evaluation.trustReasonCode === null ? confidence : 'best-effort',
              reasonCode: evaluation.trustReasonCode,
            },
          });
        }
        return frozen;
      });
    },

    async transitionGroup(input) {
      const parsed = CostReservationGroupTransitionSchema.safeParse(input);
      if (!parsed.success) throw new HttpError(422, 'INVALID_SCHEMA', 'cost reservation transition is invalid');
      const command: CostReservationGroupTransition = parsed.data;
      const nowValue = now();
      const grant = verifyGrant(command.grant, grantSecret, nowValue);
      if (grant.costContext.budgetReservationGroupId !== command.reservationGroupId
          || grant.operationId !== command.operationId || grant.taskId !== command.taskId
          || grant.invocationId !== command.invocationId || grant.costContext.attempt !== command.attempt) {
        throw problem(403, 'PERMISSION_DENIED', 'cost transition does not match the signed invocation grant');
      }
      return db.tx(async (client) => {
        const initial = await client.query<{ tenant_id: string } & QueryResultRow>(
          'SELECT tenant_id::text AS tenant_id FROM cost_reservation_groups WHERE reservation_group_id=$1',
          [command.reservationGroupId]);
        const tenantId = initial.rows[0]?.tenant_id;
        if (!tenantId || tenantId !== grant.tenantId) throw problem(404, 'NOT_FOUND', 'cost reservation group was not found');
        await assertWriteGate(client, tenantId, {
          purpose: 'cost-group-transition', reservationGroupId: command.reservationGroupId,
          operationId: command.operationId, taskId: command.taskId, invocationId: command.invocationId,
          attempt: command.attempt, target: command.target,
        });
        // Match preflight's order: tenant policy-selection -> quota windows ->
        // logical group rows. This closes settle/release-vs-admit read races.
        await lock(client, `cost-policy-selection:${tenantId}`);
        await lock(client, `cost-group:${command.reservationGroupId}`);
        const selected = await client.query<GroupRow>(
          `SELECT reservation_group_id::text AS reservation_group_id,tenant_id::text AS tenant_id,
                  operation_id::text AS operation_id,task_id::text AS task_id,invocation_id,attempt,
                  request_hash,decision,state,frozen_response,updated_at
             FROM cost_reservation_groups WHERE reservation_group_id=$1 FOR UPDATE`, [command.reservationGroupId]);
        const group = selected.rows[0];
        if (!group || group.tenant_id !== grant.tenantId || group.operation_id !== command.operationId
            || group.task_id !== command.taskId || group.invocation_id !== command.invocationId
            || Number(group.attempt) !== command.attempt) throw problem(404, 'NOT_FOUND', 'cost reservation group was not found');
        await lockGroupWindows(client, command.reservationGroupId);

        const current = group.state;
        let next: GroupRow['state'] = current;
        if (command.target === 'RUNNING') {
          if (current === 'RESERVED') next = 'RUNNING';
          else if (current !== 'RUNNING') throw problem(409, 'COST_RESERVATION_CONFLICT', 'only an admitted reservation may enter RUNNING');
        } else if (command.target === 'UNKNOWN') {
          if (current === 'RESERVED' || current === 'RUNNING') next = 'UNKNOWN';
          else if (current !== 'UNKNOWN') throw problem(409, 'COST_RESERVATION_CONFLICT', 'only an unresolved provider call may enter UNKNOWN');
        } else {
          if (current === 'RESERVED' || current === 'RUNNING') next = 'RELEASED';
          else if (current !== 'RELEASED') throw problem(409, 'COST_RESERVATION_CONFLICT', 'only an unresolved no-effect invocation can be released');
        }
        if (next !== current) {
          await client.query('UPDATE cost_reservation_groups SET state=$2,state_reason=$3,updated_at=$4 WHERE reservation_group_id=$1',
            [command.reservationGroupId, next, command.reasonCode ?? null, nowValue.toISOString()]);
          await client.query('UPDATE cost_budget_holds SET state=$2 WHERE reservation_group_id=$1',
            [command.reservationGroupId, next]);
        }
        return CostReservationGroupAckSchema.parse({
          reservationGroupId: command.reservationGroupId,
          state: next,
          updatedAt: nowValue.toISOString(),
        });
      });
    },
  };
}

/** Settle the exact reservation group in the same transaction that stores its
 * immutable usage event. Pending usage remains held until a real settlement. */
export async function settleCostReservationGroup(client: PoolClient, eventInput: UsageEvent): Promise<void> {
  const event = UsageEventSchema.parse(eventInput);
  const provenance = event.costProvenance;
  if (!provenance) return;
  // Usage ingest acquires these before its event INSERT (and therefore before
  // PostgreSQL takes the event's reservation-group FK lock). Repeating the
  // transaction-scoped advisory locks here is harmless and keeps this helper
  // safe for any future caller that has already staged the event row.
  await lockCostUsageSettlement(client, event);
  const selected = await client.query<GroupRow>(
    `SELECT reservation_group_id::text AS reservation_group_id,tenant_id::text AS tenant_id,
            operation_id::text AS operation_id,task_id::text AS task_id,invocation_id,attempt,
            request_hash,decision,state,confidence,hard_cap_enabled,frozen_response,usage_event_id,
            reserved_tokens,reserved_cost_micro_usd,reservation_bounded,updated_at
       FROM cost_reservation_groups WHERE reservation_group_id=$1 FOR UPDATE`, [provenance.reservationGroupId]);
  const group = selected.rows[0];
  if (!group || group.tenant_id !== provenance.tenantId || group.operation_id !== event.operationId
      || group.task_id !== event.taskId || group.invocation_id !== event.invocationId
      || Number(group.attempt) !== provenance.attempt) {
    throw problem(409, 'COST_RESERVATION_CONFLICT', 'usage event does not match a frozen reservation group');
  }
  await lockGroupWindows(client, provenance.reservationGroupId);
  const frozen = CostPreflightResponseSchema.parse(group.frozen_response);
  const expectedPins = frozen.selection.budgetPins;
  if (canonicalize(expectedPins) !== canonicalize(provenance.budgetPins)
      || frozen.selection.priceRevision !== provenance.priceRevision
      || canonicalize(frozen.selection.pricingTier) !== canonicalize(provenance.priceSnapshot ? {
        provider: provenance.priceSnapshot.provider,
        modelId: provenance.priceSnapshot.modelId,
        priceVersion: provenance.priceSnapshot.priceVersion,
        effectiveFrom: provenance.priceSnapshot.effectiveFrom,
        effectiveTo: provenance.priceSnapshot.effectiveTo,
        currency: provenance.priceSnapshot.currency,
        inputMicrousdPerMillion: provenance.priceSnapshot.inputMicrousdPerMillion,
        outputMicrousdPerMillion: provenance.priceSnapshot.outputMicrousdPerMillion,
        cachedInputMicrousdPerMillion: provenance.priceSnapshot.cachedInputMicrousdPerMillion,
        pageMicrousdPerPage: provenance.priceSnapshot.pageMicrousdPerPage,
      } : null)) {
    throw problem(409, 'COST_RESERVATION_CONFLICT', 'usage event price or budget pins differ from the frozen preflight selection');
  }
  if (event.provider !== undefined && provenance.costBoundCapabilityId !== null && event.provider !== frozen.selection.pricingTier?.provider) {
    throw problem(409, 'COST_RESERVATION_CONFLICT', 'usage provider differs from the frozen cost bound');
  }
  if (event.costStatus === 'pending' || event.costStatus === 'unpriced') {
    if (group.state === 'SETTLED') return;
    if (group.state === 'RELEASED' || group.state === 'BLOCKED') {
      throw problem(409, 'COST_RESERVATION_CONFLICT', 'released or blocked reservation cannot receive provider usage');
    }
    await client.query('UPDATE cost_reservation_groups SET state=$2,usage_event_id=$3,updated_at=now() WHERE reservation_group_id=$1',
      [provenance.reservationGroupId, 'PENDING', event.eventId]);
    await client.query("UPDATE cost_budget_holds SET state='PENDING',usage_event_id=$2 WHERE reservation_group_id=$1",
      [provenance.reservationGroupId, event.eventId]);
    await enqueueSettlementAlerts(client, event, group, frozen);
    return;
  }
  if (group.state === 'SETTLED') {
    if (group.usage_event_id !== event.eventId) throw problem(409, 'COST_RESERVATION_CONFLICT', 'reservation group was settled by a different usage event');
    return;
  }
  if (!['RESERVED', 'RUNNING', 'UNKNOWN', 'PENDING'].includes(group.state)) {
    throw problem(409, 'COST_RESERVATION_CONFLICT', 'reservation group is not settleable');
  }
  await client.query('UPDATE cost_reservation_groups SET state=$2,usage_event_id=$3,updated_at=now() WHERE reservation_group_id=$1',
    [provenance.reservationGroupId, 'SETTLED', event.eventId]);
  await client.query("UPDATE cost_budget_holds SET state='SETTLED',usage_event_id=$2 WHERE reservation_group_id=$1",
    [provenance.reservationGroupId, event.eventId]);
  await enqueueSettlementAlerts(client, event, group, frozen);
}
