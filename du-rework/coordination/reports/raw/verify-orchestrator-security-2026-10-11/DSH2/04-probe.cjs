/* DSH2 independent verification of the orchestrator security review findings
   SEC-01..SEC-03. READ-ONLY: loads working-tree TypeScript sources through a
   transpile hook. No product file is written; no external network.
   SEC-04 lives in crash-204.cjs and runs as its own process. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SVC = 'D:/Git/dugate/du-rework/orchestrator/services/orchestrator';
const ts = require(path.join(SVC, 'node_modules/typescript/lib/typescript.js'));

require.extensions['.ts'] = function loadTs(module, filename) {
  const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  module._compile(out, filename);
};

const results = [];
async function check(name, fn) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d === undefined ? '' : String(d) }); }
  catch (e) { results.push({ name, pass: false, detail: String((e && e.message) || e) }); }
}
const read = (p) => fs.readFileSync(p, 'utf8');

(async () => {
  // ---------- SEC-01 -----------------------------------------------------
  await check('SEC-01a a live operator session loses its tenant when projected to claims', async () => {
    const auth = require(path.join(SVC, 'src/app/admin/auth-dispatch.ts'));
    const request = {
      method: 'GET', pathname: '/admin/legacy/operations',
      query: { tenant: 'tenant-b' }, headers: {},
      cookies: { du_session: 'S'.repeat(43) },
    };
    const config = {
      adminToken: 'platform-admin-token', jsonBaseUrl: 'http://127.0.0.1:1',
      oidcSessions: { get: async () => ({ role: 'operator', tenantId: 'tenant-a', csrfToken: 'C'.repeat(43) }) },
    };
    const outcome = await auth.resolveOpaqueSession(config, request);
    assert.equal(outcome.state, 'live', 'session was not live');
    assert.equal(outcome.claims.role, 'operator');
    const keys = Object.keys(outcome.claims).sort();
    assert.deepEqual(keys, ['exp', 'iat', 'iss', 'role'], 'claims carry more than role: ' + keys.join(','));
    assert.equal(Object.hasOwn(outcome.claims, 'tenantId'), false, 'claims kept a tenant');
    return 'session tenant-a -> claims keys ' + keys.join(',') + ' (no tenant/identity)';
  });

  await check('SEC-01b legacy operations section hands the PLATFORM token + caller tenant filter to the fetcher', async () => {
    const dispatch = require(path.join(SVC, 'src/app/admin/section-dispatch.ts'));
    let seen = null;
    const config = {
      adminToken: 'platform-admin-token',
      sectionFetchers: { operations: async (input) => { seen = input; return { kind: 'empty', message: 'probe' }; } },
    };
    const request = {
      method: 'GET', pathname: '/admin/legacy/operations',
      query: { tenant: 'tenant-b', jsonBaseUrl: 'http://127.0.0.1:1' }, headers: {}, cookies: {},
    };
    await dispatch.resolveOperationExtras(request, config, 'operator');
    assert.ok(seen, 'fetcher was never called');
    assert.equal(seen.adminToken, 'platform-admin-token', 'token seen by fetcher: ' + seen.adminToken);
    assert.equal(seen.tenantFilter, 'tenant-b', 'tenant filter seen by fetcher: ' + seen.tenantFilter);
    return 'operator session -> adminToken=platform-admin-token, tenantFilter=tenant-b';
  });

  await check('SEC-01c legacy overview section does the same with ?tenantId', async () => {
    const dispatch = require(path.join(SVC, 'src/app/admin/section-dispatch.ts'));
    let seen = null;
    const config = {
      adminToken: 'platform-admin-token',
      sectionFetchers: { overview: async (input) => { seen = input; return { kind: 'empty', message: 'probe' }; } },
    };
    const request = {
      method: 'GET', pathname: '/admin/legacy/overview',
      query: { tenantId: 'tenant-b', jsonBaseUrl: 'http://127.0.0.1:1' }, headers: {}, cookies: {},
    };
    await dispatch.resolveOverviewExtras(request, config, 'viewer');
    assert.ok(seen, 'fetcher was never called');
    assert.equal(seen.adminToken, 'platform-admin-token');
    assert.equal(seen.tenantId, 'tenant-b');
    return 'viewer session -> adminToken=platform-admin-token, tenantId=tenant-b';
  });

  await check('SEC-01d contrast: the SPA BFF derives the tenant credential, the legacy dispatch does not', async () => {
    const upstream = read(path.join(SVC, 'src/app/admin/bff/upstream.ts'));
    assert.match(upstream, /export function credentialFor\(/);
    assert.match(upstream, /credentialForTenant/, 'BFF has no tenant credential selector');
    const section = read(path.join(SVC, 'src/app/admin/section-dispatch.ts'));
    assert.ok(!/rbacPrincipal|authorizeAuditTenantRead|credentialForTenant/.test(section),
      'legacy dispatch already uses the BFF tenant controls');
    const shellServer = read(path.join(SVC, 'src/app/admin/shell-server.ts'));
    assert.match(shellServer, /\/admin\/legacy\//, 'no legacy mount found');
    return 'BFF selects a tenant credential; legacy dispatch has none; /admin/legacy/* still mounted';
  });

  // ---------- SEC-02 -----------------------------------------------------
  await check('SEC-02a the origin mode defaults to warn in code and in Compose; only enforce denies', async () => {
    const source = read(path.join(SVC, 'src/modules/operations/ingestion-consumer.ts'));
    const sourceFile = ts.createSourceFile('ingestion-consumer.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let fn = null;
    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === 'sourceCredentialOriginModeFromEnv') {
        fn = statement.getText(sourceFile).replace(/^export\s+/, '');
      }
    }
    assert.ok(fn, 'sourceCredentialOriginModeFromEnv not found');
    const compiledFn = ts.transpileModule(fn, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    const modeFromEnv = new Function(compiledFn + '\nreturn sourceCredentialOriginModeFromEnv;')();
    assert.equal(modeFromEnv({}), 'warn', 'unset must default to warn');
    assert.equal(modeFromEnv({ DU_SOURCE_CREDENTIAL_ORIGIN_MODE: '' }), 'warn');
    assert.equal(modeFromEnv({ DU_SOURCE_CREDENTIAL_ORIGIN_MODE: 'enforce' }), 'enforce');
    assert.throws(() => modeFromEnv({ DU_SOURCE_CREDENTIAL_ORIGIN_MODE: 'off' }));
    const compose = read('D:/Git/dugate/du-rework/compose/orchestrator.yml');
    assert.match(compose, /DU_SOURCE_CREDENTIAL_ORIGIN_MODE: \$\{DU_SOURCE_CREDENTIAL_ORIGIN_MODE:-warn\}/,
      'compose default is not warn');
    return 'code default=warn; compose default=warn; only warn|enforce accepted';
  });

  await check('SEC-02b in warn the credential IS attached to an unapproved origin; enforce refuses before any call', async () => {
    const resolver = require(path.join(SVC, 'src/modules/operations/acquisition-ref-resolver.ts'));
    const auth = { kind: 'bearer', token: 'synthetic-source-secret', allowedOrigins: ['https://approved.example'] };
    const unapproved = 'https://unapproved.example/document.pdf';

    const seen = [];
    const fetcher = async (href, init) => {
      seen.push({ href, auth: new Headers(init?.headers).get('authorization') });
      return new Response('ok', { status: 200 });
    };
    await resolver.withSourceAuth(fetcher, auth, 'warn')(unapproved);
    assert.equal(seen.length, 1, 'warn did not call the fetcher');
    assert.equal(seen[0].auth, 'Bearer synthetic-source-secret', 'warn mode did not attach the credential');

    const enforceSeen = [];
    const enforceFetcher = async (href) => { enforceSeen.push(href); return new Response('ok'); };
    await assert.rejects(
      () => resolver.withSourceAuth(enforceFetcher, auth, 'enforce')(unapproved),
      (e) => e.code === 'ORIGIN_NOT_ALLOWLISTED',
    );
    assert.equal(enforceSeen.length, 0, 'enforce still called the fetcher');

    await resolver.withSourceAuth(fetcher, auth, 'warn')('https://approved.example/doc.pdf');
    assert.equal(seen[1].auth, 'Bearer synthetic-source-secret', 'approved origin lost the credential');
    return 'warn attached to unapproved.example (1 call); enforce threw ORIGIN_NOT_ALLOWLISTED (0 calls); approved attached';
  });

  await check('SEC-02c an empty allowlist is a warn-level ORIGIN_POLICY_MISSING, not a refusal', async () => {
    const resolver = require(path.join(SVC, 'src/modules/operations/acquisition-ref-resolver.ts'));
    const auth = { kind: 'header', headerName: 'x-api-key', headerValue: 'synthetic-header-secret', allowedOrigins: [] };
    const seen = [];
    const fetcher = async (href, init) => {
      seen.push(new Headers(init?.headers).get('x-api-key'));
      return new Response('ok');
    };
    await resolver.withSourceAuth(fetcher, auth, 'warn')('https://anywhere.example/doc.pdf');
    assert.equal(seen[0], 'synthetic-header-secret', 'warn mode did not attach the header credential');
    await assert.rejects(
      () => resolver.withSourceAuth(async () => new Response('ok'), auth, 'enforce')('https://anywhere.example/doc.pdf'),
      (e) => e.code === 'ORIGIN_POLICY_MISSING',
    );
    return 'warn attached a header credential with no policy; enforce threw ORIGIN_POLICY_MISSING';
  });

  // ---------- SEC-03 -----------------------------------------------------
  await check('SEC-03a the plaintext S3 writer stores the source bytes verbatim', async () => {
    const storage = require(path.join(SVC, 'src/modules/operations/ingestion-storage-s3.ts'));
    const plaintext = Buffer.from('synthetic source document bytes for the writer probe', 'utf8');
    let captured = null;
    let capturedBytes = null;
    const send = async (command) => {
      captured = command;
      const chunks = [];
      for await (const chunk of command.input.Body) chunks.push(Buffer.from(chunk));
      capturedBytes = Buffer.concat(chunks);
      return { VersionId: 'v-1' };
    };
    const writer = storage.createS3PinnedSourceStorage({
      bucket: 'probe-bucket', send, db: { query: async () => ({ rows: [] }) },
    });
    const receipt = await writer.putVerified({
      storageKey: 'tenant-a/op-1/source', contentType: 'application/pdf',
      body: (async function* () { yield plaintext.subarray(0, 10); yield plaintext.subarray(10); })(),
      maxBytes: 1024 * 1024,
    });
    assert.ok(captured, 'send was never called');
    assert.deepEqual(capturedBytes, plaintext, 'stored bytes differ from the source bytes');
    assert.equal(captured.input.Bucket, 'probe-bucket');
    assert.equal(receipt.sizeBytes, plaintext.byteLength);
    const asText = capturedBytes.toString('utf8');
    assert.ok(!/du-encrypted|crypto-manifest|manifest_version/i.test(asText), 'stored body carries an encryption marker');
    return 'PutObject.Body byte-equal to the plaintext (' + plaintext.byteLength + ' B); no envelope marker';
  });

  await check('SEC-03b the encrypted writer exists but the bootstrap never wires it (static)', async () => {
    const bootstrap = read(path.join(SVC, 'src/app/bootstrap/create-app.ts'));
    const consumer = read(path.join(SVC, 'src/modules/operations/ingestion-consumer.ts'));
    const storageSrc = read(path.join(SVC, 'src/modules/operations/ingestion-storage-s3.ts'));
    assert.match(bootstrap, /createS3PinnedSourceStorage\(/, 'bootstrap does not use the plaintext writer');
    assert.ok(!/createS3EncryptedPinnedSourceStorage|createEncryptedSourceStorageWrapper/.test(bootstrap),
      'bootstrap references an encrypted writer after all');
    assert.ok(!/requireEncryptedSourceWrites/.test(bootstrap), 'bootstrap passes the encryption flag');
    assert.match(consumer, /options\.requireEncryptedSourceWrites/, 'consumer no longer gates on the flag');
    assert.match(storageSrc, /export function createS3EncryptedPinnedSourceStorage/);
    const bootOptions = read(path.join(SVC, 'src/modules/encryption/boot-options.ts'));
    assert.match(bootOptions, /requires persistence/, 'policy text 1 missing');
    assert.match(bootOptions, /encryption across PG\/S3 and every producer/, 'policy text 2 missing');
    return 'bootstrap: plaintext writer + no flag + no encrypted factory; encrypted factory exists; real-data policy demands encryption';
  });

  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log((r.pass ? 'ok   ' : 'FAIL ') + r.name + (r.detail ? ' :: ' + r.detail : ''));
  console.log('PROBE_RESULT ' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  process.exitCode = failed.length === 0 ? 0 : 1;
})();
