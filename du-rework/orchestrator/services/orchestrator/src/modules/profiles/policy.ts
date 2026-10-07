import {
  PROFILE_JOB_PRIORITY_DEFAULT,
  PROFILE_JOB_PRIORITY_WEIGHTS,
  ProfileEndpointPolicySchema,
  ProfileJobPrioritySchema,
  ProfileParametersSchema,
  RequestRedactionRulesSchema,
  type RequestRedactionRule,
  parseAllowedFileExtensions,
  type ConnectionStep,
  type ProfileEndpointPolicy,
  type ProfileJobPriority,
  type ProfileParameters,
  type ProfileParameterValue,
} from '@du/contracts';
import { extname } from 'node:path';
import { HttpError, badRequest } from '../../http/errors';

/**
 * T-PROF-02 — profile policy parse + parameter merge.
 *
 * Ports legacy `lib/endpoints/profile-resolver.ts:49-93` (`mergeParameters`)
 * and the write-side validation of `app/api/internal/profile-endpoints/route.ts`.
 * Two rules carry over verbatim and are load-bearing:
 *
 *  1. A LOCKED parameter that is PRESENT in the client payload is refused with
 *     400 `PROFILE_LOCKED_FIELD` even when the value is identical to the stored
 *     one. Legacy checked `form.has(key)`, not the value — the send itself is
 *     the violation, because a client that can write a locked key at all is
 *     one that has stopped honouring the lock.
 *  2. `allowedFileExtensions` is a CSV STRING on the wire and in the column.
 *     Legacy only `trim()`ed it on write and split/trim/drop-empty on read —
 *     no MIME whitelist, no case folding, no de-duplication. Enforcement lives
 *     at the point of use (T-SUB-03), never at this boundary.
 */

/** The stored policy: the write schema with defaults applied, minus the secret. */
export interface StoredProfilePolicy {
  enabled: boolean;
  parameters: ProfileParameters;
  jobPriority: ProfileJobPriority;
  /** CSV string, exactly as stored. Parse with `parseAllowedFileExtensions`. */
  allowedFileExtensions: string;
  connectionsOverride: ConnectionStep[];
  /** True when a cipher (or a legacy plaintext config) is stored. */
  fileUrlAuthConfigured: boolean;
}

/**
 * Validate a policy as it arrives on a WRITE path (admin upsert, import).
 * Every field is optional — legacy treated an absent field as "leave
 * unchanged", and the BFF forwards `body.policy` through unvalidated today, so
 * rejecting a partial policy would strand the Save button.
 *
 * `.strict()` is the point: an unrecognized key is a typo or a stale client,
 * and 422 beats writing a field nobody reads.
 */
export function parsePolicy(raw: unknown): ProfileEndpointPolicy {
  const parsed = ProfileEndpointPolicySchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'policy validation failed', {
      errors: parsed.error.issues.slice(0, 50).map((i) => ({
        pointer: '/' + i.path.join('/'),
        message: i.message,
      })),
    });
  }
  return parsed.data;
}

/**
 * Apply the stored defaults to a raw policy, producing the shape the read and
 * enforcement paths consume. Absent fields fall back to the legacy defaults
 * (`enabled: true`, `jobPriority: 'MEDIUM'`, empty CSV, empty override list).
 */
export function normalizeStoredPolicy(policy: ProfileEndpointPolicy): StoredProfilePolicy {
  return {
    enabled: policy.enabled ?? true,
    parameters: policy.parameters ?? {},
    jobPriority: policy.jobPriority ?? PROFILE_JOB_PRIORITY_DEFAULT,
    allowedFileExtensions: policy.allowedFileExtensions ?? '',
    connectionsOverride: policy.connectionsOverride ?? [],
    fileUrlAuthConfigured: false,
  };
}

/** The BullMQ `priority` option for a profile priority. Lower runs first. */
export function bullMqPriorityFor(priority: ProfileJobPriority): number {
  return PROFILE_JOB_PRIORITY_WEIGHTS[priority];
}

