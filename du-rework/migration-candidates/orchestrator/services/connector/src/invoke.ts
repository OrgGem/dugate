import { ConnectorError, isRetryableErrorCode } from './errors';
import { hashInvocationInput } from './hash';
import type {
  AdapterConfig,
  ConnectorErrorCode,
  InvocationLedger,
  LocalInvocationRequest,
  NormalizedProviderResult,
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  QuotaLease,
  QuotaStore,
  CredentialGuard,
} from './types';

const MIN_PROVIDER_POLL_DELAY_MS = 1000;
const MAX_PROVIDER_POLL_DELAY_MS = 30_000;
const MAX_PROVIDER_POLL_ATTEMPTS = 16;
const PROVIDER_POLL_JITTER_RATIO = 0.2;
const QUOTA_RETRY_DELAY_MS = 1000;
const DEFAULT_QUOTA_LEASE_MS = 30_000;
const MAX_QUOTA_RENEWAL_REQUEST_MS = 1000;
const QUOTA_RENEWAL_TIMEOUT_FRACTION = 0.8;
const POLL_LEASE_BUFFER_MS = 5000;

export type AdapterInvocationOutcome =
  | { state: 'completed'; result: NormalizedProviderResult }
  | { state: 'pending'; nextPollAt: string; providerRequestId?: string };

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
  random?: () => number;
  credential?: CredentialGuard;
  providerTimeoutMs?: number;
}

