import { hashInvocationInput, type InvocationInputHashParts } from '../src';

/**
 * W11-C1: canonical Connector invocation input hash.
 * The SDK, the Orchestrator grant signer and the Connector verifier must all
 * derive the identical digest for the same wire fields — this is what lets
 * Antigravity remove the E2E pendingHashes bridge.
 */
describe('canonical invocation input hash (W11-C1 / R08-02)', () => {
  const base: InvocationInputHashParts = {
    contractVersion: '1',
    tenantId: 'tenant-1',
    operationId: '11111111-1111-4111-8111-111111111111',
    taskId: '22222222-2222-4222-8222-222222222222',
    stepKey: 'connector-inference',
    bindingSlot: 'reasoning',
    input: { prompt: 'classify', text: 'invoice INV-1' },
    options: { temperature: 0 },
    sessionRef: null,
    deadlineAt: '2026-09-21T12:00:00.000Z',
  };

  it('is stable for identical wire fields', () => {
    expect(hashInvocationInput(base)).toBe(hashInvocationInput({ ...base }));
  });

  it('carries the sha256: prefix', () => {
    expect(hashInvocationInput(base).startsWith('sha256:')).toBe(true);
  });

  it('key order in input does not change the hash', () => {
    const reordered = { ...base, input: { text: 'invoice INV-1', prompt: 'classify' } };
    expect(hashInvocationInput(reordered)).toBe(hashInvocationInput(base));
  });

  it('omitted options hash identically to explicit empty options', () => {
    const { options: _dropped, ...without } = base;
    expect(hashInvocationInput(without)).toBe(hashInvocationInput({ ...base, options: {} }));
  });

  it('omitted sessionRef hashes identically to explicit null', () => {
    const { sessionRef: _dropped, ...without } = base;
    expect(hashInvocationInput(without)).toBe(hashInvocationInput(base));
  });

  it('differs when slot, step, task, input, options or deadline differ', () => {
    const variants: InvocationInputHashParts[] = [
      { ...base, bindingSlot: 'ocr' },
      { ...base, stepKey: 'other-step' },
      { ...base, taskId: '33333333-3333-4333-8333-333333333333' },
      { ...base, input: { prompt: 'classify', text: 'invoice INV-2' } },
      { ...base, options: { temperature: 1 } },
      { ...base, deadlineAt: '2026-09-21T12:05:00.000Z' },
    ];
    const digests = new Set([hashInvocationInput(base), ...variants.map((v) => hashInvocationInput(v))]);
    expect(digests.size).toBe(variants.length + 1);
  });
});
