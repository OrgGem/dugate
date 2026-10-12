import { createHash } from 'node:crypto';
import { VaultKv2RefSchema } from '@du/contracts';
import { ConnectorError } from '../errors';
import type { VaultPrefixScopeLike } from './reader';
import type { RenewalDaemon } from './token-renewal';

export interface VaultKv2SecretWritePlan {
  account: string;
  mount: string;
  path: string;
  key: string;
  expectedVersion: number;
  targetVersion: number;
  secretSha256: string;
}

/** Write-only KV v2 capability. Callers persist a plan before `writePlanned`;
 * retries first reconcile the exact target version and never issue a second
 * write when Vault already committed the original request. */
export interface VaultKv2SecretWriter {
  currentVersion(input: Pick<VaultKv2SecretWritePlan, 'account' | 'mount' | 'path' | 'key'>): Promise<number>;
  writePlanned(plan: VaultKv2SecretWritePlan, secret: string): Promise<number>;
}

export interface VaultKv2HttpWriterOptions {
  address: string;
  namespace?: string;
  allowedScopes: readonly VaultPrefixScopeLike[];
  daemon: RenewalDaemon;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export function createVaultKv2HttpSecretWriter(options: VaultKv2HttpWriterOptions): VaultKv2SecretWriter {
  const base = new URL(options.address);
  if ((base.protocol !== 'https:' && base.protocol !== 'http:') || base.username || base.password || base.search || base.hash) {
    throw new Error('vault kv2 writer requires a clean absolute http(s) origin');
  }
  if (!Array.isArray(options.allowedScopes) || options.allowedScopes.length === 0) {
    throw new Error('vault kv2 writer requires at least one allowed mount/path scope');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const fetchImpl = options.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));

  const assertRef = (input: Pick<VaultKv2SecretWritePlan, 'account' | 'mount' | 'path' | 'key'>): void => {
    // Write plans carry CAS and digest metadata in addition to the KV address.
    // Project the address explicitly because VaultKv2RefSchema is strict.
    const parsed = VaultKv2RefSchema.safeParse({
      account: input.account,
      mount: input.mount,
      path: input.path,
      key: input.key,
      version: 1,
    });
    if (!parsed.success) throw new ConnectorError('INVALID_INPUT', 'Vault credential destination is invalid.');
    const allowed = options.allowedScopes.some((scope) => scope.mount === input.mount
      && (input.path === scope.pathPrefix || input.path.startsWith(`${scope.pathPrefix.replace(/\/$/, '')}/`)));
    if (!allowed) throw new ConnectorError('BINDING_DENIED', 'Vault credential destination is outside the configured scope.');
  };

