'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const test = require('node:test');

const {
  LEGACY_TABLES,
  RowSkip,
  SKIP_POLICIES,
  runBackfill,
} = require('../scripts/ldba-03-backfill.cjs');

const API_KEY_ID = '10000000-0000-4000-8000-000000000001';
const CONNECTION_ID = '20000000-0000-4000-8000-000000000001';
const USER_ID = '30000000-0000-4000-8000-000000000001';

function tables(overrides = {}) {
  return Object.fromEntries(LEGACY_TABLES.map((table) => [table, overrides[table] || []]));
}

function connector(overrides = {}) {
  return {
    id: CONNECTION_ID,
    name: 'synthetic connector',
    slug: 'synthetic-connector',
    description: null,
    endpointUrl: 'https://connector.example.test/api',
    httpMethod: 'POST',
    authType: 'API_KEY_HEADER',
    authSecret: 'synthetic-source-secret',
    authKeyHeader: 'X-API-Key',
    promptFieldName: 'prompt',
    fileFieldName: null,
    fileUrlFieldName: null,
    defaultPrompt: null,
    staticFormFields: '{}',
    extraHeaders: '{}',
    responseContentPath: 'content',
    sessionIdResponsePath: null,
    sessionIdFieldName: null,
    timeoutSec: 30,
    state: 'ENABLED',
    createdAt: '2026-01-01 00:00:00.000000',
    updatedAt: '2026-01-01 00:00:00.000000',
    ...overrides,
  };
}

function override(overrides = {}) {
  return {
    id: '40000000-0000-4000-8000-000000000001',
    connectionId: CONNECTION_ID,
    apiKeyId: API_KEY_ID,
    endpointSlug: 'analyze',
    stepId: '_default',
    promptOverride: null,
    createdAt: '2026-01-01 00:00:00.000000',
    updatedAt: '2026-01-01 00:00:00.000000',
    ...overrides,
  };
}

function user(overrides = {}) {
  return {
    id: USER_ID,
    username: 'synthetic-user',
    password: '$2b$12$synthetic-bcrypt-verifier',
    role: 'USER',
    provider: null,
    providerSub: null,
    email: null,
    displayName: null,
    createdAt: '2026-01-01 00:00:00.000000',
    updatedAt: '2026-01-01 00:00:00.000000',
    ...overrides,
  };
}

function assignment(overrides = {}) {
  return {
    id: '50000000-0000-4000-8000-000000000001',
    userId: USER_ID,
    apiKeyId: API_KEY_ID,
    createdAt: '2026-01-01 00:00:00.000000',
    ...overrides,
  };
}

function createAdapter(sourceTables, context = {}) {
  const target = new Map();
  let validateCalls = 0;
  let applyCalls = 0;
  const tenantId = 'a0000000-0000-4000-8000-000000000001';
  const adapter = {
    a1Passed: true,
    sourceVersion: 'synthetic-test-v1',
    a1SourceVersion: 'synthetic-test-v1',
    source: {
      async scan(table) {
        return sourceTables[table] || [];
      },
    },
    sink: {
      async resolveTenantIdsByName(name) {
        assert.equal(name, 'legacy-default');
        return [tenantId];
      },
      async seedTenantByName() {
        throw new Error('test adapter already has a tenant');
      },
      async validatePlan() {
        validateCalls += 1;
        return [];
      },
      async inspectImmutable(item) {
        const prior = target.get(item.entity + '|' + item.key);
        if (prior === undefined) return 'new';
        return isDeepStrictEqual(prior, item.value) ? 'identical' : 'conflict';
      },
      async applyImmutableBatch(items) {
        applyCalls += 1;
        return items.map((item) => {
          const key = item.entity + '|' + item.key;
          const prior = target.get(key);
          if (prior !== undefined) {
            if (!isDeepStrictEqual(prior, item.value)) throw new Error('immutable conflict');
            return 'identical';
          }
          target.set(key, item.value);
          return 'inserted';
        });
      },
    },
    context,
  };
  return {
    adapter,
    target,
    getValidateCalls: () => validateCalls,
    getApplyCalls: () => applyCalls,
  };
}

async function run(sourceTables, context, options = {}) {
  const fixture = createAdapter(sourceTables, context);
  const report = await runBackfill(fixture.adapter, {
    apply: true,
    skipPolicy: 'report',
    ...options,
  });
  return { ...fixture, report };
}

