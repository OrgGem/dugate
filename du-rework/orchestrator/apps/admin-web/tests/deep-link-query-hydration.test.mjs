import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { localDateTimeToUtc } from '../src/features/audit/state.ts';
import { normalizeTraceLookup } from '../src/features/trace/state.ts';

function extractDeclarations(source, fileName, names) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const remaining = new Set(names);
  const declarations = [];

  for (const statement of sourceFile.statements) {
    const name = ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement)
      ? statement.name?.text
      : undefined;
    if (name && remaining.has(name)) {
      declarations.push(statement.getText(sourceFile));
      remaining.delete(name);
    }
  }

  assert.deepEqual([...remaining], [], `${fileName} must retain the hydration helpers covered here`);
  return declarations.join('\n\n');
}

function loadHelpers(source, fileName, declarations, functionNames, dependencies = {}) {
  const compiled = ts.transpileModule(extractDeclarations(source, fileName, declarations), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
    reportDiagnostics: true,
  });
  const errors = (compiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);

  const dependencyNames = Object.keys(dependencies);
  const helperFactory = new Function(
    ...dependencyNames,
    `${compiled.outputText}\nreturn { ${functionNames.join(', ')} };`,
  );
  return helperFactory(...dependencyNames.map((name) => dependencies[name]));
}

function getVariableInitializer(source, fileName, variableName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === variableName) {
      initializer = node.initializer?.getText(sourceFile);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.ok(initializer, `${fileName} must retain the ${variableName} guard`);
  return initializer;
}

