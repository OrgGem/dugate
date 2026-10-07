import { createHash } from 'node:crypto';
import type { MetadataCrypto } from '../src/modules/runtime/metadata-crypto';
import { createRuntimeService } from '../src/modules/runtime/runtime';
import { handlePublicRoutes } from '../src/http/routes/public';
import { handleLegacyRoute } from '../src/compat/legacy-http-mount';
import type { RouteContext } from '../src/http/route-context';
import type { Db } from '../src/db/db';
import { contentHash } from '@du/contracts';

const TASK_ID = '00000000-0000-4000-8000-000000000010';
const OPERATION_ID = '00000000-0000-4000-8000-000000000020';
const TENANT_ID = '00000000-0000-4000-8000-000000000030';
const API_KEY_ID = '00000000-0000-4000-8000-000000000040';
const BUSINESS_ID = 'document-core';

type Row = Record<string, unknown>;
type QueryCall = { sql: string; params: unknown[] };

function result(rows: Row[] = []): { rows: Row[]; rowCount: number } {
  return { rows, rowCount: rows.length };
}

function makeRuntimeWorld(options: {
  liveLease?: boolean;
  taskState?: string;
  leaseEpoch?: number;
  businessId?: string;
  expireOnStateTransition?: boolean;
  existingChild?: Row;
  checkpoint?: Row;
} = {}) {
  const calls: QueryCall[] = [];
  const attemptedWrites: QueryCall[] = [];
  const committedWrites: QueryCall[] = [];
  let rollbackCount = 0;
  const task: Row = {
    id: TASK_ID,
    lease_epoch: options.leaseEpoch ?? 1,
    lease_expires_at: options.liveLease ? new Date(Date.now() + 60_000) : new Date(0),
    lease_active: options.liveLease === true,
    state: options.taskState ?? 'RUNNING',
    operation_id: OPERATION_ID,
    tenant_id: TENANT_ID,
    business_id: options.businessId ?? BUSINESS_ID,
    business_version: '1.0.0',
    action: 'extract',
    kind: 'root',
    correlation_id: 'rcr-luna-offline',
    input_ref: { text: 'source' },
    deadline_at: null,
    manifest_digest: 'sha256:manifest',
    profile_id: null,
    profile_revision: 0,
    connector_bindings: {},
    profile_policy_snapshot: null,
    prompt_revisions_pin: null,
    prompt_overrides_ref: null,
    op_cancel_requested: false,
    op_state: 'QUEUED',
    last_delivery_id: null,
    leased_by: null,
    attempt: 1,
  };
  let storedCheckpoints: Row[] = options.checkpoint ? [options.checkpoint] : [];

  const query = async (sql: string, params: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    const call = { sql: normalized, params };
    calls.push(call);
    if (/^(INSERT|UPDATE|DELETE)/i.test(normalized)) attemptedWrites.push(call);

    if (/^SELECT/.test(normalized)) {
      if (normalized.includes('FROM tasks t JOIN operations') || normalized.includes('FROM tasks t\n')) {
        return result([{ ...task }]);
      }
      if (normalized.includes('FROM tasks WHERE id=$1') || normalized.includes('FROM tasks WHERE id = $1')) {
        return result([{ ...task }]);
      }
      if (normalized.includes('FROM tasks t') && normalized.includes('FOR UPDATE')) {
        return result([{ ...task }]);
      }
      if (normalized.includes('FROM business_versions')) {
        return result([{
          manifest: { runtime: { handlerKinds: ['child'] }, actions: [{ name: 'extract', defaultLimits: { maxParallelTasks: 10 } }] },
          digest: 'sha256:manifest',
          queue: 'document-core',
        }]);
      }
      if (normalized.includes('FROM human_waits')) return result([]);
      if (normalized.includes('FROM step_checkpoints')) {
        if (normalized.includes('ORDER BY generation DESC')) {
          const stepKey = String(params[1]);
          const latest = storedCheckpoints
            .filter((checkpoint) => checkpoint['stepKey'] === stepKey)
            .sort((a, b) => Number(b['generation']) - Number(a['generation']))[0];
          return result(latest ? [latest] : []);
        }
        if (normalized.includes('step_key as "stepKey"')) {
          const checkpoints = [...storedCheckpoints];
          if (/ORDER BY\s+step_key\s*,\s*generation\s+DESC/i.test(normalized)) {
            checkpoints.sort((a, b) =>
              String(a['stepKey']).localeCompare(String(b['stepKey'])) || Number(b['generation']) - Number(a['generation'])
            );
          }
          return result(checkpoints);
        }
        return result([...storedCheckpoints]);
      }
      if (normalized.includes('FROM tasks WHERE operation_id=$1') || normalized.includes('FROM tasks WHERE operation_id = $1')) {
        return result(options.existingChild ? [options.existingChild] : []);
      }
      if (normalized.includes('count(*)')) return result([{ n: 0, count: 0 }]);
      if (normalized.includes('SELECT state FROM operations')) return result([{ state: 'QUEUED' }]);
      if (normalized.includes('SELECT state FROM tasks')) return result([{ state: String(task.state) }]);
      return result();
    }

    if (/^INSERT INTO step_checkpoints/i.test(normalized)) {
      const columnsText = /\(([^)]+)\)/.exec(normalized)?.[1] ?? '';
      const columns = columnsText.split(',').map((column) => column.trim());
      const parameter = (column: string): unknown => params[columns.indexOf(column)];
      const sessionIndex = columns.findIndex((column) => column === 'session_ref');
      const sessionRaw = sessionIndex >= 0 ? parameter('session_ref') : undefined;
      const checkpoint: Row = {
        stepKey: String(parameter('step_key')),
        generation: Number(parameter('generation')),
        inputHash: String(parameter('input_hash')),
        outputRef: parameter('output_ref') === undefined ? undefined : JSON.parse(String(parameter('output_ref'))) as unknown,
        status: parameter('status'),
        ...(sessionIndex >= 0
          ? { sessionRef: sessionRaw == null ? sessionRaw : JSON.parse(String(sessionRaw)) as unknown }
          : {}),
      };
      storedCheckpoints = [
        ...storedCheckpoints.filter((existing) =>
          existing['stepKey'] !== checkpoint['stepKey'] || existing['generation'] !== checkpoint['generation']
        ),
        checkpoint,
      ];
      return { rows: [], rowCount: 1 };
    }
    if (/^INSERT INTO tasks/i.test(normalized)) {
      return { rows: [{ id: '00000000-0000-4000-8000-000000000099' }], rowCount: 1 };
    }
    if (/^UPDATE tasks/i.test(normalized)) {
      if (
        options.expireOnStateTransition &&
        /WAITING_(?:CHILDREN|INPUT)/.test(normalized) &&
        /lease_expires_at\s*>\s*clock_timestamp\(\)/i.test(normalized)
      ) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ state: 'WAITING_CHILDREN' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };

  const db = {
    query,
    tx: async <T>(callback: (client: { query: typeof query }) => Promise<T>): Promise<T> => {
      const start = attemptedWrites.length;
      try {
        const value = await callback({ query });
        committedWrites.push(...attemptedWrites.slice(start));
        return value;
      } catch (error) {
        rollbackCount += 1;
        throw error;
      }
    },
  } as unknown as Db;

  return {
    calls,
    attemptedWrites,
    committedWrites,
    get rollbackCount() { return rollbackCount; },
    get storedCheckpoints() { return storedCheckpoints; },
    task,
    runtime: createRuntimeService(db),
    runtimeWithCrypto: (crypto: MetadataCrypto) => createRuntimeService(db, undefined, crypto),
  };
}

