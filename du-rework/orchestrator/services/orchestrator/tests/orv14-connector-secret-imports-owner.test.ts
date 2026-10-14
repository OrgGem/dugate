import { randomUUID } from 'node:crypto';
import type { Db } from '../src/db/db';
import { createMetadataCrypto, type MetadataCrypto } from '../src/modules/runtime/metadata-crypto';
import { adaptKeyProviderForMetadata } from '../src/modules/encryption/metadata-key-adapter';
import {
  createLocalKeyProvider,
  LOCAL_METADATA_KEY_REF,
  parseLocalEncryptionKeyring,
} from '../src/modules/encryption/local-key-provider';
import { encryptSecretValue } from '../src/modules/secrets/secret-catalog-store';
import { parseSecretCatalogKeyring, type SecretCatalogKeyring } from '../src/modules/secrets/secret-revision-resolver';
import type { BackupSnapshotWriteGate } from '../src/modules/maintenance/backup-effect-fence';
import {
  createConnectorSecretImportService,
  type ConnectorSecretImportActor,
} from '../src/modules/connectors/connector-secret-imports';
import type { ConnectorDraftUpsert, ConnectorParityDraftResult } from '@du/contracts';

// The seed tenant uses the canonical all-zero sentinel form; it is valid
// tenant identity text even though it is not an RFC UUID version/variant.
const TENANT = '00000000-0000-0000-0000-000000000001';
const SECRET_ID = '3b2bbf03-d716-49f6-93c1-8fb75d8eb2d1';
const CONNECTOR_ID = 'text.primary';
const SECRET = 'catalog-secret-original';
const CATALOG_KEY = Buffer.alloc(32, 0x42);

const actor: ConnectorSecretImportActor = {
  actor: 'admin-session:operator-1',
  role: 'platform',
  issuer: 'du-local',
  sub: 'operator-1',
};

const recipe = {
  adapter: 'openai-compatible' as const,
  method: 'POST' as const,
  endpointUrl: 'https://provider.example.test/v1/chat/completions',
  auth: { kind: 'bearer' as const, secretSlot: 'api_key' },
  headers: [],
  request: { promptField: 'prompt', modelField: 'model', fields: [{ name: 'model', source: 'model' as const }] },
  response: { contentPath: 'choices.0.message.content' },
  session: { capture: [], inject: [] },
  timeoutMs: 10_000,
  responseBytes: 16_384,
};

function request(expectedHeadRevision = 0): ConnectorDraftUpsert {
  return {
    tenantId: TENANT,
    expectedHeadRevision,
    recipe,
    credentialChange: { action: 'vault-ref', reference: SECRET_ID },
    idempotencyKey: 'catalog-import-test-001',
  };
}

function result(credentialRef = 'recipe-11111111-1111-4111-8111-111111111111'): ConnectorParityDraftResult {
  return {
    revision: {
      tenantId: TENANT,
      connectorId: CONNECTOR_ID,
      revision: 1,
      state: 'PENDING',
      recipe,
      credentialRef,
      credentialVersion: 1,
      expectedHeadRevision: 0,
    },
    expectedHeadRevision: 0,
    replayed: false,
  };
}

