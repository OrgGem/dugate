import { createHash } from 'node:crypto';
import { canonicalize } from '@du/contracts';
import { createCostAdjustmentService, type AdjustmentReader, type CostAdjustmentEvidencePin } from '../src/modules/cost-control/adjustments';
import type { Db } from '../src/db/db';
import type { PoolClient } from 'pg';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const artifactId = '33333333-3333-4333-8333-333333333333';
const operationId = '55555555-5555-4555-8555-555555555555';
const taskId = '66666666-6666-4666-8666-666666666666';
const reservationGroupId = '77777777-7777-4777-8777-777777777777';
const digest = `sha256:${'a'.repeat(64)}`;
const sessionId = 'opaque-session-id-from-cookie';

const actor: AdjustmentReader = {
  kind: 'platform',
  authKind: 'cookie',
  tenantId,
  principalId: actorId,
  role: 'admin',
  roleVersion: 1,
  csrfOk: true,
  sessionId,
};

const evidence: CostAdjustmentEvidencePin = {
  artifactId,
  tenantId,
  fileName: 'invoice.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 10,
  sha256: digest,
  databaseMetadata: {
    kind: 'gateway-ciphertext',
    sizeBytes: 14,
    sha256: `sha256:${'b'.repeat(64)}`,
  },
  objectSizeBytes: 14,
  objectSha256: `sha256:${'b'.repeat(64)}`,
  storageGenerationId: '44444444-4444-4444-8444-444444444444',
  storageVersionId: 'object-version-1',
  sidecarVersionId: 'sidecar-version-1',
  sidecarSha256: `sha256:${'c'.repeat(64)}`,
  sidecarSizeBytes: 20,
  createdAt: '2026-10-01T00:00:00.000Z',
};

