/**
 * SC-02 (SECRET-CATALOG-20261006) — runtime secret resolver for the platform
 * control plane (Orchestrator).
 *
 * Resolves a typed secret REFERENCE to a value for one authenticated purpose:
 *
 *   managed_value     → the value is an AES-GCM envelope stored by the
 *                       catalog; the injected decryptor opens it. The
 *                       resolver never sees or handles key material.
 *   vault_reference   → a KV v2 link (mount/path/field[/version], optional
 *                       namespace) read through an injected reader; the link
 *                       must stay inside this tenant's canonical prefix.
 *
 * Isolation and fail-closed rules (SC-02 acceptance):
 * - tenant: the reference's tenant MUST equal the caller's authenticated
 *   tenant; anything else is TENANT_MISMATCH (no store/reader call).
 * - purpose: the reference lists the purposes it may serve; resolving for a
 *   different purpose is PURPOSE_DENIED.
 * - state: only ACTIVE references resolve; DISABLED/REVOKED fail closed.
 * - vault path: mount must be allowlisted and the path must be exactly
 *   `<prefix>/tenants/<tenantId>/...`; foreign-tenant or out-of-prefix links
 *   are denied BEFORE any reader call. Namespace allowlist is enforced when
 *   configured; `version` is required unless the deployment explicitly allows
 *   latest reads.
 * - cache: bounded in-process TTL keyed by tenant + secretId + revision.
 *   Rotation bumps the revision (new key) and `invalidate(secretId)` drops
 *   every cached generation; revoke/disable therefore stops future resolves.
 * - never a plaintext fallback: a missing store/reader, decryptor failure or
 *   outage surfaces as a typed error, never as an empty/literal value.
 * - error messages never carry secret values, paths or key material.
 */

export type SecretProvider = 'managed_value' | 'vault_reference';
export type SecretState = 'ACTIVE' | 'DISABLED' | 'REVOKED';

export interface SecretReferenceCommon {
  secretId: string;
  tenantId: string;
  /** Purposes (services/features) this reference may be resolved for. */
  purposes: readonly string[];
  state: SecretState;
  /** Monotonic revision; rotation/disable bumps it. Cache key material. */
  revision: number;
}

export interface ManagedValueReference extends SecretReferenceCommon {
  provider: 'managed_value';
  /** Opaque AES-GCM envelope produced by the catalog writer. */
  ciphertext: unknown;
}

export interface VaultReference extends SecretReferenceCommon {
  provider: 'vault_reference';
  mount: string;
  path: string;
  field: string;
  /** KV v2 version pin. undefined = latest (only when explicitly allowed). */
  version?: number;
  namespace?: string;
}

export type RuntimeSecretReference = ManagedValueReference | VaultReference;

export interface SecretResolveContext {
  /** Authenticated tenant of the caller (must match the reference). */
  tenantId: string;
  /** Fixed purpose key of the consuming feature, e.g. 'connector-credential'. */
  purpose: string;
}

export interface ManagedValueDecryptor {
  /** Open the stored envelope; throws on tamper/wrong key/outage. */
  decrypt(input: { reference: ManagedValueReference }): Promise<string>;
}

export interface VaultReferenceReader {
  read(input: {
    mount: string;
    path: string;
    field: string;
    version?: number;
    namespace?: string;
  }): Promise<string>;
}

export type SecretResolutionErrorCode =
  | 'INVALID_REFERENCE'
  | 'TENANT_MISMATCH'
  | 'PURPOSE_DENIED'
  | 'SECRET_UNAVAILABLE'
  | 'VERSION_REQUIRED'
  | 'MOUNT_DENIED'
  | 'PATH_DENIED'
  | 'NAMESPACE_DENIED'
  | 'RESOLVE_FAILED';

/** Typed, secret-free failure. */
export class SecretResolutionError extends Error {
  public constructor(
    public readonly code: SecretResolutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SecretResolutionError';
  }
}

