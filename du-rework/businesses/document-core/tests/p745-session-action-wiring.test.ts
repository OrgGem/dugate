import { ExtractAction } from '../src/actions/extract';
import { IngestAction } from '../src/actions/ingest';
import {
  awaitCheckpointSessionRef,
  persistStepSessionCapture,
  resolveStepSessionRef,
  sessionSlotStepKey,
} from '../src/actions/session-seam';
import type { TaskContext } from '../src/types/context';
import { toInternalContext } from '../src/worker';
import { MockTaskContext } from './fixtures/mock-context';

/**
 * CR06-03 P745-SESSION-CONSUME action wiring. Offline only.
 *
 * Proves the seam now has PRODUCTION call-sites on the six actions' connector
 * invoke path:
 * - ingest OCR captures the provider-offered sessionRef into the named slot;
 * - a later step (extract connector-inference) injects it before invoke;
 * - the captured value survives a new delivery that carries the task's
 *   checkpoints (checkpoint resume multi-turn);
 * - capture is first-write-wins;
 * - the official Δ-2 mapping rule is exact-step-key-or-skip: legacy ids
 *   (`ocr`/`extract`) are never guessed;
 * - no policy => pass-through (pre-P745 single-shot unchanged);
 * - the SDK wrapper forwards step options and surfaces the row sessionRef.
 */

const OCR_SLOT = 'w2-ocr-session';

const POLICY = {
  enabled: true,
  parameters: {},
  jobPriority: 'MEDIUM',
  allowedFileExtensions: 'pdf',
  connectionsOverride: [
    { slug: 'mock-ocr', stepId: 'ingest:execute-ocr', captureSession: OCR_SLOT },
    { slug: 'mock-llm', stepId: 'extract:connector-inference', injectSession: OCR_SLOT },
  ],
  fileUrlAuthConfigured: false,
  credentialRef: { tenantId: 'tenant-test-default', profileId: 'prof-1', profileRevision: 3 },
};

const LEGACY_POLICY = {
  ...POLICY,
  connectionsOverride: [
    { slug: 'legacy-ocr', stepId: 'ocr', captureSession: 'legacy-slot' },
    { slug: 'legacy-llm', stepId: 'extract', injectSession: 'legacy-slot' },
  ],
};

function withPin(ctx: MockTaskContext, policy: unknown): MockTaskContext {
  (ctx as unknown as { profilePolicy: unknown }).profilePolicy = policy;
  return ctx;
}

async function runIngestOcr(ctx: MockTaskContext): Promise<void> {
  const ref = await ctx.artifacts.write(Buffer.from('fake-scan-bytes'), 'scan.png', 'image/png');
  const input = IngestAction.validateInput({ mode: 'ocr', artifactIds: [ref.artifactId], language: 'en' });
  const sources = await IngestAction.prepareSources(ctx, input);
  await IngestAction.executeRecipe(ctx, IngestAction.selectRecipe(input), input, sources);
}

async function runExtractInvoice(ctx: MockTaskContext): Promise<void> {
  const input = ExtractAction.validateInput({ type: 'invoice', text: 'Sample invoice text' });
  const sources = await ExtractAction.prepareSources(ctx, input);
  await ExtractAction.executeRecipe(ctx, ExtractAction.selectRecipe(input), input, sources);
}

function invoiceResponse(sessionRef?: string | null) {
  return {
    invocationId: 'inv-extract',
    status: 'SUCCESS' as const,
    data: { invoiceNumber: 'INV-CR06-03', total: 42 },
    ...(sessionRef === undefined ? {} : { sessionRef }),
  };
}

const ocrResponse = {
  invocationId: 'inv-ocr',
  status: 'SUCCESS' as const,
  data: { text: 'parsed' },
  sessionRef: 'ocr-sess-1',
};

