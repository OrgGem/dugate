import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  checkWorkflowSchemaDraft,
  connectorReferences,
  updateConnectorReference,
  workflowSchemaDiff,
} from '../../../apps/admin-web/src/features/workflows/revision-editor';

const operationsPath = resolve(__dirname, '../../../apps/admin-web/src/features/operations/operations-screen.tsx');
const callbacksPath = resolve(__dirname, '../../../apps/admin-web/src/features/operations/callback-deliveries.tsx');
const workflowsPath = resolve(__dirname, '../../../apps/admin-web/src/features/workflows/workflows-screen.tsx');

describe('ORV13 UI13 journeys owner checks', () => {
  test('revision editor checks JSON structure and pins a stable workflow slug', () => {
    const valid = JSON.stringify({ slug: 'invoice-flow', nodes: [{ id: 'extract', type: 'connector' }], flow: ['extract'] });
    expect(checkWorkflowSchemaDraft(valid, 'invoice-flow')).toMatchObject({ ok: true });
    expect(checkWorkflowSchemaDraft('{invalid', 'invoice-flow')).toMatchObject({ ok: false });
    expect(checkWorkflowSchemaDraft(valid, 'other-flow')).toMatchObject({ ok: false, message: expect.stringContaining('pinned') });
    expect(checkWorkflowSchemaDraft(JSON.stringify({ slug: 'invoice-flow', nodes: [], flow: [] }), 'invoice-flow')).toMatchObject({ ok: false });
  });

  test('connector references include nested branch paths and updates do not mutate the source', () => {
    const schema = {
      slug: 'flow',
      nodes: [
        { id: 'first', type: 'connector', connector: 'doc-core' },
        { id: 'parallel', type: 'parallel', branches: [[{ id: 'second', type: 'connector', connector: 'review' }]] },
      ],
      flow: ['first', 'parallel'],
    };
    const references = connectorReferences(schema);
    expect(references.map(reference => reference.nodeId)).toEqual(['first', 'second']);
    const next = updateConnectorReference(schema, references[1]!.path, 'review-v2') as typeof schema;
    expect(JSON.stringify(next)).toContain('review-v2');
    expect(JSON.stringify(schema)).toContain('"connector":"review"');
    expect(() => updateConnectorReference(schema, ['__proto__', 'polluted'], 'bad')).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('workflow diff reports a bounded change while retaining context', () => {
    expect(workflowSchemaDiff('a\nbefore\nc', 'a\nafter\nc')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'before' },
      { kind: 'added', text: 'after' },
      { kind: 'same', text: 'c' },
    ]);
    expect(workflowSchemaDiff('same', 'same')).toEqual([{ kind: 'same', text: 'No schema changes.' }]);
  });

  test('operation detail actions wrap on narrow screens without compressing the download link', () => {
    const operations = readFileSync(operationsPath, 'utf8');
    expect(operations).toContain('className="flex min-w-0 flex-wrap items-center gap-2"');
    expect(operations).toContain('className="shrink-0 whitespace-nowrap text-sm underline"');
  });

  test('operator journeys use current tenant detail, safe confirmations, and expected-revision workflow publishing', () => {
    const operations = readFileSync(operationsPath, 'utf8');
    const callbacks = readFileSync(callbacksPath, 'utf8');
    const workflows = readFileSync(workflowsPath, 'utf8');

    expect(operations).toContain("searchParams.get('operation')");
    expect(operations).toContain('Retry detail load');
    expect(operations).toContain('client.deleteOperation(op.id, key)');
    expect(operations).toContain('expectedStateVersion');
    expect(operations).not.toContain('window.confirm');
    expect(callbacks).toContain('expectedAttempts: delivery.attempts');
    expect(callbacks).toContain('ConfirmDialog');
    expect(callbacks).toContain('Retry loading callbacks');
    expect(workflows).toContain('expectedRevision: target.revision');
    expect(workflows).toContain('Edit active revision');
    expect(workflows).toContain('checkWorkflowSchemaDraft');
    expect(workflows).toContain('workflowSchemaDiff');
    expect(workflows).toContain('platform administrator session');
    expect(workflows).not.toContain('if (!confirm(');
  });
});
