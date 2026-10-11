/**
 * 0039 — the key set a profile OWNS, as an admin read.
 *
 * Membership lives in `profile_api_keys`; credential metadata lives in
 * `api_keys`. The join is the whole answer: a profile's keys are exactly its
 * membership rows, and a membership whose key is REVOKED stays visible (with
 * `membershipState`) so the operator can see WHY a key stopped working
 * instead of watching it disappear from the list.
 *
 * The projected fields are the SAME set the tenant-wide api-keys list emits,
 * plus `membershipState` / `joinedAt` / `revokedAt` — so admin-web's
 * parseApiKeyPage reads this response unchanged.
 *
 * Tenant scope is a SQL predicate, never a JavaScript filter, so another
 * tenant's row cannot reach the wire and then get dropped there.
 */
import type { Db } from '../../db/db';
import { dateToIso } from './keyset';

export interface ProfileApiKeyRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  prefix: string;
  name: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
  membership_state: string;
  joined_at: Date;
  revoked_at: Date | null;
}

/** A profile's key set is small by design; this is a runaway cap, not pagination. */
export const PROFILE_API_KEY_LIMIT = 100;

export interface ProfileApiKeyList {
  items: Array<Record<string, unknown>>;
  nextCursor: null;
  prevCursor: null;
  total: number;
  limit: number;
  profileId: string;
}

/**
 * @param scope `''` = platform principal (any tenant); otherwise exactly one
 *   tenant, which becomes a SQL predicate. Rows outside the scope are not
 *   selected in the first place.
 */
export async function listProfileApiKeys(
  db: Db,
  profileId: string,
  scope: string
): Promise<ProfileApiKeyList> {
  const params: unknown[] = [profileId];
  const tenantClause = scope === '' ? '' : ' AND m.tenant_id = $2';
  if (scope !== '') params.push(scope);
  const rows = await db.query<ProfileApiKeyRow>(
    `SELECT k.id, k.tenant_id, k.prefix, k.name, k.status,
            k.created_at, k.updated_at,
            m.state AS membership_state, m.created_at AS joined_at, m.revoked_at
       FROM profile_api_keys m
       JOIN api_keys k ON k.id = m.api_key_id
      WHERE m.profile_id = $1${tenantClause}
      ORDER BY (m.state = 'ACTIVE') DESC, m.created_at DESC, k.id DESC
      LIMIT ${PROFILE_API_KEY_LIMIT}`,
    params
  );
  const counted = await db.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM profile_api_keys m WHERE m.profile_id = $1${tenantClause}`,
    params
  );
  return {
    items: rows.rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      prefix: r.prefix,
      name: r.name,
      maskedHint: r.prefix,
      status: r.status,
      createdAt: dateToIso(r.created_at),
      updatedAt: dateToIso(r.updated_at ?? r.created_at),
      membershipState: r.membership_state,
      joinedAt: dateToIso(r.joined_at),
      revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : dateToIso(r.revoked_at),
    })),
    nextCursor: null,
    prevCursor: null,
    total: counted.rows[0]?.total ?? rows.rows.length,
    limit: PROFILE_API_KEY_LIMIT,
    profileId,
  };
}
