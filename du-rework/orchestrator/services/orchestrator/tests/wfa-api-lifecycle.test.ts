import type { PoolClient } from 'pg';
import { Readable } from 'node:stream';
import type { RouteContext } from '../src/server';
import { legacyCompatHost, toLegacyRow } from '../src/compat/legacy-host-adapter';

type QueryResultLike = { rowCount: number | null; rows: unknown[] };

const PRINCIPAL = { tenantId: 'tenant-a', apiKeyId: 'key-a' };

function result(rows: unknown[] = []): QueryResultLike {
  return { rowCount: rows.length, rows };
}

function operationRow(state: string): Record<string, unknown> {
  return {
    id: 'operation-a', state, tenant_id: PRINCIPAL.tenantId, api_key_id: PRINCIPAL.apiKeyId,
    deleted_at: null, pipeline_json: '[{"processor":"ext-classifier","workflow":"invoice-flow"}]',
    steps_result_json: null, current_step: 0, progress_percent: 0,
    progress_message: 'Initializing schema workflow...', created_at: '2026-10-07T00:00:00.000Z',
    updated_at: '2026-10-07T00:00:00.000Z', output_format: null, output_content: null,
    extracted_data: null, total_input_tokens: null, total_output_tokens: null, pages_processed: null,
    model_used: null, total_cost_usd: null, usage_breakdown: null, error_code: null,
    error_message: null, failed_at_step: null, endpoint_slug: 'workflows:schema:invoice-flow',
  };
}

function makeContext(options: {
  query: (sql: string, params?: unknown[]) => Promise<QueryResultLike>;
  tx?: (work: (client: PoolClient) => Promise<unknown>) => Promise<unknown>;
  cancelOperation?: jest.Mock;
  resumeOperation?: jest.Mock;
  readStoredText?: jest.Mock;
  artifacts?: { getBlob: (storageKey: string) => Promise<Readable> };
}): RouteContext {
  const db = {
    query: options.query,
    tx: options.tx ?? (async () => { throw new Error('unexpected transaction'); }),
  };
  return {
    db,
    lifecycle: { cancelOperation: options.cancelOperation ?? jest.fn() },
    runtime: { resumeOperation: options.resumeOperation ?? jest.fn() },
    artifacts: options.artifacts ?? undefined,
    metadataReader: options.readStoredText
      ? { readStoredText: options.readStoredText }
      : undefined,
  } as unknown as RouteContext;
}

