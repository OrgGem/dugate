/* DSH2 independent probe for the two new Connectors suites.
   READ-ONLY: my own loader (ESM data-URL with the relative import rewritten) and
   my own inputs; the production sources are only read. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WEB = 'D:/Git/dugate/du-rework/orchestrator/apps/admin-web';
const ts = require(path.join(WEB, 'node_modules/typescript/lib/typescript.js'));

const results = [];
function check(name, fn) {
  try { const d = fn(); results.push({ name, pass: true, detail: d === undefined ? '' : String(d) }); }
  catch (e) { results.push({ name, pass: false, detail: String((e && e.message) || e) }); }
}
const read = (file) => fs.readFileSync(path.join(WEB, file), 'utf8');

(async () => {
  // ---- load the production modules -------------------------------------
  const stateFile = path.join(WEB, 'src/features/connectors/state.ts');
  const curlUrl = pathToFileURL(path.join(WEB, 'src/features/connectors/curl-import.ts')).href;
  const compiled = ts.transpileModule(fs.readFileSync(stateFile, 'utf8'), {
    fileName: 'connectors-state.ts',
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  });
  const errors = (compiled.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [], 'state.ts must transpile');
  const rewritten = compiled.outputText.replace(/from (['"])\.\/curl-import\1/g, `from '${curlUrl}'`);
  assert.notEqual(rewritten, compiled.outputText, 'the curl-import import must be rewritten');
  const state = await import(`data:text/javascript;base64,${Buffer.from(rewritten, 'utf8').toString('base64')}`);
  const curl = await import(curlUrl);

  const {
    parseConnectorCapabilities, connectorActionGating, summarizeConnectorConfig,
    connectorConfigFromDraft, buildConnectorUpsertParams, parseConnectorList,
  } = state;
  const { parseCurlImport, summarizeCurlImport, isSecretTokenName } = curl;

  const flags = (g) => ({ upsert: g.upsert, activate: g.activate, disable: g.disable, retire: g.retire, test: g.test, rotate: g.rotate });

  // ---- P1 capabilities fail closed -------------------------------------
  check('P1 the capability advertisement fails closed on every malformed shape', () => {
    const good = { management: true, credentialWorkflow: true, test: false, knownConnectorIds: ['c-1'] };
    assert.ok(parseConnectorCapabilities(good), 'a complete advertisement must parse');
    for (const bad of [null, undefined, [], 'x', 7, {}, { management: true },
      { management: 'yes', credentialWorkflow: true, test: true, knownConnectorIds: [] },
      { management: true, credentialWorkflow: true, test: 1, knownConnectorIds: [] },
      { management: true, credentialWorkflow: true, test: true, knownConnectorIds: 'c-1' },
      { ...good, surprise: true }]) {
      assert.equal(parseConnectorCapabilities(bad), null, 'accepted: ' + JSON.stringify(bad));
    }
    return '1 valid, 10 malformed shapes rejected';
  });

  // ---- P2 gating matrix ------------------------------------------------
  check('P2 action gating follows the advertisement exactly, and null closes everything', () => {
    assert.deepEqual(flags(connectorActionGating(null)),
      { upsert: false, activate: false, disable: false, retire: false, test: false, rotate: false });
    assert.match(connectorActionGating(null).reason, /advertisement is unavailable/);

    const matrix = [
      [{ management: false, credentialWorkflow: false, test: false }, { upsert: false, activate: false, disable: false, retire: false, test: false, rotate: false }],
      [{ management: true, credentialWorkflow: false, test: false }, { upsert: true, activate: true, disable: true, retire: true, test: false, rotate: false }],
      [{ management: false, credentialWorkflow: true, test: true }, { upsert: false, activate: false, disable: false, retire: false, test: true, rotate: true }],
      [{ management: true, credentialWorkflow: true, test: true }, { upsert: true, activate: true, disable: true, retire: true, test: true, rotate: true }],
    ];
    for (const [advertised, expected] of matrix) {
      const caps = parseConnectorCapabilities({ ...advertised, knownConnectorIds: [] });
      assert.ok(caps, 'advertisement rejected: ' + JSON.stringify(advertised));
      assert.deepEqual(flags(connectorActionGating(caps)), expected, JSON.stringify(advertised));
    }
    return 'null + 4 combinations';
  });

  // ---- P3 config summary ----------------------------------------------
  check('P3 the config summary keeps names only, sorted, with no value leakage', () => {
    const secrets = ['s-top-9911', 's-pass-7722', 's-auth-5533', 's-token-3344'];
    const config = {
      zeta: secrets[0],
      alpha: { nested: { password: secrets[1] } },
      headers: [
        { name: 'Authorization', value: secrets[2] },
        { name: 'x-session-token', value: secrets[3] },
        { name: 'X-Trace-Id', value: 'trace-plain-1' },
        { name: 'X-Gone', value: '[REDACTED]' },
        { name: '', value: 'empty-name-value' },
        null,
        'not-an-object',
      ],
      middle: 'plain-value',
    };
    const summary = summarizeConnectorConfig(config);
    assert.deepEqual(summary, {
      keys: ['alpha', 'headers', 'middle', 'zeta'],
      headerNames: ['X-Trace-Id'],
      redactedHeaderNames: ['Authorization', 'x-session-token', 'X-Gone'],
    });
    const serialized = JSON.stringify(summary);
    for (const secret of [...secrets, 'trace-plain-1', 'empty-name-value', 'plain-value']) {
      assert.equal(serialized.includes(secret), false, 'summary leaked ' + secret);
    }
    assert.deepEqual(summarizeConnectorConfig({ headers: [] }), { keys: ['headers'], headerNames: [], redactedHeaderNames: [] });
    assert.deepEqual(summarizeConnectorConfig({ headers: 'nope' }), { keys: ['headers'], headerNames: [], redactedHeaderNames: [] });
    assert.equal(isSecretTokenName('Authorization'), true);
    assert.equal(isSecretTokenName('X-Trace-Id'), false);
    return 'sorted keys; 3 secret-named headers; 5 sentinel values absent; 2 odd header shapes tolerated';
  });

  // ---- P4 upsert plan --------------------------------------------------
  check('P4 the upsert plan trims its target, names every missing field, and never carries a secret', () => {
    const bearer = 'probe-bearer-2024';
    const headerSecret = 'probe-header-3031';
    const formSecret = 'probe-form-4042';
    const localPath = '/private/probe-customer.pdf';
    const command = [
      'curl -X PUT https://probe.example.test/upload',
      `-H 'Authorization: Bearer ${bearer}'`,
      `-H 'X-Api-Token: ${headerSecret}'`,
      "-H 'X-Trace-Id: probe-trace-51'",
      "-F 'username=bob'",
      `-F 'password=${formSecret}'`,
      `-F 'document=@${localPath}'`,
    ].join(' ');
    const parsed = parseCurlImport(command);
    assert.equal(parsed.ok, true, JSON.stringify(parsed.ok ? null : parsed.error));

    for (const [target, missing] of [
      [{ connectorId: '   ', adapter: 'http', credentialRef: 'v' }, 'connectorId'],
      [{ connectorId: 'c', adapter: '  ', credentialRef: 'v' }, 'adapter'],
      [{ connectorId: 'c', adapter: 'http', credentialRef: ' ' }, 'credentialRef'],
    ]) {
      const plan = buildConnectorUpsertParams(parsed.draft, target);
      assert.deepEqual(plan, { ok: false, missing }, JSON.stringify(target));
    }

    const plan = buildConnectorUpsertParams(parsed.draft, {
      connectorId: ' probe-connector ', adapter: ' http ', credentialRef: ' vault-ref-9 ',
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.params.mode, 'create');
    assert.equal(plan.params.connectorId, 'probe-connector');
    assert.equal(plan.params.adapter, 'http');
    assert.equal(plan.params.credentialRef, 'vault-ref-9');

    const config = connectorConfigFromDraft(parsed.draft);
    assert.deepEqual(config.auth, { type: 'BEARER', headerName: 'Authorization', secretPresent: true });
    assert.deepEqual(config.headers, [{ name: 'X-Trace-Id', value: 'probe-trace-51' }]);
    assert.deepEqual(config.redactedHeaderNames, ['X-Api-Token']);
    assert.deepEqual(config.secretFormFieldNames, ['password']);
    assert.deepEqual(config.fileFormFieldNames, ['document']);
    assert.deepEqual(config.formFields, [{ name: 'username', value: 'bob' }]);

    const payload = JSON.stringify(plan.params);
    for (const sensitive of [bearer, headerSecret, formSecret, localPath, 'probe-customer.pdf']) {
      assert.equal(payload.includes(sensitive), false, 'upsert payload leaked ' + sensitive);
    }
    return '3 missing-field errors; trim; create mode; 5 sensitive strings absent';
  });

  // ---- P5 curl preview masking ----------------------------------------
  check('P5 the curl preview masks secrets and keeps only safe values', () => {
    const bearer = 'bearer-abcdef-7788';
    const headerSecret = 'header-xyz-9911';
    const formSecret = 'form-secret-2233';
    const command = [
      'curl --request POST',
      '--url https://mask.example.test/v2/push',
      `--header 'Authorization: Bearer ${bearer}'`,
      `--header 'X-Client-Secret: ${headerSecret}'`,
      "--header 'X-Trace-Id: mask-trace-77'",
      "--form 'username=carol'",
      `--form 'password=${formSecret}'`,
      "--form 'document=@/private/mask-file.docx'",
    ].join(' ');
    const parsed = parseCurlImport(command);
    assert.equal(parsed.ok, true);
    const summary = summarizeCurlImport(parsed.draft);

    assert.equal(summary.auth.preview, '****7788');
    assert.equal(summary.auth.secretPresent, true);
    const header = summary.headers.find((h) => h.name === 'X-Client-Secret');
    assert.deepEqual(header, { name: 'X-Client-Secret', secret: true, valueChars: headerSecret.length, preview: '****9911' });
    const plain = summary.headers.find((h) => h.name === 'X-Trace-Id');
    assert.equal(plain.secret, false);
    assert.equal(plain.preview, 'set (13 chars)');
    assert.equal(plain.valueChars, 'mask-trace-77'.length);
    const password = summary.formFields.find((f) => f.name === 'password');
    assert.deepEqual(password, { name: 'password', secret: true, isFile: false, valueChars: formSecret.length, preview: '****2233' });
    assert.equal(summary.formFields.find((f) => f.name === 'document').preview, '@mask-file.docx');
    assert.equal(summary.formFields.find((f) => f.name === 'document').isFile, true);

    const serialized = JSON.stringify(summary);
    for (const sensitive of [bearer, headerSecret, formSecret, '/private/mask-file.docx', 'mask-trace-77']) {
      assert.equal(serialized.includes(sensitive), false, 'preview leaked ' + sensitive);
    }
    return 'auth/header/form masking + file basename only; 5 sensitive strings absent';
  });

  // ---- P6 list reader --------------------------------------------------
  check('P6 the list reader counts malformed rows as skipped and keeps the valid order', () => {
    const rows = [
      { connectorId: 'c-1', revision: 2, adapter: 'http', state: 'ACTIVE', config: {} },
      null,
      { connectorId: 'c-2', revision: 0, adapter: 'http', state: 'ACTIVE', config: {} },
      { connectorId: 'c-3', revision: 1, adapter: 'http', state: 'RETIRED', config: {}, extra: 1 },
      { connectorId: 'c-4', revision: 3, adapter: 'smtp', state: 'PENDING', config: {} },
    ];
    const parsed = parseConnectorList({ items: rows });
    assert.equal(parsed.skipped, 3);
    assert.deepEqual(parsed.items.map((i) => i.connectorId), ['c-1', 'c-4']);
    return 'skipped=3, order preserved';
  });

  // ---- P7 meta ---------------------------------------------------------
  check('P7 both suites fail loudly if a helper disappears, and neither can skip', () => {
    const honesty = read('tests/connectors-state-honesty.test.mjs');
    const fixtures = read('tests/connectors-fixtures.test.mjs');
    for (const [label, suite] of [['honesty', honesty], ['fixtures', fixtures]]) {
      assert.ok(!/\.skip|\.only|xit\(|xdescribe\(|todo\(/.test(suite), label + ' has skip/only/todo');
      assert.match(suite, /DiagnosticCategory\.Error/, label + ' lacks the diagnostics guard');
    }
    assert.match(honesty, /assert\.notEqual\(stateModuleSource, compiledState\.outputText, 'state module must resolve its curl helper import'\)/);
    assert.match(fixtures, /assert\.deepEqual\(\[\.\.\.remainingFunctions\], \[\], /);
    assert.match(fixtures, /assert\.deepEqual\(\[\.\.\.remainingVariables\], \[\], /);
    return 'honesty: import-rewrite assert + diagnostics; fixtures: function AND variable guards';
  });

  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log((r.pass ? 'ok   ' : 'FAIL ') + r.name + (r.detail ? ' :: ' + r.detail : ''));
  console.log('PROBE_RESULT ' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  process.exitCode = failed.length === 0 ? 0 : 1;
})();
