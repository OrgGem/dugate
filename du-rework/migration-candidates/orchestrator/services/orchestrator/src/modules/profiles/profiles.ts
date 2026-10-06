import { randomUUID } from 'node:crypto';
import { PoolClient, QueryResult, QueryResultRow } from 'pg';
import {
  FileUrlAuthConfigSchema,
  type ConnectionStep,
  type FileUrlAuthConfig,
  type ProfileJobPriority,
  type ProfileParameters,
} from '@du/contracts';
import { Db } from '../../db/db';
import { HttpError, forbidden, notFound } from '../../http/errors';
import {
  bullMqPriorityFor,
  coerceAllowedFileExtensions,
  coerceConnectionsOverride,
  coerceEnabled,
  coerceJobPriority,
  coerceRowParameters,
  mergeParameters,
  parseWriteParameters,
  parseRequestRedactionRules,
} from './policy';
import {
  createLegacyPlaintextWarner,
  decryptFileUrlAuthConfig,
  encryptFileUrlAuthConfig,
  type ProfileEnv,
} from './file-url-auth';
import { pinActiveRevision } from './publish';

/**
 * Profile-bound authorization (P2-02 / R08-02, W13-C) and the effective
 * profile resolution that T-PROF-05 folds into it.
 *
 * One immutable row per (profile_id, revision) in `profile_bindings` maps an
 * API key to (business, version, action), the slot → connector pin, and (since
 * migration 0026) the whole endpoint policy. A separate pointer table
 * `profile_active_revisions` (migration 0027) says WHICH revision is live.
 *
 * PRF-02: submission pins the resolution onto the operation; grants and claim
 * snapshots read the pin, never the live profile, so a mid-operation revision
 * change affects new submissions only.
 *
 * Interim policy (see Claude lane report): a key with NO binding rows stays on
 * the legacy path (manifest-declared slots + deployment connector opts). A key
 * with ≥1 row is confined to its bindings: no match → 403.
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

/** The policy half of a resolved profile, as it will be snapshotted. */
export interface EffectiveProfilePolicy {
  enabled: boolean;
  parameters: ProfileParameters;
  jobPriority: ProfileJobPriority;
  allowedFileExtensions: string;
  connectionsOverride: ConnectionStep[];
  fileUrlAuthConfig: FileUrlAuthConfig | null;
}

/**
 * PAR-XA-03: the ONE typed result every admission seam consumer sees.
 *
 * `legacy` means the key has no profile at all and runs on manifest defaults.
 * `pinned` means the key IS in profile mode and carries a full, decoded policy
 * — there is deliberately no "pinned but empty policy" state, because the
 * caller would then have to guess which defaults apply.
 */
export type EffectiveProfile =
  | { mode: 'legacy' }
  | {
      mode: 'pinned';
      profileId: string;
      revision: number;
      bindings: ConnectorPinMap;
      policy: EffectiveProfilePolicy;
      /** Client input merged over the stored defaults (locks already enforced). */
      effectiveParameters: Record<string, unknown>;
      /**
       * Client keys the profile does not manage (not declared, not stored).
       * They are returned untouched so the caller can put them back on the
       * input for AJV to judge — a stray key is the action schema's problem,
       * not a profile problem, and answering 400 here would contradict the
       * action's own contract.
       */
      passthrough: Record<string, unknown>;
      /** `effectiveParameters ∪ passthrough` — what the worker will run. */
      effectiveInput: Record<string, unknown>;
      /** BullMQ `priority`: lower runs first. HIGH=1, MEDIUM=10, LOW=20. */
      bullMqPriority: number;
    };

export interface CreateBindingInput {
  profileId?: string;
  apiKeyHash: string;
  businessId: string;
  businessVersion: string;
  action: string;
  connectorBindings: unknown;
  /**
   * T-PROF-02/04: the policy half of the revision. Absent fields carry
   * forward from the previous revision — the legacy admin route treated an
   * absent field as "leave unchanged", and a revision that silently reset a
   * field to its default would be a data-loss bug dressed as a save.
   */
  policy?: Record<string, unknown>;
}

interface PolicyRow {
  enabled: boolean | null;
  parameters: unknown;
  job_priority: string | null;
  allowed_file_extensions: string | null;
  connections_override: unknown;
  file_url_auth_cipher: string | null;
  request_redaction?: unknown;
}

