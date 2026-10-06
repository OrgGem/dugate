/**
 * RV01-02 (#8): env -> ServerConfig encryption blocks for the production boot.
 *
 * Closes the ordering hole RV01-01 recorded: `main.ts` passed no crypto blocks
 * to `createApp`, so `metadataCrypto` was `undefined` and every control-plane
 * column kept its plaintext behaviour with no warning.
 *
 * Fail-closed by construction. The only way to get "no encryption" is
 * `ARTIFACT_STORAGE_BACKEND=postgres` with every enable flag off, and that is
 * a positive operator choice rather than a silently ignored config. Anything
 * half-specified throws at boot with the missing field named.
 *
 * The operator surface is ONE JSON env var mapped 1:1 onto the existing
 * `VaultTransitProviderOptions`. Tokens are deliberately NOT in that JSON:
 * `VaultTransitIdentity.token` is a thunk, so a token is re-read per request
 * instead of being frozen into process config at boot.
 */

import { VaultTransitProvider, type KeyProvider } from './vault-transit-provider';
import {
  SyntheticDataExemptionSchema,
  type SyntheticDataExemption,
} from '@du/contracts';
import {
  createBoundedDualReadWindow,
  type BoundedDualReadWindow,
} from './legacy-payload-migration';
import {
  createMetadataReadPolicy,
  isMetadataPlaintextReadMode,
  type MetadataReadPolicy,
} from './metadata-read-policy';

export const VAULT_TRANSIT_OPTIONS_ENV = 'DU_VAULT_TRANSIT_OPTIONS';
export const VAULT_ENCRYPT_TOKEN_ENV = 'DU_VAULT_TRANSIT_ENC_TOKEN';
export const VAULT_DECRYPT_TOKEN_ENV = 'DU_VAULT_TRANSIT_DEC_TOKEN';
export const METADATA_ENABLED_ENV = 'DU_ENCRYPTION_METADATA_ENABLED';
export const PUBLIC_UPLOAD_ENABLED_ENV = 'DU_ENCRYPTION_PUBLIC_UPLOAD_ENABLED';
/**
 * SEC-ENC-05 mode switch. `real` (the DEFAULT when unset) requires persistence
 * encryption across PG/S3 and every producer: a missing flag, partial surface
 * or missing key refuses the boot. Only an explicit `synthetic` mode with a
 * complete acknowledgement object may opt out — omission can never disable
 * encryption.
 */
export const DATA_MODE_ENV = 'DU_DATA_MODE';
/**
 * Required with `DU_DATA_MODE=synthetic`; JSON matching the SEC-ENC-01
 * explicit exemption (`reason`, `approvedBy`, `acknowledgedAt`,
 * `isolatedFromRealData: true`). Real tenant data must not use it.
 */
export const SYNTHETIC_ACK_ENV = 'DU_SYNTHETIC_DATA_ACK';
// CONTROL-PLANE-IMPL-818: the one operator-facing switch for allowPlaintext.
// REQUIRED: an absent or unknown mode fails the boot (buildMetadataReadPolicy).
export const METADATA_READ_MODE_ENV = 'DU_METADATA_PLAINTEXT_READ_MODE';
// Required when METADATA_READ_MODE_ENV === 'window'; ignored for 'forbid'.
export const METADATA_WINDOW_START_ENV = 'DU_METADATA_PLAINTEXT_WINDOW_START';
export const METADATA_WINDOW_END_ENV = 'DU_METADATA_PLAINTEXT_WINDOW_END';

const MAX_TOKEN_CHARS = 8192;

export class EncryptionBootConfigError extends Error {
  public constructor(message: string) {
    super('refusing to boot: ' + message);
    this.name = 'EncryptionBootConfigError';
  }
}

/** The validated operator surface, before any Vault client exists. */
export interface EncryptionBootConfig {
  readonly vaultAddress: string;
  readonly allowedKeyRefs: Readonly<Record<string, string>>;
  readonly transitMount?: string;
  readonly requestTimeoutMs?: number;
  readonly metadataKeyRef?: string;
  readonly publicUploadKeyRef?: string;
  readonly publicUploadKeyVersion?: number;
  readonly publicUploadMaxBytes?: number;
}

