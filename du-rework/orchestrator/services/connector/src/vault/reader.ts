import { VaultKv2RefSchema } from '@du/contracts';
import type { VaultKv2SecretReader } from './resolver';
import type { RenewalDaemon } from './token-renewal';

/**
 * SC-02 (SECRET-CATALOG-20261006) — the production Vault KV v2 reader.
 *
 * Implements the `VaultKv2SecretReader` port with the same HTTP hygiene as the
 * existing Vault client paths (orchestrator `vault-kv2-writer.ts`,
 * `vault-transit-provider.ts`): token guard, no redirects, bounded response,
 * typed `{ code, retryable }` failures, and value-free error text.
 *
 * Security invariants:
 * - Every ref is validated with `VaultKv2RefSchema` (traversal / encoded
 *   separators / whitespace / over-long segments fail BEFORE any HTTP call)
 *   and must additionally sit inside one of the configured
 *   mount + path-prefix scopes (defense in depth on top of the runtime's
 *   revision-binding check).
 * - The token is obtained from a provider (the renewal daemon's live lease in
 *   production); no live lease → `VAULT_UNAUTHENTICATED` (non-retryable) and
 *   NO request is sent. There is no static/plaintext fallback.
 * - The resolved value is returned to the caller only. Error messages never
 *   carry tokens or values.
 * - KV v2 read is `GET /v1/{mount}/data/{path}?version=N`; `version` is always
 *   a pin here (the resolver only ever receives version-pinned sources).
 */

export type VaultReaderErrorCode =
  | 'VAULT_UNAUTHENTICATED'
  | 'VAULT_SCOPE_DENIED'
  | 'VAULT_NOT_FOUND'
  | 'VAULT_PERMISSION_DENIED'
  | 'VAULT_BAD_REQUEST'
  | 'VAULT_SERVER_ERROR'
  | 'VAULT_TRANSPORT'
  | 'VAULT_INVALID_RESPONSE';

export class VaultReaderError extends Error {
  public constructor(
    public readonly code: VaultReaderErrorCode,
    public readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'VaultReaderError';
  }
}

export interface VaultPrefixScopeLike {
  mount: string;
  pathPrefix: string;
}

export interface VaultKv2HttpReaderOptions {
  /** Vault origin, e.g. https://vault.internal:8200. */
  address: string;
  /** Optional Vault Enterprise namespace header. */
  namespace?: string;
  /** Mount + path-prefix scopes this reader is allowed to touch. */
  allowedScopes: readonly VaultPrefixScopeLike[];
  /** Live token supplier (renewal daemon lease); undefined => fail closed. */
  token: () => string | undefined | null;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

function fail(code: VaultReaderErrorCode, retryable: boolean, message: string): never {
  throw new VaultReaderError(code, retryable, message);
}

function assertOrigin(address: string): URL {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error('vault kv2 reader requires an absolute http(s) vaultAddress');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('vault kv2 reader requires an absolute http(s) vaultAddress');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('vault kv2 reader requires a clean vaultAddress (no userinfo/query/fragment)');
  }
  return url;
}

function inScope(scope: VaultPrefixScopeLike, mount: string, path: string): boolean {
  if (scope.mount !== mount) return false;
  if (path === scope.pathPrefix) return true;
  return path.startsWith(scope.pathPrefix.endsWith('/') ? scope.pathPrefix : scope.pathPrefix + '/');
}

