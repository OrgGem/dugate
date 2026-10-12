import { randomUUID } from 'node:crypto';
import type { Db } from '../src/db/db';
import {
  listSecretsFromDb,
  parseSecretCatalogListQuery,
  type SecretCatalogRow,
} from '../src/modules/secrets/secret-catalog-store';

const TENANT_ID = '123e4567-e89b-42d3-a456-426614174000';
const CURSOR_SECRET = 'catalog-list-cursor-test-secret-32-bytes';

function row(overrides: Partial<SecretCatalogRow> = {}): SecretCatalogRow {
  const createdAt = new Date('2026-10-11T12:00:00.000Z');
  return {
    secret_id: randomUUID(),
    tenant_id: TENANT_ID,
    name: 'Primary Storage Credential',
    purpose: 'storage.credential',
    services: ['orchestrator'],
    provider_kind: 'managed_value',
    provider_config: {},
    state: 'ACTIVE',
    revision: 1,
    encrypted_value: { v: 1, alg: 'aes-256-gcm', iv: 'a', tag: 'b', ct: 'c' },
    rotated_at: null,
    rotation_interval_days: null,
    disabled_reason: null,
    created_at: createdAt,
    updated_at: createdAt,
    created_at_cursor: '2026-10-11T12:00:00.000000Z',
    ...overrides,
  };
}

describe('ORV14 Secret Catalog bounded search and keyset paging', () => {
  test('normalizes q and rejects repeated, oversized, or control-character filters', () => {
    expect(parseSecretCatalogListQuery(new URLSearchParams(
      `tenantId=${TENANT_ID}&limit=20&q=%20Storage%20Credential%20&state=ACTIVE`,
    ))).toMatchObject({ tenantId: TENANT_ID, limit: 20, q: 'storage credential', state: 'ACTIVE' });
    expect(() => parseSecretCatalogListQuery(new URLSearchParams('q=a&q=b'))).toThrow(/q must not be repeated/);
    expect(() => parseSecretCatalogListQuery(new URLSearchParams(`q=${'x'.repeat(129)}`))).toThrow(/q must be at most/);
    expect(() => parseSecretCatalogListQuery(new URLSearchParams('q=%00'))).toThrow(/safe characters/);
    expect(() => parseSecretCatalogListQuery(new URLSearchParams('limit=201'))).toThrow(/limit must be/);
    expect(parseSecretCatalogListQuery(new URLSearchParams('service=connector')).service).toBe('connector');
    expect(() => parseSecretCatalogListQuery(new URLSearchParams('service=worker'))).toThrow(/service is not a supported/);
  });

  test('service selection is an exact metadata predicate and part of the signed cursor scope', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const rows = [row({ services: ['connector'] }), row({ services: ['connector'] })];
    const db = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
      },
    } as unknown as Db;
    const firstQuery = parseSecretCatalogListQuery(new URLSearchParams(
      `tenantId=${TENANT_ID}&limit=1&purpose=connector.credential&service=connector`,
    ));
    const first = await listSecretsFromDb(db, firstQuery, CURSOR_SECRET);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(calls[0]?.sql).toContain('services @> ARRAY[$3]::text[]');
    expect(calls[0]?.params).toEqual([TENANT_ID, 'connector.credential', 'connector', 2]);

    const changedService = parseSecretCatalogListQuery(new URLSearchParams(
      `tenantId=${TENANT_ID}&limit=1&purpose=connector.credential&service=orchestrator&cursor=${encodeURIComponent(first.nextCursor!)}`,
    ));
    await expect(listSecretsFromDb(db, changedService, CURSOR_SECRET)).rejects.toThrow(/cursor is invalid/);
    expect(calls).toHaveLength(1);
  });

  test('binds tenant, metadata search, filters, and cursor boundary in SQL parameters', async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const rows = [row(), row(), row()];
    const db = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
      },
    } as unknown as Db;
    const query = parseSecretCatalogListQuery(new URLSearchParams(
      `tenantId=${TENANT_ID}&limit=2&state=ACTIVE&purpose=storage.credential&q=credential`,
    ));
    const first = await listSecretsFromDb(db, query, CURSOR_SECRET);

    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(calls[0]?.sql).toContain('strpos(lower(name), $4::text) > 0');
    expect(calls[0]?.sql).toContain('ORDER BY created_at DESC, secret_id DESC');
    expect(calls[0]?.params).toEqual([TENANT_ID, 'ACTIVE', 'storage.credential', 'credential', 3]);
    expect(JSON.stringify(first)).not.toContain('encrypted_value');

    calls.length = 0;
    const nextQuery = parseSecretCatalogListQuery(new URLSearchParams(
      `tenantId=${TENANT_ID}&limit=2&state=ACTIVE&purpose=storage.credential&q=credential&cursor=${encodeURIComponent(first.nextCursor!)}`,
    ));
    const second = await listSecretsFromDb(db, nextQuery, CURSOR_SECRET);
    expect(second.items).toHaveLength(2);
    expect(calls[0]?.sql).toContain('(created_at, secret_id) < ($5::timestamptz, $6::uuid)');
    expect(calls[0]?.params.slice(0, 4)).toEqual([TENANT_ID, 'ACTIVE', 'storage.credential', 'credential']);
    expect(calls[0]?.params.slice(-3)).toEqual([
      '2026-10-11T12:00:00.000000Z',
      rows[1]?.secret_id,
      3,
    ]);
  });

  test('rejects a cursor replayed with another tenant or search filter before querying', async () => {
    const rows = [row(), row()];
    const db = {
      query: jest.fn(async () => ({ rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] })),
    } as unknown as Db;
    const firstQuery = parseSecretCatalogListQuery(new URLSearchParams(`tenantId=${TENANT_ID}&limit=1&q=storage`));
    const first = await listSecretsFromDb(db, firstQuery, CURSOR_SECRET);
    expect(first.nextCursor).not.toBeNull();

    const changedFilter = parseSecretCatalogListQuery(new URLSearchParams(
      `tenantId=${TENANT_ID}&limit=1&q=other&cursor=${encodeURIComponent(first.nextCursor!)}`,
    ));
    await expect(listSecretsFromDb(db, changedFilter, CURSOR_SECRET)).rejects.toThrow(/cursor is invalid/);
    const foreignTenant = parseSecretCatalogListQuery(new URLSearchParams(
      `tenantId=123e4567-e89b-42d3-a456-426614174001&limit=1&q=storage&cursor=${encodeURIComponent(first.nextCursor!)}`,
    ));
    await expect(listSecretsFromDb(db, foreignTenant, CURSOR_SECRET)).rejects.toThrow(/cursor is invalid/);
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
