import { CORE_ENDPOINTS } from '../settings/endpoints';
import { randomUUID } from 'node:crypto';
import { PoolClient, QueryResult, QueryResultRow } from 'pg';
import {
  CredentialAllowedOriginsSchema,
  FileUrlAuthConfigSchema,
  ProfileCallbackPolicySchema,
  type ConnectionStep,
  type FileUrlAuthConfig,
  type ProfileCallbackPolicy,
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
  allowedOrigins?: string[];
  /** CB-02: stored callback policy, or null when none is configured. */
  callbackPolicy: ProfileCallbackPolicy | null;
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
      /** CB-02: name from the `profile_names` registry, when present. */
      profileName: string | null;
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
  endpointSlug?: string;
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
  callback_policy?: unknown;
  allowed_origins?: unknown;
  profile_name?: string | null;
}

/**
 * CB-02: tolerant read of a stored callback policy. Absent/null → null;
 * a malformed stored value fails the admission closed (never treated as
 * "no auth"), matching the dispatcher's invalid-pin behavior.
 */
function parseStoredCallbackPolicy(raw: unknown): ProfileCallbackPolicy | null {
  if (raw === null || raw === undefined) return null;
  const parsed = ProfileCallbackPolicySchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(500, 'INVALID_SCHEMA', 'stored profile callback policy does not satisfy its contract');
  }
  return parsed.data;
}

/** CB-02: validate the CLIENT-SUPPLIED callback policy (write boundary). */
function parseWriteCallbackPolicy(raw: unknown): ProfileCallbackPolicy | null {
  if (raw === null) return null;
  const parsed = ProfileCallbackPolicySchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'callbackPolicy failed validation', {
      errors: parsed.error.issues.slice(0, 50).map((i) => ({
        pointer: '/callbackPolicy/' + i.path.join('/'),
        message: i.message,
      })),
    });
  }
  return parsed.data;
}