describe('WFA legacy operation lifecycle adapters', () => {
  it('projects canonical WAITING_INPUT as the legacy WAITING_USER_INPUT state for workflows', () => {
    const projected = toLegacyRow({
      ...operationRow('WAITING_INPUT'),
      pipeline_json: '[{"processor":"ext-classifier","workflow":"invoice-flow"}]',
    });
    expect(projected.state).toBe('WAITING_USER_INPUT');
    expect(projected.done).toBe(false);
  });

  // WFA 6c (fail-first): the legacy poll contract reports a parked wait as
  // WAITING_USER_INPUT for EVERY operation, not only schema-workflow rows. A
  // legacy pipeline without the workflow marker must not leak the canonical
  // WAITING_INPUT token back to old clients.
  it('projects WAITING_INPUT as WAITING_USER_INPUT even without a workflow marker', () => {
    const projected = toLegacyRow({
      ...operationRow('WAITING_INPUT'),
      pipeline_json: '[{"processor":"ext-classifier"}]',
    });
    expect(projected.state).toBe('WAITING_USER_INPUT');
    expect(projected.workflow).toBeNull();
    expect(projected.done).toBe(false);
  });

  it('atomically cancels a parked wait and closes it through the lifecycle service', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.startsWith('SELECT state FROM operations')) return result([{ state: 'WAITING_INPUT' }]);
      if (sql.startsWith('SELECT * FROM operations')) return result([operationRow('CANCELLED')]);
      throw new Error(`unexpected query: ${sql}`);
    });
    const clientQuery = jest.fn(async (sql: string) => {
      if (sql.startsWith('SELECT id, state FROM operations')) return result([{ id: 'operation-a', state: 'WAITING_INPUT' }]);
      if (sql.includes('FROM tasks WHERE operation_id')) {
        return result([{ id: 'task-a', state: 'WAITING_INPUT', lease_active: true }]);
      }
      throw new Error(`unexpected transactional query: ${sql}`);
    });
    const client = { query: clientQuery } as unknown as PoolClient;
    const tx = jest.fn(async (work: (client: PoolClient) => Promise<unknown>) => work(client));
    const cancelOperation = jest.fn(async (_id: string, _tenantId: string, activeClient?: PoolClient) => {
      expect(activeClient).toBe(client);
      return { operationId: 'operation-a', state: 'CANCELLED', replayed: false };
    });
    const host = legacyCompatHost(makeContext({ query, tx, cancelOperation }));

    const canceled = await host.cancelLegacy?.('operation-a', PRINCIPAL);

    expect(canceled?.ok).toBe(true);
    expect(cancelOperation).toHaveBeenCalledWith('operation-a', PRINCIPAL.tenantId, client);
    expect(tx).toHaveBeenCalledTimes(1);
    expect(clientQuery.mock.calls[1]?.[0]).toContain('FOR UPDATE NOWAIT');
    expect(query.mock.calls[0]?.[0]).toContain('api_key_id = $3');
  });

  it('keeps cancellation as a request while any task has a live worker lease', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.startsWith('SELECT state FROM operations')) return result([{ state: 'WAITING_CHILDREN' }]);
      if (sql.startsWith('SELECT * FROM operations')) return result([operationRow('CANCEL_REQUESTED')]);
      throw new Error(`unexpected query: ${sql}`);
    });
    const clientQuery = jest.fn(async (sql: string) => {
      if (sql.startsWith('SELECT id, state FROM operations')) return result([{ id: 'operation-a', state: 'WAITING_CHILDREN' }]);
      if (sql.includes('FROM tasks WHERE operation_id')) {
        return result([{ id: 'child-a', state: 'RUNNING', lease_active: true }]);
      }
      if (sql.startsWith('UPDATE operations SET state=')) return result([]);
      throw new Error(`unexpected transactional query: ${sql}`);
    });
    const client = { query: clientQuery } as unknown as PoolClient;
    const tx = async (work: (client: PoolClient) => Promise<unknown>) => work(client);
    const cancelOperation = jest.fn();
    const host = legacyCompatHost(makeContext({ query, tx, cancelOperation }));

    const canceled = await host.cancelLegacy?.('operation-a', PRINCIPAL);

    expect(canceled?.ok).toBe(true);
    expect(cancelOperation).not.toHaveBeenCalled();
    expect(clientQuery.mock.calls[2]?.[0]).toContain("state='CANCEL_REQUESTED'");
  });

  it('terminalizes a RUNNING task whose lease has expired', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.startsWith('SELECT state FROM operations')) return result([{ state: 'RUNNING' }]);
      if (sql.startsWith('SELECT * FROM operations')) return result([operationRow('CANCELLED')]);
      throw new Error(`unexpected query: ${sql}`);
    });
    const clientQuery = jest.fn(async (sql: string) => {
      if (sql.startsWith('SELECT id, state FROM operations')) return result([{ id: 'operation-a', state: 'RUNNING' }]);
      if (sql.includes('FROM tasks WHERE operation_id')) {
        return result([{ id: 'task-a', state: 'RUNNING', lease_active: false }]);
      }
      throw new Error(`unexpected transactional query: ${sql}`);
    });
    const client = { query: clientQuery } as unknown as PoolClient;
    const cancelOperation = jest.fn(async () => ({ operationId: 'operation-a', state: 'CANCELLED', replayed: false }));
    const host = legacyCompatHost(makeContext({
      query,
      tx: async (work) => work(client),
      cancelOperation,
    }));

    const canceled = await host.cancelLegacy?.('operation-a', PRINCIPAL);

    expect(canceled?.ok).toBe(true);
    expect(cancelOperation).toHaveBeenCalledWith('operation-a', PRINCIPAL.tenantId, client);
  });

  it('falls back to a soft cancel request when a task-first claim holds a row lock', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.startsWith('SELECT state FROM operations')) return result([{ state: 'QUEUED' }]);
      if (sql.startsWith('UPDATE operations SET state=')) return result([{ state: 'CANCEL_REQUESTED' }]);
      if (sql.startsWith('SELECT * FROM operations')) return result([operationRow('CANCEL_REQUESTED')]);
      throw new Error(`unexpected query: ${sql}`);
    });
    const tx = jest.fn(async () => { throw Object.assign(new Error('could not obtain lock'), { code: '55P03' }); });
    const cancelOperation = jest.fn();
    const host = legacyCompatHost(makeContext({ query, tx, cancelOperation }));

    const canceled = await host.cancelLegacy?.('operation-a', PRINCIPAL);

    expect(canceled?.ok).toBe(true);
    expect(tx).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[1]?.[0]).toContain("state='CANCEL_REQUESTED'");
    expect(cancelOperation).not.toHaveBeenCalled();
  });

  it('pins the legacy resume to the authenticated open wait, ignoring client wait identifiers', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('root_task_id')) {
        return result([{ id: 'operation-a', root_task_id: 'task-a', state: 'WAITING_INPUT', state_version: 17 }]);
      }
      if (sql.includes('FROM human_waits')) return result([{ wait_id: 'server-wait-a' }]);
      throw new Error(`unexpected query: ${sql}`);
    });
    const resumeOperation = jest.fn(async () => ({
      operationId: 'operation-a', state: 'QUEUED', stateVersion: 18, replayed: false, taskId: 'task-a',
    }));
    const host = legacyCompatHost(makeContext({ query, resumeOperation }));

    const resumed = await host.resumeLegacy?.('operation-a', PRINCIPAL, {
      step: 2,
      extracted_data: { approved: true },
      waitId: 'attacker-selected-wait',
      expectedStateVersion: 999,
    });

    expect(resumed).toEqual({ ok: true });
    expect(query.mock.calls[0]?.[0]).toContain('api_key_id = $3');
    expect(resumeOperation).toHaveBeenCalledWith('operation-a', PRINCIPAL.tenantId, {
      waitId: 'server-wait-a',
      expectedStateVersion: 17,
      input: { step: 2, extracted_data: { approved: true } },
    });
  });

  it('does not resume an operation owned by a different API key', async () => {
    const query = jest.fn(async () => result([]));
    const resumeOperation = jest.fn();
    const host = legacyCompatHost(makeContext({ query, resumeOperation }));

    const resumed = await host.resumeLegacy?.('operation-a', { tenantId: 'tenant-a', apiKeyId: 'other-key' }, {});

    expect(resumed).toEqual({ ok: false, status: 404, state: '' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(resumeOperation).not.toHaveBeenCalled();
  });

  it('projects terminal workflow progress from the versioned result without writing result data to the database', async () => {
    const readStoredText = jest.fn(async () => JSON.stringify({
      schemaVersion: 'legacy-workflow-result-v1',
      outputFormat: 'md',
      content: '# completed result',
      extractedData: { answer: 42 },
      pipelineSteps: [
        { step: 0, stepName: 'first', processor: 'ext-a', content_preview: null, extracted_data: null },
        { step: 1, stepName: 'second', processor: 'ext-b', content_preview: 'safe preview', extracted_data: { x: 1 } },
      ],
      usage: {},
    }));
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => result([{
      ...operationRow('SUCCEEDED'),
      result_ref: 'encrypted-result-reference',
      current_step: 0,
    }]));
    const host = legacyCompatHost(makeContext({ query, readStoredText }));

    const projected = await host.loadOperation('operation-a', PRINCIPAL.tenantId, PRINCIPAL.apiKeyId);

    expect(projected).toMatchObject({
      currentStep: 1,
      outputContent: '# completed result',
      extractedData: JSON.stringify({ answer: 42 }),
      stepsResultJson: expect.stringContaining('safe preview'),
    });
    expect(readStoredText).toHaveBeenCalledWith('encrypted-result-reference', {
      tenantId: PRINCIPAL.tenantId,
      slot: 'operations.result_ref',
      refId: 'operation-a',
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("pipeline_json->0->>'workflow' IS NULL OR api_key_id = $3");
  });

  it('returns no workflow operation to another API key in the same tenant', async () => {
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => result([]));
    const host = legacyCompatHost(makeContext({ query }));

    const projected = await host.loadOperation?.('operation-a', PRINCIPAL.tenantId, 'different-key');

    expect(projected).toBeNull();
    expect(query.mock.calls[0]?.[0]).toContain('api_key_id = $3');
    expect(query.mock.calls[0]?.[1]).toEqual(['operation-a', PRINCIPAL.tenantId, 'different-key']);
  });

  // WFA 6a (fail-first): an operation whose output lives in the file backend
  // (`output_file_path`) must serve its bytes through the artifact blob
  // reader, not collapse into the 404 `no-output` answer.
  it('serves a file-backend output by reading its artifact blob', async () => {
    const getBlob = jest.fn(async (_storageKey: string) =>
      Readable.from([Buffer.from('# file backed', 'utf8')]));
    const query = jest.fn(async () => result([{
      ...operationRow('SUCCEEDED'),
      output_content: null,
      output_file_path: 'art-output-1',
    }]));
    const host = legacyCompatHost(makeContext({ query, artifacts: { getBlob } }));

    const bytes = await host.loadOutputContent?.('operation-a', PRINCIPAL.tenantId, PRINCIPAL.apiKeyId);

    expect(bytes?.toString('utf8')).toBe('# file backed');
    expect(getBlob).toHaveBeenCalledWith('art-output-1');
  });

  it('prefers an inline output over the file path and skips storage entirely', async () => {
    const getBlob = jest.fn();
    const query = jest.fn(async () => result([{
      ...operationRow('SUCCEEDED'),
      output_content: '# inline',
      output_file_path: 'art-output-1',
    }]));
    const host = legacyCompatHost(makeContext({ query, artifacts: { getBlob } }));

    const bytes = await host.loadOutputContent?.('operation-a', PRINCIPAL.tenantId, PRINCIPAL.apiKeyId);

    expect(bytes?.toString('utf8')).toBe('# inline');
    expect(getBlob).not.toHaveBeenCalled();
  });

  it('returns null (the documented no-output answer) when neither backend has content', async () => {
    const query = jest.fn(async () => result([{
      ...operationRow('SUCCEEDED'),
      output_content: null,
      output_file_path: null,
    }]));
    const host = legacyCompatHost(makeContext({ query, artifacts: { getBlob: jest.fn() } }));

    await expect(
      host.loadOutputContent?.('operation-a', PRINCIPAL.tenantId, PRINCIPAL.apiKeyId),
    ).resolves.toBeNull();
  });

  it('answers null when the file-backend reference no longer resolves', async () => {
    const getBlob = jest.fn(async (_storageKey: string): Promise<Readable> => {
      throw new Error('artifact not found');
    });
    const query = jest.fn(async () => result([{
      ...operationRow('SUCCEEDED'),
      output_content: null,
      output_file_path: 'art-missing',
    }]));
    const host = legacyCompatHost(makeContext({ query, artifacts: { getBlob } }));

    await expect(
      host.loadOutputContent?.('operation-a', PRINCIPAL.tenantId, PRINCIPAL.apiKeyId),
    ).resolves.toBeNull();
    expect(getBlob).toHaveBeenCalledWith('art-missing');
  });
});
