'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const test = require('node:test');

const {
  JSON_EXCEPTIONS,
  JSON_FIELDS,
  LEGACY_TABLES,
  decimalUsd,
  parseFileUrlAuthCipher,
  parseJsonField,
  runBackfill: runBackfillCore,
  timestampUtc,
} = require('../scripts/ldba-03-backfill.cjs');

async function runBackfill(adapter, options = {}) {
  adapter.timezoneEvidence = { verified: true, sourceVersion: adapter.sourceVersion, timezone: 'UTC', sha256: 'a'.repeat(64) };
  return runBackfillCore(adapter, options);
}

const API_KEY_ID = '4b302d31-9408-4e26-8cd5-f09bc7c74aa1';
const OPERATION_ID = '6f7dd08f-b131-4fc5-9bc8-12276af2a1e9';
const PROFILE_ID = '5d5a21d5-25f6-4c9b-a786-5d0eb492cf2e';
const CONNECTION_ID = 'b98b59ad-bdc1-4e41-a53f-dbe615d24c69';

function tables(overrides = {}) {
  return Object.fromEntries(LEGACY_TABLES.map((name) => [name, overrides[name] || []]));
}

function validApiKey(overrides = {}) {
  return {
    id: API_KEY_ID,
    name: 'offline key',
    keyHash: 'sha256:fixture-hash',
    prefix: 'sk-fixture',
    role: 'STANDARD',
    note: null,
    spendingLimit: '12.340000',
    totalUsed: '1.200000',
    status: 'active',
    createdAt: '2026-01-02 03:04:05.006',
    updatedAt: '2026-01-02 03:04:06.007',
    ...overrides,
  };
}

function validOperation(overrides = {}) {
  return {
    id: OPERATION_ID,
    apiKeyId: API_KEY_ID,
    createdByUserId: null,
    idempotencyKey: null,
    done: true,
    state: 'SUCCEEDED',
    progressPercent: 15,
    progressMessage: 'running',
    endpointSlug: 'analyze',
    pipelineJson: JSON.stringify({ kind: 'fixture' }),
    currentStep: 1,
    failedAtStep: null,
    filesJson: '[]',
    outputFormat: 'json',
    outputContent: null,
    outputFilePath: null,
    extractedData: null,
    stepsResultJson: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    pagesProcessed: 0,
    modelUsed: null,
    totalCostUsd: null,
    usageBreakdown: null,
    webhookUrl: null,
    webhookSentAt: null,
    errorCode: null,
    errorMessage: null,
    filesDeleted: false,
    createdAt: '2026-01-02 03:04:05.006',
    updatedAt: '2026-01-02 03:04:06.007',
    deletedAt: null,
    ...overrides,
  };
}

function createAdapter(sourceTables, context = {}, options = {}) {
  const target = new Map();
  let applyCalls = 0;
  let tenantIds = options.tenantIds ? [...options.tenantIds] : options.tenantId ? [options.tenantId] : [];
  const tenantSeedCalls = [];
  const adapter = {
    a1Passed: true,
    sourceVersion: 'synthetic-fixture-v1',
    a1SourceVersion: 'synthetic-fixture-v1',
    source: {
      async scan(table) {
        return sourceTables[table] || [];
      },
    },
    sink: {
      async resolveTenantIdsByName(name) {
        assert.equal(name, 'legacy-default');
        return [...tenantIds];
      },
      async seedTenantByName(name) {
        tenantSeedCalls.push({ name, argumentCount: arguments.length });
        if (tenantIds.length === 0) tenantIds = [crypto.randomUUID()];
      },
      async validatePlan() {
        return [];
      },
      async inspectImmutable(item) {
        const prior = target.get(item.entity + '|' + item.key);
        if (prior === undefined) return 'new';
        return isDeepStrictEqual(prior, item.value) ? 'identical' : 'conflict';
      },
      async applyImmutableBatch(items) {
        applyCalls += 1;
        const outcomes = [];
        for (const item of items) {
          const key = item.entity + '|' + item.key;
          const prior = target.get(key);
          if (prior !== undefined) {
            if (!isDeepStrictEqual(prior, item.value)) throw new Error('immutable conflict');
            outcomes.push('identical');
          } else {
            target.set(key, item.value);
            outcomes.push('inserted');
          }
        }
        return outcomes;
      },
    },
    context: {
      resolveBusinessAction(slug) {
        if (slug !== 'analyze') return null;
        return { businessId: 'document', businessVersion: '1', action: 'analyze' };
      },
      ...context,
    },
  };
  return {
    adapter,
    target,
    getApplyCalls: () => applyCalls,
    getTenantIds: () => [...tenantIds],
    getTenantSeedCalls: () => [...tenantSeedCalls],
  };
}

