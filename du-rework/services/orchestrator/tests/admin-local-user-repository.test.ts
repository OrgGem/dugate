import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { createAuditService } from '../src/modules/audit/audit';
import {
  createAdminLocalUserRepository,
  normalizeLocalUsername,
} from '../src/modules/auth/admin-local/repository';
import { hashLocalPassword, isLocalPasswordHash } from '../src/modules/auth/admin-local/password';

const TENANT_A = 'c1aec1ae-1111-4111-8111-c1aec1aec1ae';
const TENANT_B = 'd2bed2be-2222-4222-8222-d2bed2bed2be';
const USER_ID = 'e3cfc3cf-3333-4333-8333-e3cfc3cfe3cf';

interface Statement {
  sql: string;
  params: unknown[];
  via: 'pool' | 'tx';
}

interface FakeDbOptions {
  failAudit?: boolean;
  initialPasswordHash?: string;
}

function makeFakeDb(options: FakeDbOptions = {}) {
  const attempted: Statement[] = [];
  const committed: Statement[] = [];
  const staged: Statement[] = [];
  let row = {
    id: USER_ID,
    tenant_id: TENANT_A,
    username_normalized: 'admin.one',
    role: 'admin',
    is_enabled: true,
    is_locked: false,
    created_at: new Date('2026-10-01T00:00:00.000Z'),
    updated_at: new Date('2026-10-01T00:00:00.000Z'),
    version: 1,
  };
  let storedPasswordHash = options.initialPasswordHash ?? null;

  const query = async <T extends QueryResultRow>(
    via: 'pool' | 'tx',
    sql: string,
    params: unknown[] = []
  ): Promise<QueryResult<T>> => {
    const statement = { sql, params, via };
    attempted.push(statement);
    if (via === 'tx') staged.push(statement);
    else committed.push(statement);
    if (options.failAudit && /INSERT INTO admin_audit_events/.test(sql)) {
      throw new Error('injected audit failure');
    }

    let rows: Record<string, unknown>[] = [];
    if (/INSERT INTO admin_local_users/.test(sql)) {
      if (params[0] === TENANT_A) {
        storedPasswordHash = String(params[2]);
        rows = [row];
      }
    } else if (/INSERT INTO admin_audit_events/.test(sql)) {
      rows = [{ id: 'audit-row-1' }];
    } else if (/UPDATE admin_local_users/.test(sql) && /SET is_enabled = false/.test(sql)) {
      if (params[0] === TENANT_A && params[1] === USER_ID) {
        row = { ...row, is_enabled: false, version: row.version + 1 };
        rows = [row];
      }
    } else if (/UPDATE admin_local_users/.test(sql) && /SET password_hash = \$1/.test(sql)) {
      if (params[1] === TENANT_A && params[2] === USER_ID) {
        storedPasswordHash = String(params[0]);
        row = { ...row, version: row.version + 1 };
        rows = [row];
      }
    } else if (/UPDATE admin_local_users/.test(sql)) {
      if (params[2] === TENANT_A && params[3] === USER_ID) {
        row = {
          ...row,
          is_enabled: Boolean(params[0]),
          is_locked: Boolean(params[1]),
          version: row.version + 1,
        };
        rows = [row];
      }
    } else if (/SELECT .*FROM admin_local_users/s.test(sql)) {
      if (params[0] === TENANT_A && params[1] === USER_ID) rows = [row];
    }
    return { rows, rowCount: rows.length } as unknown as QueryResult<T>;
  };

  const client = {
    query: <T extends QueryResultRow>(sql: string, params?: unknown[]) => query<T>('tx', sql, params),
  } as unknown as PoolClient;
  const db = {
    pool: undefined as unknown as Pool,
    query: <T extends QueryResultRow>(sql: string, params?: unknown[]) => query<T>('pool', sql, params),
    tx: async <T>(work: (txClient: PoolClient) => Promise<T>): Promise<T> => {
      try {
        const result = await work(client);
        committed.push(...staged.splice(0));
        return result;
      } catch (error) {
        staged.splice(0);
        throw error;
      }
    },
    close: async () => undefined,
  } as Db;

  return {
    db,
    attempted,
    committed,
    storedPasswordHash: () => storedPasswordHash,
    setStoredPasswordHash: (value: string) => { storedPasswordHash = value; },
  };
}