export async function invokeAdapter(
  request: LocalInvocationRequest,
  options: InvokeAdapterOptions,
): Promise<AdapterInvocationOutcome> {
  const now = options.now ?? Date.now;
  const inputHash = hashInvocationInput(request);
  const claim = await options.ledger.claim(request, inputHash);
  if (claim.kind === 'conflict') {
    throw new ConnectorError('INPUT_HASH_MISMATCH', 'Invocation ID was already used with different input.');
  }
  const deadline = Date.parse(request.deadlineAt);
  let pollLeaseToken: string | undefined;
  const carriedQuotaLease = claim.kind === 'replay' ? claim.record.quotaLease : undefined;
  const providerPollAttempts = claim.kind === 'replay' ? (claim.record.providerPollAttempts ?? 0) : 0;
  const failAndReleaseCarriedLease = async (code: 'PROVIDER_TIMEOUT' | 'INVALID_PROVIDER_RESPONSE' | 'CREDENTIAL_INVALID') => {
    const currentPollLeaseToken = pollLeaseToken
      ?? (claim.kind === 'replay' ? claim.record.pollLeaseToken : undefined);
    await options.ledger.fail(request.invocationId, code, currentPollLeaseToken);
    await releaseQuotaLease(options.quota, carriedQuotaLease);
  };
  if (claim.kind === 'replay') {
    switch (claim.record.state) {
      case 'SUCCEEDED':
        if (claim.record.result) return { state: 'completed', result: claim.record.result };
        throw new ConnectorError('INVOCATION_UNKNOWN', 'Completed invocation has no stored result.');
      case 'FAILED':
        throw new ConnectorError(claim.record.errorCode ?? 'INVOCATION_UNKNOWN', 'Invocation has already failed.');
      case 'CANCELLED':
        throw new ConnectorError('CANCELLED', 'Invocation has been cancelled.');
      case 'UNKNOWN':
        throw new ConnectorError('INVOCATION_UNKNOWN', 'Invocation outcome requires reconciliation.');
      case 'IN_FLIGHT':
        // IN_FLIGHT is reserved for the first provider dispatch. It has no
        // recovery lease, so a replay must remain ambiguous and must not send.
        throw new ConnectorError('INVOCATION_UNKNOWN', 'Invocation outcome requires reconciliation.');
      case 'POLLING': {
        const currentTime = now();
        const leaseExpiresAt = claim.record.pollLeaseExpiresAt ? Date.parse(claim.record.pollLeaseExpiresAt) : Number.NaN;
        if (!claim.record.pollLeaseToken || !Number.isFinite(leaseExpiresAt)) {
          throw new ConnectorError('INVOCATION_UNKNOWN', 'Invocation outcome requires reconciliation.');
        }
        if (!Number.isFinite(deadline) || deadline <= currentTime) {
          await failAndReleaseCarriedLease('PROVIDER_TIMEOUT');
          throw new ConnectorError('PROVIDER_TIMEOUT', 'Invocation deadline has expired.');
        }
        if (currentTime < leaseExpiresAt) {
          return {
            state: 'pending',
            nextPollAt: claim.record.pollLeaseExpiresAt!,
            providerRequestId: claim.record.providerRequestId,
          };
        }
        pollLeaseToken = await options.ledger.claimPendingPoll(
          request.invocationId,
          inputHash,
          currentTime,
          Math.max(30_000, (options.providerTimeoutMs ?? options.config.timeoutMs) + POLL_LEASE_BUFFER_MS),
        );
        if (!pollLeaseToken) {
          const current = await options.ledger.get(request.invocationId);
          if (current?.state === 'SUCCEEDED' && current.result) return { state: 'completed', result: current.result };
          if (current?.state === 'PENDING' && current.nextPollAt) {
            return { state: 'pending', nextPollAt: current.nextPollAt, providerRequestId: current.providerRequestId };
          }
          if (current?.state === 'POLLING' && current.pollLeaseExpiresAt) {
            return { state: 'pending', nextPollAt: current.pollLeaseExpiresAt, providerRequestId: current.providerRequestId };
          }
          throw new ConnectorError('INVOCATION_UNKNOWN', 'Invocation poll recovery was claimed by another worker.');
        }
        if (providerPollAttempts >= MAX_PROVIDER_POLL_ATTEMPTS) {
          await options.ledger.markUnknown(request.invocationId, pollLeaseToken);
          throw new ConnectorError('INVOCATION_UNKNOWN', 'Provider poll budget is exhausted; reconciliation is required.');
        }
        break;
      }
      case 'PENDING': {
        if (options.credential && !(await options.credential.isActive())) {
          return failPendingReplay(
            request,
            inputHash,
            'CREDENTIAL_INVALID',
            'Connector credential has been revoked.',
            carriedQuotaLease,
            options,
          );
        }
        const nextPollAt = claim.record.nextPollAt ? Date.parse(claim.record.nextPollAt) : Number.NaN;
        if (!Number.isFinite(nextPollAt)) {
          return failPendingReplay(
            request,
            inputHash,
            'INVALID_PROVIDER_RESPONSE',
            'Pending invocation has no valid nextPollAt.',
            carriedQuotaLease,
            options,
          );
        }
        const currentTime = now();
        if (!Number.isFinite(deadline) || deadline <= currentTime) {
          return failPendingReplay(
            request,
            inputHash,
            'PROVIDER_TIMEOUT',
            'Invocation deadline has expired.',
            carriedQuotaLease,
            options,
          );
        }
        if (currentTime < nextPollAt) {
          return {
            state: 'pending',
            nextPollAt: claim.record.nextPollAt!,
            providerRequestId: claim.record.providerRequestId,
          };
        }
        pollLeaseToken = await options.ledger.claimPendingPoll(
          request.invocationId,
          inputHash,
          currentTime,
          Math.max(30_000, (options.providerTimeoutMs ?? options.config.timeoutMs) + POLL_LEASE_BUFFER_MS),
        );
        if (!pollLeaseToken) {
          const current = await options.ledger.get(request.invocationId);
          if (current?.inputHash !== inputHash) {
            throw new ConnectorError('INPUT_HASH_MISMATCH', 'Invocation ID was already used with different input.');
          }
          if (current?.state === 'SUCCEEDED' && current.result) {
            return { state: 'completed', result: current.result };
          }
          if (current?.state === 'PENDING' && current.nextPollAt) {
            return {
              state: 'pending',
              nextPollAt: current.nextPollAt,
              providerRequestId: current.providerRequestId,
            };
          }
          if (current?.state === 'POLLING' && current.pollLeaseExpiresAt) {
            return {
              state: 'pending',
              nextPollAt: current.pollLeaseExpiresAt,
              providerRequestId: current.providerRequestId,
            };
          }
          if (current?.state === 'FAILED') {
            throw new ConnectorError(current.errorCode ?? 'INVOCATION_UNKNOWN', 'Invocation has already failed.');
          }
          if (current?.state === 'CANCELLED') {
            throw new ConnectorError('CANCELLED', 'Invocation has been cancelled.');
          }
          throw new ConnectorError('INVOCATION_UNKNOWN', 'Invocation poll is already in flight or requires reconciliation.');
        }
        if (providerPollAttempts >= MAX_PROVIDER_POLL_ATTEMPTS) {
          await options.ledger.markUnknown(request.invocationId, pollLeaseToken);
          throw new ConnectorError('INVOCATION_UNKNOWN', 'Provider poll budget is exhausted; reconciliation is required.');
        }
        // The durable worker redelivery is the poll trigger. Continue below only
        // once due; the ledger CAS allows only one poller and the provider receives
        // the same invocation idempotency key.
        break;
      }
    }
  }

  const dispatchTime = now();
  if (!Number.isFinite(deadline) || deadline <= dispatchTime) {
    await options.ledger.fail(request.invocationId, 'PROVIDER_TIMEOUT', pollLeaseToken);
    await releaseQuotaLease(options.quota, carriedQuotaLease);
    throw new ConnectorError('PROVIDER_TIMEOUT', 'Invocation deadline has expired.');
  }
  const configuredTimeout = options.providerTimeoutMs ?? options.config.timeoutMs;
  const providerTimeoutMs = Math.max(1, Math.min(configuredTimeout, deadline - dispatchTime));
  const quotaAcquiredAt = now();
  if (deadline <= quotaAcquiredAt) {
    await options.ledger.fail(request.invocationId, 'PROVIDER_TIMEOUT', pollLeaseToken);
    await releaseQuotaLease(options.quota, carriedQuotaLease);
    throw new ConnectorError('PROVIDER_TIMEOUT', 'Invocation deadline has expired.');
  }
  const configuredQuotaLeaseMs = options.quotaLeaseMs ?? DEFAULT_QUOTA_LEASE_MS;
  const quotaLeaseWindowMs = Number.isFinite(configuredQuotaLeaseMs) && configuredQuotaLeaseMs > 0
    ? Math.min(DEFAULT_QUOTA_LEASE_MS, Math.floor(configuredQuotaLeaseMs))
    : DEFAULT_QUOTA_LEASE_MS;
  const requestedQuotaLeaseMs = Math.max(
    1,
    Math.min(quotaLeaseWindowMs, deadline - quotaAcquiredAt),
  );
  let lease: QuotaLease | undefined;
  let retainQuotaLease = Boolean(carriedQuotaLease);
  lease = carriedQuotaLease && carriedQuotaLease.expiresAt > quotaAcquiredAt ? carriedQuotaLease : undefined;
  try {
    if (!lease) {
      lease = await options.quota.acquire(
        options.quotaKey,
        quotaAcquiredAt,
        Math.min(requestedQuotaLeaseMs, deadline - quotaAcquiredAt),
        options.maxInFlight ?? 1,
      );
    }
  } catch {
    // The provider has not been contacted. A failed lease acquisition is safe to
    // retry after a short delay; if Redis acquired but lost the response, its
    // bounded lease still expires without a provider side effect.
    const retryTime = now();
    if (deadline <= retryTime) {
      await options.ledger.fail(request.invocationId, 'PROVIDER_TIMEOUT', pollLeaseToken);
      await releaseQuotaLease(options.quota, carriedQuotaLease);
      throw new ConnectorError('PROVIDER_TIMEOUT', 'Invocation deadline expired while acquiring quota.');
    }
    const retryAt = Math.min(deadline, retryTime + QUOTA_RETRY_DELAY_MS);
    await options.ledger.markPending(request.invocationId, new Date(retryAt).toISOString(), undefined, pollLeaseToken);
    throw new ConnectorError('QUOTA_EXHAUSTED', 'Provider quota lease could not be acquired.', {
      retryAfterMs: QUOTA_RETRY_DELAY_MS,
      safeToRetry: true,
    });
  }
  if (!lease) {
    const retryTime = now();
    if (deadline <= retryTime) {
      await options.ledger.fail(request.invocationId, 'PROVIDER_TIMEOUT', pollLeaseToken);
      await releaseQuotaLease(options.quota, carriedQuotaLease);
      throw new ConnectorError('PROVIDER_TIMEOUT', 'Invocation deadline expired while waiting for quota.');
    }
    const retryAt = Math.min(deadline, retryTime + QUOTA_RETRY_DELAY_MS);
    await options.ledger.markPending(request.invocationId, new Date(retryAt).toISOString(), undefined, pollLeaseToken);
    throw new ConnectorError('QUOTA_EXHAUSTED', 'Provider quota is currently exhausted.', {
      retryAfterMs: QUOTA_RETRY_DELAY_MS,
      safeToRetry: true,
    });
  }

  try {
    if (options.credential && !(await options.credential.isActive())) {
      await options.ledger.fail(request.invocationId, 'CREDENTIAL_INVALID', pollLeaseToken);
      retainQuotaLease = false;
      throw new ConnectorError('CREDENTIAL_INVALID', 'Connector credential has been revoked.');
    }
    const sendTime = now();
    if (deadline <= sendTime) {
      await options.ledger.fail(request.invocationId, 'PROVIDER_TIMEOUT', pollLeaseToken);
      retainQuotaLease = false;
      throw new ConnectorError('PROVIDER_TIMEOUT', 'Invocation deadline has expired.');
    }
    if (lease.expiresAt <= sendTime) {
      lease = await renewQuotaLeaseBounded(
        options.quota,
        lease,
        sendTime,
        Math.min(requestedQuotaLeaseMs, deadline - sendTime),
        Math.min(MAX_QUOTA_RENEWAL_REQUEST_MS, deadline - sendTime),
      );
      if (!lease) {
        const retryAt = Math.min(deadline, sendTime + QUOTA_RETRY_DELAY_MS);
        await options.ledger.markPending(request.invocationId, new Date(retryAt).toISOString(), undefined, pollLeaseToken);
        retainQuotaLease = false;
        throw new ConnectorError('QUOTA_EXHAUSTED', 'Provider quota lease expired before dispatch.', {
          retryAfterMs: QUOTA_RETRY_DELAY_MS,
          safeToRetry: true,
        });
      }
    }
    const controller = new AbortController();
    let quotaRenewalFailed = false;
    const renewal = startQuotaLeaseRenewal(
      options.quota,
      lease,
      requestedQuotaLeaseMs,
      deadline,
      now,
      () => {
        quotaRenewalFailed = true;
        controller.abort();
      },
    );
    const timeoutMs = Math.max(1, Math.min(configuredTimeout, deadline - sendTime));
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: ProviderResponse;
    try {
      const providerRequest = withInvocationIdempotencyKey(
        options.adapter.buildRequest(request, options.config),
        request.invocationId,
      );
      response = await options.transport.send(providerRequest, controller.signal);
      if (controller.signal.aborted || now() >= deadline) {
        retainQuotaLease = Boolean(renewal.getLease());
        await options.ledger.markUnknown(request.invocationId, pollLeaseToken);
        throw new ConnectorError(
          quotaRenewalFailed ? 'INVOCATION_UNKNOWN' : 'PROVIDER_TIMEOUT',
          quotaRenewalFailed
            ? 'Provider quota lease renewal failed; outcome requires reconciliation.'
            : 'Provider response arrived after the invocation deadline.',
        );
      }
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      if (controller.signal.aborted) {
        retainQuotaLease = Boolean(renewal.getLease());
        await options.ledger.markUnknown(request.invocationId, pollLeaseToken);
        throw new ConnectorError(
          quotaRenewalFailed ? 'INVOCATION_UNKNOWN' : 'PROVIDER_TIMEOUT',
          quotaRenewalFailed
            ? 'Provider quota lease renewal failed; outcome requires reconciliation.'
            : 'Provider timeout outcome requires reconciliation.',
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      await renewal.stop();
      lease = renewal.getLease();
    }
    if (quotaRenewalFailed || now() >= deadline) {
      retainQuotaLease = Boolean(lease);
      await options.ledger.markUnknown(request.invocationId, pollLeaseToken);
      throw new ConnectorError(
        quotaRenewalFailed ? 'INVOCATION_UNKNOWN' : 'PROVIDER_TIMEOUT',
        quotaRenewalFailed
          ? 'Provider quota lease renewal failed; outcome requires reconciliation.'
          : 'Provider response arrived after the invocation deadline.',
      );
    }
    if (response.status === 202) {
      if (
        options.adapter.asyncPollingMode !== 'idempotency-key-replay'
        || options.config.asyncPollingMode !== 'idempotency-key-replay'
      ) {
        await options.ledger.fail(request.invocationId, 'CAPABILITY_UNSUPPORTED', pollLeaseToken);
        retainQuotaLease = false;
        throw new ConnectorError(
          'CAPABILITY_UNSUPPORTED',
          'HTTP 202 requires the configured provider to declare idempotency-key replay support.',
        );
      }
      const body = response.body;
      const nextPollAt = body !== null && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).nextPollAt
        : undefined;
      const rawProviderRequestId = body !== null && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).providerRequestId
        : undefined;
      if (rawProviderRequestId !== undefined && (typeof rawProviderRequestId !== 'string' || rawProviderRequestId.length === 0)) {
        await options.ledger.fail(request.invocationId, 'INVALID_PROVIDER_RESPONSE', pollLeaseToken);
        retainQuotaLease = false;
        throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Async provider request ID is invalid.');
      }
      const providerRequestId = typeof rawProviderRequestId === 'string' ? rawProviderRequestId : undefined;
      const parsedNextPollAt = typeof nextPollAt === 'string' ? Date.parse(nextPollAt) : Number.NaN;
      if (!Number.isFinite(parsedNextPollAt)) {
        await options.ledger.fail(request.invocationId, 'INVALID_PROVIDER_RESPONSE', pollLeaseToken);
        retainQuotaLease = false;
        throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Async provider response omitted nextPollAt.');
      }
      const responseTime = now();
      if (deadline <= responseTime) {
        await options.ledger.fail(request.invocationId, 'PROVIDER_TIMEOUT', pollLeaseToken);
        retainQuotaLease = false;
        throw new ConnectorError('PROVIDER_TIMEOUT', 'Invocation deadline expired while provider was pending.');
      }
      const nextPollAttempt = providerPollAttempts + 1;
      const backoffMs = providerPollBackoffMs(nextPollAttempt, options.random ?? Math.random);
      const scheduledPollAt = Math.min(
        Math.max(parsedNextPollAt, responseTime + backoffMs),
        deadline,
      );
      const scheduledPollAtIso = new Date(scheduledPollAt).toISOString();
      const pendingRecord = await options.ledger.markPending(
        request.invocationId,
        scheduledPollAtIso,
        providerRequestId,
        pollLeaseToken,
        lease,
        true,
      );
      retainQuotaLease = true;
      return { state: 'pending', nextPollAt: scheduledPollAtIso, providerRequestId: pendingRecord.providerRequestId };
    }
    if (response.status < 200 || response.status >= 300) {
      const code = options.adapter.classifyFailure(response);
      await options.ledger.fail(request.invocationId, code, pollLeaseToken);
      retainQuotaLease = false;
      throw new ConnectorError(code, describeNonSuccessResponse(request, response.status), {
        retryAfterMs: response.status === 429 ? 1000 : undefined,
        safeToRetry: isRetryableErrorCode(code),
      });
    }
    let result: NormalizedProviderResult;
    try {
      result = options.adapter.normalizeResponse(response, options.config);
    } catch (error) {
      if (error instanceof ConnectorError) {
        await options.ledger.fail(request.invocationId, error.code, pollLeaseToken);
        retainQuotaLease = false;
      }
      throw error;
    }
    await options.ledger.complete(request.invocationId, result, pollLeaseToken);
    retainQuotaLease = false;
    return { state: 'completed', result };
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    retainQuotaLease = Boolean(lease);
    await options.ledger.markUnknown(request.invocationId, pollLeaseToken);
    throw new ConnectorError('INVOCATION_UNKNOWN', 'Provider outcome is unknown; reconciliation is required.');
  } finally {
    if (!retainQuotaLease) await releaseQuotaLease(options.quota, lease);
  }
}

