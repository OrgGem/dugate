import type { CostPreflightResponse } from '@du/contracts';
import { AdapterRegistry } from '../src/adapters/registry';
import { AesCredentialCipher, DurableConnectorRuntime } from '../src/services';
import type { ConnectorCostControlClient } from '../src/cost-control-client';
import { InMemoryUsageOutbox } from '../src/db/usage-outbox';
import { InMemoryInvocationLedger } from '../src/ledger';
import { InMemoryQuotaStore } from '../src/quota';
import { hashInvocationInput } from '../src/hash';
import type {
  GrantClaims,
  LocalInvocationRequest,
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  NormalizedProviderResult,
} from '../src/types';
import type { ProviderTransport } from '../src/invoke';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OPERATION = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';
const API_KEY = '44444444-4444-4444-8444-444444444444';
const PROFILE = '55555555-5555-4555-8555-555555555555';
const GROUP = '66666666-6666-4666-8666-666666666666';
const CONNECTOR = 'openai-primary';
const GRANT = 'test-only-signed-cost-grant';

const price = {
  provider: 'openai',
  modelId: 'gpt-4o-2024-08-06',
  priceVersion: 3,
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  currency: 'USD' as const,
  inputMicrousdPerMillion: 2_000_000,
  cachedInputMicrousdPerMillion: 1_000_000,
  outputMicrousdPerMillion: 10_000_000,
};

function costContext() {
  return {
    selectionState: 'DEFERRED' as const,
    apiKeyId: API_KEY,
    profileId: PROFILE,
    profileRevision: 2,
    businessId: 'claims',
    businessVersion: 'v3',
    action: 'extract',
    attempt: 1,
    priceRevision: null,
    budgetReservationGroupId: GROUP,
    budgetPins: [],
  };
}

function preflightResponse(decision: 'ADMITTED' | 'BLOCKED', hardCapEnabled: boolean, noPrice = false): CostPreflightResponse {
  return {
    decision,
    selection: {
      state: 'FROZEN',
      reservationGroupId: GROUP,
      selectedAt: new Date().toISOString(),
      priceRevision: noPrice ? null : 3,
      pricingTier: noPrice ? null : price,
      budgetPins: noPrice ? [] : [{ budgetId: '77777777-7777-4777-8777-777777777777', revision: 4 }],
    },
    confidence: noPrice ? 'best-effort' : 'upper-bound',
    hardCapEnabled,
    evaluations: [],
  };
}

