import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  InvocationGrantRequestSchema,
  type InvocationGrant,
} from '@du/contracts';
import { Db } from '../../db/db';
import { conflict, notFound, unprocessable } from '../../http/errors';
import { parseConnectorBindings } from '../profiles/profiles';

/**
 * Invocation grant issuance (P2-07 / R08-02). The worker asks the Orchestrator
 * for a short-lived Connector invocation grant bound to (task, step, slot,
 * inputHash). The Orchestrator signs it HS256 with INVOCATION_GRANT_SECRET
 * using the exact header/claims shape the Connector's ContractSignedGrantVerifier
 * expects. Fail-closed: if the secret is absent the service throws instead of
 * issuing an unsigned grant.
 *
 * Stable identity (R08-02 / W11-C1 / W12-C): the invocationId is a deterministic
 * function of the LOGICAL key (taskId, stepKey, bindingSlot) only. It deliberately omits
 * both the inputHash (a differing hash for the same key is a 409 conflict, not
 * a new identity) and any checkpoint generation (generations version step
 * OUTPUTS; the invocation identity is the logical request, reconciled against
 * the stored input_hash row). Fields are length-prefixed before HMAC so no
 * delimiter collision across field boundaries can alias two logical keys.
 * request. A transport retry or a real recovery reuses the same ID, so the
 * Connector ledger dedupes to one provider execution. A conflicting input hash
 * for the same (task, step, slot) is rejected (INPUT_HASH_MISMATCH) — never
 * blind-retried as a new provider call.
 */

const GRANT_TTL_SECONDS = 15 * 60;

export interface GrantService {
  /** Connector identity the worker is allowed to invoke for this task's slots. */
  connectorId: string;
  connectorRevision: number;
  issue(taskId: string, leaseEpoch: number, body: unknown): Promise<InvocationGrant>;
}

/**
 * Deterministic UUIDv5-style invocation identity from the logical key. The
 * namespace seed is fixed; the digest is folded into RFC-4122 layout so the
 * value is a valid UUID without a real v5 library.
 */
/** Length-prefix one frame so delimiter collisions across fields are impossible. */
function frame(value: string): string {
  return `${value.length}:${value}`;
}

function stableInvocationId(taskId: string, stepKey: string, bindingSlot: string): string {
  const ns = '1b671a64-40d5-491e-99b0-190777e0c4e3';
  const digest = createHmac('sha256', ns).update(frame(taskId) + '|' + frame(stepKey) + '|' + frame(bindingSlot)).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  // Set version (5) and variant (RFC 4122) bits per RFC 4122 §4.4.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Parse the operation pin ("connectorId@revision" per slot) back to the
 * structured pin. Submission writes the pin via renderPinnedBindings; claims
 * and grants read this row — never the live profile (PRF-02).
 */
function parsePinnedBindings(raw: unknown): Record<string, { connectorId: string; revision: number }> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw conflict('BINDING_DENIED', 'operation carries a malformed connector pin');
  }
  const structured: Record<string, unknown> = {};
  for (const [slot, rendered] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof rendered !== 'string') {
      throw conflict('BINDING_DENIED', `operation pin for slot ${slot} is malformed`);
    }
    const at = rendered.lastIndexOf('@');
    if (at <= 0) throw conflict('BINDING_DENIED', `operation pin for slot ${slot} is malformed`);
    const revision = Number(rendered.slice(at + 1));
    if (!Number.isInteger(revision) || revision < 1) {
      throw conflict('BINDING_DENIED', `operation pin for slot ${slot} has an invalid revision`);
    }
    structured[slot] = { connectorId: rendered.slice(0, at), revision };
  }
  return parseConnectorBindings(structured);
}

