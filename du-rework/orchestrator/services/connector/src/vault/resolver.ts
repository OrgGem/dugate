import {
  ConnectorCredentialSourceSchema,
  matchesVaultAccountPath,
  type ConnectorCredentialSource,
  type VaultAccountPathScope,
} from '@du/contracts';
import { ConnectorError } from '../errors';
import type { AdapterConfig } from '../types';

/**
 * VAULT-05 (tasks/SEC-OIDC-VAULT-2026-09-24.md, SEC-05): the SecretResolver
 * seam for the Connector. Two credential sources, one fail-closed contract:
 *
 *   - legacy-db  → the existing AES-GCM secret_versions path (unchanged
 *     behavior; kept explicit so nothing "heuristically" reroutes old data).
 *   - vault-kv2 → the machine-identity read of a validated, version-pinned ref
 *     (mount/path/key[/version]) through the VAULT-02 connector-reader
 *     policy. The reader interface below is satisfied by the dev fixture
 *     (tests/stubs/vault-dev-fixture) and, later, the real Vault client.
 *
 * Security contract (SEC-05):
 *   - missing key / revoked/destroyed version / any policy deny (403 class)
 *     → CREDENTIAL_INVALID thrown BEFORE any provider call.
 *   - Vault 5xx / timeout → bounded retries, then PROVIDER_UNAVAILABLE
 *     (safeToRetry) — NEVER a silent fallback to the legacy DB secret.
 *   - the resolved value is only ever returned to the caller; it is never
 *     logged, embedded in error messages, or persisted here.
 */

export interface VaultKv2SecretReader {
  /** Resolve data.data[key] for the immutable KV v2 version pin. */
  readSecret(input: { account: string; mount: string; path: string; key: string; version: number }): Promise<unknown>;
}

/** Failures a reader implementation must surface (see VaultError in tests). */
export interface VaultReaderFailure {
  code: string;
  retryable: boolean;
}

export type CredentialSource = ConnectorCredentialSource;

/**
 * Parse a persisted credential_source value. Missing/null and malformed
 * values fail closed. Existing rows become explicit legacy-db values in the
 * migration, so a broken migration can never silently select the DB secret.
 */
export function parseCredentialSource(value: unknown): CredentialSource {
  const parsed = ConnectorCredentialSourceSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConnectorError('CREDENTIAL_INVALID', 'Credential source is not valid.');
  }
  return parsed.data;
}

/**
 * Fail closed unless a Vault ref is pinned to the authenticated tenant and
 * trusted connector revision. With no tenantId this validates the persisted
 * ref's canonical connector/account path before it is accepted for storage.
 */
export function assertVaultAccountPrefix(
  source: Extract<CredentialSource, { kind: 'vault-kv2' }>,
  scope: VaultAccountPathScope,
): void {
  if (!matchesVaultAccountPath(source, scope)) {
    throw new ConnectorError('BINDING_DENIED', 'Vault credential account binding is invalid.');
  }
}

export interface LegacyCredentialStore {
  getActiveCredential(credentialRef: string): Promise<Uint8Array | undefined>;
}

export interface SecretResolverOptions {
  kv2?: VaultKv2SecretReader;
  legacy?: { store: LegacyCredentialStore; decrypt(value: Uint8Array): string };
  /** Bounded retry for retryable Vault failures (SEC-05 "retryable with bound"). */
  retry?: { maxAttempts?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> };
}

export interface ResolvedSecret {
  value: string;
  via: 'legacy-db' | 'vault-kv2';
  attempts: number;
}

function classifyReaderFailure(err: unknown): VaultReaderFailure {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    const code = String((err as { code: unknown }).code);
    const retryable = Boolean((err as { retryable?: unknown }).retryable === true);
    return { code, retryable };
  }
  // Unknown shape → NOT retryable: a reader we cannot reason about must
  // fail closed rather than hammer an endpoint that may be rejecting auth.
  return { code: 'VAULT_READER_ERROR', retryable: false };
}

export class SecretResolver {
  public constructor(private readonly opts: SecretResolverOptions) {}

  public async resolve(source: CredentialSource): Promise<ResolvedSecret> {
    if (source.kind === 'legacy-db') return this.resolveLegacy(source);
    return this.resolveVault(source);
  }