test('exports the exact table-scoped skip allowlist and RowSkip marker', () => {
  assert.equal(typeof RowSkip, 'function');
  assert.deepEqual(Object.keys(SKIP_POLICIES), [
    'ExternalApiConnection',
    'ExternalApiOverride',
    'User',
    'UserProfileAssignment',
  ]);
  assert.deepEqual(SKIP_POLICIES, {
    ExternalApiConnection: ['CONNECTOR_ROW_OUT_OF_SCOPE'],
    ExternalApiOverride: [
      'OVERRIDE_CONNECTION_ID_NOT_UUID',
      'OVERRIDE_API_KEY_ID_NOT_UUID',
      'OVERRIDE_CONNECTOR_NOT_MIGRATED',
    ],
    User: ['IDENTITY_PENDING_REHASH'],
    UserProfileAssignment: [
      'ASSIGNMENT_USER_NOT_MIGRATED',
      'ASSIGNMENT_USER_ID_NOT_UUID',
      'ASSIGNMENT_API_KEY_ID_NOT_UUID',
    ],
  });
  assert.equal(SKIP_POLICIES.ExternalApiConnection.includes('CONTEXT_POLICY_REQUIRED'), false);
});

test('records an allowlisted adapter return skip and keeps the registry out of JSON', async () => {
  const result = await run(tables({ ExternalApiConnection: [connector()] }), {
    async prepareConnector() {
      return {
        skipped: true,
        code: 'CONNECTOR_ROW_OUT_OF_SCOPE',
        reason: 'synthetic unsupported connector policy',
      };
    },
  });

  assert.equal(result.report.status, 'APPLIED');
  assert.deepEqual(result.report.skips, [{
    table: 'ExternalApiConnection',
    sourceKey: CONNECTION_ID,
    field: 'authType',
    code: 'CONNECTOR_ROW_OUT_OF_SCOPE',
    reason: 'synthetic unsupported connector policy',
  }]);
  assert.equal(result.report.sourceRows.skipped, 1);
  assert.equal(result.report.perTable.ExternalApiConnection.skipped, 1);
  assert.equal(result.target.size, 0);
  assert.equal(JSON.stringify(result.report).includes('_skippedSourceKeys'), false);
});

test('accepts a RowSkip thrown by the adapter for an allowlisted row', async () => {
  const result = await run(tables({ ExternalApiConnection: [connector()] }), {
    async prepareConnector(row) {
      throw new RowSkip('ExternalApiConnection', row.id, 'authType', 'CONNECTOR_ROW_OUT_OF_SCOPE', 'synthetic row policy');
    },
  });

  assert.equal(result.report.status, 'APPLIED');
  assert.equal(result.report.skips[0].code, 'CONNECTOR_ROW_OUT_OF_SCOPE');
  assert.equal(result.report.skips[0].sourceKey, CONNECTION_ID);
});

test('rejects an unapproved adapter skip as UNAPPROVED_SKIP', async () => {
  const result = await run(tables({ ExternalApiConnection: [connector()] }), {
    async prepareConnector() {
      return { skipped: true, code: 'SILENTLY_IGNORE', reason: 'not allowlisted' };
    },
  });

  assert.equal(result.report.status, 'BLOCKED_TRANSFORM');
  assert.equal(result.report.skips.length, 0);
  assert.equal(result.report.failures[0].code, 'UNAPPROVED_SKIP');
  assert.match(result.report.failures[0].message, /SILENTLY_IGNORE/);
});

test('does not turn missing context configuration into a connector skip', async () => {
  const configurationError = Object.assign(new Error('context provider is absent'), { code: 'CONTEXT_POLICY_REQUIRED' });
  const result = await run(tables({ ExternalApiConnection: [connector()] }), {
    async prepareConnector() {
      throw configurationError;
    },
  });

  assert.equal(result.report.status, 'BLOCKED_TRANSFORM');
  assert.equal(result.report.skips.length, 0);
  assert.equal(result.report.failures[0].code, 'TRANSFORM_ERROR');
});

test('skips override text connection ids and invalid API key ids with exact codes', async () => {
  const result = await run(tables({
    ExternalApiOverride: [
      override({ id: '40000000-0000-4000-8000-000000000001', connectionId: 'legacy-connection' }),
      override({ id: '40000000-0000-4000-8000-000000000002', apiKeyId: 'legacy-api-key' }),
    ],
  }));

  assert.equal(result.report.status, 'APPLIED');
  assert.deepEqual(result.report.skips.map((item) => item.code), [
    'OVERRIDE_CONNECTION_ID_NOT_UUID',
    'OVERRIDE_API_KEY_ID_NOT_UUID',
  ]);
  assert.deepEqual(result.report.skips.map((item) => item.field), ['connectionId', 'apiKeyId']);
  assert.equal(result.report.sourceRows.skipped, 2);
  assert.equal(result.report.perTable.ExternalApiOverride.skipped, 2);
});

