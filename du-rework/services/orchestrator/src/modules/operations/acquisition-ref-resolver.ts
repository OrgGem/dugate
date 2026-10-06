import type { SdkFetcher } from '@du/worker-sdk';
import type { Db } from '../../db/db';
import {
  createLegacyPlaintextWarner,
  decryptFileUrlAuthConfig,
  fileUrlAuthConfigCarriesSecret,
  type ProfileEnv,
} from '../profiles/file-url-auth';

/**
 * P730-ACQUIRE (W1c) — the acquisition-time source-credential resolver.
 *
 * The worker and the queue never carry a raw Profile credential: an operation
 * pins only the immutable `credentialRef { tenantId, profileId,
 * profileRevision }` (PLAN04-01). This module is the ONLY place that turns that
 * ref back into a usable credential, and it does so:
 *
 *  1. **At fetch time, in the orchestrator.** `resolveSourceAuth` reads the
 *     pinned revision's `file_url_auth_cipher` FROM THE EXACT ROW the pin
 *     names and decrypts it immediately before the caller builds its fetch —
 *     the plaintext exists for one call, never in a claim, queue payload,
 *     checkpoint or log.
 *  2. **Fail-closed and typed, BEFORE any network.** Every failure path
 *     throws `SourceAuthDeniedError` with a deterministic code; the ingestion
 *     consumer escalates on those codes instead of retrying (redelivery cannot
 *     change any of them). A missing ref, a foreign tenant, a vanished
 *     revision, a wrong key/tag and a malformed pin are all distinct codes so
 *     operators can tell "no auth configured" from "auth configured but
 *     broken" without reading blobs.
 *  3. **URL-query credentials are forbidden by design (Δ2).** A
 *     `type: 'query'` config is DENIED — a secret must never travel in a query
 *     string (access logs, proxies, redirect `Location` echoes). The config is
 *     refused deliberately rather than "supported with care": the caller can
 *     re-save the profile with a header/bearer slot.
 *
 * Legacy plaintext rows (pre-encryption `file_url_auth_cipher` values) are
 * READ, never rewritten, mirroring `profiles.ts` `decodePolicy`: the warning
 * latch fires once per process and migration happens only through a profile
 * re-save. That keeps the read path byte-compatible with the historical rows
 * without turning plaintext into a silent default.
 */

export type ResolvedSourceAuth =
  | { kind: 'none' }
  | { kind: 'bearer'; token: string }
  | { kind: 'header'; headerName: string; headerValue: string };

export type SourceAuthDenialCode =
  | 'REF_INVALID'
  | 'REF_NOT_FOUND'
  | 'REF_TENANT_MISMATCH'
  | 'AUTH_CONFIG_MISSING'
  | 'AUTH_DECRYPT_FAILED'
  | 'QUERY_AUTH_FORBIDDEN';

/** Deterministic pre-network denial. Message text is fixed and secret-free. */
export class SourceAuthDeniedError extends Error {
  constructor(
    readonly status: number,
    readonly code: SourceAuthDenialCode,
    message: string
  ) {
    super(message);
    this.name = 'SourceAuthDeniedError';
  }
}

export interface AcquisitionRefCoords {
  operationId: string;
  tenantId: string;
}

export interface AcquisitionRefResolver {
  /**
   * Resolve the pinned Profile source credential for one operation.
   *
   * `{ kind: 'none' }` means the operation genuinely has no source auth
   * (legacy mode, or the pinned policy says auth is not configured) — the
   * caller proceeds unauthenticated. Anything else is a typed denial.
   */
  resolveSourceAuth(coords: AcquisitionRefCoords): Promise<ResolvedSourceAuth>;
}

interface PinnedRef {
  tenantId: string;
  profileId: string;
  profileRevision: number;
}

const OP_SNAPSHOT_SQL =
  'SELECT profile_policy_snapshot AS "snapshot" FROM operations WHERE id=$1 AND tenant_id=$2';

const BINDING_CIPHER_SQL =
  'SELECT tenant_id AS "tenantId", file_url_auth_cipher AS "cipher" ' +
  'FROM profile_bindings WHERE profile_id=$1 AND revision=$2';

