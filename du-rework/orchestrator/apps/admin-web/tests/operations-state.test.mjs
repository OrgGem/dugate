import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import ts from 'typescript';
import {
  buildOperationsQuery,
  operationsCursorIsStale,
  operationsPopulation,
  operationsTimeWindow,
  operationsWindowInvalid,
  parseOperationDetail,
  parseOperationsPage,
} from '../src/features/operations/state.ts';

// AWEB-20a: the Operations screen used to filter dates in the BROWSER over the
// page it happened to have loaded, so a matching operation on page 2 was
// invisible. The admin list route already accepts server-side bounds
// (modules/operations/list-query.ts parses `from`/`to` into SQL predicates) and
// the BFF allowlists them (app/admin/bff/operations.ts OPERATIONS_PARAM_ALLOWLIST).
// These tests pin the wire query that turns the date pickers into that server
// filter instead of a client-side trim.

const baseInput = {
  limit: '50',
  state: 'ALL',
  sort: 'created_at:desc',
  tenantId: 'tenant-a',
  id: '',
  business: '',
  action: '',
  apiKey: '',
  profile: '',
  correlation: '',
  provider: '',
  model: '',
  usage: 'any',
  reservation: 'any',
  attention: 'any',
  cursor: null,
  fromDate: '',
  toDate: '',
};

// Mirror of ADMIN_LIST_TIME_PATTERN (packages/contracts/src/public-api.ts:532)
// - the backend stays the authority and answers 422 on a bad instant.
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

function assertAcceptedInstant(value) {
  assert.match(value, UTC_INSTANT);
  assert.equal(
    new Date(Date.parse(value)).toISOString().slice(0, 19),
    value.slice(0, 19),
    'the instant must be a real calendar day, not a rolled-over one',
  );
}

describe('buildOperationsQuery', () => {
  it('always carries the paging and ordering parameters', () => {
    // A platform session with no tenant selected asks for the cross-tenant list,
    // so an absent tenant must stay absent rather than becoming an empty string.
    assert.deepEqual(buildOperationsQuery({ ...baseInput, tenantId: null }), {
      limit: '50',
      sort: 'created_at:desc',
    });
  });

  it('passes the tenant and a non-empty id filter through', () => {
    assert.deepEqual(buildOperationsQuery({ ...baseInput, id: 'op_123 ' }), {
      limit: '50',
      sort: 'created_at:desc',
      tenant: 'tenant-a',
      id: 'op_123',
    });
  });

  it('omits ALL so the wire never carries a state the contract does not define', () => {
    const query = buildOperationsQuery({ ...baseInput, state: 'FAILED' });
    assert.equal(query['state'], 'FAILED');
    assert.equal(buildOperationsQuery(baseInput)['state'], undefined);
  });

  it('carries a cursor when paging', () => {
    assert.equal(buildOperationsQuery({ ...baseInput, cursor: 'abc' })['cursor'], 'abc');
    assert.equal(buildOperationsQuery(baseInput)['cursor'], undefined);
  });

  it('turns empty date inputs into no server bound at all', () => {
    const query = buildOperationsQuery(baseInput);
    assert.equal(Object.hasOwn(query, 'from'), false);
    assert.equal(Object.hasOwn(query, 'to'), false);
  });

  it('turns a half-open window into the bound that was asked for', () => {
    const onlyFrom = buildOperationsQuery({ ...baseInput, fromDate: '2026-10-01' });
    assert.equal(onlyFrom['from'], '2026-10-01T00:00:00.000Z');
    assert.equal(Object.hasOwn(onlyFrom, 'to'), false);
    const onlyTo = buildOperationsQuery({ ...baseInput, toDate: '2026-10-10' });
    assert.equal(onlyTo['to'], '2026-10-10T23:59:59.999Z');
    assert.equal(Object.hasOwn(onlyTo, 'from'), false);
  });

  it('sends an inclusive UTC day window that the admin list contract accepts', () => {
    const query = buildOperationsQuery({ ...baseInput, fromDate: '2026-10-01', toDate: '2026-10-10' });
    assert.equal(query['from'], '2026-10-01T00:00:00.000Z');
    assert.equal(query['to'], '2026-10-10T23:59:59.999Z');
    assertAcceptedInstant(String(query['from']));
    assertAcceptedInstant(String(query['to']));
  });

  it('keeps the same inclusive-day bounds as the previous client-side filter', () => {
    // The old in-window helper used T00:00:00.000Z and T23:59:59.999Z too; the
    // operator mental model (pick a day, get that whole UTC day) must not shift.
    assert.deepEqual(operationsTimeWindow('2026-10-01', '2026-10-10'), {
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-10T23:59:59.999Z',
    });
    assert.deepEqual(operationsTimeWindow('', ''), { from: null, to: null });
  });
});

