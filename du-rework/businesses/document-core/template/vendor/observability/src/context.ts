// VENDORED from @du/observability @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-06)
// source: packages/observability/src/context.ts (lines=56) sha256=71803F4E476E68105D20BDE2D344A1F7DD5B7443E11C111F6330BBBC696494FC
// why: createLogger for src/main.ts

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Correlation context (docs 12 observability): structured logs carry
 * operationId, taskId, stepKey, invocationId, business/version,
 * correlationId, leaseEpoch. Context propagates through async boundaries
 * via AsyncLocalStorage; never use operationId as a metric label.
 */

export interface CorrelationContext {
  correlationId: string;
  tenantId?: string;
  operationId?: string;
  taskId?: string;
  stepKey?: string;
  invocationId?: string;
  businessId?: string;
  businessVersion?: string;
  leaseEpoch?: number;
  component: string; // 'orchestrator' | 'connector' | 'worker' | ...
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export function runWithContext<T>(ctx: Partial<CorrelationContext> & { component: string }, fn: () => T): T {
  const full: CorrelationContext = {
    correlationId: ctx.correlationId ?? randomUUID(),
    ...ctx,
  };
  return storage.run(full, fn);
}

export function currentContext(): CorrelationContext | undefined {
  return storage.getStore();
}

/** Merge additional fields into the current context for a nested scope. */
export function withContext<T>(extra: Partial<CorrelationContext>, fn: () => T): T {
  const current = storage.getStore();
  if (!current) return fn();
  return storage.run({ ...current, ...extra }, fn);
}

/**
 * Validate/normalize a client-supplied correlation ID (docs 06):
 * length/charset checked, otherwise replaced with a server-generated ID.
 */
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

export function normalizeCorrelationId(candidate: unknown): string {
  if (typeof candidate === 'string' && CORRELATION_ID_PATTERN.test(candidate)) {
    return candidate;
  }
  return randomUUID();
}