function denial(status: number, code: SourceAuthDenialCode, message: string): SourceAuthDeniedError {
  return new SourceAuthDeniedError(status, code, message);
}

/**
 * Narrow, fail-closed extraction of the two fields this resolver needs.
 *
 * The full snapshot is parsed by the runtime's claim path; duplicating that
 * schema here would couple two lanes, so this reads exactly
 * `fileUrlAuthConfigured` and `credentialRef` and treats ANY other shape as a
 * corrupt admission record. NULL (pre-0026 / legacy-mode row) is the one
 * non-corrupt "no pin" state and maps to "no auth".
 */
function readPinnedAuth(snapshot: unknown): { configured: boolean; ref: PinnedRef | null } {
  if (snapshot === null || snapshot === undefined) return { configured: false, ref: null };
  if (typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw denial(422, 'REF_INVALID', 'pinned profile policy snapshot is not an object');
  }
  const record = snapshot as Record<string, unknown>;
  const configured = record['fileUrlAuthConfigured'];
  if (configured !== true && configured !== false) {
    throw denial(422, 'REF_INVALID', 'pinned profile policy snapshot has no fileUrlAuthConfigured flag');
  }
  if (configured === false) return { configured: false, ref: null };

  const rawRef = record['credentialRef'];
  if (typeof rawRef !== 'object' || rawRef === null || Array.isArray(rawRef)) {
    throw denial(422, 'REF_INVALID', 'pinned profile policy snapshot has no credential ref');
  }
  const ref = rawRef as Record<string, unknown>;
  const tenantId = ref['tenantId'];
  const profileId = ref['profileId'];
  const profileRevision = ref['profileRevision'];
  if (
    typeof tenantId !== 'string' || tenantId.length === 0 ||
    typeof profileId !== 'string' || profileId.length === 0 ||
    typeof profileRevision !== 'number' || !Number.isInteger(profileRevision) || profileRevision < 1
  ) {
    throw denial(422, 'REF_INVALID', 'pinned credential ref is not a valid (tenantId, profileId, revision) tuple');
  }
  return { configured: true, ref: { tenantId, profileId, profileRevision } };
}

export interface AcquisitionRefResolverOptions {
  db: Db;
  /** Key material for the profile cipher; defaults to process.env like decodePolicy. */
  env?: ProfileEnv;
  /** Test/ops seam for the legacy-plaintext warning; default is warn-once console. */
  onLegacyPlaintext?: () => void;
}

