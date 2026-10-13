import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  buildTraceLinks,
  buildTraceTimeline,
  findOperationByTaskId,
  getTracePayloadPreview,
  legacyOperationsWorkspacePath,
  maskSensitivePayload,
  normalizeTraceLookup,
  traceWorkspacePath,
} from '../src/features/trace/state.ts';

const operation = {
  id: 'operation-1',
  state: 'FAILED',
  tenantId: 'tenant-a',
  businessId: 'business-a',
  action: 'extract',
  createdAt: '2026-10-10T10:00:00.000Z',
  updatedAt: '2026-10-10T10:03:00.000Z',
  startedAt: '2026-10-10T10:01:00.000Z',
  completedAt: '2026-10-10T10:03:00.000Z',
  retryOf: null,
  errorCode: 'PROVIDER_FAILED',
  deadlineAt: null,
  progress: { percent: 63, message: 'Waiting for parallel checks' },
};

function detailFor(id, taskId = 'task-2') {
  return {
    operation: { ...operation, id },
    tasks: [{
      id: taskId, taskKey: 'root', kind: 'extract', state: 'FAILED', attempt: 2, maxAttempts: 3, errorCode: 'PROVIDER_FAILED',
      spawnedBy: 'parent-task', leasedBy: 'worker-7', leaseExpiresAt: '2026-10-10T10:04:00.000Z', dueAt: null,
      admissionParkedReason: 'VERSION_NOT_ACTIVE', admissionParkedAt: '2026-10-10T10:02:45.000Z',
      awaitedChildren: [{ taskId: 'check-a', joinPolicy: 'all-success' }, { taskId: 'check-b', joinPolicy: 'all-success' }],
    }],
    requestInput: { status: 'REDACTED', data: { document: 'private document', apiKey: 'secret-key' }, ruleCount: 1 },
    result: {
      usage: { inputTokens: 41, outputTokens: 12, costMicrousd: 900, measurement: 'measured' },
      data: { resultRef: 'private-result-reference' },
    },
    artifacts: [],
    serverNow: '2026-10-10T10:04:00.000Z',
  };
}

