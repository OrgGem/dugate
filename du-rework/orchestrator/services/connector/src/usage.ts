import { createHash } from 'node:crypto';
import type { UsageEvent as ContractUsageEvent } from '@du/contracts';
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

export function toContractUsageEvent(
  event: UsageEvent,
  context?: { operationId: string; taskId: string },
): ContractUsageEvent {
  const operationId = context?.operationId ?? event.operationId;
  const taskId = context?.taskId ?? event.taskId;
  if (!operationId || !taskId) throw new Error('Usage event operation/task identity is required.');
  return {
    eventId: event.eventId,
    invocationId: event.invocationId,
    operationId,
    taskId,
    units: {
      inputTokens: event.usage?.inputTokens ?? 0,
      outputTokens: event.usage?.outputTokens ?? 0,
      pages: event.usage?.pages,
    },
    costMicrousd: event.usage?.costMicrousd ?? 0,
    currency: 'USD',
    measurement: event.usage?.measurement ?? 'estimated',
    occurredAt: event.createdAt,
  };
}

export function appendUsageEvent(
  invocationId: string,
  attempt: number,
  usage: NormalizedProviderResult['usage'],
  context?: { operationId: string; taskId: string },
): UsageEvent | undefined {
  if (!usage) return undefined;
  const eventId = createHash('sha256').update(`${invocationId}:${attempt}`).digest('hex');
  return { eventId, invocationId, operationId: context?.operationId, taskId: context?.taskId, usage, createdAt: new Date().toISOString() };
}