/** The three blocks `createApp` accepts, all sharing one Vault-backed provider. */
export interface EncryptionBootOptions {
  readonly cryptoConfig: { readonly allowedKeyRefs: readonly string[] };
  readonly metadataEncryption?: { readonly keyProvider: KeyProvider; readonly keyRef: string };
  readonly publicUploadEncryption?: {
    readonly keyProvider: KeyProvider;
    readonly keyRef: string;
    readonly keyVersion?: number;
    readonly maxBytes?: number;
  };
}

export type EnvReader = Readonly<Record<string, string | undefined>>;

function readOptional(env: EnvReader, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** Strict boolean: an unset flag is off, a typo is a boot failure, never a guess. */
function readBoolean(env: EnvReader, name: string): boolean {
  const raw = readOptional(env, name);
  if (raw === undefined) return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new EncryptionBootConfigError(name + ' must be true or false, got ' + JSON.stringify(raw));
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new EncryptionBootConfigError(label + ' is required and must be a non-empty string');
  }
  return value;
}

function readBoundedInt(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new EncryptionBootConfigError(label + ' must be an integer between ' + min + ' and ' + max);
  }
  return value;
}

function parseKeyRefs(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EncryptionBootConfigError(VAULT_TRANSIT_OPTIONS_ENV + '.allowedKeyRefs must be an object');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    throw new EncryptionBootConfigError(
      VAULT_TRANSIT_OPTIONS_ENV + '.allowedKeyRefs must map at least one key ref',
    );
  }
  const out: Record<string, string> = {};
  for (const [ref, keyName] of entries) {
    out[ref] = requireNonEmptyString(keyName, VAULT_TRANSIT_OPTIONS_ENV + '.allowedKeyRefs[' + ref + ']');
  }
  return out;
}

function parseConfig(raw: string): EncryptionBootConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EncryptionBootConfigError(VAULT_TRANSIT_OPTIONS_ENV + ' must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new EncryptionBootConfigError(VAULT_TRANSIT_OPTIONS_ENV + ' must be a JSON object');
  }
  const source = parsed as Record<string, unknown>;
  const transitMount = source['transitMount'];
  if (transitMount !== undefined && typeof transitMount !== 'string') {
    throw new EncryptionBootConfigError(VAULT_TRANSIT_OPTIONS_ENV + '.transitMount must be a string');
  }
  return {
    vaultAddress: requireNonEmptyString(
      source['vaultAddress'],
      VAULT_TRANSIT_OPTIONS_ENV + '.vaultAddress',
    ),
    allowedKeyRefs: parseKeyRefs(source['allowedKeyRefs']),
    ...(transitMount === undefined ? {} : { transitMount }),
    ...(source['requestTimeoutMs'] === undefined
      ? {}
      : { requestTimeoutMs: readBoundedInt(source['requestTimeoutMs'], 'requestTimeoutMs', 1, 60_000) }),
    ...(source['metadataKeyRef'] === undefined
      ? {}
      : { metadataKeyRef: requireNonEmptyString(source['metadataKeyRef'], 'metadataKeyRef') }),
    ...(source['publicUploadKeyRef'] === undefined
      ? {}
      : { publicUploadKeyRef: requireNonEmptyString(source['publicUploadKeyRef'], 'publicUploadKeyRef') }),
    ...(source['publicUploadKeyVersion'] === undefined
      ? {}
      : { publicUploadKeyVersion: readBoundedInt(source['publicUploadKeyVersion'], 'publicUploadKeyVersion', 1, Number.MAX_SAFE_INTEGER) }),
    ...(source['publicUploadMaxBytes'] === undefined
      ? {}
      : { publicUploadMaxBytes: readBoundedInt(source['publicUploadMaxBytes'], 'publicUploadMaxBytes', 1, Number.MAX_SAFE_INTEGER) }),
  };
}

/**
 * SEC-ENC-05 effective data mode. Default is `real`; the synthetic opt-out is
 * only valid with the complete explicit acknowledgement object.
 */
export type DataMode = 'real' | 'synthetic';

export interface EffectiveDataMode {
  readonly mode: DataMode;
  /** Present only in synthetic mode, after validation. */
  readonly exemption?: SyntheticDataExemption;
}