/** Validate a priority string coming off the wire (admin write path). */
export function parseJobPriority(raw: unknown): ProfileJobPriority {
  const parsed = ProfileJobPrioritySchema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest('jobPriority must be one of LOW, MEDIUM, HIGH');
  }
  return parsed.data;
}

/**
 * MEDIUM-1 - keys that must never be written into a parameter map.
 *
 * Measured 2026-10-04 (probe, .qwen/tmp/p745-probe.js): `JSON.parse` creates
 * an OWN `__proto__` property and `Object.entries` surfaces it, so a crafted
 * body reaches the loops below. Assigning one of these keys does NOT add an
 * own key - it sets the PROTOTYPE of the target object, which silently
 * manufactures inherited properties (`merged.polluted === 'yes'`). It does not
 * reach `Object.prototype` globally (`({}).polluted` stays `undefined`), so
 * this is a per-object prototype set, not a realm-wide pollution.
 *
 * The deny is therefore defence-in-depth on the client path (the allowlist
 * already blocks it unless a manifest declares such a key) and a real fix on
 * the write/read paths, where an admin-controlled key reaches the assignment
 * directly (`parametersFromFlatValues`, `coerceRowParameters`).
 */
const RESERVED_PARAMETER_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

export function isReservedParameterKey(key: string): boolean {
  return RESERVED_PARAMETER_KEYS.has(key);
}

/**
 * MEDIUM-1 - service-side caps on a parameter map. Deliberately NOT in
 * contracts: the wire schema stays `value: z.unknown()` so a business can
 * carry any JSON value, and a contract change would re-freeze the snapshot DTO.
 * These bound what one admin may persist, not what a value may contain.
 */
export const PROFILE_PARAMETER_MAX_KEYS = 64;
export const PROFILE_PARAMETER_MAX_VALUE_LENGTH = 8192;

/** Serialized size of a value: strings by length, everything else by JSON. */
function parameterValueSize(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (value === undefined) return 0;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : json.length;
  } catch {
    // Circular or non-serializable: refuse rather than measure.
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Validate the `parameters` half of a policy as it arrives on a WRITE path.
 *
 * Three checks, in this order, each fail-closed 422:
 *  1. reserved keys - refused before the shape parse, so a crafted key never
 *     reaches a zod record assignment;
 *  2. the strict contract shape (`ProfileParametersSchema`) - a value that is
 *     not `{ value, isLocked? }` is a stale writer, not a value to carry;
 *  3. the caps above - key count and per-value size.
 *
 * Only the CLIENT-SUPPLIED branch is validated. A carried-forward previous
 * revision is already stored and is read tolerantly (`coerceRowParameters`), so
 * re-validating it would strand a live profile on a legacy row shape.
 */
export function parseWriteParameters(raw: unknown): ProfileParameters {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'parameters must be an object of key -> { value, isLocked? }');
  }
  for (const [key, config] of Object.entries(raw as Record<string, unknown>)) {
    if (isReservedParameterKey(key)) {
      throw new HttpError(422, 'INVALID_SCHEMA', `parameter key '${key}' is reserved and cannot be stored`);
    }
    // `value: z.unknown()` makes the key OPTIONAL in zod (unknown includes
    // undefined), so the shape schema alone accepts `{ isLocked: true }`.
    // The READ path does not: `isProfileParameters`/`coerceRowParameters`
    // require `value` and silently DROP an entry without it. Requiring it here
    // keeps write and read in agreement - a stored entry is one that reads back.
    if (
      typeof config !== 'object' ||
      config === null ||
      !Object.prototype.hasOwnProperty.call(config, 'value') ||
      (config as { value?: unknown }).value === undefined
    ) {
      throw new HttpError(422, 'INVALID_SCHEMA', `parameter '${key}' must be { value, isLocked? } with a defined value`);
    }
  }
  const parsed = ProfileParametersSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'parameters failed validation', {
      errors: parsed.error.issues.slice(0, 50).map((i) => ({
        pointer: '/parameters/' + i.path.join('/'),
        message: i.message,
      })),
    });
  }
  const entries = Object.entries(parsed.data);
  if (entries.length > PROFILE_PARAMETER_MAX_KEYS) {
    throw new HttpError(422, 'INVALID_SCHEMA',
      `parameters has ${entries.length} keys; at most ${PROFILE_PARAMETER_MAX_KEYS} are allowed`);
  }
  for (const [key, config] of entries) {
    const size = parameterValueSize(config.value);
    if (size > PROFILE_PARAMETER_MAX_VALUE_LENGTH) {
      throw new HttpError(422, 'INVALID_SCHEMA',
        `parameter '${key}' is ${size} bytes; at most ${PROFILE_PARAMETER_MAX_VALUE_LENGTH} are allowed`);
    }
  }
  return parsed.data;
}

