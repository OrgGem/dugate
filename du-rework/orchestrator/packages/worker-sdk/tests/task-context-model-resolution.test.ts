import { randomUUID } from 'node:crypto';
import {
  DefaultTaskContext,
  RuntimeClient,
  applyPinnedModelDefault,
  describeResolvedParameters,
} from '../src';
import type { PinnedProfilePolicy, TenantDefaultsSnapshot } from '@du/contracts';

/**
 * PC-06 — manifest and worker opt-in.
 *
 * The plan places the whole parameter resolution on the admission side: the
 * resolved request `parameters` travel in the existing Runtime API v1 task
 * input, and `profileSettings` stay in the existing pinned profile snapshot.
 * The SDK is therefore required to add **no** wire field. What it must prove is
 * that the values arrive intact and that two precedence rules cannot drift:
 *
 *   1. provider model = explicit invoke option → pinned profile model → tenant
 *      AI default (only for the tenant-default Connector);
 *   2. an action input property named `model` stays action input forever — a
 *      `requestDefaults` fill must never silently become the provider model.
 *
 * Offline: no runtime, no connector, no network.
 */

const TENANT_ID = '00000000-0000-4000-8000-0000000000c6';
const PROFILE_ID = '00000000-0000-4000-8000-0000000000c7';

function pinnedPolicy(parameters: Record<string, { value: unknown; isLocked?: boolean }> = {}): PinnedProfilePolicy {
  return {
    enabled: true,
    parameters,
    jobPriority: 'MEDIUM',
    allowedFileExtensions: '',
    connectionsOverride: [],
    fileUrlAuthConfigured: false,
    credentialRef: { tenantId: TENANT_ID, profileId: PROFILE_ID, profileRevision: 3 },
  } as unknown as PinnedProfilePolicy;
}

function tenantDefaults(model?: string): TenantDefaultsSnapshot {
  return {
    ai: {
      connectorId: 'tenant-ai',
      connectorRevision: 4,
      model: model ?? null,
    },
  } as unknown as TenantDefaultsSnapshot;
}

