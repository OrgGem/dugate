import { CostAdjustmentCommandSchema, type CostAdjustmentCommand, type CostAdjustmentHistoryPage } from '@du/contracts';
import type { AdminWebSession } from '../../lib/api';

export type CostAdjustmentFailureClass = 'maintenance-hold' | 'head-conflict' | 'idempotency-conflict' | 'unknown-acknowledgement' | 'other';

/** Interpret typed server failures before falling back to their HTTP status.
 * Several unrelated financial/maintenance errors use 409, so status alone
 * cannot tell the operator whether the reviewed head actually changed. */
export function classifyCostAdjustmentFailure(status: number, code: string | undefined): CostAdjustmentFailureClass {
  // A server/unavailable response cannot prove whether this exact write was
  // committed, even if a proxy included a stale or generic problem code.
  if (status === 0 || status >= 500) return 'unknown-acknowledgement';
  if (code === 'BACKUP_EFFECT_FENCE_ACTIVE') return 'maintenance-hold';
  if (code === 'COST_ADJUSTMENT_CAS_CONFLICT') return 'head-conflict';
  if (code === 'IDEMPOTENCY_CONFLICT') return 'idempotency-conflict';
  if (status === 423) return 'maintenance-hold';
  return 'other';
}

export function canWriteCostAdjustments(session: AdminWebSession): boolean {
  return session.role === 'admin' && session.principal.kind === 'platform';
}

export function adjustmentHistoryMatchesScope(page: CostAdjustmentHistoryPage, tenantId: string, rootEventId: string): boolean {
  return page.tenantId === tenantId && page.rootEventId === rootEventId;
}

/** Build only the typed request shown for review. The server remains the sole
 * authority for current net, refund limits, evidence pins and CAS outcome. */
export function buildCostAdjustmentReview(input: {
  tenantId: string;
  rootEventId: string;
  expectedAdjustmentRevision: number;
  kind: 'correction' | 'refund';
  amountText: string;
  reason: string;
  evidenceArtifactId: string;
}): CostAdjustmentCommand | null {
  if (!/^\d+$/.test(input.amountText)) return null;
  const amount = Number(input.amountText);
  if (!Number.isSafeInteger(amount) || amount < (input.kind === 'refund' ? 1 : 0)) return null;
  const base = {
    tenantId: input.tenantId,
    rootEventId: input.rootEventId,
    expectedAdjustmentRevision: input.expectedAdjustmentRevision,
    reason: input.reason.trim(),
    evidenceArtifactId: input.evidenceArtifactId,
  };
  const command = input.kind === 'correction'
    ? { ...base, kind: input.kind, targetChargeMicrousd: amount }
    : { ...base, kind: input.kind, refundMicrousd: amount };
  const parsed = CostAdjustmentCommandSchema.safeParse(command);
  return parsed.success ? parsed.data : null;
}