/**
 * Diagnostics for a non-2xx provider response.
 *
 * The HTTP status is always safe to report and is the fact an operator is missing:
 * the previous fixed message said only 'Provider request failed.', so a request the
 * provider refused and a provider that broke were indistinguishable in the ledger.
 *
 * The task discriminator is echoed only when it still looks like the business-supplied
 * literal it normally is (`disbursement_classify`, `doc_compare_structure`, ...). `input`
 * is caller-supplied, so anything outside that shape is withheld rather than reflected —
 * this message travels to the orchestrator (http/server.ts:77) and must not become a
 * channel for echoing whatever arrived in the request.
 */
function describeNonSuccessResponse(request: LocalInvocationRequest, status: number): string {
  const task = request.input.task;
  const echoableTask = typeof task === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(task) ? task : undefined;
  return echoableTask === undefined
    ? `Provider returned HTTP ${status}.`
    : `Provider returned HTTP ${status} for task '${echoableTask}'.`;
}

function providerPollBackoffMs(attempt: number, random: () => number): number {
  const exponent = Math.min(Math.max(0, attempt - 1), 20);
  const baseMs = Math.min(MAX_PROVIDER_POLL_DELAY_MS, MIN_PROVIDER_POLL_DELAY_MS * (2 ** exponent));
  const sample = Math.max(0, Math.min(1, random()));
  const jittered = baseMs * (1 + PROVIDER_POLL_JITTER_RATIO * sample);
  return Math.min(MAX_PROVIDER_POLL_DELAY_MS, Math.max(1, Math.floor(jittered)));
}