/**
 * Merge the client's parameter payload over the stored profile defaults.
 *
 * Legacy `mergeParameters` seeded `mergedVars` from the DB profile, then walked
 * the union of the manifest's declared keys and the DB keys. Two deviations,
 * both deliberate and both documented:
 *
 *  - **Unknown key → 400 `PROFILE_UNKNOWN_FIELD`.** Legacy silently ignored a
 *    key that was in neither set. The plan calls for 400, and a key the server
 *    has never heard of is a client/schema version skew, not a no-op.
 *  - **Client values keep their JSON type.** Legacy coerced everything to
 *    string because the source was `FormData`. Here the payload has already
 *    passed the action's `inputSchema` (AJV), so coercing to string would
 *    destroy a validated number/boolean.
 *
 * @param profileDefaults  the stored `parameters` map
 * @param clientInput      the client's parameter payload
 * @param declaredKeys     the manifest's declared parameter keys. When
 *                         omitted, the stored keys are the only allowed set
 *                         (the legacy fallback for a manifest-less profile).
 */
export function mergeParameters(
  profileDefaults: ProfileParameters,
  clientInput: Record<string, unknown>,
  declaredKeys?: readonly string[]
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [key, config] of Object.entries(profileDefaults)) {
    // A reserved key in a stored row is skipped, never assigned: assigning it
    // would set the prototype of `merged` instead of adding an own key.
    if (isReservedParameterKey(key)) continue;
    merged[key] = config.value;
  }

  const allowed = new Set<string>([
    ...(declaredKeys ?? []),
    ...Object.keys(profileDefaults),
  ]);

  for (const [key, value] of Object.entries(clientInput)) {
    // Reserved keys are refused outright. The allowlist below would only block
    // them incidentally - and only when no manifest declares them.
    if (isReservedParameterKey(key)) {
      throw new HttpError(400, 'PROFILE_UNKNOWN_FIELD', `parameter '${key}' is reserved and cannot be supplied`, {
        errors: [{ pointer: `/${key}`, message: 'reserved key' }],
      });
    }
    if (!allowed.has(key)) {
      throw new HttpError(400, 'PROFILE_UNKNOWN_FIELD', `parameter '${key}' is not declared by this profile`, {
        errors: [{ pointer: `/${key}`, message: 'unknown parameter' }],
      });
    }
    const isLocked = profileDefaults[key]?.isLocked ?? false;
    if (isLocked) {
      // Presence, not value: identical content is still a refusal.
      throw new HttpError(400, 'PROFILE_LOCKED_FIELD', `parameter '${key}' is locked by the administrator`, {
        errors: [{ pointer: `/${key}`, message: 'locked by the administrator' }],
      });
    }
    merged[key] = value;
  }

  return merged;
}

/**
 * The parameter value the worker should see for one key: the client's value
 * when it sent one, otherwise the stored default. Exposed separately from
 * `mergeParameters` so the read path can render the effective grid without
 * re-running the lock check (a read must never 400 on a locked key the client
 * did not send).
 */
