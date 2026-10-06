import { MockTaskContext } from './fixtures/mock-context';
import { toInternalContext } from '../src/worker';
import { applyPinnedStepPrompt, connectionIdForSlot } from '../src/actions/prompt-application';

/**
 * P745-CARRIER-IMPL-B2 focused tests (qwen_2). Offline only.
 * T6 = toInternalContext forwards pinned.promptOverrides (guarded); T7 = the
 * applyPinnedStepPrompt substitution at a build-prompt site (PC-2(a)).
 */

const SHA = 'sha256:' + 'a'.repeat(64);
const ROW = { connectionId: 'conn-1', stepId: 'extract:build-prompt', promptOverride: 'PINNED_EXACT_PROMPT', revision: SHA };
const DEFAULT_ROW = { connectionId: 'conn-1', stepId: '_default', promptOverride: 'PINNED_DEFAULT_PROMPT', revision: SHA };
const POLICY = { profileId: 'prof-1', revision: 3 };

function fakeSdkWithPin(pin: Record<string, unknown>) {
  return {
    taskId: 't1', operationId: 'op1', businessId: 'document-core', businessVersion: '1.0.0',
    tenantId: 'tenant-x', action: 'extract',
    signal: new AbortController().signal, deadlineAt: null, cancelRequested: false,
    artifacts: { read: async () => Buffer.from(''), write: async () => ({ artifactId: 'a1' }) },
    step: { run: async () => ({}), peek: async () => null },
    connector: { invoke: async () => ({ invocationId: 'i1', state: 'SUCCEEDED', result: {} }) },
    ...pin,
  } as never;
}

describe('P745-CARRIER-IMPL-B2 T6', () => {
  it('forwards pinned.promptOverrides from the SDK context into document-core', () => {
    const internal = toInternalContext(fakeSdkWithPin({ promptOverrides: [ROW] }));
    expect(internal.promptOverrides).toEqual([ROW]);
  });

  it('forwards NULL promptOverrides as null (no carrier), and omits keys that were never set', () => {
    const withNull = toInternalContext(fakeSdkWithPin({ promptOverrides: null, profilePolicy: null }));
    expect(withNull.promptOverrides).toBeNull();
    expect('promptOverrides' in withNull).toBe(true);
    const withoutIt = toInternalContext(fakeSdkWithPin({}));
    expect('promptOverrides' in withoutIt).toBe(false);
  });

  it('forwards connectorBindings so the resolver can derive the connection', () => {
    const internal = toInternalContext(fakeSdkWithPin({ connectorBindings: { reasoning: 'conn-1@3' } }));
    expect(internal.connectorBindings).toEqual({ reasoning: 'conn-1@3' });
  });
});

describe('P745-CARRIER-IMPL-B2 T7 applyPinnedStepPrompt', () => {
  function ctxWith(over: Record<string, unknown>) {
    return {
      profilePolicy: POLICY,
      promptOverrides: [ROW],
      connectorBindings: { reasoning: 'conn-1@3' },
      ...over,
    } as never;
  }

  it('applies the exact-step profile prompt over the call-site default (PC-2(a))', () => {
    expect(applyPinnedStepPrompt(ctxWith({}), { slot: 'reasoning', stepId: 'extract:build-prompt', defaultText: 'DEFAULT' }))
      .toBe('PINNED_EXACT_PROMPT');
  });

  it('falls back to the pinned _default row when the step has no exact row', () => {
    expect(applyPinnedStepPrompt(ctxWith({ promptOverrides: [DEFAULT_ROW] }), { slot: 'reasoning', stepId: 'analyze:build-prompt', defaultText: 'DEFAULT' }))
      .toBe('PINNED_DEFAULT_PROMPT');
  });

  it('Δ-2 skip: unmatched stepId / missing connection / null policy all keep the default text', () => {
    expect(applyPinnedStepPrompt(ctxWith({}), { slot: 'reasoning', stepId: 'extract', defaultText: 'DEFAULT' })).toBe('DEFAULT');
    expect(applyPinnedStepPrompt(ctxWith({ connectorBindings: {} }), { slot: 'reasoning', stepId: 'extract:build-prompt', defaultText: 'DEFAULT' })).toBe('DEFAULT');
    expect(applyPinnedStepPrompt(ctxWith({ profilePolicy: null }), { slot: 'reasoning', stepId: 'extract:build-prompt', defaultText: 'DEFAULT' })).toBe('DEFAULT');
  });

  it('a cleared (blank) pinned row falls through to the connector default unchanged', () => {
    expect(applyPinnedStepPrompt(ctxWith({ promptOverrides: [{ ...ROW, promptOverride: '   ' }] }), { slot: 'reasoning', stepId: 'extract:build-prompt', defaultText: 'DEFAULT' }))
      .toBe('DEFAULT');
  });

  it('a code-injected prompt outranks the pinned profile prompt', () => {
    expect(applyPinnedStepPrompt(ctxWith({}), { slot: 'reasoning', stepId: 'extract:build-prompt', defaultText: 'DEFAULT', codePrompt: 'CODE PROMPT' }))
      .toBe('CODE PROMPT');
  });

  it('observed request: the substituted prompt reaches ctx.connector.invoke', async () => {
    const ctx = new MockTaskContext();
    (ctx as unknown as { profilePolicy: unknown }).profilePolicy = POLICY;
    (ctx as unknown as { promptOverrides: unknown }).promptOverrides = [ROW];
    (ctx as unknown as { connectorBindings: unknown }).connectorBindings = { reasoning: 'conn-1@3' };
    const promptText = applyPinnedStepPrompt(ctx, { slot: 'reasoning', stepId: 'extract:build-prompt', defaultText: 'DEFAULT' });
    await ctx.connector.invoke('reasoning', { task: 'extract_invoice', payload: { promptText, documentSnippet: 'txt' } });
    const seen = (ctx.connectorInvocations[0]?.payload as { payload?: { promptText?: string } })?.payload?.promptText;
    expect(seen).toBe('PINNED_EXACT_PROMPT');
  });



describe('P745-CARRIER-IMPL-B2 B2-WIRING: every connector site declares a stepId', () => {
  const { documentCoreHandlers } = require('../src/worker');

  async function runAndCollect(action: string, payload: Record<string, unknown>) {
    const ctx = new MockTaskContext();
    ctx.defaultConnectorResponse = {
      invocationId: 'inv-x',
      status: 'SUCCESS',
      data: { result: 'ok' },
      rawText: 'ok',
    };
    try {
      await (documentCoreHandlers as Record<string, (c: unknown, p: unknown) => Promise<unknown>>)[action]!(ctx, payload);
    } catch (err) {
      // Output validation runs AFTER the invoke; the invariant under test is
      // the invoke site's declared options, so a later schema failure does
      // not invalidate the recorded call. An empty `calls` below still fails.
      if (ctx.connectorInvocations.length === 0) throw err;
    }
    return ctx.connectorInvocations;
  }

  it('extract declares the connector-inference stepId', async () => {
    const calls = await runAndCollect('extract', { type: 'invoice', text: 'INV' });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.options?.promptStepId).toBe('extract:connector-inference');
  });

  it('generate declares the connector-inference stepId', async () => {
    const calls = await runAndCollect('generate', { task: 'summary', text: 'x' });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.options?.promptStepId).toBe('generate:connector-inference');
  });

  it('analyze declares the connector-inference stepId', async () => {
    const calls = await runAndCollect('analyze', { task: 'classify', text: 'x', categories: ['a', 'b'] });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.options?.promptStepId).toBe('analyze:connector-inference');
  });

  it('transform declares the translate stepId', async () => {
    const calls = await runAndCollect('transform', { variant: 'translate', text: 'hi', targetLanguage: 'es' });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.options?.promptStepId).toBe('transform:execute-translate');
  });

  it('compare declares the semantic stepId', async () => {
    const calls = await runAndCollect('compare', { mode: 'semantic', source: { text: 'a' }, target: { text: 'b' } });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.options?.promptStepId).toBe('compare:execute-semantic');
  });
});

