import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { createAuditService } from '../src/modules/audit/audit';
import {
  createAdminLocalUserRepository,
  type AdminLocalUserIdentityRole,
} from '../src/modules/auth/admin-local/repository';
import { hashLocalPassword, type LocalPasswordHash } from '../src/modules/auth/admin-local/password';

const TENANT_ID = 'c1aec1ae-1111-4111-8111-c1aec1aec1ae';
const USER_ID = 'e3cfc3cf-3333-4333-8333-e3cfc3cfe3cf';

interface Statement {
  sql: string;
  params: unknown[];
}

function makeFakeDb() {
  const statements: Statement[] = [];

  const query = async <T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> => {
    statements.push({ sql, params });
    let rows: Record<string, unknown>[] = [];
    if (/INSERT INTO admin_local_users/.test(sql)) {
      rows = [
        {
          id: USER_ID,
          tenant_id: params[0],
          username_normalized: params[1],
          role: params[3],
          is_enabled: true,
          is_locked: false,
          created_at: new Date('2026-10-05T00:00:00.000Z'),
          updated_at: new Date('2026-10-05T00:00:00.000Z'),
          version: 1,
        },
      ];
    } else if (/INSERT INTO admin_audit_events/.test(sql)) {
      rows = [{ id: 'audit-row-1' }];
    }
    return { rows, rowCount: rows.length } as unknown as QueryResult<T>;
  };

  const client = {
    query: <T extends QueryResultRow>(sql: string, params?: unknown[]) => query<T>(sql, params),
  } as unknown as PoolClient;
  const db = {
    pool: undefined as unknown as Pool,
    query: <T extends QueryResultRow>(sql: string, params?: unknown[]) => query<T>(sql, params),
    tx: async <T>(work: (txClient: PoolClient) => Promise<T>): Promise<T> => work(client),
    close: async () => undefined,
  } as Db;

  return { db, statements };
}

describe('admin local user role policy', () => {
  let passwordHash: LocalPasswordHash | undefined;

  beforeAll(async () => {
    passwordHash = await hashLocalPassword('role-policy-offline-test-password');
  });

  function getPasswordHash(): LocalPasswordHash {
    if (!passwordHash) throw new Error('test password hash was not initialized');
    return passwordHash;
  }

  function makeInput(role: unknown) {
    return {
      tenantId: TENANT_ID,
      username: 'role.policy.user',
      passwordHash: getPasswordHash(),
      actor: 'identity-role-policy-test',
      role,
    };
  }

  it('allows an ADMIN caller to create an ADMIN and stores the internal admin role', async () => {
    const f = makeFakeDb();
    const repository = createAdminLocalUserRepository(f.db, createAuditService(f.db));

    const user = await repository.createUser(makeInput('ADMIN'), { callerRole: 'ADMIN' });

    expect(user).toMatchObject({ id: USER_ID, tenantId: TENANT_ID, username: 'role.policy.user', role: 'admin' });
    expect(f.statements.filter((statement) => /INSERT INTO admin_local_users/.test(statement.sql))[0]?.params)
      .toEqual([TENANT_ID, 'role.policy.user', getPasswordHash(), 'admin']);
    expect(f.statements.filter((statement) => /INSERT INTO admin_audit_events/.test(statement.sql))).toHaveLength(1);
  });

  it.each(['USER', 'VIEWER'] as const)(
    'rejects ADMIN creation by a %s caller before database or audit effects',
    async (callerRole) => {
      const f = makeFakeDb();
      const repository = createAdminLocalUserRepository(f.db, createAuditService(f.db));

      await expect(repository.createUser(makeInput('ADMIN'), { callerRole })).rejects.toMatchObject({
        name: 'AdminLocalUserRolePolicyError',
        code: 'ROLE_ESCALATION_DENIED',
      });
      expect(f.statements).toEqual([]);
    }
  );

  it('rejects a role outside the request allowlist before database or audit effects', async () => {
    const f = makeFakeDb();
    const repository = createAdminLocalUserRepository(f.db, createAuditService(f.db));

    await expect(repository.createUser(makeInput('SUPERUSER'), { callerRole: 'ADMIN' })).rejects.toMatchObject({
      name: 'AdminLocalUserRolePolicyError',
      code: 'INVALID_ROLE',
    });
    expect(f.statements).toEqual([]);
  });

  it('maps USER to operator and prevents VIEWER from assigning USER', async () => {
    const f = makeFakeDb();
    const repository = createAdminLocalUserRepository(f.db, createAuditService(f.db));

    const user = await repository.createUser(makeInput('USER'), { callerRole: 'USER' });
    expect(user.role).toBe('operator');
    expect(f.statements.find((statement) => /INSERT INTO admin_local_users/.test(statement.sql))?.params[3])
      .toBe('operator');

    const beforeDeniedCreate = f.statements.length;
    await expect(repository.createUser(makeInput('USER'), { callerRole: 'VIEWER' })).rejects.toMatchObject({
      code: 'ROLE_ESCALATION_DENIED',
    });
    expect(f.statements).toHaveLength(beforeDeniedCreate);
  });
});