function makeRuntime(input: { decision?: 'ADMITTED' | 'BLOCKED'; transportFailure?: boolean; noPrice?: boolean; providerUsage?: unknown }) {
  const ledger = new InMemoryInvocationLedger();
  const sequence: string[] = [];
  const sent: ProviderRequest[] = [];
  const outbox = new InMemoryUsageOutbox();
  const cipher = new AesCredentialCipher(new Uint8Array(32).fill(7));
  const adapter: ProviderAdapter = {
    id: 'owner-cost-test',
    mode: 'json',
    asyncPollingMode: 'idempotency-key-replay',
    buildRequest: (_request, config) => ({
      url: config.baseUrl + config.path,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(config.headers ?? {}) },
      body: JSON.stringify({
        model: 'gpt-4o-2024-08-06',
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 128,
      }),
    }),
    normalizeResponse: (response: ProviderResponse) => response.body as NormalizedProviderResult,
    classifyFailure: () => 'PROVIDER_UNAVAILABLE',
  };
  const transport: ProviderTransport = {
    send: async (request) => {
      sequence.push('provider-send');
      sent.push(request);
      if (input.transportFailure) throw new Error('simulated ambiguous transport failure');
      return {
        status: 200,
        // The provider body is allowed to contain these names, but the
        // Connector must compute billable cost from its frozen trusted tier.
        body: { content: 'ok', usage: input.providerUsage ?? {
          inputTokens: 4,
          outputTokens: 2,
          provider: 'provider-claimed-by-response',
          model: 'model-claimed-by-response',
          costMicrousd: 1,
          costStatus: 'measured',
          measurement: 'measured',
        } },
      };
    },
  };
  const costControl: ConnectorCostControlClient = {
    preflight: async (_grant, proof) => {
      sequence.push('preflight');
      expect(proof.capabilityId).toBe('openai-gpt-4o-2024-08-06-chat-v1');
      return preflightResponse(input.decision ?? 'ADMITTED', input.decision === 'BLOCKED', input.noPrice);
    },
    transition: async (command) => { sequence.push('transition:' + command.target); },
  };
  const request = {
    contractVersion: '1' as const,
    invocationId: 'cost-' + (input.decision ?? 'success') + '-' + (input.transportFailure ? 'unknown' : 'normal'),
    grant: GRANT,
    operationId: OPERATION,
    taskId: TASK,
    stepKey: 'extract',
    bindingSlot: 'reasoning',
    input: { prompt: 'test' },
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
  };
  const local: LocalInvocationRequest = { ...request, tenantId: TENANT };
  const claims: GrantClaims = {
    audience: 'connector',
    tenantId: TENANT,
    operationId: OPERATION,
    taskId: TASK,
    stepKey: request.stepKey,
    invocationId: request.invocationId,
    inputHash: hashInvocationInput(local),
    connectorRevision: CONNECTOR + ':1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    bindingSlot: request.bindingSlot,
    costContext: costContext(),
  };
  const repository = {
    getRevision: async () => ({
      connectorId: CONNECTOR,
      revision: 1,
      adapter: adapter.id,
      state: 'ACTIVE',
      credentialRef: CONNECTOR + ':credential',
      credentialSource: { kind: 'legacy-db', credentialRef: CONNECTOR + ':credential' },
      // A legacy-db credential is valid only on the unbound migration chain.
      tenantId: '',
      config: { baseUrl: 'https://api.openai.com', path: '/v1/chat/completions', timeoutMs: 5_000 },
    }),
    getActiveCredential: async () => cipher.encrypt('safe-test-secret'),
  };
  const runtime = new DurableConnectorRuntime(
    ledger as never,
    repository as never,
    new InMemoryQuotaStore(),
    outbox as never,
    new AdapterRegistry([adapter]),
    transport,
    cipher,
    { verify: async () => claims },
    undefined,
    undefined,
    undefined,
    costControl,
  );
  return { runtime, request, ledger, sequence, sent, outbox };
}

