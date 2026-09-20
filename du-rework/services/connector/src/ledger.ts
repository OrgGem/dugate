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

  public async complete(
    invocationId: string,
    result: NormalizedProviderResult,
  ): Promise<InvocationRecord> {
    const record = this.require(invocationId);
    if (record.state === 'SUCCEEDED') return record;
    if (record.state !== 'IN_FLIGHT') {
      throw new ConnectorError('INVOCATION_UNKNOWN', 'Invocation cannot be completed from its current state.');
    }
    const updated = {
      ...record,
      state: 'SUCCEEDED' as const,
      result,
      providerRequestId: result.providerRequestId,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(invocationId, updated);
    return updated;
  }

  public async fail(invocationId: string, errorCode: ConnectorErrorCode): Promise<InvocationRecord> {
    const record = this.require(invocationId);
    const updated = { ...record, state: 'FAILED' as const, errorCode, updatedAt: new Date().toISOString() };
    this.records.set(invocationId, updated);
    return updated;
  }

  public async cancel(invocationId: string): Promise<InvocationRecord> {
    const record = this.require(invocationId);
    if (record.state === 'CANCELLED') return record;
    if (record.state === 'SUCCEEDED' || record.state === 'FAILED') {
      throw new ConnectorError('INVOCATION_UNKNOWN', 'Invocation cannot be cancelled from its current state.');
    }
    const updated = { ...record, state: 'CANCELLED' as const, errorCode: 'CANCELLED' as const, updatedAt: new Date().toISOString() };
    this.records.set(invocationId, updated);
    return updated;
  }

  public async markUnknown(invocationId: string): Promise<InvocationRecord> {
    const record = this.require(invocationId);
    const updated = { ...record, state: 'UNKNOWN' as const, errorCode: 'INVOCATION_UNKNOWN' as const, updatedAt: new Date().toISOString() };
    this.records.set(invocationId, updated);
    return updated;
  }

  public async markPending(invocationId: string, nextPollAt: string): Promise<InvocationRecord> {
    const record = this.require(invocationId);
    const updated = {
      ...record,
      state: 'PENDING' as const,
      nextPollAt,
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
}

export function newInvocationId(): string {
  return randomUUID();
}
