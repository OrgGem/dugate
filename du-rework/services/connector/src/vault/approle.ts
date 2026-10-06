import type { RenewalToken, VaultTokenClient } from './token-renewal';

/**
 * SC-02 — AppRole machine identity for the Vault KV v2 reader.
 *
 * Implements the `VaultTokenClient` port the renewal daemon drives:
 *   login  → POST /v1/auth/{mount}/login {role_id, secret_id}
 *   renew  → POST /v1/auth/token/renew-self (renewable leases only)
 *
 * Contracts:
 * - AppRole login rejection (400/403) throws non-retryable; the daemon counts
 *   failures and eventually reports UNAUTHENTICATED (fail closed).
 * - `renew` returning null (400/403 on renew-self) tells the daemon the lease
 *   is not renewable → immediate re-login. Transport/5xx are thrown so the
 *   daemon can keep a still-valid token and back off.
 * - Response parsing is bounded; `client_token`/`lease_duration` are validated.
 *   Error text never carries the token, secret_id or response body.
 * - No redirects; the secret ride in the body/headers only.
 */

export type VaultAuthErrorCode = 'VAULT_TRANSPORT' | 'VAULT_AUTH_REJECTED' | 'VAULT_RESPONSE_INVALID';

export class VaultAuthError extends Error {
  public constructor(
    public readonly code: VaultAuthErrorCode,
    public readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'VaultAuthError';
  }
}

export interface AppRoleTokenClientOptions {
  /** Vault origin, e.g. https://vault.internal:8200. */
  address: string;
  namespace?: string;
  roleId: string;
  secretId: string;
  /** Auth mount, default 'approle'. */
  mountPath?: string;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_CREDENTIAL_LENGTH = 4096;

function fail(code: VaultAuthErrorCode, retryable: boolean, message: string): never {
  throw new VaultAuthError(code, retryable, message);
}

function assertSecret(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > MAX_CREDENTIAL_LENGTH
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error('vault approle ' + label + ' is invalid');
  }
  return value;
}

export function createAppRoleTokenClient(options: AppRoleTokenClientOptions): VaultTokenClient {
  let base: URL;
  try {
    base = new URL(options.address);
  } catch {
    throw new Error('vault approle requires an absolute http(s) vaultAddress');
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new Error('vault approle requires an absolute http(s) vaultAddress');
  }
  if (base.username || base.password || base.search || base.hash) {
    throw new Error('vault approle requires a clean vaultAddress (no userinfo/query/fragment)');
  }
  const roleId = assertSecret(options.roleId, 'role_id');
  const secretId = assertSecret(options.secretId, 'secret_id');
  const mountPath = options.mountPath ?? 'approle';
  if (!/^[a-z0-9][a-z0-9._/-]{0,63}$/i.test(mountPath) || mountPath.includes('..')) {
    throw new Error('vault approle mount path is invalid');
  }
  const namespace = options.namespace;
  const fetchImpl = options.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const now = options.now ?? Date.now;

  const call = async (
    path: string,
    body: Record<string, unknown>,
    token?: string,
  ): Promise<{ status: number; json: Record<string, unknown> }> => {
    const url = new URL('v1/' + path, base);
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (namespace !== undefined) headers['x-vault-namespace'] = namespace;
    if (token !== undefined) headers['x-vault-token'] = token;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      fail('VAULT_TRANSPORT', true, 'vault auth request failed');
    } finally {
      clearTimeout(timer);
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      fail('VAULT_TRANSPORT', true, 'vault auth response could not be read');
    }
    if (Buffer.byteLength(text, 'utf8') > maxResponseBytes) {
      fail('VAULT_RESPONSE_INVALID', false, 'vault auth response exceeded the bound');
    }
    let json: Record<string, unknown> = {};
    if (text.length > 0) {
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          fail('VAULT_RESPONSE_INVALID', false, 'vault auth response is not a JSON object');
        }
        json = parsed as Record<string, unknown>;
      } catch (error) {
        if (error instanceof VaultAuthError) throw error;
        fail('VAULT_RESPONSE_INVALID', false, 'vault auth response is not valid JSON');
      }
    }
    return { status: response.status, json };
  };

  const parseLease = (json: Record<string, unknown>): RenewalToken => {
    const auth = json['auth'];
    if (auth === null || typeof auth !== 'object' || Array.isArray(auth)) {
      fail('VAULT_RESPONSE_INVALID', false, 'vault auth response carries no auth object');
    }
    const record = auth as Record<string, unknown>;
    const token = record['client_token'];
    const leaseSeconds = record['lease_duration'];
    if (
      typeof token !== 'string'
      || token.length < 1
      || token.length > MAX_CREDENTIAL_LENGTH
      || /[\u0000-\u001f\u007f]/.test(token)
    ) {
      fail('VAULT_RESPONSE_INVALID', false, 'vault auth response carries no usable client token');
    }
    if (typeof leaseSeconds !== 'number' || !Number.isFinite(leaseSeconds) || leaseSeconds <= 0) {
      fail('VAULT_RESPONSE_INVALID', false, 'vault auth response carries no usable lease');
    }
    return { value: token, expiresAtMs: now() + Math.floor(leaseSeconds) * 1000 };
  };

  return {
    async login(): Promise<RenewalToken> {
      const { status, json } = await call('auth/' + mountPath + '/login', {
        role_id: roleId,
        secret_id: secretId,
      });
      if (status === 400 || status === 403) {
        // Wrong/expired AppRole credentials: deterministic, not retryable.
        fail('VAULT_AUTH_REJECTED', false, 'vault approle login was rejected');
      }
      if (status !== 200) {
        fail('VAULT_TRANSPORT', status === 429 || status >= 500, 'vault approle login failed');
      }
      return parseLease(json);
    },

    async renew(token: RenewalToken): Promise<RenewalToken | null> {
      const { status, json } = await call('auth/token/renew-self', {}, token.value);
      if (status === 400 || status === 403 || status === 404) {
        // The lease is gone/not renewable: rotate via a fresh login.
        return null;
      }
      if (status !== 200) {
        fail('VAULT_TRANSPORT', status === 429 || status >= 500, 'vault token renewal failed');
      }
      return parseLease(json);
    },
  };
}
