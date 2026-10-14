import type { PoolClient } from 'pg';
import { budgetQuotaScopeKey, resolveBudgetQuotaWindow } from '@du/contracts';
import type { BudgetConfigInput } from '@du/contracts';
import type { Db } from '../src/db/db';
import { createBudgetReservationService } from '../src/modules/usage/budget-reservations';
import { createBackupSnapshotWriteGate } from '../src/modules/maintenance/backup-effect-fence';

const TENANT = '50000000-0000-4000-8000-000000000007';
const API_KEY = 'key-or10-07';
const PROFILE = 'profile-or10-07';
const BUSINESS = 'document-core';
const OPERATION = '3f2a8c9e-1b4d-4a6c-8e2f-9d0c1b2a3f45';
const TASK = 'a1a2a3a4-a5a6-47a8-89aa-a1a2a3a4a5a6';
const NOW = new Date('2026-09-28T12:00:00.000Z');

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

function result(rows: Record<string, unknown>[]) {
  return { rows, rowCount: rows.length };
}

describe('OR10-07 advisory lock encoding', () => {
  test('backup snapshot write fence accepts the canonical default tenant sentinel', async () => {
    const query = jest.fn(async () => result([{ state: 'OPEN', fence_id: null, fence_revision: 0 }]));
    const client = { query } as unknown as PoolClient;
    const gate = createBackupSnapshotWriteGate();
    await expect(gate.assertWriteAllowed(client, {
      tenantId: '00000000-0000-0000-0000-000000000001',
      domain: 'secret-catalog-write',
      requestKey: 'tenant-sentinel-write-0001',
    })).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
  });

  test('reserve sends a NUL-free, tuple-preserving lock key to PostgreSQL', async () => {
    const lockParameters: unknown[] = [];
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        const normalized = sql.replace(/\s+/g, ' ').trim();
        if (normalized.includes('FROM maintenance_backup_effect_gate')) {
          return result([{ state: 'OPEN', fence_id: null, fence_revision: 0 }]);
        }
        if (normalized.startsWith('SELECT pg_advisory_xact_lock')) {
          lockParameters.push(params[0]);
          return result([]);
        }
        if (normalized.includes('FROM budget_reservations') && normalized.includes('idempotency_key = $2')) {
          return result([]);
        }
        if (normalized.includes('FROM operations o')) {
          return result([{
            operation_id: OPERATION,
            task_id: TASK,
            tenant_id: TENANT,
            api_key_id: API_KEY,
            profile_id: PROFILE,
            business_id: BUSINESS,
          }]);
        }
        if (normalized.includes('FROM usage_events ue')) return result([]);
        if (normalized.includes("status IN ('RESERVED', 'RUNNING', 'UNKNOWN')")) return result([]);
        if (normalized.startsWith('INSERT INTO budget_reservations')) {
          const [
            reservationId,
            tenantId,
            scopeKey,
            scopeJson,
            budgetJson,
            period,
            from,
            to,
            idempotencyKey,
            requestHash,
            operationId,
            taskId,
            invocationId,
            attempt,
            tokens,
            cost,
            confidence,
            status,
            hardCapEnabled,
            evaluationJson,
          ] = params;
          return result([{
            reservation_id: String(reservationId),
            tenant_id: String(tenantId),
            scope_key: String(scopeKey),
            quota_scope: JSON.parse(String(scopeJson)) as unknown,
            budget_config: JSON.parse(String(budgetJson)) as unknown,
            period: String(period),
            window_start: new Date(String(from)),
            window_end: new Date(String(to)),
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
          }]);
        }
        throw new Error(`unexpected SQL in OR10-07 test: ${normalized}`);
      },
    };
    const db = {
      pool: {},
      query: async (): Promise<never> => { throw new Error('unexpected non-transactional query'); },
      tx: async <T>(fn: (transactionClient: PoolClient) => Promise<T>): Promise<T> =>
        fn(client as unknown as PoolClient),
      close: async (): Promise<void> => undefined,
    } as unknown as Db;
    const service = createBudgetReservationService(db, {
      clock: () => NOW,
      backupSnapshotWriteGate: createBackupSnapshotWriteGate(),
    });

    const admission = await service.reserve({
      budget: BUDGET,
      quotaScope: { tenantId: TENANT, apiKeyId: API_KEY, profileId: PROFILE, businessId: BUSINESS },
      operationId: OPERATION,
      taskId: TASK,
      invocationId: 'inv-or10-07',
      attempt: 1,
      idempotencyKey: 'reserve-or10-07',
      reserve: { tokens: 1, costMicroUsd: 0 },
      confidence: 'upper-bound',
    });

    const scopeKey = budgetQuotaScopeKey({
      tenantId: TENANT,
      apiKeyId: API_KEY,
      profileId: PROFILE,
      businessId: BUSINESS,
    });
    const window = resolveBudgetQuotaWindow(BUDGET.period, NOW);
    const quotaLock = lockParameters.filter((value): value is string => typeof value === 'string')
      .find((value) => value.startsWith('cost-quota:'));
    expect(admission.decision).toBe('ADMITTED');
    expect(lockParameters).toContain(`cost-policy-selection:${TENANT}`);
    expect(quotaLock).toBe(`cost-quota:${JSON.stringify([scopeKey, window.from, window.to])}`);
    expect(quotaLock).not.toContain('\u0000');
  });
});
