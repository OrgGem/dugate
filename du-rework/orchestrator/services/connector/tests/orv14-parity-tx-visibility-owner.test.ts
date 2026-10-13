import { createHash } from 'node:crypto';
import { canonicalize, ConnectorRecipeSchema, type ConnectorRecipe } from '@du/contracts';
import {
  createInvocationFieldCrypto,
  createLocalInvocationKekProvider,
} from '../src/db/invocation-crypto';
import { PostgresConnectorParityRepository } from '../src/db/parity-repository';
import type { ConnectorBackupConfigWritePort } from '../src/db/backup-effect-fences';
import type { SqlClient, SqlResult } from '../src/db/sql';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONNECTOR = 'provider-main';
const REVISION = 1;
const IDEMPOTENCY_KEY = 'draft-transaction-visibility-01';
const PAYLOAD_HASH = 'a'.repeat(64);
const BACKUP_EFFECT_ID = 'b1b2b3b4-c5c6-47d8-89e0-f1f2f3f4f5f6';

const RECIPE = ConnectorRecipeSchema.parse({
  adapter: 'json-http',
  method: 'POST',
  endpointUrl: 'https://provider.example/v1/generate',
  auth: { kind: 'bearer', secretSlot: 'credential' },
  headers: [],
  request: {
    promptField: 'messages[0].content',
    modelField: 'model',
    fields: [{ name: 'temperature', source: 'input' }],
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
});

type IntentState = 'PENDING' | 'COMPLETED';

class TransactionVisibilityDb implements SqlClient {
  public inTransaction = false;
  public transactionCount = 0;
  public transactionQueries = 0;
  public poolQueries = 0;
  public poolQueriesInsideTransaction = 0;
  public revisionInserts = 0;
  public completedEffects: string[] = [];
  public intent: Record<string, unknown>;
  public revision: Record<string, unknown> | undefined;

  public constructor(recipeEnvelope: unknown, private readonly claimHash: string) {
    this.intent = {
      tenant_id: TENANT,
      connector_id: CONNECTOR,
      idempotency_key: IDEMPOTENCY_KEY,
      payload_hash: PAYLOAD_HASH,
      state: 'PENDING' satisfies IntentState,
      operation: 'DRAFT',
      revision: REVISION,
      expected_head_revision: 0,
      source_revision: null,
      recipe_envelope: recipeEnvelope,
      credential_ref: null,
      credential_version: null,
      credential_source: null,
      credential_import_source: null,
      vault_expected_version: null,
      vault_target_version: null,
      vault_secret_sha256: null,
      backup_effect_id: BACKUP_EFFECT_ID,
    };
  }

  public async query<Row extends object = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> {
    this.poolQueries += 1;
    if (this.inTransaction) {
      this.poolQueriesInsideTransaction += 1;
      throw new Error('global SQL pool read attempted while a parity transaction is open');
    }
    return this.execute<Row>(text, parameters);
  }

  public async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    if (this.inTransaction) throw new Error('unexpected nested SQL transaction');
    this.transactionCount += 1;
    this.inTransaction = true;
    const tx: SqlClient = {
      query: async <Row extends object = Record<string, unknown>>(text: string, parameters: readonly unknown[] = []) => {
        if (!this.inTransaction) throw new Error('transaction query ran after its transaction ended');
        this.transactionQueries += 1;
        return this.execute<Row>(text, parameters);
      },
      transaction: async <Nested>(nested: (client: SqlClient) => Promise<Nested>) => nested(tx),
    };
    try {
      return await callback(tx);
    } finally {
      this.inTransaction = false;
    }
  }

  private async execute<Row extends object>(text: string, parameters: readonly unknown[]): Promise<SqlResult<Row>> {
    const sql = text.replace(/\s+/g, ' ').trim().toLowerCase();
    let rows: object[] = [];

    if (sql.startsWith('select fence_id,fence_revision,state from connector_backup_effect_gate')) {
      rows = [{ fence_id: null, fence_revision: 0, state: 'OPEN' }];
    } else if (sql.startsWith("update connector_backup_effect_permits set state='completed'")) {
      this.completedEffects.push(String(parameters[0]));
    } else if (sql.includes('pg_advisory_xact_lock')) {
      rows = [];
    } else if (sql.startsWith('select * from connector_parity_draft_intents')) {
      rows = [this.intent];
    } else if (sql.startsWith('select tenant_id from connector_parity_chains')) {
      rows = [{ tenant_id: TENANT }];
    } else if (sql.startsWith('select payload_hash from connector_parity_claim_intents')) {
      rows = [{ payload_hash: this.claimHash }];
    } else if (sql.startsWith('insert into connector_parity_revisions')) {
      this.revisionInserts += 1;
      this.revision = {
        tenant_id: TENANT,
        connector_id: CONNECTOR,
        revision: REVISION,
        state: 'PENDING',
        recipe_envelope: this.intent.recipe_envelope,
        credential_ref: null,
        credential_version: null,
        credential_source: null,
        created_at: '2026-10-11T23:00:00.000Z',
        updated_at: '2026-10-11T23:00:00.000Z',
      };
      rows = [this.revision];
    } else if (sql.startsWith("update connector_parity_draft_intents set state='completed'")) {
      this.intent.state = 'COMPLETED';
    } else if (sql.startsWith('select * from connector_parity_revisions')) {
      rows = this.revision ? [this.revision] : [];
    } else {
      throw new Error(`Unexpected SQL in transaction-visibility test: ${sql}; params=${parameters.length}`);
    }
    return { rows: rows as Row[] };
  }
}

