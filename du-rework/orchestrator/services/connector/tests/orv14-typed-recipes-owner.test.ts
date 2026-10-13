import { createHash } from 'node:crypto';
import { canonicalize, ConnectorRecipeSchema, ConnectorWorkflowOverridesSchema, type ConnectorRecipe } from '@du/contracts';
import { createTypedRecipeAdapter } from '../src/adapters/recipe';
import { PostgresConnectorParityRepository } from '../src/db/parity-repository';
import type { SqlClient, SqlResult } from '../src/db/sql';
import { DurableConnectorRuntime } from '../src/services';
import type { LocalInvocationRequest } from '../src/types';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

class ClaimSql implements SqlClient {
  public readonly owners = new Map<string, string>();
  public readonly claims = new Map<string, { hash: string; expectedHead: number }>();
  public readonly heads = new Map<string, number>();

  public async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    return callback(this);
  }

  public async query<Row extends object = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    const sql = text.replace(/\s+/g, ' ').trim().toLowerCase();
    const params = values;
    let rows: object[] = [];
    if (sql.startsWith('select fence_id,fence_revision,state from connector_backup_effect_gate')) {
      rows = [{ fence_id: null, fence_revision: 0, state: 'OPEN' }];
    } else if (sql.includes('pg_advisory_xact_lock')) {
      rows = [];
    } else if (sql.startsWith('select tenant_id from connector_parity_chains where connector_id=$1')) {
      const owner = this.owners.get(String(params[0]));
      rows = owner ? [{ tenant_id: owner }] : [];
    } else if (sql.startsWith('select payload_hash from connector_parity_claim_intents')) {
      const key = `${String(params[0])}|${String(params[1])}|${String(params[2])}`;
      const receipt = this.claims.get(key);
      rows = receipt ? [{ payload_hash: receipt.hash }] : [];
    } else if (sql.startsWith('select revision from connector_parity_revisions')) {
      const key = `${String(params[0])}|${String(params[1])}`;
      const revision = this.heads.get(key) ?? 0;
      rows = revision ? [{ revision }] : [];
    } else if (sql.startsWith('select idempotency_key from connector_parity_draft_intents')) {
      rows = [];
    } else if (sql.startsWith('insert into connector_parity_chains')) {
      const connectorId = String(params[0]);
      if (!this.owners.has(connectorId)) this.owners.set(connectorId, String(params[1]));
    } else if (sql.startsWith('insert into connector_parity_claim_intents')) {
      const key = `${String(params[0])}|${String(params[1])}|${String(params[2])}`;
      this.claims.set(key, { hash: String(params[3]), expectedHead: Number(params[4]) });
    } else if (sql.startsWith('select c.tenant_id, i.payload_hash')) {
      const tenantId = String(params[1]);
      const connectorId = String(params[0]);
      const idempotencyKey = String(params[2]);
      const key = `${tenantId}|${connectorId}|${idempotencyKey}`;
      const owner = this.owners.get(connectorId);
      const receipt = this.claims.get(key);
      rows = owner && owner.toLowerCase() === tenantId.toLowerCase() && receipt
        ? [{ tenant_id: owner, payload_hash: receipt.hash }]
        : [];
    } else {
      throw new Error(`Unexpected SQL in claim owner test: ${sql}`);
    }
    return { rows: rows as Row[] };
  }
}

function recipe(overrides: Partial<ConnectorRecipe> = {}): ConnectorRecipe {
  return ConnectorRecipeSchema.parse({
    adapter: 'json-http',
    method: 'POST',
    endpointUrl: 'https://provider.example/v1/generate',
    auth: { kind: 'bearer', secretSlot: 'credential' },
    headers: [{ name: 'x-client', value: 'fixed' }],
    request: {
      promptField: 'messages[0].content',
      modelField: 'model',
      fields: [
        { name: 'temperature', source: 'input' },
        { name: 'mode', source: 'static', value: 'fast' },
      ],
    },
    response: {
      contentPath: 'choices[0].message.content',
      modelPath: 'model',
      inputTokensPath: 'usage.prompt_tokens',
      outputTokensPath: 'usage.completion_tokens',
    },
    session: { capture: [], inject: [] },
    timeoutMs: 5_000,
    responseBytes: 32_768,
    ...overrides,
  });
}

