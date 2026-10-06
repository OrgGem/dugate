import { FILE_URL_AUTH_CIPHER_RE, FileUrlAuthConfigSchema, ProfileCallbackPolicySchema, RequestRedactionRulesSchema } from '@du/contracts';
import type { Db } from '../../db/db';
import type { ProfileEndpointPolicyRead } from '@du/contracts';

/**
 * T-API-01 closure — the REAL profile detail read.
 *
 * Replaces the `revision: 0 / currentValues: {}` placeholder projection with
 * the active revision resolved through `profile_names` (the Δ7-A registry) +
 * `profile_active_revisions` (0027) + the immutable `profile_bindings` row it
 * pins. Read-only by construction: this module runs SELECTs only, never
 * decrypts (the write shape's `fileUrlAuthConfig` stays behind
 * `fileUrlAuthConfigured`), and never touches the live profile services.
 *
 * Identity: the URL carries `(businessId, businessVersion, profileName)`; the
 * registry is unique per `(tenant, api key, business, version, action, name)`.
 * The admin read is platform-scoped and deterministic: the most recently
 * moved pointer wins, then the profile id (never a silent MAX(revision)
 * fallback — a missing pointer is an explicit inconsistent state).
 */

export interface ProfileDetailDbRow extends Record<string, unknown> {
  profile_id: string;
  revision: number;
  api_key_id: string;
  enabled: boolean | null;
  parameters: unknown;
  job_priority: string | null;
  allowed_file_extensions: string | null;
  connections_override: unknown;
  file_url_auth_cipher: string | null;
  request_redaction?: unknown;
  /** CB-02: stored callback policy (migration 0036), secret refs only. */
  callback_policy?: unknown;
}

export type ProfileDetailLookup =
  | { kind: 'found'; row: ProfileDetailDbRow }
  /** Registry row exists but the 0027 pointer is gone — fail closed, never guess. */
  | { kind: 'pointer-missing' }
  | { kind: 'not-found' };

export async function loadProfileDetail(
  db: Db,
  businessId: string,
  businessVersion: string,
  profileName: string
): Promise<ProfileDetailLookup> {
  const hit = await db.query<ProfileDetailDbRow>(
    `SELECT n.profile_id, a.revision, n.api_key_id,
            p.enabled, p.parameters, p.job_priority, p.allowed_file_extensions,
            p.connections_override, p.file_url_auth_cipher, p.request_redaction, p.callback_policy
       FROM profile_names n
       JOIN profile_active_revisions a ON a.profile_id = n.profile_id
       JOIN profile_bindings p
         ON p.profile_id = a.profile_id AND p.revision = a.revision
      WHERE n.business_id=$1 AND n.business_version=$2 AND n.profile_name=$3
      ORDER BY a.moved_at DESC, n.profile_id
      LIMIT 1`,
    [businessId, businessVersion, profileName]
  );
  if (hit.rowCount) return { kind: 'found', row: hit.rows[0]! };

  const orphan = await db.query(
    `SELECT 1 FROM profile_names
      WHERE business_id=$1 AND business_version=$2 AND profile_name=$3 LIMIT 1`,
    [businessId, businessVersion, profileName]
  );
  return orphan.rowCount ? { kind: 'pointer-missing' } : { kind: 'not-found' };
}

/** The schema-valid EMPTY read policy for the `/new` blank-editor shape. */
export const EMPTY_PROFILE_POLICY_READ: ProfileEndpointPolicyRead = {
  enabled: true,
  parameters: {},
  jobPriority: 'MEDIUM',
  allowedFileExtensions: '',
  fileUrlAuthConfigured: false,
  connectionsOverride: [],
  callbackPolicy: null,
};

const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;

function coercePriority(value: string | null): ProfileEndpointPolicyRead['jobPriority'] {
  return value === 'LOW' || value === 'MEDIUM' || value === 'HIGH' ? value : 'MEDIUM';
}

/**
 * `true` when a cipher OR a legacy plaintext JSON config is stored — the
 * same two generations `decryptFileUrlAuthConfig` accepts, decided WITHOUT
 * decrypting (read paths never need the secret).
 */
function fileUrlAuthConfigured(stored: string | null): boolean {
  if (typeof stored !== 'string' || stored.length === 0) return false;
  if (FILE_URL_AUTH_CIPHER_RE.test(stored)) return true;
  try {
    return FileUrlAuthConfigSchema.safeParse(JSON.parse(stored)).success;
  } catch {
    return false;
  }
}

/** Lenient read normalization: display data, not a write boundary. */
function normalizeParameters(raw: unknown): ProfileEndpointPolicyRead['parameters'] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: ProfileEndpointPolicyRead['parameters'] = {};
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (key.length === 0) continue;
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry) && 'value' in entry) {
      const value = (entry as { value: unknown }).value;
      const locked = (entry as { isLocked?: unknown }).isLocked;
      out[key] = typeof locked === 'boolean' ? { value, isLocked: locked } : { value };
    } else {
      out[key] = { value: entry };
    }
  }
  return out;
}

export function profileDetailPolicyRead(row: ProfileDetailDbRow): ProfileEndpointPolicyRead {
  // WT-04: never expose malformed stored content, but distinguish it from
  // an absent policy so operators can replace or explicitly clear the pin.
  const storedCallback = row.callback_policy === null || row.callback_policy === undefined
    ? null : ProfileCallbackPolicySchema.safeParse(row.callback_policy);
  const callbackPolicy = storedCallback?.success ? storedCallback.data : null;
  const callbackPolicyInvalid = storedCallback !== null && !storedCallback.success;
  return {
    enabled: typeof row.enabled === 'boolean' ? row.enabled : true,
    parameters: normalizeParameters(row.parameters),
    jobPriority: coercePriority(row.job_priority),
    allowedFileExtensions:
      typeof row.allowed_file_extensions === 'string' ? row.allowed_file_extensions : '',
    fileUrlAuthConfigured: fileUrlAuthConfigured(row.file_url_auth_cipher),
    connectionsOverride: Array.isArray(row.connections_override) ? row.connections_override : [],
    ...(row.request_redaction !== undefined ? { requestRedaction: RequestRedactionRulesSchema.parse(row.request_redaction) } : {}),
    callbackPolicy,
    ...(callbackPolicyInvalid ? { callbackPolicyInvalid: true as const } : {}),
  };
}

/** Flat `{"paramKey": "<string value>"}` for the form grid. */
export function profileDetailCurrentValues(row: ProfileDetailDbRow): Record<string, string> {
  const parameters = profileDetailPolicyRead(row).parameters;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parameters)) {
    const value = entry.value;
    out[key] =
      value === null || value === undefined
        ? ''
        : typeof value === 'string'
          ? value
          : JSON.stringify(value);
  }
  return out;
}
