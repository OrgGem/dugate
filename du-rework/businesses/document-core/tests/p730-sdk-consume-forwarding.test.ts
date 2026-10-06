import { randomUUID } from 'node:crypto';
import { toInternalContext } from '../src/worker';

/*
 * P730-SDK-CONSUME (W1b) forwarding tests (qwen_2). Offline only.
 * Proves toInternalContext passes the pinned admission snapshot (revision/
 * promptRevisions/profilePolicy) from the SDK claim context into the
 * internal document-core context, with null-vs-absent semantics preserved.
 * Recipe/slot pinning behavior is NOT changed here (execution-pin suite
 * stays green); this is the seam only.
 */

const POLICY = {
  enabled: true,
  parameters: {},
  jobPriority: 'MEDIUM',
  allowedFileExtensions: 'pdf',
  connectionsOverride: [],
  fileUrlAuthConfigured: false,
  credentialRef: { tenantId: 'tenant-test-default', profileId: 'prof-1', profileRevision: 3 },
};

function sdkLike(pin: Record<string, unknown> = {}) {
  return {
    taskId: randomUUID(),
    operationId: randomUUID(),
    businessId: 'document-core',
    businessVersion: '1.0.0',
    tenantId: 'tenant-test-default',
    signal: new AbortController().signal,
    artifacts: {
      read: async () => Buffer.from(''),
      write: async () => ({ artifactId: randomUUID() }),
    },
    ...pin,
  } as never;
}

describe('P730-SDK-CONSUME toInternalContext pin forwarding (W1b)', () => {
  it('forwards profileRevision + promptRevisions + profilePolicy from the SDK context', () => {
    const internal = toInternalContext(sdkLike({ profileRevision: 3, promptRevisions: { extract_invoice: 'v7' }, profilePolicy: POLICY }));
    expect(internal.profileRevision).toBe(3);
    expect(internal.promptRevisions).toEqual({ extract_invoice: 'v7' });
    expect(internal.profilePolicy?.fileUrlAuthConfigured).toBe(false);
    expect(internal.profilePolicy?.credentialRef.profileId).toBe('prof-1');
  });

  it('forwards a NULL profilePolicy as null (admitted-without-policy), distinct from absent', () => {
    const internal = toInternalContext(sdkLike({ profileRevision: 0, promptRevisions: {}, profilePolicy: null }));
    expect(internal.profilePolicy).toBeNull();
  });

  it('omits the pin keys entirely for contexts that never carried them (internal/test shape unchanged)', () => {
    const internal = toInternalContext(sdkLike({}));
    expect('profilePolicy' in internal).toBe(false);
    expect('profileRevision' in internal).toBe(false);
    expect('promptRevisions' in internal).toBe(false);
  });
});
