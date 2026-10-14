import type { SqlClient, SqlResult } from '../src/db/sql';
import { PostgresConnectorParityRepository } from '../src/db/parity-repository';
import type { InvocationFieldCrypto, SealedInvocationField } from '../src/db/invocation-crypto';
import { createConnectorServer } from '../src/http/server';

const TENANT = '00000000-0000-0000-0000-000000000001';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const CASED_TENANT = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const SECRET_URL = 'https://private-provider.example/api?token=secret-value';
const SECRET_HEADER = 'header-secret-value';
const SECRET_CREDENTIAL = 'vault://tenant/private-token';

const RECIPE = {
  adapter: 'json-http',
  method: 'POST',
  endpointUrl: SECRET_URL,
  auth: { kind: 'none' },
  headers: [{ name: 'x-private', value: SECRET_HEADER }],
  request: { promptField: 'prompt', fields: [] },
  response: { contentPath: 'choices.0.message.content' },
  session: { capture: [], inject: [] },
  timeoutMs: 10_000,
  responseBytes: 65_536,
} as const;

const SEALED: SealedInvocationField = {
  version: 1,
  algorithm: 'aes-256-gcm',
  keyRef: 'test-key',
  dek: { version: 1, keyName: 'test-key', keyVersion: 1, wrappedKey: 'wrapped' },
  nonce: 'nonce',
  tag: 'tag',
  aad: 'aad',
  ciphertext: 'ciphertext',
  plaintextSha256: 'a'.repeat(64),
};

function revision(tenantId: string, connectorId: string, state: 'PENDING' | 'ACTIVE' | 'RETIRED', credentialRef: string | null = null) {
  return {
    tenant_id: tenantId,
    connector_id: connectorId,
    revision: 1,
    state,
    recipe_envelope: SEALED,
    credential_ref: credentialRef,
    credential_version: credentialRef === null ? null : 1,
    credential_source: null,
    created_at: '2026-10-14T12:00:00.000Z',
    updated_at: '2026-10-14T12:00:00.000Z',
  };
}

class CatalogDb implements SqlClient {
  public readonly sql: Array<{ text: string; parameters: readonly unknown[] }> = [];
  private key: Buffer | undefined;
  public readonly revisions = [
    revision(TENANT, 'codex-ui-check-20261014', 'PENDING', SECRET_CREDENTIAL),
    revision(TENANT, 'connector-active', 'ACTIVE'),
    revision(TENANT, 'connector-retired', 'RETIRED'),
    revision(OTHER_TENANT, 'cross-tenant-secret', 'PENDING', SECRET_CREDENTIAL),
    revision(CASED_TENANT, 'case-normalized-recipe', 'PENDING'),
  ];