/** Path segments re-encoded individually so no segment can smuggle a slash. */
function encodePath(path: string): string {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function mapStatus(status: number): VaultReaderErrorCode {
  if (status === 400) return 'VAULT_BAD_REQUEST';
  if (status === 403) return 'VAULT_PERMISSION_DENIED';
  if (status === 404) return 'VAULT_NOT_FOUND';
  if (status === 429 || status >= 500) return 'VAULT_SERVER_ERROR';
  return 'VAULT_INVALID_RESPONSE';
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function createVaultKv2HttpReader(options: VaultKv2HttpReaderOptions): VaultKv2SecretReader {
  const base = assertOrigin(options.address);
  if (typeof options.token !== 'function') {
    throw new Error('vault kv2 reader requires a token supplier');
  }
  if (!Array.isArray(options.allowedScopes) || options.allowedScopes.length === 0) {
    throw new Error('vault kv2 reader requires at least one allowed mount/path scope');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const namespace = options.namespace;

  return {
    async readSecret(input: { account: string; mount: string; path: string; key: string; version: number }): Promise<unknown> {
      const parsed = VaultKv2RefSchema.safeParse({
        account: input.account,
        mount: input.mount,
        path: input.path,
        key: input.key,
        version: input.version,
      });
      if (!parsed.success) fail('VAULT_BAD_REQUEST', false, 'vault ref is invalid');
      const ref = parsed.data;
      if (!options.allowedScopes.some((scope) => inScope(scope, ref.mount, ref.path))) {
        fail('VAULT_SCOPE_DENIED', false, 'vault ref is outside the configured scopes');
      }
      const rawToken = options.token();
      if (typeof rawToken !== 'string' || rawToken.trim().length === 0 || /[\r\n\u0000]/.test(rawToken)) {
        // No live lease: never issue the request with a stale/absent identity
        // and never fall back to any other credential source.
        fail('VAULT_UNAUTHENTICATED', false, 'vault identity is unavailable');
      }
      const url = new URL(
        `v1/${encodeURIComponent(ref.mount)}/data/${encodePath(ref.path)}`,
        base,
      );
      url.searchParams.set('version', String(ref.version));
      const headers: Record<string, string> = { 'x-vault-token': rawToken, accept: 'application/json' };
      if (namespace !== undefined) headers['x-vault-namespace'] = namespace;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await (options.fetchImpl ?? fetch)(url.toString(), {
          method: 'GET',
          headers,
          redirect: 'error',
          signal: controller.signal,
        });
      } catch {
        fail('VAULT_TRANSPORT', true, 'vault request failed');
      } finally {
        clearTimeout(timer);
      }
      let text: string;
      try {
        text = await response.text();
      } catch {
        fail('VAULT_TRANSPORT', true, 'vault response could not be read');
      }
      if (response.status !== 200) {
        const code = mapStatus(response.status);
        fail(code, isRetryableStatus(response.status), 'vault denied the read');
      }
      if (Buffer.byteLength(text, 'utf8') > maxResponseBytes) {
        fail('VAULT_INVALID_RESPONSE', false, 'vault response exceeded the bound');
      }
      let body: unknown;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        fail('VAULT_INVALID_RESPONSE', false, 'vault response is not valid JSON');
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        fail('VAULT_INVALID_RESPONSE', false, 'vault response is not a JSON object');
      }
      const data = (body as Record<string, unknown>)['data'];
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        fail('VAULT_INVALID_RESPONSE', false, 'vault response carries no data object');
      }
      const fields = (data as Record<string, unknown>)['data'];
      if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
        // A KV v1-shaped or non-KV response must never be interpreted as a hit.
        fail('VAULT_NOT_FOUND', false, 'vault path is not a KV v2 data record');
      }
      const value = (fields as Record<string, unknown>)[ref.key];
      if (value === undefined) fail('VAULT_NOT_FOUND', false, 'vault field is not present');
      return value;
    },
  };
}

/**
 * Reader bound to the token renewal daemon: every read requires a live lease
 * from `daemon.current()`; the daemon's fail-closed policy (undefined while
 * retrying/unauthenticated) therefore gates Vault access without any cached
 * plaintext fallback.
 */
export function createDaemonBackedVaultKv2Reader(deps: {
  daemon: RenewalDaemon;
  reader: VaultKv2SecretReader;
}): VaultKv2SecretReader {
  return {
    readSecret: async (input) => {
      const live = deps.daemon.current();
      if (!live) fail('VAULT_UNAUTHENTICATED', false, 'vault identity is unavailable');
      return deps.reader.readSecret(input);
    },
  };
}
