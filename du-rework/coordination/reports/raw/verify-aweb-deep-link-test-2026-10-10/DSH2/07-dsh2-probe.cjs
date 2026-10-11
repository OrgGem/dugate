/* DSH2 independent probe for the AWEB deep-link hydration helpers.
   READ-ONLY: my own extractor + my own inputs (the author's four tests are NOT
   reused). Loads the real screen sources from the working tree. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = 'D:/Git/dugate/du-rework/orchestrator/apps/admin-web';
const ts = require(path.join(WEB, 'node_modules/typescript/lib/typescript.js'));

const results = [];
function check(name, fn) {
  try { const d = fn(); results.push({ name, pass: true, detail: d === undefined ? '' : String(d) }); }
  catch (e) { results.push({ name, pass: false, detail: String((e && e.message) || e) }); }
}

/** Independent extractor: pull the named top-level declarations out of a TSX file.
    `names` are extracted (interfaces included, for typing); `returnNames` are the
    runtime functions handed back (an interface is erased by transpilation). */
function extract(fileName, names, returnNames, dependencies) {
  const source = fs.readFileSync(path.join(WEB, fileName), 'utf8');
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const wanted = new Set(names);
  const found = new Map();
  for (const statement of sourceFile.statements) {
    const name = (ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement))
      ? statement.name?.text : undefined;
    if (name && wanted.has(name)) found.set(name, statement.getText(sourceFile));
  }
  const missing = [...wanted].filter((name) => !found.has(name));
  assert.deepEqual(missing, [], 'declarations missing from ' + fileName + ': ' + missing.join(','));
  const compiled = ts.transpileModule([...found.values()].join('\n\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    reportDiagnostics: true,
  });
  const errors = (compiled.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [],
    'extracted declarations do not transpile cleanly');
  const keys = Object.keys(dependencies);
  const factory = new Function(...keys, compiled.outputText + '\nreturn { ' + returnNames.join(', ') + ' };');
  return { helpers: factory(...keys.map((k) => dependencies[k])), source };
}

// The Trace helper needs the state module's normaliser, exactly as the screen does.
const traceState = (() => {
  const file = path.join(WEB, 'src/features/trace/state.ts');
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', compiled)(module, module.exports, require);
  return module.exports;
})();
const auditState = (() => {
  const file = path.join(WEB, 'src/features/audit/state.ts');
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', compiled)(module, module.exports, require);
  return module.exports;
})();

const trace = extract('src/features/trace/trace-screen.tsx',
  ['TraceDeepLinkLookup', 'safeQueryValue', 'traceLookupFromQuery'],
  ['safeQueryValue', 'traceLookupFromQuery'],
  { normalizeTraceLookup: traceState.normalizeTraceLookup }).helpers;
const audit = extract('src/features/audit/audit-screen.tsx',
  ['DraftFilters', 'safeQueryValue', 'queryTimeToLocalInput', 'auditFiltersFromQuery'],
  ['safeQueryValue', 'queryTimeToLocalInput', 'auditFiltersFromQuery'],
  { localDateTimeToUtc: auditState.localDateTimeToUtc }).helpers;

// ---- Trace --------------------------------------------------------------
check('T1 priority is operationId > correlationId > taskId (all three present)', () => {
  const all = trace.traceLookupFromQuery(new URLSearchParams('taskId=task-39&correlationId=corr-28&operationId=op-17'));
  assert.deepEqual(all, { kind: 'operationId', value: 'op-17', error: null });
  const pair = trace.traceLookupFromQuery(new URLSearchParams('taskId=task-39&correlationId=corr-28'));
  assert.deepEqual(pair, { kind: 'correlationId', value: 'corr-28', error: null });
  const only = trace.traceLookupFromQuery(new URLSearchParams('taskId=task-39'));
  assert.deepEqual(only, { kind: 'taskId', value: 'task-39', error: null });
  return '3 orders checked';
});