export interface RuntimeSecretResolverOptions {
  decryptManagedValue: ManagedValueDecryptor;
  /** Required only when vault_reference entries exist. */
  readVaultReference?: VaultReferenceReader;
  /** Allowlisted KV mounts; required for vault_reference. */
  allowedMounts?: readonly string[];
  /** Allowed path roots, e.g. ['du']. Tenant path is appended. Default ['du']. */
  allowedPathRoots?: readonly string[];
  /** Allowlisted Vault namespaces; when set, refs must name a listed one. */
  allowedNamespaces?: readonly string[];
  /** Default false: version pin required on every vault_reference. */
  allowLatestVersion?: boolean;
  /** Cache TTL. 0 disables caching. Default 30 s. */
  cacheTtlMs?: number;
  now?: () => number;
  /** Hard bound on a resolved value. Default 8192 chars. */
  maxValueLength?: number;
}

export interface RuntimeSecretResolver {
  /** Resolve one reference for an authenticated tenant/purpose. */
  resolve(reference: RuntimeSecretReference, context: SecretResolveContext): Promise<string>;
  /** Safe availability probe: never returns the value. */
  probe(reference: RuntimeSecretReference, context: SecretResolveContext): Promise<{ ok: true } | { ok: false; errorCode: SecretResolutionErrorCode }>;
  /** Drop every cached generation of a secret (rotation/revocation). */
  invalidate(secretId: string): void;
  invalidateAll(): void;
}

interface CachedValue {
  value: string;
  expiresAt: number;
}

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_MAX_VALUE_LENGTH = 8192;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(code: SecretResolutionErrorCode, message: string): never {
  throw new SecretResolutionError(code, message);
}

function assertCommon(reference: RuntimeSecretReference): void {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
    fail('INVALID_REFERENCE', 'secret reference is not an object');
  }
  if (typeof reference.secretId !== 'string' || reference.secretId.length < 1 || reference.secretId.length > 256) {
    fail('INVALID_REFERENCE', 'secret reference id is invalid');
  }
  if (typeof reference.tenantId !== 'string' || reference.tenantId.length < 1 || reference.tenantId.length > 128) {
    fail('INVALID_REFERENCE', 'secret reference tenant is invalid');
  }
  if (!Array.isArray(reference.purposes) || reference.purposes.length < 1 || reference.purposes.length > 16) {
    fail('INVALID_REFERENCE', 'secret reference purpose list is invalid');
  }
  if (!Number.isSafeInteger(reference.revision) || reference.revision < 1) {
    fail('INVALID_REFERENCE', 'secret reference revision is invalid');
  }
  if (
    reference.state !== 'ACTIVE'
    && reference.state !== 'DISABLED'
    && reference.state !== 'REVOKED'
  ) {
    fail('INVALID_REFERENCE', 'secret reference state is invalid');
  }
}

function validateResolvedValue(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || value.includes('\u0000')) {
    fail('RESOLVE_FAILED', 'resolved secret is not a usable value');
  }
  return value;
}

