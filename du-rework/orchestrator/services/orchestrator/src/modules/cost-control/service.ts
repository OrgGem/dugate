import { createHash, randomUUID } from 'node:crypto';
import {
  BudgetConfigSchema,
  BudgetDraftWriteSchema,
  CostControlBudgetDetailSchema,
  CostControlBudgetListSchema,
  CostControlPriceListSchema,
  CostPolicyRollbackRequestSchema,
  CostPolicyTransitionRequestSchema,
  ModelPricingTableSchema,
  PersistedBudgetRevisionSchema,
  PersistedPriceRevisionSchema,
  PriceDraftWriteSchema,
  canonicalize,
  type BudgetDraftWrite,
  type CostPreflightResponse,
  type CostReservationGroupAck,
  type CostControlBudgetDetail,
  type CostControlBudgetList,
  type CostControlPriceList,
  type CostPolicyRollbackRequest,
  type CostPolicyTransitionRequest,
  type PersistedBudgetRevision,
  type PersistedPriceRevision,
  type PriceDraftWrite,
} from '@du/contracts';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Db } from '../../db/db';
import { HttpError, zodIssuesToProblem } from '../../http/errors';
import type { AuditService } from '../audit/audit';
import type { BackupSnapshotWriteGate } from '../maintenance/backup-effect-fence';
import { createCostReservationGroupService } from './reservation-groups';

export interface CostControlActor {
  label: string;
  /** Stable private command scope key; never projected to Admin DTOs/audit labels. */
  identityKey?: string;
  issuer?: string;
  sub?: string;
  role?: string;
}

export interface CostControlService {
  preflight(input: unknown): Promise<CostPreflightResponse>;
  transitionGroup(input: unknown): Promise<CostReservationGroupAck>;
  listBudgets(tenantId: string): Promise<CostControlBudgetList>;
  getBudget(tenantId: string, budgetId: string): Promise<CostControlBudgetDetail>;
  createBudgetDraft(input: unknown, actor: CostControlActor, idempotencyKey?: string): Promise<PersistedBudgetRevision>;
  transitionBudget(budgetId: string, action: 'review' | 'publish' | 'retire', input: unknown, actor: CostControlActor, idempotencyKey?: string, tenantId?: string): Promise<PersistedBudgetRevision>;
  rollbackBudget(budgetId: string, input: unknown, actor: CostControlActor, idempotencyKey?: string, tenantId?: string): Promise<PersistedBudgetRevision>;
  getPrices(): Promise<CostControlPriceList>;
  createPriceDraft(input: unknown, actor: CostControlActor, idempotencyKey?: string): Promise<PersistedPriceRevision>;
  transitionPrice(action: 'review' | 'publish' | 'retire', input: unknown, actor: CostControlActor, idempotencyKey?: string): Promise<PersistedPriceRevision>;
  rollbackPrice(input: unknown, actor: CostControlActor, idempotencyKey?: string): Promise<PersistedPriceRevision>;
}

