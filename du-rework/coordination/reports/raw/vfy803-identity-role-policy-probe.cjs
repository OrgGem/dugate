const assert = require('node:assert/strict');
const { createAdminLocalUserRepository } = require('../../../services/orchestrator/dist/modules/auth/admin-local/repository.js');
const { hashLocalPassword } = require('../../../services/orchestrator/dist/modules/auth/admin-local/password.js');
const { createAuditService } = require('../../../services/orchestrator/dist/modules/audit/audit.js');

const TENANT = 'c1aec1ae-1111-4111-8111-c1aec1aec1ae';
const USER_IDS = [
  'e3cfc3cf-3333-4333-8333-e3cfc3cfe3cf',
  'f4dfc4df-4444-4444-8444-f4dfc4df4444',
];

async function main() {
  const statements = [];
  let transactionCalls = 0;
  let nextUser = 0;
  const query = async (sql, params = []) => {
    const text = String(sql);
    statements.push({ sql: text, params: [...params] });
    if (/INSERT INTO admin_local_users/.test(text)) {
      return {
        rows: [{
          id: USER_IDS[nextUser++], tenant_id: params[0], username_normalized: params[1], role: params[3],
          is_enabled: true, is_locked: false, created_at: new Date('2026-10-05T00:00:00.000Z'),
          updated_at: new Date('2026-10-05T00:00:00.000Z'), version: 1,
        }],
        rowCount: 1,
      };
    }
    if (/INSERT INTO admin_audit_events/.test(text)) return { rows: [{ id: 'audit-fixture' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const client = { query };
  const db = {
    pool: undefined,
    query,
    tx: async (callback) => { transactionCalls += 1; return callback(client); },
    close: async () => undefined,
  };
  const repository = createAdminLocalUserRepository(db, createAuditService(db));
  const passwordHash = await hashLocalPassword('vfy803-probe-password-only');
  const input = (role) => ({ tenantId: TENANT, username: 'role.probe.user', passwordHash, actor: 'vfy803-probe', role });

  await assert.rejects(
    repository.createUser(input('ADMIN'), { callerRole: 'UNTRUSTED' }),
    (error) => error?.code === 'INVALID_CALLER_ROLE',
  );
  assert.equal(statements.length, 0, 'invalid caller role must cause zero DB/audit queries');
  assert.equal(transactionCalls, 0, 'invalid caller role must be rejected before opening a DB transaction');

  for (const [requested, stored] of [['USER', 'operator'], ['VIEWER', 'viewer']]) {
    const before = statements.length;
    const created = await repository.createUser(input(requested), { callerRole: 'ADMIN' });
    assert.equal(created.role, stored);
    const effects = statements.slice(before);
    const insert = effects.find((item) => /INSERT INTO admin_local_users/.test(item.sql));
    const audit = effects.find((item) => /INSERT INTO admin_audit_events/.test(item.sql));
    assert.ok(insert);
    assert.match(insert.sql, /VALUES\s*\(\$1,\s*\$2,\s*\$3,\s*\$4\)/i);
    assert.equal(insert.params[3], stored);
    assert.equal(/'operator'|'viewer'/i.test(insert.sql), false, 'role literal must not be interpolated into SQL');
    assert.ok(audit, 'successful creation must record an audit row in the transaction');
  }

  console.log('IDENTITY_ROLE_POLICY_PROBE=PASS');
  console.log('invalid_caller=INVALID_CALLER_ROLE; queries=0; transaction_calls=0');
  console.log('ADMIN_assignments=USER(operator),VIEWER(viewer); role_bound_at=$4; audit_rows=2');
}

main().catch((error) => {
  console.error('IDENTITY_ROLE_POLICY_PROBE=FAIL', error?.stack ?? String(error));
  process.exitCode = 1;
});