test('skips overrides that reference a connector skipped earlier in the same run', async () => {
  const skippedConnectionId = '20000000-0000-4000-8000-000000000002';
  const result = await run(tables({
    ExternalApiConnection: [connector({ id: skippedConnectionId })],
    ExternalApiOverride: [override({ connectionId: skippedConnectionId })],
  }), {
    async prepareConnector() {
      return {
        skipped: true,
        code: 'CONNECTOR_ROW_OUT_OF_SCOPE',
        reason: 'synthetic connector intentionally out of scope',
      };
    },
  });

  assert.equal(result.report.status, 'APPLIED');
  assert.deepEqual(result.report.skips.map((item) => item.code), [
    'CONNECTOR_ROW_OUT_OF_SCOPE',
    'OVERRIDE_CONNECTOR_NOT_MIGRATED',
  ]);
  assert.equal(result.report.skips[1].sourceKey, override({ connectionId: skippedConnectionId }).id);
});

test('pending-rehash users skip without writes and suppress assignments that reference them', async () => {
  const result = await run(tables({
    User: [user()],
    UserProfileAssignment: [assignment()],
  }), {
    prepareAdminLocalUser() {
      return { pending: true, reason: 'user must present plaintext at first login' };
    },
  });

  assert.equal(result.report.status, 'APPLIED');
  assert.deepEqual(result.report.skips.map((item) => item.code), [
    'IDENTITY_PENDING_REHASH',
    'ASSIGNMENT_USER_NOT_MIGRATED',
  ]);
  assert.equal(result.report.sourceRows.skipped, 2);
  assert.equal(result.report.perTable.User.skipped, 1);
  assert.equal(result.report.perTable.UserProfileAssignment.skipped, 1);
  assert.equal(result.target.has('admin_local_users|' + USER_ID), false);
  assert.equal(result.target.has('user_profile_assignments|' + USER_ID + '|' + API_KEY_ID), false);
});

test('supports the LDBA-08 PASSWORD_RESET_REQUIRED compatibility path', async () => {
  const result = await run(tables({ User: [user()] }), {
    prepareAdminLocalUser() {
      throw Object.assign(new Error('first login plaintext is required'), { code: 'PASSWORD_RESET_REQUIRED' });
    },
  });

  assert.equal(result.report.status, 'APPLIED');
  assert.equal(result.report.skips[0].code, 'IDENTITY_PENDING_REHASH');
  assert.equal(result.report.skips[0].reason, 'first login plaintext is required');
  assert.equal(result.target.size, 0);
});

test('fails malformed identity output and validates role before a pending skip', async () => {
  let contextCalls = 0;
  const malformed = await run(tables({ User: [user()] }), {
    prepareAdminLocalUser() {
      return { pending: true };
    },
  });
  assert.equal(malformed.report.status, 'BLOCKED_TRANSFORM');
  assert.equal(malformed.report.failures[0].code, 'INVALID_IDENTITY_ADAPTER_OUTPUT');
  assert.equal(malformed.report.skips.length, 0);

  const invalidRole = await run(tables({ User: [user({ role: 'OWNER' })] }), {
    prepareAdminLocalUser() {
      contextCalls += 1;
      return { pending: true, reason: 'must not hide invalid role' };
    },
  });
  assert.equal(invalidRole.report.status, 'BLOCKED_TRANSFORM');
  assert.equal(invalidRole.report.failures[0].code, 'UNKNOWN_VALUE');
  assert.equal(contextCalls, 0);
});

test('assignment invalid user and API key UUIDs become the scoped skip codes', async () => {
  const result = await run(tables({
    UserProfileAssignment: [
      assignment({ id: '50000000-0000-4000-8000-000000000002', userId: 'legacy-user' }),
      assignment({ id: '50000000-0000-4000-8000-000000000003', apiKeyId: 'legacy-key' }),
    ],
  }));

  assert.equal(result.report.status, 'APPLIED');
  assert.deepEqual(result.report.skips.map((item) => item.code), [
    'ASSIGNMENT_USER_ID_NOT_UUID',
    'ASSIGNMENT_API_KEY_ID_NOT_UUID',
  ]);
});

