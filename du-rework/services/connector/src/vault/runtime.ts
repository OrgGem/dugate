import { SecretResolver, type VaultKv2SecretReader } from './resolver';
import { createAppRoleTokenClient } from './approle';
import {
  createDaemonBackedVaultKv2Reader,
  createVaultKv2HttpReader,
  type VaultPrefixScopeLike,
} from './reader';
import {
  createTokenRenewalDaemon,
  type RenewalDaemon,
  type RenewalDaemonOptions,
} from './token-renewal';

/**
 * SC-02 (SECRET-CATALOG-20261006) — one production factory that closes the
 * Vault KV v2 chain (CR06-02 reconciliation):
 *
 *   AppRole login/renew (machine identity)
 *     → token renewal daemon (dynamic leases, fail-closed UNAUTHENTICATED)
 *       → daemon-backed HTTP KV v2 reader (scope-checked, version-pinned)
 *         → SecretResolver (vault-kv2 sources; legacy-db handled by services)
 *
 * Composition owns the wiring: build once, `start()` before serving, and pass
 * `secretResolver` to `DurableConnectorRuntime`/`DurableConnectorManagement`.
 * The factory exists so the resolver/renewal are real production code (not
 * exported dead code) with a single, tested construction path.
 */

export interface ConnectorVaultRuntimeOptions {
  /** Vault origin, e.g. https://vault.internal:8200. */
  address: string;
  /** Optional Vault Enterprise namespace. */
  namespace?: string;
  roleId: string;
  secretId: string;
  /** Mount + path-prefix scopes the reader may touch. */
  scopes: readonly VaultPrefixScopeLike[];
  authMountPath?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  retry?: { maxAttempts?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> };
  daemon?: Pick<
    RenewalDaemonOptions,
    'safetyMarginMs' | 'retryBaseMs' | 'retryMaxMs' | 'minLeadMs' | 'now' | 'schedule' | 'cancel' | 'log'
  >;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface ConnectorVaultRuntime {
  secretResolver: SecretResolver;
  daemon: RenewalDaemon;
  reader: VaultKv2SecretReader;
  /** Acquire the first lease; call before serving. */
  start(): Promise<void>;
  stop(): void;
}

export function createConnectorVaultRuntime(
  options: ConnectorVaultRuntimeOptions,
): ConnectorVaultRuntime {
  const tokenClient = createAppRoleTokenClient({
    address: options.address,
    ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
    roleId: options.roleId,
    secretId: options.secretId,
    ...(options.authMountPath === undefined ? {} : { mountPath: options.authMountPath }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
  });
  const daemon = createTokenRenewalDaemon({ client: tokenClient, ...(options.daemon ?? {}) });
  const httpReader = createVaultKv2HttpReader({
    address: options.address,
    ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
    allowedScopes: options.scopes,
    token: () => daemon.current()?.value,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
  });
  const reader = createDaemonBackedVaultKv2Reader({ daemon, reader: httpReader });
  const secretResolver = new SecretResolver({
    kv2: reader,
    ...(options.retry === undefined ? {} : { retry: options.retry }),
  });
  return {
    secretResolver,
    daemon,
    reader,
    start: () => daemon.start(),
    stop: () => daemon.stop(),
  };
}

/**
 * Environment-driven construction. Returns undefined when the deployment does
 * not configure Vault at all (composition keeps its current behavior); a
 * HALF-set configuration is a boot error instead of a silent no-Vault
 * deployment.
 *
 * Names: VAULT_ADDR, VAULT_NAMESPACE (optional), VAULT_APPROLE_ROLE_ID,
 * VAULT_APPROLE_SECRET_ID, VAULT_APPROLE_MOUNT, VAULT_KV_MOUNT,
 * VAULT_KV_ALLOWED_PREFIX (default 'du/tenants'), VAULT_REQUEST_TIMEOUT_MS.
 */
export function connectorVaultRuntimeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  overrides: Partial<Pick<ConnectorVaultRuntimeOptions, 'daemon' | 'fetchImpl'>> = {},
): ConnectorVaultRuntime | undefined {
  const value = (name: string): string | undefined => {
    const raw = env[name];
    return raw === undefined || raw.length === 0 ? undefined : raw;
  };
  const address = value('VAULT_ADDR');
  const roleId = value('VAULT_APPROLE_ROLE_ID');
  const secretId = value('VAULT_APPROLE_SECRET_ID');
  if (address === undefined && roleId === undefined && secretId === undefined) return undefined;
  if (address === undefined || roleId === undefined || secretId === undefined) {
    throw new Error('Vault runtime requires VAULT_ADDR together with VAULT_APPROLE_ROLE_ID and VAULT_APPROLE_SECRET_ID');
  }
  const mount = value('VAULT_KV_MOUNT') ?? 'secret';
  const prefix = value('VAULT_KV_ALLOWED_PREFIX') ?? 'du/tenants';
  if (
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(mount)
    || prefix.startsWith('/')
    || prefix.endsWith('/')
    || prefix.includes('..')
    || /[\s\u0000-\u001f\u007f]/.test(prefix)
  ) {
    throw new Error('Vault runtime mount/prefix configuration is invalid');
  }
  const timeoutRaw = value('VAULT_REQUEST_TIMEOUT_MS');
  const timeoutMs = timeoutRaw === undefined ? undefined : Number(timeoutRaw);
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) {
    throw new Error('VAULT_REQUEST_TIMEOUT_MS must be a positive integer');
  }
  return createConnectorVaultRuntime({
    address,
    ...(value('VAULT_NAMESPACE') === undefined ? {} : { namespace: value('VAULT_NAMESPACE') }),
    roleId,
    secretId,
    scopes: [{ mount, pathPrefix: prefix }],
    ...(value('VAULT_APPROLE_MOUNT') === undefined ? {} : { authMountPath: value('VAULT_APPROLE_MOUNT') }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...overrides,
  });
}
