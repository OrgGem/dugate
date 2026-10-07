import { randomUUID } from 'node:crypto';
import { DefaultTaskContext, RuntimeClient } from '../src';

/**
 * CR06-07 — tri-state policy discipline on DefaultTaskContext.
 *
 * The context must preserve three distinct states from the claim:
 *   undefined -> pre-pin (a context that never carried the pin)
 *   null      -> admitted WITHOUT a profile policy
 *   object    -> the pinned policy snapshot
 * The previous `task.profilePolicy ?? null` collapsed the first two into a
 * single state, so a consumer could not tell them apart.
 */

const POLICY = {
  enabled: true,
  parameters: {},
  jobPriority: 'MEDIUM',
  allowedFileExtensions: 'pdf',
  connectionsOverride: [],
  fileUrlAuthConfigured: false,
  credentialRef: { tenantId: '73000000-0000-4000-8000-000000000001', profileId: 'prof-1', profileRevision: 3 },
};

function makeContext(profilePolicy: unknown) {
  return new DefaultTaskContext(
    {
      taskId: randomUUID(),
      operationId: randomUUID(),
      tenantId: '73000000-0000-4000-8000-000000000001',
      businessId: 'test-biz',
      businessVersion: '1.0.0',
      action: 'extract',
      kind: 'root',
      taskKey: 'root',
      attempt: 1,
      leaseEpoch: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      deadlineAt: null,
      input: {},
      connectorBindings: {},
      profilePolicy,
      checkpointRefs: [],
      cancelRequested: false,
    } as never,
    {
      runtime: new RuntimeClient({ baseUrl: 'http://runtime', token: 'tok', fetchImpl: (async () => new Response('{}')) as never }),
      logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never,
      invokeConnector: async () => { throw new Error('unused'); },
    },
  );
}

describe('CR06-07 DefaultTaskContext tri-state profilePolicy', () => {
  it('keeps undefined (pre-pin) as undefined, NOT null', () => {
    const ctx = makeContext(undefined);
    expect(ctx.profilePolicy).toBeUndefined();
    expect(ctx.profilePolicy).not.toBeNull();
  });

  it('keeps null (admitted-without-policy) as null', () => {
    const ctx = makeContext(null);
    expect(ctx.profilePolicy).toBeNull();
  });

  it('passes a populated policy through untouched', () => {
    const ctx = makeContext(POLICY);
    expect(ctx.profilePolicy).toEqual(POLICY);
    expect(ctx.profilePolicy?.credentialRef.profileId).toBe('prof-1');
  });

  it('the three states are distinguishable from each other', () => {
    const prePin = makeContext(undefined).profilePolicy;
    const noPolicy = makeContext(null).profilePolicy;
    const pinned = makeContext(POLICY).profilePolicy;
    expect(prePin).not.toBe(noPolicy);
    expect(typeof prePin).toBe('undefined');
    expect(noPolicy).toBeNull();
    expect(pinned).not.toBeNull();
    expect(pinned).not.toBe(prePin);
  });
});