test('writes an assignment for a user already present in the fake target', async () => {
  const fixture = createAdapter(tables({ UserProfileAssignment: [assignment()] }));
  fixture.target.set('admin_local_users|' + USER_ID, { id: USER_ID });
  const report = await runBackfill(fixture.adapter, { apply: true, skipPolicy: 'report' });

  assert.equal(report.status, 'APPLIED');
  assert.deepEqual(report.skips, []);
  assert.equal(report.sourceRows.written, 1);
  assert.deepEqual(
    fixture.target.get('user_profile_assignments|' + USER_ID + '|' + API_KEY_ID),
    {
      user_id: USER_ID,
      api_key_id: API_KEY_ID,
      granted_at: '2026-01-01T00:00:00.000Z',
    },
  );
  assert.equal(fixture.target.has('admin_local_users|' + USER_ID), true);
});

test('writes connector revision and secret rows from a complete fake context result', async () => {
  const fixture = await run(tables({ ExternalApiConnection: [connector()] }), {
    async prepareConnector(row, request) {
      const credentialRef = 'synthetic-test-credential:' + row.id;
      return {
        revision: {
          adapter: 'synthetic-test-adapter:' + row.id,
          connector_id: request.connectorId,
          tenant_id: '',
          revision: 1,
          state: request.state,
          credential_ref: credentialRef,
          config: request.config,
          credential_source: { kind: 'legacy-db', credentialRef },
          account_id: null,
        },
        secret: {
          id: 'synthetic-test-secret:' + row.id,
          credential_ref: credentialRef,
          encrypted_value: Buffer.from('synthetic-test-ciphertext', 'utf8'),
        },
      };
    },
  });

  assert.equal(fixture.report.status, 'APPLIED');
  assert.deepEqual(fixture.report.skips, []);
  assert.equal(fixture.report.sourceRows.written, 1);
  const revision = fixture.target.get('connector_revisions|' + CONNECTION_ID + '||1');
  assert.equal(revision.adapter, 'synthetic-test-adapter:' + CONNECTION_ID);
  assert.equal(revision.tenant_id, '');
  assert.equal(revision.credential_source.credentialRef, 'synthetic-test-credential:' + CONNECTION_ID);
  const secret = fixture.target.get('secret_versions|synthetic-test-secret:' + CONNECTION_ID);
  assert(Buffer.isBuffer(secret.encrypted_value));
  assert.equal(secret.credential_ref, revision.credential_ref);
});

test('fail policy blocks any controlled skip before target validation or writes', async () => {
  const fixture = createAdapter(tables({ ExternalApiConnection: [connector()] }), {
    async prepareConnector() {
      return {
        skipped: true,
        code: 'CONNECTOR_ROW_OUT_OF_SCOPE',
        reason: 'synthetic out of scope row',
      };
    },
  });
  const report = await runBackfill(fixture.adapter, { apply: true, skipPolicy: 'fail' });

  assert.equal(report.status, 'BLOCKED_SKIPPED_ROWS');
  assert.equal(report.skips.length, 1);
  assert.equal(fixture.getValidateCalls(), 0);
  assert.equal(fixture.getApplyCalls(), 0);
});

test('invalid skip policy exits the CLI with code 2', () => {
  const runnerPath = path.resolve(__dirname, '../scripts/ldba-03-backfill.cjs');
  const env = { ...process.env, LDBA_A1_PASSED: '1', LDBA_SKIP_POLICY: 'unknown' };
  delete env.LDBA03_ADAPTER_MODULE;
  const result = spawnSync(process.execPath, [runnerPath, '--preflight'], { encoding: 'utf8', env });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /LDBA_SKIP_POLICY must be report or fail/);
});

test('workflow duplicate diagnostics use actual AppSetting keys', async () => {
  const duplicateValue = JSON.stringify({ slug: 'analyze', nodes: [] });
  const result = await run(tables({
    AppSetting: [
      { key: 'wb_schema:analyze', value: duplicateValue, updatedAt: '2026-01-01 00:00:00.000000' },
      { key: 'wb_schema:analyze', value: duplicateValue, updatedAt: '2026-01-01 00:00:00.000000' },
      { key: 'deployment:region', value: 'synthetic', updatedAt: '2026-01-01 00:00:00.000000' },
    ],
  }), {
    async prepareWorkflowSchema() {
      return {
        digest: 'sha256:' + 'a'.repeat(64),
        schemaRef: { kind: 'synthetic-test-envelope' },
      };
    },
  });

  assert.equal(result.report.status, 'APPLIED');
  assert.deepEqual(result.report.workflowDuplicates, [{
    slug: 'analyze',
    winner: 'wb_schema:analyze',
    skipped: 'wb_schema:analyze',
  }]);
  assert.equal(JSON.stringify(result.report.workflowDuplicates).includes('undefined'), false);
  assert.equal(result.report.perTable.AppSetting.skipped, 2);
  assert.equal(result.report.skips.some((item) => item.table === 'AppSetting'), false);
});
