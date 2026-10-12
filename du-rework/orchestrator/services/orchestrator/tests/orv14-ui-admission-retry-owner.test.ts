import {
  parseWorkflowOverrideRows,
  updateConnectorNodeOverride,
} from '../../../apps/admin-web/src/features/workflows/revision-editor';
import {
  acceptAttempt,
  classifyAdmissionFailure,
  createImmutableAttempt,
  retainAfterFailure,
} from '../../../apps/admin-web/src/features/submissions/immutable-attempt';

describe('ORV14 UI retry and guided workflow override owner checks', () => {
  test('captures a detached frozen request and preserves its original tenant/key across failure transitions', () => {
    const editable = { tenantId: 'tenant-a', artifacts: [{ artifactId: 'artifact-a' }], input: { mode: 'invoice' } };
    const attempt = createImmutableAttempt('tenant-a', 'attempt-1', editable);
    editable.artifacts[0]!.artifactId = 'artifact-b';
    editable.input.mode = 'edited';

    expect(attempt.request).toEqual({ tenantId: 'tenant-a', artifacts: [{ artifactId: 'artifact-a' }], input: { mode: 'invoice' } });
    expect(Object.isFrozen(attempt.request)).toBe(true);
    expect(Object.isFrozen(attempt.request.artifacts)).toBe(true);
    expect(Object.isFrozen(attempt.request.artifacts[0])).toBe(true);
    expect(classifyAdmissionFailure(0, attempt.state)).toBe('UNCERTAIN');
    const uncertain = retainAfterFailure(attempt, 0);
    expect(uncertain?.state).toBe('UNCERTAIN');
    expect(retainAfterFailure(uncertain!, 403)?.request).toBe(attempt.request);
    expect(retainAfterFailure(uncertain!, 409)?.idempotencyKey).toBe('attempt-1');
    expect(retainAfterFailure(uncertain!, 422)?.tenantId).toBe('tenant-a');
  });

  test('clears only a first definitive rejection and locks a positively accepted operation', () => {
    const attempt = createImmutableAttempt('tenant-a', 'attempt-2', { tenantId: 'tenant-a', input: { fixed: true } });
    expect(classifyAdmissionFailure(403, attempt.state)).toBe('DEFINITIVE_REJECTION');
    expect(retainAfterFailure(attempt, 403)).toBeNull();
    for (const status of [0, 408, 425, 429, 500, 502, 599]) {
      expect(classifyAdmissionFailure(status, 'READY')).toBe('UNCERTAIN');
    }
    const accepted = acceptAttempt(attempt, 'operation-7');
    expect(accepted).toMatchObject({ tenantId: 'tenant-a', idempotencyKey: 'attempt-2', state: 'ACCEPTED', operationId: 'operation-7' });
    expect(retainAfterFailure(accepted, 401)).toBe(accepted);
  });

  test('rejects an attempt when request scope or JSON shape is not safely snapshotable', () => {
    expect(() => createImmutableAttempt('tenant-b', 'attempt-3', { tenantId: 'tenant-a' })).toThrow(/tenant/);
    expect(() => createImmutableAttempt('tenant-a', 'attempt-3', { tenantId: 'tenant-a', input: Number.NaN })).toThrow(/non-finite/);
    const cyclic: { tenantId: string; self?: unknown } = { tenantId: 'tenant-a' };
    cyclic.self = cyclic;
    expect(() => createImmutableAttempt('tenant-a', 'attempt-3', cyclic)).toThrow();
  });

  test('parses bounded static form fields without coercing imported static values', () => {
    expect(parseWorkflowOverrideRows('staticFormFields', JSON.stringify([
      { name: 'mode', value: 'invoice' },
      { name: 'includeTables', value: true },
      { name: 'pageLimit', value: 4 },
    ]))).toEqual({
      ok: true,
      rows: [
        { name: 'mode', value: 'invoice' },
        { name: 'includeTables', value: true },
        { name: 'pageLimit', value: 4 },
      ],
    });
  });

  test('rejects duplicate, excessive, or unsafe static fields and protected extra headers', () => {
    expect(parseWorkflowOverrideRows('staticFormFields', JSON.stringify([
      { name: 'mode', value: 'one' }, { name: 'MODE', value: 'two' },
    ]))).toMatchObject({ ok: false });
    expect(parseWorkflowOverrideRows('staticFormFields', JSON.stringify([
      { name: 'api_key', value: 'secret' },
    ]))).toMatchObject({ ok: false });
    expect(parseWorkflowOverrideRows('staticFormFields', JSON.stringify(
      Array.from({ length: 33 }, (_, index) => ({ name: `field${index}`, value: 'x' })),
    ))).toMatchObject({ ok: false });
    expect(parseWorkflowOverrideRows('extraHeaders', JSON.stringify([
      { name: 'X-Api-Key', value: 'secret' },
    ]))).toMatchObject({ ok: false });
    expect(parseWorkflowOverrideRows('extraHeaders', JSON.stringify([
      { name: 'X-Mode', value: 'one' }, { name: 'x-mode', value: 'two' },
    ]))).toMatchObject({ ok: false });
  });

  test('updates one node override while retaining imported sibling fields, headers, and other nodes', () => {
    const source = {
      slug: 'invoice-flow',
      nodes: [
        { id: 'extract', type: 'connector', connector: 'ocr', overrideConnector: {
          prompt: 'Read invoice', timeoutSec: 45,
          staticFormFields: '[{"name":"mode","value":"old"}]',
          extraHeaders: '[{"name":"X-Mode","value":"invoice"}]',
        } },
        { id: 'review', type: 'connector', connector: 'review', overrideConnector: { prompt: 'Review' } },
      ],
      flow: ['extract', 'review'],
    };
    const next = updateConnectorNodeOverride(
      source,
      ['nodes', 0],
      'staticFormFields',
      JSON.stringify([{ name: 'mode', value: 'purchase-order' }]),
    ) as typeof source;

    expect(next.nodes[0]?.overrideConnector).toEqual({
      prompt: 'Read invoice', timeoutSec: 45,
      staticFormFields: '[{"name":"mode","value":"purchase-order"}]',
      extraHeaders: '[{"name":"X-Mode","value":"invoice"}]',
    });
    expect(next.nodes[1]).toEqual(source.nodes[1]);
    expect(source.nodes[0]?.overrideConnector.staticFormFields).toBe('[{"name":"mode","value":"old"}]');
  });

  test('removes an emptied override field without deleting its siblings', () => {
    const source = {
      nodes: [{ id: 'extract', type: 'connector', connector: 'ocr', overrideConnector: {
        prompt: 'Read invoice', staticFormFields: '[]', extraHeaders: '[{"name":"X-Mode","value":"invoice"}]',
      } }],
    };
    const next = updateConnectorNodeOverride(source, ['nodes', 0], 'staticFormFields', undefined) as typeof source;
    expect(next.nodes[0]?.overrideConnector).toEqual({
      prompt: 'Read invoice', extraHeaders: '[{"name":"X-Mode","value":"invoice"}]',
    });
    expect(source.nodes[0]?.overrideConnector.staticFormFields).toBe('[]');
  });
});
