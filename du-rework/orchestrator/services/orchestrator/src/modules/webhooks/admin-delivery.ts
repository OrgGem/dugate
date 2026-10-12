import type { PoolClient } from 'pg';
import { ProfileCallbackPolicySchema, ProfileCallbackPolicySnapshotSchema, authorizeCallbackDestination } from '@du/contracts';
import { conflict, notFound } from '../../http/errors';

export type AdminDeliveryCapabilities = { dispatcherConfigured: boolean; authResolverConfigured: boolean };
export type AdminDeliveryItem = {
  deliveryId: string; status: string; attempts: number; maxAttempts: number;
  lastError: string | null; nextAttemptAt: string | null; canRetry: boolean; disabledReason: string | null;
};
const LIMIT = 10;
const SAFE_ERRORS = new Set(['WEBHOOK_TRANSPORT_FAILED', 'DESTINATION_UNRESOLVED', 'DESTINATION_DENIED',
  'WEBHOOK_ENCRYPTION_FAILED', 'WEBHOOK_AUTH_UNAVAILABLE', 'WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED',
  'WEBHOOK_POLICY_INVALID', 'SHUTDOWN_RELEASED']);
type Row = Record<string, any>;
function reason(row: Row, caps: AdminDeliveryCapabilities): string | null {
  if (row.status !== 'FAILED') return 'Only a failed delivery can be retried; pending or in-flight deliveries must finish first.';
  if (!Number.isInteger(row.attempts) || !Number.isInteger(row.max_attempts) || row.attempts < 0 || row.max_attempts < 1 || row.attempts >= LIMIT || row.max_attempts > LIMIT) return 'The manual delivery attempt limit has been reached or the stored budget is invalid.';
  if (!caps.dispatcherConfigured) return 'Callback dispatch is not configured.';
  if (row.callback_policy != null) {
    let raw = row.callback_policy;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return 'The immutable callback policy is invalid.'; } }
    const snapshot = ProfileCallbackPolicySnapshotSchema.safeParse(raw);
    const parsed = ProfileCallbackPolicySchema.safeParse(snapshot.success ? snapshot.data.policy : raw);
    if (!parsed.success) return 'The immutable callback policy is invalid.';
    if (authorizeCallbackDestination(row.destination_url, parsed.data.auth, parsed.data.destination).kind === 'DENIED') return 'The pinned callback policy denies this destination.';
    if (parsed.data.auth.method !== 'none') {
      if (!caps.authResolverConfigured) return 'The callback credential resolver is not configured.';
    }
  }
  return null;
}
function item(row: Row, caps: AdminDeliveryCapabilities): AdminDeliveryItem {
  const disabledReason = reason(row, caps);
  const error = typeof row.last_error === 'string' ? row.last_error : null;
  return { deliveryId: row.delivery_id, status: row.status, attempts: row.attempts, maxAttempts: row.max_attempts,
    lastError: error == null ? null : SAFE_ERRORS.has(error) || /^HTTP_[1-5][0-9]{2}$/.test(error) ? error : 'DELIVERY_FAILED',
    nextAttemptAt: row.next_at == null ? null : new Date(row.next_at).toISOString(), canRetry: disabledReason === null, disabledReason };
}
export async function listAdminDeliveries(db: Pick<PoolClient, 'query'>, operationId: string, tenantId: string, capabilities: AdminDeliveryCapabilities): Promise<{ items: AdminDeliveryItem[] }> {
  const op = await db.query('SELECT id FROM operations WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL', [operationId, tenantId]);
  if (!op.rowCount) throw notFound('operation not found');
  const rows = await db.query('SELECT * FROM webhook_deliveries WHERE operation_id=$1 AND tenant_id=$2 ORDER BY created_at DESC', [operationId, tenantId]);
  return { items: rows.rows.map(row => item(row, capabilities)) };
}
/** Caller supplies the action transaction: row lock, audit and idempotency commit together. */
export async function retryAdminDelivery(client: PoolClient, input: { operationId: string; deliveryId: string; tenantId: string; expectedAttempts: number }, capabilities: AdminDeliveryCapabilities): Promise<AdminDeliveryItem> {
  const rows = await client.query(`SELECT d.* FROM webhook_deliveries d JOIN operations o ON o.id=d.operation_id AND o.tenant_id=d.tenant_id AND o.deleted_at IS NULL
    WHERE d.delivery_id=$1 AND d.operation_id=$2 AND d.tenant_id=$3 FOR UPDATE OF d`, [input.deliveryId, input.operationId, input.tenantId]);
  const row = rows.rows[0];
  if (!row) throw notFound('callback delivery not found');
  if (!Number.isInteger(input.expectedAttempts) || input.expectedAttempts !== row.attempts) throw conflict('STATE_CONFLICT', 'Delivery attempts changed; refresh before retrying.');
  const disabled = reason(row, capabilities);
  if (disabled) throw conflict('CALLBACK_RETRY_BLOCKED', disabled);
  // Preserve the consumed count and existing budget. Exhaustion earns exactly one
  // additional attempt; configuration failures reuse their unconsumed budget.
  const result = await client.query(`UPDATE webhook_deliveries SET status='PENDING', max_attempts=GREATEST(max_attempts,attempts+1), next_at=now(), updated_at=now()
    WHERE delivery_id=$1 AND status='FAILED' AND attempts=$2 RETURNING *`, [input.deliveryId, input.expectedAttempts]);
  if (!result.rowCount) throw conflict('STATE_CONFLICT', 'Delivery changed; refresh before retrying.');
  return item(result.rows[0], capabilities);
}
