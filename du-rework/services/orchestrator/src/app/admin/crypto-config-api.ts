/**
 * ENC-08 (tasks/APP-ENCRYPTION-2026-09-27.md): the Admin API for crypto
 * configuration - the allowlisted Vault storage key ref, the delivery-encryption
 * toggle, and the pinned recipient public key version, per tenant.
 *
 * Framework-free on purpose: it takes a principal, a store, a key lister and an audit
 * sink, and returns a view model. The HTTP route and the persistence adapter are
 * wired by the composition root (outside this packet's file scope - see the receipt's
 * delta), which is also what keeps every rule below offline-testable.
 *
 * The authorization model, stated once:
 *
 *   - Reads: platform may read any tenant; a tenant operator reads only its own.
 *   - Mutations are cookie- or bearer-authenticated ADMIN actions, so a cookie caller
 *     must also present the server-derived CSRF token (ADM-BASE-02). A `viewer`
 *     session may read and may not write.
 *   - Choosing the Vault storage key ref is PLATFORM-ONLY. It decides which Transit
 *     key wraps the tenant's DEKs - infrastructure, not a tenant preference.
 *   - The delivery toggle and the recipient key pin are tenant-scoped: an operator may
 *     only change its own tenant, and a foreign tenant is 403 with identical wording.
 *
 * Fail-closed by construction: a ref outside the allowlist, a version that is not
 * registered for the tenant, and a version that has been revoked are all refused. The
 * handler never accepts a key id, a suite, or a key blob from the caller - the pin is a
 * VERSION NUMBER the server resolves through the ENC-06 registry.
 */

import { HttpError } from '../../http/errors';
import {
  resolveAdminPrincipal,
  validateCsrfToken,
  type AdminCredentialConfig,
  type AdminPrincipal,
  type ShellRole,
} from '../../modules/admin-actions/rbac';
import type { AuditRecordInput } from '../../modules/audit/audit';
import type { RecipientPublicKeyRecord } from '../../modules/encryption/recipient-key-registry';
import {
  buildCryptoConfigView,
  EMPTY_CRYPTO_CONFIG,
  type CryptoConfigViewModel,
  type RecipientKeyOption,
} from './crypto-config-view-models';

type CryptoConfigState = import('./crypto-config-view-models').CryptoConfigState;
export type { CryptoConfigState };

/** Persistence port. PostgresCryptoConfigStore implements it for durable deployments. */
export interface CryptoConfigStore {
  get(tenantId: string): Promise<CryptoConfigState>;
  set(tenantId: string, next: CryptoConfigState): Promise<CryptoConfigState>;
}

/** Read port over the ENC-06 registry, reduced to what the pane may show. */
export interface RecipientKeyLister {
  listRecipientKeys(tenantId: string): Promise<RecipientKeyOption[]>;
}

/** Audit port. `AuditService` from modules/audit satisfies it structurally. */
export interface CryptoConfigAudit {
  record(input: AuditRecordInput): Promise<unknown>;
}

/**
 * Project ENC-06 records onto the pane's option shape. A record whose tenant does not
 * match is DROPPED rather than rendered: the pane must never offer another tenant's
 * key, and a repository that leaks rows is a bug we refuse to paper over.
 */
export function recipientKeyOptions(
  records: readonly RecipientPublicKeyRecord[],
  tenantId: string,
): RecipientKeyOption[] {
  return records
    .filter((record) => record.tenantId === tenantId)
    .map((record) => ({
      version: record.version,
      fingerprint: record.fingerprint,
      revokedAt: record.revokedAt,
      effectiveAt: record.effectiveAt,
    }));
}

export interface CryptoConfigServiceOptions {
  /** Platform-allowlisted Vault Transit key refs. Never the Transit key names. */
  readonly allowedKeyRefs: readonly string[];
  readonly store: CryptoConfigStore;
  readonly keys: RecipientKeyLister;
  readonly audit: CryptoConfigAudit;
  /** Stable actor label per principal kind. NEVER a token or session id. */
  readonly actorLabels?: Readonly<Record<'platform' | 'tenant_operator', string>>;
}

export interface CryptoConfigAuth {
  /** Bearer principal from the admin credential tables, or null. */
  readonly principal: AdminPrincipal | null;
  /** Present for the cookie shell surface. */
  readonly cookieRole?: ShellRole;
  /** Presented CSRF token; verified against the session cookie with the server secret. */
  readonly csrfToken?: string;
  /** Shell cookie secret, needed to derive the expected CSRF token. */
  readonly cookieSecret?: string;
  /** The session cookie value presented by the browser. */
  readonly sessionCookie?: string;
}

