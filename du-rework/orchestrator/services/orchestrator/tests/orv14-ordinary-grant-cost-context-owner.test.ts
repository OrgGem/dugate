import {
  canonicalLegacyWorkflowPinBytes,
  InvocationGrantClaimsSchema,
  workflowOverridesDigest,
} from '@du/contracts';
import { createHash } from 'node:crypto';
import type { Db } from '../src/db/db';
import { createGrantService } from '../src/modules/grants/grants';
import { createMetadataCrypto } from '../src/modules/runtime/metadata-crypto';
import { sealConnectorRecipePins } from '../src/modules/global-settings/workflow-recipe-pins';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const API_KEY_ID = '44444444-4444-4444-8444-444444444444';
const PROFILE_ID = '55555555-5555-4555-8555-555555555555';
const SECRET = Buffer.from('ordinary-cost-context-regression-secret');

describe('ordinary invocation grant cost attribution', () => {
  test('signs deferred cost scope from locked operation/task pins and preserves it on stable replay', async () => {
    let attempt = 4;
    let stored: { input_hash: string; expires_at: Date; grant_token: string } | undefined;
    const client = {
      query: async (text: string, values: unknown[] = []) => {
        const sql = text.replace(/\s+/g, ' ').trim().toUpperCase();
        if (sql.includes('FROM TASKS T JOIN OPERATIONS O')) {
          return {
            rowCount: 1,
            rows: [{
              lease_epoch: 7,
              lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
              state: 'RUNNING',
              operation_id: OPERATION_ID,
              attempt,
              tenant_id: TENANT_ID,
              api_key_id: API_KEY_ID,
              profile_id: PROFILE_ID,
              profile_revision: 8,
              business_id: 'document-core',
              business_version: '1.2.3',
              action: 'classify',
              connector_bindings: { reasoning: 'typed-connector@6' },
              submitArtifacts: [],
            }],
          };
        }
        if (sql.includes('FROM ARTIFACTS WHERE ID = ANY')) return { rowCount: 0, rows: [] };
        if (sql.includes('FROM INVOCATION_GRANTS')) {
          return stored ? { rowCount: 1, rows: [stored] } : { rowCount: 0, rows: [] };
        }
        if (sql.startsWith('INSERT INTO INVOCATION_GRANTS')) {
          stored = {
            input_hash: String(values[9]),
            expires_at: values[11] as Date,
            grant_token: String(values[10]),
          };
          return { rowCount: 1, rows: [] };
        }
        if (sql.startsWith('UPDATE INVOCATION_GRANTS')) {
          if (!stored) throw new Error('replay update without stored grant');
          stored.grant_token = String(values[0]);
          stored.expires_at = values[1] as Date;
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    };
    const db = { tx: async <T>(callback: (tx: typeof client) => Promise<T>) => callback(client) } as unknown as Db;
    const service = createGrantService(db, {
      getEnabledVersion: async () => ({ manifest: { actions: [{ name: 'classify', connectorSlots: [{ name: 'reasoning' }] }] } }),
    }, { connectorId: 'fallback-must-not-be-used', connectorRevision: 1, secret: SECRET });
    const request = {
      leaseEpoch: 7,
      stepKey: 'classify.reasoning', bindingSlot: 'reasoning', inputHash: 'sha256:stable-input', artifactIds: [],
    };

    const first = await service.issue(TASK_ID, 7, request);
    const firstClaims = InvocationGrantClaimsSchema.parse(JSON.parse(
      Buffer.from(first.grant.split('.')[1]!, 'base64url').toString('utf8'),
    ) as unknown);
    expect(firstClaims.costContext).toMatchObject({
      selectionState: 'DEFERRED',
      apiKeyId: API_KEY_ID,
      profileId: PROFILE_ID,
      profileRevision: 8,
      businessId: 'document-core',
      businessVersion: '1.2.3',
      action: 'classify',
      attempt: 4,
      priceRevision: null,
      budgetPins: [],
    });
    expect(firstClaims.connectorId).toBe('typed-connector');
    expect(firstClaims.connectorRevision).toBe(6);

    const replay = await service.issue(TASK_ID, 7, request);
    const replayClaims = InvocationGrantClaimsSchema.parse(JSON.parse(
      Buffer.from(replay.grant.split('.')[1]!, 'base64url').toString('utf8'),
    ) as unknown);
    expect(replay.invocationId).toBe(first.invocationId);
    expect(replayClaims.costContext).toEqual(firstClaims.costContext);

    attempt = 5;
    await expect(service.issue(TASK_ID, 7, request)).rejects.toMatchObject({ code: 'COST_CONTEXT_STALE' });
  });

  test('signs only the exact canonical root or parallel-branch checkpoint pinned on the admitted operation', async () => {
    const branchNodes = [{ id: 'extract', type: 'connector' as const, connector: 'reviewer' }];
    const schema = {
      slug: 'invoice-flow',
      name: 'Invoice flow',
      nodes: [
        { id: 'prepare', type: 'connector' as const, connector: 'reviewer' },
        { id: 'fork', type: 'parallel' as const, branches: [
          branchNodes,
          [{ id: 'review', type: 'connector' as const, connector: 'reviewer' }],
        ] },
      ],
      flow: ['prepare', 'fork'],
      output: { from: 'prepare' },
    };
    const connectorSlotMap = { reviewer: 'legacy-connector-00' };
    const workflowOverrides = {
      connectorId: 'typed-connector',
      connectorRevision: 6,
      recipeDigest: 'ab'.repeat(32),
      staticFormFields: [{ name: 'format', value: 'compact' }],
      extraHeaders: [{ name: 'X-Workflow-Mode', value: 'review' }],
    };
    const connectorRecipePins = { prepare: workflowOverrides, extract: workflowOverrides, review: workflowOverrides };
    const admittedWorkflowDigest = `sha256:${createHash('sha256').update(canonicalLegacyWorkflowPinBytes(
      schema as never,
      connectorSlotMap,
      [],
      connectorRecipePins,
    )).digest('hex')}`;
    const catalogDigest = `sha256:${createHash('sha256').update(canonicalLegacyWorkflowPinBytes(
      schema as never,
      connectorSlotMap,
      [],
    )).digest('hex')}`;

    const dekByRef = new Map<string, Buffer>();
    let nextDek = 0;
    const metadataCrypto = createMetadataCrypto({
      async wrapDek(dek, keyRef) {
        const wrappedKey = `dek-${++nextDek}`;
        dekByRef.set(wrappedKey, Buffer.from(dek));
        return { version: 1, keyName: keyRef, keyVersion: 1, wrappedKey };
      },
      async unwrapDek(wrapped) {
        const dek = dekByRef.get(wrapped.wrappedKey);
        if (!dek) throw new Error('missing test DEK');
        return Buffer.from(dek);
      },
    }, 'workflow-grant-test-key');
    const connectorRecipePinsRef = await sealConnectorRecipePins(metadataCrypto, {
      workflowSchemaSlug: schema.slug,
      workflowSchemaRevision: 3,
      workflowSchemaDigest: admittedWorkflowDigest,
      connectorRecipePins,
    }, { tenantId: TENANT_ID, operationId: OPERATION_ID });
    const schemaRef = await metadataCrypto.seal({
      schema,
      connectorSlotMap,
      approvedEgressOrigins: [],
    }, {
      tenantId: TENANT_ID,
      slot: 'legacy_workflow_schemas.schema_ref',
      refId: `${schema.slug}:3`,
    });
    const taskPin = {
      tenantId: TENANT_ID,
      slug: schema.slug,
      revision: 3,
      digest: admittedWorkflowDigest,
      schema,
      connectorSlotMap,
      approvedEgressOrigins: [],
      connectorRecipePins,
    };
    const rootPayloadRef = await metadataCrypto.seal({ input: {}, legacyWorkflowSchema: taskPin }, {
      tenantId: TENANT_ID, slot: 'tasks.payload_ref', refId: TASK_ID,
    });
    const branchTaskId = '77777777-7777-4777-8777-777777777777';
    const branchPayloadRef = await metadataCrypto.seal({
      input: {}, legacyWorkflowSchema: taskPin,
      __legacyWorkflowBranch: { parallelNodeId: 'fork', branchIndex: 0, nodes: branchNodes, baseResults: {} },
    }, { tenantId: TENANT_ID, slot: 'tasks.payload_ref', refId: branchTaskId });
    const taskRows = new Map([
      [TASK_ID, { task_key: 'root', task_kind: 'root', parent_id: null, payload_ref: rootPayloadRef }],
      [branchTaskId, {
        task_key: 'legacy-workflow:fork:branch:00', task_kind: 'legacy-workflow-branch',
        parent_id: TASK_ID, payload_ref: branchPayloadRef,
      }],
    ]);

    let stored: { input_hash: string; expires_at: Date; grant_token: string } | undefined;
    let insertCount = 0;
    const client = {
      query: async (text: string, values: unknown[] = []) => {
        const sql = text.replace(/\s+/g, ' ').trim().toUpperCase();
        if (sql.includes('FROM TASKS T JOIN OPERATIONS O')) {
          const workflowTask = taskRows.get(String(values[0]));
          if (!workflowTask) return { rowCount: 0, rows: [] };
          return {
            rowCount: 1,
            rows: [{
              lease_epoch: 7,
              lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
              state: 'RUNNING',
              operation_id: OPERATION_ID,
              ...workflowTask,
              attempt: 4,
              tenant_id: TENANT_ID,
              api_key_id: API_KEY_ID,
              profile_id: PROFILE_ID,
              profile_revision: 8,
              business_id: 'document-core',
              business_version: '1.2.3',
              action: 'classify',
              connector_bindings: { 'legacy-connector-00': 'typed-connector@6' },
              submitArtifacts: [],
              connector_recipe_pins_ref: JSON.parse(connectorRecipePinsRef),
              workflow_schema_slug: schema.slug,
              workflow_schema_revision: 3,
              workflow_schema_digest: admittedWorkflowDigest,
            }],
          };
        }
        if (sql.includes('FROM LEGACY_WORKFLOW_SCHEMAS')) {
          return {
            rowCount: 1,
            rows: [{
              tenant_id: TENANT_ID,
              slug: schema.slug,
              revision: 3,
              digest: catalogDigest,
              schema_ref: schemaRef,
            }],
          };
        }
        if (sql.includes('FROM ARTIFACTS WHERE ID = ANY')) return { rowCount: 0, rows: [] };
        if (sql.includes('FROM INVOCATION_GRANTS')) {
          return stored ? { rowCount: 1, rows: [stored] } : { rowCount: 0, rows: [] };
        }
        if (sql.startsWith('INSERT INTO INVOCATION_GRANTS')) {
          insertCount += 1;
          stored = {
            input_hash: String(values[9]),
            expires_at: values[11] as Date,
            grant_token: String(values[10]),
          };
          return { rowCount: 1, rows: [] };
        }
        if (sql.startsWith('UPDATE INVOCATION_GRANTS')) {
          if (!stored) throw new Error('replay update without stored grant');
          stored.grant_token = String(values[0]);
          stored.expires_at = values[1] as Date;
          return { rowCount: 1, rows: [] };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    };
    const db = { tx: async <T>(callback: (tx: typeof client) => Promise<T>) => callback(client) } as unknown as Db;
    const service = createGrantService(db, {
      getEnabledVersion: async () => ({ manifest: { actions: [{
        name: 'classify',
        connectorSlots: [{ name: 'legacy-connector-00' }, { name: 'legacy-connector-01' }],
      }] } }),
    }, {
      connectorId: 'fallback-must-not-be-used',
      connectorRevision: 1,
      secret: SECRET,
      metadataCrypto,
    });
    const request = {
      leaseEpoch: 7,
      stepKey: `legacy-workflow:node:${admittedWorkflowDigest}:root:root:prepare`,
      bindingSlot: 'legacy-connector-00',
      inputHash: 'sha256:wfa-input',
      artifactIds: [],
      workflowOverrides,
    };

    const issued = await service.issue(TASK_ID, 7, request);
    const claims = InvocationGrantClaimsSchema.parse(JSON.parse(
      Buffer.from(issued.grant.split('.')[1]!, 'base64url').toString('utf8'),
    ) as unknown);
    expect(claims.workflowOverridesDigest).toBe(workflowOverridesDigest({
      tenantId: TENANT_ID,
      operationId: OPERATION_ID,
      taskId: TASK_ID,
      stepKey: request.stepKey,
      invocationId: issued.invocationId,
      connectorId: 'typed-connector',
      connectorRevision: 6,
      workflowOverrides,
    }));
    expect(insertCount).toBe(1);

    stored = undefined;
    const branchStepKey = `legacy-workflow:node:${admittedWorkflowDigest}:branch:fork-0:extract`;
    const branchRequest = { ...request, stepKey: branchStepKey };
    const branchGrant = await service.issue(branchTaskId, 7, branchRequest);
    const branchClaims = InvocationGrantClaimsSchema.parse(JSON.parse(
      Buffer.from(branchGrant.grant.split('.')[1]!, 'base64url').toString('utf8'),
    ) as unknown);
    expect(branchClaims.workflowOverridesDigest).toBe(workflowOverridesDigest({
      tenantId: TENANT_ID,
      operationId: OPERATION_ID,
      taskId: branchTaskId,
      stepKey: branchStepKey,
      invocationId: branchGrant.invocationId,
      connectorId: 'typed-connector',
      connectorRevision: 6,
      workflowOverrides,
    }));
    expect(insertCount).toBe(2);

    await expect(service.issue(TASK_ID, 7, {
      ...request,
      workflowOverrides: { ...workflowOverrides, staticFormFields: [{ name: 'format', value: 'unapproved' }] },
    })).rejects.toMatchObject({ code: 'BINDING_DENIED' });
    await expect(service.issue(TASK_ID, 7, {
      ...request,
      bindingSlot: 'legacy-connector-01',
    })).rejects.toMatchObject({ code: 'BINDING_DENIED' });
    await expect(service.issue(TASK_ID, 7, {
      ...request,
      stepKey: 'unadmitted-node',
    })).rejects.toMatchObject({ code: 'BINDING_DENIED' });
    await expect(service.issue(branchTaskId, 7, {
      ...branchRequest,
      stepKey: `legacy-workflow:node:${admittedWorkflowDigest}:branch:fork-1:extract`,
    })).rejects.toMatchObject({ code: 'BINDING_DENIED' });
    await expect(service.issue(TASK_ID, 7, {
      ...request,
      stepKey: `legacy-workflow:node:sha256:${'0'.repeat(64)}:root:root:prepare`,
    })).rejects.toMatchObject({ code: 'BINDING_DENIED' });
    expect(insertCount).toBe(2);
  });
});
