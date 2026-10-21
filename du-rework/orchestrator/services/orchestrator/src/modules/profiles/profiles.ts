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
import { isActiveConnectorPin } from './connector-pin-validation';
import type { ConnectorManagementStore } from '../connectors/connector-management-store';

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

/**
 * PC-03: the Admin actor that authors a revision without an API key.
 *
 * Stored as `created_by` (+ issuer/sub) on `profile_bindings` and
 * `profile_group_revisions`, mirroring the actor shape 0060 uses for
 * `connector_secret_imports`. It is never a credential and never a raw key.
 * Declared here (the lower-level module) so `profile-groups.ts` can re-export
 * it as `ProfileGroupActor` without a circular import.
 */
export interface ProfileRevisionActor {
  actor: string;
  role: string;
  issuer?: string;
  sub?: string;
}

export interface CreateBindingInput {
  profileId?: string;
  /**
   * Standalone authoring only. Group-owned appends carry `actor` instead and
   * are rejected when both are supplied (PC-03).
   */
  apiKeyHash?: string;
  /** Group-owned append: the Admin actor recorded as the revision author. */
  actor?: ProfileRevisionActor;
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
  /**
   * PC-03 / plan item 4: per-field request defaults, immutable with the
   * revision. Absent carries the previous revision forward, matching
   * `policy`; a profile with no previous revision stores `{}`.
   */
  requestDefaults?: unknown;
}

export interface ProfileSelectorLock {
  businessId: string;
  businessVersion: string;
  action: string;
  endpointSlug?: string | null;
}

export interface ProfileActiveSelector extends ProfileSelectorLock {
  endpointSlug: string | null;
}

export interface LockedApiKeyRow {
  id: string;
  tenant_id: string;
  hash: string;
  prefix: string;
  status: string;
}

export interface ActiveProfileMembership {
  apiKeyId: string;
  tenantId: string;
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
  /** PC-03: per-field request defaults, immutable with the revision. */
  request_defaults?: unknown;
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
  requestDefaults: Record<string, { value: unknown; isLocked?: boolean }>;
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
    // PC-03: `requestDefaults` is deliberately NOT part of `policy`. It is a
    // distinct source (manifest `parameterResolution.fields`), never request
    // input, and never injected into `parameters`. Absent carries the previous
    // revision; a first revision stores `{}`.
    requestDefaults: has('requestDefaults')
      ? (parseWriteParameters(policy.requestDefaults) as Record<string, { value: unknown; isLocked?: boolean }>)
      : normalizeStoredRequestDefaults(previous?.request_defaults),
  };
}

/**
 * PC-03: read-side coercion of a stored `profile_bindings.request_defaults`.
 *
 * A v1 row (or the migration default) reads as `{}` — a real "no defaults
 * declared" value, never NULL — so adding the column changed no resolution.
 * A malformed stored value is dropped to `{}` rather than failing a read the
 * writer already accepted, matching `coerceRowParameters`' tolerance.
 */
export function normalizeStoredRequestDefaults(
  raw: unknown
): Record<string, { value: unknown; isLocked?: boolean }> {
  if (raw === null || raw === undefined) return {};
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return {};
    }
  }
  // `coerceRowParameters` drops entries without a defined `value`, which is the
  // same tolerance the read path applies to `parameters`.
  return coerceRowParameters(value) as Record<string, { value: unknown; isLocked?: boolean }>;
}

export interface CreateProfileServiceOptions {
  /**
   * Env used to derive the profile-cipher key (T-PROF-04). Defaults to
   * `process.env`, which is what every non-test deployment wants.
   */
  cryptoEnv?: ProfileEnv;
  /** Connector source of truth used to validate every explicit profile pin. */
  connectorManagement?: Pick<ConnectorManagementStore, 'getRecipeRevision' | 'hasRecipeChain' | 'getRevision'>;
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
    // PC-R01: the key's EXPLICIT `key_mode` decides, BEFORE any membership is
    // consulted. `profile_api_keys` is evidence, not authority.
    //
    // Before this check the fallback was a heuristic on membership rows, so a
    // `LEGACY_STANDALONE` key with no rows at all (issued with `profileIds: []`,
    // or rotated from a key whose memberships were all tombstoned) resolved as
    // `'legacy'` and authorized every action with unmanaged behaviour. It also
    // let a `GROUP_MANAGED` key with stale child memberships resolve through the
    // child projection instead of its root grant.
    const keyModeRes = await c.query<{ key_mode: string | null }>(
      'SELECT key_mode FROM api_keys WHERE id=$1',
      [apiKeyId]
    );
    const keyModeRow = keyModeRes.rows[0];
    // Unknown key: nothing may resolve for it.
    if (!keyModeRow) return 'not-authorized' as const;

