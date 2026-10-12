import type { PoolClient, QueryResultRow } from 'pg';
import type { MaintenanceControlState, MaintenanceScope } from '@du/contracts';

export interface RuntimeControlSnapshot {
  state: MaintenanceControlState;
  revision: number;
  states: Array<{ scopeKind: 'platform' | 'tenant' | 'business'; scopeId: string; state: MaintenanceControlState; revision: number }>;
}

interface ControlRow extends QueryResultRow {
  scope_kind: 'platform' | 'tenant' | 'business';
  scope_id: string;
  desired_state: MaintenanceControlState;
  revision: number | string;
}

type ScopeKey = { scopeKind: 'platform' | 'tenant' | 'business'; scopeId: string };

function scopeRows(scope: MaintenanceScope | { tenantId?: string; businessId?: string }): ScopeKey[] {
  const rows: Array<{ scopeKind: 'platform' | 'tenant' | 'business'; scopeId: string }> = [
    { scopeKind: 'platform', scopeId: 'all' },
  ];
  if ('kind' in scope) {
    if (scope.kind === 'tenant') rows.push({ scopeKind: 'tenant', scopeId: scope.tenantId });
    if (scope.kind === 'business') rows.push({ scopeKind: 'business', scopeId: scope.businessId });
  } else {
    if (scope.tenantId) rows.push({ scopeKind: 'tenant', scopeId: scope.tenantId });
    if (scope.businessId) rows.push({ scopeKind: 'business', scopeId: scope.businessId });
  }
  return rows;
}

/**
 * Lock and read every applicable persisted admission scope in a stable order.
 * Queue dispatch, claims and control mutations share these row locks, so a
 * task cannot slip through between a pause and its durable revision.
 */
export async function lockRuntimeControls(client: PoolClient, scope: MaintenanceScope | { tenantId?: string; businessId?: string }): Promise<RuntimeControlSnapshot> {
  const keys = scopeRows(scope);
  for (const key of keys) {
    await client.query(
      `INSERT INTO runtime_control_scopes(scope_kind,scope_id,desired_state,revision,reason,actor)
       VALUES ($1,$2,'OPEN',nextval('runtime_control_revision_seq'),'initial control state','system')
       ON CONFLICT (scope_kind,scope_id) DO NOTHING`,
      [key.scopeKind, key.scopeId],
    );
  }
  const conditions = keys.map((_, index) => `($${index * 2 + 1},$${index * 2 + 2})`).join(',');
  const rows = await client.query<ControlRow>(
    `SELECT scope_kind,scope_id,desired_state,revision
       FROM runtime_control_scopes
      WHERE (scope_kind,scope_id) IN (VALUES ${conditions})
      ORDER BY CASE scope_kind WHEN 'platform' THEN 0 WHEN 'tenant' THEN 1 ELSE 2 END, scope_id
      FOR SHARE`,
    keys.flatMap(({ scopeKind, scopeId }) => [scopeKind, scopeId]),
  );
  const states = rows.rows.map((row) => ({
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    state: row.desired_state,
    revision: Number(row.revision),
  }));
  const state: MaintenanceControlState = states.some((entry) => entry.state === 'DRAINING')
    ? 'DRAINING'
    : states.some((entry) => entry.state === 'PAUSED')
      ? 'PAUSED'
      : 'OPEN';
  return { state, revision: Math.max(0, ...states.map((entry) => entry.revision)), states };
}

export async function lockRuntimeControlsForTask(client: PoolClient, input: { tenantId: string; businessId: string }): Promise<RuntimeControlSnapshot> {
  return lockRuntimeControls(client, input);
}

/** Platform+business projection used by heartbeat acknowledgements. */
export async function readWorkerControl(client: PoolClient, businessId: string): Promise<RuntimeControlSnapshot> {
  return lockRuntimeControls(client, { kind: 'business', businessId });
}