export interface CryptoConfigReadRequest {
  readonly auth: CryptoConfigAuth;
  /** Tenant whose configuration is requested. Empty/absent = the caller's own tenant. */
  readonly tenantId?: string;
}

export interface CryptoConfigMutation {
  /** null = no app-managed storage key for this tenant. */
  readonly storageKeyRef?: string | null;
  readonly deliveryEncryption?: boolean;
  /** null = follow the current active key. */
  readonly recipientKeyVersion?: number | null;
}

export interface CryptoConfigWriteRequest extends CryptoConfigReadRequest {
  readonly mutation: CryptoConfigMutation;
}

function requirePrincipal(auth: CryptoConfigAuth): AdminPrincipal {
  if (!auth.principal) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'admin credentials are required');
  }
  return auth.principal;
}

/**
 * Cookie-authenticated writers must prove the CSRF binding; bearer writers carry the
 * credential in the header, which a cross-site page cannot send.
 */
function requireWriteAuth(auth: CryptoConfigAuth, isMutation: boolean): AdminPrincipal {
  const principal = requirePrincipal(auth);
  if (!isMutation || principal.role === 'platform') return principal;
  if (auth.cookieRole === undefined) return principal;
  if (auth.cookieRole === 'viewer') {
    throw new HttpError(403, 'PERMISSION_DENIED', 'this session may read but not change crypto configuration');
  }
  if (!validateCsrfToken({
    secret: auth.cookieSecret,
    sessionCookie: auth.sessionCookie,
    provided: auth.csrfToken,
  })) {
    throw new HttpError(403, 'PERMISSION_DENIED', 'missing or invalid CSRF proof');
  }
  return principal;
}

/**
 * Resolve the tenant a request may act on. A platform caller may name any tenant; a
 * tenant operator is pinned to its own, and the wording is identical for every foreign
 * id so the response cannot be used to probe which tenants exist.
 */
function resolveTargetTenant(principal: AdminPrincipal, requested: string | undefined): string {
  const wanted = typeof requested === 'string' ? requested : '';
  if (principal.role === 'platform') {
    if (!wanted) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId is required');
    }
    return wanted;
  }
  if (wanted && wanted !== principal.tenantId) {
    throw new HttpError(403, 'PERMISSION_DENIED', 'crypto configuration is scoped to the caller tenant');
  }
  return principal.tenantId;
}

function actorFor(
  principal: AdminPrincipal,
  labels: CryptoConfigServiceOptions['actorLabels'] | undefined,
): string {
  const fallback = principal.role === 'platform' ? 'admin:platform' : 'admin:tenant_operator';
  return labels?.[principal.role] ?? fallback;
}

function assertTenantId(tenantId: string): string {
  if (typeof tenantId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(tenantId)) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId is invalid');
  }
  return tenantId;
}

/**
 * Validate the storage key ref against the platform allowlist. The form only offers
 * allowlisted refs, so a hand-typed POST of anything else is exactly the case this
 * check exists for.
 */
function validateKeyRef(ref: string | null, allowed: readonly string[]): string | null {
  if (ref === null || ref === '') return null;
  if (typeof ref !== 'string' || !allowed.includes(ref)) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'storage key ref is not allowlisted');
  }
  return ref;
}

/**
 * Validate a requested pin. The version must be one the TENANT actually registered and
 must not be revoked: pinning a revoked version would configure delivery that ENC-07
 then fails closed at request time, which is a worse outcome than refusing to save it.
 */
function validatePin(version: number | null, keys: readonly RecipientKeyOption[]): number | null {
  if (version === null) return null;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'recipient key version is invalid');
  }
  const match = keys.find((key) => key.version === version);
  if (!match) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'recipient key version is not registered for this tenant');
  }
  if (match.revokedAt !== null) {
    throw new HttpError(409, 'STATE_CONFLICT', 'recipient key version is revoked');
  }
  return version;
}

/** Read the tenant's crypto configuration and its view model. */
export async function readCryptoConfig(
  options: CryptoConfigServiceOptions,
  request: CryptoConfigReadRequest,
): Promise<CryptoConfigViewModel> {
  const principal = requirePrincipal(request.auth);
  const tenantId = assertTenantId(resolveTargetTenant(principal, request.tenantId));
  const [state, records] = await Promise.all([
    options.store.get(tenantId),
    options.keys.listRecipientKeys(tenantId),
  ]);
  return buildCryptoConfigView({
    tenantId,
    state: state ?? EMPTY_CRYPTO_CONFIG,
    allowedKeyRefs: options.allowedKeyRefs,
    recipientKeys: records,
  });
}

/** What one accepted mutation changed - the audit record names the field, not its value. */
export interface CryptoConfigChange {
  readonly tenantId: string;
  readonly fields: readonly string[];
}

