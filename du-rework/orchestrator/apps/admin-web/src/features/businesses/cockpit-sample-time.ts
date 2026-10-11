/**
 * The newest timestamp a payload carries, or null - never a fabricated now.
 *
 * Lives in its own .ts rather than in the .tsx because admin-web runs
 * `node --test` over tests/*.test.mjs, and Node type-stripping does not
 * handle JSX.
 */
export interface TimestampedRow {
  observedAt?: string;
  updatedAt?: string | null;
  createdAt?: string;
}

export function newest(rows: TimestampedRow[]): string | null {
  let best: string | null = null;
  for (const row of rows) {
    const value = row.observedAt ?? row.updatedAt ?? row.createdAt ?? null;
    if (value !== null && (best === null || value > best)) best = value;
  }
  return best;
}