export function resolveDataMode(env: EnvReader): EffectiveDataMode {
  const raw = readOptional(env, DATA_MODE_ENV);
  if (raw === undefined || raw === 'real') return { mode: 'real' };
  if (raw !== 'synthetic') {
    throw new EncryptionBootConfigError(
      DATA_MODE_ENV + ' must be real or synthetic, got ' + JSON.stringify(raw),
    );
  }
  const ackRaw = readOptional(env, SYNTHETIC_ACK_ENV);
  if (ackRaw === undefined) {
    throw new EncryptionBootConfigError(
      'synthetic-data mode requires an explicit ' + SYNTHETIC_ACK_ENV
        + ' acknowledgement; encryption cannot be disabled by an omitted flag',
    );
  }
  let ack: unknown;
  try {
    ack = JSON.parse(ackRaw);
  } catch {
    throw new EncryptionBootConfigError(SYNTHETIC_ACK_ENV + ' must be valid JSON');
  }
  const parsed = SyntheticDataExemptionSchema.safeParse(ack);
  if (!parsed.success) {
    throw new EncryptionBootConfigError(
      SYNTHETIC_ACK_ENV + ' must be a complete synthetic-data exemption'
        + ' (mode, reason, approvedBy, acknowledgedAt, isolatedFromRealData)',
    );
  }
  return { mode: 'synthetic', exemption: parsed.data };
}

/**
 * True when this deployment must have a working encryption surface.
 *
 * SEC-ENC-05: real-data mode ALWAYS requires it, whatever the backend or the
 * legacy enable flags say. Only an explicit, acknowledged synthetic mode may
 * fall back to the previous rule (s3 implies it; the enable flags cover the
 * postgres backend where encryption was historically opt-in).
 */
export function encryptionIsRequired(env: EnvReader): boolean {
  if (resolveDataMode(env).mode === 'real') return true;
  const backend = readOptional(env, 'ARTIFACT_STORAGE_BACKEND') ?? 'postgres';
  return backend === 's3' || readBoolean(env, METADATA_ENABLED_ENV) || readBoolean(env, PUBLIC_UPLOAD_ENABLED_ENV);
}

function assertKeyRefAllowed(config: EncryptionBootConfig, keyRef: string | undefined, label: string): void {
  if (keyRef === undefined) {
    throw new EncryptionBootConfigError(label + ' is required but was not set');
  }
  if (!Object.prototype.hasOwnProperty.call(config.allowedKeyRefs, keyRef)) {
    throw new EncryptionBootConfigError(
      label + ' ' + JSON.stringify(keyRef) + ' is not present in allowedKeyRefs',
    );
  }
}

/**
 * Validate the operator surface. Returns `null` only when encryption is
 * neither required nor enabled — a deliberate postgres + all-flags-off boot.
 */
export function parseEncryptionBootConfig(env: EnvReader): EncryptionBootConfig | null {
  return resolveEncryptionBoot(env).config;
}

/**
 * Single decision point for "which blocks are on". Returning the flags
 * alongside the config keeps the enable decision from being recomputed — the
 * two copies drifted once already, which silently dropped the metadata block
 * while validation still demanded its key ref.
 */
function resolveEncryptionBoot(env: EnvReader): {
  readonly config: EncryptionBootConfig | null;
  readonly metadataEnabled: boolean;
  readonly publicUploadEnabled: boolean;
} {
  const backend = readOptional(env, 'ARTIFACT_STORAGE_BACKEND') ?? 'postgres';
  if (backend === 'vault') {
    throw new EncryptionBootConfigError(
      'ARTIFACT_STORAGE_BACKEND=vault is not a storage backend; artifact storage is postgres or s3, '
      + 'and Vault is configured through ' + VAULT_TRANSIT_OPTIONS_ENV,
    );
  }
  if (backend !== 'postgres' && backend !== 's3') {
    throw new EncryptionBootConfigError('ARTIFACT_STORAGE_BACKEND must be postgres or s3, got ' + JSON.stringify(backend));
  }

  // s3 is the encrypted-upload backend, so it turns on BOTH blocks: the artifact
  // write path and the control-plane columns. Leaving metadata off here is the
  // exact fail-open RV01-02 exists to close.
  //
  // SEC-ENC-05: real-data mode forces BOTH blocks regardless of backend/flags;
  // only an explicit synthetic exemption keeps the historical opt-in shape.
  const dataMode = resolveDataMode(env);
  const forced = dataMode.mode === 'real';
  const s3 = backend === 's3';
  const metadataEnabled = forced || readBoolean(env, METADATA_ENABLED_ENV) || s3;
  const publicUploadEnabled = forced || readBoolean(env, PUBLIC_UPLOAD_ENABLED_ENV) || s3;
  if (!metadataEnabled && !publicUploadEnabled) return { config: null, metadataEnabled, publicUploadEnabled };

  const raw = readOptional(env, VAULT_TRANSIT_OPTIONS_ENV);
  if (raw === undefined) {
    throw new EncryptionBootConfigError(
      VAULT_TRANSIT_OPTIONS_ENV + ' is required when artifact encryption is enabled'
        + (forced ? ' (real-data mode; export ' + DATA_MODE_ENV + '=synthetic with an explicit '
          + SYNTHETIC_ACK_ENV + ' only for isolated synthetic data)' : '')
        + '; refusing to store artifacts in plaintext',
    );
  }
  const config = parseConfig(raw);

  if (metadataEnabled) assertKeyRefAllowed(config, config.metadataKeyRef, 'metadataKeyRef');
  if (publicUploadEnabled) assertKeyRefAllowed(config, config.publicUploadKeyRef, 'publicUploadKeyRef');

  return { config, metadataEnabled, publicUploadEnabled };
}

