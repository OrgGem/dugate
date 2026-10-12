import {
  acceptAttempt,
  createImmutableAttempt,
  FileArtifactCache,
  type ImmutableAttempt,
  markAttemptDispatched,
  retainAfterFailure,
  TenantAttemptRegistry,
} from '../../../apps/admin-web/src/features/submissions/immutable-attempt';
import {
  parseWorkflowOverrideRows,
  updateConnectorNodeOverride,
} from '../../../apps/admin-web/src/features/workflows/revision-editor';

type TestRequest = {
  tenantId: string;
  workflow: { slug: string; revision: number };
  apiKeyId: string;
  artifacts: Array<{ artifactId: string; role: string }>;
  variables: Record<string, unknown>;
};

describe('ORV15 Admin retry and tenant regression seams', () => {
  test('lost ACK followed by 401/403/409 keeps the exact frozen request, key and uploaded artifacts', () => {
    const request: TestRequest = {
      tenantId: 'tenant-a', workflow: { slug: 'extract', revision: 7 }, apiKeyId: 'key-a',
      artifacts: [{ artifactId: 'uploaded-a', role: 'invoice' }], variables: { mode: 'invoice' },
    };
    const ready = createImmutableAttempt('tenant-a', 'idem-original', request);
    const sent = markAttemptDispatched(ready);
    const uncertain = retainAfterFailure(sent, 0)!;

    expect(uncertain.state).toBe('UNCERTAIN');
    for (const status of [401, 403, 409]) {
      const sourceCheck = markAttemptDispatched(uncertain);
      const retained = retainAfterFailure(sourceCheck, status)!;
      expect(retained.tenantId).toBe('tenant-a');
      expect(retained.idempotencyKey).toBe('idem-original');
      expect(retained.request).toBe(ready.request);
      expect(retained.request.artifacts).toEqual([{ artifactId: 'uploaded-a', role: 'invoice' }]);
      expect(Object.isFrozen(retained.request)).toBe(true);
    }
  });

  test('tenant registry isolates late A updates, blocks workflow changes, and clears only the matching terminal operation', () => {
    const registry = new TenantAttemptRegistry<ImmutableAttempt<TestRequest>>();
    const readyA = createImmutableAttempt('tenant-a', 'idem-a', {
      tenantId: 'tenant-a', workflow: { slug: 'extract', revision: 7 }, apiKeyId: 'key-a', artifacts: [], variables: {},
    });
    const uncertainA = retainAfterFailure(markAttemptDispatched(readyA), 0)!;
    const checkedA = retainAfterFailure(uncertainA, 403)!;
    expect(checkedA.state).toBe('UNCERTAIN');
    expect(checkedA.request).toBe(readyA.request);
    const a = acceptAttempt(checkedA, 'operation-a');
    const b = createImmutableAttempt('tenant-b', 'idem-b', {
      tenantId: 'tenant-b', workflow: { slug: 'extract', revision: 7 }, apiKeyId: 'key-b', artifacts: [], variables: {},
    });

    expect(registry.set('tenant-a', uncertainA)).toBe(true);
    expect(registry.set('tenant-a', a)).toBe(true);
    registry.set('tenant-b', b);
    const replacement = acceptAttempt(createImmutableAttempt('tenant-a', 'idem-new', {
      tenantId: 'tenant-a', workflow: { slug: 'other-workflow', revision: 1 }, apiKeyId: 'key-a', artifacts: [], variables: {},
    }), 'operation-a');
    expect(registry.set('tenant-a', replacement)).toBe(false);
    expect(registry.get('tenant-a')).toBe(a);
    const staleUncertain = retainAfterFailure(checkedA, 401)!;
    expect(registry.set('tenant-a', staleUncertain)).toBe(false);
    expect(registry.get('tenant-a')).toBe(a);
    // An A callback completing while B is displayed still writes only to A's entry.
    expect(registry.get('tenant-b')).toBe(b);
    expect(registry.clearAcceptedOperation('tenant-a', 'operation-other')).toBe(false);
    expect(registry.has('tenant-a')).toBe(true);
    expect(registry.clearAcceptedOperation('tenant-a', 'operation-a')).toBe(true);
    expect(registry.get('tenant-a')).toBeNull();
    expect(registry.get('tenant-b')).toBe(b);

    // An unresolved tenant attempt blocks another workflow/revision in that tenant.
    const unresolved = retainAfterFailure(markAttemptDispatched(b), 0)!;
    registry.set('tenant-b', unresolved);
    const selectedAfterEdit = { slug: 'different-workflow', revision: 99 };
    expect(selectedAfterEdit).not.toEqual(unresolved.request.workflow);
    expect(registry.has('tenant-b')).toBe(true);
  });

  test('partial upload cache reuses only the same File identity and exact tenant/key context', async () => {
    type FileLike = { name: string; size: number; lastModified: number };
    const cache = new FileArtifactCache<FileLike>();
    const first = { name: 'invoice.pdf', size: 14, lastModified: 123 };
    const second = { name: 'receipt.pdf', size: 12, lastModified: 456 };
    const sameMetadataNewFile = { ...first };
    let firstUploadCount = 0;
    let secondUploadCount = 0;
    const upload = async (file: FileLike): Promise<string> => {
      const cached = cache.get(file, 'tenant-a', 'key-a');
      if (cached) return cached;
      if (file === first) firstUploadCount += 1;
      else secondUploadCount += 1;
      if (file === second && secondUploadCount === 1) throw new Error('partial upload failure');
      const artifactId = file === first ? 'artifact-first' : 'artifact-second';
      cache.set(file, 'tenant-a', 'key-a', artifactId);
      return artifactId;
    };

    await expect(Promise.all([upload(first), upload(second)])).rejects.toThrow('partial upload failure');
    await expect(Promise.all([upload(first), upload(second)])).resolves.toEqual(['artifact-first', 'artifact-second']);
    expect(firstUploadCount).toBe(1);
    expect(secondUploadCount).toBe(2);
    expect(cache.get(sameMetadataNewFile, 'tenant-a', 'key-a')).toBeNull();
    expect(cache.get(first, 'tenant-b', 'key-a')).toBeNull();
    expect(cache.get(first, 'tenant-a', 'key-b')).toBeNull();
  });

  test('guided static-field/header edit preserves profile lock data and sibling overrides', () => {
    const source = {
      slug: 'invoice-flow',
      profileParameters: { accountId: { value: 'acct-a', isLocked: true }, mode: { value: 'invoice', isLocked: false } },
      nodes: [
        { id: 'extract', type: 'connector', connector: 'ocr', overrideConnector: {
          prompt: 'Read invoice', timeoutSec: 45,
          staticFormFields: '[{"name":"mode","value":"invoice"}]',
          extraHeaders: '[{"name":"X-Mode","value":"invoice"}]',
        } },
        { id: 'review', type: 'connector', connector: 'review', overrideConnector: { prompt: 'Review' } },
      ],
      flow: ['extract', 'review'],
    };
    const parsedStaticFields = parseWorkflowOverrideRows('staticFormFields', source.nodes[0]?.overrideConnector.staticFormFields);
    expect(parsedStaticFields).toMatchObject({ ok: true });
    const staticUpdated = updateConnectorNodeOverride(
      source,
      ['nodes', 0],
      'staticFormFields',
      JSON.stringify([{ name: 'mode', value: 'purchase-order' }]),
    ) as typeof source;
    const parsedHeaders = parseWorkflowOverrideRows('extraHeaders', JSON.stringify([{ name: 'X-Mode', value: 'purchase-order' }]));
    expect(parsedHeaders).toMatchObject({ ok: true });
    const changed = updateConnectorNodeOverride(
      staticUpdated,
      ['nodes', 0],
      'extraHeaders',
      JSON.stringify(parsedHeaders.ok ? parsedHeaders.rows : []),
    ) as typeof source;

    expect(changed.nodes[0]?.overrideConnector.prompt).toBe('Read invoice');
    expect(changed.nodes[0]?.overrideConnector.staticFormFields).toBe('[{"name":"mode","value":"purchase-order"}]');
    expect(changed.nodes[1]).toEqual(source.nodes[1]);
    expect(changed.profileParameters).toEqual(source.profileParameters);
    expect(source.nodes[0]?.overrideConnector.extraHeaders).toBe('[{"name":"X-Mode","value":"invoice"}]');
  });
});
