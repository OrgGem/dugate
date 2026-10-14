import { randomUUID } from 'node:crypto';
import { ConnectorRecipeSchema } from '@du/contracts';
import { AdapterRegistry } from '../src/adapters/registry';
import { AesCredentialCipher } from '../src/services';
import { DurableConnectorRuntime } from '../src/services';
import { PostgresTypedCredentialStore, type TypedCredentialBinding } from '../src/db/credential-store';
import type { SqlClient, SqlResult } from '../src/db/sql';
import { InMemoryInvocationLedger } from '../src/ledger';
import { InMemoryQuotaStore } from '../src/quota';
import { InMemoryUsageOutbox } from '../src/db/usage-outbox';
import type { LocalInvocationRequest, ProviderRequest } from '../src/types';

const SENTINEL_TENANT = '00000000-0000-0000-0000-000000000001';
const OTHER_TENANT = '10000000-0000-0000-0000-000000000001';

class MemoryCredentialRows implements SqlClient {
  readonly rows = new Map<string, Uint8Array>();

  public async query<Row extends object = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> {
    if (text.includes('INSERT INTO connector_parity_credentials')) {
      const key = rowKey(parameters);
      if (this.rows.has(key)) return { rows: [], rowCount: 0 };
      this.rows.set(key, Buffer.from(parameters[5] as Uint8Array));
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('SELECT ciphertext FROM connector_parity_credentials')) {
      const ciphertext = this.rows.get(rowKey(parameters));
      return {
        rows: ciphertext ? [{ ciphertext: Buffer.from(ciphertext) } as Row] : [],
        rowCount: ciphertext ? 1 : 0,
      };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  }

  public async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

function rowKey(parameters: readonly unknown[]): string {
  return JSON.stringify(parameters.slice(0, 5));
}

function binding(tenantId = SENTINEL_TENANT, revision = 1, credentialRef: string = randomUUID()): TypedCredentialBinding {
  return {
    tenantId,
    connectorId: 'openai:llm-v1',
    revision,
    credentialRef,
    credentialVersion: 1,
  };
}

function source(value: TypedCredentialBinding) {
  return { kind: 'encrypted-db' as const, credentialRef: value.credentialRef, version: value.credentialVersion };
}

describe('typed Connector AES-GCM credential storage', () => {
  it('saves and reopens ciphertext for the default sentinel tenant', async () => {
    const database = new MemoryCredentialRows();
    const key = new Uint8Array(32).fill(29);
    const writer = new PostgresTypedCredentialStore(database, new AesCredentialCipher(key));
    const persistedSource = source(binding());
    const context = binding(SENTINEL_TENANT, 1, persistedSource.credentialRef);
    const secret = 'typed-secret-sentinel-roundtrip';

    await writer.stage(database, context, persistedSource, secret);

    const [stored] = [...database.rows.values()];
    expect(stored).toBeDefined();
    expect(Buffer.from(stored!).includes(Buffer.from(secret))).toBe(false);
    const reader = new PostgresTypedCredentialStore(database, new AesCredentialCipher(key));
    await expect(reader.resolve(context, persistedSource)).resolves.toBe(secret);
  });

  it('reseals Keep into its assigned revision and rejects copied ciphertext at another tenant row', async () => {
    const database = new MemoryCredentialRows();
    const key = new Uint8Array(32).fill(31);
    const store = new PostgresTypedCredentialStore(database, new AesCredentialCipher(key));
    const from = binding(SENTINEL_TENANT, 1);
    const fromSource = source(from);
    const to = binding(SENTINEL_TENANT, 2);
    const toSource = source(to);

    await store.stage(database, from, fromSource, 'keep-before-activation');
    await store.copy(database, from, fromSource, to, toSource);
    await expect(store.resolve(to, toSource)).resolves.toBe('keep-before-activation');

    const sourceCiphertext = database.rows.get(rowKey([
      from.tenantId, from.connectorId, from.revision, from.credentialRef, from.credentialVersion,
    ]));
    expect(sourceCiphertext).toBeDefined();
    const foreign = binding(OTHER_TENANT, 2, to.credentialRef);
    database.rows.set(rowKey([
      foreign.tenantId, foreign.connectorId, foreign.revision, foreign.credentialRef, foreign.credentialVersion,
    ]), Buffer.from(sourceCiphertext!));

    await expect(store.resolve(foreign, toSource)).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
  });

  it('resolves the reopened DB credential on the typed invocation runtime path', async () => {
    const database = new MemoryCredentialRows();
    const key = new Uint8Array(32).fill(37);
    const cipher = new AesCredentialCipher(key);
    const writer = new PostgresTypedCredentialStore(database, cipher);
    const credentialBinding = binding(SENTINEL_TENANT, 1);
    const credentialSource = source(credentialBinding);
    const secret = 'runtime-save-reopen-secret';
    await writer.stage(database, credentialBinding, credentialSource, secret);

    const recipe = ConnectorRecipeSchema.parse({
      adapter: 'json-http',
      method: 'POST',
      endpointUrl: 'https://provider.example/v1/generate',
      auth: { kind: 'bearer', secretSlot: 'credential' },
      headers: [],
      request: {
        promptField: 'messages[0].content',
        modelField: 'model',
        fields: [],
      },
      response: {
        contentPath: 'choices[0].message.content',
        modelPath: 'model',
        inputTokensPath: 'usage.prompt_tokens',
        outputTokensPath: 'usage.completion_tokens',
      },
      session: { capture: [], inject: [] },
      timeoutMs: 2_000,
      responseBytes: 16_384,
    });
    const revision = {
      tenantId: SENTINEL_TENANT,
      connectorId: credentialBinding.connectorId,
      revision: credentialBinding.revision,
      state: 'ACTIVE' as const,
      recipe,
      credentialRef: credentialBinding.credentialRef,
      credentialVersion: credentialBinding.credentialVersion,
      expectedHeadRevision: 0,
      credentialSource,
    };
    const sent: ProviderRequest[] = [];
    const transport = {
      send: async (request: ProviderRequest) => {
        sent.push(request);
        return {
          status: 200,
          body: {
            choices: [{ message: { content: 'runtime-ok' } }],
            model: 'model-test',
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          },
        };
      },
    };
    const parityRepository = {
      hasTypedChain: async () => true,
      getRevision: async () => revision,
    };
    const ledger = new InMemoryInvocationLedger();
    const runtime = new DurableConnectorRuntime(
      ledger as never,
      {} as never,
      new InMemoryQuotaStore(),
      new InMemoryUsageOutbox() as never,
      new AdapterRegistry(),
      transport,
      cipher,
      { verify: async () => { throw new Error('unused'); } },
      undefined,
      undefined,
      parityRepository as never,
      undefined,
      new PostgresTypedCredentialStore(database, new AesCredentialCipher(key)),
    );
    const request: LocalInvocationRequest = {
      contractVersion: '1',
      invocationId: `typed-local-${randomUUID()}`,
      tenantId: SENTINEL_TENANT,
      operationId: '00000000-0000-0000-0000-000000000011',
      taskId: '00000000-0000-0000-0000-000000000012',
      stepKey: 'generate',
      bindingSlot: 'provider',
      input: { prompt: 'hello' },
      deadlineAt: new Date(Date.now() + 10_000).toISOString(),
      connectorId: credentialBinding.connectorId,
      connectorRevision: credentialBinding.revision,
    };
    const execute = (runtime as unknown as {
      executeInvocation(local: LocalInvocationRequest, connectorId: string, revision: number, allowPending: boolean): Promise<{ state: string }>;
    }).executeInvocation;

    const result = await execute.call(runtime, request, credentialBinding.connectorId, 1, false);
    expect(result.state).toBe('completed');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers.Authorization).toBe(`Bearer ${secret}`);
  });
});
