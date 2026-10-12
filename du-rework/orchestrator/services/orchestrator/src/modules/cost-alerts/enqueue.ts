import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import {
  BudgetConfigSchema,
  budgetQuotaScopeKey,
  quotaScopeForBudget,
  CostBudgetAlertEnqueueFactsSchema,
  type CostBudgetAlertEnqueueFacts,
  type CostAlertKind,
} from '@du/contracts';
import { HttpError } from '../../http/errors';

interface BudgetRow extends QueryResultRow {
  tenant_id: string;
  config: unknown;
  published_at: Date | string | null;
}

interface BindingRow extends QueryResultRow {
  binding_revision: number;
  owner_recipient_kind: 'local' | 'oidc';
  owner_user_id: string | null;
  owner_oidc_principal_id: string | null;
  owner_authorization_version: number | string | null;
  owner_display_name: string;
  channel_refs: unknown;
}

interface OwnerRow extends QueryResultRow {
  role: string;
  is_enabled: boolean;
  is_locked: boolean;
}

interface OidcOwnerRow extends QueryResultRow {
  observed_role: string;
  observed_tenant_id: string | null;
  state: string;
  authorization_version: number | string;
}

interface ChannelRow extends QueryResultRow {
  channel_id: string;
  channel_revision: number;
  kind: string;
  display_name: string;
  enabled: boolean;
}

function alertKinds(facts: CostBudgetAlertEnqueueFacts): CostAlertKind[] {
  const kinds: CostAlertKind[] = [];
  if (facts.evaluation.limitExceeded) kinds.push('limit');
  if (facts.evaluation.warnThresholdExceeded) kinds.push('threshold');
  if (facts.trust.reasonCode !== null) kinds.push('trust_gap');
  return kinds;
}

interface ChannelRef { channelId: string; channelRevision: number; }