describe('trace state helpers', () => {
  it('normalizes identifiers and rejects empty, control characters, and overlong values', () => {
    assert.equal(normalizeTraceLookup('  op-123  '), 'op-123');
    assert.equal(normalizeTraceLookup(''), null);
    assert.equal(normalizeTraceLookup('bad\nvalue'), null);
    assert.equal(normalizeTraceLookup('x'.repeat(201)), null);
  });

  it('scans operations only inside the selected tenant and finds the exact task ID', async () => {
    const queries = [];
    const detailsRequested = [];
    const api = {
      async listOperations(query) {
        queries.push(query);
        if (query.cursor === undefined) {
          return { ok: true, status: 200, data: {
            items: [{ ...operation, id: 'operation-1' }], total: 2, limit: 1, nextCursor: 'cursor-2', prevCursor: null,
          } };
        }
        return { ok: true, status: 200, data: {
          items: [{ ...operation, id: 'operation-2' }], total: 2, limit: 1, nextCursor: null, prevCursor: 'cursor-1',
        } };
      },
      async getOperation(id) {
        detailsRequested.push(id);
        return { ok: true, status: 200, data: detailFor(id, id === 'operation-2' ? 'task-target' : 'task-other') };
      },
    };

    const result = await findOperationByTaskId('task-target', 'tenant-a', api);
    assert.equal(result.kind, 'found');
    assert.equal(result.detail.operation?.id, 'operation-2');
    assert.equal(result.detail.tasks?.[0]?.admissionParkedReason, 'VERSION_NOT_ACTIVE');
    assert.equal(result.detail.tasks?.[0]?.admissionParkedAt, '2026-10-10T10:02:45.000Z');
    assert.deepEqual(detailsRequested, ['operation-1', 'operation-2']);
    assert.equal(queries[0].tenant, 'tenant-a');
    assert.equal(queries[0].limit, '100');
    assert.equal(queries[1].cursor, 'cursor-2');
    assert.ok(queries.every((query) => query.tenant === 'tenant-a'));
  });

  it('refuses an unscoped task lookup without calling the API', async () => {
    let called = false;
    const result = await findOperationByTaskId('task-a', null, {
      async listOperations() { called = true; throw new Error('must not call'); },
      async getOperation() { called = true; throw new Error('must not call'); },
    });
    assert.equal(result.kind, 'failed');
    assert.equal(result.problem.code, 'TENANT_SCOPE_REQUIRED');
    assert.equal(called, false);
  });

  it('merges operation, task, usage, and tenant-filtered audit events in time order', () => {
    const detail = {
      ...detailFor('operation-1'),
      operation,
      raw: detailFor('operation-1'),
    };
    const timeline = buildTraceTimeline(detail, {
      items: [
        { id: 'audit-1', kind: 'operation.cancel', severity: 'warning', occurredAt: '2026-10-10T10:02:00.000Z', tenantId: 'tenant-a', resourceId: 'operation:operation-1', actor: 'operator' },
        { id: 'audit-other', kind: 'other', severity: 'info', occurredAt: '2026-10-10T10:02:30.000Z', tenantId: 'tenant-a', resourceId: 'operation:another-id', actor: 'operator' },
      ],
      total: 2,
      limit: 100,
      nextCursor: null,
      prevCursor: null,
    });

    assert.deepEqual(timeline.map((item) => item.source), ['operation', 'operation', 'audit', 'operation', 'operation', 'task', 'usage']);
    assert.ok(timeline.some((item) => item.title === 'root snapshot'));
    const progress = timeline.find((item) => item.title === 'Latest progress snapshot');
    assert.match(progress?.summary ?? '', /63% · Waiting for parallel checks/);
    const task = timeline.find((item) => item.source === 'task');
    assert.match(task?.summary ?? '', /attempt 2\/3/);
    assert.match(task?.summary ?? '', /spawned by parent-task/);
    assert.match(task?.summary ?? '', /awaits child join check-a \(all-success\), check-b \(all-success\)/);
    assert.match(task?.summary ?? '', /parked: VERSION_NOT_ACTIVE/);
    assert.match(task?.summary ?? '', /parked since 2026-10-10T10:02:45.000Z/);
    assert.doesNotMatch(task?.summary ?? '', /depends on/);
    assert.match(task?.summary ?? '', /worker worker-7/);
    assert.ok(timeline.some((item) => item.title === 'Usage summary' && item.summary.includes('900 micro-USD')));
    assert.ok(!timeline.some((item) => item.title === 'other'));
  });

  it('masks every payload scalar before rendering a preview', () => {
    const payload = {
      apiKey: 'sk-live-secret',
      nested: [{ token: 'bearer-secret', documentText: 'private customer text', count: 7 }],
    };
    const masked = JSON.stringify(maskSensitivePayload(payload));
    assert.ok(!masked.includes('sk-live-secret'));
    assert.ok(!masked.includes('bearer-secret'));
    assert.ok(!masked.includes('private customer text'));
    assert.ok(!masked.includes('"count":7'));
    assert.ok(!masked.includes('documentText'));

    const preview = JSON.stringify(getTracePayloadPreview({ raw: { requestInput: payload, result: { resultRef: 'private-result-reference' } } }));
    assert.ok(!preview.includes('private-result-reference'));
  });

  it('builds tenant-aware deep links to the Operations and Audit screens', () => {
    const links = buildTraceLinks('op / 1', 'tenant-a');
    assert.equal(links.operations, '/trace?view=operations&id=op+%2F+1&tenantId=tenant-a');
    assert.equal(links.audit, '/audit?tenantId=tenant-a&resource=operation%3Aop+%2F+1');
  });

  it('keeps legacy Operations filters, cursors, detail links and hashes in the Trace workspace', () => {
    assert.equal(
      legacyOperationsWorkspacePath('?id=op-7&cursor=cursor-2&state=FAILED&operation=op-7', '#detail'),
      '/trace?id=op-7&cursor=cursor-2&state=FAILED&operation=op-7&view=operations#detail',
    );
    assert.equal(traceWorkspacePath('?id=op-7&cursor=cursor-2&view=trace', 'operations'), '/trace?id=op-7&cursor=cursor-2&view=operations');
    assert.equal(traceWorkspacePath('?operationId=op-7&tenantId=tenant-a&view=operations', 'trace'), '/trace?operationId=op-7&tenantId=tenant-a');
  });

  it('registers /trace and exposes it in workspace navigation', async () => {
    const [router, shell, route] = await Promise.all([
      readFile(new URL('../src/router.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../src/app-shell/app-shell.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../src/routes/trace.tsx', import.meta.url), 'utf8'),
    ]);
    assert.match(router, /import \{ TraceRoute \} from '@\/routes\/trace'/);
    assert.match(router, /path: 'trace', Component: TraceRoute/);
    assert.match(shell, /\['Trace', '\/trace'\]/);
    assert.doesNotMatch(shell, /\['Operations', '\/operations'\]/);
    assert.match(route, /TraceScreen/);
    assert.match(route, /aria-label="Trace workspace views"/);
  });
});
