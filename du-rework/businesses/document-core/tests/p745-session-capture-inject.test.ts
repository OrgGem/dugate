import { MockTaskContext } from './fixtures/mock-context';
import {
  findStepSessionConfig,
  resolveInjectSessionRef,
  awaitCheckpointSessionRef,
  captureSessionRef,
  type StepSessionConfig,
} from '../src/actions/session-seam';

/**
 * P745-SESSION-CONSUME focused tests (qwen_2). Offline only.
 * Proves the capture/inject session seam on the existing ctx.connector.invoke
 * path: config resolution from the pinned policy, inject fallback to the
 * checkpoint, capture extraction, and the no-config no-op.
 */

const POLICY = {
  enabled: true,
  parameters: {},
  jobPriority: 'MEDIUM',
  allowedFileExtensions: 'pdf',
  connectionsOverride: [
    { slug: 'mock-ocr', stepId: 'ingest:execute-ocr', captureSession: 'w2-ocr-session' },
    { slug: 'mock-llm', stepId: 'extract:connector-inference', injectSession: 'w2-ocr-session' },
  ],
  fileUrlAuthConfigured: false,
  credentialRef: { tenantId: 'tenant-test-default', profileId: 'prof-1', profileRevision: 3 },
};

/**
 * The pin fields are readonly+optional on TaskContext (the SDK sets them), so
 * a test installs them through a cast instead of widening the shared
 * MockTaskContext fixture, which this packet does not lease.
 */
function withPin(ctx: MockTaskContext, policy: unknown): MockTaskContext {
  (ctx as unknown as { profilePolicy: unknown }).profilePolicy = policy;
  return ctx;
}

