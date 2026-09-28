import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { Db } from '../../db/db';
import { HttpError, forbidden } from '../../http/errors';

/**
 * Profile-bound authorization (P2-02 / R08-02, W13-C).
 *
 * One immutable row per (profile_id, revision) in `profile_bindings` maps an
 * API key to (business, version, action) plus the slot → connector pin:
 * `{ [slot]: { connectorId, revision } }`. Submission resolves the key's
 * LATEST revision for the requested action and pins it onto the operation;
 * grant issuance and claim snapshots read the pin, never the live profile —
 * so a mid-operation revision change affects new submissions only (PRF-02).
 *
 * Interim policy (see Claude lane report): a key with NO binding rows stays
 * on the legacy path (manifest-declared slots + deployment connector opts).
 * A key with ≥1 row is confined to its bindings: no match → 403.
 */

export interface SlotPin {
  connectorId: string;
  revision: number;
}

export type ConnectorPinMap = Record<string, SlotPin>;

export type BindingResolution =
  | { mode: 'legacy' }
  | { mode: 'pinned'; profileId: string; revision: number; bindings: ConnectorPinMap };

export function parseConnectorBindings(raw: unknown): ConnectorPinMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'connectorBindings must be an object of slot -> {connectorId, revision}');
  }
  const out: ConnectorPinMap = {};
  for (const [slot, pin] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof pin !== 'object' || pin === null || Array.isArray(pin)) {
      throw new HttpError(422, 'INVALID_SCHEMA', `connectorBindings[${slot}] must be {connectorId, revision}`);
    }
    const p = pin as Record<string, unknown>;
    if (typeof p.connectorId !== 'string' || p.connectorId.length === 0) {
      throw new HttpError(422, 'INVALID_SCHEMA', `connectorBindings[${slot}].connectorId must be a non-empty string`);
    }
    if (typeof p.revision !== 'number' || !Number.isInteger(p.revision) || (p.revision as number) < 1) {
      throw new HttpError(422, 'INVALID_SCHEMA', `connectorBindings[${slot}].revision must be a positive integer`);
    }
    out[slot] = { connectorId: p.connectorId, revision: p.revision as number };
  }
  return out;
}

/**
 * Render the operation pin (slot → "connectorId@revision") for the claim
 * snapshot's `pinned.connectorBindings` wire shape (ExecutionSnapshotSchema).
 */
export function renderPinnedBindings(bindings: ConnectorPinMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [slot, pin] of Object.entries(bindings)) {
    out[slot] = `${pin.connectorId}@${pin.revision}`;
  }
  return out;
}

export interface CreateBindingInput {
  profileId?: string;
  apiKeyHash: string;
  businessId: string;
  businessVersion: string;
  action: string;
  connectorBindings: unknown;
}

export function createProfileService(db: Db) {
  return {
    /** Admin: append the next immutable revision for a profile (creates the profile when omitted).
     *  W48-C1: also returns the bound key's tenant/app identity so the admin
     *  audit ledger can attribute the grant (tenant-scoped read predicate).
     *  Additive — existing callers destructuring { profileId, revision } are unaffected. */
    async createRevision(
      input: CreateBindingInput,
      activeClient?: PoolClient
    ): Promise<{
      profileId: string;
      revision: number;
      tenantId: string;
      apiKeyId: string;
    }> {
      // R3-01: when the admin route passes its open tx client, every read and
      // write here runs inside the route's transaction so the binding row and
      // its audit row commit (or roll back) together. Standalone callers get
      // their own transaction (previously untx'ed).
      const run = async (
        c: PoolClient
      ): Promise<{ profileId: string; revision: number; tenantId: string; apiKeyId: string }> => {
        const bindings = parseConnectorBindings(input.connectorBindings);
        if (!input.businessId || !input.businessVersion || !input.action) {
          throw new HttpError(422, 'INVALID_SCHEMA', 'businessId, businessVersion and action are required');
        }
        const keyRes = await c.query<{ id: string; tenant_id: string }>(
          'SELECT id, tenant_id FROM api_keys WHERE hash=$1 AND status=$2',
          [input.apiKeyHash, 'ACTIVE']
        );
        if (!keyRes.rowCount) throw new HttpError(404, 'NOT_FOUND', 'api key not found or not ACTIVE');
        const key = keyRes.rows[0]!;
        const profileId = input.profileId ?? randomUUID();
        const maxRes = await c.query<{ m: number | null }>(
          'SELECT max(revision) AS m FROM profile_bindings WHERE profile_id=$1',
          [profileId]
        );
        const revision = (maxRes.rows[0]?.m ?? 0) + 1;
        await c.query(
          `INSERT INTO profile_bindings
             (profile_id, revision, tenant_id, api_key_id, business_id, business_version, action, connector_bindings)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            profileId,
            revision,
            key.tenant_id,
            key.id,
            input.businessId,
            input.businessVersion,
            input.action,
            JSON.stringify(bindings),
          ]
        );
        return { profileId, revision, tenantId: key.tenant_id, apiKeyId: key.id };
      };
      return activeClient ? run(activeClient) : db.tx(run);
    },

    /** Submission-time: resolve the key's latest binding for (business, version, action). */
    async resolveBinding(
      apiKeyId: string,
      businessId: string,
      businessVersion: string,
      action: string
    ): Promise<BindingResolution> {
      const hit = await db.query<{ profile_id: string; revision: number; connector_bindings: ConnectorPinMap }>(
        `SELECT profile_id, revision, connector_bindings FROM profile_bindings
         WHERE api_key_id=$1 AND business_id=$2 AND business_version=$3 AND action=$4
         ORDER BY revision DESC LIMIT 1`,
        [apiKeyId, businessId, businessVersion, action]
      );
      if (hit.rowCount) {
        const row = hit.rows[0]!;
        return {
          mode: 'pinned',
          profileId: row.profile_id,
          revision: row.revision,
          bindings: parseConnectorBindings(row.connector_bindings),
        };
      }
      // Key in profile mode but not authorized for this action → 403, nothing
      // enqueued (PRF-01). Keys with no bindings at all stay legacy.
      const anyRes = await db.query('SELECT 1 FROM profile_bindings WHERE api_key_id=$1 LIMIT 1', [apiKeyId]);
      if (anyRes.rowCount) {
        throw forbidden(`api key is not authorized for action ${action} on ${businessId}@${businessVersion}`);
      }
      return { mode: 'legacy' };
    },
  };
}

export type ProfileService = ReturnType<typeof createProfileService>;