function contextFor(task: {
  input: Record<string, unknown>;
  profilePolicy?: PinnedProfilePolicy | null;
  tenantDefaults?: TenantDefaultsSnapshot | null;
  connectorBindings?: Record<string, string>;
}): DefaultTaskContext {
  const runtime = new RuntimeClient({
    baseUrl: 'http://runtime.invalid/api/runtime/v1',
    token: 'offline-test-token',
    fetchImpl: (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch,
  });
  return new DefaultTaskContext(
    {
      taskId: randomUUID(),
      operationId: randomUUID(),
      tenantId: TENANT_ID,
      businessId: 'document-core',
      businessVersion: '1.2.0',
      action: 'extract',
      kind: 'root',
      taskKey: 'root',
      attempt: 1,
      leaseEpoch: 1,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      deadlineAt: null,
      input: task.input,
      connectorBindings: task.connectorBindings ?? {},
      profileRevision: 3,
      promptRevisions: {},
      profilePolicy: task.profilePolicy,
      promptOverrides: null,
      tenantDefaults: task.tenantDefaults,
      checkpointRefs: [],
      cancelRequested: false,
    } as never,
    {
      runtime,
      logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never,
      invokeConnector: async () => { throw new Error('unused'); },
      fetchImpl: (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch,
    },
  );
}

describe('PC-06 provider model precedence', () => {
  const profileWithModel = pinnedPolicy({ model: { value: 'profile-model' } });

  it('explicit invoke options win over every pin', () => {
    const result = applyPinnedModelDefault(
      { model: 'explicit-model' },
      profileWithModel,
      tenantDefaults('tenant-model'),
      'tenant-ai@4',
    );
    expect(result?.model).toBe('explicit-model');
  });

  it('the pinned profile model fills an absent option', () => {
    const result = applyPinnedModelDefault(undefined, profileWithModel, tenantDefaults('tenant-model'), 'tenant-ai@4');
    expect(result?.model).toBe('profile-model');
  });

  it('the tenant AI default fills only for its own Connector binding', () => {
    const sameBinding = applyPinnedModelDefault(undefined, null, tenantDefaults('tenant-model'), 'tenant-ai@4');
    expect(sameBinding?.model).toBe('tenant-model');

    const otherBinding = applyPinnedModelDefault(undefined, null, tenantDefaults('tenant-model'), 'other@1');
    expect(otherBinding?.model).toBeUndefined();
  });

  it('a blank or non-string stored model never becomes the provider model', () => {
    expect(applyPinnedModelDefault(undefined, pinnedPolicy({ model: { value: '   ' } }), null, undefined)?.model)
      .toBeUndefined();
    expect(applyPinnedModelDefault(undefined, pinnedPolicy({ model: { value: 7 } }), null, undefined)?.model)
      .toBeUndefined();
  });

  it('returns the caller options untouched when no source pins a model', () => {
    expect(applyPinnedModelDefault(undefined, null, null, undefined)).toBeUndefined();
    expect(applyPinnedModelDefault({ temperature: 0 }, null, null, undefined)).toEqual({ temperature: 0 });
  });
});

describe('PC-06 resolved parameter view', () => {
  it('exposes exactly the admission-resolved map, including requestDefaults fills', () => {
    // The orchestrator already merged `requestDefaults` into the task input at
    // admission; the SDK must not re-derive or reshape it.
    const input = { mode: 'strict', flavor: 'vanilla', maxTokens: 128 };
    const view = describeResolvedParameters({ input });
    expect(view.parameters).toEqual(input);
    expect(view.parameters).not.toBe(input);
  });

  it('keeps profileSettings out of the request parameters', () => {
    const view = describeResolvedParameters({
      input: { mode: 'strict' },
      profilePolicy: pinnedPolicy({ maxParallelItems: { value: 4 }, autoApprovePassed: { value: true } }),
    });
    expect(view.profileSettings).toEqual({ maxParallelItems: 4, autoApprovePassed: true });
    expect(view.parameters).not.toHaveProperty('maxParallelItems');
    expect(view.parameters).not.toHaveProperty('autoApprovePassed');
  });

  it('an action input property named model stays action input', () => {
    // A `requestDefaults` value named `model` is action data. It reaches the
    // provider only when a handler explicitly passes it as an invoke option.
    const view = describeResolvedParameters({
      input: { model: 'request-default-model', text: 'hello' },
    });
    expect(view.parameters.model).toBe('request-default-model');
    expect(view.providerModel).toBeUndefined();
  });

  it('the pinned profile model wins over an input property named model', () => {
    const view = describeResolvedParameters({
      input: { model: 'request-default-model' },
      profilePolicy: pinnedPolicy({ model: { value: 'profile-model' } }),
    });
    expect(view.parameters.model).toBe('request-default-model');
    expect(view.providerModel).toBe('profile-model');
  });

  it('an explicit invoke option wins over the pinned profile model', () => {
    const view = describeResolvedParameters(
      { input: { model: 'request-default-model' }, profilePolicy: pinnedPolicy({ model: { value: 'profile-model' } }) },
      { model: 'explicit-model' },
    );
    expect(view.providerModel).toBe('explicit-model');
    expect(view.parameters.model).toBe('request-default-model');
  });

  it('is immutable: a handler cannot mutate the delivered parameters', () => {
    const view = describeResolvedParameters({ input: { mode: 'strict' } });
    expect(Object.isFrozen(view.parameters)).toBe(true);
    expect(Object.isFrozen(view.profileSettings)).toBe(true);
  });

  it('tolerates every pin state a v1 claim can carry (undefined, null, populated)', () => {
    for (const profilePolicy of [undefined, null, pinnedPolicy({ mode: { value: 'x' } })]) {
      const view = describeResolvedParameters({ input: { text: 'hi' }, profilePolicy });
      expect(view.parameters).toEqual({ text: 'hi' });
      expect(view.providerModel).toBeUndefined();
    }
  });
});

describe('PC-06 worker TaskContext wiring', () => {
  it('DefaultTaskContext exposes the same view for a delivered task', () => {
    const ctx = contextFor({
      input: { mode: 'strict', maxTokens: 64 },
      profilePolicy: pinnedPolicy({ maxParallelItems: { value: 2 } }),
      connectorBindings: { reasoning: 'ext-reasoning@2' },
    });
    const view = ctx.resolvedParameters();
    expect(view.parameters).toEqual({ mode: 'strict', maxTokens: 64 });
    expect(view.profileSettings).toEqual({ maxParallelItems: 2 });
    expect(view.providerModel).toBeUndefined();
    // `input` on the public interface is unchanged, so every existing handler
    // keeps reading exactly what it read before.
    expect(ctx.input).toEqual({ mode: 'strict', maxTokens: 64 });
  });

  it('a pre-PC-06 delivery with no capability marker still resolves', () => {
    // No `parameterResolution` marker, no `requestDefaults`, no new wire field:
    // the view is derivable from a claim that a v1 orchestrator already sends.
    const ctx = contextFor({ input: { text: 'legacy' }, profilePolicy: undefined });
    expect(ctx.resolvedParameters().parameters).toEqual({ text: 'legacy' });
    expect(ctx.profilePolicy).toBeUndefined();
  });

  it('the view reports the model this call would actually send', () => {
    const ctx = contextFor({
      input: { text: 'x' },
      profilePolicy: pinnedPolicy({ model: { value: 'profile-model' } }),
    });
    expect(ctx.resolvedParameters().providerModel).toBe('profile-model');
    expect(ctx.resolvedParameters({ model: 'explicit-model' }).providerModel).toBe('explicit-model');
  });
});

describe('PC-06 mixed-rollout compatibility', () => {
  function claimDto(extraTopLevel: Record<string, unknown> = {}) {
    return {
      taskId: randomUUID(),
      operationId: randomUUID(),
      leaseEpoch: 1,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      attempt: 1,
      deadlineAt: null,
      executionSnapshot: {
        operationId: randomUUID(),
        tenantId: TENANT_ID,
        businessId: 'document-core',
        businessVersion: '1.2.0',
        action: 'extract',
        kind: 'root',
        taskKey: 'root',
        schemaDigest: 'sha256:pc06-schema',
        manifestDigest: 'sha256:pc06-manifest',
        resolvedInputRef: { text: 'offline', outputFormat: 'json' },
        pinned: {
          profileRevision: 3,
          promptRevisions: {},
          connectorBindings: {},
          profilePolicy: null,
        },
        payloadRef: { input: { text: 'offline' } },
        deadlineAt: null,
        cancelRequested: false,
      },
      checkpointRefs: [],
      ...extraTopLevel,
    };
  }

  function clientReturning(body: unknown): RuntimeClient {
    return new RuntimeClient({
      baseUrl: 'http://runtime.invalid',
      token: 'offline-token',
      fetchImpl: (async () => new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    });
  }

  it('an older-style payload with no capability marker still claims', async () => {
    const claim = await clientReturning(claimDto()).claimTask('task-pc06', {
      deliveryId: 'delivery-pc06',
      workerInstanceId: 'worker-pc06',
      businessId: 'document-core',
    });
    expect(claim.executionSnapshot.resolvedInputRef).toEqual({ text: 'offline', outputFormat: 'json' });
    expect(claim.executionSnapshot.pinned.profilePolicy).toBeNull();
  });

  it('a claim carrying an unknown top-level field is tolerated (forward compatible)', async () => {
    // PC-06 deliberately adds NO wire field, so this is the guarantee that a
    // future additive publisher cannot break an older SDK in the field.
    const claim = await clientReturning(claimDto({ parameterResolution: { version: 2 } })).claimTask('task-pc06', {
      deliveryId: 'delivery-pc06',
      workerInstanceId: 'worker-pc06',
      businessId: 'document-core',
    });
    expect(claim.taskId).toBeDefined();
    // Unknown fields are not projected into the task input.
    expect(claim.executionSnapshot.resolvedInputRef).toEqual({ text: 'offline', outputFormat: 'json' });
  });
});