check('T2 a blank first candidate falls through to the next one', () => {
  const blank = trace.traceLookupFromQuery(new URLSearchParams('operationId=%20%20&taskId=task-39'));
  assert.deepEqual(blank, { kind: 'taskId', value: 'task-39', error: null });
  const empty = trace.traceLookupFromQuery(new URLSearchParams('operationId=&correlationId=corr-28'));
  assert.deepEqual(empty, { kind: 'correlationId', value: 'corr-28', error: null });
  return 'whitespace-only and empty both fall through';
});

check('T3 an INVALID first candidate errors instead of falling through (no silent downgrade)', () => {
  const bad = trace.traceLookupFromQuery(new URLSearchParams('operationId=bad%0Avalue&taskId=task-39'));
  assert.equal(bad.kind, 'operationId');
  assert.equal(bad.value, '');
  assert.equal(typeof bad.error, 'string');
  return 'kind=' + bad.kind + ' error kept: ' + bad.error;
});

check('T4 no identifier at all yields an empty, error-free lookup', () => {
  const none = trace.traceLookupFromQuery(new URLSearchParams('tenantId=tenant-a&foo=bar'));
  assert.deepEqual(none, { kind: 'operationId', value: '', error: null });
  return 'kind defaults to operationId with empty value';
});

check('T5 safeQueryValue boundaries: trim, length 200/201, control chars, null', () => {
  assert.equal(trace.safeQueryValue('  op-17  '), 'op-17');
  assert.equal(trace.safeQueryValue('x'.repeat(200)), 'x'.repeat(200));
  assert.equal(trace.safeQueryValue('x'.repeat(201)), null);
  assert.equal(trace.safeQueryValue('a\u0000b'), null);
  assert.equal(trace.safeQueryValue('a\u007fb'), null);
  assert.equal(trace.safeQueryValue(''), null);
  assert.equal(trace.safeQueryValue('   '), null);
  assert.equal(trace.safeQueryValue(null), null);
  return '8 boundary cases';
});

// ---- Audit --------------------------------------------------------------
check('A1 severity is case-insensitive; unknown severity falls back to ALL', () => {
  const warn = audit.auditFiltersFromQuery(new URLSearchParams('severity=WARNING'));
  assert.equal(warn.draft.severity, 'warning');
  assert.equal(audit.auditFiltersFromQuery(new URLSearchParams('severity=critical')).draft.severity, 'ALL');
  assert.equal(audit.auditFiltersFromQuery(new URLSearchParams()).draft.severity, 'ALL');
  return 'WARNING -> warning; critical -> ALL; absent -> ALL';
});

check('A2 sort and limit only accept the published values', () => {
  assert.equal(audit.auditFiltersFromQuery(new URLSearchParams('sort=createdAt:asc')).draft.sort, 'createdAt:asc');
  assert.equal(audit.auditFiltersFromQuery(new URLSearchParams('sort=createdAt:desc')).draft.sort, 'createdAt:desc');
  assert.equal(audit.auditFiltersFromQuery(new URLSearchParams('sort=updatedAt:asc')).draft.sort, 'createdAt:desc');
  for (const limit of ['25', '50', '100', '200']) {
    assert.equal(audit.auditFiltersFromQuery(new URLSearchParams('limit=' + limit)).draft.limit, limit);
  }
  for (const bad of ['1', '1000', 'abc', '']) {
    assert.equal(audit.auditFiltersFromQuery(new URLSearchParams('limit=' + bad)).draft.limit, '50', 'limit ' + bad);
  }
  return '2 sort values, 4 accepted limits, 4 rejected';
});