describe('P745-CARRIER-IMPL-B2 T7 adapter (Δ-B2-2 final-text assembly)', () => {
  it('substitutes the pinned prompt for the assembled text when promptStepId matches', async () => {
    const calls: { input?: { prompt?: string } }[] = [];
    const sdk = {
      taskId: 't1', operationId: 'op1', businessId: 'document-core', businessVersion: '1.0.0',
      tenantId: 'tenant-x', action: 'extract',
      signal: new AbortController().signal, deadlineAt: null, cancelRequested: false,
      artifacts: { read: async () => Buffer.from(''), write: async () => ({ artifactId: 'a1' }) },
      step: { run: async () => ({}), peek: async () => null },
      connector: {
        invoke: async (_slot: unknown, input: unknown, _o: unknown, _v: unknown) => {
          calls.push({ input: input as { prompt?: string } });
          return { invocationId: 'i1', state: 'SUCCEEDED', result: {} };
        },
      },
      profilePolicy: POLICY,
      promptOverrides: [ROW],
      connectorBindings: { reasoning: 'conn-1@3' },
    } as never;
    const internal = toInternalContext(sdk);
    await internal.connector.invoke('reasoning', { task: 'extract_invoice', payload: { promptText: 'DEFAULTPY' } }, { promptStepId: 'extract:build-prompt' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input?.prompt).toBe('PINNED_EXACT_PROMPT');
  });

  it('SKIPs the substitution when no promptStepId is supplied (assembled text used as-is)', async () => {
    const calls: { input?: { prompt?: string } }[] = [];
    const sdk = {
      taskId: 't1', operationId: 'op1', businessId: 'document-core', businessVersion: '1.0.0',
      tenantId: 'tenant-x', action: 'extract',
      signal: new AbortController().signal, deadlineAt: null, cancelRequested: false,
      artifacts: { read: async () => Buffer.from(''), write: async () => ({ artifactId: 'a1' }) },
      step: { run: async () => ({}), peek: async () => null },
      connector: {
        invoke: async (_slot: unknown, input: unknown, _o: unknown, _v: unknown) => {
          calls.push({ input: input as { prompt?: string } });
          return { invocationId: 'i1', state: 'SUCCEEDED', result: {} };
        },
      },
      profilePolicy: POLICY,
      promptOverrides: [ROW],
      connectorBindings: { reasoning: 'conn-1@3' },
    } as never;
    const internal = toInternalContext(sdk);
    await internal.connector.invoke('reasoning', { task: 'extract_invoice', payload: { promptText: 'DEFAULTPY' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input?.prompt).toBe('extract_invoice: DEFAULTPY');
  });
});

  it('connectionIdForSlot derives the connection from the pinned binding', () => {
    expect(connectionIdForSlot(ctxWith({}), 'reasoning')).toBe('conn-1');
    expect(connectionIdForSlot(ctxWith({ connectorBindings: {} }), 'reasoning')).toBeNull();
  });
});