function readToken(env: EnvReader, name: string): string {
  const value = readOptional(env, name);
  if (value === undefined) {
    throw new EncryptionBootConfigError(name + ' is required when artifact encryption is enabled');
  }
  if (value.length > MAX_TOKEN_CHARS) {
    throw new EncryptionBootConfigError(name + ' is longer than ' + MAX_TOKEN_CHARS + ' characters');
  }
  return value;
}

/**
 * CONTROL-PLANE-IMPL-818: parse the operator's plaintext-read switch.
 *
 * REQUIRED whenever this deployment has a metadata seam — an absent or
 * unknown mode fails the boot, so `allowPlaintext` can never again be an
 * implicit, uncontrolled `true`. A deployment with no seam at all (postgres,
 * every enable flag off) never parses it: there is no plaintext read to
 * govern, `metadataCrypto` is undefined and the reader applies the no-seam
 * rule.
 *
 * | mode     | required env                | policy built |
 * |----------|-----------------------------|--------------|
 * | `window` | start + end (ISO or epoch)  | bounded window (<= 14 days, enforced by createBoundedDualReadWindow) |
 * | `forbid` | none — carrying window vars is a refusal to boot (contradiction) | no window, `allowPlaintext()` always false |
 *
 * An inverted window, an over-cap window, or an unparseable instant becomes
 * `EncryptionBootConfigError` rather than a silently shifted window.
 */
export function buildMetadataReadPolicy(env: EnvReader): MetadataReadPolicy {
  const rawMode = readOptional(env, METADATA_READ_MODE_ENV);
  if (rawMode === undefined) {
    throw new EncryptionBootConfigError(
      METADATA_READ_MODE_ENV + ' is required when metadata encryption is enabled; '
        + 'set it to window (while the ENC-09 backfill is running) or forbid',
    );
  }
  if (!isMetadataPlaintextReadMode(rawMode)) {
    throw new EncryptionBootConfigError(
      METADATA_READ_MODE_ENV + ' must be window or forbid, got ' + JSON.stringify(rawMode),
    );
  }

  const hasWindowVars = readOptional(env, METADATA_WINDOW_START_ENV) !== undefined
    || readOptional(env, METADATA_WINDOW_END_ENV) !== undefined;
  if (rawMode === 'forbid') {
    if (hasWindowVars) {
      throw new EncryptionBootConfigError(
        METADATA_READ_MODE_ENV + '=forbid must not be combined with '
          + METADATA_WINDOW_START_ENV + '/' + METADATA_WINDOW_END_ENV
          + ' — forbid admits no window',
      );
    }
    return createMetadataReadPolicy('forbid', null);
  }

  const startsAtMs = readInstantMs(env, METADATA_WINDOW_START_ENV);
  const expiresAtMs = readInstantMs(env, METADATA_WINDOW_END_ENV);
  let window: BoundedDualReadWindow;
  try {
    window = createBoundedDualReadWindow(startsAtMs, expiresAtMs);
  } catch (error) {
    throw new EncryptionBootConfigError(
      METADATA_WINDOW_START_ENV + '/' + METADATA_WINDOW_END_ENV + ' is not a valid dual-read window: '
        + (error instanceof Error ? error.message : String(error)),
    );
  }
  return createMetadataReadPolicy('window', window, startsAtMs);
}