test('covers all nine legacy tables and lists strict JSON exceptions', () => {
  assert.equal(LEGACY_TABLES.length, 9);
  assert.deepEqual(JSON_FIELDS, [
    'pipelineJson',
    'stepsResultJson',
    'extractedData',
    'usageBreakdown',
    'parameters',
    'connectionsOverride',
    'staticFormFields',
    'extraHeaders',
  ]);
  assert.deepEqual(JSON_EXCEPTIONS, {
    allowedFileExtensions: 'csv-text',
    fileUrlAuthConfig: 'encrypted-iv-tag-ciphertext-text',
  });
  assert.equal(Object.prototype.hasOwnProperty.call(require('../scripts/ldba-03-backfill.cjs'), 'LEGACY_TENANT_ID'), false);
});

test('uses UTC for naive timestamps and rejects offset or Z input', () => {
  assert.equal(
    timestampUtc('Operation', { id: OPERATION_ID }, 'createdAt', '2026-10-08 12:13:14.123'),
    '2026-10-08T12:13:14.123Z',
  );
  for (const zoned of ['2026-10-08T12:13:14+07:00', '2026-10-08T12:13:14Z']) {
    assert.throws(
      () => timestampUtc('Operation', { id: OPERATION_ID }, 'createdAt', zoned),
      /timestamp without timezone/,
    );
  }
});

test('blocks real A2 without timezone evidence after source scan and before writing rows', async () => {
  const previous = process.env.LDBA_ALLOW_UNVERIFIED_TIMEZONE;
  delete process.env.LDBA_ALLOW_UNVERIFIED_TIMEZONE;
  try {
    const fixture = createAdapter(tables({ ApiKey: [validApiKey()] }));
    let scans = 0;
    const scan = fixture.adapter.source.scan;
    fixture.adapter.source.scan = async (table) => {
      scans += 1;
      return scan(table);
    };

    const report = await runBackfillCore(fixture.adapter, { apply: true, skipPolicy: 'report' });
    assert.equal(report.status, 'BLOCKED_TIMEZONE_UNVERIFIED');
    assert.equal(report.failures[0].code, 'LEGACY_TIMEZONE_UNVERIFIED');
    assert.equal(scans, LEGACY_TABLES.length);
    assert.deepEqual(fixture.getTenantSeedCalls(), []);
    assert.equal(fixture.getApplyCalls(), 0);

    const env = {
      ...process.env,
      LDBA_A1_PASSED: '1',
      LDBA_SKIP_POLICY: 'report',
      LDBA_ALLOW_UNVERIFIED_TIMEZONE: '',
    };
    delete env.LDBA03_ADAPTER_MODULE;
    const cli = spawnSync(process.execPath, [
      path.resolve(__dirname, '../scripts/ldba-03-backfill.cjs'),
      '--execute',
    ], { encoding: 'utf8', env });
    assert.equal(cli.status, 2);
    assert.match(cli.stderr, /LDBA03_ADAPTER_MODULE is required/);
  } finally {
    if (previous === undefined) delete process.env.LDBA_ALLOW_UNVERIFIED_TIMEZONE;
    else process.env.LDBA_ALLOW_UNVERIFIED_TIMEZONE = previous;
  }
});

test('strict JSON parsing fails with row and field context', () => {
  assert.deepEqual(parseJsonField('Operation', { id: OPERATION_ID }, 'pipelineJson', JSON.stringify({ ok: true }), true), { ok: true });
  assert.throws(
    () => parseJsonField('Operation', { id: OPERATION_ID }, 'pipelineJson', '{broken', true),
    (error) => error.code === 'INVALID_JSON' && error.sourceKey === OPERATION_ID && error.field === 'pipelineJson',
  );
});