function carryForwardPolicy(
  previous: PolicyRow | undefined,
  input: Record<string, unknown> | undefined,
  cryptoEnv: ProfileEnv,
  warnLegacy: () => void
): {
  enabled: boolean;
  parameters: unknown;
  jobPriority: string;
  allowedFileExtensions: string;
  connectionsOverride: unknown;
  cipher: string | null;
  requestRedaction: unknown;
} {
  // Absent field → previous value. No previous revision → legacy defaults.
  const policy = input ?? {};
  const has = (k: string) =>
    Object.prototype.hasOwnProperty.call(policy, k) && policy[k] !== undefined;

  const enabled = has('enabled') ? Boolean(policy.enabled) : (previous?.enabled ?? true);
  // MEDIUM-1 (A-lite): validate the CLIENT-SUPPLIED branch before it can
  // reach the column. `parameters: null` historically meant "clear" (the
  // INSERT coalesced it to `{}`), so that gesture keeps working instead of
  // 422-ing a legacy client. The carried-forward branch is deliberately left
  // unvalidated: it is already stored and `coerceRowParameters` reads it
  // tolerantly, so re-checking it would strand a live profile on a legacy row.
  const parameters =
    has('parameters') && policy.parameters !== null
      ? parseWriteParameters(policy.parameters)
      : (previous?.parameters ?? {});
  const jobPriority = has('jobPriority') ? String(policy.jobPriority) : (previous?.job_priority ?? 'MEDIUM');
  const allowedFileExtensions = has('allowedFileExtensions')
    ? String(policy.allowedFileExtensions)
    : (previous?.allowed_file_extensions ?? '');
  const connectionsOverride = has('connectionsOverride')
    ? policy.connectionsOverride
    : (previous?.connections_override ?? []);

  let cipher: string | null;
  if (policy.fileUrlAuthConfig === null) {
    // Explicit null clears the stored secret.
    cipher = null;
  } else if (has('fileUrlAuthConfig')) {
    const parsed = FileUrlAuthConfigSchema.safeParse(policy.fileUrlAuthConfig);
    if (!parsed.success) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'fileUrlAuthConfig failed validation', {
        errors: parsed.error.issues.slice(0, 50).map((i) => ({
          pointer: '/fileUrlAuthConfig/' + i.path.join('/'),
          message: i.message,
        })),
      });
    }
    cipher = encryptFileUrlAuthConfig(parsed.data, cryptoEnv);
  } else {
    // Absent key: carry the previous revision's cipher forward, so a save that
    // does not touch the secret cannot silently drop it.
    cipher = previous?.file_url_auth_cipher ?? null;
  }

  return {
    enabled,
    parameters,
    jobPriority,
    allowedFileExtensions,
    connectionsOverride,
    cipher,
    requestRedaction: parseRequestRedactionRules(
      has('requestRedaction') ? policy.requestRedaction : (previous?.request_redaction ?? [])
    ),
  };
}

export interface CreateProfileServiceOptions {
  /**
   * Env used to derive the profile-cipher key (T-PROF-04). Defaults to
   * `process.env`, which is what every non-test deployment wants.
   */
  cryptoEnv?: ProfileEnv;
}