describe('operation progress and task graph parsing', () => {
  it('keeps reported progress, spawn ancestry, retries, and parent child-join semantics', () => {
    const detail = parseOperationDetail({
      operation: { id: 'op-1', state: 'RUNNING', progress: { percent: 42, message: 'Parsing pages' } },
      tasks: [{
        id: 'task-parent', taskKey: 'split', kind: 'workflow', state: 'WAITING_CHILDREN',
        spawnedBy: null, leasedBy: 'worker-a', leaseExpiresAt: '2026-10-13T00:00:30Z', dueAt: null,
        attempt: 1, maxAttempts: 4, errorCode: null,
        awaitedChildren: [{ taskId: 'task-east', joinPolicy: 'all-success' }, { taskId: 'task-west', joinPolicy: 'all-success' }],
      }, {
        id: 'task-child', taskKey: 'check-east', kind: 'check', state: 'READY',
        spawnedBy: 'task-parent', leasedBy: null, leaseExpiresAt: null, dueAt: null,
        admissionParkedReason: 'VERSION_NOT_ACTIVE', admissionParkedAt: '2026-10-13T00:02:30.000Z',
        attempt: 0, maxAttempts: 4, errorCode: null, awaitedChildren: [],
      }],
    });

    assert.equal(detail?.operation?.progress?.percent, 42);
    assert.equal(detail?.operation?.progress?.message, 'Parsing pages');
    assert.deepEqual(detail?.tasks?.[0], {
      id: 'task-parent', taskKey: 'split', kind: 'workflow', state: 'WAITING_CHILDREN',
      spawnedBy: null, leasedBy: 'worker-a', leaseExpiresAt: '2026-10-13T00:00:30Z', dueAt: null,
      awaitedChildren: [{ taskId: 'task-east', joinPolicy: 'all-success' }, { taskId: 'task-west', joinPolicy: 'all-success' }],
      attempt: 1, maxAttempts: 4, errorCode: null,
    });
    assert.equal(detail?.tasks?.[1]?.spawnedBy, 'task-parent');
    assert.equal(detail?.tasks?.[1]?.admissionParkedReason, 'VERSION_NOT_ACTIVE');
    assert.equal(detail?.tasks?.[1]?.admissionParkedAt, '2026-10-13T00:02:30.000Z');
    assert.deepEqual(detail?.tasks?.[1]?.awaitedChildren, []);
    assert.equal('dependsOn' in (detail?.tasks?.[1] ?? {}), false);
  });

  it('distinguishes explicit unparked state from an older response with no admission fields', () => {
    const explicit = parseOperationDetail({ tasks: [{ id: 'task-a', admissionParkedReason: null, admissionParkedAt: null }] });
    const older = parseOperationDetail({ tasks: [{ id: 'task-b' }] });
    assert.equal(explicit?.tasks?.[0]?.admissionParkedReason, null);
    assert.equal(explicit?.tasks?.[0]?.admissionParkedAt, null);
    assert.equal(older?.tasks?.[0]?.admissionParkedReason, undefined);
    assert.equal(older?.tasks?.[0]?.admissionParkedAt, undefined);
  });

  it('ignores invalid progress instead of displaying an impossible percent', () => {
    const detail = parseOperationDetail({ operation: { id: 'op-1', state: 'RUNNING', progress: { percent: 101 } } });
    assert.equal(detail?.operation?.progress, undefined);
  });
});

// AWEB-20: a keyset cursor addresses one population. The route cannot detect
// a changed tenant/state/window because the token carries only position and
// sort (list-query.ts encodeOperationsListCursor), so the screen has to drop it.
const baseFilters = {
  state: 'ALL',
  sort: 'created_at:desc',
  tenantId: 'tenant-a',
  id: '',
  business: '',
  action: '',
  apiKey: '',
  profile: '',
  correlation: '',
  provider: '',
  model: '',
  usage: 'any',
  reservation: 'any',
  attention: 'any',
  fromDate: '',
  toDate: '',
  limit: '50',
};

