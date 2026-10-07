import {
  hashInvocationInput as contractsHash,
} from '@du/contracts';
import { hashInvocationInput, type LocalInvocationRequest } from '../src';

/**
 * W11-C1: the Connector hash delegates to @du/contracts, so the digest the
 * Connector re-derives during grant validation is byte-identical to the one
 * the SDK hashed and the Orchestrator signed. If this drifts, the Antigravity
 * E2E bridge becomes load-bearing again — this test pins the delegation.
 */
describe('connector hash parity with @du/contracts (W11-C1)', () => {
  const request: LocalInvocationRequest = {
    contractVersion: '1',
    invocationId: 'inv-parity',
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

  test('connector digest equals the contracts digest for the same wire fields', () => {
    expect(hashInvocationInput(request)).toBe(
      contractsHash({
        contractVersion: request.contractVersion,
        tenantId: request.tenantId,
        operationId: request.operationId,
        taskId: request.taskId,
        stepKey: request.stepKey,
        bindingSlot: request.bindingSlot,
        input: request.input,
        options: request.options,
        sessionRef: request.sessionRef,
        deadlineAt: request.deadlineAt,
      })
    );
  });

  test('omitted options/sessionRef hash identically on both sides', () => {
    const sparse: LocalInvocationRequest = { ...request };
    delete sparse.options;
    delete sparse.sessionRef;
    expect(hashInvocationInput(sparse)).toBe(
      contractsHash({
        contractVersion: sparse.contractVersion,
        tenantId: sparse.tenantId,
        operationId: sparse.operationId,
        taskId: sparse.taskId,
        stepKey: sparse.stepKey,
        bindingSlot: sparse.bindingSlot,
        input: sparse.input,
        deadlineAt: sparse.deadlineAt,
      })
    );
  });
});
