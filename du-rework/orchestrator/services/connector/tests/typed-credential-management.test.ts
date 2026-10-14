import { randomUUID } from 'node:crypto';
import { ConnectorRecipeSchema } from '@du/contracts';
import type {
  ConnectorParityIntentInput,
  ConnectorParityIntentResult,
  ConnectorParityStoredRevision,
} from '../src/db/parity-repository';
import type { SqlClient, SqlResult } from '../src/db/sql';
import { PostgresTypedCredentialStore } from '../src/db/credential-store';
import { AesCredentialCipher } from '../src/services';
import { createConnectorParityManagement } from '../src/modules/parity-management';
import type { VaultKv2SecretWritePlan, VaultKv2SecretWriter } from '../src/vault/writer';

const TENANT = '00000000-0000-0000-0000-000000000001';
const CONNECTOR = 'provider-main';
const SECRET = 'typed-pending-credential';

class MemoryCredentialRows implements SqlClient {
  readonly rows = new Map<string, Uint8Array>();

  public async query<Row extends object = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> {
    if (text.includes('INSERT INTO connector_parity_credentials')) {
      const key = JSON.stringify(values.slice(0, 5));
      if (this.rows.has(key)) return { rows: [], rowCount: 0 };
      this.rows.set(key, Buffer.from(values[5] as Uint8Array));
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('SELECT ciphertext FROM connector_parity_credentials')) {
      const value = this.rows.get(JSON.stringify(values.slice(0, 5)));
      return { rows: value ? [{ ciphertext: Buffer.from(value) } as Row] : [], rowCount: value ? 1 : 0 };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  }

  public async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

function recipe() {
  return ConnectorRecipeSchema.parse({
    adapter: 'json-http',
    method: 'POST',
    endpointUrl: 'https://provider.example/v1/generate',
    auth: { kind: 'bearer', secretSlot: 'credential' },
    headers: [],
    request: { promptField: 'messages[0].content', modelField: 'model', fields: [] },
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
}

function localRevision(revision: number, credentialRef: string, credentialSource: unknown): ConnectorParityStoredRevision {
  return {
    tenantId: TENANT,
    connectorId: CONNECTOR,
    revision,
    state: 'PENDING',
    recipe: recipe(),
    credentialRef,
    credentialVersion: 1,
    expectedHeadRevision: revision - 1,
    credentialSource: credentialSource as ConnectorParityStoredRevision['credentialSource'],
  };
}

function fixture() {
  const database = new MemoryCredentialRows();
  const store = new PostgresTypedCredentialStore(database, new AesCredentialCipher(new Uint8Array(32).fill(41)));
  let head = 0;
  const revisions = new Map<number, ConnectorParityStoredRevision>();
  const intents = new Map<string, ConnectorParityIntentResult>();
  const unknownWrites: string[] = [];
  let activeIntentInput: ConnectorParityIntentInput | undefined;
  const repository = {
    assertDraftClaim: async () => undefined,
    getIntent: async (_tenantId: string, _connectorId: string, key: string) => intents.get(key),
    getHead: async () => head,
    getRevision: async (_tenantId: string, _connectorId: string, revision: number) => revisions.get(revision),
    beginIntent: async (input: ConnectorParityIntentInput): Promise<ConnectorParityIntentResult> => {
      activeIntentInput = input;
      const revision = head + 1;
      if (input.credentialSource?.kind === 'encrypted-db') {
        const target = {
          tenantId: input.tenantId,
          connectorId: input.connectorId,
          revision,
          credentialRef: input.credentialSource.credentialRef,
          credentialVersion: input.credentialSource.version,
        };
        if (input.credentialSecret !== undefined) {
          await store.stage(database, target, input.credentialSource, input.credentialSecret);
        } else if (input.credentialCopyFrom) {
          await store.copy(database, {
            tenantId: input.tenantId,
            connectorId: input.connectorId,
            revision: input.credentialCopyFrom.revision,
            credentialRef: input.credentialCopyFrom.credentialRef,
            credentialVersion: input.credentialCopyFrom.credentialVersion,
          }, input.credentialCopyFrom.credentialSource, target, input.credentialSource);
        } else {
          throw new Error('local intent did not carry an ephemeral source value');
        }
      }
      const intent: ConnectorParityIntentResult = {
        created: true,
        payloadHash: input.payloadHash,
        state: 'PENDING',
        revision,
        expectedHeadRevision: input.expectedHeadRevision,
        vaultExpectedVersion: input.vaultExpectedVersion,
        vaultTargetVersion: input.vaultTargetVersion,
        vaultSecretSha256: input.vaultSecretSha256,
        credentialSource: input.credentialSource,
        credentialRef: input.credentialRef,
        credentialVersion: input.credentialVersion,
        credentialImportSource: input.credentialImportSource,
        recipe: input.recipe,
        backupEffectId: `effect-${revision}`,
      };
      intents.set(input.idempotencyKey, intent);
      return intent;
    },
    activateConfigWrite: async () => true,
    markConfigWriteUnknown: async (_effectId: string | null | undefined, reason: string) => { unknownWrites.push(reason); },
    finalizeIntent: async (_tenantId: string, _connectorId: string, key: string) => {
      const prior = intents.get(key);
      if (!prior || !activeIntentInput) throw new Error('intent unavailable');
      const completed: ConnectorParityStoredRevision = {
        tenantId: TENANT,
        connectorId: CONNECTOR,
        revision: prior.revision,
        state: 'PENDING',
        recipe: prior.recipe,
        credentialRef: prior.credentialRef,
        credentialVersion: prior.credentialVersion,
        expectedHeadRevision: prior.expectedHeadRevision,
        credentialSource: prior.credentialSource,
      };
      revisions.set(prior.revision, completed);
      head = prior.revision;
      const updated = { ...prior, state: 'COMPLETED' as const, revisionResult: completed };
      intents.set(key, updated);
      return updated;
    },
  };
  return { database, store, revisions, intents, unknownWrites, repository, getActiveIntentInput: () => activeIntentInput };
}

function upsert(f: ReturnType<typeof fixture>, options: { typedCredentialStore?: PostgresTypedCredentialStore; secretWriter?: VaultKv2SecretWriter }) {
  return createConnectorParityManagement({
    repository: f.repository as never,
    typedCredentialStorage: true,
    typedCredentialStore: options.typedCredentialStore ?? f.store,
    ...(options.secretWriter === undefined ? {} : { secretWriter: options.secretWriter }),
  });
}

async function createInitialDbDraft(f: ReturnType<typeof fixture>): Promise<ConnectorParityStoredRevision> {
  const service = upsert(f, {});
  const result = await service.upsertDraft({
    tenantId: TENANT,
    connectorId: CONNECTOR,
    expectedHeadRevision: 0,
    recipe: recipe(),
    credentialChange: { action: 'replace', secret: SECRET },
    idempotencyKey: 'typed-credential-enter-0001',
  });
  const revision = f.revisions.get(result.revision.revision);
  if (!revision) throw new Error('initial draft was not finalized');
  return revision;
}

describe('typed Connector credential mode management', () => {
  it('lets Keep copy a pending rev1 to rev2 before activation with fresh revision-bound ciphertext', async () => {
    const f = fixture();
    const first = await createInitialDbDraft(f);
    expect(first.state).toBe('PENDING');
    await expect(f.store.resolve({
      tenantId: TENANT,
      connectorId: CONNECTOR,
      revision: first.revision,
      credentialRef: first.credentialRef!,
      credentialVersion: first.credentialVersion!,
    }, first.credentialSource)).resolves.toBe(SECRET);

    const secondResult = await upsert(f, {}).upsertDraft({
      tenantId: TENANT,
      connectorId: CONNECTOR,
      expectedHeadRevision: first.revision,
      recipe: recipe(),
      credentialChange: { action: 'keep' },
      idempotencyKey: 'typed-credential-keep-0002',
    });
    const second = f.revisions.get(secondResult.revision.revision)!;

    expect(second.revision).toBe(2);
    expect(second.state).toBe('PENDING');
    expect(second.credentialSource).toMatchObject({ kind: 'encrypted-db', version: 1 });
    expect(second.credentialRef).not.toBe(first.credentialRef);
    await expect(f.store.resolve({
      tenantId: TENANT,
      connectorId: CONNECTOR,
      revision: second.revision,
      credentialRef: second.credentialRef!,
      credentialVersion: second.credentialVersion!,
    }, second.credentialSource)).resolves.toBe(SECRET);
    expect(f.database.rows.size).toBe(2);
  });

  it('moves DB-backed Keep to the exact planned Vault version and reopens the source on retry', async () => {
    const f = fixture();
    const first = await createInitialDbDraft(f);
    const plans: VaultKv2SecretWritePlan[] = [];
    let currentVersionReads = 0;
    let writeAttempts = 0;
    const writer: VaultKv2SecretWriter = {
      currentVersion: async () => { currentVersionReads += 1; return 4; },
      writePlanned: async (plan, secret) => {
        plans.push(plan);
        expect(secret).toBe(SECRET);
        writeAttempts += 1;
        if (writeAttempts === 1) throw new Error('simulated Vault outage after plan persistence');
        return plan.targetVersion;
      },
    };
    const service = upsert(f, { secretWriter: writer });
    const input = {
      tenantId: TENANT,
      connectorId: CONNECTOR,
      expectedHeadRevision: first.revision,
      recipe: recipe(),
      credentialChange: { action: 'keep' as const },
      idempotencyKey: 'typed-credential-vault-keep-0002',
    };

    await expect(service.upsertDraft(input)).rejects.toThrow('simulated Vault outage');
    expect(f.database.rows.size).toBe(1);
    expect(currentVersionReads).toBe(1);
    expect(f.unknownWrites).toEqual(['VAULT_WRITE_AMBIGUOUS']);

    const result = await service.upsertDraft(input);
    const second = f.revisions.get(result.revision.revision)!;
    expect(second.credentialSource).toMatchObject({ kind: 'vault-kv2', version: 5 });
    expect(second.credentialRef).toMatch(/^recipe-[0-9a-f-]{36}$/i);
    expect(f.database.rows.size).toBe(1);
    expect(currentVersionReads).toBe(1);
    expect(writeAttempts).toBe(2);
    expect(plans[0]).toEqual(plans[1]);
    expect(f.getActiveIntentInput()?.credentialSecret).toBe(SECRET);
  });

  it('fails closed on Vault metadata outage instead of selecting local DB storage', async () => {
    const f = fixture();
    const writer: VaultKv2SecretWriter = {
      currentVersion: async () => { throw new Error('Vault unavailable'); },
      writePlanned: async () => { throw new Error('must not be called'); },
    };
    await expect(upsert(f, { secretWriter: writer }).upsertDraft({
      tenantId: TENANT,
      connectorId: CONNECTOR,
      expectedHeadRevision: 0,
      recipe: recipe(),
      credentialChange: { action: 'replace', secret: SECRET },
      idempotencyKey: 'typed-credential-vault-outage-01',
    })).rejects.toThrow('Vault unavailable');
    expect(f.database.rows.size).toBe(0);
    expect(f.intents.size).toBe(0);
  });

  it('replays a planned Vault Rollback from a historical DB source after a lost write response', async () => {
    const f = fixture();
    const source = await createInitialDbDraft(f);
    const plans: VaultKv2SecretWritePlan[] = [];
    let currentVersionReads = 0;
    let writeAttempts = 0;
    const vaultWriter: VaultKv2SecretWriter = {
      currentVersion: async () => { currentVersionReads += 1; return 7; },
      writePlanned: async (plan, secret) => {
        plans.push(plan);
        expect(secret).toBe(SECRET);
        writeAttempts += 1;
        if (writeAttempts === 1) throw new Error('simulated lost Vault rollback response');
        return plan.targetVersion;
      },
    };
    const service = upsert(f, { secretWriter: vaultWriter });
    const input = {
      tenantId: TENANT,
      connectorId: CONNECTOR,
      sourceRevision: source.revision,
      expectedHeadRevision: source.revision,
      idempotencyKey: 'typed-credential-vault-rollback-01',
    };

    await expect(service.createRollbackDraft(input)).rejects.toThrow('simulated lost Vault rollback response');
    expect(f.database.rows.size).toBe(1);
    expect(currentVersionReads).toBe(1);
    expect(f.unknownWrites).toEqual(['VAULT_WRITE_AMBIGUOUS']);

    const result = await service.createRollbackDraft(input);
    const rollback = f.revisions.get(result.revision.revision)!;
    expect(rollback.credentialSource).toMatchObject({ kind: 'vault-kv2', version: 8 });
    expect(f.database.rows.size).toBe(1);
    expect(currentVersionReads).toBe(1);
    expect(writeAttempts).toBe(2);
    expect(plans[0]).toEqual(plans[1]);
  });
});