const screenFilterBindings = {
  sort: 'created_at:desc',
  businessFilter: '',
  actionFilter: '',
  apiKeyFilter: '',
  profileFilter: '',
  correlationFilter: '',
  providerFilter: '',
  modelFilter: '',
  usageFilter: 'any',
  reservationFilter: 'any',
  attentionFilter: 'any',
};

describe('operations population fingerprint', () => {
  it('is stable when nothing the operator selected changed', () => {
    assert.equal(
      operationsPopulation(baseFilters),
      operationsPopulation({ ...baseFilters }),
      'a re-render with the same filters must not invalidate a live cursor',
    );
  });

  for (const [field, value] of [
    ['state', 'FAILED'],
    ['tenantId', 'tenant-b'],
    ['id', 'op_9'],
    ['fromDate', '2026-10-01'],
    ['toDate', '2026-10-10'],
    ['limit', '100'],
  ]) {
    it(`changes when ${field} changes`, () => {
      assert.notEqual(
        operationsPopulation(baseFilters),
        operationsPopulation({ ...baseFilters, [field]: value }),
        `${field} shapes which rows the query returns, so it must change the population`,
      );
    });
  }

  it('trims the id filter so typing a trailing space does not churn the population', () => {
    assert.equal(
      operationsPopulation({ ...baseFilters, id: 'op_9' }),
      operationsPopulation({ ...baseFilters, id: ' op_9 ' }),
      'the wire trims the id, so the fingerprint must too',
    );
  });

  it('treats an absent tenant and an empty one as the same population', () => {
    // buildOperationsQuery drops both from the wire, so both ask the route for
    // the same cross-tenant list; marking them different would drop a live
    // cursor for no operator-visible change.
    assert.equal(
      operationsPopulation({ ...baseFilters, tenantId: null }),
      operationsPopulation({ ...baseFilters, tenantId: '' }),
    );
  });
});

describe('operationsCursorIsStale', () => {
  it('never fires when there is no cursor to lose', () => {
    assert.equal(operationsCursorIsStale(null, 'any', 'different'), false);
  });

  it('keeps the cursor while the population is unchanged so paging keeps working', () => {
    const scope = operationsPopulation(baseFilters);
    assert.equal(operationsCursorIsStale('cursor-2', scope, scope), false);
  });

  it('drops a cursor minted for another tenant - the AWEB-20 defect', () => {
    const tenantA = operationsPopulation(baseFilters);
    const tenantB = operationsPopulation({ ...baseFilters, tenantId: 'tenant-b' });
    assert.notEqual(tenantA, tenantB);
    assert.equal(operationsCursorIsStale('cursor-for-a', tenantA, tenantB), true);
  });

  it('drops the cursor for a changed state, window, id or page size', () => {
    const scope = operationsPopulation(baseFilters);
    for (const change of [
      { state: 'FAILED' },
      { fromDate: '2026-10-01' },
      { toDate: '2026-10-10' },
      { id: 'op_9' },
      { limit: '100' },
    ]) {
      assert.equal(
        operationsCursorIsStale('cursor-2', scope, operationsPopulation({ ...baseFilters, ...change })),
        true,
        JSON.stringify(change) + ' must invalidate the cursor',
      );
    }
  });

  it('fails safe when the cursor origin was never recorded', () => {
    assert.equal(
      operationsCursorIsStale('cursor-unknown', null, operationsPopulation(baseFilters)),
      true,
      'an untraceable cursor is dropped rather than replayed against a population nobody recorded',
    );
  });
});