test('CSV and encrypted file-url auth remain text with strict three-part cipher checks', () => {
  const csv = '.pdf,.docx';
  const cipher = '0123456789abcdef01234567:0123456789abcdef0123456789abcdef:deadbeef';
  assert.equal(csv, '.pdf,.docx');
  assert.equal(parseFileUrlAuthCipher('ProfileEndpoint', { id: PROFILE_ID }, cipher), cipher);
  assert.throws(
    () => parseFileUrlAuthCipher('ProfileEndpoint', { id: PROFILE_ID }, JSON.stringify({ url: 'https://example.test' })),
    /three parts/,
  );
});

test('decimal USD rounding is exact and null stays null', () => {
  assert.equal(decimalUsd('Operation', { id: OPERATION_ID }, 'totalCostUsd', '0.123457'), '0.123457');
  assert.equal(decimalUsd('Operation', { id: OPERATION_ID }, 'totalCostUsd', '-0.000001'), '-0.000001');
  assert.equal(decimalUsd('Operation', { id: OPERATION_ID }, 'totalCostUsd', null), null);
  assert.throws(
    () => decimalUsd('Operation', { id: OPERATION_ID }, 'totalCostUsd', '0.1234565'),
    (error) => error.code === 'DECIMAL_NOT_DATABASE_ROUNDED',
  );
  assert.throws(
    () => decimalUsd('Operation', { id: OPERATION_ID }, 'totalCostUsd', 0.25),
    (error) => error.code === 'UNSAFE_DECIMAL_INPUT',
  );
});

test('two runs are immutable and idempotent with the same synthetic source snapshot', async () => {
  const fixture = createAdapter(tables({
    ApiKey: [validApiKey()],
    Operation: [validOperation({ totalCostUsd: '0.000001' })],
  }));
  const first = await runBackfill(fixture.adapter);
  const firstSnapshot = new Map(fixture.target);
  const second = await runBackfill(fixture.adapter);

  assert.equal(first.status, 'APPLIED');
  assert.equal(first.sourceRows.read, 2);
  assert.equal(first.sourceRows.written, 2);
  assert.equal(first.destinationRows.written, 3);
  assert.equal(second.status, 'APPLIED');
  assert.equal(second.sourceRows.written, 0);
  assert.equal(second.sourceRows.skipped, 2);
  assert.equal(second.destinationRows.written, 0);
  assert.equal(second.destinationRows.skipped, 3);
  assert.deepEqual(fixture.target, firstSnapshot);
  assert.equal(fixture.getApplyCalls(), 2);
  assert.equal(fixture.target.get('operations|' + OPERATION_ID).total_cost_usd, '0.000001');
  assert.equal(fixture.target.get('operations|' + OPERATION_ID).tenant_id, fixture.getTenantIds()[0]);
  assert.deepEqual(fixture.getTenantSeedCalls(), [{ name: 'legacy-default', argumentCount: 1 }]);
});

test('preflight reports projected writes and never writes', async () => {
  const fixture = createAdapter(tables({ ApiKey: [validApiKey()] }), {}, { tenantId: crypto.randomUUID() });
  const report = await runBackfill(fixture.adapter, { apply: false });

  assert.equal(report.status, 'PREFLIGHT_READY');
  assert.equal(report.sourceRows.read, 1);
  assert.equal(report.destinationRows.planned, 2);
  assert.equal(report.destinationRows.skipped, 1);
  assert.equal(fixture.getApplyCalls(), 0);
  assert.equal(fixture.target.size, 0);
  assert.deepEqual(fixture.getTenantSeedCalls(), []);
});