describe('P745-SESSION-CONSUME session seam', () => {
  it('findStepSessionConfig returns the declared capture/inject slots for a step', () => {
    const ctx = withPin(new MockTaskContext(), POLICY);
    expect(findStepSessionConfig(ctx, 'ingest:execute-ocr')).toEqual({ injectSession: null, captureSession: 'w2-ocr-session' });
    expect(findStepSessionConfig(ctx, 'extract:connector-inference')).toEqual({ injectSession: 'w2-ocr-session', captureSession: null });
  });

  it('Δ-2 adjudication: an unmapped step SKIPS capture/inject (fail-loud, no guessed binding)', () => {
    const ctx = withPin(new MockTaskContext(), POLICY);
    // Legacy stepId 'ocr'/'extract' (fixture W2) does NOT match a document-core
    // step key ('ingest:execute-ocr' / 'extract:connector-inference'). The
    // adjudication is conservative: no confident match -> no session config,
    // so the step keeps its pre-P745 behaviour. No binding is guessed.
    expect(findStepSessionConfig(ctx, 'ocr')).toBeNull();
    expect(findStepSessionConfig(ctx, 'extract')).toBeNull();
    // And a null/absent policy never yields a config either.
    withPin(ctx, null);
    expect(findStepSessionConfig(ctx, 'ingest:execute-ocr')).toBeNull();
  });
  it('findStepSessionConfig returns null for an unmapped step and for a null/absent policy', () => {
    const ctx = withPin(new MockTaskContext(), POLICY);
    expect(findStepSessionConfig(ctx, 'no:such:step')).toBeNull();
    withPin(ctx, null);
    expect(findStepSessionConfig(ctx, 'ingest:execute-ocr')).toBeNull();
    withPin(ctx, undefined);
    expect(findStepSessionConfig(ctx, 'ingest:execute-ocr')).toBeNull();
  });

  it('resolveInjectSessionRef prefers the explicit request, else falls back to the checkpoint', async () => {
    const ctx = withPin(new MockTaskContext(), POLICY);
    expect(await resolveInjectSessionRef(ctx, 'extract:connector-inference', 'explicit-session')).toBe('explicit-session');
    ctx.checkpointsStore.set('extract:connector-inference', {
      stepKey: 'extract:connector-inference',
      inputHash: 'h1',
      output: { sessionRef: 'captured-session' },
      savedAt: new Date().toISOString(),
    });
    expect(await resolveInjectSessionRef(ctx, 'extract:connector-inference')).toBe('captured-session');
  });

  it('resolveInjectSessionRef returns null when there is nothing to continue (never fabricates)', async () => {
    const ctx = withPin(new MockTaskContext(), POLICY);
    expect(await resolveInjectSessionRef(ctx, 'extract:connector-inference')).toBeNull();
  });

  it('awaitCheckpointSessionRef reads the stored session without executing the step', async () => {
    const ctx = new MockTaskContext();
    ctx.checkpointsStore.set('ingest:execute-ocr', {
      stepKey: 'ingest:execute-ocr',
      inputHash: 'h1',
      output: { sessionRef: 'ocr-session' },
      savedAt: new Date().toISOString(),
    });
    expect(await awaitCheckpointSessionRef(ctx, 'ingest:execute-ocr')).toBe('ocr-session');
    expect(await awaitCheckpointSessionRef(ctx, 'missing:step')).toBeNull();
  });

  it('captureSessionRef extracts the offered session only when the step captures', () => {
    const capture: StepSessionConfig = { captureSession: 'w2-ocr-session', injectSession: null };
    expect(captureSessionRef(capture, { sessionRef: 'sess-1' })).toBe('sess-1');
    expect(captureSessionRef(capture, { sessionRef: null })).toBeNull();
    expect(captureSessionRef(capture, null)).toBeNull();
    expect(captureSessionRef({ captureSession: null, injectSession: null }, { sessionRef: 'sess-1' })).toBeNull();
    expect(captureSessionRef(null, { sessionRef: 'sess-1' })).toBeNull();
  });

  it('the connector facade forwards options.sessionRef and surfaces the offered one', async () => {
    const ctx = new MockTaskContext();
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-1',
      status: 'SUCCESS',
      data: { ok: true },
      sessionRef: 'offered-session',
    };
    const res = await ctx.connector.invoke('ocr', { task: 'ocr' }, { sessionRef: 'continuing-session' });
    expect(ctx.connectorInvocations[0]?.options?.sessionRef).toBe('continuing-session');
    expect(res.sessionRef).toBe('offered-session');
  });


describe('P745-SESSION-CONSUME toInternalContext forwarding (W1b seam)', () => {
  function fakeSdkCtx(invokeImpl: (slot: unknown, input: unknown, options: unknown, invokeOpts: unknown) => Promise<unknown>) {
    const calls: { slot: unknown; input: unknown; options: unknown; invokeOpts: unknown }[] = [];
    const sdk = {
      taskId: 't1',
      operationId: 'op1',
      businessId: 'document-core',
      businessVersion: '1.0.0',
      tenantId: 'tenant-x',
      action: 'extract',
      signal: new AbortController().signal,
      deadlineAt: null,
      cancelRequested: false,
      artifacts: {
        read: async () => Buffer.from(''),
        write: async () => ({ artifactId: 'a1' }),
      },
      step: { run: async () => ({}), peek: async () => null },
      connector: {
        invoke: async (slot: unknown, input: unknown, options: unknown, invokeOpts: unknown) => {
          calls.push({ slot, input, options, invokeOpts });
          return invokeImpl(slot, input, options, invokeOpts);
        },
      },
    };
    return { sdk, calls };
  }

  it('forwards options.sessionRef as the SDK invokeOpts 4th arg and surfaces result.sessionRef', async () => {
    const { toInternalContext } = await import('../src/worker');
    const { sdk, calls } = fakeSdkCtx(async () => ({
      invocationId: 'inv-1',
      state: 'SUCCEEDED',
      result: { sessionRef: 'offered-session', data: { ok: true } },
    }));
    const internal = toInternalContext(sdk as never);
    const res = await internal.connector.invoke('reasoning', { task: 'extract_invoice' }, { sessionRef: 'continuing-session' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.invokeOpts).toEqual({ sessionRef: 'continuing-session' });
    expect(calls[0]?.options).toBeUndefined();
    expect(res.sessionRef).toBe('offered-session');
  });

  it('omits invokeOpts entirely when no sessionRef is requested (direct single-shot unchanged)', async () => {
    const { toInternalContext } = await import('../src/worker');
    const { sdk, calls } = fakeSdkCtx(async () => ({
      invocationId: 'inv-2',
      state: 'SUCCEEDED',
      result: { data: 'ok' },
    }));
    const internal = toInternalContext(sdk as never);
    const res = await internal.connector.invoke('reasoning', { task: 'extract_invoice' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.invokeOpts).toBeUndefined();
    expect(res.sessionRef).toBeNull();
  });

  it('consumes prompt metadata locally while preserving contract-valid provider options', async () => {
    const { toInternalContext } = await import('../src/worker');
    const { InvocationOptionsSchema } = await import('@du/contracts');
    const { sdk, calls } = fakeSdkCtx(async () => ({ invocationId: 'inv-3', state: 'SUCCEEDED', result: { data: 'ok' } }));
    await toInternalContext(sdk as never).connector.invoke('reasoning', { task: 'extract_invoice' }, {
      promptStepId: 'extract:connector-inference', sessionRef: 'continuing-session', temperature: 0.2,
    });
    expect(calls[0]?.options).toEqual({ temperature: 0.2 });
    expect(InvocationOptionsSchema.safeParse(calls[0]?.options).success).toBe(true);
    expect(calls[0]?.invokeOpts).toEqual({ sessionRef: 'continuing-session' });
  });
});
  it('a direct single-shot invoke with no session option is unchanged (no sessionRef on the wire)', async () => {
    const ctx = new MockTaskContext();
    await ctx.connector.invoke('ocr', { task: 'ocr' });
    expect(ctx.connectorInvocations[0]?.options?.sessionRef).toBeUndefined();
  });
});