interface BudgetHeadRow extends QueryResultRow { tenant_id: string; budget_id: string; head_revision: number; active_revision: number | null; }
interface BudgetRevisionRow extends QueryResultRow { tenant_id: string; budget_id: string; revision: number; state: string; config: unknown; content_digest: string; actor: string; created_at: Date | string; published_at: Date | string | null; }
interface PriceHeadRow extends QueryResultRow { head_revision: number; active_revision: number | null; }
interface PriceRevisionRow extends QueryResultRow { revision: number; state: string; tiers: unknown; content_digest: string; actor: string; created_at: Date | string; published_at: Date | string | null; }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_HISTORY = 100;
function safeActorLabel(value: string): string {
  // Older rows used session:<OIDC sub> or shell:<role> and those labels were
  // projected to Admin clients. Keep the database/audit history intact while
  // masking ambiguous legacy attribution at this typed DTO boundary.
  return /^(?:session|shell):/i.test(value) ? 'legacy-admin' : value;
}
function invalid(message: string): never { throw new HttpError(422, 'INVALID_SCHEMA', message); }
function conflict(message: string): never { throw new HttpError(409, 'STATE_CONFLICT', message); }
function asIso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new HttpError(503, 'COST_CONTROL_UNAVAILABLE', 'stored cost revision timestamp is invalid');
  return date.toISOString();
}
function digest(value: unknown): string { return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`; }
function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: (string | number)[]; message: string }> } } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw zodIssuesToProblem(result.error.issues);
  return result.data;
}
function budgetRevision(row: BudgetRevisionRow): PersistedBudgetRevision {
  return parse(PersistedBudgetRevisionSchema, {
    budgetId: row.budget_id,
    revision: Number(row.revision),
    state: row.state,
    config: row.config,
    contentDigest: row.content_digest,
    actor: safeActorLabel(row.actor),
    createdAt: asIso(row.created_at),
    publishedAt: asIso(row.published_at),
  });
}
function priceRevision(row: PriceRevisionRow): PersistedPriceRevision {
  return parse(PersistedPriceRevisionSchema, {
    revision: Number(row.revision),
    state: row.state,
    tiers: row.tiers,
    contentDigest: row.content_digest,
    actor: safeActorLabel(row.actor),
    createdAt: asIso(row.created_at),
    publishedAt: asIso(row.published_at),
  });
}
async function lock(client: PoolClient, key: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}
async function readCommandReplay<T>(client: PoolClient, scope: string, key: string | undefined, requestHash: string): Promise<T | undefined> {
  if (!key) return undefined;
  await lock(client, `cost-command:${scope}:${key}`);
  const prior = await client.query<{ request_hash: string; result: T } & QueryResultRow>(
    'SELECT request_hash,result FROM cost_control_commands WHERE scope_key=$1 AND idempotency_key=$2 FOR UPDATE', [scope, key]);
  if (!prior.rows[0]) return undefined;
  if (prior.rows[0].request_hash !== requestHash) conflict('Idempotency-Key was already used for a different cost policy command');
  return prior.rows[0].result;
}
async function saveCommand(client: PoolClient, scope: string, key: string | undefined, requestHash: string, result: unknown): Promise<void> {
  if (!key) return;
  await client.query(
    'INSERT INTO cost_control_commands(scope_key,idempotency_key,request_hash,result) VALUES($1,$2,$3,$4::jsonb)',
    [scope, key, requestHash, JSON.stringify(result)]);
}
function requireUuid(value: string, field: string): void { if (!UUID.test(value)) invalid(`${field} must be a UUID`); }
function budgetResult(value: unknown): PersistedBudgetRevision {
  const parsed = parse(PersistedBudgetRevisionSchema, value);
  return { ...parsed, actor: safeActorLabel(parsed.actor) };
}
function priceResult(value: unknown): PersistedPriceRevision {
  const parsed = parse(PersistedPriceRevisionSchema, value);
  return { ...parsed, actor: safeActorLabel(parsed.actor) };
}
function requireActor(actor: CostControlActor): void {
  if (!actor || typeof actor.label !== 'string' || actor.label.length < 1 || actor.label.length > 128) invalid('trusted actor is required');
}
function actorScope(actor: CostControlActor): string {
  return actor.identityKey && /^[a-f0-9]{64}$/.test(actor.identityKey) ? actor.identityKey : actor.label;
}
async function audit(auditService: AuditService | undefined, client: PoolClient, actor: CostControlActor, tenantId: string | null, action: string, resource: string): Promise<void> {
  if (!auditService) throw new HttpError(503, 'COST_CONTROL_AUDIT_UNAVAILABLE', 'cost policy changes require an audit ledger');
  await auditService.record({
    tenantId,
    actor: actor.label,
    ...(actor.issuer ? { actorIssuer: actor.issuer } : {}),
    ...(actor.sub ? { actorSub: actor.sub } : {}),
    ...(actor.role ? { actorRole: actor.role } : {}),
    action,
    resource,
    severity: action.endsWith('.publish') || action.endsWith('.retire') ? 'warning' : 'info',
  }, client);
}

export function createCostControlService(
  db: Db,
  auditService?: AuditService,
  now: () => Date = () => new Date(),
  options?: { invocationGrantSecret?: string | Uint8Array; backupSnapshotWriteGate?: BackupSnapshotWriteGate },
): CostControlService {
  const reservationGroups = options?.invocationGrantSecret
    ? createCostReservationGroupService(db, {
      invocationGrantSecret: options.invocationGrantSecret,
      backupSnapshotWriteGate: options.backupSnapshotWriteGate,
      now,
    })
    : null;
  const assertSnapshotWriteAllowed = async (client: PoolClient, tenantId: string | null, requestHash: string) => {
    const gate = options?.backupSnapshotWriteGate;
    if (!gate) throw new HttpError(503, 'BACKUP_WRITE_GATE_UNAVAILABLE', 'cost policy writes require the backup snapshot gate');
    await gate.assertWriteAllowed(client, {
      tenantId,
      domain: 'cost-policy-publication',
      requestKey: requestHash.replace(/^sha256:/, ''),
    });
  };
  return {
    async preflight(input) {
      if (!reservationGroups) throw new HttpError(503, 'COST_CONTROL_UNAVAILABLE', 'invocation grant verification is not configured');
      return reservationGroups.preflight(input);
    },
    async transitionGroup(input) {
      if (!reservationGroups) throw new HttpError(503, 'COST_CONTROL_UNAVAILABLE', 'invocation grant verification is not configured');
      return reservationGroups.transitionGroup(input);
    },
    async listBudgets(tenantId) {
      requireUuid(tenantId, 'tenantId');
      const result = await db.query<BudgetHeadRow & { latest_revision: BudgetRevisionRow | null }>(
        `SELECT h.tenant_id::text AS tenant_id, h.budget_id::text AS budget_id,
                h.head_revision, h.active_revision,
                (SELECT jsonb_build_object(
                   'tenant_id',r.tenant_id::text,'budget_id',r.budget_id::text,'revision',r.revision,
                   'state',r.state,'config',r.config,'content_digest',r.content_digest,'actor',r.actor,
                   'created_at',r.created_at,'published_at',r.published_at)
                 FROM cost_budget_revisions r WHERE r.tenant_id=h.tenant_id AND r.budget_id=h.budget_id
                 ORDER BY r.revision DESC LIMIT 1) AS latest_revision
         FROM cost_budget_heads h WHERE h.tenant_id=$1 ORDER BY h.budget_id LIMIT 201`, [tenantId]);
      if (result.rows.length > 200) throw new HttpError(503, 'COST_CONTROL_PAGE_REQUIRED', 'budget catalog exceeds the current bounded list page');
      return parse(CostControlBudgetListSchema, { tenantId, budgets: result.rows.map((row) => {
        const latestRaw = row.latest_revision as unknown as Record<string, unknown> | null;
        const latest = latestRaw === null ? null : budgetRevision({
          tenant_id: String(latestRaw['tenant_id']), budget_id: String(latestRaw['budget_id']),
          revision: Number(latestRaw['revision']), state: String(latestRaw['state']), config: latestRaw['config'],
          content_digest: String(latestRaw['content_digest']), actor: String(latestRaw['actor']),
          created_at: latestRaw['created_at'] as Date | string, published_at: latestRaw['published_at'] as Date | string | null,
        } as BudgetRevisionRow);
        return { budgetId: row.budget_id, headRevision: Number(row.head_revision), activeRevision: row.active_revision === null ? null : Number(row.active_revision), latest };
      }) });
    },

    async getBudget(tenantId, budgetId) {
      requireUuid(tenantId, 'tenantId'); requireUuid(budgetId, 'budgetId');
      const headResult = await db.query<BudgetHeadRow>('SELECT tenant_id::text AS tenant_id,budget_id::text AS budget_id,head_revision,active_revision FROM cost_budget_heads WHERE tenant_id=$1 AND budget_id=$2', [tenantId, budgetId]);
      const head = headResult.rows[0];
      if (!head) throw new HttpError(404, 'NOT_FOUND', 'budget was not found');
      const history = await db.query<BudgetRevisionRow>(
        `SELECT tenant_id::text AS tenant_id,budget_id::text AS budget_id,revision,state,config,content_digest,actor,created_at,published_at
         FROM cost_budget_revisions WHERE tenant_id=$1 AND budget_id=$2 ORDER BY revision DESC LIMIT $3`, [tenantId, budgetId, MAX_HISTORY + 1]);
      if (history.rows.length > MAX_HISTORY) throw new HttpError(503, 'COST_CONTROL_HISTORY_PAGE_REQUIRED', 'budget history exceeds the current bounded detail page');
      return parse(CostControlBudgetDetailSchema, {
        tenantId, budgetId, headRevision: Number(head.head_revision),
        activeRevision: head.active_revision === null ? null : Number(head.active_revision),
        revisions: history.rows.map(budgetRevision),
      });
    },

    async createBudgetDraft(input, actor, idempotencyKey) {
      requireActor(actor);
      const request = parse(BudgetDraftWriteSchema, input) as BudgetDraftWrite;
      const config = parse(BudgetConfigSchema, request.config);
      requireUuid(config.tenantId, 'config.tenantId');
      const budgetId = request.budgetId ?? randomUUID();
      const instant = now();
      if (!Number.isFinite(instant.getTime())) throw new HttpError(503, 'COST_CONTROL_UNAVAILABLE', 'clock is invalid');
      const contentDigest = digest(config);
      const commandScope = `budget-draft:${config.tenantId}:${actorScope(actor)}`;
      const commandHash = digest({ action: 'budget.draft', request, actor });
      return db.tx(async (client) => {
        await assertSnapshotWriteAllowed(client, config.tenantId, commandHash);
        const replay = await readCommandReplay<PersistedBudgetRevision>(client, commandScope, idempotencyKey, commandHash);
        if (replay !== undefined) return budgetResult(replay);
        await lock(client, `cost-budget:${config.tenantId}:${budgetId}`);
        const selected = await client.query<BudgetHeadRow>(
          'SELECT tenant_id::text AS tenant_id,budget_id::text AS budget_id,head_revision,active_revision FROM cost_budget_heads WHERE tenant_id=$1 AND budget_id=$2 FOR UPDATE',
          [config.tenantId, budgetId]);
        const current = selected.rows[0];
        if ((current ? Number(current.head_revision) : 0) !== request.expectedHeadRevision) conflict('budget head changed; refresh before saving the draft');
        if (!current) {
          await client.query('INSERT INTO cost_budget_heads(tenant_id,budget_id,head_revision,active_revision) VALUES($1,$2,1,NULL)', [config.tenantId, budgetId]);
        } else {
          const head = Number(current.head_revision) + 1;
          await client.query('UPDATE cost_budget_heads SET head_revision=$3,updated_at=now() WHERE tenant_id=$1 AND budget_id=$2', [config.tenantId, budgetId, head]);
        }
        const revision = request.expectedHeadRevision + 1;
        const inserted = await client.query<BudgetRevisionRow>(
          `INSERT INTO cost_budget_revisions(tenant_id,budget_id,revision,state,config,content_digest,actor,created_at,published_at)
           VALUES($1,$2,$3,'DRAFT',$4::jsonb,$5,$6,$7,NULL)
           RETURNING tenant_id::text AS tenant_id,budget_id::text AS budget_id,revision,state,config,content_digest,actor,created_at,published_at`,
          [config.tenantId, budgetId, revision, JSON.stringify(config), contentDigest, actor.label, instant.toISOString()]);
        await audit(auditService, client, actor, config.tenantId, 'cost.budget.draft', `budget:${budgetId}@${revision}`);
        const result = budgetRevision(inserted.rows[0]!);
        await saveCommand(client, commandScope, idempotencyKey, commandHash, result);
        return result;
      });
    },

    async transitionBudget(budgetId, action, input, actor, idempotencyKey, requestedTenantId) {
      requireActor(actor); requireUuid(budgetId, 'budgetId');
      const request = parse(CostPolicyTransitionRequestSchema, input) as CostPolicyTransitionRequest;
      return db.tx(async (client) => {
        if (requestedTenantId) requireUuid(requestedTenantId, 'tenantId');
        const tenant = requestedTenantId
          ? await client.query<{ tenant_id: string }>('SELECT tenant_id::text AS tenant_id FROM cost_budget_heads WHERE budget_id=$1 AND tenant_id=$2', [budgetId, requestedTenantId])
          : await client.query<{ tenant_id: string }>('SELECT tenant_id::text AS tenant_id FROM cost_budget_heads WHERE budget_id=$1 ORDER BY tenant_id LIMIT 2', [budgetId]);
        if (tenant.rows.length !== 1) throw new HttpError(tenant.rows.length ? 422 : 404, tenant.rows.length ? 'INVALID_SCHEMA' : 'NOT_FOUND', 'budget identifier must resolve to one tenant');
        const tenantId = tenant.rows[0]!.tenant_id;
        const commandScope = `budget:${tenantId}:${budgetId}:${actorScope(actor)}`;
        const commandHash = digest({ action: `budget.${action}`, request, actor });
        await assertSnapshotWriteAllowed(client, tenantId, commandHash);
        const replay = await readCommandReplay<PersistedBudgetRevision>(client, commandScope, idempotencyKey, commandHash);
        if (replay !== undefined) return budgetResult(replay);
        if (action === 'publish' || action === 'retire') await lock(client, `cost-policy-selection:${tenantId}`);
        await lock(client, `cost-budget:${tenantId}:${budgetId}`);
        const selected = await client.query<BudgetHeadRow>('SELECT tenant_id::text AS tenant_id,budget_id::text AS budget_id,head_revision,active_revision FROM cost_budget_heads WHERE tenant_id=$1 AND budget_id=$2 FOR UPDATE', [tenantId, budgetId]);
        const head = selected.rows[0]; if (!head) throw new HttpError(404, 'NOT_FOUND', 'budget was not found');
        if (Number(head.head_revision) !== request.expectedHeadRevision) conflict('budget head changed; refresh before transitioning');
        const revisionResult = await client.query<BudgetRevisionRow>('SELECT tenant_id::text AS tenant_id,budget_id::text AS budget_id,revision,state,config,content_digest,actor,created_at,published_at FROM cost_budget_revisions WHERE tenant_id=$1 AND budget_id=$2 AND revision=$3 FOR UPDATE', [tenantId, budgetId, head.head_revision]);
        const current = revisionResult.rows[0]; if (!current) throw new HttpError(503, 'COST_CONTROL_UNAVAILABLE', 'budget head has no revision');
        if (current.state !== request.expectedState) conflict('budget state changed; refresh before transitioning');
        const nextState = action === 'review' ? 'REVIEW' : action === 'publish' ? 'PUBLISHED' : 'RETIRED';
        const allowed = action === 'review' ? current.state === 'DRAFT'
          : action === 'publish' ? current.state === 'REVIEW'
            : current.state === 'PUBLISHED';
        if (!allowed) conflict(`budget cannot transition from ${current.state} with ${action}`);
        if (action !== 'review' && !request.reviewerReason) invalid('publish and retire require reviewerReason');
        const publishedAt = action === 'publish' ? now().toISOString() : action === 'retire' ? null : null;
        if (action === 'publish' && head.active_revision !== null) {
          await client.query("UPDATE cost_budget_revisions SET state='SUPERSEDED' WHERE tenant_id=$1 AND budget_id=$2 AND revision=$3 AND state='PUBLISHED'", [tenantId, budgetId, head.active_revision]);
        }
        await client.query('UPDATE cost_budget_revisions SET state=$4,reviewer_reason=$5,published_at=$6 WHERE tenant_id=$1 AND budget_id=$2 AND revision=$3', [tenantId, budgetId, head.head_revision, nextState, request.reviewerReason ?? null, publishedAt]);
        const activeRevision = action === 'publish' ? Number(head.head_revision) : action === 'retire' ? null : head.active_revision;
        await client.query('UPDATE cost_budget_heads SET active_revision=$3,updated_at=now() WHERE tenant_id=$1 AND budget_id=$2', [tenantId, budgetId, activeRevision]);
        const saved = await client.query<BudgetRevisionRow>('SELECT tenant_id::text AS tenant_id,budget_id::text AS budget_id,revision,state,config,content_digest,actor,created_at,published_at FROM cost_budget_revisions WHERE tenant_id=$1 AND budget_id=$2 AND revision=$3', [tenantId, budgetId, head.head_revision]);
        await audit(auditService, client, actor, tenantId, `cost.budget.${action}`, `budget:${budgetId}@${head.head_revision}`);
        const result = budgetRevision(saved.rows[0]!);
        await saveCommand(client, commandScope, idempotencyKey, commandHash, result);
        return result;
      });
    },

    async rollbackBudget(budgetId, input, actor, idempotencyKey, requestedTenantId) {
      requireActor(actor); requireUuid(budgetId, 'budgetId');
      const request = parse(CostPolicyRollbackRequestSchema, input) as CostPolicyRollbackRequest;
      return db.tx(async (client) => {
        if (requestedTenantId) requireUuid(requestedTenantId, 'tenantId');
        const tenant = requestedTenantId
          ? await client.query<{ tenant_id: string }>('SELECT tenant_id::text AS tenant_id FROM cost_budget_heads WHERE budget_id=$1 AND tenant_id=$2', [budgetId, requestedTenantId])
          : await client.query<{ tenant_id: string }>('SELECT tenant_id::text AS tenant_id FROM cost_budget_heads WHERE budget_id=$1 ORDER BY tenant_id LIMIT 2', [budgetId]);
        if (tenant.rows.length !== 1) throw new HttpError(tenant.rows.length ? 422 : 404, tenant.rows.length ? 'INVALID_SCHEMA' : 'NOT_FOUND', 'budget identifier must resolve to one tenant');
        const tenantId = tenant.rows[0]!.tenant_id;
        const commandScope = `budget:${tenantId}:${budgetId}:${actorScope(actor)}`;
        const commandHash = digest({ action: 'budget.rollback', request, actor });
        await assertSnapshotWriteAllowed(client, tenantId, commandHash);
        const replay = await readCommandReplay<PersistedBudgetRevision>(client, commandScope, idempotencyKey, commandHash);
        if (replay !== undefined) return budgetResult(replay);
        await lock(client, `cost-budget:${tenantId}:${budgetId}`);
        const heads = await client.query<BudgetHeadRow>('SELECT tenant_id::text AS tenant_id,budget_id::text AS budget_id,head_revision,active_revision FROM cost_budget_heads WHERE tenant_id=$1 AND budget_id=$2 FOR UPDATE', [tenantId, budgetId]);
        const head = heads.rows[0]!;
        if (Number(head.head_revision) !== request.expectedHeadRevision) conflict('budget head changed; refresh before rollback');
        const source = await client.query<BudgetRevisionRow>('SELECT tenant_id::text AS tenant_id,budget_id::text AS budget_id,revision,state,config,content_digest,actor,created_at,published_at FROM cost_budget_revisions WHERE tenant_id=$1 AND budget_id=$2 AND revision=$3', [tenantId, budgetId, request.sourceRevision]);
        if (!source.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'source budget revision was not found');
        const config = parse(BudgetConfigSchema, source.rows[0].config);
        const revision = Number(head.head_revision) + 1;
        const inserted = await client.query<BudgetRevisionRow>(
          `INSERT INTO cost_budget_revisions(tenant_id,budget_id,revision,state,config,content_digest,actor,reviewer_reason,source_revision,created_at,published_at)
           VALUES($1,$2,$3,'DRAFT',$4::jsonb,$5,$6,$7,$8,$9,NULL)
           RETURNING tenant_id::text AS tenant_id,budget_id::text AS budget_id,revision,state,config,content_digest,actor,created_at,published_at`,
          [tenantId, budgetId, revision, JSON.stringify(config), digest(config), actor.label, request.reviewerReason, request.sourceRevision, now().toISOString()]);
        await client.query('UPDATE cost_budget_heads SET head_revision=$3,updated_at=now() WHERE tenant_id=$1 AND budget_id=$2', [tenantId, budgetId, revision]);
        await audit(auditService, client, actor, tenantId, 'cost.budget.rollback', `budget:${budgetId}@${revision}`);
        const result = budgetRevision(inserted.rows[0]!);
        await saveCommand(client, commandScope, idempotencyKey, commandHash, result);
        return result;
      });
    },

    async getPrices() {
      const heads = await db.query<PriceHeadRow>('SELECT head_revision,active_revision FROM cost_price_heads WHERE singleton=true');
      const head = heads.rows[0];
      const history = await db.query<PriceRevisionRow>('SELECT revision,state,tiers,content_digest,actor,created_at,published_at FROM cost_price_revisions ORDER BY revision DESC LIMIT $1', [MAX_HISTORY + 1]);
      if (history.rows.length > MAX_HISTORY) throw new HttpError(503, 'COST_CONTROL_HISTORY_PAGE_REQUIRED', 'price history exceeds the current bounded detail page');
      return parse(CostControlPriceListSchema, {
        headRevision: head ? Number(head.head_revision) : 0,
        activeRevision: head?.active_revision === null || head?.active_revision === undefined ? null : Number(head.active_revision),
        revisions: history.rows.map(priceRevision),
      });
    },

    async createPriceDraft(input, actor, idempotencyKey) {
      requireActor(actor);
      const request = parse(PriceDraftWriteSchema, input) as PriceDraftWrite;
      const tiers = parse(ModelPricingTableSchema, request.tiers);
      const createdAt = now(); if (!Number.isFinite(createdAt.getTime())) throw new HttpError(503, 'COST_CONTROL_UNAVAILABLE', 'clock is invalid');
      const commandScope = `price:${actorScope(actor)}`;
      const commandHash = digest({ action: 'price.draft', request, actor });
      return db.tx(async (client) => {
        await assertSnapshotWriteAllowed(client, null, commandHash);
        const replay = await readCommandReplay<PersistedPriceRevision>(client, commandScope, idempotencyKey, commandHash);
        if (replay !== undefined) return priceResult(replay);
        await lock(client, 'cost-price:head');
        const heads = await client.query<PriceHeadRow>('SELECT head_revision,active_revision FROM cost_price_heads WHERE singleton=true FOR UPDATE');
        const head = heads.rows[0];
        const headRevision = head ? Number(head.head_revision) : 0;
        if (headRevision !== request.expectedHeadRevision) conflict('price head changed; refresh before saving the draft');
        const revision = headRevision + 1;
        if (!head) await client.query('INSERT INTO cost_price_heads(singleton,head_revision,active_revision) VALUES(true,$1,NULL)', [revision]);
        else await client.query('UPDATE cost_price_heads SET head_revision=$1,updated_at=now() WHERE singleton=true', [revision]);
        const inserted = await client.query<PriceRevisionRow>(
          `INSERT INTO cost_price_revisions(revision,state,tiers,content_digest,actor,created_at,published_at)
           VALUES($1,'DRAFT',$2::jsonb,$3,$4,$5,NULL)
           RETURNING revision,state,tiers,content_digest,actor,created_at,published_at`,
          [revision, JSON.stringify(tiers), digest(tiers), actor.label, createdAt.toISOString()]);
        await audit(auditService, client, actor, null, 'cost.price.draft', `price:${revision}`);
        const result = priceRevision(inserted.rows[0]!);
        await saveCommand(client, commandScope, idempotencyKey, commandHash, result);
        return result;
      });
    },

    async transitionPrice(action, input, actor, idempotencyKey) {
      requireActor(actor);
      const request = parse(CostPolicyTransitionRequestSchema, input) as CostPolicyTransitionRequest;
      const commandScope = `price:${actorScope(actor)}`;
      const commandHash = digest({ action: `price.${action}`, request, actor });
      return db.tx(async (client) => {
        await assertSnapshotWriteAllowed(client, null, commandHash);
        const replay = await readCommandReplay<PersistedPriceRevision>(client, commandScope, idempotencyKey, commandHash);
        if (replay !== undefined) return priceResult(replay);
        await lock(client, 'cost-price:head');
        const heads = await client.query<PriceHeadRow>('SELECT head_revision,active_revision FROM cost_price_heads WHERE singleton=true FOR UPDATE');
        const head = heads.rows[0]; if (!head) throw new HttpError(404, 'NOT_FOUND', 'price book was not found');
        if (Number(head.head_revision) !== request.expectedHeadRevision) conflict('price head changed; refresh before transitioning');
        const rows = await client.query<PriceRevisionRow>('SELECT revision,state,tiers,content_digest,actor,created_at,published_at FROM cost_price_revisions WHERE revision=$1 FOR UPDATE', [head.head_revision]);
        const current = rows.rows[0]; if (!current) throw new HttpError(503, 'COST_CONTROL_UNAVAILABLE', 'price head has no revision');
        if (current.state !== request.expectedState) conflict('price state changed; refresh before transitioning');
        const nextState = action === 'review' ? 'REVIEW' : action === 'publish' ? 'PUBLISHED' : 'RETIRED';
        const allowed = action === 'review' ? current.state === 'DRAFT' : action === 'publish' ? current.state === 'REVIEW' : current.state === 'PUBLISHED';
        if (!allowed) conflict(`price book cannot transition from ${current.state} with ${action}`);
        if (action !== 'review' && !request.reviewerReason) invalid('publish and retire require reviewerReason');
        const publishedAt = action === 'publish' ? now().toISOString() : null;
        if (action === 'publish' && head.active_revision !== null) await client.query("UPDATE cost_price_revisions SET state='SUPERSEDED' WHERE revision=$1 AND state='PUBLISHED'", [head.active_revision]);
        await client.query('UPDATE cost_price_revisions SET state=$2,reviewer_reason=$3,published_at=$4 WHERE revision=$1', [head.head_revision, nextState, request.reviewerReason ?? null, publishedAt]);
        const activeRevision = action === 'publish' ? Number(head.head_revision) : action === 'retire' ? null : head.active_revision;
        await client.query('UPDATE cost_price_heads SET active_revision=$1,updated_at=now() WHERE singleton=true', [activeRevision]);
        const saved = await client.query<PriceRevisionRow>('SELECT revision,state,tiers,content_digest,actor,created_at,published_at FROM cost_price_revisions WHERE revision=$1', [head.head_revision]);
        await audit(auditService, client, actor, null, `cost.price.${action}`, `price:${head.head_revision}`);
        const result = priceRevision(saved.rows[0]!);
        await saveCommand(client, commandScope, idempotencyKey, commandHash, result);
        return result;
      });
    },

    async rollbackPrice(input, actor, idempotencyKey) {
      requireActor(actor);
      const request = parse(CostPolicyRollbackRequestSchema, input) as CostPolicyRollbackRequest;
      const commandScope = `price:${actorScope(actor)}`;
      const commandHash = digest({ action: 'price.rollback', request, actor });
      return db.tx(async (client) => {
        await assertSnapshotWriteAllowed(client, null, commandHash);
        const replay = await readCommandReplay<PersistedPriceRevision>(client, commandScope, idempotencyKey, commandHash);
        if (replay !== undefined) return priceResult(replay);
        await lock(client, 'cost-price:head');
        const heads = await client.query<PriceHeadRow>('SELECT head_revision,active_revision FROM cost_price_heads WHERE singleton=true FOR UPDATE');
        const head = heads.rows[0]; if (!head) throw new HttpError(404, 'NOT_FOUND', 'price book was not found');
        if (Number(head.head_revision) !== request.expectedHeadRevision) conflict('price head changed; refresh before rollback');
        const source = await client.query<PriceRevisionRow>('SELECT revision,state,tiers,content_digest,actor,created_at,published_at FROM cost_price_revisions WHERE revision=$1', [request.sourceRevision]);
        if (!source.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'source price revision was not found');
        const tiers = parse(ModelPricingTableSchema, source.rows[0].tiers);
        const revision = Number(head.head_revision) + 1;
        await client.query('UPDATE cost_price_heads SET head_revision=$1,updated_at=now() WHERE singleton=true', [revision]);
        const inserted = await client.query<PriceRevisionRow>(
          `INSERT INTO cost_price_revisions(revision,state,tiers,content_digest,actor,reviewer_reason,source_revision,created_at,published_at)
           VALUES($1,'DRAFT',$2::jsonb,$3,$4,$5,$6,$7,NULL)
           RETURNING revision,state,tiers,content_digest,actor,created_at,published_at`,
          [revision, JSON.stringify(tiers), digest(tiers), actor.label, request.reviewerReason, request.sourceRevision, now().toISOString()]);
        await audit(auditService, client, actor, null, 'cost.price.rollback', `price:${revision}`);
        const result = priceRevision(inserted.rows[0]!);
        await saveCommand(client, commandScope, idempotencyKey, commandHash, result);
        return result;
      });
    },
  };
}