async function failPendingReplay(
  request: LocalInvocationRequest,
  inputHash: string,
  errorCode: ConnectorErrorCode,
  message: string,
  carriedQuotaLease: QuotaLease | undefined,
  options: InvokeAdapterOptions,
): Promise<AdapterInvocationOutcome> {
  if (await options.ledger.failPending(request.invocationId, inputHash, errorCode)) {
    await releaseQuotaLease(options.quota, carriedQuotaLease);
    throw new ConnectorError(errorCode, message);
  }

  const current = await options.ledger.get(request.invocationId);
  if (current?.inputHash !== inputHash) {
    throw new ConnectorError('INPUT_HASH_MISMATCH', 'Invocation ID was already used with different input.');
  }
  if (current?.state === 'SUCCEEDED' && current.result) {
    return { state: 'completed', result: current.result };
  }
  if (current?.state === 'PENDING' && current.nextPollAt) {
    return { state: 'pending', nextPollAt: current.nextPollAt, providerRequestId: current.providerRequestId };
  }
  if (current?.state === 'POLLING' && current.pollLeaseExpiresAt) {
    return { state: 'pending', nextPollAt: current.pollLeaseExpiresAt, providerRequestId: current.providerRequestId };
  }
  if (current?.state === 'FAILED') {
    throw new ConnectorError(current.errorCode ?? errorCode, 'Invocation has already failed.');
  }
  if (current?.state === 'CANCELLED') throw new ConnectorError('CANCELLED', 'Invocation has been cancelled.');
  throw new ConnectorError('INVOCATION_UNKNOWN', 'Invocation state changed while handling a pending replay.');
}