describe('RCR Luna independent offline verification — runtime contracts', () => {
  it.each([
    ['spawnChildren', async (runtime: ReturnType<typeof createRuntimeService>) => runtime.spawnChildren(TASK_ID, {
      leaseEpoch: 1,
      children: [{ taskKey: 'child-1', kind: 'child', payloadRef: { id: 'child' }, payloadHash: contentHash({ id: 'child' }) }],
      joinPolicy: 'all-success',
      continuationRef: 'continue-1',
    })],
    ['waitInput', async (runtime: ReturnType<typeof createRuntimeService>) => runtime.waitInput(TASK_ID, {
      leaseEpoch: 1,
      waitKey: 'need-approval',
      inputSchema: { type: 'object' },
    })],
  ])('%s rejects an expired current-epoch lease before durable writes', async (_name, invoke) => {
    const world = makeRuntimeWorld({ liveLease: false });

    await expect(invoke(world.runtime)).rejects.toMatchObject({ status: 409, code: 'LEASE_LOST' });

    expect(world.committedWrites).toEqual([]);
    expect(world.attemptedWrites).toEqual([]);
  });

  it.each([
    ['spawnChildren', async (runtime: ReturnType<typeof createRuntimeService>, epoch: number, businessId: string) => {
      const call = runtime.spawnChildren as unknown as (taskId: string, body: unknown, workerBusinessId?: string) => Promise<unknown>;
      return call(TASK_ID, {
        leaseEpoch: epoch,
        children: [{ taskKey: 'child-1', kind: 'child', payloadRef: { id: 'child' }, payloadHash: contentHash({ id: 'child' }) }],
        joinPolicy: 'all-success',
        continuationRef: 'continue-1',
      }, businessId);
    }],
    ['waitInput', async (runtime: ReturnType<typeof createRuntimeService>, epoch: number, businessId: string) => {
      const call = runtime.waitInput as unknown as (taskId: string, body: unknown, workerBusinessId?: string) => Promise<unknown>;
      return call(TASK_ID, { leaseEpoch: epoch, waitKey: 'need-approval', inputSchema: { type: 'object' } }, businessId);
    }],
  ])('%s rejects a stale epoch and foreign business without writes', async (_name, invoke) => {
    const stale = makeRuntimeWorld({ liveLease: true });
    await expect(invoke(stale.runtime, 2, BUSINESS_ID)).rejects.toMatchObject({ status: 409, code: 'LEASE_LOST' });
    expect(stale.attemptedWrites).toEqual([]);

    const foreign = makeRuntimeWorld({ liveLease: true });
    await expect(invoke(foreign.runtime, 1, 'another-business')).rejects.toMatchObject({
      status: 403,
      code: 'PERMISSION_DENIED',
    });
    expect(foreign.attemptedWrites).toEqual([]);
  });

  it.each([
    ['spawnChildren', async (runtime: ReturnType<typeof createRuntimeService>) => runtime.spawnChildren(TASK_ID, {
      leaseEpoch: 1,
      children: [{ taskKey: 'child-1', kind: 'child', payloadRef: { id: 'child' }, payloadHash: contentHash({ id: 'child' }) }],
      joinPolicy: 'all-success',
      continuationRef: 'continue-1',
    })],
    ['waitInput', async (runtime: ReturnType<typeof createRuntimeService>) => runtime.waitInput(TASK_ID, {
      leaseEpoch: 1,
      waitKey: 'need-approval',
      inputSchema: { type: 'object' },
    })],
  ])('%s rolls back tentative rows if the database-clock lease CAS loses expiry during the transaction', async (_name, invoke) => {
    const world = makeRuntimeWorld({ liveLease: true, expireOnStateTransition: true });

    await expect(invoke(world.runtime)).rejects.toMatchObject({ status: 409, code: 'LEASE_LOST' });

    expect(world.attemptedWrites.length).toBeGreaterThan(0);
    expect(world.calls.some((call) => /lease_expires_at\s*>\s*clock_timestamp\(\)/i.test(call.sql))).toBe(true);
    expect(world.committedWrites).toEqual([]);
    expect(world.rollbackCount).toBe(1);
  });

  it('preserves a fully durable identical child-spawn replay after expiry', async () => {
    const childPayload = { id: 'child' };
    const world = makeRuntimeWorld({
      liveLease: false,
      taskState: 'WAITING_CHILDREN',
      existingChild: {
        id: '00000000-0000-4000-8000-000000000099',
        task_key: 'child-1',
        payload_ref: childPayload,
      },
    });

    await expect(world.runtime.spawnChildren(TASK_ID, {
      leaseEpoch: 1,
      children: [{ taskKey: 'child-1', kind: 'child', payloadRef: childPayload, payloadHash: contentHash(childPayload) }],
      joinPolicy: 'all-success',
      continuationRef: 'continue-1',
    })).resolves.toMatchObject({
      childTaskIds: ['00000000-0000-4000-8000-000000000099'],
      parentState: 'WAITING_CHILDREN',
    });

    expect(world.committedWrites).toEqual([]);
  });

  it('applies SaveStepRequestSchema defaults before persistence and rejects invalid reports without writes', async () => {
    const world = makeRuntimeWorld({ liveLease: true });
    const input = { leaseEpoch: 1, inputHash: 'input-hash', outputRef: 'memory://result' };

    await world.runtime.saveStep(TASK_ID, 'step-1', input as never, BUSINESS_ID);

    const insert = world.attemptedWrites.find((call) => call.sql.startsWith('INSERT INTO step_checkpoints'));
    expect(insert).toBeDefined();
    expect(insert?.params[5]).toBe('SUCCEEDED');

    const invalidWorld = makeRuntimeWorld({ liveLease: true });
    await expect(invalidWorld.runtime.saveStep(TASK_ID, 'step-1', {
      ...input,
      status: 'UNKNOWN',
    } as never, BUSINESS_ID)).rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    expect(invalidWorld.attemptedWrites).toEqual([]);
  });

  it.each([
    ['empty inputHash', { leaseEpoch: 1, inputHash: '', outputRef: 'memory://result' }],
    ['empty outputRef', { leaseEpoch: 1, inputHash: 'input-hash', outputRef: '' }],
    ['out-of-range lease epoch', { leaseEpoch: 0, inputHash: 'input-hash', outputRef: 'memory://result' }],
  ])('rejects a SaveStepRequest with %s before any SQL write', async (_name, body) => {
    const world = makeRuntimeWorld({ liveLease: true });

    await expect(world.runtime.saveStep(TASK_ID, 'step-1', body as never, BUSINESS_ID))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    expect(world.attemptedWrites).toEqual([]);
  });

  it('persists and restores a checkpoint sessionRef across save → claim with a distinct authenticated binding', async () => {
    const world = makeRuntimeWorld({ liveLease: true });
    const sealedContexts: Array<{ tenantId: string; slot: string; refId: string }> = [];
    const readContexts: Array<{ tenantId: string; slot: string; refId: string }> = [];
    const metadataCrypto = {
      seal: jest.fn(async (value: unknown, context: { tenantId: string; slot: string; refId: string }) => {
        sealedContexts.push(context);
        return { marker: 'offline-sealed', value, context };
      }),
      open: jest.fn(async (sealed: { value: unknown }) => sealed.value),
      isSealed: jest.fn((value: unknown): value is never => typeof value === 'object' && value !== null),
      readStored: jest.fn(async (value: { value?: unknown }, context: { tenantId: string; slot: string; refId: string }) => {
        readContexts.push(context);
        return value && Object.prototype.hasOwnProperty.call(value, 'value') ? value.value : value;
      }),
    } as unknown as MetadataCrypto;
    const runtime = world.runtimeWithCrypto(metadataCrypto);
    const stepKey = 'connector-call';
    const sessionRef = 'provider-session-secret';

    await runtime.saveStep(TASK_ID, stepKey, {
      leaseEpoch: 1,
      inputHash: 'input-hash',
      outputRef: 'memory://checkpoint',
      status: 'FAILED',
      sessionRef,
    } as never, BUSINESS_ID);
    const sessionSeal = sealedContexts.find((context) => context.slot === 'step_checkpoints.session_ref');
    expect(sessionSeal).toEqual({
      tenantId: TENANT_ID,
      slot: 'step_checkpoints.session_ref',
      refId: `${TASK_ID}:${stepKey}:1`,
    });

    world.task['lease_expires_at'] = new Date(0);
    world.task['state'] = 'RUNNING';
    world.task['op_state'] = 'RUNNING';
    const claimed = await runtime.claimTask(TASK_ID, 'delivery-after-restart', 'worker-restarted', BUSINESS_ID);

    expect(claimed.checkpointRefs).toContainEqual(expect.objectContaining({
      stepKey,
      generation: 1,
      sessionRef,
    }));
    expect(readContexts).toContainEqual({
      tenantId: TENANT_ID,
      slot: 'step_checkpoints.session_ref',
      refId: `${TASK_ID}:${stepKey}:1`,
    });
    const checkpointSelect = world.calls.find((call) =>
      call.sql.includes('FROM step_checkpoints') && call.sql.includes('step_key as "stepKey"')
    );
    expect(checkpointSelect?.sql).toMatch(/session_ref/i);
  });

  it('projects newest checkpoint generations first for the SDK step.peek/find consumer', async () => {
    const world = makeRuntimeWorld({ liveLease: true });
    const sealedContexts: Array<{ tenantId: string; slot: string; refId: string }> = [];
    const metadataCrypto = {
      seal: jest.fn(async (value: unknown, context: { tenantId: string; slot: string; refId: string }) => {
        sealedContexts.push(context);
        return { marker: 'offline-sealed', value, context };
      }),
      open: jest.fn(async (sealed: { value: unknown }) => sealed.value),
      isSealed: jest.fn((value: unknown): value is never => typeof value === 'object' && value !== null),
      readStored: jest.fn(async (value: { value?: unknown }, context: { tenantId: string; slot: string; refId: string }) => {
        return value && Object.prototype.hasOwnProperty.call(value, 'value') ? value.value : value;
      }),
    } as unknown as MetadataCrypto;
    const runtime = world.runtimeWithCrypto(metadataCrypto);
    const stepKey = 'connector-call';

    await runtime.saveStep(TASK_ID, stepKey, {
      leaseEpoch: 1, inputHash: 'input-hash', outputRef: 'memory://generation-1', status: 'FAILED', sessionRef: 'session-generation-1',
    } as never, BUSINESS_ID);
    await runtime.saveStep(TASK_ID, stepKey, {
      leaseEpoch: 1, inputHash: 'input-hash', outputRef: 'memory://generation-2', status: 'FAILED', sessionRef: 'session-generation-2',
    } as never, BUSINESS_ID);

    world.task['lease_expires_at'] = new Date(0);
    world.task['state'] = 'RUNNING';
    world.task['op_state'] = 'RUNNING';
    const claimed = await runtime.claimTask(TASK_ID, 'delivery-after-second-failure', 'worker-restarted', BUSINESS_ID);
    const refs = claimed.checkpointRefs.filter((checkpoint) => checkpoint.stepKey === stepKey);

    expect(refs.map((checkpoint) => checkpoint.generation)).toEqual([2, 1]);
    // connector-session's resume path uses checkpointList.find(stepKey), so
    // the first matching checkpoint must carry the latest continuation token.
    expect(refs.find((checkpoint) => checkpoint.stepKey === stepKey)?.sessionRef).toBe('session-generation-2');
    expect(sealedContexts.filter((context) => context.slot === 'step_checkpoints.session_ref').map((context) => context.refId))
      .toEqual([`${TASK_ID}:${stepKey}:1`, `${TASK_ID}:${stepKey}:2`]);
  });

  it.each([
    ['omitted', undefined],
    ['null', null],
  ])('keeps a legacy %s sessionRef usable across claim', async (_kind, sessionRef) => {
    const world = makeRuntimeWorld({ liveLease: true });
    const body = {
      leaseEpoch: 1,
      inputHash: 'input-hash',
      outputRef: 'memory://checkpoint',
      status: 'SUCCEEDED',
      ...(sessionRef === undefined ? {} : { sessionRef }),
    };

    await world.runtime.saveStep(TASK_ID, 'legacy-step', body as never, BUSINESS_ID);
    world.task['lease_expires_at'] = new Date(0);
    world.task['state'] = 'RUNNING';
    world.task['op_state'] = 'RUNNING';
    const claimed = await world.runtime.claimTask(TASK_ID, `legacy-${_kind}`, 'worker-restarted', BUSINESS_ID);
    const ref = claimed.checkpointRefs.find((checkpoint) => checkpoint.stepKey === 'legacy-step');

    expect(ref).toBeDefined();
    expect(ref?.sessionRef === null || ref?.sessionRef === undefined).toBe(true);
  });
});