describe('admin local user repository', () => {
  it('normalizes usernames before tenant-scoped unique storage', () => {
    expect(normalizeLocalUsername('  Admin.One  ')).toBe('admin.one');
    expect(() => normalizeLocalUsername('contains space')).toThrow('username is invalid');
  });

  it('hashes bootstrap password material with a random, self-describing scrypt encoding', async () => {
    const first = await hashLocalPassword('bootstrap-secret-1');
    const second = await hashLocalPassword('bootstrap-secret-1');
    expect(first).not.toBe('bootstrap-secret-1');
    expect(first).not.toBe(second);
    expect(isLocalPasswordHash(first)).toBe(true);
    expect(first).toMatch(/^scrypt\$32768\$8\$1\$/);
    await expect(hashLocalPassword('')).rejects.toThrow();
  });

  it('fails closed on a missing tenant before making a database query', async () => {
    const f = makeFakeDb();
    const repository = createAdminLocalUserRepository(f.db, createAuditService(f.db));
    await expect(repository.findById('', USER_ID)).rejects.toThrow('tenant scope is required');
    await expect(
      repository.setStatus({
        tenantId: '',
        userId: USER_ID,
        enabled: false,
        locked: false,
        actor: 'test-actor',
      })
    ).rejects.toThrow('tenant scope is required');
    await expect(repository.disableAdmin({ tenantId: '', userId: USER_ID, actor: 'test-actor' }))
      .rejects.toThrow('tenant scope is required');
    const passwordHash = await hashLocalPassword('bootstrap-secret-missing-tenant');
    await expect(repository.resetPassword({
      tenantId: '', userId: USER_ID, passwordHash, actor: 'test-actor',
    })).rejects.toThrow('tenant scope is required');
    await expect(repository.rotateCredentials({
      tenantId: '', userId: USER_ID, passwordHash, actor: 'test-actor',
    })).rejects.toThrow('tenant scope is required');
    expect(f.attempted).toEqual([]);
  });

  it('writes the user and its tenant-scoped audit row in one transaction without returning the hash', async () => {
    const f = makeFakeDb();
    const repository = createAdminLocalUserRepository(f.db, createAuditService(f.db));
    const passwordHash = await hashLocalPassword('bootstrap-secret-2');
    const user = await repository.createAdmin({
      tenantId: TENANT_A,
      username: ' Admin.One ',
      passwordHash,
      actor: 'admin-local-user-cli',
    });

    expect(user).toMatchObject({ id: USER_ID, tenantId: TENANT_A, username: 'admin.one', role: 'admin' });
    expect(user).not.toHaveProperty('passwordHash');
    expect(user).not.toHaveProperty('password_hash');
    const insert = f.committed.find((statement) => /INSERT INTO admin_local_users/.test(statement.sql));
    const audit = f.committed.find((statement) => /INSERT INTO admin_audit_events/.test(statement.sql));
    expect(insert?.via).toBe('tx');
    expect(insert?.params).toEqual([TENANT_A, 'admin.one', passwordHash]);
    expect(insert?.sql).not.toMatch(/RETURNING[^;]*password_hash/i);
    expect(audit?.via).toBe('tx');
    expect(audit?.params).toEqual([
      TENANT_A,
      'admin-local-user-cli',
      'admin_local_user.create',
      `admin_local_user:${USER_ID}`,
      'success',
      null,
    ]);
  });

  it('binds reads and status writes to both tenant and immutable user id', async () => {
    const f = makeFakeDb();
    const repository = createAdminLocalUserRepository(f.db, createAuditService(f.db));
    await expect(repository.findById(TENANT_B, USER_ID)).resolves.toBeNull();
    await expect(repository.setStatus({
      tenantId: TENANT_B,
      userId: USER_ID,
      enabled: false,
      locked: true,
      actor: 'test-actor',
    })).resolves.toBeNull();
    await expect(repository.setStatus({
      tenantId: TENANT_A,
      userId: USER_ID,
      enabled: false,
      locked: true,
      actor: 'test-actor',
    })).resolves.toMatchObject({ tenantId: TENANT_A, enabled: false, locked: true, version: 2 });

    const read = f.attempted.find((statement) => /SELECT .*FROM admin_local_users/s.test(statement.sql));
    const update = f.attempted.find((statement) => /UPDATE admin_local_users/.test(statement.sql));
    expect(read?.sql).toMatch(/WHERE tenant_id = \$1 AND id = \$2/);
    expect(read?.params).toEqual([TENANT_B, USER_ID]);
    expect(update?.sql).toMatch(/WHERE tenant_id = \$3 AND id = \$4/);
    expect(update?.params).toEqual([false, true, TENANT_B, USER_ID]);
    const auditRows = f.committed.filter((statement) => /INSERT INTO admin_audit_events/.test(statement.sql));
    expect(auditRows).toHaveLength(1); // same-tenant status change only; cross-tenant misses do not audit
    expect(auditRows[0]?.params[0]).toBe(TENANT_A);
  });

  it('rolls back a created identity if its required audit row cannot be written', async () => {
    const f = makeFakeDb({ failAudit: true });
    const repository = createAdminLocalUserRepository(f.db, createAuditService(f.db));
    const passwordHash = await hashLocalPassword('bootstrap-secret-3');
    await expect(
      repository.createAdmin({ tenantId: TENANT_A, username: 'admin.one', passwordHash, actor: 'test-actor' })
    ).rejects.toThrow('injected audit failure');
    expect(f.attempted.some((statement) => /INSERT INTO admin_local_users/.test(statement.sql))).toBe(true);
    expect(f.attempted.some((statement) => /INSERT INTO admin_audit_events/.test(statement.sql))).toBe(true);
    expect(f.committed).toEqual([]);
  });

  it('disables an account and exposes it as ineligible for a future verifier', async () => {
    const f = makeFakeDb();
    const repository = createAdminLocalUserRepository(f.db, createAuditService(f.db));
    const disabled = await repository.disableAdmin({ tenantId: TENANT_A, userId: USER_ID, actor: 'test-actor' });
    expect(disabled).toMatchObject({ enabled: false, version: 2 });
    await expect(repository.findById(TENANT_A, USER_ID)).resolves.toMatchObject({ enabled: false });
    const update = f.attempted.find((statement) => /SET is_enabled = false/.test(statement.sql));
    expect(update?.sql).toMatch(/WHERE tenant_id = \$1 AND id = \$2/);
    expect(update?.params).toEqual([TENANT_A, USER_ID]);
    expect(f.committed.some((statement) => statement.params[2] === 'admin_local_user.disable')).toBe(true);
  });

  it('reset replaces the verifier and advances the account version without returning hash material', async () => {
    const oldHash = await hashLocalPassword('old-reset-verifier');
    const newHash = await hashLocalPassword('new-reset-verifier');
    const f = makeFakeDb({ initialPasswordHash: oldHash });
    const repository = createAdminLocalUserRepository(f.db, createAuditService(f.db));
    const updated = await repository.resetPassword({
      tenantId: TENANT_A, userId: USER_ID, passwordHash: newHash, actor: 'test-actor',
    });
    expect(f.storedPasswordHash()).toBe(newHash);
    expect(f.storedPasswordHash()).not.toBe(oldHash);
    expect(updated).toMatchObject({ version: 2 });
    expect(updated).not.toHaveProperty('passwordHash');
    const statement = f.attempted.find((item) => /SET password_hash = \$1/.test(item.sql));
    expect(statement?.params).toEqual([newHash, TENANT_A, USER_ID]);
    expect(statement?.sql).toMatch(/version = version \+ 1/);
  });

  it('credential rotation replaces old material, bumps version, and records a distinct audit action', async () => {
    const oldHash = await hashLocalPassword('old-rotated-verifier');
    const rotatedHash = await hashLocalPassword('new-rotated-verifier');
    const f = makeFakeDb({ initialPasswordHash: oldHash });
    const repository = createAdminLocalUserRepository(f.db, createAuditService(f.db));
    const updated = await repository.rotateCredentials({
      tenantId: TENANT_A, userId: USER_ID, passwordHash: rotatedHash, actor: 'test-actor',
    });
    expect(f.storedPasswordHash()).toBe(rotatedHash);
    expect(f.storedPasswordHash()).not.toBe(oldHash);
    expect(updated).toMatchObject({ version: 2 });
    const statement = f.attempted.find((item) => /SET password_hash = \$1/.test(item.sql));
    expect(statement?.params).toEqual([rotatedHash, TENANT_A, USER_ID]);
    expect(f.committed.some((item) => item.params[2] === 'admin_local_user.credentials_rotated')).toBe(true);
  });

  it('fails closed for an unknown tenant or user on create, disable, reset, and rotation', async () => {
    const f = makeFakeDb();
    const repository = createAdminLocalUserRepository(f.db, createAuditService(f.db));
    const passwordHash = await hashLocalPassword('bootstrap-secret-unknown-target');
    await expect(repository.createAdmin({
      tenantId: TENANT_B, username: 'admin.unknown', passwordHash, actor: 'test-actor',
    })).rejects.toThrow();

    for (const tenantId of [TENANT_B, TENANT_A]) {
      const userId = tenantId === TENANT_B ? USER_ID : 'f4d0f4d0-4444-4444-8444-f4d0f4d0f4d0';
      await expect(repository.disableAdmin({ tenantId, userId, actor: 'test-actor' })).resolves.toBeNull();
      await expect(repository.resetPassword({ tenantId, userId, passwordHash, actor: 'test-actor' }))
        .resolves.toBeNull();
      await expect(repository.rotateCredentials({ tenantId, userId, passwordHash, actor: 'test-actor' }))
        .resolves.toBeNull();
    }
    expect(f.committed.filter((statement) => /INSERT INTO admin_audit_events/.test(statement.sql))).toEqual([]);
  });
});
