import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import {
  BudgetConfigSchema,
  BudgetQuotaScopeSchema,
  CostAlertChannelListSchema,
  CostAlertInboxPageSchema,
  CostAlertInboxItemSchema,
  CostAlertInboxReadAckSchema,
  CostAlertInboxQuerySchema,
  CostAlertListQuerySchema,
  CostAlertListSchema,
  CostAlertRecordSchema,
  CostPolicyScopeCatalogQuerySchema,
  CostPolicyScopeCatalogSchema,
  CostBudgetAlertBindingSchema,
  CostBudgetAlertBindingWriteSchema,
  type CostAlertChannelList,
  type CostAlertInboxPage,
  type CostAlertInboxReadAck,
  type CostAlertInboxQuery,
  type CostAlertList,
  type CostAlertListQuery,
  type CostPolicyScopeCatalogQuery,
  type CostPolicyScopeCatalog,
  type CostBudgetAlertBinding,
  type CostBudgetAlertBindingWrite,
  type CostAlertRecipientReference,
  type CostAlertRecipientCatalogQuery,
} from '@du/contracts';
import { listCostAlertOidcRecipients } from './oidc-recipients';
import type { Db } from '../../db/db';
import { HttpError, zodIssuesToProblem } from '../../http/errors';
import type { AuditService } from '../audit/audit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ATTEMPTS = 8;
const CLAIM_LEASE_MS = 60_000;

export interface CostAlertActor {
  label: string;
  role: string;
  issuer?: string;
  sub?: string;
}

export type CostAlertInboxPrincipal =
  | { kind: 'local'; userId: string }
  | { kind: 'oidc'; principalId: string; authorizationVersion: number };

interface BudgetRevisionRow extends QueryResultRow { config: unknown; published_at: Date | string | null; }
interface BindingRow extends QueryResultRow {
  tenant_id: string;
  budget_id: string;
  budget_revision: number;
  binding_revision: number;
  owner_recipient_kind: 'local' | 'oidc';
  owner_user_id: string | null;
  owner_oidc_principal_id: string | null;
  owner_authorization_version: number | string | null;
  owner_display_name: string;
  owner_role: string;
  owner_enabled: boolean;
  owner_locked: boolean;
  owner_state?: string | null;
  channel_refs: unknown;
  actor: string;
  updated_at: Date | string;
}
interface CurrentOwnerRow extends QueryResultRow {
  id: string;
  username_normalized: string;
  role: string;
  is_enabled: boolean;
  is_locked: boolean;
}
interface ChannelRow extends QueryResultRow {
  channel_id: string;
  channel_revision: number;
  kind: string;
  display_name: string;
  destination_label: string;
  enabled: boolean;
}
interface AlertRow extends QueryResultRow {
  alert_id: string;
  tenant_id: string;
  budget_id: string;
  budget_revision: number;
  alert_kind: string;
  source: string;
  source_event_key: string;
  quota_scope: unknown;
  quota_scope_key: string;
  window_start: Date | string;
  window_end: Date | string;
  reservation_group_id: string;
  operation_id: string;
  task_id: string;
  invocation_id: string;
  attempt: number;
  usage_event_id: string | null;
  evaluation: unknown;
  trust: unknown;
  routing_state: string;
  binding_revision: number | null;
  owner_user_id: string | null;
  owner_recipient_kind: 'local' | 'oidc' | null;
  owner_oidc_principal_id: string | null;
  owner_authorization_version: number | string | null;
  owner_display_name: string | null;
  channel_refs: unknown;
  created_at: Date | string;
}
interface DeliveryRow extends QueryResultRow {
  delivery_id: string;
  alert_id: string;
  channel_id: string;
  channel_revision: number;
  channel_name: string;
  state: string;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: Date | string | null;
  delivered_at: Date | string | null;
}
interface AttemptRow extends QueryResultRow {
  delivery_id: string;
  attempt: number;
  state: string;
  started_at: Date | string;
  finished_at: Date | string | null;
  error_code: string | null;
}

interface InboxRow extends QueryResultRow {
  delivery_id: string;
  alert_id: string;
  tenant_id: string;
  budget_id: string;
  budget_revision: number;
  alert_kind: string;
  source: string;
  source_event_key: string;
  window_start: Date | string;
  window_end: Date | string;
  evaluation: unknown;
  trust: unknown;
  created_at: Date | string;
  delivered_at: Date | string;
  read_at: Date | string | null;
}

interface ChannelRef { channelId: string; channelRevision: number; }
interface ScopeApiKeyRow extends QueryResultRow { id: string; prefix: string; }
interface ScopeProfileRow extends QueryResultRow {
  id: string;
  api_key_id: string;
  api_key_prefix: string;
  business_id: string;
  business_version: string;
  action: string;
  profile_name: string;
}
interface ScopeBusinessRow extends QueryResultRow { id: string; }

interface ScopeCatalogCursor {
  version: 1;
  kind: CostPolicyScopeCatalogQuery['kind'];
  tenantId: string;
  filterHash: string;
  after: string[];
}