check('A3 resource precedence: explicit wins, operationId is the fallback, junk is dropped', () => {
  const explicit = audit.auditFiltersFromQuery(new URLSearchParams('operationId=op-17&resource=business%3Abiz'));
  assert.equal(explicit.draft.resource, 'business:biz');
  const fallback = audit.auditFiltersFromQuery(new URLSearchParams('operationId=op-17'));
  assert.equal(fallback.draft.resource, 'operation:op-17');
  const badOperation = audit.auditFiltersFromQuery(new URLSearchParams('operationId=bad%0Avalue'));
  assert.equal(badOperation.draft.resource, '', 'a control-char operationId must not become a resource');
  const blankResource = audit.auditFiltersFromQuery(new URLSearchParams('resource=%20%20'));
  assert.equal(blankResource.draft.resource, '');
  return 'explicit > fallback > empty';
});

check('A4 time bounds: valid instants round-trip, junk and blanks become empty', () => {
  const from = '2026-10-10T10:00:00.000Z';
  const to = '2026-10-10T12:30:00.000Z';
  const hydrated = audit.auditFiltersFromQuery(new URLSearchParams('from=' + from + '&to=' + to));
  assert.equal(new Date(hydrated.filters.from).toISOString(), from, 'from round-trip');
  assert.equal(new Date(hydrated.filters.to).toISOString(), to, 'to round-trip');
  assert.equal(audit.queryTimeToLocalInput('not-a-date'), '');
  assert.equal(audit.queryTimeToLocalInput(''), '');
  assert.equal(audit.queryTimeToLocalInput(null), '');
  assert.equal(audit.queryTimeToLocalInput('x'.repeat(65)), '');
  const none = audit.auditFiltersFromQuery(new URLSearchParams());
  assert.equal(none.draft.from, '');
  assert.equal(none.draft.to, '');
  assert.equal(none.filters.from, '');
  return 'round-trip exact; 4 junk/blank inputs -> empty';
});

check('A5 absent query yields the documented defaults and drops unknown params', () => {
  const hydrated = audit.auditFiltersFromQuery(new URLSearchParams('unknown=1&page=3'));
  assert.deepEqual(hydrated.draft, {
    severity: 'ALL', action: '', actor: '', resource: '', from: '', to: '',
    sort: 'createdAt:desc', limit: '50',
  });
  assert.equal(audit.safeQueryValue('x'.repeat(128)), 'x'.repeat(128));
  assert.equal(audit.safeQueryValue('x'.repeat(129)), null);
  return 'defaults match the screen initial state; audit safeQueryValue caps at 128';
});

// ---- meta: the suite cannot silently skip ------------------------------
check('M1 every declaration the suite extracts still exists in the screens', () => {
  const wanted = {
    'src/features/trace/trace-screen.tsx': ['TraceDeepLinkLookup', 'safeQueryValue', 'traceLookupFromQuery'],
    'src/features/audit/audit-screen.tsx': ['DraftFilters', 'safeQueryValue', 'queryTimeToLocalInput', 'auditFiltersFromQuery'],
  };
  for (const [file, names] of Object.entries(wanted)) {
    extract(file, names, [], { normalizeTraceLookup: () => null, localDateTimeToUtc: () => null });
  }
  return 'all 7 declarations present; my extractor throws if any disappears';
});

check('M2 the suite has no skip/only/todo and its extraction asserts on diagnostics', () => {
  const suite = fs.readFileSync(path.join(WEB, 'tests/deep-link-query-hydration.test.mjs'), 'utf8');
  assert.ok(!/\.skip|\.only|xit\(|xdescribe\(|todo\(/.test(suite), 'skip/only/todo present');
  assert.match(suite, /assert\.deepEqual\(\[\.\.\.remaining\], \[\], /, 'missing-declaration guard absent');
  assert.match(suite, /reportDiagnostics: true/);
  assert.match(suite, /DiagnosticCategory\.Error/);
  return 'no skip/only/todo; missing-declaration and diagnostics guards present';
});

const failed = results.filter((r) => !r.pass);
for (const r of results) console.log((r.pass ? 'ok   ' : 'FAIL ') + r.name + (r.detail ? ' :: ' + r.detail : ''));
console.log('PROBE_RESULT ' + (results.length - failed.length) + '/' + results.length + ' checks passed');
process.exitCode = failed.length === 0 ? 0 : 1;
