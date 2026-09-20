import { ConnectorError } from './errors';
import { hashInvocationInput } from './hash';
import type {
  AdapterConfig,
  InvocationLedger,
  LocalInvocationRequest,
  NormalizedProviderResult,
  ProviderAdapter,
  ProviderResponse,
  QuotaStore,
  CredentialGuard,
} from './types';

export type AdapterInvocationOutcome =
  | { state: 'completed'; result: NormalizedProviderResult }
  | { state: 'pending'; nextPollAt: string };

export interface ProviderTransport {
  send(request: ReturnType<ProviderAdapter['buildRequest']>, signal?: AbortSignal): Promise<ProviderResponse>;
}

export interface InvokeAdapterOptions {
  ledger: InvocationLedger;
  quota: QuotaStore;
  adapter: ProviderAdapter;
  config: AdapterConfig;
  transport: ProviderTransport;
  quotaKey: string;
  quotaLeaseMs?: number;
  maxInFlight?: number;
  now?: () => number;
  credential?: CredentialGuard;
  providerTimeoutMs?: number;
}

export async function invokeAdapter(
  request: LocalInvocationRequest,
  options: InvokeAdapterOptions,
): Promise<AdapterInvocationOutcome> {
  const inputHash = hashInvocationInput(request);
  const claim = await options.ledger.claim(request, inputHash);
  if (claim.kind === 'conflict') {
    throw new ConnectorError('INPUT_HASH_MISMATCH', 'Invocation ID was already used with different input.');
  }
  if (claim.kind === 'replay') {
    if (claim.record.state === 'SUCCEEDED' && claim.record.result) {
      return { state: 'completed', result: claim.record.result };
    }
    if (claim.record.state === 'UNKNOWN') {
      throw new ConnectorError('INVOCATION_UNKNOWN', 'Invocation outcome requires reconciliation.');
    }
    if (claim.record.state === 'PENDING' && claim.record.nextPollAt) {
      if (options.credential && !(await options.credential.isActive())) {
        throw new ConnectorError('CREDENTIAL_INVALID', 'Connector credential has been revoked.');
      }
      return { state: 'pending', nextPollAt: claim.record.nextPollAt };
    }
  }

  const now = options.now ?? Date.now;
  const deadline = Date.parse(request.deadlineAt);
  if (!Number.isFinite(deadline) || deadline <= now()) {
    await options.ledger.fail(request.invocationId, 'PROVIDER_TIMEOUT');
    throw new ConnectorError('PROVIDER_TIMEOUT', 'Invocation deadline has expired.');
  }
  const lease = await options.quota.acquire(
    options.quotaKey,
    now(),
    options.quotaLeaseMs ?? 30_000,
    options.maxInFlight ?? 1,
  );
  if (!lease) throw new ConnectorError('QUOTA_EXHAUSTED', 'Provider quota is currently exhausted.', { retryAfterMs: 1000 });

  try {
    if (options.credential && !(await options.credential.isActive())) {
      await options.ledger.fail(request.invocationId, 'CREDENTIAL_INVALID');
      throw new ConnectorError('CREDENTIAL_INVALID', 'Connector credential has been revoked.');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.providerTimeoutMs ?? options.config.timeoutMs);
    let response: ProviderResponse;
    try {
      response = await options.transport.send(
        options.adapter.buildRequest(request, options.config),
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        await options.ledger.markUnknown(request.invocationId);
        throw new ConnectorError('PROVIDER_TIMEOUT', 'Provider timeout outcome requires reconciliation.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 202) {
      const body = response.body;
      const nextPollAt = body !== null && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).nextPollAt
        : undefined;
      if (typeof nextPollAt !== 'string') {
        await options.ledger.fail(request.invocationId, 'INVALID_PROVIDER_RESPONSE');
        throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Async provider response omitted nextPollAt.');
      }
      await options.ledger.markPending(request.invocationId, nextPollAt);
      return { state: 'pending', nextPollAt };
    }
    if (response.status < 200 || response.status >= 300) {
      const code = options.adapter.classifyFailure(response);
      await options.ledger.fail(request.invocationId, code);
      throw new ConnectorError(code, 'Provider request failed.', {
        retryAfterMs: response.status === 429 ? 1000 : undefined,
        safeToRetry: code === 'PROVIDER_RATE_LIMITED' || code === 'PROVIDER_UNAVAILABLE',
      });
    }
    const result = options.adapter.normalizeResponse(response, options.config);
    await options.ledger.complete(request.invocationId, result);
    return { state: 'completed', result };
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    await options.ledger.markUnknown(request.invocationId);
    throw new ConnectorError('INVOCATION_UNKNOWN', 'Provider outcome is unknown; reconciliation is required.');
  } finally {
    await options.quota.release(lease);
  }
}