function fakeDb(catalogKey: Buffer = CATALOG_KEY, catalogKeyVersion = 'catalog-key-v1') {
  let row: Record<string, unknown> | null = null;
  let catalogSecret = SECRET;
  let catalogRevision = 1;
  let catalogReads = 0;

  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
    if (sql.includes('FROM connector_secret_imports') && sql.includes('FOR UPDATE')) {
      return row && row.tenant_id === params[0] && row.connector_id === params[1] && row.idempotency_key === params[2]
        ? { rows: [{ ...row }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM secret_catalog c') && sql.includes('secret_catalog_revisions')) {
      catalogReads += 1;
      return {
        rows: [{
          secret_id: SECRET_ID,
          tenant_id: TENANT,
          state: 'ACTIVE',
          revision: catalogRevision,
          revision_state: 'ACTIVE',
          purpose: 'connector.credential',
          services: ['connector'],
          provider_kind: 'managed_value',
          encrypted_value: encryptSecretValue(catalogSecret, catalogKey),
          encryption_key_version: catalogKeyVersion,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes('INSERT INTO connector_secret_imports')) {
      row = {
        import_id: params[0], tenant_id: params[1], connector_id: params[2], idempotency_key: params[3],
        request_hash: params[4], source_secret_id: params[5], source_revision: params[6], source_key_version: params[7],
        state: 'PENDING', resolved_payload: JSON.parse(String(params[8])), result: null,
        lease_token: params[9], lease_until: params[10], created_by: params[11], created_by_issuer: params[12],
        created_by_sub: params[13], created_at: params[14],
      };
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE connector_secret_imports') && sql.includes("SET lease_token=$2")) {
      if (row && row.import_id === params[0] && row.state === 'PENDING') {
        row.lease_token = params[1]; row.lease_until = params[2]; row.updated_at = params[3];
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('UPDATE connector_secret_imports') && sql.includes("SET lease_token=NULL")) {
      if (row && row.import_id === params[0] && row.lease_token === params[2]) {
        row.lease_token = null; row.lease_until = null; row.updated_at = params[1];
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('UPDATE connector_secret_imports') && sql.includes("SET state='COMPLETED'")) {
      if (row && row.import_id === params[0] && row.state === 'PENDING' && row.lease_token === params[1] && row.request_hash === params[2]) {
        row.state = 'COMPLETED'; row.result = JSON.parse(String(params[3])); row.lease_token = null; row.lease_until = null;
        row.updated_at = params[4];
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('SELECT state,result FROM connector_secret_imports')) {
      return row ? { rows: [{ state: row.state, result: row.result }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    throw new Error('unexpected fake SQL: ' + sql);
  };
  const db = {
    pool: {} as Db['pool'],
    query,
    tx: async (fn: (client: never) => Promise<unknown>) => fn({ query } as never),
    close: async () => undefined,
  } as unknown as Db;
  return {
    db,
    get row() { return row; },
    setCatalog(value: string, revision: number) { catalogSecret = value; catalogRevision = revision; },
    get catalogReads() { return catalogReads; },
  };
}

function metadataCrypto(): MetadataCrypto {
  return createMetadataCrypto({
    wrapDek: async (dek) => ({ version: 1, keyName: 'unit-test', keyVersion: 1, wrappedKey: dek.toString('base64') }),
    unwrapDek: async (wrapped) => Buffer.from(wrapped.wrappedKey, 'base64'),
  }, 'unit-test');
}

function keyring(): SecretCatalogKeyring {
  return { activeVersion: 'catalog-key-v1', keys: { 'catalog-key-v1': CATALOG_KEY } };
}

function noVaultMetadataCrypto(master: string): MetadataCrypto {
  const localKeyring = parseLocalEncryptionKeyring({ ENCRYPTION_KEY: master });
  if (!localKeyring) throw new Error('test local keyring was not derived');
  const provider = createLocalKeyProvider(localKeyring, [LOCAL_METADATA_KEY_REF]);
  return createMetadataCrypto(adaptKeyProviderForMetadata(provider), LOCAL_METADATA_KEY_REF);
}

function audit() {
  return { record: jest.fn(async () => ({ id: randomUUID() })) } as never;
}

function allowSnapshotWrites(): BackupSnapshotWriteGate {
  return { assertWriteAllowed: async () => undefined };
}

describe('ORV14 Connector secret import journal', () => {
  test('completes and replays a managed-value import with no Vault using retained local keys', async () => {
    const master = 'orchestrator-no-vault-import-master-key'.padEnd(64, 'x');
    const catalogKeyring = parseSecretCatalogKeyring({ ENCRYPTION_KEY: master });
    const catalogKey = catalogKeyring?.keys[catalogKeyring.activeVersion];
    if (!catalogKeyring || !catalogKey) throw new Error('test Catalog keyring was not derived');
    const fixture = fakeDb(catalogKey, catalogKeyring.activeVersion);
    const output = result(randomUUID());
    const submit = jest.fn().mockRejectedValueOnce(new Error('ambiguous Connector timeout')).mockResolvedValue(output);
    const claim = jest.fn(async (input: { expectedHeadRevision: number }) => ({
      claimed: true,
      expectedHeadRevision: input.expectedHeadRevision,
    }));
    const service = createConnectorSecretImportService({
      db: fixture.db,
      audit: audit(),
      metadataCrypto: noVaultMetadataCrypto(master),
      catalogKeyring,
      backupSnapshotWriteGate: allowSnapshotWrites(),
      connector: { claimRecipeDraft: claim, upsertResolvedRecipeDraft: submit },
    });

    await expect(service.importCredential(CONNECTOR_ID, request(), actor)).rejects.toMatchObject({ status: 503 });
    expect(fixture.row?.state).toBe('PENDING');
    expect(JSON.stringify(fixture.row?.resolved_payload)).not.toContain(SECRET);
    expect((fixture.row?.resolved_payload as { dek?: { providerKind?: string } }).dek?.providerKind).toBe('local-keyring');

    const completed = await service.importCredential(CONNECTOR_ID, request(), actor);
    expect(completed.revision.credentialRef).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(fixture.row?.state).toBe('COMPLETED');
    expect(JSON.stringify(fixture.row?.resolved_payload)).not.toContain(SECRET);
    expect(JSON.stringify(fixture.row?.result)).not.toContain(SECRET);

    const replay = await service.importCredential(CONNECTOR_ID, request(), actor);
    expect(replay.replayed).toBe(true);
    expect(replay.revision).toEqual(completed.revision);
    expect(fixture.catalogReads).toBe(1);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(claim).toHaveBeenCalledTimes(3);
  });

  test('seals before network, retries the same exact Catalog revision, and replays the masked result', async () => {
    const fixture = fakeDb();
    const submit = jest.fn()
      .mockRejectedValueOnce(new Error('ambiguous connector timeout'))
      .mockResolvedValue(result());
    const claim = jest.fn(async (input: { expectedHeadRevision: number }) => ({
      claimed: true, expectedHeadRevision: input.expectedHeadRevision,
    }));
    const service = createConnectorSecretImportService({
      db: fixture.db, audit: audit(), metadataCrypto: metadataCrypto(), catalogKeyring: keyring(), backupSnapshotWriteGate: allowSnapshotWrites(),
      connector: { claimRecipeDraft: claim, upsertResolvedRecipeDraft: submit },
    });

    await expect(service.importCredential(CONNECTOR_ID, request(), actor)).rejects.toMatchObject({ status: 503 });
    expect(fixture.row?.state).toBe('PENDING');
    expect(JSON.stringify(fixture.row?.resolved_payload)).not.toContain(SECRET);
    expect(submit.mock.calls[0]?.[0]).toMatchObject({
      credentialChange: { action: 'replace', secret: SECRET },
      credentialImportSource: { catalogVersionRef: SECRET_ID + '@1', catalogKeyVersion: 'catalog-key-v1' },
      idempotencyKey: request().idempotencyKey,
    });

    fixture.setCatalog('rotated-secret-must-not-be-used', 2);
    const recovered = await service.importCredential(CONNECTOR_ID, request(), actor);
    expect(recovered.revision.credentialRef).toBe('recipe-11111111-1111-4111-8111-111111111111');
    expect(fixture.catalogReads).toBe(1);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(claim).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]?.[0]).toMatchObject({
      credentialChange: { action: 'replace', secret: SECRET },
      credentialImportSource: { catalogVersionRef: SECRET_ID + '@1', catalogKeyVersion: 'catalog-key-v1' },
    });

    const replay = await service.importCredential(CONNECTOR_ID, request(), actor);
    expect(replay.replayed).toBe(true);
    expect(replay.revision).toEqual(recovered.revision);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(claim).toHaveBeenCalledTimes(3);
    expect(fixture.catalogReads).toBe(1);
    expect(JSON.stringify(fixture.row?.result)).not.toContain(SECRET);
  });

  test('rejects same-key divergent input before a second Catalog resolution', async () => {
    const fixture = fakeDb();
    const submit = jest.fn().mockResolvedValue(result());
    const claim = jest.fn(async (input: { expectedHeadRevision: number }) => ({
      claimed: true, expectedHeadRevision: input.expectedHeadRevision,
    }));
    const service = createConnectorSecretImportService({
      db: fixture.db, audit: audit(), metadataCrypto: metadataCrypto(), catalogKeyring: keyring(), backupSnapshotWriteGate: allowSnapshotWrites(),
      connector: { claimRecipeDraft: claim, upsertResolvedRecipeDraft: submit },
    });
    await service.importCredential(CONNECTOR_ID, request(), actor);
    await expect(service.importCredential(CONNECTOR_ID, request(1), actor)).rejects.toMatchObject({
      status: 409, code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(fixture.catalogReads).toBe(1);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(2);
  });

  test('refuses an unclaimed tenant/connector chain before opening Catalog data', async () => {
    const fixture = fakeDb();
    const submit = jest.fn().mockResolvedValue(result());
    const claim = jest.fn().mockResolvedValue({ claimed: false, expectedHeadRevision: 0 });
    const service = createConnectorSecretImportService({
      db: fixture.db, audit: audit(), metadataCrypto: metadataCrypto(), catalogKeyring: keyring(), backupSnapshotWriteGate: allowSnapshotWrites(),
      connector: { claimRecipeDraft: claim, upsertResolvedRecipeDraft: submit },
    });

    await expect(service.importCredential(CONNECTOR_ID, request(), actor)).rejects.toMatchObject({
      status: 409, code: 'CONNECTOR_SCOPE_CONFLICT',
    });
    expect(fixture.catalogReads).toBe(0);
    expect(submit).not.toHaveBeenCalled();
  });

  test('requires configured metadata crypto and rejects non-platform callers before Catalog access', async () => {
    const fixture = fakeDb();
    const service = createConnectorSecretImportService({
      db: fixture.db, audit: audit(), catalogKeyring: keyring(),
      connector: {
        claimRecipeDraft: async (input: { expectedHeadRevision: number }) => ({ claimed: true, expectedHeadRevision: input.expectedHeadRevision }),
        upsertResolvedRecipeDraft: jest.fn().mockResolvedValue(result()),
      },
    });
    await expect(service.importCredential(CONNECTOR_ID, request(), actor)).rejects.toMatchObject({
      status: 503, code: 'METADATA_ENCRYPTION_REQUIRED',
    });
    await expect(service.importCredential(CONNECTOR_ID, request(), { ...actor, role: 'operator' as 'platform' })).rejects.toMatchObject({
      status: 403, code: 'PERMISSION_DENIED',
    });
    expect(fixture.catalogReads).toBe(0);
  });

  test('metadata AAD rejects another tenant and row for the sealed resolved credential', async () => {
    const cryptoService = metadataCrypto();
    const refId = randomUUID();
    const sealed = await cryptoService.seal(
      { marker: 'private-test-value' },
      { tenantId: TENANT, slot: 'connector_secret_imports.resolved_payload', refId },
    );
    await expect(cryptoService.open(sealed, {
      tenantId: '3b2bbf03-d716-49f6-93c1-8fb75d8eb2d1',
      slot: 'connector_secret_imports.resolved_payload',
      refId: randomUUID(),
    })).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });
  });

  test('does not persist or return a Connector response that echoes the write-only value', async () => {
    const fixture = fakeDb();
    const echoed = result();
    echoed.revision.credentialRef = SECRET;
    const service = createConnectorSecretImportService({
      db: fixture.db, audit: audit(), metadataCrypto: metadataCrypto(), catalogKeyring: keyring(), backupSnapshotWriteGate: allowSnapshotWrites(),
      connector: {
        claimRecipeDraft: async (input: { expectedHeadRevision: number }) => ({ claimed: true, expectedHeadRevision: input.expectedHeadRevision }),
        upsertResolvedRecipeDraft: jest.fn().mockResolvedValue(echoed),
      },
    });

    await expect(service.importCredential(CONNECTOR_ID, request(), actor)).rejects.toMatchObject({ status: 503 });
    expect(fixture.row?.state).toBe('PENDING');
    expect(fixture.row?.result).toBeNull();
  });
});