export function effectiveParameterValue(
  key: string,
  profileDefaults: ProfileParameters,
  clientInput: Record<string, unknown>
): unknown {
  if (Object.prototype.hasOwnProperty.call(clientInput, key)) {
    return clientInput[key];
  }
  return profileDefaults[key]?.value;
}

/** Type guard for a stored parameter map, used when reading a row back. */
export function isProfileParameters(raw: unknown): raw is ProfileParameters {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  for (const config of Object.values(raw as Record<string, unknown>)) {
    if (typeof config !== 'object' || config === null) return false;
    const c = config as { value?: unknown; isLocked?: unknown };
    if (!('value' in c)) return false;
    if (c.isLocked !== undefined && typeof c.isLocked !== 'boolean') return false;
  }
  return true;
}

/**
 * Coerce a possibly-absent stored parameter map, never throwing.
 *
 * Returns a COPY, never the caller's object: a stored row read back through
 * `JSON.parse` can carry an OWN `__proto__` key, and handing that object on
 * would let the next `Object.entries` walk it into a prototype assignment.
 */
export function coerceProfileParameters(raw: unknown): ProfileParameters {
  if (!isProfileParameters(raw)) return {};
  const out: ProfileParameters = {};
  for (const [key, entry] of Object.entries(raw as ProfileParameters)) {
    if (isReservedParameterKey(key)) continue;
    out[key] = entry;
  }
  return out;
}

/**
 * Coerce a possibly-absent stored parameter map from a row read, where the
 * column may be NULL or a legacy shape. Never throws.
 */
export function coerceRowParameters(raw: unknown): ProfileParameters {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: ProfileParameters = {};
  for (const [key, config] of Object.entries(raw as Record<string, unknown>)) {
    // Drop, never assign: an own `__proto__` from JSON.parse would otherwise
    // set this map's prototype instead of adding an entry.
    if (isReservedParameterKey(key)) continue;
    if (typeof config !== 'object' || config === null) continue;
    const c = config as { value?: unknown; isLocked?: unknown };
    if (!('value' in c)) continue;
    const entry: ProfileParameterValue = { value: c.value };
    if (typeof c.isLocked === 'boolean') entry.isLocked = c.isLocked;
    out[key] = entry;
  }
  return out;
}

/** Coerce a possibly-absent connections override, never throwing. */
export function coerceConnectionsOverride(raw: unknown): ConnectionStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is ConnectionStep =>
      typeof s === 'object' && s !== null && typeof (s as { slug?: unknown }).slug === 'string'
  );
}

/** Coerce a possibly-absent priority, falling back to the legacy default. */
export function coerceJobPriority(raw: unknown): ProfileJobPriority {
  return ProfileJobPrioritySchema.safeParse(raw).success
    ? (raw as ProfileJobPriority)
    : PROFILE_JOB_PRIORITY_DEFAULT;
}

/** Coerce a possibly-absent enabled flag, falling back to the legacy default. */
export function coerceEnabled(raw: unknown): boolean {
  return typeof raw === 'boolean' ? raw : true;
}

/** Coerce a possibly-absent CSV, falling back to the legacy default. */
export function coerceAllowedFileExtensions(raw: unknown): string {
  return typeof raw === 'string' ? raw : '';
}

/**
 * T-SUB-03 — the profile's extension list, normalized the way enforcement
 * compares it.
 *
 * Legacy `lib/upload.ts:86-88` lower-cased BOTH sides before comparing, so
 * `.PDF` in the CSV matched a `report.pdf`. `parseAllowedFileExtensions`
 * (contracts) deliberately preserves case because the stored string is
 * displayed verbatim in the admin UI; folding happens here, at the point of
 * use, exactly as the contract comment instructs.
 */
export function normalizedAllowedFileExtensions(csv: string): string[] {
  return parseAllowedFileExtensions(csv).map((part) => part.toLowerCase());
}