function claimHash(): string {
  return createHash('sha256').update(canonicalize({
    tenantId: TENANT,
    connectorId: CONNECTOR,
    expectedHeadRevision: 0,
  })).digest('hex');
}

function invocationCrypto() {
  const keyRef = 'orv14-parity-tx-visibility-test';
  const provider = createLocalInvocationKekProvider({
    keyRef,
    activeVersion: 1,
    keysByVersion: { '1': Buffer.alloc(32, 19).toString('base64') },
  });
  return createInvocationFieldCrypto(provider, keyRef);
}

function backupConfigWrites(): ConnectorBackupConfigWritePort {
  return {
    prepare: async () => undefined,
    activate: async () => true,
    complete: async (client, effectId) => {
      await client.query("UPDATE connector_backup_effect_permits SET state='COMPLETED' WHERE effect_id=$1", [effectId]);
    },
    markUnknown: async () => undefined,
  };
}

describe('ORV14 parity transaction-consistent revision visibility', () => {
  it('finalizes and replays a completed intent without reading the pool before commit', async () => {
    const crypto = invocationCrypto();
    const envelope = await crypto.seal(RECIPE, {
      tenantId: TENANT,
      slot: 'connector_parity_revisions.recipe',
      refId: `${CONNECTOR}:${REVISION}`,
    });
    const db = new TransactionVisibilityDb(envelope, claimHash());
    const repository = new PostgresConnectorParityRepository(db, crypto, backupConfigWrites());

    const firstWrite = await repository.finalizeIntent(TENANT, CONNECTOR, IDEMPOTENCY_KEY);
    expect(firstWrite).toMatchObject({
      state: 'COMPLETED',
      revision: REVISION,
      revisionResult: {
        tenantId: TENANT,
        connectorId: CONNECTOR,
        revision: REVISION,
        state: 'PENDING',
        recipe: RECIPE,
        credentialRef: null,
        credentialVersion: null,
      },
    });
    expect(db.poolQueriesInsideTransaction).toBe(0);
    expect(db.transactionQueries).toBe(9);
    expect(db.revisionInserts).toBe(1);
    expect(db.completedEffects).toEqual([BACKUP_EFFECT_ID]);

    const completedReplay = await repository.finalizeIntent(TENANT, CONNECTOR, IDEMPOTENCY_KEY);
    expect(completedReplay).toEqual(firstWrite);
    expect(db.poolQueriesInsideTransaction).toBe(0);
    expect(db.revisionInserts).toBe(1);
    expect(db.completedEffects).toEqual([BACKUP_EFFECT_ID]);

    const beginIntentReplay = await repository.beginIntent({
      tenantId: TENANT,
      connectorId: CONNECTOR,
      idempotencyKey: IDEMPOTENCY_KEY,
      payloadHash: PAYLOAD_HASH,
      operation: 'DRAFT',
      expectedHeadRevision: 0,
      recipe: RECIPE as ConnectorRecipe,
      credentialRef: null,
      credentialVersion: null,
      credentialSource: null,
      credentialImportSource: null,
      vaultExpectedVersion: null,
      vaultTargetVersion: null,
      vaultSecretSha256: null,
    });
    expect(beginIntentReplay).toEqual(firstWrite);
    expect(db.poolQueriesInsideTransaction).toBe(0);
    expect(db.revisionInserts).toBe(1);
    expect(db.transactionCount).toBe(3);
  });
});