  const request = async (path: string, method: 'GET' | 'POST', body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const token = options.daemon.current()?.value;
    if (!token || /[\r\n\u0000]/.test(token)) {
      throw new ConnectorError('CREDENTIAL_INVALID', 'Vault write identity is unavailable.');
    }
    const headers: Record<string, string> = { accept: 'application/json', 'x-vault-token': token };
    if (options.namespace !== undefined) headers['x-vault-namespace'] = options.namespace;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const controller = new AbortController();
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let responseBody: ReadableStream<Uint8Array> | null = null;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = () => new ConnectorError(
      'PROVIDER_UNAVAILABLE',
      'Vault credential request timed out.',
      { safeToRetry: true },
    );
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(timeoutError());
      }, timeoutMs);
    });
    const cancelResponse = (): void => {
      if (activeReader) {
        void activeReader.cancel().catch(() => undefined);
        return;
      }
      if (responseBody) void responseBody.cancel().catch(() => undefined);
    };
    const perform = async (): Promise<{ status: number; json: Record<string, unknown> }> => {
      let response: Response;
      try {
        response = await fetchImpl(new URL(path, base).toString(), {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'error',
          signal: controller.signal,
        });
      } catch {
        throw timedOut
          ? timeoutError()
          : new ConnectorError('PROVIDER_UNAVAILABLE', 'Vault credential request failed.', { safeToRetry: true });
      }
      responseBody = response.body;
      if (timedOut) {
        cancelResponse();
        throw timeoutError();
      }

      const declaredLength = response.headers.get('content-length');
      if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxResponseBytes) {
        cancelResponse();
        throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Vault credential response exceeded its bound.');
      }

      let bytes: Uint8Array;
      try {
        bytes = await readCappedBody(responseBody, maxResponseBytes, (reader) => { activeReader = reader; });
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        throw timedOut
          ? timeoutError()
          : new ConnectorError('PROVIDER_UNAVAILABLE', 'Vault credential response failed.', { safeToRetry: true });
      }
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Vault credential response was invalid.'); }
      if (text.length === 0 && response.status === 404) return { status: 404, json: {} };
      let json: Record<string, unknown> = {};
      if (text.length > 0) {
        try {
          const parsed: unknown = JSON.parse(text);
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
          json = parsed as Record<string, unknown>;
        } catch {
          throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Vault credential response was invalid.');
        }
      }
      return { status: response.status, json };
    };
    try {
      return await Promise.race([perform(), timeout]);
    } catch (error) {
      controller.abort();
      cancelResponse();
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Vault credential response failed.', { safeToRetry: true });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const encodedPath = (value: string): string => value.split('/').map(encodeURIComponent).join('/');
  const dataPath = (mount: string, path: string): string => `v1/${encodeURIComponent(mount)}/data/${encodedPath(path)}`;

  return {
    async currentVersion(input): Promise<number> {
      assertRef(input);
      const response = await request(`v1/${encodeURIComponent(input.mount)}/metadata/${encodedPath(input.path)}`, 'GET');
      if (response.status === 404) return 0;
      if (response.status !== 200) {
        throw new ConnectorError(response.status === 403 ? 'BINDING_DENIED' : 'PROVIDER_UNAVAILABLE', 'Vault metadata could not be read.');
      }
      const data = response.json.data;
      const version = data !== null && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>).current_version
        : undefined;
      if (!Number.isSafeInteger(version) || (version as number) < 0 || (version as number) > 2_147_483_646) {
        throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Vault metadata version is invalid.');
      }
      return version as number;
    },

    async writePlanned(plan, secret): Promise<number> {
      assertRef(plan);
      if (secret.length < 1 || secret.length > 16_384 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(secret)) {
        throw new ConnectorError('INVALID_INPUT', 'Vault credential value is invalid.');
      }
      if (!Number.isSafeInteger(plan.expectedVersion) || plan.expectedVersion < 0 || plan.expectedVersion > 2_147_483_646
        || !Number.isSafeInteger(plan.targetVersion) || plan.targetVersion < 1 || plan.targetVersion > 2_147_483_647
        || plan.targetVersion !== plan.expectedVersion + 1
        || !/^[0-9a-f]{64}$/.test(plan.secretSha256)
        || createHash('sha256').update(secret, 'utf8').digest('hex') !== plan.secretSha256) {
        throw new ConnectorError('BINDING_DENIED', 'Vault write plan does not match its staged credential.');
      }
      const ref = { account: plan.account, mount: plan.mount, path: plan.path, key: plan.key, version: plan.targetVersion };
      const targetUrl = `${dataPath(plan.mount, plan.path)}?version=${plan.targetVersion}`;
      const existing = await request(targetUrl, 'GET');
      if (existing.status === 200) {
        const data = existing.json.data;
        const fields = data !== null && typeof data === 'object' && !Array.isArray(data)
          ? (data as Record<string, unknown>).data
          : undefined;
        const actual = fields !== null && typeof fields === 'object' && !Array.isArray(fields)
          ? (fields as Record<string, unknown>)[plan.key]
          : undefined;
        if (typeof actual === 'string' && createHash('sha256').update(actual, 'utf8').digest('hex') === plan.secretSha256) {
          return plan.targetVersion;
        }
        throw new ConnectorError('BINDING_DENIED', 'The staged Vault version differs from the requested credential.');
      }
      if (existing.status !== 404) {
        throw new ConnectorError('PROVIDER_UNAVAILABLE', 'The staged Vault version could not be reconciled.', { safeToRetry: true });
      }
      const written = await request(dataPath(plan.mount, plan.path), 'POST', {
        options: { cas: plan.expectedVersion },
        data: { [plan.key]: secret },
      });
      if (written.status === 400 || written.status === 409) {
        // CAS lost to another writer; never retry with a newer plan here.
        throw new ConnectorError('BINDING_DENIED', 'Vault credential write lost its version fence.');
      }
      if (written.status !== 200 && written.status !== 204) {
        throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Vault credential write did not complete.', { safeToRetry: true });
      }
      const data = written.json.data;
      const metadata = data !== null && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>).version
        : undefined;
      const version = typeof metadata === 'number' ? metadata : plan.targetVersion;
      if (version !== plan.targetVersion) {
        throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Vault returned an unexpected credential version.');
      }
      // Keep a parsed reference in this module so invalid coordinates cannot
      // accidentally become a readback request in a later recovery attempt.
      if (!VaultKv2RefSchema.safeParse(ref).success) {
        throw new ConnectorError('INVALID_INPUT', 'Vault credential reference is invalid.');
      }
      return version;
    },
  };
}

async function readCappedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  onReader: (reader: ReadableStreamDefaultReader<Uint8Array>) => void,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  onReader(reader);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new ConnectorError('INVALID_PROVIDER_RESPONSE', 'Vault credential response exceeded its bound.');
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