function channelRefs(value: unknown): ChannelRef[] | null {
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

function resolveScope(key: string, budget: ReturnType<typeof BudgetConfigSchema.parse>): unknown {
  const scope = quotaScopeForBudget(budget);
  if (budgetQuotaScopeKey(scope) !== key) {
    throw new HttpError(503, 'COST_ALERT_SOURCE_INVALID', 'the trusted quota scope did not match its tenant');
  }
  return scope;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

/**
 * Persist alert facts inside the already-open Usage reservation-group
 * transaction. This function deliberately never starts or commits a
 * transaction and never performs delivery. Source and window uniqueness make
 * the producer replay safe while preserving the first immutable source refs.
 */
export async function enqueueCostBudgetAlerts(
  client: PoolClient,
  input: CostBudgetAlertEnqueueFacts,
): Promise<void> {
  const facts = CostBudgetAlertEnqueueFactsSchema.parse(input);
  const kinds = alertKinds(facts);
  if (kinds.length === 0) return;

  const budgetResult = await client.query<BudgetRow>(
    `SELECT tenant_id::text AS tenant_id,config,published_at
       FROM cost_budget_revisions
      WHERE tenant_id=$1 AND budget_id=$2 AND revision=$3`,
    [facts.tenantId, facts.budgetId, facts.budgetRevision],
  );
  const budgetRow = budgetResult.rows[0];
  if (!budgetRow || budgetRow.tenant_id !== facts.tenantId || budgetRow.published_at == null) {
    throw new HttpError(503, 'COST_ALERT_SOURCE_INVALID', 'the source budget revision could not be verified');
  }
  const budget = BudgetConfigSchema.safeParse(budgetRow.config);
  if (!budget.success || budget.data.tenantId !== facts.tenantId) {
    throw new HttpError(503, 'COST_ALERT_SOURCE_INVALID', 'the source budget snapshot is invalid');
  }
  const quotaScope = resolveScope(facts.quotaScopeKey, budget.data);

  const bindingResult = await client.query<BindingRow>(
    `SELECT binding_revision,owner_recipient_kind,owner_user_id::text AS owner_user_id,
            owner_oidc_principal_id::text AS owner_oidc_principal_id,owner_authorization_version,
            owner_display_name,channel_refs
       FROM cost_budget_alert_bindings
      WHERE tenant_id=$1 AND budget_id=$2 AND budget_revision=$3 FOR SHARE`,
    [facts.tenantId, facts.budgetId, facts.budgetRevision],
  );
  const binding = bindingResult.rows[0];
  const configuredChannels = binding ? channelRefs(binding.channel_refs) : null;
  const configuredChannelIds = configuredChannels?.map((channel) => channel.channelId) ?? [];
  const bindingMatchesPolicy = configuredChannels !== null
    && sameIds(configuredChannelIds, budget.data.notificationChannels);
  const ownerResult = binding?.owner_recipient_kind === 'local' && binding.owner_user_id
    ? await client.query<OwnerRow>(
      `SELECT role,is_enabled,is_locked FROM admin_local_users
        WHERE tenant_id=$1 AND id=$2 FOR SHARE`, [facts.tenantId, binding.owner_user_id])
    : null;
  const oidcOwnerResult = binding?.owner_recipient_kind === 'oidc' && binding.owner_oidc_principal_id
    ? await client.query<OidcOwnerRow>(
      `SELECT observed_role,observed_tenant_id::text AS observed_tenant_id,state,authorization_version
         FROM cost_alert_oidc_recipients WHERE principal_id=$1 FOR SHARE`, [binding.owner_oidc_principal_id])
    : null;
  const ownerCurrent = binding?.owner_recipient_kind === 'local'
    ? ownerResult?.rows[0]?.role === 'admin'
      && ownerResult.rows[0].is_enabled === true
      && ownerResult.rows[0].is_locked === false
    : binding?.owner_recipient_kind === 'oidc'
      && oidcOwnerResult?.rows[0]?.observed_role === 'admin'
      && oidcOwnerResult.rows[0].observed_tenant_id === null
      && oidcOwnerResult.rows[0].state === 'ENABLED'
      && Number(oidcOwnerResult.rows[0].authorization_version) === Number(binding.owner_authorization_version);
  const activeChannels: ChannelRow[] = [];
  if (bindingMatchesPolicy && configuredChannels) {
    for (const channel of configuredChannels) {
      const result = await client.query<ChannelRow>(
        `SELECT channel_id,channel_revision,kind,display_name,enabled FROM cost_alert_channels
          WHERE channel_id=$1 AND channel_revision=$2 AND kind='in-app' FOR SHARE`,
        [channel.channelId, channel.channelRevision],
      );
      if (result.rows[0]) activeChannels.push(result.rows[0]);
    }
  }
  const channelsCurrent = bindingMatchesPolicy && configuredChannels !== null
    && activeChannels.length === configuredChannels.length;
  const channelsEnabled = activeChannels.every((channel) => channel.enabled === true && channel.kind === 'in-app');
  const routed = binding !== undefined && ownerCurrent && channelsCurrent && channelsEnabled;

  for (const kind of kinds) {
    const alertId = randomUUID();
    const frozenOwnerId = binding?.owner_user_id ?? null;
    const frozenOidcOwnerId = binding?.owner_oidc_principal_id ?? null;
    const frozenOwnerKind = binding?.owner_recipient_kind ?? null;
    const frozenOwnerVersion = binding?.owner_authorization_version === null || binding?.owner_authorization_version === undefined
      ? null : Number(binding.owner_authorization_version);
    const frozenOwnerName = binding?.owner_display_name ?? null;
    const frozenChannels = configuredChannels
      ? configuredChannels.map((channel) => ({
        ...channel,
        displayName: activeChannels.find((row) => row.channel_id === channel.channelId)?.display_name ?? channel.channelId,
      }))
      : [];
    const inserted = await client.query<{ alert_id: string } & QueryResultRow>(
      `INSERT INTO cost_budget_alerts
        (alert_id,tenant_id,budget_id,budget_revision,alert_kind,source,source_event_key,
         quota_scope,quota_scope_key,window_start,window_end,reservation_group_id,operation_id,
         task_id,invocation_id,attempt,usage_event_id,evaluation,trust,routing_state,
         binding_revision,owner_user_id,owner_display_name,channel_refs,owner_recipient_kind,
         owner_oidc_principal_id,owner_authorization_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$20,$21,$22,$23,$24::jsonb,$25,$26,$27)
       ON CONFLICT DO NOTHING RETURNING alert_id::text AS alert_id`,
      [alertId, facts.tenantId, facts.budgetId, facts.budgetRevision, kind, facts.source, facts.sourceEventKey,
        JSON.stringify(quotaScope), facts.quotaScopeKey, facts.windowStart, facts.windowEnd,
        facts.reservationGroupId, facts.operationId, facts.taskId, facts.invocationId, facts.attempt,
        facts.usageEventId ?? null, JSON.stringify(facts.evaluation), JSON.stringify(facts.trust), routed ? 'ROUTED' : 'UNROUTED',
        binding ? Number(binding.binding_revision) : null, frozenOwnerId, frozenOwnerName, JSON.stringify(frozenChannels),
        frozenOwnerKind, frozenOidcOwnerId, frozenOwnerVersion],
    );
    if (!inserted.rows[0]) continue;
    if (!routed) continue;

    for (const channel of activeChannels) {
      await client.query(
        `INSERT INTO cost_alert_deliveries
          (delivery_id,alert_id,tenant_id,channel_id,channel_revision,channel_name,recipient_user_id,
           recipient_display_name,state,attempt_count,max_attempts,next_attempt_at,recipient_kind,
           recipient_oidc_principal_id,recipient_authorization_version)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',0,8,now(),$9,$10,$11)
         ON CONFLICT (alert_id,channel_id,channel_revision) DO NOTHING`,
        [randomUUID(), inserted.rows[0].alert_id, facts.tenantId, channel.channel_id, channel.channel_revision,
          channel.display_name, binding!.owner_user_id, binding!.owner_display_name,
          binding!.owner_recipient_kind, binding!.owner_oidc_principal_id,binding!.owner_authorization_version],
      );
    }
  }
}
