/**
 * CONV-02: shared x-api-key resolution for the public and admin families
 * (moved verbatim out of server.ts). Fail-closed hash lookup: only ACTIVE
 * keys resolve, no fallback (R08-01).
 *
 * PC-04: the resolver also enforces the explicit authority mode (migration 0070
 * `api_keys.key_mode`). A key whose mode is NULL/unknown is denied here — 0070
 * deliberately has no DEFAULT, so a NULL is a writer defect, never a
 * permission. PC-05 branches on the `keyMode` this returns; this module never
 * decides the standing of a grant.
 */
import { createHash } from 'node:crypto';
import { ApiKeyModeSchema, type ApiKeyMode } from '@du/contracts';
import { HttpError } from '../errors';
import type { RouteContext } from '../route-context';

export interface ResolvedApiKey {
  id: string;
  tenantId: string;
  /** Explicit authority mode; callers must branch on it, never assume one. */
  keyMode: ApiKeyMode;
}

export async function resolveApiKey(ctx: RouteContext): Promise<ResolvedApiKey> {
  const raw = ctx.headers['x-api-key'] as string | undefined;
  if (!raw) throw new HttpError(401, 'UNAUTHENTICATED', 'missing x-api-key');
  // Fail-closed hash lookup: only ACTIVE keys resolve. No fallback — unknown,
  // revoked, or cross-tenant keys are denied (R08-01).
  const hash = hashKey(raw);
  const res = await ctx.db.query(
    'SELECT id, tenant_id, key_mode FROM api_keys WHERE hash=$1 AND status=$2',
    [hash, 'ACTIVE'],
  );
  const row = res.rows[0] as { id: string; tenant_id: string; key_mode: string | null } | undefined;
  if (!row) throw new HttpError(401, 'UNAUTHENTICATED', 'invalid api key');
  const mode = ApiKeyModeSchema.safeParse(row.key_mode);
  if (!mode.success) {
    // Same wire answer as an invalid credential: the caller learns nothing, and
    // operators find the row through the PC-04 remediation query. Never guess
    // `UNMANAGED_LEGACY` here — that would turn a write bug into a grant.
    throw new HttpError(401, 'UNAUTHENTICATED', 'api key has no declared authority mode');
  }
  return { id: row.id, tenantId: row.tenant_id, keyMode: mode.data };
}

export function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