function invalid(message: string): never { throw new HttpError(422, 'INVALID_SCHEMA', message); }
function conflict(message: string): never { throw new HttpError(409, 'STATE_CONFLICT', message); }
function unavailable(message: string): never { throw new HttpError(503, 'COST_ALERTS_UNAVAILABLE', message); }

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) unavailable('a stored alert timestamp is invalid');
  return date.toISOString();
}

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: (string | number)[]; message: string }> } } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw zodIssuesToProblem(result.error.issues);
  return result.data;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function digest(value: unknown): string { return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`; }

function parseChannelRefs(value: unknown): ChannelRef[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return null;
  const refs: ChannelRef[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (typeof row['channelId'] !== 'string' || row['channelId'].length < 1 || row['channelId'].length > 128
      || !Number.isSafeInteger(row['channelRevision']) || Number(row['channelRevision']) < 1) return null;
    refs.push({ channelId: row['channelId'], channelRevision: Number(row['channelRevision']) });
  }
  return new Set(refs.map((ref) => ref.channelId)).size === refs.length ? refs : null;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

const SAFE_BINDING_ACTOR_LABELS = new Set(['platform-token', 'tenant-operator', 'shell:admin', 'shell:operator', 'shell:viewer']);

/** Keep only explicitly provenance-marked local/directory identities or
 * known synthetic actor labels. Historical `session:<UUID>` rows are
 * ambiguous: an OIDC subject can itself be UUID-shaped. */
export function safeCostAlertBindingUpdatedBy(value: string): string {
  if (/^(?:local-user|oidc-principal):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    || SAFE_BINDING_ACTOR_LABELS.has(value)) return value;
  return 'Administrator session';
}

/** New OIDC actor labels use the server-generated opaque alert principal,
 * never the verified IdP subject. Labels record which trusted source issued
 * the UUID so old ambiguous `session:` values are not treated as safe. */
export function costAlertBindingActorLabel(input: {
  issuer?: string;
  role: string;
  localPrincipalId?: string;
  alertPrincipalId?: string;
}): string {
  const candidate = input.issuer === 'du-local' ? input.localPrincipalId : input.alertPrincipalId;
  if (candidate && UUID.test(candidate)) return `${input.issuer === 'du-local' ? 'local-user' : 'oidc-principal'}:${candidate}`;
  const role = ['admin', 'operator', 'viewer'].includes(input.role) ? input.role : 'admin';
  return `shell:${role}`;
}

function mapBinding(row: BindingRow): CostBudgetAlertBinding {
  const channels = parseChannelRefs(row.channel_refs);
  if (!channels) unavailable('a stored budget alert binding is invalid');
  const role = row.owner_role === 'admin' ? 'ADMIN' : row.owner_role === 'operator' ? 'USER' : 'VIEWER';
  const owner = row.owner_recipient_kind === 'oidc'
    ? {
      kind: 'oidc' as const,
      principalId: row.owner_oidc_principal_id,
      displayName: row.owner_display_name,
      role: 'ADMIN' as const,
      enabled: row.owner_enabled,
      locked: false as const,
      authorizationVersion: Number(row.owner_authorization_version),
    }
    : {
      userId: row.owner_user_id,
      displayName: row.owner_display_name,
      role,
      enabled: row.owner_enabled,
      locked: row.owner_locked,
    };
  return parse(CostBudgetAlertBindingSchema, {
    tenantId: row.tenant_id,
    budgetId: row.budget_id,
    budgetRevision: Number(row.budget_revision),
    bindingRevision: Number(row.binding_revision),
    owner,
    channels,
    updatedAt: iso(row.updated_at),
    updatedBy: safeCostAlertBindingUpdatedBy(row.actor),
  });
}

async function recordAudit(
  audit: AuditService | undefined,
  client: PoolClient,
  actor: CostAlertActor,
  tenantId: string,
  budgetId: string,
  budgetRevision: number,
): Promise<void> {
  if (!audit) unavailable('cost alert routing changes require the audit ledger');
  await audit.record({
    tenantId,
    actor: actor.label,
    ...(actor.issuer ? { actorIssuer: actor.issuer } : {}),
    ...(actor.sub ? { actorSub: actor.sub } : {}),
    actorRole: actor.role,
    action: 'cost.alert.binding',
    resource: `budget:${budgetId}@${budgetRevision}`,
    severity: 'info',
  }, client);
}

interface AlertCursor { createdAt: string; alertId: string; filterHash: string; tenantId: string; }
interface InboxCursor { deliveredAt: string; deliveryId: string; filterHash: string; tenantId: string; userId: string; }

function filterHash(query: CostAlertListQuery): string {
  return digest({ tenantId: query.tenantId, limit: query.limit, budgetId: query.budgetId ?? null, kind: query.kind ?? null });
}

function encodeCursor(cursor: AlertCursor): string { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }

function decodeCursor(raw: string, query: CostAlertListQuery): AlertCursor {
  let decoded: string;
  let value: unknown;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== raw) throw new Error('cursor is not canonical');
    value = JSON.parse(decoded) as unknown;
  } catch {
    invalid('alert cursor is invalid');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('alert cursor is invalid');
  const cursor = value as Record<string, unknown>;
  const createdAt = cursor['createdAt'];
  const alertId = cursor['alertId'];
  if (cursor['tenantId'] !== query.tenantId || cursor['filterHash'] !== filterHash(query)
    || typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))
    || typeof alertId !== 'string' || !UUID.test(alertId)) invalid('alert cursor does not match this tenant and query');
  return { createdAt, alertId, tenantId: query.tenantId, filterHash: filterHash(query) };
}

function inboxFilterHash(query: CostAlertInboxQuery, identityKey: string): string {
  return digest({ tenantId: query.tenantId, userId: identityKey, limit: query.limit, unreadOnly: query.unreadOnly });
}

function encodeInboxCursor(cursor: InboxCursor): string { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }

function decodeInboxCursor(raw: string, query: CostAlertInboxQuery, identityKey: string): InboxCursor {
  let value: unknown;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== raw) throw new Error('cursor is not canonical');
    value = JSON.parse(decoded) as unknown;
  } catch {
    invalid('inbox cursor is invalid');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('inbox cursor is invalid');
  const cursor = value as Record<string, unknown>;
  const deliveredAt = cursor['deliveredAt'];
  const deliveryId = cursor['deliveryId'];
  if (cursor['tenantId'] !== query.tenantId || cursor['userId'] !== identityKey
    || cursor['filterHash'] !== inboxFilterHash(query, identityKey)
    || typeof deliveredAt !== 'string' || !Number.isFinite(Date.parse(deliveredAt))
    || typeof deliveryId !== 'string' || !UUID.test(deliveryId)) invalid('inbox cursor does not match this identity and query');
  return { deliveredAt, deliveryId, tenantId: query.tenantId, userId: identityKey, filterHash: inboxFilterHash(query, identityKey) };
}

function scopeCatalogFilterHash(query: CostPolicyScopeCatalogQuery): string {
  return digest({
    tenantId: query.tenantId,
    kind: query.kind,
    q: query.q,
    apiKeyId: query.apiKeyId ?? null,
    profileId: query.profileId ?? null,
  });
}

function encodeScopeCatalogCursor(cursor: ScopeCatalogCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeScopeCatalogCursor(raw: string, query: CostPolicyScopeCatalogQuery): ScopeCatalogCursor {
  let cursor: Record<string, unknown>;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== raw) throw new Error('non-canonical cursor');
    const value = JSON.parse(decoded) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid cursor');
    cursor = value as Record<string, unknown>;
  } catch {
    invalid('scope catalog cursor is invalid');
  }
  const after = cursor['after'];
  const expectedLength = query.kind === 'api-keys' ? 2 : query.kind === 'profiles' ? 6 : 1;
  if (cursor['version'] !== 1 || cursor['tenantId'] !== query.tenantId || cursor['kind'] !== query.kind
    || cursor['filterHash'] !== scopeCatalogFilterHash(query) || !Array.isArray(after)
    || after.length !== expectedLength || after.some((value) => typeof value !== 'string' || value.length > 160)) {
    invalid('scope catalog cursor does not match this tenant and search');
  }
  return { version: 1, tenantId: query.tenantId, kind: query.kind, filterHash: scopeCatalogFilterHash(query), after: after as string[] };
}

function mapAlert(row: AlertRow, deliveries: DeliveryRow[], histories: AttemptRow[]): unknown {
  const channelRefs = parseChannelRefs(row.channel_refs) ?? [];
  const alertDeliveries = deliveries.filter((delivery) => delivery.alert_id === row.alert_id).map((delivery) => ({
    channelId: delivery.channel_id,
    channelRevision: Number(delivery.channel_revision),
    channelName: delivery.channel_name,
    state: delivery.state,
    attempts: Number(delivery.attempt_count),
    maxAttempts: 8,
    nextAttemptAt: iso(delivery.next_attempt_at),
    deliveredAt: iso(delivery.delivered_at),
    history: histories.filter((attempt) => attempt.delivery_id === delivery.delivery_id).map((attempt) => ({
      attempt: Number(attempt.attempt),
      state: attempt.state,
      startedAt: iso(attempt.started_at),
      finishedAt: iso(attempt.finished_at),
      errorCode: attempt.error_code,
    })),
  }));
  return parse(CostAlertRecordSchema, {
    alertId: row.alert_id,
    tenantId: row.tenant_id,
    budgetId: row.budget_id,
    budgetRevision: Number(row.budget_revision),
    kind: row.alert_kind,
    source: row.source,
    sourceEventKey: row.source_event_key,
    quotaScope: BudgetQuotaScopeSchema.parse(row.quota_scope),
    quotaScopeKey: row.quota_scope_key,
    windowStart: iso(row.window_start),
    windowEnd: iso(row.window_end),
    reservationGroupId: row.reservation_group_id,
    operationId: row.operation_id,
    taskId: row.task_id,
    invocationId: row.invocation_id,
    attempt: Number(row.attempt),
    usageEventId: row.usage_event_id,
    evaluation: row.evaluation,
    trust: row.trust,
    routingState: row.routing_state,
    bindingRevision: row.binding_revision === null ? null : Number(row.binding_revision),
    owner: row.owner_display_name === null ? null : row.owner_recipient_kind === 'oidc'
      ? {
        kind: 'oidc',
        principalId: row.owner_oidc_principal_id,
        displayName: row.owner_display_name,
        role: 'ADMIN',
        enabled: row.routing_state === 'ROUTED',
        locked: false,
        authorizationVersion: Number(row.owner_authorization_version),
      }
      : row.owner_user_id === null ? null : {
        userId: row.owner_user_id,
        displayName: row.owner_display_name,
        role: 'ADMIN',
      },
    channels: channelRefs.map((channel) => ({
      ...channel,
      displayName: (row.channel_refs as Array<{ channelId: string; channelRevision: number; displayName: string }> | null)
        ?.find((entry) => entry.channelId === channel.channelId && entry.channelRevision === channel.channelRevision)?.displayName ?? channel.channelId,
    })),
    deliveries: alertDeliveries,
    createdAt: iso(row.created_at),
  });
}

export function createCostAlertService(db: Db, audit?: AuditService, now: () => Date = () => new Date()) {
  return {
    async listScopeCatalog(input: CostPolicyScopeCatalogQuery): Promise<CostPolicyScopeCatalog> {
      const query = parse(CostPolicyScopeCatalogQuerySchema, input);
      const params: unknown[] = [query.tenantId];
      const bind = (value: unknown): string => {
        params.push(value);
        return `$${params.length}`;
      };
      const conditions: string[] = [];
      if (query.q) {
        const search = bind(query.q);
        if (query.kind === 'api-keys') {
          conditions.push(`(position(${search} in lower(prefix)) > 0 OR position(${search} in lower(id::text)) > 0)`);
        } else if (query.kind === 'profiles') {
          conditions.push(`position(${search} in lower(concat_ws(' ',n.profile_name,p.business_id,p.business_version,p.action,m.api_key_id::text,n.profile_id::text))) > 0`);
        } else {
          conditions.push(`position(${search} in lower(scoped.id)) > 0`);
        }
      }
      if (query.kind === 'profiles' && query.apiKeyId) conditions.push(`m.api_key_id=${bind(query.apiKeyId)}::uuid`);
      if (query.kind === 'businesses' && query.profileId) {
        conditions.push(`scoped.profile_id=${bind(query.profileId)}::uuid`);
        conditions.push(`scoped.api_key_id=${bind(query.apiKeyId)}::uuid`);
      }

      const cursor = query.cursor ? decodeScopeCatalogCursor(query.cursor, query) : null;
      if (cursor) {
        const after = cursor.after.map((value) => bind(value));
        if (query.kind === 'api-keys') {
          conditions.push(`(lower(prefix),id::text)>(lower(${after[0]}),${after[1]})`);
        } else if (query.kind === 'profiles') {
          conditions.push(`(lower(n.profile_name),lower(p.business_id),lower(p.business_version),lower(p.action),m.api_key_id::text,n.profile_id::text)>(lower(${after[0]}),lower(${after[1]}),lower(${after[2]}),lower(${after[3]}),${after[4]},${after[5]})`);
        } else {
          conditions.push(`lower(scoped.id)>lower(${after[0]})`);
        }
      }
      const limit = bind(query.limit + 1);
      const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
      const hasMoreRows = (rows: unknown[]) => rows.length > query.limit;

      if (query.kind === 'api-keys') {
        const result = await db.query<ScopeApiKeyRow>(
          `SELECT id::text AS id,prefix FROM api_keys
            WHERE tenant_id=$1 AND status='ACTIVE' ${where}
            ORDER BY lower(prefix),id::text LIMIT ${limit}`,
          params,
        );
        const rows = result.rows.slice(0, query.limit);
        const hasMore = hasMoreRows(result.rows);
        return parse(CostPolicyScopeCatalogSchema, {
          tenantId: query.tenantId,
          kind: query.kind,
          items: rows.map((row) => ({ id: row.id, label: `Key · ${row.prefix}` })),
          limit: query.limit,
          hasMore,
          nextCursor: hasMore && rows.length ? encodeScopeCatalogCursor({
            version: 1, kind: query.kind, tenantId: query.tenantId, filterHash: scopeCatalogFilterHash(query),
            after: [rows.at(-1)!.prefix.toLocaleLowerCase('en-US'), rows.at(-1)!.id],
          }) : null,
        });
      }

      if (query.kind === 'profiles') {
        const result = await db.query<ScopeProfileRow>(
          `SELECT n.profile_id::text AS id,m.api_key_id::text AS api_key_id,k.prefix AS api_key_prefix,
                  p.business_id,p.business_version,p.action,n.profile_name
             FROM profile_names n
             JOIN profile_active_revisions a ON a.profile_id=n.profile_id
             JOIN profile_bindings p ON p.profile_id=a.profile_id AND p.revision=a.revision
             JOIN profile_api_keys m ON m.profile_id=n.profile_id AND m.tenant_id=n.tenant_id AND m.state='ACTIVE'
             JOIN api_keys k ON k.id=m.api_key_id AND k.tenant_id=m.tenant_id AND k.status='ACTIVE'
            WHERE n.tenant_id=$1 ${where}
            ORDER BY lower(n.profile_name),lower(p.business_id),lower(p.business_version),lower(p.action),m.api_key_id::text,n.profile_id::text
            LIMIT ${limit}`,
          params,
        );
        const rows = result.rows.slice(0, query.limit);
        const hasMore = hasMoreRows(result.rows);
        return parse(CostPolicyScopeCatalogSchema, {
          tenantId: query.tenantId,
          kind: query.kind,
          items: rows.map((row) => ({
            id: row.id,
            apiKeyId: row.api_key_id,
            apiKeyLabel: `Key · ${row.api_key_prefix}`,
            businessId: row.business_id,
            businessVersion: row.business_version,
            action: row.action,
            profileName: row.profile_name,
          })),
          limit: query.limit,
          hasMore,
          nextCursor: hasMore && rows.length ? encodeScopeCatalogCursor({
            version: 1, kind: query.kind, tenantId: query.tenantId, filterHash: scopeCatalogFilterHash(query),
            after: [rows.at(-1)!.profile_name.toLocaleLowerCase('en-US'), rows.at(-1)!.business_id.toLocaleLowerCase('en-US'),
              rows.at(-1)!.business_version.toLocaleLowerCase('en-US'), rows.at(-1)!.action.toLocaleLowerCase('en-US'),
              rows.at(-1)!.api_key_id, rows.at(-1)!.id],
          }) : null,
        });
      }

      const businessSources = query.profileId ? `
           SELECT p.business_id AS id,p.profile_id,pak.api_key_id
             FROM profile_bindings p
             JOIN profile_active_revisions a ON a.profile_id=p.profile_id AND a.revision=p.revision
             JOIN profile_api_keys pak ON pak.profile_id=p.profile_id AND pak.tenant_id=p.tenant_id AND pak.state='ACTIVE'
             JOIN api_keys k ON k.id=pak.api_key_id AND k.tenant_id=pak.tenant_id AND k.status='ACTIVE'
            WHERE p.tenant_id=$1` : `
           SELECT p.business_id AS id,p.profile_id,pak.api_key_id
             FROM profile_bindings p
             JOIN profile_active_revisions a ON a.profile_id=p.profile_id AND a.revision=p.revision
             JOIN profile_api_keys pak ON pak.profile_id=p.profile_id AND pak.tenant_id=p.tenant_id AND pak.state='ACTIVE'
             JOIN api_keys k ON k.id=pak.api_key_id AND k.tenant_id=pak.tenant_id AND k.status='ACTIVE'
            WHERE p.tenant_id=$1
           UNION ALL
           SELECT o.business_id AS id,NULL::uuid AS profile_id,NULL::uuid AS api_key_id
             FROM operations o WHERE o.tenant_id=$1 AND o.business_id IS NOT NULL`;
      const result = await db.query<ScopeBusinessRow>(
        `SELECT scoped.id FROM (${businessSources}) scoped
          WHERE true ${where}
          GROUP BY scoped.id
          ORDER BY lower(scoped.id) LIMIT ${limit}`,
        params,
      );
      const rows = result.rows.slice(0, query.limit);
      const hasMore = hasMoreRows(result.rows);
      return parse(CostPolicyScopeCatalogSchema, {
        tenantId: query.tenantId,
        kind: query.kind,
        items: rows.map((row) => ({ id: row.id, label: row.id })),
        limit: query.limit,
        hasMore,
        nextCursor: hasMore && rows.length ? encodeScopeCatalogCursor({
          version: 1, kind: query.kind, tenantId: query.tenantId, filterHash: scopeCatalogFilterHash(query),
          after: [rows.at(-1)!.id.toLocaleLowerCase('en-US')],
        }) : null,
      });
    },

    async listChannels(tenantId: string): Promise<CostAlertChannelList> {
      if (!UUID.test(tenantId)) invalid('tenantId must be a UUID');
      const result = await db.query<ChannelRow>(
        `SELECT channel_id,channel_revision,kind,display_name,destination_label,enabled
           FROM cost_alert_channels WHERE enabled=true
          ORDER BY display_name,channel_id,channel_revision DESC LIMIT 20`,
      );
      return parse(CostAlertChannelListSchema, {
        tenantId,
        channels: result.rows.map((row) => ({
          channelId: row.channel_id,
          channelRevision: Number(row.channel_revision),
          kind: row.kind,
          displayName: row.display_name,
          enabled: row.enabled,
          destinationLabel: row.destination_label,
        })),
      });
    },

    async listRecipients(query: CostAlertRecipientCatalogQuery) {
      return listCostAlertOidcRecipients(db, query);
    },

    async getBinding(tenantId: string, budgetId: string, budgetRevision: number): Promise<CostBudgetAlertBinding | null> {
      if (!UUID.test(tenantId) || !UUID.test(budgetId) || !Number.isSafeInteger(budgetRevision) || budgetRevision < 1) invalid('budget binding scope is invalid');
      const revision = await db.query<BudgetRevisionRow>(
        `SELECT config,published_at FROM cost_budget_revisions WHERE tenant_id=$1 AND budget_id=$2 AND revision=$3`,
        [tenantId, budgetId, budgetRevision],
      );
      const config = revision.rows[0] ? BudgetConfigSchema.safeParse(revision.rows[0].config) : null;
      if (!config?.success || config.data.tenantId !== tenantId || revision.rows[0]?.published_at == null) {
        throw new HttpError(404, 'NOT_FOUND', 'published budget revision was not found');
      }
      const result = await db.query<BindingRow>(
        `SELECT b.tenant_id::text AS tenant_id,b.budget_id::text AS budget_id,b.budget_revision,
                b.binding_revision,b.owner_recipient_kind,b.owner_user_id::text AS owner_user_id,
                b.owner_oidc_principal_id::text AS owner_oidc_principal_id,b.owner_authorization_version,
                b.owner_display_name,COALESCE(u.role,o.observed_role,'viewer') AS owner_role,
                CASE WHEN b.owner_recipient_kind='local' THEN COALESCE(u.is_enabled,false)
                     ELSE COALESCE(o.state='ENABLED' AND o.observed_role='admin' AND o.observed_tenant_id IS NULL,false) END AS owner_enabled,
                CASE WHEN b.owner_recipient_kind='local' THEN COALESCE(u.is_locked,true) ELSE false END AS owner_locked,
                o.state AS owner_state,b.channel_refs,b.actor,b.updated_at
           FROM cost_budget_alert_bindings b
           LEFT JOIN admin_local_users u ON u.tenant_id=b.tenant_id AND u.id=b.owner_user_id
           LEFT JOIN cost_alert_oidc_recipients o ON o.principal_id=b.owner_oidc_principal_id
          WHERE b.tenant_id=$1 AND b.budget_id=$2 AND b.budget_revision=$3`,
        [tenantId, budgetId, budgetRevision],
      );
      return result.rows[0] ? mapBinding(result.rows[0]) : null;
    },

    async saveBinding(input: CostBudgetAlertBindingWrite, actor: CostAlertActor, idempotencyKey: string): Promise<CostBudgetAlertBinding> {
      const write = parse(CostBudgetAlertBindingWriteSchema, input);
      const recipient: CostAlertRecipientReference = write.owner
        ?? { kind: 'local', userId: write.ownerUserId! };
      if (!actor || typeof actor.label !== 'string' || actor.label.length < 1 || actor.label.length > 128
        || typeof actor.role !== 'string' || actor.role.length < 1 || actor.role.length > 64) invalid('a trusted Admin actor is required');
      if (!/^[A-Za-z0-9._:-]{8,256}$/.test(idempotencyKey)) invalid('a bounded idempotency key is required');
      const bindingActor = { ...actor, label: safeCostAlertBindingUpdatedBy(actor.label) };
      const commandScope = `cost-alert-binding:${write.tenantId}:${write.budgetId}:${write.budgetRevision}`;
      const requestHash = digest({ write, actor });
      return db.tx(async (client) => {
        // Lock the exact published revision, not just one idempotency key.
        // This serializes first-write CAS attempts when no binding row exists.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [commandScope]);
        const replay = await client.query<{ request_hash: string; result: unknown } & QueryResultRow>(
          `SELECT request_hash,result FROM cost_alert_binding_commands WHERE scope_key=$1 AND idempotency_key=$2 FOR UPDATE`,
          [commandScope, idempotencyKey],
        );
        if (replay.rows[0]) {
          if (replay.rows[0].request_hash !== requestHash) conflict('Idempotency-Key was reused for a different alert binding');
          const saved = parse(CostBudgetAlertBindingSchema, replay.rows[0].result);
          return { ...saved, updatedBy: safeCostAlertBindingUpdatedBy(saved.updatedBy) };
        }

        const budgetResult = await client.query<BudgetRevisionRow>(
          `SELECT config,published_at FROM cost_budget_revisions
            WHERE tenant_id=$1 AND budget_id=$2 AND revision=$3 FOR SHARE`,
          [write.tenantId, write.budgetId, write.budgetRevision],
        );
        const budgetResultRow = budgetResult.rows[0];
        const config = budgetResultRow ? BudgetConfigSchema.safeParse(budgetResultRow.config) : null;
        if (!config?.success || config.data.tenantId !== write.tenantId || budgetResultRow?.published_at == null) {
          throw new HttpError(404, 'NOT_FOUND', 'published budget revision was not found');
        }
        const selectedChannelIds = write.channels.map((channel) => channel.channelId);
        if (!sameIds(config.data.notificationChannels, selectedChannelIds)) {
          invalid('selected channels must match the opaque notification channel IDs on this exact budget revision');
        }

        let ownerName: string;
        let ownerUserId: string | null = null;
        let ownerOidcPrincipalId: string | null = null;
        let ownerAuthorizationVersion: number | null = null;
        if (recipient.kind === 'local') {
          const ownerResult = await client.query<CurrentOwnerRow>(
            `SELECT id::text AS id,username_normalized,role,is_enabled,is_locked
               FROM admin_local_users WHERE tenant_id=$1 AND id=$2 FOR SHARE`,
            [write.tenantId, recipient.userId],
          );
          const owner = ownerResult.rows[0];
          if (!owner || owner.role !== 'admin' || owner.is_enabled !== true || owner.is_locked !== false) {
            throw new HttpError(422, 'COST_ALERT_OWNER_UNAVAILABLE', 'choose a current enabled, unlocked tenant Admin identity as the alert owner');
          }
          ownerUserId = owner.id;
          ownerName = owner.username_normalized;
        } else {
          const ownerResult = await client.query<{
            principal_id: string; display_code: string; observed_role: string; observed_tenant_id: string | null;
            state: string; authorization_version: number | string;
          } & QueryResultRow>(
            `SELECT principal_id::text AS principal_id,display_code,observed_role,
                    observed_tenant_id::text AS observed_tenant_id,state,authorization_version
               FROM cost_alert_oidc_recipients WHERE principal_id=$1 FOR SHARE`, [recipient.principalId],
          );
          const owner = ownerResult.rows[0];
          if (!owner || owner.observed_role !== 'admin' || owner.observed_tenant_id !== null || owner.state !== 'ENABLED') {
            throw new HttpError(422, 'COST_ALERT_OWNER_UNAVAILABLE', 'choose a current enabled platform OIDC Admin recipient');
          }
          ownerOidcPrincipalId = owner.principal_id;
          ownerAuthorizationVersion = Number(owner.authorization_version);
          if (!Number.isSafeInteger(ownerAuthorizationVersion) || ownerAuthorizationVersion < 1) unavailable('OIDC recipient version is invalid');
          ownerName = `External OIDC Admin · ${owner.display_code}`;
        }

        const channelRows: ChannelRow[] = [];
        for (const selected of write.channels) {
          const channelResult = await client.query<ChannelRow>(
            `SELECT channel_id,channel_revision,kind,display_name,destination_label,enabled
               FROM cost_alert_channels WHERE channel_id=$1 AND channel_revision=$2 FOR SHARE`,
            [selected.channelId, selected.channelRevision],
          );
          if (channelResult.rows[0]) channelRows.push(channelResult.rows[0]);
        }
        if (channelRows.length !== write.channels.length
          || channelRows.some((channel) => channel.kind !== 'in-app' || channel.enabled !== true)) {
          throw new HttpError(422, 'COST_ALERT_CHANNEL_UNAVAILABLE', 'one or more selected alert channels are unavailable');
        }

        const currentResult = await client.query<BindingRow>(
          `SELECT b.tenant_id::text AS tenant_id,b.budget_id::text AS budget_id,b.budget_revision,
                  b.binding_revision,b.owner_recipient_kind,b.owner_user_id::text AS owner_user_id,
                  b.owner_oidc_principal_id::text AS owner_oidc_principal_id,b.owner_authorization_version,
                  b.owner_display_name,'admin' AS owner_role,true AS owner_enabled,false AS owner_locked,
                  NULL::text AS owner_state,b.channel_refs,b.actor,b.updated_at
             FROM cost_budget_alert_bindings b
            WHERE b.tenant_id=$1 AND b.budget_id=$2 AND b.budget_revision=$3 FOR UPDATE`,
          [write.tenantId, write.budgetId, write.budgetRevision],
        );
        const current = currentResult.rows[0];
        const currentRevision = current ? Number(current.binding_revision) : 0;
        if (currentRevision !== write.expectedBindingRevision) conflict('alert owner/channel mapping changed; reload it before saving');
        const bindingRevision = currentRevision + 1;
        const changedAt = now();
        if (!Number.isFinite(changedAt.getTime())) unavailable('alert binding clock is invalid');

        if (current) {
          await client.query(
            `UPDATE cost_budget_alert_bindings
                SET binding_revision=$4,owner_user_id=$5,owner_display_name=$6,channel_refs=$7::jsonb,
                    actor=$8,actor_role=$9,actor_issuer=$10,actor_sub=$11,updated_at=$12,
                    owner_recipient_kind=$14,owner_oidc_principal_id=$15,owner_authorization_version=$16
              WHERE tenant_id=$1 AND budget_id=$2 AND budget_revision=$3 AND binding_revision=$13`,
            [write.tenantId, write.budgetId, write.budgetRevision, bindingRevision, ownerUserId,
              ownerName, JSON.stringify(write.channels), bindingActor.label, bindingActor.role,
              bindingActor.issuer ?? null, bindingActor.sub ?? null, changedAt.toISOString(), write.expectedBindingRevision,
              recipient.kind, ownerOidcPrincipalId, ownerAuthorizationVersion],
          );
        } else {
          await client.query(
            `INSERT INTO cost_budget_alert_bindings
              (tenant_id,budget_id,budget_revision,binding_revision,owner_user_id,owner_display_name,channel_refs,
               actor,actor_role,actor_issuer,actor_sub,updated_at,owner_recipient_kind,owner_oidc_principal_id,owner_authorization_version)
             VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [write.tenantId, write.budgetId, write.budgetRevision, bindingRevision, ownerUserId,
              ownerName, JSON.stringify(write.channels), bindingActor.label, bindingActor.role,
              bindingActor.issuer ?? null, bindingActor.sub ?? null, changedAt.toISOString(), recipient.kind, ownerOidcPrincipalId, ownerAuthorizationVersion],
          );
        }
        await client.query(
          `INSERT INTO cost_budget_alert_binding_history
            (tenant_id,budget_id,budget_revision,binding_revision,owner_user_id,owner_display_name,channel_refs,
             actor,actor_role,actor_issuer,actor_sub,changed_at,owner_recipient_kind,owner_oidc_principal_id,owner_authorization_version)
           VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [write.tenantId, write.budgetId, write.budgetRevision, bindingRevision, ownerUserId,
            ownerName, JSON.stringify(write.channels), bindingActor.label, bindingActor.role,
            bindingActor.issuer ?? null, bindingActor.sub ?? null, changedAt.toISOString(), recipient.kind, ownerOidcPrincipalId, ownerAuthorizationVersion],
        );
        await recordAudit(audit, client, bindingActor, write.tenantId, write.budgetId, write.budgetRevision);

        const result = parse(CostBudgetAlertBindingSchema, {
          tenantId: write.tenantId,
          budgetId: write.budgetId,
          budgetRevision: write.budgetRevision,
          bindingRevision,
          owner: recipient.kind === 'local'
            ? { userId: ownerUserId!, displayName: ownerName, role: 'ADMIN', enabled: true, locked: false }
            : { kind: 'oidc', principalId: ownerOidcPrincipalId!, displayName: ownerName, role: 'ADMIN', enabled: true, locked: false, authorizationVersion: ownerAuthorizationVersion! },
          channels: write.channels,
          updatedAt: changedAt.toISOString(),
          updatedBy: bindingActor.label,
        });
        await client.query(
          `INSERT INTO cost_alert_binding_commands(scope_key,idempotency_key,request_hash,result)
           VALUES($1,$2,$3,$4::jsonb)`, [commandScope, idempotencyKey, requestHash, JSON.stringify(result)],
        );
        return result;
      });
    },

    async listAlerts(input: CostAlertListQuery): Promise<CostAlertList> {
      const query = parse(CostAlertListQuerySchema, input);
      const cursor = query.cursor ? decodeCursor(query.cursor, query) : null;
      const args: unknown[] = [query.tenantId];
      const where = ['tenant_id=$1'];
      if (query.budgetId) { args.push(query.budgetId); where.push(`budget_id=$${args.length}`); }
      if (query.kind) { args.push(query.kind); where.push(`alert_kind=$${args.length}`); }
      if (cursor) {
        args.push(cursor.createdAt, cursor.alertId);
        where.push(`(created_at,alert_id)<($${args.length - 1}::timestamptz,$${args.length}::uuid)`);
      }
      args.push(query.limit + 1);
      const rowsResult = await db.query<AlertRow>(
        `SELECT alert_id::text AS alert_id,tenant_id::text AS tenant_id,budget_id::text AS budget_id,
                budget_revision,alert_kind,source,source_event_key,quota_scope,quota_scope_key,
                window_start,window_end,reservation_group_id::text AS reservation_group_id,
                operation_id::text AS operation_id,task_id::text AS task_id,invocation_id,attempt,
                usage_event_id,evaluation,trust,routing_state,binding_revision,owner_user_id::text AS owner_user_id,
                owner_display_name,channel_refs,created_at
           FROM cost_budget_alerts WHERE ${where.join(' AND ')}
          ORDER BY created_at DESC,alert_id DESC LIMIT $${args.length}`,
        args,
      );
      const hasMore = rowsResult.rows.length > query.limit;
      const rows = rowsResult.rows.slice(0, query.limit);
      const ids = rows.map((row) => row.alert_id);
      let deliveryRows: DeliveryRow[] = [];
      let attemptRows: AttemptRow[] = [];
      if (ids.length) {
        const deliveries = await db.query<DeliveryRow>(
          `SELECT delivery_id::text AS delivery_id,alert_id::text AS alert_id,channel_id,channel_revision,channel_name,state,
                  attempt_count,max_attempts,next_attempt_at,delivered_at
             FROM cost_alert_deliveries WHERE alert_id=ANY($1::uuid[]) ORDER BY alert_id,channel_id`, [ids],
        );
        deliveryRows = deliveries.rows;
        const deliveryIds = deliveryRows.map((row) => row.delivery_id);
        if (deliveryIds.length) {
          const attempts = await db.query<AttemptRow>(
            `SELECT delivery_id::text AS delivery_id,attempt,state,started_at,finished_at,error_code
               FROM cost_alert_delivery_attempts WHERE delivery_id=ANY($1::uuid[]) ORDER BY delivery_id,attempt`,
            [deliveryIds],
          );
          attemptRows = attempts.rows;
        }
      }
      const last = rows.at(-1);
      return parse(CostAlertListSchema, {
        tenantId: query.tenantId,
        items: rows.map((row) => mapAlert(row, deliveryRows, attemptRows)),
        limit: query.limit,
        hasMore,
        nextCursor: hasMore && last ? encodeCursor({
          createdAt: iso(last.created_at)!,
          alertId: last.alert_id,
          tenantId: query.tenantId,
          filterHash: filterHash(query),
        }) : null,
      });
    },

    async listOwnerInbox(input: CostAlertInboxQuery, owner: string | CostAlertInboxPrincipal): Promise<CostAlertInboxPage> {
      const query = parse(CostAlertInboxQuerySchema, input);
      const principal: CostAlertInboxPrincipal = typeof owner === 'string' ? { kind: 'local', userId: owner } : owner;
      const identityId = principal.kind === 'local' ? principal.userId : principal.principalId;
      if (!UUID.test(identityId) || (principal.kind === 'oidc'
        && (!Number.isSafeInteger(principal.authorizationVersion) || principal.authorizationVersion < 1))) invalid('inbox identity is invalid');
      const identityKey = principal.kind === 'local' ? identityId : `oidc:${identityId}:${principal.authorizationVersion}`;
      const cursor = query.cursor ? decodeInboxCursor(query.cursor, query, identityKey) : null;
      const args: unknown[] = principal.kind === 'local'
        ? [query.tenantId, identityId]
        : [query.tenantId, identityId, principal.authorizationVersion];
      const where = principal.kind === 'local'
        ? [
          'i.tenant_id=$1',
          "i.recipient_kind='local'",
          'i.recipient_user_id=$2',
          `EXISTS (SELECT 1 FROM admin_local_users u
                   WHERE u.tenant_id=i.tenant_id AND u.id=i.recipient_user_id
                     AND u.role='admin' AND u.is_enabled=true AND u.is_locked=false)`,
        ]
        : [
          'i.tenant_id=$1',
          "i.recipient_kind='oidc'",
          'i.recipient_oidc_principal_id=$2',
          'i.recipient_authorization_version=$3',
          `EXISTS (SELECT 1 FROM cost_alert_oidc_recipients p
                   WHERE p.principal_id=i.recipient_oidc_principal_id
                     AND p.state='ENABLED' AND p.observed_role='admin' AND p.observed_tenant_id IS NULL
                     AND p.authorization_version=i.recipient_authorization_version)`,
        ];
      if (query.unreadOnly) where.push('i.read_at IS NULL');
      if (cursor) {
        args.push(cursor.deliveredAt, cursor.deliveryId);
        where.push(`(i.delivered_at,i.delivery_id)<($${args.length - 1}::timestamptz,$${args.length}::uuid)`);
      }
      args.push(query.limit + 1);
      const result = await db.query<InboxRow>(
        `SELECT i.delivery_id::text AS delivery_id,a.alert_id::text AS alert_id,
                a.tenant_id::text AS tenant_id,a.budget_id::text AS budget_id,a.budget_revision,
                a.alert_kind,a.source,a.source_event_key,a.window_start,a.window_end,
                a.evaluation,a.trust,a.created_at,i.delivered_at,i.read_at
           FROM cost_alert_inbox i JOIN cost_budget_alerts a ON a.alert_id=i.alert_id
          WHERE ${where.join(' AND ')}
          ORDER BY i.delivered_at DESC,i.delivery_id DESC LIMIT $${args.length}`,
        args,
      );
      const hasMore = result.rows.length > query.limit;
      const rows = result.rows.slice(0, query.limit);
      const items = rows.map((row) => parse(CostAlertInboxItemSchema, {
        alertId: row.alert_id,
        tenantId: row.tenant_id,
        budgetId: row.budget_id,
        budgetRevision: Number(row.budget_revision),
        kind: row.alert_kind,
        source: row.source,
        sourceEventKey: row.source_event_key,
        windowStart: iso(row.window_start),
        windowEnd: iso(row.window_end),
        evaluation: row.evaluation,
        trust: row.trust,
        createdAt: iso(row.created_at),
        deliveredAt: iso(row.delivered_at),
        readAt: iso(row.read_at),
      }));
      const last = rows.at(-1);
      return parse(CostAlertInboxPageSchema, {
        tenantId: query.tenantId,
        items,
        limit: query.limit,
        hasMore,
        nextCursor: hasMore && last ? encodeInboxCursor({
          deliveredAt: iso(last.delivered_at)!,
          deliveryId: last.delivery_id,
          tenantId: query.tenantId,
          userId: identityKey,
          filterHash: inboxFilterHash(query, identityKey),
        }) : null,
      });
    },

    async markOwnerInboxRead(tenantId: string, owner: string | CostAlertInboxPrincipal, alertId: string): Promise<CostAlertInboxReadAck> {
      const principal: CostAlertInboxPrincipal = typeof owner === 'string' ? { kind: 'local', userId: owner } : owner;
      const identityId = principal.kind === 'local' ? principal.userId : principal.principalId;
      if (!UUID.test(tenantId) || !UUID.test(identityId) || !UUID.test(alertId)
        || (principal.kind === 'oidc' && (!Number.isSafeInteger(principal.authorizationVersion) || principal.authorizationVersion < 1))) invalid('inbox read scope is invalid');
      const readAt = now();
      if (!Number.isFinite(readAt.getTime())) unavailable('inbox clock is invalid');
      const updated = principal.kind === 'local'
        ? await db.query<{ read_at: Date | string } & QueryResultRow>(
          `UPDATE cost_alert_inbox i SET read_at=COALESCE(i.read_at,$4)
            WHERE i.tenant_id=$1 AND i.recipient_kind='local' AND i.recipient_user_id=$2 AND i.alert_id=$3
              AND EXISTS (SELECT 1 FROM admin_local_users u
                           WHERE u.tenant_id=i.tenant_id AND u.id=i.recipient_user_id
                             AND u.role='admin' AND u.is_enabled=true AND u.is_locked=false)
            RETURNING i.read_at`, [tenantId, identityId, alertId, readAt.toISOString()],
        )
        : await db.query<{ read_at: Date | string } & QueryResultRow>(
          `UPDATE cost_alert_inbox i SET read_at=COALESCE(i.read_at,$5)
            WHERE i.tenant_id=$1 AND i.recipient_kind='oidc' AND i.recipient_oidc_principal_id=$2
              AND i.recipient_authorization_version=$3 AND i.alert_id=$4
              AND EXISTS (SELECT 1 FROM cost_alert_oidc_recipients p
                           WHERE p.principal_id=i.recipient_oidc_principal_id
                             AND p.state='ENABLED' AND p.observed_role='admin' AND p.observed_tenant_id IS NULL
                             AND p.authorization_version=i.recipient_authorization_version)
            RETURNING i.read_at`, [tenantId, identityId, principal.authorizationVersion, alertId, readAt.toISOString()],
        );
      if (!updated.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'notification not found');
      return parse(CostAlertInboxReadAckSchema, { tenantId, alertId, readAt: iso(updated.rows[0].read_at) });
    },
  };
}

interface ClaimedDelivery {
  deliveryId: string;
  alertId: string;
  tenantId: string;
  channelId: string;
  channelRevision: number;
  channelName: string;
  recipientKind: 'local' | 'oidc';
  recipientUserId: string | null;
  recipientOidcPrincipalId: string | null;
  recipientAuthorizationVersion: number | null;
  recipientDisplayName: string;
  claimToken: string;
  attempt: number;
  payload: Record<string, unknown>;
}

function retryAt(now: Date, attempt: number): string {
  const delayMs = Math.min(5 * 60_000, 5_000 * 2 ** Math.max(0, attempt - 1));
  return new Date(now.getTime() + delayMs).toISOString();
}

/**
 * Claim due rows with SKIP LOCKED, then idempotently deliver to the first-party
 * owner-scoped Admin inbox. Backend owns the timer/config that invokes this
 * function; no HTTP client, external provider, browser URL or credential is
 * accepted.
 */
export async function runCostAlertDeliveryBatch(
  db: Db,
  input: { workerId: string; limit?: number; now?: Date },
): Promise<{ claimed: number; delivered: number; retried: number; exhausted: number; held: number }> {
  const limit = input.limit ?? 25;
  const now = input.now ?? new Date();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.workerId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || !Number.isFinite(now.getTime())) invalid('cost alert delivery batch parameters are invalid');

  const claimed = await db.tx(async (client) => {
    const expired = await client.query<{ delivery_id: string; claim_token: string; attempt_count: number } & QueryResultRow>(
      `SELECT delivery_id::text AS delivery_id,claim_token::text AS claim_token,attempt_count
         FROM cost_alert_deliveries
        WHERE state='CLAIMED' AND claim_expires_at <= $1
        ORDER BY claim_expires_at,delivery_id LIMIT $2 FOR UPDATE SKIP LOCKED`, [now.toISOString(), limit],
    );
    for (const delivery of expired.rows) {
      const nextState = Number(delivery.attempt_count) >= MAX_ATTEMPTS ? 'EXHAUSTED' : 'RETRY';
      const next = nextState === 'RETRY' ? retryAt(now, Number(delivery.attempt_count)) : null;
      await client.query(
        `UPDATE cost_alert_delivery_attempts SET state='UNKNOWN',finished_at=$3,error_code='DELIVERY_LEASE_EXPIRED'
          WHERE delivery_id=$1 AND claim_token=$2 AND state='CLAIMED'`,
        [delivery.delivery_id, delivery.claim_token, now.toISOString()],
      );
      await client.query(
        `UPDATE cost_alert_deliveries SET state=$2,next_attempt_at=$3,claimed_by=NULL,claim_token=NULL,
                claim_expires_at=NULL,last_error_code='DELIVERY_LEASE_EXPIRED',updated_at=$4
          WHERE delivery_id=$1 AND state='CLAIMED' AND claim_token=$5`,
        [delivery.delivery_id, nextState, next, now.toISOString(), delivery.claim_token],
      );
    }

    const due = await client.query<AlertRow & {
      delivery_id: string;
      channel_id: string;
      channel_revision: number;
      channel_name: string;
      recipient_kind: 'local' | 'oidc';
      recipient_user_id: string | null;
      recipient_oidc_principal_id: string | null;
      recipient_authorization_version: number | string | null;
      recipient_display_name: string;
      attempt_count: number;
    }>(
      `SELECT d.delivery_id::text AS delivery_id,d.channel_id,d.channel_revision,d.channel_name,
              d.recipient_kind,d.recipient_user_id::text AS recipient_user_id,
              d.recipient_oidc_principal_id::text AS recipient_oidc_principal_id,d.recipient_authorization_version,
              d.recipient_display_name,d.attempt_count,
              a.alert_id::text AS alert_id,a.tenant_id::text AS tenant_id,a.budget_id::text AS budget_id,
              a.budget_revision,a.alert_kind,a.source,a.source_event_key,a.quota_scope,a.quota_scope_key,
              a.window_start,a.window_end,a.reservation_group_id::text AS reservation_group_id,
              a.operation_id::text AS operation_id,a.task_id::text AS task_id,a.invocation_id,a.attempt,
              a.usage_event_id,a.evaluation,a.trust,a.routing_state,a.binding_revision,
              a.owner_user_id::text AS owner_user_id,a.owner_recipient_kind,
              a.owner_oidc_principal_id::text AS owner_oidc_principal_id,a.owner_authorization_version,
              a.owner_display_name,a.channel_refs,a.created_at
         FROM cost_alert_deliveries d JOIN cost_budget_alerts a ON a.alert_id=d.alert_id
         JOIN cost_alert_channels c ON c.channel_id=d.channel_id AND c.channel_revision=d.channel_revision
        WHERE d.state IN ('PENDING','RETRY') AND d.next_attempt_at <= $1 AND d.attempt_count < d.max_attempts
          AND c.kind='in-app'
        ORDER BY d.next_attempt_at,d.created_at,d.delivery_id
        LIMIT $2 FOR UPDATE OF d SKIP LOCKED`, [now.toISOString(), limit],
    );
    const values: ClaimedDelivery[] = [];
    for (const row of due.rows) {
      const claimToken = randomUUID();
      const attempt = Number(row.attempt_count) + 1;
      await client.query(
        `UPDATE cost_alert_deliveries SET state='CLAIMED',attempt_count=$2,claimed_by=$3,claim_token=$4,
                claim_expires_at=$5,updated_at=$6
          WHERE delivery_id=$1 AND state IN ('PENDING','RETRY')`,
        [row.delivery_id, attempt, input.workerId, claimToken, new Date(now.getTime() + CLAIM_LEASE_MS).toISOString(), now.toISOString()],
      );
      await client.query(
        `INSERT INTO cost_alert_delivery_attempts(delivery_id,attempt,claim_token,state,started_at)
         VALUES($1,$2,$3,'CLAIMED',$4)`, [row.delivery_id, attempt, claimToken, now.toISOString()],
      );
      values.push({
        deliveryId: row.delivery_id,
        alertId: row.alert_id,
        tenantId: row.tenant_id,
        channelId: row.channel_id,
        channelRevision: Number(row.channel_revision),
        channelName: row.channel_name,
        recipientKind: row.recipient_kind,
        recipientUserId: row.recipient_user_id,
        recipientOidcPrincipalId: row.recipient_oidc_principal_id,
        recipientAuthorizationVersion: row.recipient_authorization_version === null ? null : Number(row.recipient_authorization_version),
        recipientDisplayName: row.recipient_display_name,
        claimToken,
        attempt,
        payload: {
          alertId: row.alert_id,
          tenantId: row.tenant_id,
          budgetId: row.budget_id,
          budgetRevision: Number(row.budget_revision),
          kind: row.alert_kind,
          source: row.source,
          sourceEventKey: row.source_event_key,
          quotaScope: row.quota_scope,
          quotaScopeKey: row.quota_scope_key,
          windowStart: iso(row.window_start),
          windowEnd: iso(row.window_end),
          reservationGroupId: row.reservation_group_id,
          operationId: row.operation_id,
          taskId: row.task_id,
          invocationId: row.invocation_id,
          attempt: Number(row.attempt),
          usageEventId: row.usage_event_id,
          evaluation: row.evaluation,
          trust: row.trust,
          bindingRevision: row.binding_revision === null ? null : Number(row.binding_revision),
          ownerUserId: row.owner_user_id,
          ownerRecipient: row.owner_recipient_kind === 'oidc'
            ? { kind: 'oidc', principalId: row.owner_oidc_principal_id, authorizationVersion: Number(row.owner_authorization_version) }
            : row.owner_user_id === null ? null : { kind: 'local', userId: row.owner_user_id },
          ownerDisplayName: row.owner_display_name,
          channelId: row.channel_id,
          channelRevision: Number(row.channel_revision),
        },
      });
    }
    return values;
  });

  let delivered = 0;
  let retried = 0;
  let exhausted = 0;
  let held = 0;
  for (const claim of claimed) {
    try {
      const deliveryResult = await db.tx(async (client): Promise<'delivered' | 'held' | 'fenced'> => {
        const selected = await client.query<{
          state: string;
          claim_token: string | null;
          recipient_kind: 'local' | 'oidc';
          recipient_user_id: string | null;
          recipient_oidc_principal_id: string | null;
          recipient_authorization_version: number | string | null;
        } & QueryResultRow>(
          `SELECT state,claim_token::text AS claim_token,recipient_kind,
                  recipient_user_id::text AS recipient_user_id,
                  recipient_oidc_principal_id::text AS recipient_oidc_principal_id,recipient_authorization_version
             FROM cost_alert_deliveries
            WHERE delivery_id=$1 FOR UPDATE`, [claim.deliveryId],
        );
        const current = selected.rows[0];
        if (!current || current.state !== 'CLAIMED' || current.claim_token !== claim.claimToken) return 'fenced';

        let recipientAvailable = false;
        let recipientError = 'RECIPIENT_UNAVAILABLE';
        if (current.recipient_kind === 'local' && current.recipient_user_id === claim.recipientUserId) {
          const owner = await client.query<{ eligible: boolean } & QueryResultRow>(
            `SELECT (role='admin' AND is_enabled=true AND is_locked=false) AS eligible
               FROM admin_local_users WHERE tenant_id=$1 AND id=$2 FOR SHARE`, [claim.tenantId, current.recipient_user_id],
          );
          recipientAvailable = owner.rows[0]?.eligible === true;
          recipientError = 'LOCAL_OWNER_UNAVAILABLE';
        } else if (current.recipient_kind === 'oidc'
          && current.recipient_oidc_principal_id === claim.recipientOidcPrincipalId
          && Number(current.recipient_authorization_version) === claim.recipientAuthorizationVersion
          && current.recipient_oidc_principal_id && current.recipient_authorization_version !== null) {
          const owner = await client.query<{ state: string; observed_role: string; observed_tenant_id: string | null; authorization_version: number | string } & QueryResultRow>(
            `SELECT state,observed_role,observed_tenant_id::text AS observed_tenant_id,authorization_version
               FROM cost_alert_oidc_recipients WHERE principal_id=$1 FOR SHARE`, [current.recipient_oidc_principal_id],
          );
          const row = owner.rows[0];
          recipientAvailable = !!row && row.state === 'ENABLED' && row.observed_role === 'admin'
            && row.observed_tenant_id === null && Number(row.authorization_version) === Number(current.recipient_authorization_version);
          recipientError = !row ? 'OIDC_RECIPIENT_UNAVAILABLE'
            : row.state !== 'ENABLED' ? 'OIDC_RECIPIENT_DISABLED'
              : row.observed_role !== 'admin' || row.observed_tenant_id !== null ? 'OIDC_RECIPIENT_SCOPE_CHANGED'
                : Number(row.authorization_version) !== Number(current.recipient_authorization_version) ? 'OIDC_RECIPIENT_VERSION_STALE'
                  : 'OIDC_RECIPIENT_UNAVAILABLE';
        }

        if (!recipientAvailable) {
          await client.query(
            `UPDATE cost_alert_deliveries SET state='HELD',next_attempt_at=NULL,claimed_by=NULL,claim_token=NULL,
                    claim_expires_at=NULL,last_error_code=$3,updated_at=$4
              WHERE delivery_id=$1 AND state='CLAIMED' AND claim_token=$2`,
            [claim.deliveryId, claim.claimToken, recipientError, now.toISOString()],
          );
          await client.query(
            `UPDATE cost_alert_delivery_attempts SET state='UNKNOWN',finished_at=$3,error_code=$4
              WHERE delivery_id=$1 AND claim_token=$2 AND state='CLAIMED'`,
            [claim.deliveryId, claim.claimToken, now.toISOString(), recipientError],
          );
          return 'held';
        }

        await client.query(
          `INSERT INTO cost_alert_inbox(delivery_id,alert_id,tenant_id,recipient_kind,recipient_user_id,
                                       recipient_oidc_principal_id,recipient_authorization_version,payload,delivered_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT(delivery_id) DO NOTHING`,
          [claim.deliveryId, claim.alertId, claim.tenantId, current.recipient_kind, current.recipient_user_id,
            current.recipient_oidc_principal_id, current.recipient_authorization_version, JSON.stringify(claim.payload), now.toISOString()],
        );
        const updated = await client.query(
          `UPDATE cost_alert_deliveries SET state='DELIVERED',next_attempt_at=NULL,claimed_by=NULL,claim_token=NULL,
                  claim_expires_at=NULL,delivered_at=$3,last_error_code=NULL,updated_at=$3
            WHERE delivery_id=$1 AND state='CLAIMED' AND claim_token=$2`,
          [claim.deliveryId, claim.claimToken, now.toISOString()],
        );
        if (updated.rowCount !== 1) throw new Error('delivery claim changed during inbox commit');
        await client.query(
          `UPDATE cost_alert_delivery_attempts SET state='DELIVERED',finished_at=$3,error_code=NULL
            WHERE delivery_id=$1 AND claim_token=$2 AND state='CLAIMED'`,
          [claim.deliveryId, claim.claimToken, now.toISOString()],
        );
        return 'delivered';
      });
      if (deliveryResult === 'delivered') delivered += 1;
      else if (deliveryResult === 'held') held += 1;
    } catch {
      const nextState = claim.attempt >= MAX_ATTEMPTS ? 'EXHAUSTED' : 'RETRY';
      const nextAttemptAt = nextState === 'RETRY' ? retryAt(now, claim.attempt) : null;
      try {
        await db.tx(async (client) => {
          const result = await client.query(
            `UPDATE cost_alert_deliveries SET state=$3,next_attempt_at=$4,claimed_by=NULL,claim_token=NULL,
                    claim_expires_at=NULL,last_error_code='IN_APP_INBOX_WRITE_FAILED',updated_at=$5
              WHERE delivery_id=$1 AND state='CLAIMED' AND claim_token=$2`,
            [claim.deliveryId, claim.claimToken, nextState, nextAttemptAt, now.toISOString()],
          );
          if (result.rowCount !== 1) return;
          await client.query(
            `UPDATE cost_alert_delivery_attempts SET state=$3,finished_at=$4,error_code='IN_APP_INBOX_WRITE_FAILED'
              WHERE delivery_id=$1 AND claim_token=$2 AND state='CLAIMED'`,
            [claim.deliveryId, claim.claimToken, nextState, now.toISOString()],
          );
        });
      } catch {
        // The claim lease records an UNKNOWN result if its fenced retry write
        // cannot reach PostgreSQL; a later batch safely recovers it.
      }
      if (nextState === 'EXHAUSTED') exhausted += 1;
      else retried += 1;
    }
  }
  return { claimed: claimed.length, delivered, retried, exhausted, held };
}
