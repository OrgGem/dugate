/**
 * CONV-02: shared x-api-key resolution for the public and admin families
 * (moved verbatim out of server.ts). Fail-closed hash lookup: only ACTIVE
 * keys resolve, no fallback (R08-01).
 */
import { createHash } from 'node:crypto';
import { HttpError } from '../errors';
import type { RouteContext } from '../route-context';

export async function resolveApiKey(ctx: RouteContext): Promise<{ id: string; tenantId: string }> {
  const raw = ctx.headers['x-api-key'] as string | undefined;
  if (!raw) throw new HttpError(401, 'UNAUTHENTICATED', 'missing x-api-key');
  // Fail-closed hash lookup: only ACTIVE keys resolve. No fallback — unknown,
  // revoked, or cross-tenant keys are denied (R08-01).
  const hash = hashKey(raw);
  const res = await ctx.db.query('SELECT id, tenant_id FROM api_keys WHERE hash=$1 AND status=$2', [hash, 'ACTIVE']);
  if (res.rowCount) {
    const row = res.rows[0] as { id: string; tenant_id: string };
    return { id: row.id, tenantId: row.tenant_id };
  }
  throw new HttpError(401, 'UNAUTHENTICATED', 'invalid api key');
}

export function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