export function createAcquisitionRefResolver(
  options: AcquisitionRefResolverOptions
): AcquisitionRefResolver {
  const env = options.env ?? process.env;
  const warnLegacy =
    options.onLegacyPlaintext ??
    createLegacyPlaintextWarner((message) => {
      // eslint-disable-next-line no-console
      console.warn(`[acquisition-ref-resolver] ${message}`);
    });

  return {
    async resolveSourceAuth(coords: AcquisitionRefCoords): Promise<ResolvedSourceAuth> {
      const found = await options.db.query<{ snapshot: unknown }>(OP_SNAPSHOT_SQL, [
        coords.operationId,
        coords.tenantId,
      ]);
      const row = found.rows[0];
      if (!row) {
        throw denial(404, 'REF_NOT_FOUND', 'operation not found under its own tenant');
      }

      const pinned = readPinnedAuth(row.snapshot);
      if (!pinned.configured || pinned.ref === null) return { kind: 'none' };
      const ref = pinned.ref;

      // The ref's tenant is a trust anchor: it must be the operation's own
      // tenant. A ref lifted from another tenant is never "resolved to null",
      // it is a denial — the pin itself is broken.
      if (ref.tenantId !== coords.tenantId) {
        throw denial(403, 'REF_TENANT_MISMATCH', 'pinned credential ref belongs to a different tenant');
      }

      // The pinned revision row is immutable (one row per (profile_id,
      // revision)); reading it is NOT a live-profile resolve and cannot be
      // swapped by a later publish.
      const bindingRes = await options.db.query<{ tenantId: string; cipher: unknown }>(
        BINDING_CIPHER_SQL,
        [ref.profileId, ref.profileRevision]
      );
      const binding = bindingRes.rows[0];
      if (!binding) {
        throw denial(409, 'REF_NOT_FOUND', 'pinned profile revision does not exist');
      }
      if (binding.tenantId !== ref.tenantId) {
        throw denial(403, 'REF_TENANT_MISMATCH', 'pinned profile revision belongs to a different tenant');
      }
      if (binding.cipher === null || binding.cipher === undefined || binding.cipher === '') {
        throw denial(422, 'AUTH_CONFIG_MISSING', 'pinned revision has auth configured but no stored cipher');
      }

      let decrypted: ReturnType<typeof decryptFileUrlAuthConfig>;
      try {
        decrypted = decryptFileUrlAuthConfig(binding.cipher, env, warnLegacy);
      } catch {
        // The shared helper also serves profile writes and nullable policy
        // reads, so convert its missing-key exception at this typed resolver
        // boundary without changing those callers' contracts.
        throw denial(500, 'AUTH_DECRYPT_FAILED', 'stored auth cipher could not be decrypted with this deployment key');
      }
      if (decrypted === null) {
        // Wrong key, tampered tag, or a non-cipher shape: the same answer.
        throw denial(500, 'AUTH_DECRYPT_FAILED', 'stored auth cipher could not be decrypted with this deployment key');
      }
      const config = decrypted.config;

      // The snapshot flag said "configured"; a config that carries nothing is
      // a mismatch between the pin and the row, never a silent no-auth.
      if (!fileUrlAuthConfigCarriesSecret(config)) {
        throw denial(422, 'AUTH_CONFIG_MISSING', 'pinned auth config carries no usable secret');
      }

      switch (config.type) {
        case 'query':
          // Δ2 — deliberate: a raw secret never travels in a URL query.
          throw denial(
            422,
            'QUERY_AUTH_FORBIDDEN',
            'URL-query credentials are forbidden for source acquisition; re-save the profile with a header or bearer slot'
          );
        case 'bearer': {
          const token = config.token?.trim();
          if (!token) {
            throw denial(422, 'AUTH_CONFIG_MISSING', 'pinned bearer auth has no token');
          }
          return { kind: 'bearer', token };
        }
        case 'header': {
          const headerName = config.header_name?.trim();
          const headerValue = config.header_value;
          if (!headerName || !headerValue) {
            throw denial(422, 'AUTH_CONFIG_MISSING', 'pinned header auth is missing its name or value');
          }
          return { kind: 'header', headerName, headerValue };
        }
        case 'none':
          // Unreachable after the carries-secret check above.
          throw denial(422, 'AUTH_CONFIG_MISSING', 'pinned auth config carries no usable secret');
      }
    },
  };
}

/**
 * Wrap a fetcher so the resolved source credential rides ONLY requests to the
 * origin that answered the first (original) URL.
 *
 * The SDK acquisition loop re-invokes the same fetcher for every redirect hop
 * (redirects are manual and re-validated); forwarding the credential blindly
 * would leak it to any third-party host a `Location` header names. The
 * wrapper therefore pins the FIRST origin and omits the header on every hop
 * that leaves it — a deliberate redaction, not a fallback. Nothing here logs
 * or echoes the credential.
 */
export function withSourceAuth(
  fetcher: SdkFetcher,
  auth: Exclude<ResolvedSourceAuth, { kind: 'none' }>
): SdkFetcher {
  let originalOrigin: string | null = null;
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let origin: string | null = null;
    try {
      origin = new URL(href).origin;
    } catch {
      origin = null;
    }
    if (originalOrigin === null) originalOrigin = origin;
    if (origin === null || origin !== originalOrigin) {
      return fetcher(href, init);
    }
    const headers = new Headers(init?.headers);
    if (auth.kind === 'bearer') headers.set('authorization', `Bearer ${auth.token}`);
    else headers.set(auth.headerName, auth.headerValue);
    return fetcher(href, { ...init, headers });
  };
  return wrapped as SdkFetcher;
}