test('A2 reports Orchestrator provenance failure after Connector commit as an explicit partial hold', async () => {
  const fixture = createAdapter(tables({ ApiKey: [validApiKey()] }), {}, { tenantId: 'a107ae7b-4a2b-40ee-a9a8-9b89b7ff79a2' });
  fixture.adapter.sink.applyImmutableBatch = async () => {
    const error = new Error('Orchestrator source provenance conflict');
    error.code = 'CROSS_PLANE_PARTIAL';
    error.phaseFailureCode = 'IMPORT_PROVENANCE_CONFLICT';
    error.connectorRowsCommitted = 1;
    error.replayRequired = false;
    throw error;
  };

  const report = await runBackfill(fixture.adapter, { apply: true, skipPolicy: 'report' });

  assert.equal(report.status, 'PARTIAL_CROSS_PLANE_HOLD');
  assert.equal(report.cutoverReady, false);
  assert.equal(report.crossPlane.state, 'PARTIAL_HOLD');
  assert.equal(report.crossPlane.committedPlane, 'connector');
  assert.equal(report.crossPlane.pendingPlane, 'orchestrator');
  assert.equal(report.crossPlane.phaseFailureCode, 'IMPORT_PROVENANCE_CONFLICT');
  assert.equal(report.crossPlane.replayRequired, false);
  assert.match(report.cutoverGate, /provenance conflicts/);
});

test('read-only preflight blocks without a tenant and never seeds', async () => {
  const fixture = createAdapter(tables({ ApiKey: [validApiKey()] }));
  const report = await runBackfill(fixture.adapter, { apply: false });

  assert.equal(report.status, 'PREFLIGHT_TENANT_PENDING');
  assert.equal(report.failures[0].code, 'TENANT_NOT_SEEDED');
  assert.deepEqual(fixture.getTenantIds(), []);
  assert.deepEqual(fixture.getTenantSeedCalls(), []);
  assert.equal(fixture.getApplyCalls(), 0);
});

test('duplicate tenant names fail closed because target name has no unique constraint', async () => {
  const fixture = createAdapter(tables(), {}, { tenantIds: [crypto.randomUUID(), crypto.randomUUID()] });
  const report = await runBackfill(fixture.adapter);

  assert.equal(report.status, 'BLOCKED_TENANT_RESOLUTION');
  assert.equal(report.failures[0].code, 'DUPLICATE_TENANT_NAME');
  assert.equal(fixture.getTenantSeedCalls().length, 0);
  assert.equal(fixture.getApplyCalls(), 0);
});

test('profile transform preserves CSV and cipher text and orders pointer after binding', async () => {
  const profile = {
    id: PROFILE_ID,
    apiKeyId: API_KEY_ID,
    endpointSlug: 'analyze',
    enabled: true,
    parameters: JSON.stringify({}),
    connectionsOverride: JSON.stringify([]),
    jobPriority: 'MEDIUM',
    fileUrlAuthConfig: '0123456789abcdef01234567:0123456789abcdef0123456789abcdef:deadbeef',
    allowedFileExtensions: '.pdf,.docx',
    rateLimitPerMin: null,
    maxConcurrent: null,
    createdAt: '2026-01-02 03:04:05.006',
    updatedAt: '2026-01-02 03:04:06.007',
  };
  const fixture = createAdapter(tables({
    ApiKey: [validApiKey()],
    ProfileEndpoint: [profile],
  }), {
    resolveProfileName() {
      return 'Imported analyze';
    },
    normalizeConnectionsOverride(value) {
      return value;
    },
  });
  const report = await runBackfill(fixture.adapter);
  assert.equal(report.status, 'APPLIED');
  const bindingKey = 'profile_bindings|' + PROFILE_ID + '|1';
  const pointerKey = 'profile_active_revisions|' + PROFILE_ID;
  assert.equal(fixture.target.get(bindingKey).allowed_file_extensions, '.pdf,.docx');
  assert.equal(
    fixture.target.get(bindingKey).file_url_auth_cipher,
    profile.fileUrlAuthConfig,
  );
  assert.equal(report.preflight.findIndex((item) => item.entity === 'profile_active_revisions') >
    report.preflight.findIndex((item) => item.entity === 'profile_bindings'), true);
  assert.equal(fixture.target.has(pointerKey), true);
  assert.equal(fixture.target.get(bindingKey).endpoint_slug, profile.endpointSlug);
  assert.equal(fixture.target.get('profile_api_keys|' + PROFILE_ID + '|' + API_KEY_ID).state, 'ACTIVE');
  assert.equal(report.omissions.some((item) => item.field === 'rateLimitPerMin'), true);
});

