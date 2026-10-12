export function usageCostState(summary: Record<string, unknown>): { label: string; description: string; knownCostUsd: number | null; incomplete: boolean } {
  const raw = summary.totals;
  const totals = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const amount = totals.costMicrousd;
  const knownCostUsd = typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0 ? amount / 1_000_000 : null;
  switch (totals.costStatus) {
    case 'measured': return { label: 'Computed net cost', description: 'The server projects current net cost from measured units, the frozen price snapshot, and direct-root financial adjustments. Provider-reported amounts stay separate unverified diagnostics; this is not a final invoice.', knownCostUsd, incomplete: false };
    case 'estimated': return { label: 'Estimated net cost', description: 'Some current net cost uses estimated usage. Reconcile with provider billing before using it as final spend.', knownCostUsd, incomplete: true };
    case 'unpriced': return { label: 'Unpriced usage remains', description: 'Known accrued net cost excludes usage without a price. A recorded zero does not mean the requests were free.', knownCostUsd, incomplete: true };
    case 'pending': return { label: 'Cost pending', description: 'Cost information is still pending. Known accrued net cost does not represent the final total.', knownCostUsd, incomplete: true };
    default: return { label: 'Cost completeness unknown', description: 'This response has no cost classification. Do not infer finality or free usage from a missing status or a zero amount.', knownCostUsd, incomplete: true };
  }
}