/**
 * T-SUB-03 — is `fileName` admitted by the profile's CSV?
 *
 * Mirrors legacy `validateFileMetadata` line for line on the comparison:
 * `extname(name).toLowerCase()` against the lower-cased CSV entries, plain
 * `includes`. Deliberately absent, because legacy had none and each would be
 * new behavior rather than parity:
 *
 *  - dot normalization. An admin who typed `pdf` instead of `.pdf` gets no
 *    match in legacy either; silently repairing it here would hide a config
 *    typo that legacy surfaced as "unsupported format".
 *  - MIME cross-check. The CSV is an extension list, not a MIME whitelist.
 *
 * An EMPTY CSV admits everything — see `extensionDeniedReason`.
 */
export function profileExtensionAllowed(csv: string, fileName: string): boolean {
  const allowed = normalizedAllowedFileExtensions(csv);
  if (allowed.length === 0) return true;
  return allowed.includes(extname(fileName).toLowerCase());
}

/**
 * Why `fileName` is refused, or `null` when it is admitted.
 *
 * The empty-CSV case is a real decision and not a no-op. Legacy fell back to
 * `DEFAULT_ALLOWED_EXTENSIONS` ('.docx', '.pdf') when the CSV was empty
 * (lib/upload.ts:86-88). du-rework does NOT, deliberately:
 *
 *  - du-rework's upload path has never had a type allowlist, so applying one
 *    here would be a NEW restriction, not a restored one;
 *  - it would bind hardest on exactly the keys an admin chose to manage,
 *    silently breaking their xlsx/image ingestion while their unmanaged
 *    neighbours kept accepting everything;
 *  - it would contradict migration 0026's own wording, where "NULL snapshot ≠
 *    empty policy" says an absent/empty policy means *nothing was applied*.
 *
 * So "no restriction configured" reads identically in legacy mode and in a
 * pinned profile whose CSV is empty. A non-empty CSV is enforced exactly as
 * legacy enforced it.
 */
export function extensionDeniedReason(csv: string, fileName: string): string | null {
  const allowed = normalizedAllowedFileExtensions(csv);
  if (allowed.length === 0) return null;
  const ext = extname(fileName).toLowerCase();
  if (allowed.includes(ext)) return null;
  return `only ${allowed.join(', ')} are accepted; this file has "${ext || 'no extension'}"`;
}

/**
 * The name a `file_urls` entry is checked under (T-SUB-03).
 *
 * Legacy `file-url-downloader.ts:184-188` resolved the name in three steps:
 * `entry.filename` → the response's `Content-Disposition` → the URL path.
 * The middle step needs a network round-trip, so it belongs to the download
 * leg and cannot run at submit. This covers the other two, which is exactly
 * the pair a submission can decide on: the declared name when the client
 * gave one, otherwise the URL's own path segment, and `null` when neither
 * yields an extension — in which case the entry is NOT judged here, because
 * guessing "no extension" would refuse URLs a server legitimately names via
 * `Content-Disposition`.
 */
export function fileUrlEntryName(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const declared = (entry as { filename?: unknown }).filename;
  if (typeof declared === 'string' && declared.trim().length > 0) return declared.trim();

  const url = (entry as { url?: unknown }).url;
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    // No query/hash: those never contribute an extension.
    const segment = decodeURIComponent(parsed.pathname.split('/').pop() ?? '');
    return segment.length > 0 ? segment : null;
  } catch {
    return null;
  }
}

/** Rebuild the stored parameter map from a flat `{key: value}` view. */
export function parametersFromFlatValues(values: Record<string, unknown>): ProfileParameters {
  const out: ProfileParameters = {};
  for (const [key, value] of Object.entries(values)) {
    if (isReservedParameterKey(key)) continue;
    const entry: ProfileParameterValue = { value };
    out[key] = entry;
  }
  return out;
}

/** Validate privacy configuration before the profile revision transaction writes. */
export function parseRequestRedactionRules(raw: unknown): RequestRedactionRule[] {
  const parsed = RequestRedactionRulesSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(422, 'INVALID_SCHEMA', 'Invalid request redaction rules');
  return parsed.data;
}