test('bad JSON, UUID, and state are row failures and prevent all writes', async (t) => {
  const cases = [
    {
      label: 'bad JSON',
      operation: validOperation({ pipelineJson: '{bad' }),
      expected: 'INVALID_JSON',
    },
    {
      label: 'bad UUID',
      apiKey: validApiKey({ id: 'not-a-uuid' }),
      expected: 'INVALID_UUID',
    },
    {
      label: 'unknown state',
      operation: validOperation({ state: 'MYSTERY' }),
      expected: 'UNKNOWN_VALUE',
    },
  ];
  for (const item of cases) {
    await t.test(item.label, async () => {
      const fixture = createAdapter(tables({
        ApiKey: item.apiKey ? [item.apiKey] : [],
        Operation: item.operation ? [item.operation] : [],
      }));
      const report = await runBackfill(fixture.adapter);
      assert.equal(report.status, 'BLOCKED_TRANSFORM');
      assert.equal(report.failures.some((failure) => failure.code === item.expected), true);
      assert.equal(fixture.target.size, 0);
      assert.equal(fixture.getApplyCalls(), 0);
    });
  }
});

test('terminal callback history is preserved without scheduling delivery', async () => {
  const fixture = createAdapter(tables({
    ApiKey: [validApiKey()],
    Operation: [validOperation({ webhookUrl: 'https://callback.example.test' })],
  }));
  const report = await runBackfill(fixture.adapter);
  assert.equal(report.status, 'APPLIED');
  assert.equal(fixture.target.get('operations|' + OPERATION_ID).legacy_history.webhookUrl, 'https://callback.example.test');
  assert.equal(report.omissions.some((item) => item.field === 'webhookUrl'), true);
});

test('connector adapter preserves opaque text identifiers and rejects plaintext secrets', async (t) => {
  const row = {
    id: 'connector:legacy-a',
    name: 'Offline connector',
    slug: 'offline-connector',
    description: null,
    endpointUrl: 'https://connector.example.test',
    httpMethod: 'POST',
    authType: 'API_KEY_HEADER',
    authKeyHeader: 'x-api-key',
    authSecret: 'synthetic-secret',
    promptFieldName: 'query',
    fileFieldName: 'files',
    fileUrlFieldName: null,
    defaultPrompt: 'offline',
    staticFormFields: JSON.stringify({}),
    extraHeaders: JSON.stringify({}),
    responseContentPath: 'content',
    sessionIdResponsePath: null,
    sessionIdFieldName: null,
    timeoutSec: 60,
    state: 'ENABLED',
    createdAt: '2026-01-02 03:04:05.006',
    updatedAt: '2026-01-02 03:04:06.007',
  };
  const context = {
    async prepareConnector(source, input) {
      return {
        revision: {
          connector_id: source.id,
          revision: 1,
          adapter: 'http-json',
          config: input.config,
          credential_ref: 'legacy-credential-fixture',
          credential_source: { kind: 'legacy-db', credentialRef: 'legacy-credential-fixture' },
          state: input.state,
          created_at: input.createdAt,
          tenant_id: '',
          account_id: null,
        },
        secret: {
          id: 'secret:revision-1',
          credential_ref: 'legacy-credential-fixture',
          encrypted_value: Buffer.from('synthetic-ciphertext'),
        },
      };
    },
  };
  const fixture = createAdapter(tables({ ExternalApiConnection: [row] }), context);
  const report = await runBackfill(fixture.adapter);
  assert.equal(report.status, 'APPLIED');
  assert.equal(fixture.target.has('connector_revisions|connector:legacy-a||1'), true);
  assert.equal(fixture.target.has('secret_versions|secret:revision-1'), true);
  const revision = fixture.target.get('connector_revisions|connector:legacy-a||1');
  assert.equal(revision.connector_id, 'connector:legacy-a');
  assert.equal(revision.tenant_id, '');
  assert.deepEqual(revision.credential_source, { kind: 'legacy-db', credentialRef: 'legacy-credential-fixture' });

  await t.test('plaintext adapter output fails closed', async () => {
    const plainFixture = createAdapter(tables({ ExternalApiConnection: [row] }), {
      async prepareConnector(source, input) {
        return {
          revision: {
            connector_id: source.id,
            revision: 1,
            state: input.state,
            tenant_id: '',
            credential_ref: 'legacy-credential-fixture',
            config: input.config,
            credential_source: { kind: 'legacy-db', credentialRef: 'legacy-credential-fixture' },
            account_id: null,
          },
          secret: {
            id: 'secret:revision-1',
            credential_ref: 'legacy-credential-fixture',
            encrypted_value: Buffer.from(source.authSecret),
          },
        };
      },
    });
    const result = await runBackfill(plainFixture.adapter);
    assert.equal(result.status, 'BLOCKED_TRANSFORM');
    assert.equal(result.failures[0].code, 'PLAINTEXT_SECRET');
    assert.equal(plainFixture.target.size, 0);
  });
});