function parseWriteCredentialAllowedOrigins(raw: unknown): string[] {
  const parsed = CredentialAllowedOriginsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'allowedOrigins failed validation', {
      errors: parsed.error.issues.slice(0, 50).map((issue) => ({
        pointer: '/allowedOrigins/' + issue.path.join('/'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

function parseStoredCredentialAllowedOrigins(raw: unknown): string[] {
  let value = raw;
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new HttpError(500, 'INVALID_SCHEMA', 'stored profile allowed origins are invalid');
    }
  }
  const parsed = CredentialAllowedOriginsSchema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(500, 'INVALID_SCHEMA', 'stored profile allowed origins do not satisfy their contract');
  }
  return parsed.data;
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
  callbackPolicy: ProfileCallbackPolicy | null;
  allowedOrigins: string[];
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
    // CB-02: explicit null clears; absent carries the previous revision
    // forward; a client value is validated here (write boundary).
    callbackPolicy:
      policy.callbackPolicy === null
        ? null
        : has('callbackPolicy')
          ? parseWriteCallbackPolicy(policy.callbackPolicy)
          : parseStoredCallbackPolicy(previous?.callback_policy),
    // Absent carries the previous immutable binding forward; [] explicitly
    // clears the policy. Canonicalization happens at this write boundary.
    allowedOrigins: has('allowedOrigins')
      ? parseWriteCredentialAllowedOrigins(policy.allowedOrigins)
      : parseStoredCredentialAllowedOrigins(previous?.allowed_origins),
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
      callback_policy?: unknown;
      allowed_origins?: unknown;
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
      allowedOrigins: parseStoredCredentialAllowedOrigins(row.allowed_origins),
      callbackPolicy: parseStoredCallbackPolicy(row.callback_policy),
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
   *
   * Membership (0039) answers WHICH key may resolve WHICH profile; the
   * revision rows answer WHAT that profile is. Since the backfill seeded
   * membership from every key that ever authored a revision, every key that
   * resolved before still resolves — plus the other keys of the same profile,
   * which is the whole point of the change.
   */
  const selectActiveRow = async (
    c: Queryable,
    apiKeyId: string,
    businessId: string,
    businessVersion: string,
    action: string,
    endpointSlug?: string
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
              p.connections_override, p.file_url_auth_cipher, p.request_redaction, p.callback_policy, p.allowed_origins,
              (SELECT n.profile_name FROM profile_names n WHERE n.profile_id = p.profile_id LIMIT 1) AS profile_name,
              a.moved_at
         FROM profile_active_revisions a
         JOIN profile_bindings p
           ON p.profile_id = a.profile_id AND p.revision = a.revision
         -- 0039: membership is a SET, not the revision's author. A key that maps
         -- to this profile resolves the profile's active revision; a key that
         -- does not map resolves nothing (the probes below decide which refusal).
         JOIN profile_api_keys m
           ON m.profile_id = p.profile_id AND m.api_key_id=$1
          AND m.state='ACTIVE' AND m.tenant_id = p.tenant_id
        WHERE p.business_id=$2 AND p.business_version=$3 AND p.action=$4
          AND (p.endpoint_slug IS NULL OR p.endpoint_slug=$5)
        ORDER BY (p.endpoint_slug IS NOT NULL) DESC, a.moved_at DESC, p.profile_id
        LIMIT 1`,
      [apiKeyId, businessId, businessVersion, action, endpointSlug ?? null]
    );
    if (hit.rowCount) return hit.rows[0]!;

    // No pointer row for this action. Distinguish "profile has no rows at
    // all" (→ legacy) from "rows exist but the pointer is gone" (→ 404).
    const orphan = await c.query(
      `SELECT 1 FROM profile_api_keys m
         JOIN profile_bindings p ON p.profile_id = m.profile_id
        WHERE m.api_key_id=$1 AND m.state='ACTIVE'
          AND p.business_id=$2 AND p.business_version=$3 AND p.action=$4
          AND (p.endpoint_slug IS NULL OR p.endpoint_slug=$5) LIMIT 1`,
      [apiKeyId, businessId, businessVersion, action, endpointSlug ?? null]
    );
    if (orphan.rowCount) return 'pointer-missing' as const;

    const anyRes = await c.query(
      "SELECT 1 FROM profile_api_keys WHERE api_key_id=$1 AND state='ACTIVE' LIMIT 1",
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

        const prevRes = await c.query<PolicyRow & { endpoint_slug: string | null }>(
          `SELECT enabled, parameters, job_priority, allowed_file_extensions,
                  connections_override, file_url_auth_cipher, request_redaction, callback_policy,
                  allowed_origins, endpoint_slug
             FROM profile_bindings WHERE profile_id=$1 AND revision=$2`,
          [profileId, revision - 1]
        );
        if(input.endpointSlug !== undefined && (input.businessId !== 'document-core' || !CORE_ENDPOINTS.has(input.endpointSlug) || input.endpointSlug.split(':')[0] !== input.action)) throw new HttpError(422,'INVALID_SCHEMA','endpointSlug must be a supported core endpoint matching action');
        if(prevRes.rows[0] && input.endpointSlug !== undefined && input.endpointSlug !== prevRes.rows[0].endpoint_slug) throw new HttpError(409,'STATE_CONFLICT','existing profile endpoint selector cannot be changed; create a dedicated profile');
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
              file_url_auth_cipher, connections_override, request_redaction, callback_policy,
              allowed_origins, endpoint_slug)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
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
            policy.callbackPolicy === null ? null : JSON.stringify(policy.callbackPolicy),
            JSON.stringify(policy.allowedOrigins),
            input.endpointSlug ?? prevRes.rows[0]?.endpoint_slug ?? null,
          ]
        );

        // T-DB-02 invariant #1 — SAME transaction, not "sometime after".
        await pinActiveRevision(c, profileId, revision);
        // A binding created through the admin API must be resolvable immediately.
        // Existing explicit revocations stay revoked; membership restore is a separate action.
        await c.query(
          `INSERT INTO profile_api_keys (profile_id, api_key_id, tenant_id, state)
           VALUES ($1,$2,$3,'ACTIVE') ON CONFLICT (profile_id, api_key_id) DO NOTHING`,
          [profileId, key.id, key.tenant_id],
        );

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
      action: string,
      endpointSlug?: string
    ): Promise<BindingResolution> {
      const row = await selectActiveRow(db, apiKeyId, businessId, businessVersion, action, endpointSlug);
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
      declaredKeys?: readonly string[],
      endpointSlug?: string
    ): Promise<EffectiveProfile> {
      const row = await selectActiveRow(db, apiKeyId, businessId, businessVersion, action, endpointSlug);
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
      if (endpointSlug !== undefined) {
        const aliases = Object.entries(policy.parameters).map(([key, value]) => [
          key === 'action' && action === 'transform' ? 'variant' : key.replace(/_+([a-zA-Z0-9])/g, (_match, letter: string) => letter.toUpperCase()), value,
        ] as const);
        if (new Set(aliases.map(([key]) => key)).size !== aliases.length) throw new HttpError(422, 'INVALID_SCHEMA', 'Legacy profile has conflicting parameter aliases');
        policy.parameters = Object.fromEntries(aliases);
      }
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
        profileName: typeof row.profile_name === 'string' && row.profile_name.length > 0
          ? row.profile_name
          : null,
        policy,
        effectiveParameters,
        passthrough,
        effectiveInput: { ...effectiveParameters, ...passthrough },
        bullMqPriority,
      };
    },

    /**
     * 0039 membership write: make `apiKeyId` an ACTIVE member of `profileId`.
     *
     * One statement, so two concurrent attaches cannot both decide they
     * created the row. `xmax = 0` is the standard Postgres discriminator for
     * "this row was INSERTed" (an UPDATE leaves an xmax behind); with the
     * `WHERE` on DO UPDATE, an already-ACTIVE membership returns NO row and
     * reports created=false without touching the row.
     */
    async addMembership(
      input: { profileId: string; apiKeyId: string; tenantId: string },
      client: PoolClient
    ): Promise<{ created: boolean }> {
      const res = await client.query<{ created: boolean }>(
        `INSERT INTO profile_api_keys (profile_id, api_key_id, tenant_id, state)
         VALUES ($1, $2, $3, 'ACTIVE')
         ON CONFLICT (profile_id, api_key_id)
         DO UPDATE SET state='ACTIVE', revoked_at=NULL
           WHERE profile_api_keys.state <> 'ACTIVE'
         RETURNING (xmax = 0) AS created`,
        [input.profileId, input.apiKeyId, input.tenantId]
      );
      return { created: res.rowCount ? res.rows[0]!.created === true : false };
    },

    /** 0039: the ACTIVE profile set a rotation has to inherit (never a subset). */
    async listActiveMemberships(
      apiKeyId: string,
      client: PoolClient
    ): Promise<Array<{ profileId: string; tenantId: string }>> {
      const res = await client.query<{ profile_id: string; tenant_id: string }>(
        `SELECT profile_id, tenant_id FROM profile_api_keys
          WHERE api_key_id=$1 AND state='ACTIVE' ORDER BY profile_id`,
        [apiKeyId]
      );
      return res.rows.map((r) => ({ profileId: r.profile_id, tenantId: r.tenant_id }));
    },

    /** 0039: end every ACTIVE membership of a key in one statement. */
    async revokeMemberships(apiKeyId: string, client: PoolClient): Promise<number> {
      const res = await client.query(
        `UPDATE profile_api_keys SET state='REVOKED', revoked_at=now()
          WHERE api_key_id=$1 AND state='ACTIVE'`,
        [apiKeyId]
      );
      return res.rowCount ?? 0;
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
