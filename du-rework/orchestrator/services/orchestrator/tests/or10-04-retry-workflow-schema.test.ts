import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  canonicalLegacyWorkflowPinBytes,
  LegacyWorkflowTaskPayloadSchema,
} from '@du/contracts';
import { retryOperation } from '../src/modules/operations/retry';
import {
  createMetadataCrypto,
  type MetadataKeyProvider,
  type SealedMetadata,
} from '../src/modules/runtime/metadata-crypto';

const tenantId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const taskId = '33333333-3333-4333-8333-333333333333';

function pin(revision: number, name: string) {
  const schema = {
    slug: 'invoice-flow',
    name,
    nodes: [{ id: 'review', type: 'input' as const, key: 'invoice' }],
    flow: ['review'],
  };
  const connectorSlotMap: Record<string, string> = {};
  const approvedEgressOrigins: string[] = [];
  const digest = `sha256:${createHash('sha256')
    .update(canonicalLegacyWorkflowPinBytes(schema, connectorSlotMap, approvedEgressOrigins))
    .digest('hex')}`;
  return { tenantId, slug: schema.slug, revision, digest, schema, connectorSlotMap, approvedEgressOrigins };
}

describe('OR10-04 retry preserves the original legacy workflow schema snapshot', () => {
  it('re-seals the admitted pin for the new task without resolving the current schema', async () => {
    const originalInput = {
      variables: { invoice: 'invoice-123' },
      artifactIds: [],
      fileNames: [],
      artifacts: [],
    };
    const originalPin = pin(1, 'Invoice flow revision 1');
    const currentPin = pin(2, 'Invoice flow revision 2');
    const originalPayload = { input: originalInput, legacyWorkflowSchema: originalPin };
    const originalOperation: Record<string, unknown> = {
      id: operationId,
      tenant_id: tenantId,
      state: 'FAILED',
      root_task_id: taskId,
      // PC-07: retry reauthorizes the recorded owner key before anything else.
      api_key_id: '55555555-5555-4555-8555-555555555555',
      input_ref: originalInput,
      submit_artifacts: [],
      prompt_overrides_ref: null,
      business_id: 'document-core',
      business_version: '1.0.0',
      action: 'schema-workflow',
      callback_policy: null,
    };
    const queries: string[] = [];
    let taskInsertParams: unknown[] | undefined;
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push(sql);
        if (sql.startsWith('SELECT * FROM operations')) return { rows: [originalOperation], rowCount: 1 };
      // PC-07 reauthorization: the owner key must still be ACTIVE.
      // PC-R03: it is read again under a row lock before the write.
      if (sql.startsWith('SELECT status, key_mode FROM api_keys')) {
        return { rows: [{ status: 'ACTIVE', key_mode: 'LEGACY_STANDALONE' }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT id, tenant_id, status, key_mode FROM api_keys')) {
        return { rows: [{ id: originalOperation.api_key_id, tenant_id: tenantId, status: 'ACTIVE', key_mode: 'LEGACY_STANDALONE' }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT k.name,k.spending_limit')) {
        return { rows: [{ name: 'key', spending_limit: '0', total_used: '0', tenant_id: tenantId }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT ue.event_id')) return { rows: [], rowCount: 0 };
        if (sql.startsWith('SELECT * FROM tasks')) {
          return { rows: [{ id: taskId, payload_ref: originalPayload, kind: 'legacy-workflow', max_attempts: 3 }], rowCount: 1 };
        }
      if (sql.includes('SELECT enabled,activation_revision,submissions_paused,pre_drain_version')) {
        return { rows: [{ enabled: true, activation_revision: 1, submissions_paused: false, pre_drain_version: null }], rowCount: 1 };
      }
      if (sql.includes('SELECT version,status,is_active FROM business_versions')) {
        return { rows: [{ version: '1.0.0', status: 'ENABLED', is_active: true }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT id, state, error_code FROM tasks WHERE operation_id=$1')) return { rows: [], rowCount: 0 };
        if (sql.includes('WHERE retry_of=')) return { rows: [], rowCount: 0 };
        if (sql.includes('INSERT INTO operations')) return { rows: [], rowCount: 1 };
        if (sql.includes('INSERT INTO tasks')) {
          taskInsertParams = params;
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('SELECT payload FROM outbox')) {
          return { rows: [{ payload: { priority: 7 } }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO outbox')) return { rows: [], rowCount: 1 };
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    } as unknown as PoolClient;

    const provider: MetadataKeyProvider = {
      wrapDek: async (dek, keyRef, keyVersion = 1) => ({
        version: 1,
        keyName: keyRef,
        keyVersion,
        wrappedKey: dek.toString('base64'),
      }),
      unwrapDek: async (wrapped) => Buffer.from(wrapped.wrappedKey, 'base64'),
    };
    const metadataCrypto = createMetadataCrypto(provider, 'offline-test-key');

    const result = await retryOperation(client, operationId, tenantId, metadataCrypto);

    expect(result).toMatchObject({ state: 'ACCEPTED', retryOf: operationId, replayed: false });
    expect(result.operationId).not.toBe(operationId);
    expect(taskInsertParams).toBeDefined();
    const newTaskId = String(taskInsertParams![0]);
    const storedPayload = JSON.parse(String(taskInsertParams![3])) as SealedMetadata;
    const retriedPayload = await metadataCrypto.open(storedPayload, {
      tenantId,
      slot: 'tasks.payload_ref',
      refId: newTaskId,
    });

    expect(LegacyWorkflowTaskPayloadSchema.safeParse(retriedPayload).success).toBe(true);
    expect(retriedPayload).toEqual(originalPayload);
    expect((retriedPayload as typeof originalPayload).legacyWorkflowSchema).toEqual(originalPin);
    expect((retriedPayload as typeof originalPayload).legacyWorkflowSchema).not.toEqual(currentPin);
    await expect(metadataCrypto.open(storedPayload, {
      tenantId,
      slot: 'tasks.payload_ref',
      refId: taskId,
    })).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });
    expect(queries.some((sql) => /legacy_workflow_schemas/i.test(sql))).toBe(false);
    expect(originalPayload).toEqual({ input: originalInput, legacyWorkflowSchema: originalPin });
  });
});