/** ISO-8601 instant or epoch milliseconds — both are unambiguous on the wire. */
function readInstantMs(env: EnvReader, name: string): number {
  const raw = readOptional(env, name);
  if (raw === undefined) {
    throw new EncryptionBootConfigError(
      name + ' is required when ' + METADATA_READ_MODE_ENV + '=window',
    );
  }
  if (/^-?\d+$/.test(raw)) {
    const epochMs = Number(raw);
    if (Number.isSafeInteger(epochMs)) return epochMs;
    throw new EncryptionBootConfigError(name + ' must be an ISO-8601 instant or epoch milliseconds, got ' + JSON.stringify(raw));
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new EncryptionBootConfigError(name + ' must be an ISO-8601 instant or epoch milliseconds, got ' + JSON.stringify(raw));
  }
  return parsed;
}

/**
 * Build the `createApp` blocks. Encrypt and decrypt identities stay separate
 * objects with separate thunks: `VaultTransitProvider` refuses to share them,
 * and a shared token would collapse the least-privilege split the two suppliers
 * exist to keep.
 */
export function buildEncryptionBootOptions(env: EnvReader): EncryptionBootOptions | null {
  const { config, metadataEnabled, publicUploadEnabled } = resolveEncryptionBoot(env);
  if (config === null) return null;

  const encryptToken = readToken(env, VAULT_ENCRYPT_TOKEN_ENV);
  const decryptToken = readToken(env, VAULT_DECRYPT_TOKEN_ENV);
  if (encryptToken === decryptToken) {
    throw new EncryptionBootConfigError(
      VAULT_ENCRYPT_TOKEN_ENV + ' and ' + VAULT_DECRYPT_TOKEN_ENV + ' must be different Vault tokens',
    );
  }

  const keyProvider = new VaultTransitProvider({
    vaultAddress: config.vaultAddress,
    allowedKeyRefs: config.allowedKeyRefs,
    encryptIdentity: { token: () => readOptional(env, VAULT_ENCRYPT_TOKEN_ENV) ?? encryptToken },
    decryptIdentity: { token: () => readOptional(env, VAULT_DECRYPT_TOKEN_ENV) ?? decryptToken },
    ...(config.transitMount === undefined ? {} : { transitMount: config.transitMount }),
    ...(config.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: config.requestTimeoutMs }),
  });

  const metadataKeyRef = config.metadataKeyRef;
  const publicUploadKeyRef = config.publicUploadKeyRef;

  return {
    cryptoConfig: { allowedKeyRefs: Object.keys(config.allowedKeyRefs) },
    ...(metadataEnabled && metadataKeyRef !== undefined
      ? { metadataEncryption: { keyProvider, keyRef: metadataKeyRef } }
      : {}),
    ...(publicUploadEnabled && publicUploadKeyRef !== undefined
      ? {
          publicUploadEncryption: {
            keyProvider,
            keyRef: publicUploadKeyRef,
            ...(config.publicUploadKeyVersion === undefined
              ? {}
              : { keyVersion: config.publicUploadKeyVersion }),
            ...(config.publicUploadMaxBytes === undefined
              ? {}
              : { maxBytes: config.publicUploadMaxBytes }),
          },
        }
      : {}),
  };
}

/** SEC-ENC-05: content-free effective policy summary for logs and /health. */
export interface EncryptionPolicySummary {
  readonly dataMode: DataMode;
  readonly syntheticReason?: string;
  readonly metadataEncryption: boolean;
  readonly publicUploadEncryption: boolean;
  readonly metadataPlaintextReadMode: 'forbid' | 'window' | 'none';
}

/**
 * Resolve the effective policy exactly as the boot would (same validation), so
 * a health surface can never advertise a policy the boot refused. Content-free:
 * no tokens, key material or Vault paths are ever part of this object.
 */
export function summarizeEncryptionPolicy(env: EnvReader): EncryptionPolicySummary {
  const dataMode = resolveDataMode(env);
  const { metadataEnabled, publicUploadEnabled } = resolveEncryptionBoot(env);
  let readMode: 'forbid' | 'window' | 'none' = 'none';
  if (metadataEnabled) {
    const raw = readOptional(env, METADATA_READ_MODE_ENV);
    if (raw === 'window' || raw === 'forbid') readMode = raw;
  }
  return {
    dataMode: dataMode.mode,
    ...(dataMode.exemption === undefined ? {} : { syntheticReason: dataMode.exemption.reason }),
    metadataEncryption: metadataEnabled,
    publicUploadEncryption: publicUploadEnabled,
    metadataPlaintextReadMode: readMode,
  };
}