async function releaseQuotaLease(quota: QuotaStore, lease?: QuotaLease): Promise<void> {
  if (!lease) return;
  try {
    await quota.release(lease);
  } catch {
    // Every lease expires no later than its invocation deadline.
  }
}

interface QuotaLeaseRenewal {
  getLease(): QuotaLease;
  stop(): Promise<void>;
}

function startQuotaLeaseRenewal(
  quota: QuotaStore,
  initialLease: QuotaLease,
  leaseWindowMs: number,
  deadline: number,
  now: () => number,
  onFailure: () => void,
): QuotaLeaseRenewal {
  let lease = initialLease;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let stopped = false;

  const schedule = () => {
    if (stopped || lease.expiresAt >= deadline) return;
    const currentTime = now();
    const remaining = lease.expiresAt - currentTime;
    if (remaining <= 0) {
      stopped = true;
      onFailure();
      return;
    }
    timer = setTimeout(() => {
      const operation = renew();
      inFlight = operation;
      void operation.finally(() => {
        if (inFlight === operation) inFlight = undefined;
      });
    }, Math.max(1, Math.floor(Math.min(remaining, leaseWindowMs) / 2)));
  };

  const renew = async () => {
    const renewalTime = now();
    if (stopped) return;
    const leaseRemainingMs = lease.expiresAt - renewalTime;
    if (deadline <= renewalTime || leaseRemainingMs <= 0) {
      stopped = true;
      onFailure();
      return;
    }
    const renewalTimeoutMs = Math.max(1, Math.floor(Math.min(
      MAX_QUOTA_RENEWAL_REQUEST_MS,
      leaseRemainingMs * QUOTA_RENEWAL_TIMEOUT_FRACTION,
      deadline - renewalTime,
    )));
    const renewed = await renewQuotaLeaseBounded(
      quota,
      lease,
      renewalTime,
      Math.min(leaseWindowMs, deadline - renewalTime),
      renewalTimeoutMs,
    );
    if (
      !renewed
      || renewed.leaseId !== lease.leaseId
      || renewed.key !== lease.key
      || renewed.expiresAt <= renewalTime
      || renewed.expiresAt > deadline
    ) {
      stopped = true;
      onFailure();
      return;
    }
    lease = renewed;
    schedule();
  };

  schedule();
  return {
    getLease: () => lease,
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (inFlight) await inFlight;
    },
  };
}

async function renewQuotaLeaseBounded(
  quota: QuotaStore,
  lease: QuotaLease,
  now: number,
  leaseMs: number,
  timeoutMs: number,
): Promise<QuotaLease | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => quota.renew(lease, now, leaseMs)).catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), Math.max(1, Math.floor(timeoutMs)));
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function withInvocationIdempotencyKey(request: ProviderRequest, invocationId: string): ProviderRequest {
  const headers = Object.fromEntries(
    Object.entries(request.headers).filter(([name]) => name.toLowerCase() !== 'idempotency-key'),
  );
  return { ...request, headers: { ...headers, 'Idempotency-Key': invocationId } };
}