function getTenantAvailabilityGuard(source, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let condition;
  const visit = (node) => {
    if (ts.isIfStatement(node)) {
      const candidate = node.expression.getText(sourceFile);
      if (candidate.includes('tenants.some') && candidate.includes('requestedTenantId')) condition = candidate;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.ok(condition, `${fileName} must retain the available-tenant guard`);
  return condition;
}

function evaluateExpression(expression, bindings) {
  const names = Object.keys(bindings);
  return new Function(...names, `return (${expression});`)(...names.map((name) => bindings[name]));
}

const traceFile = 'src/features/trace/trace-screen.tsx';
const auditFile = 'src/features/audit/audit-screen.tsx';
const [traceSource, auditSource] = await Promise.all([
  readFile(new URL(`../${traceFile}`, import.meta.url), 'utf8'),
  readFile(new URL(`../${auditFile}`, import.meta.url), 'utf8'),
]);

const trace = loadHelpers(
  traceSource,
  traceFile,
  ['TraceDeepLinkLookup', 'safeQueryValue', 'traceLookupFromQuery'],
  ['safeQueryValue', 'traceLookupFromQuery'],
  { normalizeTraceLookup },
);
const audit = loadHelpers(
  auditSource,
  auditFile,
  ['DraftFilters', 'safeQueryValue', 'queryTimeToLocalInput', 'auditFiltersFromQuery'],
  ['safeQueryValue', 'queryTimeToLocalInput', 'auditFiltersFromQuery'],
  { localDateTimeToUtc },
);

function localInputFor(utcValue) {
  const instant = new Date(utcValue);
  return new Date(instant.getTime() - instant.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

describe('Trace and Audit URL query hydration', () => {
  it('hydrates each supported Trace identifier and preserves the lookup priority', () => {
    assert.deepEqual(trace.traceLookupFromQuery(new URLSearchParams('operationId=%20op-17%20')), {
      kind: 'operationId', value: 'op-17', error: null,
    });
    assert.deepEqual(trace.traceLookupFromQuery(new URLSearchParams('correlationId=corr-28')), {
      kind: 'correlationId', value: 'corr-28', error: null,
    });
    assert.deepEqual(trace.traceLookupFromQuery(new URLSearchParams('taskId=task-39')), {
      kind: 'taskId', value: 'task-39', error: null,
    });
    assert.deepEqual(trace.traceLookupFromQuery(new URLSearchParams('operationId=op-17&taskId=task-39')), {
      kind: 'operationId', value: 'op-17', error: null,
    });
    assert.equal(trace.traceLookupFromQuery(new URLSearchParams('operationId=bad%0Avalue')).error !== null, true);
  });

  it('uses safe defaults when Trace and Audit query parameters are missing', () => {
    const emptyQuery = new URLSearchParams();
    assert.deepEqual(trace.traceLookupFromQuery(emptyQuery), {
      kind: 'operationId', value: '', error: null,
    });
    assert.equal(trace.safeQueryValue(emptyQuery.get('tenantId')), null);
    assert.equal(audit.safeQueryValue(emptyQuery.get('tenantId'), 256), null);
    assert.equal(audit.safeQueryValue(emptyQuery.get('correlationId'), 200), null);
    assert.deepEqual(audit.auditFiltersFromQuery(emptyQuery), {
      draft: {
        severity: 'ALL', action: '', actor: '', resource: '', from: '', to: '',
        sort: 'createdAt:desc', limit: '50',
      },
      filters: {
        severity: 'ALL', action: '', actor: '', resource: '', from: '', to: '',
        sort: 'createdAt:desc', limit: '50',
      },
    });
  });

  it('reads Trace tenantId safely and retains its session tenant authorization fence', () => {
    const query = new URLSearchParams('tenantId=tenant-a');
    assert.equal(trace.safeQueryValue(query.get('tenantId')), 'tenant-a');
    assert.equal(trace.safeQueryValue('tenant-\u0000a'), null);
    assert.equal(trace.safeQueryValue('x'.repeat(201)), null);

    assert.match(traceSource, /const rawQueryTenantId = searchParams\.get\('tenantId'\);/);
    assert.match(traceSource, /const requestedTenantId = safeQueryValue\(rawQueryTenantId\);/);
    assert.match(traceSource, /if \(!tenants\.some\(\(item\) => item\.id === requestedTenantId\)\)/);
    assert.match(traceSource, /if \(tenantId !== requestedTenantId\) setTenantId\(requestedTenantId\);/);
    assert.match(traceSource, /const initialLookup = traceLookupFromQuery\(searchParams\);/);
    assert.match(traceSource, /traceLookupFromQuery\(new URLSearchParams\(searchQuery\)\)/);
  });

  it('blocks malformed and unavailable tenant context in both screens', () => {
    const sessionTenants = [{ id: 'tenant-a' }, { id: 'tenant-b' }];
    const requestedTenantId = trace.safeQueryValue(new URLSearchParams('tenantId=tenant-outside-session').get('tenantId'));
    assert.equal(requestedTenantId, 'tenant-outside-session');

    const traceAvailabilityGuard = getTenantAvailabilityGuard(traceSource, traceFile);
    const auditAvailabilityGuard = getTenantAvailabilityGuard(auditSource, auditFile);
    for (const guard of [traceAvailabilityGuard, auditAvailabilityGuard]) {
      assert.equal(evaluateExpression(guard, { tenants: sessionTenants, requestedTenantId }), true);
      assert.equal(evaluateExpression(guard, { tenants: sessionTenants, requestedTenantId: 'tenant-a' }), false);
    }

    for (const [source, fileName] of [[traceSource, traceFile], [auditSource, auditFile]]) {
      const blockedExpression = getVariableInitializer(source, fileName, 'tenantContextBlocked');
      assert.equal(evaluateExpression(blockedExpression, {
        tenantQueryError: null,
        rawQueryTenantId: 'tenant-outside-session',
        requestedTenantId,
        tenantId: 'tenant-a',
      }), true);
      assert.equal(evaluateExpression(blockedExpression, {
        tenantQueryError: 'The tenant ID in this link is invalid.',
        rawQueryTenantId: 'tenant-\u0000a',
        requestedTenantId: null,
        tenantId: 'tenant-a',
      }), true);
    }
  });

  it('maps Audit query filters, operationId resource fallback, and UTC time bounds', () => {
    const from = '2026-10-10T10:00:00.000Z';
    const to = '2026-10-10T12:30:00.000Z';
    const query = new URLSearchParams({
      tenantId: 'tenant-a',
      correlationId: 'corr-28',
      operationId: 'op-17',
      severity: 'WARNING',
      action: 'business.enable',
      actor: 'admin',
      from,
      to,
      sort: 'createdAt:asc',
      limit: '100',
    });
    const hydrated = audit.auditFiltersFromQuery(query);

    assert.equal(audit.safeQueryValue(query.get('tenantId'), 256), 'tenant-a');
    assert.equal(audit.safeQueryValue(query.get('correlationId'), 200), 'corr-28');
    assert.deepEqual(hydrated.draft, {
      severity: 'warning',
      action: 'business.enable',
      actor: 'admin',
      resource: 'operation:op-17',
      from: localInputFor(from),
      to: localInputFor(to),
      sort: 'createdAt:asc',
      limit: '100',
    });
    assert.deepEqual(hydrated.filters, {
      ...hydrated.draft,
      from: localDateTimeToUtc(hydrated.draft.from),
      to: localDateTimeToUtc(hydrated.draft.to),
    });

    const explicitResource = audit.auditFiltersFromQuery(
      new URLSearchParams('operationId=op-17&resource=business%3Abiz'),
    );
    assert.equal(explicitResource.draft.resource, 'business:biz');
  });

  it('ignores malformed and overlong UTC time bounds instead of hydrating them', () => {
    const malformedBounds = [
      'not-a-timestamp',
      '2026-13-01T10:00:00Z',
      '2026-10-10T25:61:00Z',
      'x'.repeat(65),
    ];
    for (const malformed of malformedBounds) {
      const hydrated = audit.auditFiltersFromQuery(new URLSearchParams({ from: malformed, to: malformed }));
      assert.equal(hydrated.draft.from, '');
      assert.equal(hydrated.draft.to, '');
      assert.equal(hydrated.filters.from, '');
      assert.equal(hydrated.filters.to, '');
    }
  });

  it('round-trips encoded special characters in Trace IDs and Audit filters', () => {
    const specialId = 'op /+?#:%';
    const specialCorrelationId = 'corr +/?#:%';
    const traceUrl = new URLSearchParams({ operationId: specialId, tenantId: 'tenant +/?#' }).toString();
    const parsedTraceUrl = new URLSearchParams(traceUrl);
    assert.deepEqual(trace.traceLookupFromQuery(parsedTraceUrl), {
      kind: 'operationId', value: specialId, error: null,
    });
    assert.equal(trace.safeQueryValue(parsedTraceUrl.get('tenantId')), 'tenant +/?#');

    const auditUrl = new URLSearchParams({
      correlationId: specialCorrelationId,
      operationId: specialId,
      action: 'business.enable+restore/?#:%',
      actor: 'ops + tier/?#',
    }).toString();
    const parsedAuditUrl = new URLSearchParams(auditUrl);
    const hydrated = audit.auditFiltersFromQuery(parsedAuditUrl);
    assert.equal(audit.safeQueryValue(parsedAuditUrl.get('correlationId'), 200), specialCorrelationId);
    assert.equal(hydrated.draft.action, 'business.enable+restore/?#:%');
    assert.equal(hydrated.draft.actor, 'ops + tier/?#');
    assert.equal(hydrated.draft.resource, `operation:${specialId}`);
  });

  it('wires Audit hydration and tenant scoping to the URL while retaining correlationId', () => {
    assert.equal(audit.safeQueryValue('tenant-\u0000a', 256), null);
    assert.equal(audit.safeQueryValue('corr-28', 200), 'corr-28');
    assert.match(auditSource, /const initialFilters = auditFiltersFromQuery\(searchParams\);/);
    assert.match(auditSource, /auditFiltersFromQuery\(new URLSearchParams\(searchQuery\)\)/);
    assert.match(auditSource, /const requestedTenantId = safeQueryValue\(rawQueryTenantId, 256\);/);
    assert.match(auditSource, /const correlationIdFromUrl = safeQueryValue\(searchParams\.get\('correlationId'\), 200\);/);
    assert.match(auditSource, /if \(!tenants\.some\(\(item\) => item\.id === requestedTenantId\)\)/);
    assert.match(auditSource, /tenantId === null \|\| tenantContextBlocked \|\| searchQuery !== hydratedSearchQuery\.current/);
  });
});