test('artifact transform copies verified external bytes into postgres blob storage', async () => {
  const bytes = Buffer.from('synthetic-file-bytes');
  const md5 = crypto.createHash('md5').update(bytes).digest('hex');
  const row = {
    id: 'd0fd5849-9c9c-4e4e-9d6c-00cd5ee6e4a7',
    md5Hash: md5,
    s3Key: 'fixture-object-key',
    fileName: 'fixture.pdf',
    mimeType: 'application/pdf',
    size: bytes.length,
    refCount: 3,
    createdAt: '2026-01-02 03:04:05.006',
    lastAccessedAt: '2026-01-03 03:04:05.006',
  };
  const fixture = createAdapter(tables({ FileCache: [row], Operation: [validOperation({ filesJson: JSON.stringify([{ fileCacheId: row.id, path: row.s3Key }]), outputFilePath: row.s3Key })] }), {
    async readFileCacheBytes(key) {
      assert.equal(key, row.s3Key);
      return bytes;
    },
    artifactTokenFor(source, id) {
      return crypto.createHash('sha256').update(source.s3Key + id).digest('hex');
    },
    artifactPurposeFor() {
      return 'input';
    },
  });
  const report = await runBackfill(fixture.adapter);
  assert.equal(report.status, 'APPLIED');
  assert.equal(fixture.target.get('operations|' + OPERATION_ID).output_file_path, 'legacy-filecache/' + row.id);
  assert.deepEqual(fixture.target.get('operations|' + OPERATION_ID).submit_artifacts, [{ artifactId: row.id, role: 'input' }]);
  assert.equal(fixture.target.has('artifacts|' + row.id), true);
  assert.equal(fixture.target.get('artifacts|' + row.id).storage_backend, 'postgres');
  assert.equal(fixture.target.get('artifacts|' + row.id).file_name, 'fixture.pdf');
  assert.equal(fixture.target.has('artifact_blobs|legacy-filecache/' + row.id), true);
  assert.deepEqual(fixture.target.get('artifact_blobs|legacy-filecache/' + row.id).bytes, bytes);
  assert.equal(report.omissions.some((item) => item.field === 'refCount'), true);
  assert.equal(report.omissions.some((item) => item.field === 'lastAccessedAt'), true);
});

test('user import fails closed until the LDBA-04 identity adapter exists', async () => {
  const fixture = createAdapter(tables({
    User: [{
      id: '319bbafa-2e55-4f2a-9ecb-fdb8af98d6cc',
      username: 'admin',
      password: '$2b$12$synthetic-bcrypt-only',
      role: 'ADMIN',
      createdAt: '2026-01-02 03:04:05.006',
      updatedAt: '2026-01-02 03:04:06.007',
    }],
  }));
  const report = await runBackfill(fixture.adapter);
  assert.equal(report.status, 'BLOCKED_TRANSFORM');
  assert.equal(report.failures[0].code, 'IDENTITY_ADAPTER_REQUIRED');
  assert.equal(fixture.target.size, 0);
});

test('missing A1 evidence for the exact source version stops before reading', async () => {
  let readCalls = 0;
  const fixture = createAdapter(tables());
  fixture.adapter.a1SourceVersion = 'different-snapshot';
  fixture.adapter.source.scan = async () => {
    readCalls += 1;
    return [];
  };
  const report = await runBackfill(fixture.adapter);
  assert.equal(report.status, 'BLOCKED_A1');
  assert.equal(report.failures[0].code, 'A1_NOT_PASSED_FOR_SOURCE_VERSION');
  assert.equal(readCalls, 0);
  assert.equal(fixture.getApplyCalls(), 0);
});