describe('CR06-03 session seam wiring — action call-sites', () => {
  it('ingest OCR captures the provider-offered session into the named slot checkpoint', async () => {
    const ctx = withPin(new MockTaskContext(), POLICY);
    ctx.mockConnectorResponses.set('ocr', ocrResponse);

    await runIngestOcr(ctx);

    const ocrCall = ctx.connectorInvocations.find((i) => i.slot === 'ocr');
    // First delivery: nothing captured yet -> no sessionRef on the wire.
    expect(ocrCall?.options?.sessionRef).toBeUndefined();
    expect(await awaitCheckpointSessionRef(ctx, sessionSlotStepKey(OCR_SLOT))).toBe('ocr-sess-1');
    expect(ctx.checkpointsStore.get(sessionSlotStepKey(OCR_SLOT))?.sessionRef).toBe('ocr-sess-1');
  });

  it('a later step injects the captured slot before invoke (multi-turn resume)', async () => {
    const ctx = withPin(new MockTaskContext(), POLICY);
    ctx.mockConnectorResponses.set('ocr', ocrResponse);
    await runIngestOcr(ctx);

    ctx.defaultConnectorResponse = invoiceResponse('extract-sess-2');
    await runExtractInvoice(ctx);

    const extractCall = ctx.connectorInvocations.find((i) => i.slot === 'reasoning');
    expect(extractCall?.options?.sessionRef).toBe('ocr-sess-1');
    expect(extractCall?.options?.promptStepId).toBe('extract:connector-inference');
  });

  it('a NEW delivery carrying the claim checkpoints still injects the captured session', async () => {
    const first = withPin(new MockTaskContext(), POLICY);
    first.mockConnectorResponses.set('ocr', ocrResponse);
    await runIngestOcr(first);

    // Resume emulation: the runtime claims the task again with its checkpoint
    // rows; process state does not carry over.
    const resumed = withPin(new MockTaskContext(), POLICY);
    resumed.checkpointsStore = first.checkpointsStore;
    resumed.defaultConnectorResponse = invoiceResponse('extract-sess-2');

    await runExtractInvoice(resumed);

    const extractCall = resumed.connectorInvocations.find((i) => i.slot === 'reasoning');
    expect(extractCall?.options?.sessionRef).toBe('ocr-sess-1');
  });

  it('capture is first-write-wins: a later offered session never overwrites the slot', async () => {
    const ctx = withPin(new MockTaskContext(), POLICY);
    ctx.mockConnectorResponses.set('ocr', ocrResponse);
    await runIngestOcr(ctx);

    await persistStepSessionCapture(ctx, 'ingest:execute-ocr', 'ocr-sess-later');

    expect(await awaitCheckpointSessionRef(ctx, sessionSlotStepKey(OCR_SLOT))).toBe('ocr-sess-1');
  });

  it('no policy => pass-through: no sessionRef injected and no slot checkpoint fabricated', async () => {
    const ctx = new MockTaskContext();
    ctx.defaultConnectorResponse = invoiceResponse();
    await runExtractInvoice(ctx);

    const extractCall = ctx.connectorInvocations.find((i) => i.slot === 'reasoning');
    expect(extractCall?.options?.sessionRef).toBeUndefined();
    expect(Array.from(ctx.checkpointsStore.keys()).some((key) => key.startsWith('p745:session:'))).toBe(false);
  });
});

describe('CR06-03 Δ-2 mapping rule — legacy stepIds fail loud (skip)', () => {
  it('legacy capture step does not write a slot and legacy inject step never consumes one', async () => {
    const ctx = withPin(new MockTaskContext(), LEGACY_POLICY);
    ctx.mockConnectorResponses.set('ocr', { ...ocrResponse, sessionRef: 'should-not-be-captured' });
    await runIngestOcr(ctx);

    expect(ctx.checkpointsStore.has(sessionSlotStepKey('legacy-slot'))).toBe(false);
    expect(await awaitCheckpointSessionRef(ctx, sessionSlotStepKey('legacy-slot'))).toBeNull();

    // Even a pre-seeded slot is NOT injected when the policy stepId is legacy
    // ('extract' != 'extract:connector-inference'): exact match or skip.
    ctx.checkpointsStore.set(sessionSlotStepKey('legacy-slot'), {
      stepKey: sessionSlotStepKey('legacy-slot'),
      inputHash: 'seeded',
      output: { sessionRef: 'must-not-inject' },
      savedAt: new Date().toISOString(),
    });
    ctx.defaultConnectorResponse = invoiceResponse();
    await runExtractInvoice(ctx);

    const extractCall = ctx.connectorInvocations.find((i) => i.slot === 'reasoning');
    expect(extractCall?.options?.sessionRef).toBeUndefined();
    expect(await resolveStepSessionRef(ctx, 'extract:connector-inference')).toBeNull();
  });
});

describe('CR06-03 SDK path — step options + checkpoint sessionRef surface', () => {
  function fakeSdkContext(calls: Array<{ key: string; hash: string; opts: unknown }>) {
    return {
      taskId: 't1',
      operationId: 'op1',
      businessId: 'document-core',
      businessVersion: '1.0.0',
      tenantId: 'tenant-x',
      action: 'ingest',
      signal: new AbortController().signal,
      deadlineAt: null,
      cancelRequested: false,
      artifacts: { read: async () => Buffer.from(''), write: async () => ({ artifactId: 'a1' }) },
      step: {
        run: async (key: string, hash: string, fn: () => Promise<unknown>, opts?: unknown) => {
          calls.push({ key, hash, opts });
          return fn();
        },
        peek: async (key: string) =>
          key === sessionSlotStepKey('slot-1')
            ? { stepKey: key, inputHash: 'h', sessionRef: 'sdk-sess' }
            : null,
      },
      connector: { invoke: async () => ({ invocationId: 'inv', state: 'SUCCEEDED', result: {} }) },
    };
  }

  it('the internal facade forwards step options to the SDK step.run', async () => {
    const calls: Array<{ key: string; hash: string; opts: unknown }> = [];
    const internal = toInternalContext(fakeSdkContext(calls) as never);

    await internal.step('extract:connector-inference', 'hash-1', async () => 7, { sessionRef: 'sdk-sess' });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      key: 'extract:connector-inference',
      hash: 'hash-1',
      opts: { sessionRef: 'sdk-sess' },
    });
  });

  it('getCheckpoint surfaces the row sessionRef so the slot resolver reads it without executing', async () => {
    const calls: Array<{ key: string; hash: string; opts: unknown }> = [];
    const internal = toInternalContext(fakeSdkContext(calls) as never);

    const record = await internal.getCheckpoint(sessionSlotStepKey('slot-1'));
    expect(record?.sessionRef).toBe('sdk-sess');
    expect(await awaitCheckpointSessionRef(internal as unknown as TaskContext, sessionSlotStepKey('slot-1'))).toBe('sdk-sess');
  });
});