describe('ORV14 Connector cost-controlled provider dispatch', () => {
  it('blocks before transport when a published hard cap denies the preflight', async () => {
    const fixture = makeRuntime({ decision: 'BLOCKED' });

    await expect(fixture.runtime.invoke(fixture.request)).rejects.toMatchObject({ code: 'BUDGET_LIMIT_EXCEEDED' });

    expect(fixture.sequence).toEqual(['preflight']);
    expect(fixture.sent).toHaveLength(0);
    expect(fixture.outbox.size()).toBe(0);
    expect((await fixture.ledger.get(fixture.request.invocationId))?.state).toBe('FAILED');
  });

  it('waits for RUNNING acknowledgement, then persists exact priced attribution in the usage outbox', async () => {
    const fixture = makeRuntime({});

    const result = await fixture.runtime.invoke(fixture.request);

    expect(result.state).toBe('completed');
    expect(fixture.sequence).toEqual(['preflight', 'transition:RUNNING', 'provider-send']);
    expect(fixture.sent).toHaveLength(1);
    expect(fixture.outbox.size()).toBe(1);
    const row = (await fixture.outbox.claimBatch(10))[0];
    expect(row?.payload.usage).toMatchObject({
      inputTokens: 4,
      outputTokens: 2,
      costMicrousd: 28,
      costStatus: 'estimated',
      provider: 'openai',
      model: 'gpt-4o-2024-08-06',
      costProvenance: {
        reservationGroupId: GROUP,
        confidence: 'upper-bound',
        priceRevision: 3,
        budgetPins: [{ budgetId: '77777777-7777-4777-8777-777777777777', revision: 4 }],
      },
    });
    expect(row?.payload.usage?.providerReportedCost).toEqual({
      costMicrousd: 1, currency: 'USD', source: 'provider-response', status: 'unverified',
    });
    await fixture.runtime.invoke(fixture.request);
    expect(fixture.sent).toHaveLength(1);
    expect(fixture.outbox.size()).toBe(1);
  });

  it('prices cached input as a subset of input and ignores provider money, status, model, and provenance claims', async () => {
    const fixture = makeRuntime({ providerUsage: {
      prompt_tokens: 4,
      completion_tokens: 2,
      total_tokens: 6,
      prompt_tokens_details: { cached_tokens: 3 },
      provider: 'untrusted-provider',
      model: 'untrusted-model',
      costMicrousd: Number.MAX_SAFE_INTEGER,
      costStatus: 'measured',
      costProvenance: { version: 1, tenantId: 'attacker-controlled' },
      measurement: 'estimated',
    } });

    await fixture.runtime.invoke(fixture.request);
    const row = (await fixture.outbox.claimBatch(10))[0];

    expect(row?.payload.usage).toMatchObject({
      inputTokens: 4,
      outputTokens: 2,
      cachedInputTokens: 3,
      costMicrousd: 25,
      costStatus: 'estimated',
      provider: 'openai',
      model: 'gpt-4o-2024-08-06',
    });
    expect(row?.payload.usage?.costProvenance?.tenantId).toBe(TENANT);
    expect(row?.payload.usage?.providerReportedCost).toEqual({
      costMicrousd: Number.MAX_SAFE_INTEGER, currency: 'USD', source: 'provider-response', status: 'unverified',
    });
  });

  it('withholds unsafe provider-reported money without affecting trusted computed cost', async () => {
    const fixture = makeRuntime({ providerUsage: {
      inputTokens: 4,
      outputTokens: 2,
      costMicrousd: Number.MAX_SAFE_INTEGER + 1,
      costStatus: 'measured',
    } });

    await fixture.runtime.invoke(fixture.request);
    const row = (await fixture.outbox.claimBatch(10))[0];

    expect(row?.payload.usage?.costMicrousd).toBe(28);
    expect(row?.payload.usage?.costStatus).toBe('estimated');
    expect(row?.payload.usage?.providerReportedCost).toBeUndefined();
  });

  it.each([
    ['fractional token count', { inputTokens: 1.5, outputTokens: 2 }],
    ['unsafe token count', { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0 }],
    ['cached tokens exceed input', { inputTokens: 4, outputTokens: 2, cachedInputTokens: 5 }],
    ['reported token total mismatches components', { prompt_tokens: 4, completion_tokens: 2, total_tokens: 99 }],
  ])('keeps invalid provider usage pending (%s)', async (_name, providerUsage) => {
    const fixture = makeRuntime({ providerUsage });

    const result = await fixture.runtime.invoke(fixture.request);
    const row = (await fixture.outbox.claimBatch(10))[0];

    expect(result.state).toBe('completed');
    expect(row?.payload.usage).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      costMicrousd: 0,
      costStatus: 'pending',
      measurement: 'estimated',
    });
  });

  it('keeps known units explicitly unpriced when no frozen price exists', async () => {
    const fixture = makeRuntime({ noPrice: true });

    await fixture.runtime.invoke(fixture.request);
    const row = (await fixture.outbox.claimBatch(10))[0];

    expect(row?.payload.usage).toMatchObject({
      inputTokens: 4,
      outputTokens: 2,
      costMicrousd: 0,
      costStatus: 'unpriced',
      measurement: 'measured',
      costProvenance: { priceRevision: null, priceSnapshot: null },
    });
    expect(row?.payload.usage?.providerReportedCost).toEqual({
      costMicrousd: 1, currency: 'USD', source: 'provider-response', status: 'unverified',
    });
  });

  it('keeps the reservation UNKNOWN after an ambiguous provider transport failure and never replays', async () => {
    const fixture = makeRuntime({ transportFailure: true });

    await expect(fixture.runtime.invoke(fixture.request)).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });

    expect(fixture.sequence).toEqual(['preflight', 'transition:RUNNING', 'provider-send', 'transition:UNKNOWN']);
    expect(fixture.outbox.size()).toBe(0);
    expect((await fixture.ledger.get(fixture.request.invocationId))?.state).toBe('UNKNOWN');
    await expect(fixture.runtime.invoke(fixture.request)).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });
    expect(fixture.sent).toHaveLength(1);
  });
});
