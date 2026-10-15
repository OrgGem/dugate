import { createHash } from 'node:crypto';
import { ConnectorError } from './errors';
import { UsageEventSchema, type UsageEvent as ContractUsageEvent } from '@du/contracts';
import type { NormalizedProviderResult } from './types';

export interface UsageEvent {
  eventId: string;
  invocationId: string;
  operationId?: string;
  taskId?: string;
  usage: NormalizedProviderResult['usage'];
  createdAt: string;
}

export type ConnectorUsageEvent = ContractUsageEvent;

export function usageEventId(invocationId: string, attempt: number): string {
  return createHash('sha256').update(`${invocationId}:${attempt}`).digest('hex');
}

export function toContractUsageEvent(
  event: UsageEvent,
  context?: { operationId: string; taskId: string },
): ContractUsageEvent {
  const amounts = [event.usage?.inputTokens, event.usage?.outputTokens, event.usage?.cachedInputTokens, event.usage?.pages, event.usage?.costMicrousd];
  if (amounts.some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) {
    throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Provider usage requires nonnegative safe integer amounts.');
  }
  const operationId = context?.operationId ?? event.operationId;
  const taskId = context?.taskId ?? event.taskId;
  if (!operationId || !taskId) throw new Error('Usage event operation/task identity is required.');
  return UsageEventSchema.parse({
    eventId: event.eventId,
    invocationId: event.invocationId,
    operationId,
    taskId,
    units: {
      inputTokens: event.usage?.inputTokens ?? 0,
      outputTokens: event.usage?.outputTokens ?? 0,
      cachedInputTokens: event.usage?.cachedInputTokens,
      pages: event.usage?.pages,
    },
    costMicrousd: event.usage?.costMicrousd ?? 0,
    currency: 'USD',
    provider: event.usage?.provider,
    model: event.usage?.model,
    costStatus: event.usage?.costStatus
      ?? (event.usage?.costMicrousd === undefined ? 'unpriced' : event.usage.measurement ?? 'estimated'),
    measurement: event.usage?.measurement ?? 'estimated',
    costProvenance: event.usage?.costProvenance,
    providerReportedCost: event.usage?.providerReportedCost,
    occurredAt: event.createdAt,
  });
}

export function appendUsageEvent(
  invocationId: string,
  attempt: number,
  usage: NormalizedProviderResult['usage'],
  context?: { operationId: string; taskId: string },
): UsageEvent | undefined {
  if (!usage) return undefined;
  const eventId = usageEventId(invocationId, attempt);
  return { eventId, invocationId, operationId: context?.operationId, taskId: context?.taskId, usage, createdAt: new Date().toISOString() };
}
