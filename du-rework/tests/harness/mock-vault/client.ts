import http from 'node:http';
import type { RenewalToken, VaultTokenClient } from '../../../services/connector/src/vault/token-renewal';
import type { VaultCredentialWriter, VaultRefFields } from '../../../services/orchestrator/src/modules/connector-credentials/workflow';

/**
 * Non-pooled HTTP transport for the harness. Node's global fetch (undici)
 * keeps sockets alive; short-lived mock servers behind REUSED ephemeral
 * ports turn that pooling into cross-test bleed-through (a stale socket
 * lands on the NEW server, which legitimately 403s the unknown token).
 * Every harness call gets a fresh connection and no keep-alive.
 */
export function fetchNoPool(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: init.method ?? 'GET',
        headers: init.headers,
        agent: new http.Agent({ keepAlive: false }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

/** Response-shaped drop-in for the production adapter's fetchImpl option. */
export function noPoolFetchImpl(): typeof fetch {
  return (async (input: unknown, init?: { method?: unknown; headers?: Record<string, string>; body?: unknown }) => {
    const r = await fetchNoPool(String(input), {
      method: typeof init?.method === 'string' ? init.method : 'GET',
      headers: init?.headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return {
      status: r.status,
      text: async () => r.text,
      json: async () => JSON.parse(r.text) as unknown,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

/**
 * SEC-INT-01 harness client: speaks the mock-vault server's wire dialect and
 * exposes BOTH production seams —
 *   - VaultTokenClient for the renewal daemon (login/renew, 403/400 → null
 *     so the daemon takes its documented re-login path),
 *   - VaultCredentialWriter for the credential workflow (CAS write mapping
 *     412 → CAS_CONFLICT, 403 → denial codes, 5xx → retryable).
 * A shared live token is maintained per client instance; the daemon owns it
 * when composed together (one client, one token — exactly the production
 * shape where the daemon feeds the reader/writer).
 */

export interface MockVaultClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** Share the harness/mock-server clock so lease math is deterministic. */
  now?: () => number;
}

export interface MockVaultClient {
  tokenClient: VaultTokenClient & { currentToken(): RenewalToken | undefined; leaseIdOf(token: RenewalToken): string | undefined };
  credentialWriter: VaultCredentialWriter;
  /** Explicitly revoke the current client token server-side (sys/leases/revoke). */
  revokeCurrentToken(): Promise<void>;
}

export function createMockVaultClient(options: MockVaultClientOptions): MockVaultClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.now ?? Date.now;
  const leaseByToken = new Map<string, string>();
  let live: RenewalToken | undefined;
  const leaseIdOf = (token: RenewalToken): string | undefined => leaseByToken.get(token.value);

  async function call(path: string, init: { method: string; token?: string; body?: unknown }): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await fetchNoPool(base + path, {
      method: init.method,
      headers: {
        'content-type': 'application/json',
        ...(init.token ? { 'x-vault-token': init.token } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    let json: Record<string, unknown> = {};
    try {
      json = r.text ? (JSON.parse(r.text) as Record<string, unknown>) : {};
    } catch {
      json = {};
    }
    return { status: r.status, json };
  }



  const tokenClient = {
    async login(): Promise<RenewalToken> {
      const r = await call('/v1/auth/token/create', { method: 'POST', body: {} });
      if (r.status !== 200) throw new Error('vault login failed: ' + String(r.status));
      const auth = r.json.auth as { client_token: string; lease_id: string; lease_duration: number; renewable?: boolean };
      leaseByToken.set(auth.client_token, auth.lease_id);
      const token: RenewalToken = {
        value: auth.client_token,
        expiresAtMs: clock() + auth.lease_duration * 1000,
      };
      live = token;
      return token;
    },
    async renew(token: RenewalToken): Promise<RenewalToken | null> {
      const leaseId = leaseIdOf(token);
      if (!leaseId) return null;
      const r = await call('/v1/sys/leases/renew', { method: 'POST', token: token.value, body: { lease_id: leaseId } });
      if (r.status === 400 || r.status === 403) return null; // not renewable / expired → daemon re-logins
      if (r.status !== 200) throw new Error('vault renew failed: ' + String(r.status));
      const duration = Number((r.json as { lease_duration?: number }).lease_duration ?? 0);
      const next: RenewalToken = { value: token.value, expiresAtMs: clock() + duration * 1000 };
      live = next;
      return next;
    },
    currentToken(): RenewalToken | undefined {
      return live;
    },
    leaseIdOf(token: RenewalToken): string | undefined {
      return leaseIdOf(token);
    },
  } as MockVaultClient['tokenClient'];

  const credentialWriter: VaultCredentialWriter = {
    async writeCas(ref: VaultRefFields, value: string, cas?: number): Promise<number> {
      const token = tokenClient.currentToken();
      if (!token) throw { code: 'VAULT_NO_TOKEN', retryable: false };
      const r = await call(`/v1/${encodeURIComponent(ref.mount)}/data/${ref.path}`, {
        method: 'POST',
        token: token.value,
        body: { data: { [ref.key]: value }, ...(cas === undefined ? {} : { options: { cas } }) },
      });
      if (r.status === 412) throw { code: 'CAS_CONFLICT', retryable: false };
      if (r.status === 403) throw { code: 'CAPABILITY_DENIED', retryable: false };
      if (r.status >= 500) throw { code: 'VAULT_SERVER_ERROR', retryable: true };
      if (r.status !== 200) throw { code: 'VAULT_WRITE_FAILED_' + String(r.status), retryable: false };
      const data = r.json.data as { version?: number };
      return Number(data.version ?? 0);
    },
    async readVersions(ref: VaultRefFields): Promise<{ current_version: number; versions: number[] }> {
      const token = tokenClient.currentToken();
      if (!token) throw { code: 'VAULT_NO_TOKEN', retryable: false };
      const r = await call(`/v1/${encodeURIComponent(ref.mount)}/metadata/${ref.path}`, { method: 'GET', token: token.value });
      if (r.status === 403) throw { code: 'PREFIX_DENIED', retryable: false };
      if (r.status !== 200) throw { code: 'VAULT_METADATA_FAILED', retryable: r.status >= 500 };
      const data = (r.json.data ?? {}) as { current_version?: number; versions?: number[] };
      return { current_version: Number(data.current_version ?? 0), versions: (data.versions ?? []).map(Number) };
    },
  };

  return {
    tokenClient,
    credentialWriter,
    async revokeCurrentToken(): Promise<void> {
      const token = tokenClient.currentToken();
      const leaseId = token ? tokenClient.leaseIdOf(token) : undefined;
      if (!token || !leaseId) return;
      await call('/v1/sys/leases/revoke', { method: 'POST', token: token.value, body: { lease_id: leaseId } });
    },
  };
}