    if (keyModeRow.key_mode === 'UNMANAGED_LEGACY') {
      // The ONE path to unmanaged behaviour, and only while the key holds no
      // membership row at all. A key that claims to be unmanaged while
      // memberships exist is a contradictory row, not an entitlement.
      const anyMembership = await c.query(
        'SELECT 1 FROM profile_api_keys WHERE api_key_id=$1 LIMIT 1',
        [apiKeyId]
      );
      return anyMembership.rowCount ? ('not-authorized' as const) : ('legacy' as const);
    }

    // GROUP_MANAGED is authorized by its root grant (PC-05's resolver), never
    // by child membership. NULL/unknown mode fails closed — plan §2: after
    // migration a missing mode is an authorization error, not a default.
    if (keyModeRow.key_mode !== 'LEGACY_STANDALONE') return 'not-authorized' as const;

    // LEGACY_STANDALONE: membership-driven, exactly as before. "No eligible
    // membership" is a denial; it can never become an unmanaged fallback.
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

    // PC-R01: a `LEGACY_STANDALONE` key with no eligible membership is denied.
    // The mode check above already guarantees the key is explicit and
    // standalone, so there is no heuristics left to consult here.
    return 'not-authorized' as const;
  };

  const selectorLockKey = (selector: ProfileSelectorLock): string =>
    // endpointSlug is intentionally omitted: generic selectors overlap every
    // endpoint-specific selector, so both must serialize on the same lock.
    // apiKeyId is also omitted to make membership writers and rotations lock
    // the same selector before discovering/locking their key rows.
    `profile-selector:${JSON.stringify([selector.businessId, selector.businessVersion, selector.action])}`;

  const lockSelectorsOn = async (client: PoolClient, selectors: readonly ProfileSelectorLock[]): Promise<void> => {
    const keys = [...new Set(selectors.map(selectorLockKey))].sort();
    for (const key of keys) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
    }
  };

  const lockApiKeyRowOn = async (
    client: PoolClient,
    apiKeyId: string,
    mode: 'share' | 'update',
  ): Promise<LockedApiKeyRow | null> => {
    const lockClause = mode === 'update' ? 'FOR UPDATE' : 'FOR SHARE';
    const result = await client.query<LockedApiKeyRow>(
      `SELECT id, tenant_id, hash, prefix, status FROM api_keys WHERE id=$1 ${lockClause}`,
      [apiKeyId],
    );
    return result.rows[0] ?? null;
  };

  const activeSelectorOn = async (client: PoolClient, profileId: string): Promise<ProfileActiveSelector | null> => {
    const result = await client.query<{
      business_id: string;
      business_version: string;
      action: string;
      endpoint_slug: string | null;
    }>(
      `SELECT b.business_id, b.business_version, b.action, b.endpoint_slug
         FROM profile_active_revisions a
         JOIN profile_bindings b ON b.profile_id=a.profile_id AND b.revision=a.revision
        WHERE a.profile_id=$1`,
      [profileId],
    );
    const row = result.rows[0];
    return row ? {
      businessId: row.business_id,
      businessVersion: row.business_version,
      action: row.action,
      endpointSlug: row.endpoint_slug,
    } : null;
  };

  const revisionSelectorOn = async (
    client: PoolClient,
    profileId: string,
    revision: number,
  ): Promise<ProfileActiveSelector | null> => {
    const result = await client.query<{
      business_id: string;
      business_version: string;
      action: string;
      endpoint_slug: string | null;
    }>(
      `SELECT business_id, business_version, action, endpoint_slug
         FROM profile_bindings WHERE profile_id=$1 AND revision=$2`,
      [profileId, revision],
    );
    const row = result.rows[0];
    return row ? {
      businessId: row.business_id,
      businessVersion: row.business_version,
      action: row.action,
      endpointSlug: row.endpoint_slug,
    } : null;
  };

  const latestRevisionSelectorOn = async (
    client: PoolClient,
    profileId: string,
  ): Promise<{ revision: number; selector: ProfileActiveSelector } | null> => {
    const result = await client.query<{
      revision: number;
      business_id: string;
      business_version: string;
      action: string;
      endpoint_slug: string | null;
    }>(
      `SELECT revision, business_id, business_version, action, endpoint_slug
         FROM profile_bindings WHERE profile_id=$1 ORDER BY revision DESC LIMIT 1`,
      [profileId],
    );
    const row = result.rows[0];
    return row ? {
      revision: row.revision,
      selector: {
        businessId: row.business_id,
        businessVersion: row.business_version,
        action: row.action,
        endpointSlug: row.endpoint_slug,
      },
    } : null;
  };

  const activeProfileMembershipsOn = async (
    client: PoolClient,
    profileId: string,
  ): Promise<ActiveProfileMembership[]> => {
    const result = await client.query<{ api_key_id: string; tenant_id: string }>(
      `SELECT api_key_id, tenant_id FROM profile_api_keys
        WHERE profile_id=$1 AND state='ACTIVE' ORDER BY api_key_id`,
      [profileId],
    );
    return result.rows.map((row) => ({ apiKeyId: row.api_key_id, tenantId: row.tenant_id }));
  };

  const sameSelector = (left: ProfileActiveSelector | null, right: ProfileActiveSelector | null): boolean =>
    left === null || right === null
      ? left === right
      : left.businessId === right.businessId
        && left.businessVersion === right.businessVersion
        && left.action === right.action
        && left.endpointSlug === right.endpointSlug;

  const sameMemberships = (
    left: readonly ActiveProfileMembership[],
    right: readonly ActiveProfileMembership[],
  ): boolean => left.length === right.length && left.every((membership, index) =>
    membership.apiKeyId === right[index]?.apiKeyId && membership.tenantId === right[index]?.tenantId);

  const lockProfileMutationOn = async (
    client: PoolClient,
    profileId: string | null,
    targetSelectors: readonly ProfileSelectorLock[],
    additionalApiKeyIds: readonly string[],
    lockMembershipKeyRows = true,
  ): Promise<{
    activeSelector: ProfileActiveSelector | null;
    memberships: ActiveProfileMembership[];
    keys: Map<string, LockedApiKeyRow>;
  }> => {
    const selectorBeforeLock = profileId ? await activeSelectorOn(client, profileId) : null;
    const membershipsBeforeLock = profileId ? await activeProfileMembershipsOn(client, profileId) : [];
    await lockSelectorsOn(client, [
      ...targetSelectors,
      ...(selectorBeforeLock ? [selectorBeforeLock] : []),
    ]);

    const selectorAfterSelectorLocks = profileId ? await activeSelectorOn(client, profileId) : null;
    const membershipsAfterSelectorLocks = profileId ? await activeProfileMembershipsOn(client, profileId) : [];
    if (!sameSelector(selectorBeforeLock, selectorAfterSelectorLocks)
      || !sameMemberships(membershipsBeforeLock, membershipsAfterSelectorLocks)) {
      throw new HttpError(409, 'STATE_CONFLICT', 'profile selector or active API-key memberships changed while the revision was being prepared; retry');
    }

    const apiKeyIds = [...new Set([
      ...(lockMembershipKeyRows ? membershipsAfterSelectorLocks.map((membership) => membership.apiKeyId) : []),
      ...additionalApiKeyIds,
    ])].sort();
    const keys = new Map<string, LockedApiKeyRow>();
    for (const apiKeyId of apiKeyIds) {
      const key = await lockApiKeyRowOn(client, apiKeyId, 'share');
      if (key) keys.set(apiKeyId, key);
    }

    const selectorAfterKeyLocks = profileId ? await activeSelectorOn(client, profileId) : null;
    const membershipsAfterKeyLocks = profileId ? await activeProfileMembershipsOn(client, profileId) : [];
    if (!sameSelector(selectorAfterSelectorLocks, selectorAfterKeyLocks)
      || !sameMemberships(membershipsAfterSelectorLocks, membershipsAfterKeyLocks)) {
      throw new HttpError(409, 'STATE_CONFLICT', 'profile selector or active API-key memberships changed while key rows were being locked; retry');
    }
    for (const membership of membershipsAfterKeyLocks) {
      if (!lockMembershipKeyRows && !additionalApiKeyIds.includes(membership.apiKeyId)) continue;
      const key = keys.get(membership.apiKeyId);
      if (!key || key.tenant_id !== membership.tenantId) {
        throw new HttpError(409, 'STATE_CONFLICT', `active profile membership '${membership.apiKeyId}' no longer matches its API key tenant`);
      }
    }
    return { activeSelector: selectorAfterKeyLocks, memberships: membershipsAfterKeyLocks, keys };
  };

  const assertSelectorAvailable = async (
    client: PoolClient,
    input: {
      apiKeyId: string;
      businessId: string;
      businessVersion: string;
      action: string;
      endpointSlug: string | null;
      profileId: string;
      groupId?: string;
    },
  ): Promise<void> => {
    const overlap = await client.query<{ profile_id: string }>(
      `SELECT b.profile_id
         FROM profile_active_revisions a
         JOIN profile_bindings b ON b.profile_id=a.profile_id AND b.revision=a.revision
         JOIN profile_api_keys m ON m.profile_id=b.profile_id AND m.api_key_id=$1
          AND m.state='ACTIVE' AND m.tenant_id=b.tenant_id
         LEFT JOIN profile_names n ON n.profile_id=b.profile_id
        WHERE b.business_id=$2 AND b.business_version=$3 AND b.action=$4
          AND (b.endpoint_slug IS NULL OR $5::text IS NULL OR b.endpoint_slug=$5)
          AND b.profile_id<>$6
          AND ($7::uuid IS NULL OR n.group_id IS DISTINCT FROM $7)
        LIMIT 1`,
      [input.apiKeyId, input.businessId, input.businessVersion, input.action, input.endpointSlug,
        input.profileId, input.groupId ?? null],
    );
    if (overlap.rowCount) {
      throw new HttpError(409, 'STATE_CONFLICT', 'another active profile already binds this API key and function');
    }
  };

  const assertSelectorAvailableForMembershipsOn = async (
    client: PoolClient,
    input: {
      apiKeyIds: readonly string[];
      businessId: string;
      businessVersion: string;
      action: string;
      endpointSlug: string | null;
      profileId: string;
      groupId?: string;
    },
  ): Promise<void> => {
    const apiKeyIds = [...new Set(input.apiKeyIds)].sort();
    for (const apiKeyId of apiKeyIds) {
      await assertSelectorAvailable(client, {
        apiKeyId,
        businessId: input.businessId,
        businessVersion: input.businessVersion,
        action: input.action,
        endpointSlug: input.endpointSlug,
        profileId: input.profileId,
        ...(input.groupId ? { groupId: input.groupId } : {}),
      });
    }
  };

  type CreatedProfileRevision = {
    profileId: string;
    revision: number;
    tenantId: string;
    /** PC-03: null for a group-owned append — there is no authoring key. */
    apiKeyId: string | null;
  };

  const appendRevision = async (
    input: CreateBindingInput,
    activeClient?: PoolClient,
    groupOwnerId?: string,
    actor?: ProfileRevisionActor,
  ): Promise<CreatedProfileRevision> => {
    const run = async (c: PoolClient): Promise<CreatedProfileRevision> => {
      const bindings = parseConnectorBindings(input.connectorBindings);
      if (!input.businessId || !input.businessVersion || !input.action) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'businessId, businessVersion and action are required');
      }
      // PC-03: two mutually exclusive AUTHOR modes, independent of who owns the
      // profile. Legacy group children (CHILD_PROJECTION) are group-owned AND
      // key-authored; v2 children (GROUP_GRANT) are group-owned and
      // actor-authored. Accepting both authors at once would let a caller claim
      // group ownership while a key silently authors the revision.
      const groupOwned = groupOwnerId !== undefined;
      const keyAuthored = input.apiKeyHash !== undefined && input.apiKeyHash.length > 0;
      if (keyAuthored && actor !== undefined) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'a profile revision is authored by an API key or an Admin actor, never both');
      }
      if (keyAuthored && input.actor !== undefined) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'profile-group appends must not carry an api key author');
      }
      if (!keyAuthored) {
        if (!groupOwned) {
          throw new HttpError(422, 'INVALID_SCHEMA', 'apiKeyHash is required when no profile group owns the profile');
        }
        const authorActor = actor ?? input.actor;
        if (authorActor === undefined || authorActor.actor.trim().length === 0) {
          throw new HttpError(422, 'INVALID_SCHEMA', 'profile-group appends require the Admin actor that authored them');
        }
      }

      let tenantId: string;
      let key: LockedApiKeyRow | null = null;
      let authorKeyId: string | null = null;
      if (keyAuthored) {
        const keyRes = await c.query<{ id: string; tenant_id: string }>(
          'SELECT id, tenant_id FROM api_keys WHERE hash=$1 AND status=$2',
          [input.apiKeyHash, 'ACTIVE']
        );
        if (!keyRes.rowCount) throw new HttpError(404, 'NOT_FOUND', 'api key not found or not ACTIVE');
        tenantId = keyRes.rows[0]!.tenant_id;
        authorKeyId = keyRes.rows[0]!.id;
      } else {
        // The tenant is read from the LOCKED group root, never from the input:
        // the aggregate transaction supplies the group id server-side, and a
        // child must never be materialized into a tenant the group does not own.
        const group = await c.query<{ tenant_id: string }>(
          'SELECT tenant_id FROM profile_groups WHERE group_id=$1 FOR UPDATE',
          [groupOwnerId],
        );
        const groupRow = group.rows[0];
        if (!groupRow) throw new HttpError(404, 'NOT_FOUND', 'profile group was not found');
        tenantId = groupRow.tenant_id;
      }

      const profileId = input.profileId ?? randomUUID();
      // The aggregate save already holds its complete selector set and (for a
      // key-authored child) the authoring key row before materializing
      // children. An actor-authored append holds no key at all, so its
      // membership set is empty by construction.
      const mutationLocks = await lockProfileMutationOn(c, profileId, [
        { businessId: input.businessId, businessVersion: input.businessVersion, action: input.action, endpointSlug: input.endpointSlug },
      ], authorKeyId === null ? [] : [authorKeyId], groupOwnerId === undefined);
      if (authorKeyId !== null) {
        const locked = mutationLocks.keys.get(authorKeyId);
        if (!locked || locked.status !== 'ACTIVE' || locked.hash !== input.apiKeyHash) {
          throw new HttpError(404, 'NOT_FOUND', 'api key not found or not ACTIVE');
        }
        key = locked;
      }

      // The public createRevision method is also the direct admin binding
      // route's canonical write seam. Validate pins against the tenant from
      // the locked API-key row before any profile metadata or binding is
      // written. Profile-group saves have already validated their aggregate
      // pins against the same tenant-scoped source of truth.
      if (!groupOwned && Object.keys(bindings).length > 0) {
        const connectorManagement = options.connectorManagement;
        if (!connectorManagement) {
          throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'connector management is required to validate profile connector bindings');
        }
        for (const [slot, pin] of Object.entries(bindings)) {
          if (!await isActiveConnectorPin(connectorManagement, tenantId, pin)) {
            throw new HttpError(422, 'INVALID_SCHEMA', `connector binding '${slot}' is not an active connector revision for this tenant`);
          }
        }
      }

      // The public createRevision path is also called by the direct profile
      // binding HTTP route. Never trust a caller-supplied profileId to grant
      // mutation rights over a group child. The aggregate-only wrapper below
      // supplies groupOwnerId from its server-side group transaction.
      const owner = await c.query<{ group_id: string | null }>(
        'SELECT group_id FROM profile_names WHERE profile_id=$1 FOR UPDATE',
        [profileId],
      );
      const actualGroupId = owner.rows[0]?.group_id ?? null;
      if (actualGroupId !== null && actualGroupId !== groupOwnerId) {
        throw new HttpError(
          409,
          groupOwned ? 'STATE_CONFLICT' : 'PROFILE_GROUP_V2_REQUIRED',
          'this profile is owned by a profile group; edit it through the profile group',
        );
      }
      if (groupOwned && actualGroupId !== groupOwnerId) {
        throw new HttpError(409, 'STATE_CONFLICT', 'profile group child ownership could not be verified');
      }

      const maxRes = await c.query<{ m: number | null }>(
        'SELECT max(revision) AS m FROM profile_bindings WHERE profile_id=$1',
        [profileId]
      );
      const revision = (maxRes.rows[0]?.m ?? 0) + 1;
      const prevRes = await c.query<PolicyRow & { endpoint_slug: string | null }>(
        `SELECT enabled, parameters, job_priority, allowed_file_extensions,
                connections_override, file_url_auth_cipher, request_redaction, callback_policy,
                allowed_origins, request_defaults, endpoint_slug
           FROM profile_bindings WHERE profile_id=$1 AND revision=$2`,
        [profileId, revision - 1]
      );
      if (input.endpointSlug !== undefined && (input.businessId !== 'document-core' || !CORE_ENDPOINTS.has(input.endpointSlug) || input.endpointSlug.split(':')[0] !== input.action)) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'endpointSlug must be a supported core endpoint matching action');
      }
      if (prevRes.rows[0] && input.endpointSlug !== undefined && input.endpointSlug !== prevRes.rows[0].endpoint_slug) {
        throw new HttpError(409, 'STATE_CONFLICT', 'existing profile endpoint selector cannot be changed; create a dedicated profile');
      }
      const policy = carryForwardPolicy(prevRes.rows[0], input.policy, cryptoEnv, warnLegacyPlaintext);
      const endpointSlug = input.endpointSlug ?? prevRes.rows[0]?.endpoint_slug ?? null;
      if (input.requestDefaults !== undefined) {
        policy.requestDefaults = normalizeStoredRequestDefaults(input.requestDefaults);
      }
      if (keyAuthored) {
        await assertSelectorAvailableForMembershipsOn(c, {
          apiKeyIds: [...mutationLocks.memberships.map((membership) => membership.apiKeyId), key!.id],
          businessId: input.businessId,
          businessVersion: input.businessVersion,
          action: input.action,
          endpointSlug,
          profileId,
          ...(groupOwnerId ? { groupId: groupOwnerId } : {}),
        });
      }

      const authorActor = input.actor ?? actor;
      await c.query(
        `INSERT INTO profile_bindings
           (profile_id, revision, tenant_id, api_key_id, business_id, business_version, action,
            connector_bindings, enabled, parameters, job_priority, allowed_file_extensions,
            file_url_auth_cipher, connections_override, request_redaction, callback_policy,
            allowed_origins, endpoint_slug, request_defaults,
            created_by, created_by_issuer, created_by_sub)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [
          profileId,
          revision,
          tenantId,
          key === null ? null : key.id,
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
          endpointSlug,
          JSON.stringify(policy.requestDefaults ?? {}),
          authorActor?.actor ?? null,
          authorActor?.issuer ?? null,
          authorActor?.sub ?? null,
        ]
      );
      await pinActiveRevision(c, profileId, revision);
      // PC-03: only an ACTOR-authored append is grant-ledger territory. A
      // legacy key-authored child (CHILD_PROJECTION) keeps its ACTIVE
      // membership — that row IS its authority until the group is converted.
      if (keyAuthored) {
        await c.query(
          `INSERT INTO profile_api_keys (profile_id, api_key_id, tenant_id, state)
           VALUES ($1,$2,$3,'ACTIVE') ON CONFLICT (profile_id, api_key_id) DO NOTHING`,
          [profileId, key!.id, key!.tenant_id],
        );
      }
      return {
        profileId,
        revision,
        tenantId,
        apiKeyId: key === null ? null : key.id,
      };
    };
    return activeClient ? run(activeClient) : db.tx(run);
  };

  return {
    /** Lock a deterministic set of selector scopes before API-key or child-row
     * locks. The scope is global across keys so an operation can safely
     * discover and mutate a membership set without racing a different key. */
    async lockSelectors(selectors: readonly ProfileSelectorLock[], client: PoolClient): Promise<void> {
      await lockSelectorsOn(client, selectors);
    },

    /** Serialize a selector/pointer/revision mutation against all membership
     * writers. Selector scopes are acquired first, then every current member
     * key plus the authorizing key is row-locked in stable ID order. Both the
     * active pointer and membership set are re-read after those locks. */
    async lockProfileMutation(
      profileId: string | null,
      targetSelectors: readonly ProfileSelectorLock[],
      additionalApiKeyIds: readonly string[],
      client: PoolClient,
    ) {
      return lockProfileMutationOn(client, profileId, targetSelectors, additionalApiKeyIds);
    },

    async getRevisionSelector(profileId: string, revision: number, client: PoolClient): Promise<ProfileActiveSelector | null> {
      return revisionSelectorOn(client, profileId, revision);
    },

    async getLatestRevisionSelector(
      profileId: string,
      client: PoolClient,
    ): Promise<{ revision: number; selector: ProfileActiveSelector } | null> {
      return latestRevisionSelectorOn(client, profileId);
    },

    async listActiveProfileMemberships(profileId: string, client: PoolClient): Promise<ActiveProfileMembership[]> {
      return activeProfileMembershipsOn(client, profileId);
    },

    async assertSelectorAvailableForMemberships(
      input: {
        apiKeyIds: readonly string[];
        businessId: string;
        businessVersion: string;
        action: string;
        endpointSlug: string | null;
        profileId: string;
        groupId?: string;
      },
      client: PoolClient,
    ): Promise<void> {
      await assertSelectorAvailableForMembershipsOn(client, input);
    },

    /** Acquire an API-key row only after its selector locks. Rotation uses
     * UPDATE; binding writers use SHARE and validate status after the lock. */
    async lockApiKeyRow(
      apiKeyId: string,
      client: PoolClient,
      mode: 'share' | 'update' = 'share',
    ): Promise<LockedApiKeyRow | null> {
      return lockApiKeyRowOn(client, apiKeyId, mode);
    },

    async getActiveSelector(profileId: string, client: PoolClient): Promise<ProfileActiveSelector | null> {
      return activeSelectorOn(client, profileId);
    },

    /** Memberships to inherit during key rotation, paired with the active
     * selector lock set. A broken pointer is not silently omitted. */
    async listActiveMembershipSelectors(
      apiKeyId: string,
      client: PoolClient,
    ): Promise<Array<{ profileId: string; tenantId: string; selector: ProfileActiveSelector }>> {
      const result = await client.query<{
        profile_id: string;
        tenant_id: string;
        business_id: string | null;
        business_version: string | null;
        action: string | null;
        endpoint_slug: string | null;
      }>(
        `SELECT m.profile_id, m.tenant_id, b.business_id, b.business_version, b.action, b.endpoint_slug
           FROM profile_api_keys m
           LEFT JOIN profile_active_revisions a ON a.profile_id=m.profile_id
           LEFT JOIN profile_bindings b ON b.profile_id=a.profile_id AND b.revision=a.revision
          WHERE m.api_key_id=$1 AND m.state='ACTIVE'
          ORDER BY m.profile_id`,
        [apiKeyId],
      );
      return result.rows.map((row) => {
        if (!row.business_id || !row.business_version || !row.action) {
          throw new HttpError(409, 'STATE_CONFLICT', `active profile membership '${row.profile_id}' has no active selector`);
        }
        return {
          profileId: row.profile_id,
          tenantId: row.tenant_id,
          selector: {
            businessId: row.business_id,
            businessVersion: row.business_version,
            action: row.action,
            endpointSlug: row.endpoint_slug,
          },
        };
      });
    },

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
      apiKeyId: string | null;
    }> {
      return appendRevision(input, activeClient);
    },

    /** Server-side aggregate-only path; the group id is supplied by the
     * owning profile-group transaction, never from an HTTP request body.
     *
     * PC-03: group-owned appends carry the Admin actor instead of an API key,
     * so the caller MUST supply it — the revision's `created_by` is the only
     * attribution a group child has. */
    async createGroupChildRevision(
      input: CreateBindingInput,
      groupId: string,
      activeClient: PoolClient,
      actor?: ProfileRevisionActor,
    ): Promise<CreatedProfileRevision> {
      return appendRevision(input, activeClient, groupId, actor);
    },

    /** PC-03: the authority source of the group that owns `profileId`, or null
     * for a standalone profile. Read-only; used by the compatibility firewall
     * before any write. */
    async getProfileGroupAuthority(
      profileId: string,
      client?: Pick<PoolClient, 'query'> | Pick<Db, 'query'>,
    ): Promise<{ groupId: string | null; authority: 'CHILD_PROJECTION' | 'GROUP_GRANT' | null }> {
      const run = async (
        q: { query: PoolClient['query'] },
      ): Promise<{ groupId: string | null; authority: 'CHILD_PROJECTION' | 'GROUP_GRANT' | null }> => {
        const result = await q.query<{ group_id: string | null; auth_authority: string | null }>(
          `SELECT n.group_id, g.auth_authority
             FROM profile_names n
             LEFT JOIN profile_groups g ON g.group_id = n.group_id
            WHERE n.profile_id=$1
            LIMIT 1`,
          [profileId],
        );
        const row = result.rows[0];
        if (!row || row.group_id === null) return { groupId: null, authority: null };
        const authority = row.auth_authority === 'GROUP_GRANT' ? 'GROUP_GRANT' : 'CHILD_PROJECTION';
        return { groupId: row.group_id, authority };
      };
      return client ? run(client as { query: PoolClient['query'] }) : db.tx(run);
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