describe('RCR Luna independent offline verification — legacy download bytes', () => {
  it('returns exact raw binary bytes and byte length from the mounted legacy route', async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x41, 0x80, 0x0a]);
    const response = await handleLegacyRoute({
      method: 'GET',
      pathname: `/api/v1/operations/${OPERATION_ID}/download`,
      searchParams: new URLSearchParams(),
      headers: {},
      resolvePrincipal: async () => ({ tenantId: TENANT_ID, apiKeyId: API_KEY_ID }),
    }, {
      db: { query: async () => result() },
      loadOperation: async () => ({ id: OPERATION_ID, done: true, state: 'SUCCEEDED', outputFormat: 'markdown' }),
      loadOutputContent: async () => bytes,
    } as never);

    expect(response?.status).toBe(200);
    expect(response?.raw).toEqual(bytes);
    expect(response?.headers['content-length']).toBe(String(bytes.length));
    expect(createHash('sha256').update(response?.raw as Buffer).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('forwards UTF-8 output bytes through the public legacy adapter unchanged', async () => {
    const rawKey = 'rcr-luna-download-key';
    const content = 'Résumé – 📄';
    const bytes = Buffer.from(content, 'utf8');
    const ctx = {
      method: 'GET',
      pathname: `/api/v1/operations/${OPERATION_ID}/download`,
      searchParams: new URLSearchParams(),
      headers: { 'x-api-key': rawKey },
      body: undefined,
      rawBody: Buffer.alloc(0),
      correlationId: 'rcr-luna-download',
      config: {},
      db: {
        query: async (sql: string) => {
          if (sql.includes('FROM api_keys')) return result([{ id: API_KEY_ID, tenant_id: TENANT_ID }]);
          if (sql.includes('SELECT * FROM operations')) {
            return result([{
              id: OPERATION_ID,
              tenant_id: TENANT_ID,
              state: 'SUCCEEDED',
              output_format: 'markdown',
              output_content: content,
              deleted_at: null,
            }]);
          }
          if (sql.includes('SELECT output_content')) return result([{ output_content: content }]);
          throw new Error(`unexpected query in offline download verifier: ${sql}`);
        },
      },
    } as unknown as RouteContext;

    const response = await handlePublicRoutes(ctx);

    if (response === null) throw new Error('public route did not claim the legacy download path');
    expect(response.status).toBe(200);
    expect(response.raw).toEqual(bytes);
    expect(response.headers?.['content-length']).toBe(String(bytes.length));
    expect(createHash('sha256').update(response.raw as Buffer).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
});
