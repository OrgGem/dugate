import type { QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { runCostAlertDeliveryBatch } from '../src/modules/cost-alerts/service';

const NOW = new Date('2026-10-11T22:00:00.000Z');
const DELIVERY = '11111111-1111-4111-8111-111111111111';
const ALERT = '22222222-2222-4222-8222-222222222222';
const TENANT = '33333333-3333-4333-8333-333333333333';
const OWNER = '44444444-4444-4444-8444-444444444444';

function dueRow(attemptCount: number): Record<string, unknown> {
  return {
    delivery_id: DELIVERY,
    channel_id: 'tenant-admin-inbox-v1',
    channel_revision: 1,
    channel_name: 'Tenant Admin inbox',
    recipient_kind: 'local',
    recipient_user_id: OWNER,
    recipient_oidc_principal_id: null,
    recipient_authorization_version: null,
    recipient_display_name: 'billing-admin',
    attempt_count: attemptCount,
    alert_id: ALERT,
    tenant_id: TENANT,
    budget_id: '55555555-5555-4555-8555-555555555555',
    budget_revision: 2,
    alert_kind: 'threshold',
    source: 'preflight',
    source_event_key: 'preflight:group:budget:2',
    quota_scope: { tenantId: TENANT },
    quota_scope_key: JSON.stringify([TENANT, null, null, null]),
    window_start: '2026-10-01T00:00:00.000Z',
    window_end: '2026-11-01T00:00:00.000Z',
    reservation_group_id: '66666666-6666-4666-8666-666666666666',
    operation_id: '77777777-7777-4777-8777-777777777777',
    task_id: '88888888-8888-4888-8888-888888888888',
    invocation_id: 'invocation-1',
    attempt: 1,
    usage_event_id: null,
    evaluation: {
      action: 'WARN', hardCapEnabled: false, warnThresholdExceeded: true, usagePercent: 81,
      limitExceeded: false, remainingTokens: 190, remainingCostMicrousd: 1900,
    },
    trust: { confidence: 'upper-bound', reasonCode: null },
    routing_state: 'ROUTED',
    binding_revision: 4,
    owner_user_id: OWNER,
    owner_recipient_kind: 'local',
    owner_oidc_principal_id: null,
    owner_authorization_version: null,
    owner_display_name: 'billing-admin',
    channel_refs: [{ channelId: 'tenant-admin-inbox-v1', channelRevision: 1 }],
    created_at: '2026-10-11T21:59:00.000Z',
  };
}

const OIDC_OWNER = '99999999-9999-4999-8999-999999999999';

function oidcDueRow(attemptCount: number): Record<string, unknown> {
  return {
    ...dueRow(attemptCount),
    recipient_kind: 'oidc',
    recipient_user_id: null,
    recipient_oidc_principal_id: OIDC_OWNER,
    recipient_authorization_version: 7,
    recipient_display_name: 'External OIDC Admin · 123ABC4567',
    owner_user_id: null,
    owner_recipient_kind: 'oidc',
    owner_oidc_principal_id: OIDC_OWNER,
    owner_authorization_version: 7,
  };
}

function deliveryDb(options: {
  due?: Record<string, unknown>[];
  failInbox?: boolean;
  oidcRecipient?: { state: string; observed_role: string; observed_tenant_id: string | null; authorization_version: number | string };
} = {}) {
  const calls: Array<{ tx: number; sql: string; values?: unknown[] }> = [];
  let transaction = 0;
  let claimToken = '';
  let claimedRow: Record<string, unknown> | undefined;
  const db = {
    async tx<T>(run: (client: never) => Promise<T>): Promise<T> {
      transaction += 1;
      const tx = transaction;
      const client = {
        async query(sql: string, values?: unknown[]) {
          calls.push({ tx, sql, values });
          if (sql.includes("WHERE state='CLAIMED' AND claim_expires_at")) return { rows: [] };
          if (sql.includes('FROM cost_alert_deliveries d JOIN cost_budget_alerts')) {
            claimedRow = options.due?.[0];
            return { rows: options.due ?? [] };
          }
          if (sql.includes("SET state='CLAIMED',attempt_count")) {
            claimToken = String(values?.[3] ?? '');
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes('SELECT state,claim_token::text AS claim_token')) return {
            rows: [{
              state: 'CLAIMED', claim_token: claimToken,
              recipient_kind: claimedRow?.['recipient_kind'] ?? 'local',
              recipient_user_id: claimedRow && Object.hasOwn(claimedRow, 'recipient_user_id') ? claimedRow['recipient_user_id'] : OWNER,
              recipient_oidc_principal_id: claimedRow?.['recipient_oidc_principal_id'] ?? null,
              recipient_authorization_version: claimedRow?.['recipient_authorization_version'] ?? null,
            } as QueryResultRow], rowCount: 1,
          };
          if (sql.includes('FROM admin_local_users WHERE tenant_id=$1 AND id=$2 FOR SHARE')) return { rows: [{ eligible: true } as QueryResultRow], rowCount: 1 };
          if (sql.includes('FROM cost_alert_oidc_recipients WHERE principal_id=$1 FOR SHARE')) return {
            rows: [options.oidcRecipient ?? { state: 'ENABLED', observed_role: 'admin', observed_tenant_id: null, authorization_version: 7 } as QueryResultRow], rowCount: 1,
          };
          if (sql.includes('INSERT INTO cost_alert_inbox')) {
            if (options.failInbox) throw new Error('simulated isolated inbox write failure');
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("SET state='DELIVERED'")) return { rows: [], rowCount: 1 };
          if (sql.includes('UPDATE cost_alert_deliveries SET state=$3,next_attempt_at=$4')) return { rows: [], rowCount: 1 };
          return { rows: [], rowCount: 1 };
        },
      };
      return run(client as never);
    },
  };
  return { db: db as unknown as Db, calls };
}

describe('ORV14 COST-04 owner inbox delivery worker', () => {
  test('writes inbox receipt and delivery completion in one fenced transaction', async () => {
    const fake = deliveryDb({ due: [dueRow(0)] });
    const result = await runCostAlertDeliveryBatch(fake.db, { workerId: 'owner-test-worker', limit: 1, now: NOW });

    expect(result).toEqual({ claimed: 1, delivered: 1, retried: 0, exhausted: 0, held: 0 });
    const inboxWrite = fake.calls.find((call) => call.sql.includes('INSERT INTO cost_alert_inbox'));
    const deliveryDone = fake.calls.find((call) => call.sql.includes("SET state='DELIVERED'"));
    expect(inboxWrite?.tx).toBe(2);
    expect(deliveryDone?.tx).toBe(2);
    expect(inboxWrite?.tx).toBe(deliveryDone?.tx);
    expect(JSON.parse(String(inboxWrite?.values?.[7]))).toMatchObject({
      alertId: ALERT, tenantId: TENANT, ownerUserId: OWNER, channelRevision: 1,
    });
    expect(fake.calls.find((call) => call.sql.includes("INSERT INTO cost_alert_delivery_attempts"))?.tx).toBe(1);
  });

  test('records a bounded retry or exhaustion when the isolated inbox write fails', async () => {
    const retry = deliveryDb({ due: [dueRow(0)], failInbox: true });
    const retryResult = await runCostAlertDeliveryBatch(retry.db, { workerId: 'owner-test-worker', limit: 1, now: NOW });
    expect(retryResult).toEqual({ claimed: 1, delivered: 0, retried: 1, exhausted: 0, held: 0 });
    const retryWrite = retry.calls.find((call) => call.sql.includes('UPDATE cost_alert_deliveries SET state=$3,next_attempt_at=$4'));
    expect(retryWrite?.values?.[2]).toBe('RETRY');
    expect(retryWrite?.values?.[3]).toBe('2026-10-11T22:00:05.000Z');

    const exhausted = deliveryDb({ due: [dueRow(7)], failInbox: true });
    const exhaustedResult = await runCostAlertDeliveryBatch(exhausted.db, { workerId: 'owner-test-worker', limit: 1, now: NOW });
    expect(exhaustedResult).toEqual({ claimed: 1, delivered: 0, retried: 0, exhausted: 1, held: 0 });
    const exhaustedWrite = exhausted.calls.find((call) => call.sql.includes('UPDATE cost_alert_deliveries SET state=$3,next_attempt_at=$4'));
    expect(exhaustedWrite?.values?.[2]).toBe('EXHAUSTED');
    expect(exhaustedWrite?.values?.[3]).toBeNull();
  });

  test('delivers to the frozen OIDC principal only while its authorization version is current', async () => {
    const fake = deliveryDb({ due: [oidcDueRow(0)] });
    const result = await runCostAlertDeliveryBatch(fake.db, { workerId: 'owner-test-worker', limit: 1, now: NOW });
    expect(result).toEqual({ claimed: 1, delivered: 1, retried: 0, exhausted: 0, held: 0 });
    const inboxWrite = fake.calls.find((call) => call.sql.includes('INSERT INTO cost_alert_inbox'));
    expect(inboxWrite?.values?.[3]).toBe('oidc');
    expect(inboxWrite?.values?.[4]).toBeNull();
    expect(inboxWrite?.values?.[5]).toBe(OIDC_OWNER);
    expect(inboxWrite?.values?.[6]).toBe(7);
    expect(fake.calls.some((call) => call.sql.includes('FROM cost_alert_oidc_recipients WHERE principal_id=$1 FOR SHARE'))).toBe(true);
  });

  test('holds delivery without rerouting when the frozen OIDC recipient is disabled', async () => {
    const fake = deliveryDb({
      due: [oidcDueRow(0)],
      oidcRecipient: { state: 'DISABLED', observed_role: 'admin', observed_tenant_id: null, authorization_version: 8 },
    });
    const result = await runCostAlertDeliveryBatch(fake.db, { workerId: 'owner-test-worker', limit: 1, now: NOW });
    expect(result).toEqual({ claimed: 1, delivered: 0, retried: 0, exhausted: 0, held: 1 });
    expect(fake.calls.some((call) => call.sql.includes('INSERT INTO cost_alert_inbox'))).toBe(false);
    const heldWrite = fake.calls.find((call) => call.sql.includes("SET state='HELD'"));
    expect(heldWrite?.values?.[2]).toBe('OIDC_RECIPIENT_DISABLED');
    expect(fake.calls.some((call) => call.sql.includes("SET state='DELIVERED'"))).toBe(false);
  });
});