export function createRuntimeSecretResolver(
  options: RuntimeSecretResolverOptions,
): RuntimeSecretResolver {
  if (!options?.decryptManagedValue || typeof options.decryptManagedValue.decrypt !== 'function') {
    throw new Error('runtime secret resolver requires a managed-value decryptor');
  }
  const readVaultReference = options.readVaultReference;
  const allowedMounts = options.allowedMounts ?? [];
  const allowedPathRoots = options.allowedPathRoots ?? ['du'];
  const allowedNamespaces = options.allowedNamespaces;
  const allowLatestVersion = options.allowLatestVersion === true;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const maxValueLength = options.maxValueLength ?? DEFAULT_MAX_VALUE_LENGTH;
  const cache = new Map<string, CachedValue>();

  const cacheKeyFor = (reference: RuntimeSecretReference): string =>
    reference.tenantId + ':' + reference.secretId + ':' + reference.revision;

  async function resolveVault(reference: VaultReference, tenantId: string): Promise<string> {
    if (!readVaultReference) {
      fail('RESOLVE_FAILED', 'vault references are not configured for this deployment');
    }
    if (!SEGMENT.test(reference.mount) || allowedMounts.length === 0 || !allowedMounts.includes(reference.mount)) {
      fail('MOUNT_DENIED', 'vault reference mount is not allowed');
    }
    if (
      reference.version !== undefined
      && (!Number.isSafeInteger(reference.version) || reference.version < 1)
    ) {
      fail('INVALID_REFERENCE', 'vault reference version is invalid');
    }
    if (reference.version === undefined && !allowLatestVersion) {
      fail('VERSION_REQUIRED', 'vault reference must pin an explicit version');
    }
    if (allowedNamespaces !== undefined) {
      if (reference.namespace === undefined || !allowedNamespaces.includes(reference.namespace)) {
        fail('NAMESPACE_DENIED', 'vault reference namespace is not allowed');
      }
    }
    const segments = reference.path.split('/');
    if (
      segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..' || !SEGMENT.test(segment))
      || reference.path.includes('//')
    ) {
      fail('PATH_DENIED', 'vault reference path is invalid');
    }
    const tenantRoot = allowedPathRoots
      .map((root) => root + '/tenants/' + tenantId)
      .find((candidate) => reference.path === candidate || reference.path.startsWith(candidate + '/'));
    if (tenantRoot === undefined) {
      // The link must sit under THIS tenant's canonical prefix; foreign or
      // shared roots are refused before any reader call.
      fail('PATH_DENIED', 'vault reference path is outside the tenant prefix');
    }
    let value: unknown;
    try {
      value = await readVaultReference.read({
        mount: reference.mount,
        path: reference.path,
        field: reference.field,
        ...(reference.version === undefined ? {} : { version: reference.version }),
        ...(reference.namespace === undefined ? {} : { namespace: reference.namespace }),
      });
    } catch {
      fail('RESOLVE_FAILED', 'vault reference could not be resolved');
    }
    return validateResolvedValue(value, maxValueLength);
  }

  async function resolveFresh(reference: RuntimeSecretReference, context: SecretResolveContext): Promise<string> {
    if (reference.provider === 'managed_value') {
      let value: unknown;
      try {
        value = await options.decryptManagedValue.decrypt({ reference });
      } catch {
        fail('RESOLVE_FAILED', 'managed secret could not be decrypted');
      }
      return validateResolvedValue(value, maxValueLength);
    }
    return resolveVault(reference, context.tenantId);
  }

  async function resolve(
    reference: RuntimeSecretReference,
    context: SecretResolveContext,
  ): Promise<string> {
    assertCommon(reference);
    if (typeof context?.tenantId !== 'string' || typeof context.purpose !== 'string') {
      fail('INVALID_REFERENCE', 'secret resolve context is invalid');
    }
    if (reference.tenantId !== context.tenantId) {
      fail('TENANT_MISMATCH', 'secret reference belongs to a different tenant');
    }
    if (!reference.purposes.includes(context.purpose)) {
      fail('PURPOSE_DENIED', 'secret reference is not authorized for this purpose');
    }
    if (reference.state !== 'ACTIVE') {
      fail('SECRET_UNAVAILABLE', 'secret reference is disabled or revoked');
    }
    const key = cacheKeyFor(reference);
    const cached = cache.get(key);
    if (cached && now() < cached.expiresAt) return cached.value;
    const value = await resolveFresh(reference, context);
    if (cacheTtlMs > 0) {
      cache.set(key, { value, expiresAt: now() + cacheTtlMs });
    }
    return value;
  }

  return {
    resolve,
    async probe(reference, context) {
      try {
        await resolve(reference, context);
        return { ok: true };
      } catch (error) {
        if (error instanceof SecretResolutionError) return { ok: false, errorCode: error.code };
        return { ok: false, errorCode: 'RESOLVE_FAILED' };
      }
    },
    invalidate(secretId) {
      for (const key of cache.keys()) {
        if (key.split(':')[1] === secretId) cache.delete(key);
      }
    },
    invalidateAll() {
      cache.clear();
    },
  };
}