  public async query<Row extends object = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> {
    this.sql.push({ text, parameters });
    if (text.includes('FROM connector_tenant_catalog_cursor_key')) {
      return { rows: this.key ? [{ key_bytes: this.key } as unknown as Row] : [] };
    }
    if (text.includes('FROM connector_backup_effect_gate')) {
      return { rows: [{ fence_id: null, fence_revision: 0, state: 'OPEN' } as unknown as Row] };
    }
    if (text.includes('INSERT INTO connector_tenant_catalog_cursor_key')) {
      this.key ??= Buffer.from(parameters[0] as Buffer);
      return { rows: [] };
    }
    if (text.includes('FROM connector_parity_revisions')) {
      const [tenantId, afterConnectorId, afterRevision, limit] = parameters;
      const rows = this.revisions.filter((row) => row.tenant_id === tenantId
        && (!afterConnectorId || row.connector_id > afterConnectorId
          || (row.connector_id === afterConnectorId && row.revision > Number(afterRevision))))
        .sort((left, right) => left.connector_id.localeCompare(right.connector_id) || left.revision - right.revision)
        .slice(0, Number(limit));
      return { rows: rows as unknown as Row[] };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  }

  public async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

function createRepository(db: CatalogDb): PostgresConnectorParityRepository {
  const crypto: InvocationFieldCrypto = {
    seal: async () => SEALED,
    open: async () => RECIPE,
    isSealed: (value): value is SealedInvocationField => Boolean(value),
  };
  return new PostgresConnectorParityRepository(db, crypto);
}

function identityVerifier(scopes = ['connector:management']) {
  return { verify: async () => ({ subject: 'typed-catalog-test', audience: 'connector', scopes }) };
}

async function withServer<T>(callback: (base: string) => Promise<T>, scopes?: string[]): Promise<T> {
  const catalog = {
    listConnectorRecipeCatalog: jest.fn(async () => ({
      tenantId: TENANT,
      items: [{
        tenantId: TENANT,
        connectorId: 'codex-ui-check-20261014',
        revision: 1,
        state: 'PENDING',
        adapter: 'json-http',
        authKind: 'none',
        credentialConfigured: true,
      }],
      limit: 25,
      nextCursor: null,
    })),
  };
  const server = createConnectorServer({
    management: {} as never,
    parityManagement: catalog as never,
    runtime: {} as never,
    capabilities: () => ({}),
    ready: async () => true,
    identityVerifier: identityVerifier(scopes),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Connector test server did not bind');
  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe('typed Connector recipe metadata inventory', () => {
  it('pages every persisted state within the requested tenant and returns no recipe or secret values', async () => {
    const db = new CatalogDb();
    const repository = createRepository(db);
    const first = await repository.listRecipeCatalog({ tenantId: TENANT, limit: 2 });

    expect(first.items.map((item) => [item.connectorId, item.state])).toEqual([
      ['codex-ui-check-20261014', 'PENDING'],
      ['connector-active', 'ACTIVE'],
    ]);
    expect(first.items[0]).toEqual({
      tenantId: TENANT,
      connectorId: 'codex-ui-check-20261014',
      revision: 1,
      state: 'PENDING',
      adapter: 'json-http',
      authKind: 'none',
      credentialConfigured: true,
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(first)).not.toContain(SECRET_URL);
    expect(JSON.stringify(first)).not.toContain(SECRET_HEADER);
    expect(JSON.stringify(first)).not.toContain(SECRET_CREDENTIAL);

    const second = await repository.listRecipeCatalog({ tenantId: TENANT, limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((item) => [item.connectorId, item.state])).toEqual([['connector-retired', 'RETIRED']]);
    expect(second.nextCursor).toBeNull();
    const revisionReads = db.sql.filter(({ text }) => text.includes('FROM connector_parity_revisions'));
    expect(revisionReads.every(({ text, parameters }) => text.includes('WHERE tenant_id=$1') && parameters[0] === TENANT)).toBe(true);
    expect(revisionReads.every(({ text }) => !text.includes("state='ACTIVE'"))).toBe(true);
  });

  it('rejects malformed cursors and cursors bound to another tenant, page size, query, or catalog domain', async () => {
    const repository = createRepository(new CatalogDb());
    const first = await repository.listRecipeCatalog({ tenantId: TENANT, limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    await expect(repository.listRecipeCatalog({ tenantId: TENANT, limit: 1, cursor: 'bad-cursor' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(repository.listRecipeCatalog({ tenantId: TENANT, limit: 2, cursor: first.nextCursor! })).rejects.toThrow('different query');
    await expect(repository.listRecipeCatalog({ tenantId: TENANT, limit: 1, q: 'other', cursor: first.nextCursor! })).rejects.toThrow('different query');
    await expect(repository.listRecipeCatalog({ tenantId: OTHER_TENANT, limit: 1, cursor: first.nextCursor! })).rejects.toThrow('different query');

    const active = await repository.listActiveRevisions({ tenantId: TENANT, limit: 1 });
    await expect(repository.listRecipeCatalog({ tenantId: TENANT, limit: 1, cursor: active.nextCursor! })).rejects.toThrow('different query');
  });

  it('normalizes uppercase tenant UUIDs before querying and projecting typed metadata', async () => {
    const db = new CatalogDb();
    const repository = createRepository(db);
    const page = await repository.listRecipeCatalog({ tenantId: CASED_TENANT.toUpperCase(), limit: 25 });
    expect(page.tenantId).toBe(CASED_TENANT);
    expect(page.items).toEqual([expect.objectContaining({ tenantId: CASED_TENANT, connectorId: 'case-normalized-recipe' })]);
    const read = db.sql.find(({ text }) => text.includes('FROM connector_parity_revisions'));
    expect(read?.parameters[0]).toBe(CASED_TENANT);
  });

  it('serves PENDING metadata only behind connector:management and rejects malformed query or connector IDs', async () => {
    await withServer(async (base) => {
      const response = await fetch(`${base}/internal/admin/connector-revisions/catalog?tenantId=${TENANT}&limit=25`, {
        headers: { authorization: 'Bearer test' },
      });
      expect(response.status).toBe(200);
      const payload = await response.json() as Record<string, unknown>;
      expect(JSON.stringify(payload)).toContain('PENDING');
      expect(JSON.stringify(payload)).not.toContain(SECRET_URL);
      expect(JSON.stringify(payload)).not.toContain(SECRET_HEADER);
      expect(JSON.stringify(payload)).not.toContain(SECRET_CREDENTIAL);

      const malformed = await fetch(`${base}/internal/admin/connector-revisions/catalog?tenantId=${TENANT}%0A`, {
        headers: { authorization: 'Bearer test' },
      });
      expect(malformed.status).toBe(400);

      const badId = await fetch(`${base}/internal/admin/connector-revisions/bad..id/1?tenantId=${TENANT}`, {
        headers: { authorization: 'Bearer test' },
      });
      expect(badId.status).toBe(400);
    });

    await withServer(async (base) => {
      const response = await fetch(`${base}/internal/admin/connector-revisions/catalog?tenantId=${TENANT}`, {
        headers: { authorization: 'Bearer test' },
      });
      expect(response.status).toBe(403);
    }, ['connector:invoke']);
  });
});