function extractOperationsLoad(source) {
  const sourceFile = ts.createSourceFile(
    'operations-screen.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let declaration;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === 'load'
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression)
      && node.initializer.expression.text === 'useCallback'
    ) {
      declaration = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.ok(declaration, 'OperationsScreen must define its request callback with useCallback');
  const [callback, dependencies] = declaration.initializer.arguments;
  assert.ok(callback && ts.isArrowFunction(callback), 'the load callback must be an arrow function');
  return {
    compiled: ts.transpileModule(callback.getText(sourceFile), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    dependencies: dependencies && ts.isArrayLiteralExpression(dependencies)
      ? dependencies.elements.filter(ts.isIdentifier).map((item) => item.text)
      : [],
  };
}

async function readOperationsLoad() {
  const source = await readFile(new URL('../src/features/operations/operations-screen.tsx', import.meta.url), 'utf8');
  return extractOperationsLoad(source);
}

function makeOperationsLoad(compiled, bindings) {
  const names = Object.keys(bindings);
  const expression = compiled.trim().replace(/;\s*$/, '');
  return new Function(...names, `return (${expression});`)(...names.map((name) => bindings[name]));
}

describe('Operations screen request wiring', () => {
  it('shows durable admission parking reason and timestamp in the task table', async () => {
    const source = await readFile(new URL('../src/features/operations/operations-screen.tsx', import.meta.url), 'utf8');
    assert.match(source, /<TableHead className="text-xs">Admission<\/TableHead>/);
    assert.match(source, /task\.admissionParkedReason/);
    assert.match(source, /task\.admissionParkedAt/);
    assert.match(source, /Parked · \{task\.admissionParkedReason\}/);
    assert.match(source, /Not parked/);
  });

  it('sends the selected date window as ISO UTC bounds and tracks it in load dependencies', async () => {
    const { compiled, dependencies } = await readOperationsLoad();
    for (const dependency of ['fromDate', 'toDate', 'globalTenantId', 'selectedPopulation']) {
      assert.ok(dependencies.includes(dependency), `load must refresh when ${dependency} changes`);
    }

    let requestedQuery;
    const population = operationsPopulation({
      ...baseFilters,
      fromDate: '2026-10-01',
      toDate: '2026-10-10',
      limit: '20',
    });
    const load = makeOperationsLoad(compiled, {
      fromDate: '2026-10-01',
      toDate: '2026-10-10',
      cursor: null,
      mintedPopulation: { current: null },
      selectedPopulation: population,
      listRequest: { current: 0 },
      detailRequest: { current: 0 },
      setPage: () => {},
      setDetail: () => {},
      setDetailProblem: () => {},
      setCursor: () => {},
      client: {
        listOperations: async (query) => {
          requestedQuery = query;
          return { ok: true, data: { items: [], nextCursor: null } };
        },
      },
      ...screenFilterBindings,
      limit: '20',
      stateFilter: 'ALL',
      globalTenantId: 'tenant-a',
      idFilter: '',
      invalidSearchLabel: null,
      updateSearch: () => {},
      operationsWindowInvalid,
      operationsCursorIsStale,
      buildOperationsQuery,
      parseOperationsPage,
    });

    await load();
    assert.deepEqual(requestedQuery, {
      limit: '20',
      sort: 'created_at:desc',
      tenant: 'tenant-a',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-10T23:59:59.999Z',
    });
  });

  it('drops a cursor from a previous population before making a list request', async () => {
    const { compiled, dependencies } = await readOperationsLoad();
    assert.ok(dependencies.includes('cursor'), 'load must refresh when the cursor is reset');
    const oldPopulation = operationsPopulation({ ...baseFilters, limit: '20' });
    const newPopulation = operationsPopulation({ ...baseFilters, tenantId: 'tenant-b', limit: '20' });
    const resets = [];
    let requestCount = 0;
    const load = makeOperationsLoad(compiled, {
      fromDate: '',
      toDate: '',
      cursor: 'cursor-for-tenant-a',
      mintedPopulation: { current: oldPopulation },
      selectedPopulation: newPopulation,
      listRequest: { current: 0 },
      detailRequest: { current: 0 },
      setPage: () => {},
      setDetail: () => {},
      setDetailProblem: () => {},
      setCursor: (value) => resets.push(value),
      client: {
        listOperations: async () => {
          requestCount += 1;
          return { ok: true, data: { items: [], nextCursor: null } };
        },
      },
      ...screenFilterBindings,
      limit: '20',
      stateFilter: 'ALL',
      globalTenantId: 'tenant-b',
      idFilter: '',
      invalidSearchLabel: null,
      updateSearch: () => {},
      operationsWindowInvalid,
      operationsCursorIsStale,
      buildOperationsQuery,
      parseOperationsPage,
    });

    await load();
    assert.equal(requestCount, 0);
    assert.deepEqual(resets, [null]);
  });
});