export function createGrantService(
  db: Db,
  registry: { getEnabledVersion(businessId: string, version: string): Promise<{ manifest: { actions: { name: string; connectorSlots: { name: string }[] }[] } }> },
  opts: { connectorId: string; connectorRevision: number; secret: Uint8Array }
): GrantService {
  function sign(claims: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const sig = createHmac('sha256', opts.secret)
      .update(`${header}.${payload}`)
      .digest('base64url');
    return `${header}.${payload}.${sig}`;
  }

  function buildClaims(
    taskId: string,
    t: { operation_id: string; tenant_id: string },
    invocationId: string,
    req: { stepKey: string; bindingSlot: string; inputHash: string },
    now: number,
    connectorId: string,
    connectorRevision: number
  ): Record<string, unknown> {
    return {
      audience: 'connector',
      tenantId: t.tenant_id,
      operationId: t.operation_id,
      taskId,
      stepKey: req.stepKey,
      invocationId,
      inputHash: req.inputHash,
      connectorId,
      connectorRevision,
      bindingSlot: req.bindingSlot,
      artifactIds: [] as string[],
      iat: now,
      exp: now + GRANT_TTL_SECONDS,
    };
  }

  return {
    connectorId: opts.connectorId,
    connectorRevision: opts.connectorRevision,
    async issue(taskId, leaseEpoch, body): Promise<InvocationGrant> {
      const parsed = InvocationGrantRequestSchema.safeParse(body);
      if (!parsed.success) throw unprocessable('INVALID_SCHEMA', 'invocation grant request failed', {
        errors: parsed.error.issues.slice(0, 20).map((i) => ({ pointer: '/' + i.path.join('/'), message: i.message })),
      });
      const req = parsed.data;

      // Resolve and fence inside a single transaction: only the current lease
      // holder of a RUNNING task may request a grant.
      return db.tx(async (client) => {
        const tRes = await client.query(
          `SELECT t.lease_epoch, t.lease_expires_at, t.state, t.operation_id, o.tenant_id, o.business_id, o.business_version, o.action,
                  o.connector_bindings
           FROM tasks t JOIN operations o ON o.id = t.operation_id WHERE t.id=$1 FOR UPDATE`,
          [taskId]
        );
        if (!tRes.rowCount) throw notFound(`task ${taskId} not found`);
        const t = tRes.rows[0] as {
          lease_epoch: number;
          lease_expires_at: string | null;
          state: string;
          operation_id: string;
          tenant_id: string;
          business_id: string;
          business_version: string;
          action: string;
          connector_bindings: unknown;
        };
        if (t.lease_epoch !== leaseEpoch) {
          throw conflict('LEASE_LOST', `stale leaseEpoch ${leaseEpoch}, current ${t.lease_epoch}`);
        }
        if (t.lease_expires_at && new Date(t.lease_expires_at).getTime() <= Date.now()) {
          throw conflict('LEASE_LOST', `lease for task ${taskId} expired at ${t.lease_expires_at}`);
        }
        if (t.state !== 'RUNNING') {
          throw conflict('STATE_CONFLICT', `task ${taskId} is ${t.state}, not RUNNING`);
        }

        // Pinned binding slot (P2-02/R08-02, W13-C): the requested slot must
        // be declared by the enabled manifest's action. An action declaring
        // NO slots grants none — fail closed. When the operation carries a
        // profile pin, the pin additionally confines the grant: the slot must
        // be pinned for this operation, and the grant is issued for the
        // PINNED connector identity/revision — never the deployment opts.
        const enabled = await registry.getEnabledVersion(t.business_id, t.business_version);
        const action = enabled.manifest.actions.find((a) => a.name === t.action);
        if (!action) throw unprocessable('INVALID_SCHEMA', `action ${t.action} not found in enabled manifest`);
        const declaredSlots = (action.connectorSlots ?? []).map((s) => s.name);
        if (!declaredSlots.includes(req.bindingSlot)) {
          throw conflict('BINDING_DENIED', `slot ${req.bindingSlot} not declared by action ${t.action}`);
        }
        const pin = t.connector_bindings == null ? null : parsePinnedBindings(t.connector_bindings);
        const pinSlot = pin?.[req.bindingSlot];
        if (pin && !pinSlot) {
          throw conflict('BINDING_DENIED', `slot ${req.bindingSlot} is not pinned for this operation`);
        }
        const connectorId = pinSlot?.connectorId ?? opts.connectorId;
        const connectorRevision = pinSlot?.revision ?? opts.connectorRevision;

        const invocationId = stableInvocationId(taskId, req.stepKey, req.bindingSlot);
        const now = Math.floor(Date.now() / 1000);
        const expiresAt = new Date((now + GRANT_TTL_SECONDS) * 1000).toISOString();

        // Stable identity: reuse the existing grant when the logical key
        // matches and it has not expired. A differing hash for the same
        // (task, step, slot) is a conflict — the worker must not blind-retry
        // as a fresh provider invocation.
        const existing = await client.query(
          `SELECT input_hash, expires_at FROM invocation_grants WHERE task_id=$1 AND step_key=$2 AND invocation_id=$3`,
          [taskId, req.stepKey, invocationId]
        );
        if (existing.rowCount) {
          const row = existing.rows[0] as { input_hash: string; expires_at: Date | string };
          if (row.input_hash !== req.inputHash) {
            throw conflict('INPUT_HASH_MISMATCH', `invocation ${invocationId} already issued for a different input`);
          }
          if (new Date(row.expires_at).getTime() > Date.now()) {
            // Unexpired: re-sign the same identity and refresh the row so a
            // transport retry reuses the stable invocationId end to end.
            const claims = buildClaims(taskId, t, invocationId, req, now, connectorId, connectorRevision);
            const grantToken = sign(claims);
            await client.query(
              'UPDATE invocation_grants SET grant_token=$1, expires_at=$2 WHERE task_id=$3 AND step_key=$4 AND invocation_id=$5',
              [grantToken, new Date((now + GRANT_TTL_SECONDS) * 1000), taskId, req.stepKey, invocationId]
            );
            return {
              grant: grantToken,
              invocationId,
              connectorId,
              connectorRevision,
              expiresAt,
              allowedOptions: {},
            };
          }
        }

        const claims = buildClaims(taskId, t, invocationId, req, now, connectorId, connectorRevision);
        const grantToken = sign(claims);

        await client.query(
          `INSERT INTO invocation_grants
             (task_id, step_key, operation_id, tenant_id, business_id, connector_id, connector_revision, binding_slot, invocation_id, input_hash, grant_token, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (task_id, step_key, invocation_id) DO UPDATE SET grant_token=$11, expires_at=$12`,
          [
            taskId,
            req.stepKey,
            t.operation_id,
            t.tenant_id,
            t.business_id,
            connectorId,
            connectorRevision,
            req.bindingSlot,
            invocationId,
            req.inputHash,
            grantToken,
            new Date((now + GRANT_TTL_SECONDS) * 1000),
          ]
        );

        return {
          grant: grantToken,
          invocationId,
          connectorId,
          connectorRevision,
          expiresAt,
          allowedOptions: {},
        };
      });
    },
  };
}

/** Constant-time grant string equality (for any future local verify). */
export function equalGrantTokens(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