const AUDIT_ACTIONS: Readonly<Record<string, string>> = {
  storageKeyRef: 'crypto_config.storage_key_ref.set',
  deliveryEncryption: 'crypto_config.delivery_encryption.set',
  recipientKeyVersion: 'crypto_config.recipient_key_pin.set',
};

/**
 * Apply a crypto configuration change.
 *
 * The order of the checks is the point. Authorization first (so an unauthorized caller
 * learns nothing about the tenant's configuration), then validation against the
 * allowlist and the tenant's own registered keys, then the store, then the audit row.
 * A change that would switch delivery ON for a tenant with no usable recipient key is
 * refused rather than saved: ENC-07 would answer 503 for every delivery, and a setting
 * that is broken the moment it is turned on is worse than a refusal with a reason.
 */
export async function applyCryptoConfig(
  options: CryptoConfigServiceOptions,
  request: CryptoConfigWriteRequest,
): Promise<{ view: CryptoConfigViewModel; change: CryptoConfigChange }> {
  const principal = requireWriteAuth(request.auth, true);
  const tenantId = assertTenantId(resolveTargetTenant(principal, request.tenantId));
  const mutation = request.mutation ?? {};
  const changingKeyRef = mutation.storageKeyRef !== undefined;
  if (changingKeyRef && principal.role !== 'platform') {
    throw new HttpError(403, 'PERMISSION_DENIED', 'choosing the storage key ref is a platform action');
  }
  const keys = await options.keys.listRecipientKeys(tenantId);
  const current = (await options.store.get(tenantId)) ?? EMPTY_CRYPTO_CONFIG;
  const next: CryptoConfigState = {
    storageKeyRef: changingKeyRef
      ? validateKeyRef(mutation.storageKeyRef ?? null, options.allowedKeyRefs)
      : current.storageKeyRef,
    deliveryEncryption:
      typeof mutation.deliveryEncryption === 'boolean'
        ? mutation.deliveryEncryption
        : current.deliveryEncryption,
    pinnedRecipientKeyVersion:
      mutation.recipientKeyVersion !== undefined
        ? validatePin(mutation.recipientKeyVersion, keys)
        : current.pinnedRecipientKeyVersion,
  };
  const nextPin = next.pinnedRecipientKeyVersion;
  const pinUsable =
    nextPin === null ||
    keys.some((key) => key.version === nextPin && key.revokedAt === null);
  if (next.deliveryEncryption && !pinUsable) {
    throw new HttpError(409, 'STATE_CONFLICT', 'no usable recipient public key for this tenant');
  }
  const usableKeyExists = keys.some((key) => key.revokedAt === null);
  if (next.deliveryEncryption && !usableKeyExists) {
    throw new HttpError(409, 'STATE_CONFLICT', 'no usable recipient public key for this tenant');
  }
  const fields: string[] = [];
  if (next.storageKeyRef !== current.storageKeyRef) fields.push('storageKeyRef');
  if (next.deliveryEncryption !== current.deliveryEncryption) fields.push('deliveryEncryption');
  if (next.pinnedRecipientKeyVersion !== current.pinnedRecipientKeyVersion) {
    fields.push('recipientKeyVersion');
  }
  const saved = await options.store.set(tenantId, next);
  for (const field of fields) {
    await options.audit.record({
      tenantId,
      actor: actorFor(principal, options.actorLabels),
      action: AUDIT_ACTIONS[field] ?? 'crypto_config.update',
      resource: 'tenant:' + tenantId,
      severity: 'success',
    });
  }
  return {
    view: buildCryptoConfigView({
      tenantId,
      state: saved,
      allowedKeyRefs: options.allowedKeyRefs,
      recipientKeys: keys,
    }),
    change: { tenantId, fields },
  };
}

/**
 * Build the handler that turns an HTTP-ish request into the pane, so the shell can
 * render the section without this module knowing anything about HTML transport.
 */
export function cryptoConfigPane(options: CryptoConfigServiceOptions, request: CryptoConfigReadRequest) {
  return readCryptoConfig(options, request)
    .then((view) => ({ status: 'ready' as const, view }))
    .catch((error: unknown) => {
      if (error instanceof HttpError && error.status === 401) {
        return { status: 'unauthorized' as const };
      }
      if (error instanceof HttpError && error.status === 404) {
        return { status: 'not-found' as const };
      }
      return {
        status: 'error' as const,
        code: error instanceof HttpError ? error.code : 'UNAVAILABLE',
      };
    });
}

/** Resolve the bearer principal for a request header against the admin credential config. */
export function principalForRequest(
  config: AdminCredentialConfig,
  authorization: string | undefined,
): AdminPrincipal | null {
  return resolveAdminPrincipal(config, authorization);
}
