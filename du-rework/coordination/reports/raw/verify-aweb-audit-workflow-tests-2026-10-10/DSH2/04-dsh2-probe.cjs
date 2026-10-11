/* DSH2 independent probe for the two new AWEB suites:
   - audit-event-links (auditEventLinks + safeQueryValue from audit-screen.tsx)
   - workflow-simulation-honesty (simulation payload, result panel JSX, stage-count fallback)
   READ-ONLY: my own AST finders and my own inputs; the product sources are only read. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = 'D:/Git/dugate/du-rework/orchestrator/apps/admin-web';
const ts = require(path.join(WEB, 'node_modules/typescript/lib/typescript.js'));
const React = require(path.join(WEB, 'node_modules/react'));
const { renderToStaticMarkup } = require(path.join(WEB, 'node_modules/react-dom/server'));

const results = [];
function check(name, fn) {
  try { const d = fn(); results.push({ name, pass: true, detail: d === undefined ? '' : String(d) }); }
  catch (e) { results.push({ name, pass: false, detail: String((e && e.message) || e) }); }
}

const read = (file) => fs.readFileSync(path.join(WEB, file), 'utf8');
const parse = (file, source) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

// ---------- audit helpers -------------------------------------------------
const auditFile = 'src/features/audit/audit-screen.tsx';
const auditSource = read(auditFile);
const auditAst = parse(auditFile, auditSource);

const auditFunctions = (() => {
  const wanted = new Set(['safeQueryValue', 'auditEventLinks']);
  const found = new Map();
  for (const statement of auditAst.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && wanted.has(statement.name.text)) {
      found.set(statement.name.text, statement.getText(auditAst));
    }
  }
  assert.deepEqual([...wanted].filter((n) => !found.has(n)), [], 'audit helpers missing');
  const compiled = ts.transpileModule([...found.values()].join('\n\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true,
  });
  const errors = (compiled.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')), []);
  return new Function(compiled.outputText + '\nreturn { safeQueryValue, auditEventLinks };')();
})();

check('L1 operation resources link to both screens; non-operation resources never invent a Trace link', () => {
  assert.deepEqual(auditFunctions.auditEventLinks('operation:op-17'),
    { audit: '/audit?resource=operation%3Aop-17', trace: '/trace?operationId=op-17' });
  assert.deepEqual(auditFunctions.auditEventLinks('business:acme-42'),
    { audit: '/audit?resource=business%3Aacme-42', trace: null });
  return 'both shapes';
});

check('L2 the operation prefix is case-insensitive and the value keeps its original case', () => {
  const upper = auditFunctions.auditEventLinks('OPERATION:Op-9');
  assert.equal(upper.trace, '/trace?operationId=Op-9');
  assert.equal(upper.audit, '/audit?resource=OPERATION%3AOp-9');
  return 'OPERATION:Op-9 -> trace Op-9';
});

check('L3 the operation-id limit is inclusive at 64 and exclusive at 65', () => {
  const at64 = auditFunctions.auditEventLinks('operation:' + 'x'.repeat(64));
  assert.equal(at64.trace, '/trace?operationId=' + 'x'.repeat(64), '64 chars must keep the Trace link');
  const at65 = auditFunctions.auditEventLinks('operation:' + 'x'.repeat(65));
  assert.equal(at65.trace, null, '65 chars must drop the Trace link');
  assert.ok(at65.audit !== null, 'the Audit link must survive');
  return '64 keeps, 65 drops, audit survives';
});

check('L4 the resource limit is inclusive at 128 and exclusive at 129', () => {
  const at128 = auditFunctions.auditEventLinks('x'.repeat(128));
  assert.ok(at128.audit !== null, '128 chars must keep the Audit link');
  assert.equal(at128.trace, null);
  assert.deepEqual(auditFunctions.auditEventLinks('x'.repeat(129)), { audit: null, trace: null });
  return '128 keeps, 129 nulls both';
});

check('L5 empty, whitespace and control characters yield null links; a bare prefix keeps only the Audit link', () => {
  for (const bad of [null, undefined, '', '   ', 'operation:\u0000x', 'op\neration:x', 'a\u007fb']) {
    assert.deepEqual(auditFunctions.auditEventLinks(bad), { audit: null, trace: null }, 'accepted: ' + JSON.stringify(bad));
  }
  // A resource that is a valid audit filter but names no operation id still gets
  // its Audit link: only the Trace link needs the id (regex requires >= 1 char).
  assert.deepEqual(auditFunctions.auditEventLinks('operation:'),
    { audit: '/audit?resource=operation%3A', trace: null });
  return '7 rejected inputs; bare prefix keeps audit only';
});

check('L6 encoding is query-safe and no /operations link is ever produced', () => {
  const links = auditFunctions.auditEventLinks('  OPERATION:op /+?#:%  ');
  assert.equal(links.audit, '/audit?resource=OPERATION%3Aop+%2F%2B%3F%23%3A%25');
  assert.equal(links.trace, '/trace?operationId=op+%2F%2B%3F%23%3A%25');
  for (const value of Object.values(links)) {
    assert.ok(!String(value).includes('#'), 'a raw hash would truncate the URL');
    assert.ok(!String(value).includes(' '), 'a raw space must be encoded');
    assert.ok(!String(value).includes('/operations'), 'the deliberately unemitted operations link appeared');
  }
  assert.deepEqual(Object.keys(links).sort(), ['audit', 'trace']);
  return 'trim + encode; no raw #/space; no /operations link';
});

// ---------- workflow simulation helpers ----------------------------------
const wfFile = 'src/features/workflows/workflows-screen.tsx';
const wfSource = read(wfFile);
const wfAst = parse(wfFile, wfSource);

const simulationPayloadSource = (() => {
  let payload;
  const visit = (node) => {
    if (payload) return;
    if (ts.isIfStatement(node) && node.expression.getText(wfAst).includes("testSource === 'simulation'")) {
      const walk = (child) => {
        if (payload || ts.isFunctionLike(child)) return;
        if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === 'setTestResult') {
          const arg = child.arguments[0];
          if (arg && ts.isObjectLiteralExpression(arg)) { payload = arg.getText(wfAst); return; }
        }
        ts.forEachChild(child, walk);
      };
      walk(node.thenStatement);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(wfAst);
  assert.ok(payload, 'simulation payload not found');
  return payload;
})();

const simulationPanelSource = (() => {
  let expression;
  const visit = (node) => {
    if (expression) return;
    if (ts.isJsxExpression(node) && node.expression && ts.isConditionalExpression(node.expression)
      && node.expression.condition.getText(wfAst).includes("dataSource === 'simulation'")) {
      expression = node.expression.getText(wfAst);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(wfAst);
  assert.ok(expression, 'simulation panel branch not found');
  return expression;
})();

const stageCountSource = (() => {
  let expression;
  const visit = (node) => {
    if (expression) return;
    if (ts.isJsxExpression(node) && node.expression) {
      const text = node.expression.getText(wfAst);
      if (text.startsWith('wf.nodesCount ?? wf.stages?.length ??')) { expression = text; return; }
    }
    ts.forEachChild(node, visit);
  };
  visit(wfAst);
  assert.ok(expression, 'stage-count fallback not found');
  return expression;
})();

const makeResult = (stages) => new Function('selectedWorkflow', 'testInputVariables',
  `return (${simulationPayloadSource});`)({ slug: 'invoice-flow', stages }, { documentId: 'doc-17' });

const renderPanel = (testResult) => {
  const compiled = ts.transpileModule(`const panel = (${simulationPanelSource});`, {
    fileName: 'panel.tsx',
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
    reportDiagnostics: true,
  });
  const errors = (compiled.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')), []);
  const panel = new Function('React', 'testResult', compiled.outputText + '\nreturn panel;')(React, testResult);
  return renderToStaticMarkup(panel);
};

const stageCount = (wf) => new Function('wf', `return (${stageCountSource});`)(wf);

check('W1 the simulation payload is self-labelled and carries no fabricated operation id', () => {
  const one = makeResult(['validate']);
  assert.equal(one.status, 'SIMULATED_SUCCESS');
  assert.equal(one.dataSource, 'simulation');
  assert.deepEqual(one.simulatedStages, ['validate']);
  assert.match(one.message, /simulated locally; no backend request was sent/);
  assert.equal(Object.hasOwn(one, 'operationId'), false, 'a simulated run must not carry an operation id');
  assert.ok(!/sim-op/.test(wfSource), 'the old fabricated sim-op id is still present');
  assert.ok(!/sim-op/.test(simulationPayloadSource), 'the payload still fabricates an id');
  return 'SIMULATED_SUCCESS + simulation + no operationId + no sim-op';
});

check('W2 missing, null and empty stage lists all collapse to an empty simulation', () => {
  for (const stages of [undefined, null, []]) {
    const result = makeResult(stages);
    assert.deepEqual(result.simulatedStages, [], 'stages=' + JSON.stringify(stages));
    assert.equal(result.dataSource, 'simulation');
    assert.equal(result.status, 'SIMULATED_SUCCESS');
  }
  return '3 shapes -> []';
});

check('W3 the three render branches stay distinct (my own render assertions)', () => {
  const populated = renderPanel(makeResult(['validate', 'extract']));
  assert.match(populated, /Stages walked by this simulation \(2\):/);
  assert.match(populated, /validate, extract/);
  assert.doesNotMatch(populated, /configuration gap/);

  const empty = renderPanel(makeResult([]));
  assert.match(empty, /No stages defined for this workflow\./);
  assert.match(empty, /no stage ran/);
  assert.match(empty, /configuration gap, not a passing run/);
  assert.doesNotMatch(empty, /Stages walked by this simulation/);

  const backend = renderPanel({ dataSource: 'backend', stagesCompleted: [] });
  assert.match(backend, /No stage list returned for this run\./);
  assert.match(backend, /backend accepted the workflow but returned no stages/);
  assert.doesNotMatch(backend, /No stages defined for this workflow\./);
  return 'populated / empty simulation / empty backend all distinct';
});

check('W4 the stage-count fallback never turns a real zero into one', () => {
  assert.equal(stageCount({ stages: [] }), 0);
  assert.equal(stageCount({}), 0);
  assert.equal(stageCount({ nodesCount: null, stages: null }), 0);
  assert.equal(stageCount({ nodesCount: 0, stages: ['a', 'b'] }), 0, 'an explicit 0 must win over stages.length');
  assert.equal(stageCount({ nodesCount: null, stages: ['a', 'b'] }), 2);
  assert.equal(stageCount({ nodesCount: 4, stages: ['a'] }), 4);
  assert.equal(stageCount({ stages: ['a', 'b', 'c'] }), 3);
  return '7 fixtures, including an explicit zero';
});

check('M1 neither suite can silently skip (each suite has its own fail-loud guards)', () => {
  const auditSuite = read('tests/audit-event-links.test.mjs');
  assert.ok(!/\.skip|\.only|xit\(|xdescribe\(|todo\(/.test(auditSuite), 'audit suite has skip/only/todo');
  assert.match(auditSuite, /assert\.deepEqual\(\[\.\.\.remaining\], \[\], /, 'audit suite lacks the missing-declaration guard');
  assert.match(auditSuite, /DiagnosticCategory\.Error/, 'audit suite lacks the diagnostics guard');

  const wfSuite = read('tests/workflow-simulation-honesty.test.mjs');
  assert.ok(!/\.skip|\.only|xit\(|xdescribe\(|todo\(/.test(wfSuite), 'workflow suite has skip/only/todo');
  // The workflow suite guards differently: three finders, each asserting it FOUND
  // the real expression, plus the diagnostics guard and a real render.
  assert.match(wfSuite, /assert\.ok\(payload, 'simulation branch must set a result object'\)/);
  assert.match(wfSuite, /assert\.ok\(expression, 'result panel must keep the simulation-specific stage branch'\)/);
  assert.match(wfSuite, /assert\.ok\(expression, 'workflow row must use an explicit zero fallback for stage count'\)/);
  assert.match(wfSuite, /DiagnosticCategory\.Error/);
  assert.match(wfSuite, /renderToStaticMarkup/, 'panel is not really rendered');
  return 'audit: remaining+diagnostics; workflow: 3 finder asserts+diagnostics+real render';
});

const failed = results.filter((r) => !r.pass);
for (const r of results) console.log((r.pass ? 'ok   ' : 'FAIL ') + r.name + (r.detail ? ' :: ' + r.detail : ''));
console.log('PROBE_RESULT ' + (results.length - failed.length) + '/' + results.length + ' checks passed');
process.exitCode = failed.length === 0 ? 0 : 1;
