import type { TenantActiveConnectorCatalogQuery } from '@du/contracts';
import { PostgresConnectorParityRepository } from '../src/db/parity-repository';
import type { InvocationFieldCrypto, SealedInvocationField } from '../src/db/invocation-crypto';
import type { SqlClient, SqlResult } from '../src/db/sql';

const RECIPE = {
  adapter: 'openai-compatible', method: 'POST', endpointUrl: 'https://provider.invalid/v1',
  auth: { kind: 'none' }, headers: [],
  request: { promptField: 'prompt', modelField: 'model', fields: [{ name: 'model', source: 'static', value: 'model-a' }] },
  response: { contentPath: 'choices.0.message.content' }, session: { capture: [], inject: [] },
  timeoutMs: 10_000, responseBytes: 64_000,
} as const;

const SEALED: SealedInvocationField = {
  version: 1, algorithm: 'aes-256-gcm', keyRef: 'test-key',
  dek: { version: 1, keyName: 'test-key', keyVersion: 1, wrappedKey: 'wrapped' },
  nonce: 'nonce', tag: 'tag', aad: 'aad', ciphertext: 'ciphertext', plaintextSha256: 'a'.repeat(64),
};

function revision(tenantId: string, connectorId: string, revisionNumber: number) {
  return {
    tenant_id: tenantId, connector_id: connectorId, revision: revisionNumber, state: 'ACTIVE',
    recipe_envelope: SEALED, credential_ref: null, credential_version: null, credential_source: null,
    created_at: '2026-10-11T12:00:00.000Z', updated_at: '2026-10-11T12:10:00.000Z',
  };
}

class CatalogDb implements SqlClient {
  public readonly sql: string[] = [];
  private key: Buffer | undefined;
  public readonly revisions = [
    revision('11111111-1111-4111-8111-111111111111', 'connector-a', 1),
    revision('11111111-1111-4111-8111-111111111111', 'connector-b', 2),
    revision('22222222-2222-4222-8222-222222222222', 'connector-secret-tenant', 1),
  ];

  public async query<Row extends object = Record<string, unknown>>(text: string, parameters: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.sql.push(text);
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

  public async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> { return callback(this); }
}

function createRepository(db: CatalogDb): PostgresConnectorParityRepository {
  const crypto: InvocationFieldCrypto = {
    seal: async () => SEALED,
    open: async () => RECIPE,
    isSealed: (value): value is SealedInvocationField => Boolean(value),
  };
  return new PostgresConnectorParityRepository(db, crypto);
}

describe('ORV14 tenant Connector catalog producer', () => {
  it('returns only safe ACTIVE metadata scoped to the requested tenant and signs a bound cursor', async () => {
    const db = new CatalogDb();
    const repository = createRepository(db);
    const query: TenantActiveConnectorCatalogQuery = {
      tenantId: '11111111-1111-4111-8111-111111111111', limit: 1,
    };

    const first = await repository.listActiveRevisions(query);
    expect(first.items).toEqual([{
      tenantId: query.tenantId, connectorId: 'connector-a', revision: 1,
      adapter: 'openai-compatible', provider: 'openai-compatible', model: 'model-a',
      credentialConfigured: false, updatedAt: '2026-10-11T12:10:00.000Z',
    }]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(first)).not.toContain('credential_ref');

    const second = await repository.listActiveRevisions({ ...query, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.connectorId)).toEqual(['connector-b']);
    expect(second.nextCursor).toBeNull();
    expect(db.sql.some((sql) => sql.includes("state='ACTIVE'") && sql.includes('tenant_id=$1'))).toBe(true);
  });

  it('rejects cursor tampering and query, tenant or limit rebinding', async () => {
    const db = new CatalogDb();
    const repository = createRepository(db);
    const base: TenantActiveConnectorCatalogQuery = {
      tenantId: '11111111-1111-4111-8111-111111111111', limit: 1,
    };
    const first = await repository.listActiveRevisions(base);
    expect(first.nextCursor).not.toBeNull();
    await expect(repository.listActiveRevisions({ ...base, cursor: `${first.nextCursor}x` })).rejects.toThrow('cursor');
    await expect(repository.listActiveRevisions({ ...base, q: 'different', cursor: first.nextCursor! })).rejects.toThrow('different query');
    await expect(repository.listActiveRevisions({ ...base, limit: 2, cursor: first.nextCursor! })).rejects.toThrow('different query');
    await expect(repository.listActiveRevisions({ ...base, tenantId: '22222222-2222-4222-8222-222222222222', cursor: first.nextCursor! }))
      .rejects.toThrow('different query');
  });
});