test('ORV11 refuses active and actual legacy HITL state without manufacturing tasks', async () => {
  for (const state of ['RUNNING', 'WAITING_USER_INPUT', 'PENDING']) {
    const fixture = createAdapter(tables({ Operation: [validOperation({ state, done: false })] }));
    const report = await runBackfill(fixture.adapter);
    assert.equal(report.status, 'BLOCKED_TRANSFORM');
    assert.equal(report.failures[0].code, 'DRAIN_REQUIRED');
    assert.equal(fixture.getApplyCalls(), 0);
  }
});

test('ORV11 bypass environment cannot authorize execution', async () => {
  const fixture = createAdapter(tables());
  process.env.LDBA_ALLOW_UNVERIFIED_TIMEZONE = '1';
  try {
    const report = await runBackfillCore(fixture.adapter);
    assert.equal(report.status, 'BLOCKED_TIMEZONE_UNVERIFIED');
    assert.equal(fixture.getApplyCalls(), 0);
  } finally { delete process.env.LDBA_ALLOW_UNVERIFIED_TIMEZONE; }
});

test('ORV11 preserves disabled local identity and assignments with runtime roles', async () => {
  const provider = require('../scripts/ldba-context-provider.cjs');
  const userId = '319bbafa-2e55-4f2a-9ecb-fdb8af98d6cc';
  const fixture = createAdapter(tables({
    ApiKey: [validApiKey()],
    User: [{ id: userId, username: 'Operator', role: 'USER', createdAt: '2026-01-02 03:04:05.006', updatedAt: '2026-01-02 03:04:05.006' }],
    UserProfileAssignment: [{ id: PROFILE_ID, userId, apiKeyId: API_KEY_ID, createdAt: '2026-01-02 03:04:05.006' }],
  }), { prepareAdminLocalUser: provider.prepareAdminLocalUser });
  const report = await runBackfill(fixture.adapter);
  assert.equal(report.status, 'APPLIED');
  const user = fixture.target.get('admin_local_users|' + userId);
  assert.equal(user.role, 'operator');
  assert.equal(user.is_enabled, false);
  assert.equal(user.is_locked, true);
  assert.equal(user.legacy_password_reset_required, true);
  assert.ok(fixture.target.has('user_profile_assignments|' + userId + '|' + API_KEY_ID));
});

test('ORV11 retains non-workflow settings as non-effective archive with reconciliation notice', async () => {
  const fixture = createAdapter(tables({ AppSetting: [{ key: 'ai_model', value: 'legacy-model', updatedAt: '2026-01-02 03:04:05.006' }] }));
  const report = await runBackfill(fixture.adapter);
  assert.equal(report.status, 'APPLIED');
  assert.ok([...fixture.target.keys()].some((key) => key.startsWith('legacy_app_settings|')));
  assert.ok(report.omissions.some((item) => item.table === 'AppSetting'));
  assert.equal(report.cutoverReady, false);
});

test('ORV11 deleted-file history imports without phantom output bytes', async () => {
  const fixture = createAdapter(tables({ Operation: [validOperation({ filesDeleted: true, filesJson: '[{"path":"missing.pdf"}]', outputFilePath: 'gone.pdf' })] }));
  const report = await runBackfill(fixture.adapter);
  assert.equal(report.status, 'APPLIED');
  const operation = fixture.target.get('operations|' + OPERATION_ID);
  assert.equal(operation.output_file_path, null);
  assert.equal(operation.legacy_history.filesDeleted, true);
  assert.deepEqual(operation.submit_artifacts, []);
});

test('ORV11 refuses plaintext known secret settings before archive writes', async () => {
  const fixture = createAdapter(tables({ AppSetting: [{ key: 'ai_api_key', value: 'not-encrypted', updatedAt: '2026-01-02 03:04:05.006' }] }));
  const report = await runBackfill(fixture.adapter);
  assert.equal(report.status, 'BLOCKED_TRANSFORM');
  assert.equal(fixture.getApplyCalls(), 0);
});
