import type { VaultCredentialWriter, VaultRefFields } from './workflow';

/**
 * CREDWORKFLOW-IMPL (D1–D5): the production Vault KV v2 credential writer.
 *
 * Implements the `VaultCredentialWriter` port the credential workflow depends
 * on (`writeCas` → new version, `readVersions` → masked metadata), mirroring
 * BOTH the connector credential flow's pinned semantics (the mock harness
 * pins 412/403/5xx behavior) and the orchestrator's existing Vault HTTP
 * hygiene (`vault-transit-provider.ts`: token guard, `redirect:'error'`,
 * bounded response, typed failures).
 *
 * Failure contract (load-bearing): every rejection carries `{ code, retryable }`
 * so `workflow.refIssue` (`workflow.ts`) can map it to the typed HTTP answer —
 * CAS_CONFLICT → 409, CAPABILITY_DENIED/PREFIX_DENIED → 403,
 * retryable → 503, anything else → 502. No message ever contains the secret:
 * every throw is a fixed, value-free string.
 */

export type VaultKv2WriterErrorCode =
  | 'VAULT_NO_TOKEN'
  | 'CAS_CONFLICT'
  | 'CAPABILITY_DENIED'
  | 'PREFIX_DENIED'
  | 'VAULT_SERVER_ERROR'
  | 'VAULT_UNAVAILABLE'
  | 'VAULT_WRITE_FAILED'
  | 'VAULT_METADATA_FAILED';

export class VaultKv2WriterError extends Error {
  constructor(
    readonly code: VaultKv2WriterErrorCode,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'VaultKv2WriterError';
  }
}

export interface VaultKv2CredentialWriterOptions {
  /** Vault origin, e.g. https://vault.internal:8200. */
  vaultAddress: string;
  /** KV v2 mount name; default 'secret'. */
  kvMount?: string;
  /** Server-side machine identity for the orchestrator-writer policy. */
  token: () => string | Promise<string>;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_MOUNT = 'secret';
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

function fail(code: VaultKv2WriterErrorCode, retryable: boolean, message: string): never {
  throw new VaultKv2WriterError(code, retryable, message);
}

export function createVaultKv2CredentialWriter(
  options: VaultKv2CredentialWriterOptions,
): VaultCredentialWriter {
  if (!/^https?:\/\//.test(options.vaultAddress)) {
    throw new Error('vault kv2 writer requires an absolute http(s) vaultAddress');
  }
  const base = new URL(options.vaultAddress.replace(/\/+$/, '') + '/');
  const mount = options.kvMount ?? DEFAULT_MOUNT;
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(mount)) {
    throw new Error('vault kv2 writer requires a valid mount name');
  }

  const tokenOf = async (): Promise<string> => {
    let token: string;
    try {
      token = await options.token();
    } catch {
      return fail('VAULT_NO_TOKEN', false, 'vault identity is unavailable');
    }
    if (typeof token !== 'string' || token.trim() === '' || /[\r\n\u0000]/.test(token)) {
      fail('VAULT_NO_TOKEN', false, 'vault identity is unavailable');
    }
    return token;
  };

  const call = async (
    method: 'GET' | 'POST',
    suffix: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> => {
    const token = await tokenOf();
    const url = new URL(`v1/${encodeURIComponent(mount)}/${suffix}`, base);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)(url, {
        method,
        headers: { 'content-type': 'application/json', 'x-vault-token': token },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      // Network failure or timeout: the write may or may not have landed —
      // retryable so the caller surfaces 503 and reconcile owns the window.
      return fail('VAULT_UNAVAILABLE', true, 'vault request failed');
    } finally {
      clearTimeout(timer);
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      return fail('VAULT_UNAVAILABLE', true, 'vault response could not be read');
    }
    if (text.length > MAX_RESPONSE_BYTES) {
      return fail('VAULT_UNAVAILABLE', false, 'vault response exceeded the bound');
    }
    let json: Record<string, unknown> = {};
    if (text.length > 0) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          json = parsed as Record<string, unknown>;
        }
      } catch {
        json = {};
      }
    }
    return { status: response.status, json };
  };

  return {
    async writeCas(ref: VaultRefFields, value: string, cas?: number): Promise<number> {
      const res = await call('POST', `data/${ref.path}`, {
        data: { [ref.key]: value },
        ...(cas === undefined ? {} : { options: { cas } }),
      });
      if (res.status === 412) fail('CAS_CONFLICT', false, 'vault check-and-set conflict');
      if (res.status === 403) fail('CAPABILITY_DENIED', false, 'vault policy denied the credential write');
      if (res.status === 401) fail('VAULT_NO_TOKEN', false, 'vault identity rejected');
      if (res.status === 408 || res.status === 429 || res.status >= 500) {
        fail('VAULT_SERVER_ERROR', true, 'vault is unavailable');
      }
      if (res.status !== 200) fail('VAULT_WRITE_FAILED', false, 'vault rejected the credential write');
      const data = (res.json.data ?? {}) as { version?: unknown };
      const version = Number(data.version ?? 0);
      if (!Number.isSafeInteger(version) || version < 1) {
        // A 200 without a usable version is a broken store answer; treating it
        // as success would pin a revision to a version that does not exist.
        fail('VAULT_WRITE_FAILED', false, 'vault returned no credential version');
      }
      return version;
    },

    async readVersions(ref: VaultRefFields): Promise<{ current_version: number; versions: number[] }> {
      const res = await call('GET', `metadata/${ref.path}`);
      if (res.status === 403) fail('PREFIX_DENIED', false, 'vault policy denied the metadata read');
      if (res.status === 404) fail('VAULT_METADATA_FAILED', false, 'vault credential metadata not found');
      if (res.status === 408 || res.status === 429 || res.status >= 500) {
        fail('VAULT_SERVER_ERROR', true, 'vault is unavailable');
      }
      if (res.status !== 200) fail('VAULT_METADATA_FAILED', false, 'vault rejected the metadata read');
      const data = (res.json.data ?? {}) as { current_version?: unknown; versions?: unknown };
      const current = Number(data.current_version ?? 0);
      const versions = Array.isArray(data.versions) ? data.versions.map((v) => Number(v)) : [];
      if (!Number.isSafeInteger(current) || current < 0 || versions.some((v) => !Number.isSafeInteger(v) || v < 0)) {
        fail('VAULT_METADATA_FAILED', false, 'vault returned invalid credential metadata');
      }
      return { current_version: current, versions };
    },
  };
}