export function createProfileService(db: Db, options: CreateProfileServiceOptions = {}) {
  const cryptoEnv = options.cryptoEnv ?? process.env;
  const warnLegacyPlaintext = createLegacyPlaintextWarner((message) => {
    // eslint-disable-next-line no-console
    console.warn(`[profiles] ${message}`);
  });

  const decodePolicy = (
    row: {
      enabled: boolean | null;
      parameters: unknown;
      job_priority: string | null;
      allowed_file_extensions: string | null;
      connections_override: unknown;
      file_url_auth_cipher: string | null;
    }
  ): EffectiveProfilePolicy => {
    const decrypted = decryptFileUrlAuthConfig(row.file_url_auth_cipher, cryptoEnv, warnLegacyPlaintext);
    return {
      enabled: coerceEnabled(row.enabled),
      parameters: coerceRowParameters(row.parameters),
      jobPriority: coerceJobPriority(row.job_priority),
      allowedFileExtensions: coerceAllowedFileExtensions(row.allowed_file_extensions),
      connectionsOverride: coerceConnectionsOverride(row.connections_override),
      fileUrlAuthConfig: decrypted?.config ?? null,
    };
  };

  /**
   * The slice of `Db`/`PoolClient` the pointer read needs. Declared locally
   * because `Pick<Db | PoolClient, 'query'>` is a union of two incompatible
   * call signatures and is therefore not callable.
   */
  interface Queryable {
    query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      params?: unknown[]
    ): Promise<QueryResult<T>>;
  }

  /**
   * Pointer-driven read: exactly one active revision for this
   * (key, business, version, action).
   *
   * `null` means "the bindings exist but no pointer row does" — migration 0027
   * invariant #3 says the two must go together, so this is a fail-closed
   * inconsistency, NOT a cue to fall back to MAX(revision).
   */
  const selectActiveRow = async (
    c: Queryable,
    apiKeyId: string,
    businessId: string,
    businessVersion: string,
    action: string
  ) => {
    const hit = await c.query<
      PolicyRow & {
        profile_id: string;
        revision: number;
        connector_bindings: ConnectorPinMap;
        moved_at: Date;
      }
    >(
      `SELECT p.profile_id, p.revision, p.connector_bindings,
              p.enabled, p.parameters, p.job_priority, p.allowed_file_extensions,
              p.connections_override, p.file_url_auth_cipher, a.moved_at
         FROM profile_active_revisions a
         JOIN profile_bindings p
           ON p.profile_id = a.profile_id AND p.revision = a.revision
        WHERE p.api_key_id=$1 AND p.business_id=$2 AND p.business_version=$3 AND p.action=$4
        ORDER BY a.moved_at DESC, p.profile_id
        LIMIT 1`,
      [apiKeyId, businessId, businessVersion, action]
    );
    if (hit.rowCount) return hit.rows[0]!;

    // No pointer row for this action. Distinguish "profile has no rows at
    // all" (→ legacy) from "rows exist but the pointer is gone" (→ 404).
    const orphan = await c.query(
      `SELECT 1 FROM profile_bindings
        WHERE api_key_id=$1 AND business_id=$2 AND business_version=$3 AND action=$4 LIMIT 1`,
      [apiKeyId, businessId, businessVersion, action]
    );
    if (orphan.rowCount) return 'pointer-missing' as const;

    const anyRes = await c.query(
      'SELECT 1 FROM profile_bindings WHERE api_key_id=$1 LIMIT 1',
      [apiKeyId]
    );
    if (anyRes.rowCount) return 'not-authorized' as const;
    return 'legacy' as const;
  };

  return {
    /** Admin: append the next immutable revision for a profile (creates the profile when omitted).
     *  W48-C1: also returns the bound key's tenant/app identity so the admin
     *  audit ledger can attribute the grant (tenant-scoped read predicate).
     *  Additive — existing callers destructuring { profileId, revision } are unaffected.
     *
     *  T-DB-02 invariant #1: the pointer row is (re)pinned in the SAME
     *  transaction as the insert. Without this a brand-new profile has no
     *  pointer at all and every read of it fails closed. */
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

        const prevRes = await c.query<PolicyRow>(
          `SELECT enabled, parameters, job_priority, allowed_file_extensions,
                  connections_override, file_url_auth_cipher, request_redaction
             FROM profile_bindings WHERE profile_id=$1 AND revision=$2`,
          [profileId, revision - 1]
        );
        const policy = carryForwardPolicy(
          prevRes.rows[0],
          input.policy,
          cryptoEnv,
          warnLegacyPlaintext
        );

        await c.query(
          `INSERT INTO profile_bindings
             (profile_id, revision, tenant_id, api_key_id, business_id, business_version, action,
              connector_bindings, enabled, parameters, job_priority, allowed_file_extensions,
              file_url_auth_cipher, connections_override, request_redaction)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            profileId,
            revision,
            key.tenant_id,
            key.id,
            input.businessId,
            input.businessVersion,
            input.action,
            JSON.stringify(bindings),
            policy.enabled,
            JSON.stringify(policy.parameters ?? {}),
            policy.jobPriority,
            policy.allowedFileExtensions,
            policy.cipher,
            JSON.stringify(policy.connectionsOverride ?? []),
            JSON.stringify(policy.requestRedaction),
          ]
        );

        // T-DB-02 invariant #1 — SAME transaction, not "sometime after".
        await pinActiveRevision(c, profileId, revision);

        return { profileId, revision, tenantId: key.tenant_id, apiKeyId: key.id };
      };
      return activeClient ? run(activeClient) : db.tx(run);
    },

    /** Submission-time: resolve the key's active binding for (business, version, action).
     *  Kept for callers that only want the pin; submission uses
     *  `resolveEffectiveProfile` so it gets the policy in the same read. */
    async resolveBinding(
      apiKeyId: string,
      businessId: string,
      businessVersion: string,
      action: string
    ): Promise<BindingResolution> {
      const row = await selectActiveRow(db, apiKeyId, businessId, businessVersion, action);
      if (row === 'legacy') return { mode: 'legacy' };
      if (row === 'pointer-missing') {
        // Invariant #3: never fall back to MAX(revision).
        throw notFound(
          'profile has revisions but no active revision pointer (profile_active_revisions); ' +
            'refusing to guess rather than returning a stale revision'
        );
      }
      if (row === 'not-authorized') {
        throw forbidden(`api key is not authorized for action ${action} on ${businessId}@${businessVersion}`);
      }
      return {
        mode: 'pinned',
        profileId: row.profile_id,
        revision: row.revision,
        bindings: parseConnectorBindings(row.connector_bindings),
      };
    },

    /**
     * T-PROF-05 / T-SUB-01 — the single admission seam's resolution.
     *
     * Folded together: the enabled-check (disabled → 403, unknown profile →
     * 404, both fail-closed), the parameter merge with lock enforcement, the
     * BullMQ priority, the extension CSV and the connections override.
     *
     * Throws BEFORE any row is written (submission.ts:214, before the
     * operation/task/outbox/submission_key inserts at :314+), so a denied
     * profile leaves zero rows behind.
     */
    async resolveEffectiveProfile(
      apiKeyId: string,
      businessId: string,
      businessVersion: string,
      action: string,
      clientInput: Record<string, unknown> = {},
      declaredKeys?: readonly string[]
    ): Promise<EffectiveProfile> {
      const row = await selectActiveRow(db, apiKeyId, businessId, businessVersion, action);
      if (row === 'legacy') return { mode: 'legacy' };
      if (row === 'pointer-missing') {
        throw notFound(
          'profile has revisions but no active revision pointer (profile_active_revisions); ' +
            'refusing to guess rather than returning a stale revision'
        );
      }
      if (row === 'not-authorized') {
        throw forbidden(`api key is not authorized for action ${action} on ${businessId}@${businessVersion}`);
      }

      const policy = decodePolicy(row);
      if (!policy.enabled) {
        // Fail closed: a disabled profile admits nothing, not even a zero-row
        // operation, so an operator's "turn this off" is immediate.
        throw forbidden(`profile is disabled for action ${action} on ${businessId}@${businessVersion}`);
      }

      const managed = new Set<string>([
        ...(declaredKeys ?? []),
        ...Object.keys(policy.parameters),
      ]);
      const clientManaged: Record<string, unknown> = {};
      const passthrough: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(clientInput)) {
        (managed.has(key) ? clientManaged : passthrough)[key] = value;
      }

      const effectiveParameters = mergeParameters(policy.parameters, clientManaged, declaredKeys);
      const bullMqPriority = bullMqPriorityFor(policy.jobPriority);

      return {
        mode: 'pinned',
        profileId: row.profile_id,
        revision: row.revision,
        bindings: parseConnectorBindings(row.connector_bindings),
        policy,
        effectiveParameters,
        passthrough,
        effectiveInput: { ...effectiveParameters, ...passthrough },
        bullMqPriority,
      };
    },

    /** T-PROF-03 accessor: the active revision, never MAX(revision). */
    async getEffectiveRevision(profileId: string): Promise<number | null> {
      const res = await db.query<{ revision: number }>(
        'SELECT revision FROM profile_active_revisions WHERE profile_id=$1',
        [profileId]
      );
      return res.rowCount ? res.rows[0]!.revision : null;
    },
  };
}

export type ProfileService = ReturnType<typeof createProfileService>;
