import { randomUUID } from 'node:crypto';
import { ConnectorError } from './errors';
import type {
  InvocationLedger,
  InvocationRecord,
  LocalInvocationRequest,
  NormalizedProviderResult,
  ConnectorErrorCode,
} from './types';

export class InMemoryInvocationLedger implements InvocationLedger {
  private readonly records = new Map<string, InvocationRecord>();

  public async get(invocationId: string): Promise<InvocationRecord | undefined> {
    return this.records.get(invocationId);
  }

  public async claim(
    request: LocalInvocationRequest,
    inputHash: string,
  ): Promise<
    | { kind: 'claimed'; record: InvocationRecord }
    | { kind: 'replay'; record: InvocationRecord }
    | { kind: 'conflict'; record: InvocationRecord }
  > {
    const existing = this.records.get(request.invocationId);
    if (existing) {
      return existing.inputHash === inputHash
        ? { kind: 'replay', record: existing }
        : { kind: 'conflict', record: existing };
    }
    const record: InvocationRecord = {
      request,
      inputHash,
      state: 'IN_FLIGHT',
      updatedAt: new Date().toISOString(),
    };
    this.records.set(request.invocationId, record);
    return { kind: 'claimed', record };
  }

  public async claimPendingPoll(
    invocationId: string,
    inputHash: string,
    now: number,
    leaseMs: number,
  ): Promise<string | undefined> {
    const record = this.records.get(invocationId);
    if (!record || record.inputHash !== inputHash) return undefined;
    const pendingIsDue = record.state === 'PENDING'
      && Boolean(record.nextPollAt)
      && Date.parse(record.nextPollAt!) <= now;
    const pollLeaseExpired = record.state === 'POLLING'
      && Boolean(record.pollLeaseToken && record.pollLeaseExpiresAt)
      && Date.parse(record.pollLeaseExpiresAt!) <= now;
    if (!pendingIsDue && !pollLeaseExpired) {
      return undefined;
    }
    const pollLeaseToken = randomUUID();
    this.records.set(invocationId, {
      ...record,
      state: 'POLLING',
      pollLeaseToken,
      pollLeaseExpiresAt: new Date(now + leaseMs).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });
    return pollLeaseToken;
  }

  public async complete(
    invocationId: string,
    result: NormalizedProviderResult,
    pollLeaseToken?: string,
  ): Promise<InvocationRecord> {
    const record = this.require(invocationId);
    if (record.state === 'SUCCEEDED' && pollLeaseToken === undefined) return record;
    this.assertMutationLease(record, pollLeaseToken);
    if (record.state !== 'IN_FLIGHT' && record.state !== 'POLLING') {
      throw new ConnectorError('INVOCATION_UNKNOWN', 'Invocation cannot be completed from its current state.');
    }
    const updated = {
      ...record,
      state: 'SUCCEEDED' as const,
      result,
      providerRequestId: result.providerRequestId,
      pollLeaseToken: undefined,
      pollLeaseExpiresAt: undefined,
      quotaLease: undefined,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(invocationId, updated);
    return updated;
  }

  public async failPending(invocationId: string, inputHash: string, errorCode: ConnectorErrorCode): Promise<boolean> {
    const record = this.records.get(invocationId);
    if (!record || record.inputHash !== inputHash || record.state !== 'PENDING') return false;
    this.records.set(invocationId, {
      ...record,
      state: 'FAILED',
      errorCode,
      pollLeaseToken: undefined,
      pollLeaseExpiresAt: undefined,
      quotaLease: undefined,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  public async fail(invocationId: string, errorCode: ConnectorErrorCode, pollLeaseToken?: string): Promise<InvocationRecord> {
    const record = this.require(invocationId);
    this.assertMutationLease(record, pollLeaseToken);
    const updated = {
      ...record,
      state: 'FAILED' as const,
      errorCode,
      pollLeaseToken: undefined,
      pollLeaseExpiresAt: undefined,
      quotaLease: undefined,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(invocationId, updated);
    return updated;
  }

  public async cancel(invocationId: string): Promise<InvocationRecord> {
    const record = this.require(invocationId);
    if (record.state === 'CANCELLED') return record;
    if (record.state !== 'IN_FLIGHT' && record.state !== 'PENDING' && record.state !== 'POLLING') {
      throw new ConnectorError('INVOCATION_UNKNOWN', 'Invocation cannot be cancelled from its current state.');
    }
    const updated = {
      ...record,
      state: 'CANCELLED' as const,
      errorCode: 'CANCELLED' as const,
      pollLeaseToken: undefined,
      pollLeaseExpiresAt: undefined,
      quotaLease: undefined,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(invocationId, updated);
    return updated;
  }

  public async markUnknown(invocationId: string, pollLeaseToken?: string): Promise<InvocationRecord> {
    const record = this.require(invocationId);
    this.assertMutationLease(record, pollLeaseToken);
    const updated = {
      ...record,
      state: 'UNKNOWN' as const,
      errorCode: 'INVOCATION_UNKNOWN' as const,
      pollLeaseToken: undefined,
      pollLeaseExpiresAt: undefined,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(invocationId, updated);
    return updated;
  }

  public async markPending(
    invocationId: string,
    nextPollAt: string,
    providerRequestId?: string,
    pollLeaseToken?: string,
    quotaLease?: import('./types').QuotaLease,
    providerPollAttempt = false,
    sessionRef?: string | null,
  ): Promise<InvocationRecord> {
    const record = this.require(invocationId);
    this.assertMutationLease(record, pollLeaseToken);
    const updated = {
      ...record,
      state: 'PENDING' as const,
      nextPollAt,
      providerRequestId: providerRequestId ?? record.providerRequestId,
      // CR06-04: first non-null provider session wins; a later poll that
      // omits sessionRef must not erase one already captured.
      sessionRef: sessionRef ?? record.sessionRef,
      pollLeaseToken: undefined,
      pollLeaseExpiresAt: undefined,
      quotaLease: quotaLease ?? record.quotaLease,
      providerPollAttempts: (record.providerPollAttempts ?? 0) + (providerPollAttempt ? 1 : 0),
      updatedAt: new Date().toISOString(),
    };
    this.records.set(invocationId, updated);
    return updated;
  }

  private require(invocationId: string): InvocationRecord {
    const record = this.records.get(invocationId);
    if (!record) throw new ConnectorError('INVALID_INPUT', `Unknown invocation ${invocationId}.`);
    return record;
  }

  private assertMutationLease(record: InvocationRecord, pollLeaseToken?: string): void {
    const valid = pollLeaseToken === undefined
      ? record.state === 'IN_FLIGHT'
      : record.state === 'POLLING' && record.pollLeaseToken === pollLeaseToken;
    if (!valid) {
      throw new ConnectorError('INVOCATION_UNKNOWN', 'Invocation poll lease is no longer current.');
    }
  }
}

export function newInvocationId(): string {
  return randomUUID();
}