  /** Safe probe for management test(connectorId) — never throws. */
  public async probe(
    source: CredentialSource,
  ): Promise<{ ok: true } | { ok: false; errorCode: string }> {
    try {
      await this.resolve(source);
      return { ok: true };
    } catch (err) {
      if (err instanceof ConnectorError) return { ok: false, errorCode: err.code };
      return { ok: false, errorCode: 'CREDENTIAL_INVALID' };
    }
  }

  private async resolveLegacy(source: Extract<CredentialSource, { kind: 'legacy-db' }>): Promise<ResolvedSecret> {
    const legacy = this.opts.legacy;
    if (!legacy) {
      throw new ConnectorError('CREDENTIAL_INVALID', 'Legacy credential store is not configured.');
    }
    const stored = await legacy.store.getActiveCredential(source.credentialRef);
    if (!stored) throw new ConnectorError('CREDENTIAL_INVALID', 'Connector credential is not active.');
    return { value: legacy.decrypt(stored), via: 'legacy-db', attempts: 1 };
  }

  private async resolveVault(
    source: Extract<CredentialSource, { kind: 'vault-kv2' }>,
  ): Promise<ResolvedSecret> {
    const reader = this.opts.kv2;
    if (!reader) {
      // Fail closed: a vault-backed revision must NEVER fall back to the
      // legacy DB secret (SEC-05 explicit requirement).
      throw new ConnectorError('CREDENTIAL_INVALID', 'Vault reader not configured; legacy fallback forbidden.');
    }
    const requestedAttempts = this.opts.retry?.maxAttempts ?? 3;
    const maxAttempts = Number.isFinite(requestedAttempts)
      ? Math.max(1, Math.min(5, Math.floor(requestedAttempts)))
      : 3;
    const requestedDelayMs = this.opts.retry?.baseDelayMs ?? 100;
    const baseDelayMs = Number.isFinite(requestedDelayMs)
      ? Math.max(0, Math.min(1_000, Math.floor(requestedDelayMs)))
      : 100;
    const sleep = this.opts.retry?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const value = await reader.readSecret({
          account: source.account,
          mount: source.mount,
          path: source.path,
          key: source.key,
          version: source.version,
        });
        if (typeof value !== 'string' || value.length === 0) {
          // missing/empty field or non-string payload → hard invalid
          throw new ConnectorError('CREDENTIAL_INVALID', 'Vault secret field missing or not a non-empty string.');
        }
        return { value, via: 'vault-kv2', attempts: attempt };
      } catch (err) {
        if (err instanceof ConnectorError) {
          if (err.code === 'CREDENTIAL_INVALID') {
            throw new ConnectorError('CREDENTIAL_INVALID', 'Vault credential could not be resolved.');
          }
          throw err;
        }
        const f = classifyReaderFailure(err);
        if (!f.retryable) {
          throw new ConnectorError('CREDENTIAL_INVALID', 'Vault credential could not be resolved.');
        }
        if (attempt < maxAttempts) {
          await sleep(baseDelayMs * attempt);
        }
      }
    }
    throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Vault credential service is temporarily unavailable.', {
      safeToRetry: true,
    });
  }
}

/**
 * Provider credential slot (SEC-05: "chỉ đưa giá trị vào provider credential
 * slot đã duyệt… không hardcode Bearer cho mọi adapter"). Default 'bearer'
 * reproduces the historic withCredential() byte-for-byte so existing
 * adapters/tests are untouched.
 */
export function applyCredentialSlot(config: AdapterConfig, secret: string): AdapterConfig {
  const slot = config.credentialSlot;
  if (slot === undefined || slot === 'bearer' || slot === '') {
    return { ...config, headers: { ...(config.headers ?? {}), authorization: `Bearer ${secret}` } };
  }
  if (slot.startsWith('header:')) {
    const name = slot.slice('header:'.length).trim().toLowerCase();
    if (name.length > 0) {
      return { ...config, headers: { ...(config.headers ?? {}), [name]: secret } };
    }
  }
  throw new ConnectorError('INVALID_INPUT', 'Unsupported credentialSlot on connector config.');
}