describe('ORV14 typed Connector recipe owner checks', () => {
  test('claim reserves a new connector, replays after head advancement, and hides foreign ownership', async () => {
    const sql = new ClaimSql();
    const repository = new PostgresConnectorParityRepository(sql);
    const initial = {
      tenantId: TENANT_A,
      connectorId: 'provider-main',
      expectedHeadRevision: 0,
      idempotencyKey: 'catalog-import-0001',
    };
    expect(await repository.claimRecipeDraft(initial)).toEqual({ claimed: true, expectedHeadRevision: 0 });
    await expect(repository.assertDraftClaim(initial)).resolves.toBeUndefined();

    // A successful draft advanced the head; accepted claim replay still works.
    sql.heads.set(`${TENANT_A}|provider-main`, 1);
    expect(await repository.claimRecipeDraft(initial)).toEqual({ claimed: true, expectedHeadRevision: 0 });
    await expect(repository.claimRecipeDraft({ ...initial, expectedHeadRevision: 1 })).rejects.toMatchObject({ code: 'INPUT_HASH_MISMATCH' });

    expect(await repository.claimRecipeDraft({ ...initial, idempotencyKey: 'catalog-import-0002' }))
      .toEqual({ claimed: false, expectedHeadRevision: 0 });
    expect(await repository.claimRecipeDraft({ ...initial, expectedHeadRevision: 1, idempotencyKey: 'catalog-import-0002' }))
      .toEqual({ claimed: true, expectedHeadRevision: 1 });
    expect(await repository.claimRecipeDraft({
      tenantId: TENANT_B,
      connectorId: 'provider-main',
      expectedHeadRevision: 1,
      idempotencyKey: 'catalog-import-foreign',
    })).toEqual({ claimed: false, expectedHeadRevision: 1 });
    await expect(repository.assertDraftClaim({
      tenantId: TENANT_B,
      connectorId: 'provider-main',
      expectedHeadRevision: 1,
      idempotencyKey: 'catalog-import-foreign',
    })).rejects.toMatchObject({ code: 'BINDING_DENIED' });
  });

  test('typed recipes map only declared fields, bind workflow overrides, and report measured usage', () => {
    const config = recipe();
    const digest = createHash('sha256').update(canonicalize(config)).digest('hex');
    const overrides = ConnectorWorkflowOverridesSchema.parse({
      connectorId: 'provider-main',
      connectorRevision: 3,
      recipeDigest: digest,
      staticFormFields: [{ name: 'mode', value: 'precise' }],
      extraHeaders: [{ name: 'x-client', value: 'workflow-client' }],
    });
    const typed = createTypedRecipeAdapter(config, 'credential-secret', overrides);
    const request: LocalInvocationRequest = {
      contractVersion: '1',
      invocationId: 'inv-1',
      tenantId: TENANT_A,
      operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
      taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac',
      stepKey: 'generate',
      bindingSlot: 'profile-ai',
      input: { prompt: 'hello', parameters: { temperature: 0.2, ignored: 'not forwarded' } },
      options: { model: 'model-pinned' },
      deadlineAt: new Date(Date.now() + 10_000).toISOString(),
      connectorId: 'provider-main',
      connectorRevision: 3,
      workflowOverrides: overrides,
    };
    const built = typed.adapter.buildRequest(request, {
      baseUrl: 'https://provider.example',
      path: '/v1/generate',
      timeoutMs: 5_000,
    });
    expect(built.method).toBe('POST');
    expect(built.headers).toMatchObject({ Authorization: 'Bearer credential-secret', 'x-client': 'workflow-client' });
    const body = JSON.parse(String(built.body)) as Record<string, unknown>;
    expect(body).toEqual({
      messages: [{ content: 'hello' }],
      model: 'model-pinned',
      temperature: 0.2,
      mode: 'precise',
    });
    const normalized = typed.adapter.normalizeResponse({
      status: 200,
      body: { choices: [{ message: { content: 'done' } }], model: 'model-pinned', usage: { prompt_tokens: 5, completion_tokens: 2 } },
    }, { baseUrl: 'https://provider.example', path: '/v1/generate', timeoutMs: 5_000 });
    expect(normalized).toMatchObject({ content: 'done', usage: { inputTokens: 5, outputTokens: 2, model: 'model-pinned', measurement: 'measured' } });
  });

  test('invalid recipe URL and workflow digest fail before transport', () => {
    expect(() => createTypedRecipeAdapter(recipe({ endpointUrl: 'https://provider.example/v1?api_key=secret' }), 's'))
      .toThrow(expect.objectContaining({ code: 'CAPABILITY_UNSUPPORTED' }));
    const config = recipe();
    expect(() => createTypedRecipeAdapter(config, 's', {
      connectorId: 'provider-main', connectorRevision: 3, recipeDigest: '0'.repeat(64),
      staticFormFields: [], extraHeaders: [],
    })).toThrow(expect.objectContaining({ code: 'BINDING_DENIED' }));
  });

  test('a typed tenant chain with a missing revision never falls back to a generic row', async () => {
    const genericRepository = { getRevision: jest.fn(async () => ({ connectorId: 'provider-main', revision: 1 })) };
    const typedRepository = { hasTypedChain: jest.fn(async () => true), getRevision: jest.fn(async () => undefined) };
    const runtime = new DurableConnectorRuntime(
      {} as never,
      genericRepository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      typedRepository as never,
    );
    const execute = (runtime as unknown as { executeInvocation: (...args: unknown[]) => Promise<unknown> }).executeInvocation;
    await expect(execute.call(runtime, {
      contractVersion: '1', invocationId: 'inv-1', tenantId: TENANT_A,
      operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab', taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac',
      stepKey: 'generate', bindingSlot: 'slot', input: { prompt: 'hello' }, deadlineAt: new Date(Date.now() + 10_000).toISOString(),
    }, 'provider-main', 1, false)).rejects.toMatchObject({ code: 'BINDING_DENIED' });
    expect(genericRepository.getRevision).not.toHaveBeenCalled();
  });
});