function createFixture(input: {
  gateError?: Error;
  revalidationError?: Error;
  revalidationErrorAt?: number;
  priorResult?: { request_hash: string; result: unknown };
  successfulAdjustment?: boolean;
} = {}) {
  const query = jest.fn(async (sql: string, ..._params: unknown[]) => {
    if (sql.includes('SELECT request_hash,result FROM usage_financial_adjustment_commands') && input.priorResult) {
      return { rows: [input.priorResult], rowCount: 1 };
    }
    if (input.successfulAdjustment) {
      if (sql.includes('SELECT request_hash,result FROM usage_financial_adjustment_commands')) {
        if (sql.includes('FOR UPDATE')) {
          return { rows: [{ request_hash: createHash('sha256').update(canonicalize(command)).digest('hex'), result: null }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM usage_events ue JOIN operations')) {
        return { rows: [{
          event_id: command.rootEventId,
          operation_id: operationId,
          task_id: taskId,
          payload: {
            eventId: command.rootEventId,
            invocationId: 'invocation-1',
            operationId,
            taskId,
            units: { inputTokens: 100, outputTokens: 25 },
            costMicrousd: 100,
            measurement: 'measured',
            costStatus: 'measured',
            provider: 'openai',
            model: 'gpt-4o-mini',
            occurredAt: '2026-10-01T00:00:00.000Z',
            costProvenance: {
              version: 1,
              tenantId,
              apiKeyId: null,
              profileId: null,
              profileRevision: null,
              businessId: 'business',
              businessVersion: '1',
              action: 'generate',
              attempt: 1,
              stepKey: 'generate',
              connectorId: 'connector',
              connectorRevision: 1,
              durationMs: 40,
              reservationGroupId,
              selectedAt: '2026-10-01T00:00:00.000Z',
              confidence: 'best-effort',
              priceRevision: 1,
              priceSnapshot: {
                provider: 'openai',
                modelId: 'gpt-4o-mini',
                priceVersion: 1,
                effectiveFrom: '2026-01-01T00:00:00.000Z',
                currency: 'USD',
                inputMicrousdPerMillion: 100,
                outputMicrousdPerMillion: 200,
              },
              budgetPins: [],
              costBoundCapabilityId: null,
              inputUpperBoundTokens: null,
              outputLimitTokens: null,
            },
          },
          cost_reservation_group_id: reservationGroupId,
          received_at: '2026-10-01T00:00:00.000Z',
          tenant_id: tenantId,
          api_key_id: null,
          profile_id: null,
          profile_revision: null,
          business_id: 'business',
          business_version: '1',
          action: 'generate',
        }], rowCount: 1 };
      }
      if (sql.includes('FROM cost_reservation_groups')) {
        return { rows: [{ reservation_group_id: reservationGroupId, tenant_id: tenantId,
          operation_id: operationId, task_id: taskId, invocation_id: 'invocation-1', attempt: 1,
          state: 'SETTLED', usage_event_id: command.rootEventId }], rowCount: 1 };
      }
      if (sql.includes('FROM cost_budget_holds')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM usage_financial_adjustments')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM usage_financial_adjustment_heads')) {
        return { rows: [{ root_event_id: command.rootEventId, tenant_id: tenantId,
          adjustment_revision: '0', head_adjustment_event_id: null,
          initial_charge_microusd: '100', gross_charge_microusd: '100',
          refunded_microusd: '0', net_charge_microusd: '100' }], rowCount: 1 };
      }
      if (sql.includes('FROM artifacts WHERE')) {
        return { rows: [{ id: artifactId, tenant_id: tenantId, operation_id: operationId,
          purpose: 'input', state: 'READY', file_name: evidence.fileName, mime_type: evidence.mimeType,
          size_bytes: String(evidence.databaseMetadata.sizeBytes), sha256: evidence.databaseMetadata.sha256,
          storage_generation_id: evidence.storageGenerationId, storage_version_id: evidence.storageVersionId,
          manifest_version_id: evidence.sidecarVersionId, created_at: '2026-10-01T00:00:00.000Z' }], rowCount: 1 };
      }
      if (sql.includes('UPDATE usage_financial_adjustment_heads')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  const client = { query } as unknown as Parameters<Parameters<Db['tx']>[0]>[0];
  const db = {
    pool: {} as never,
    query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
    tx: jest.fn(async (work: (tx: typeof client) => Promise<unknown>) => work(client)),
    close: jest.fn(async () => undefined),
  } as unknown as Db;
  const gate = {
    assertWriteAllowed: jest.fn(async (_tx: Pick<PoolClient, 'query'>, request: { requestKey: string }) => {
      expect(request.requestKey).toMatch(/^[a-f0-9]{64}$/);
      await query('SELECT backup effect gate FOR SHARE');
      if (input.gateError) throw input.gateError;
    }),
  };
  let revalidationCount = 0;
  const revalidate = jest.fn(async (_current: AdjustmentReader, _tx: Pick<PoolClient, 'query'>) => {
    revalidationCount += 1;
    if (input.revalidationError && revalidationCount === (input.revalidationErrorAt ?? 1)) throw input.revalidationError;
  });
  const service = createCostAdjustmentService({
    db,
    audit: { record: jest.fn(async () => undefined) } as never,
    artifacts: { resolveCostAdjustmentEvidencePin: jest.fn(async () => evidence) },
    backupSnapshotWriteGate: gate,
    assertWriterCurrent: revalidate,
  });
  return { service, db, query, gate, revalidate };
}

const command = {
  tenantId,
  rootEventId: 'usage-event-1',
  expectedAdjustmentRevision: 0,
  reason: 'Corrected invoice amount',
  evidenceArtifactId: artifactId,
  kind: 'correction' as const,
  targetChargeMicrousd: 80,
};

describe('ORV14 financial adjustment service write fence', () => {
  it('writes only a schema-valid adjustment after verifying the current exact object proof', async () => {
    const { service, query } = createFixture({ successfulAdjustment: true });

    const result = await service.adjust(command, actor, 'request-123');

    expect(result).toMatchObject({ outcome: 'ADJUSTED', initialChargeMicrousd: 100, grossChargeMicrousd: 80 });
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO usage_financial_adjustments'))).toBe(true);
  });

  it('stops before idempotency or ledger writes when the backup gate is held', async () => {
    const { service, db, query, gate, revalidate } = createFixture({ gateError: new Error('BACKUP_EFFECT_FENCE_ACTIVE') });

    await expect(service.adjust(command, actor, 'request-123')).rejects.toThrow('BACKUP_EFFECT_FENCE_ACTIVE');

    expect(db.query).not.toHaveBeenCalled();
    expect(gate.assertWriteAllowed).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringContaining('SELECT request_hash,result FROM usage_financial_adjustment_commands'),
      'SELECT backup effect gate FOR SHARE',
    ]);
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it('revalidates the same cookie actor after evidence and gate, before other transaction work', async () => {
    const { service, query, gate, revalidate } = createFixture({ revalidationError: new Error('ADMIN_SESSION_REVOKED'), revalidationErrorAt: 2 });

    await expect(service.adjust(command, actor, 'request-123')).rejects.toThrow('ADMIN_SESSION_REVOKED');

    expect(gate.assertWriteAllowed).toHaveBeenCalledTimes(1);
    expect(revalidate).toHaveBeenNthCalledWith(2, actor, expect.anything());
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringContaining('SELECT request_hash,result FROM usage_financial_adjustment_commands'),
      'SELECT backup effect gate FOR SHARE',
    ]);
  });

  it('denies a completed replay when the cookie Admin session was revoked', async () => {
    const replayResult = {
      outcome: 'ADJUSTED', adjustmentEventId: '55555555-5555-4555-8555-555555555555', rootEventId: command.rootEventId,
      adjustmentRevision: 1, initialChargeMicrousd: 100, grossChargeMicrousd: 80, refundedMicrousd: 0,
      netChargeMicrousd: 80, effectiveAt: '2026-10-01T00:00:00.000Z', recordedAt: '2026-10-02T00:00:00.000Z', replayed: false,
    };
    const requestHash = createHash('sha256').update(canonicalize(command)).digest('hex');
    const { service, query, gate } = createFixture({
      revalidationError: new Error('ADMIN_SESSION_REVOKED'),
      priorResult: { request_hash: requestHash, result: replayResult },
    });

    await expect(service.adjust(command, actor, 'request-123')).rejects.toThrow('ADMIN_SESSION_REVOKED');

    expect(query).not.toHaveBeenCalled();
    expect(gate.assertWriteAllowed).not.toHaveBeenCalled();
  });
});
