import { createHash } from 'node:crypto';
import type { LocalInvocationRequest } from './types';

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`;
}

export function canonicalInput(request: LocalInvocationRequest): string {
  return canonicalize({
    contractVersion: request.contractVersion,
    tenantId: request.tenantId,
    operationId: request.operationId,
    taskId: request.taskId,
    stepKey: request.stepKey,
    bindingSlot: request.bindingSlot,
    input: request.input,
    options: request.options ?? {},
    sessionRef: request.sessionRef ?? null,
    deadlineAt: request.deadlineAt,
  });
}

export function hashInvocationInput(request: LocalInvocationRequest): string {
  return createHash('sha256').update(canonicalInput(request)).digest('hex');
}
