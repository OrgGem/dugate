import { randomUUID } from 'node:crypto';
import type { PoolConfig } from 'pg';
import { createConnectorServer, type ConnectorHttpDependencies } from './http/server';
import { ConnectorLifecycle, type ShutdownOptions } from './lifecycle';
import { PgSqlClient } from './db/pg-client';
import { IoredisEvalClient } from './redis-client';
import { RedisQuotaStore } from './quota-redis';
import { PostgresInvocationLedger, PostgresConnectorConfigRepository } from './db/repository';
import { PostgresUsageOutbox } from './db/usage-outbox';
import {
  resolveInvocationStorageCryptoFromEnv,
  type InvocationStorageCryptoOptions,
} from './db/invocation-crypto';
import type { QuotaStore } from './types';
import type { GrantVerifier, ProviderTestGrantVerifier } from './grants';
import { AdapterRegistry } from './adapters/registry';
import { FetchProviderTransport } from './adapters/transport';
import { AesCredentialCipher, DurableConnectorManagement, DurableConnectorRuntime } from './services';
import type { UsageSink, UsageDispatcherOptions } from './usage-dispatcher';
import { UsageOutboxDispatcher } from './usage-dispatcher';
import { ConnectorReplicaIdentitySchema, type ConnectorReplicaIdentity } from '@du/contracts';
import type { ConnectorReplicaRuntimeObservation } from '@du/contracts';
import { PostgresConnectorReplicaRuntimeControl } from './db/replica-runtime-controls';
import { PostgresConnectorBackupEffectControl } from './db/backup-effect-fences';
import { PostgresConnectorParityRepository } from './db/parity-repository';
import { createConnectorParityManagement } from './modules/parity-management';
import { connectorVaultRuntimeFromEnv, type ConnectorVaultRuntime } from './vault/runtime';
import { HttpConnectorCostControlClient, type ConnectorCostControlClient } from './cost-control-client';

export interface ConnectorConfig {
  port: number;
  host?: string;
  databaseUrl: string;
  /** Optional secret channel for the isolated restore bootstrap; this value
   * is passed directly to pg and is never copied into process.env or argv. */
  databasePassword?: PoolConfig['password'];
  databaseSsl?: PoolConfig['ssl'];
  redisUrl: string;
  redisKeyPrefix?: string;
  migrationDirectory?: string;
  drainTimeoutMs?: number;
  serviceIdentityVerifier?: ConnectorHttpDependencies['identityVerifier'];
  grantVerifier?: GrantVerifier;
  providerTestGrantVerifier?: ProviderTestGrantVerifier;
  costControl?: { baseUrl: string; token: string; fetcher?: typeof fetch };
  credentialCipher?: AesCredentialCipher;
  providerTransport?: FetchProviderTransport;
  maxProviderResponseBytes?: number;
  providerAllowHosts?: readonly string[];
  allowPrivateProviderNetworks?: boolean;
  usageSink?: UsageSink;
  usageDispatcher?: UsageDispatcherOptions;
  vaultMount?: string;
  /**
   * SEC-ENC-02 (SD-01): seals the durable invocation request/result/session
   * before SQL. Defaults to the environment
   * (`CONNECTOR_INVOCATION_ENCRYPTION_KEYS`, optional
   * `CONNECTOR_INVOCATION_LEGACY_PLAINTEXT_READS`); when neither is present
   * the ledger refuses sensitive writes instead of storing plaintext. A
   * malformed key config throws here, at composition time.
   */
  invocationStorageCrypto?: InvocationStorageCryptoOptions;
  /** Host-runner identity pin. Omit all five fields to leave the new control
   * surface unavailable; partial configuration is rejected by the entrypoint. */
  runtimeControl?: ConnectorReplicaIdentity;
  /** Trusted restore-rehearsal process mode. It never accepts mutations,
   * migrates the restored database, or starts background delivery/renewal. */
  isolatedRestoreRehearsal?: boolean;
  /** Optional test seam; production resolves the same Vault AppRole daemon from process env. */
  /** `null` explicitly disables environment discovery (restore bootstrap). */
  vaultRuntime?: ConnectorVaultRuntime | null;
}

export interface ConnectorComposition {
  dependencies: ConnectorHttpDependencies;
  lifecycle: ConnectorLifecycle;
  start(): Promise<void>;
  shutdown(options?: ShutdownOptions): Promise<void>;
  address(): ReturnType<ConnectorLifecycle['address']>;
}

export interface ConnectorCompositionOverrides {
  http: ConnectorHttpDependencies;
  migrate?: () => Promise<void>;
  pingDatabase?: () => Promise<boolean>;
  pingRedis?: () => Promise<boolean>;
  close?: () => Promise<void>;
}

export function createConnectorComposition(
  config: ConnectorConfig,
  overrides?: ConnectorCompositionOverrides,
): ConnectorComposition {
  const isolatedRestoreRehearsal = config.isolatedRestoreRehearsal === true;
  if (isolatedRestoreRehearsal && !config.runtimeControl) {
    throw new Error('Connector restore rehearsal requires an exact runtime-control identity.');
  }
  if (overrides) {
    const dependencies: ConnectorHttpDependencies = {
      ...overrides.http,
      // CR06-05: the override path enforces the same identity contract as
      // production. A verifier supplied through either the override HTTP
      // dependencies or the composition config is honored; when neither is
      // present `createConnectorServer` below fails closed, so test harnesses
      // must explicitly opt into `allowUnauthenticatedTestTraffic`.
      identityVerifier: overrides.http.identityVerifier ?? config.serviceIdentityVerifier,
      ready: async () => {
        const [database, redis] = await Promise.all([
          overrides.pingDatabase?.() ?? true,
          overrides.pingRedis?.() ?? true,
        ]);
        return database && redis && await overrides.http.ready();
      },
      ...(isolatedRestoreRehearsal ? { isolatedReadOnly: true } : {}),
    };
    const server = createConnectorServer(dependencies);
    const lifecycle = new ConnectorLifecycle({
      server,
      closeDependencies: overrides.close ?? (async () => {}),
      drainTimeoutMs: config.drainTimeoutMs,
      initiallyDraining: isolatedRestoreRehearsal,
    });
    dependencies.acceptingInvocations = () => lifecycle.isAccepting();
    if (isolatedRestoreRehearsal) {
      dependencies.restoreExternalEffects = () => connectorRestoreEffectStatus({
        accepting: lifecycle.isAccepting(), usageDelivery: false, migrations: false,
      });
    }
    return {
      dependencies,
      lifecycle,
      start: () => lifecycle.start(config.port, config.host),
      shutdown: (options) => lifecycle.shutdown(options),
      address: () => lifecycle.address(),
    };
  }

  if (!config.serviceIdentityVerifier || !config.grantVerifier || !config.credentialCipher) {
    throw new Error('Connector security configuration is required.');
  }
  const database = new PgSqlClient({
    connectionString: config.databaseUrl,
    ...(config.databasePassword === undefined ? {} : { password: config.databasePassword }),
    ...(config.databaseSsl === undefined ? {} : { ssl: config.databaseSsl }),
    migrationDirectory: config.migrationDirectory,
  });
  const redis = new IoredisEvalClient({ ...parseRedisUrl(config.redisUrl) });
  const quota = new RedisQuotaStore(redis, config.redisKeyPrefix);
  // SEC-ENC-02 (SD-01): the production ledger always receives the sealing
  // options. Explicit config wins; otherwise the environment is resolved here
  // (malformed keys fail composition loudly) and an unset key means sensitive
  // writes are refused at the ledger, never persisted as plaintext.
  const invocationCrypto = config.invocationStorageCrypto ?? resolveInvocationStorageCryptoFromEnv(process.env);
  const replicaIdentity = config.runtimeControl
    ? ConnectorReplicaIdentitySchema.parse(config.runtimeControl)
    : undefined;
  // One boot nonce owns invocation, configuration, and usage effect permits.
  // A new process must never adopt unresolved permits from its predecessor.
  const runtimeBootId = replicaIdentity ? randomUUID() : undefined;
  const backupEffectControl = replicaIdentity && runtimeBootId
    ? new PostgresConnectorBackupEffectControl(database, replicaIdentity, runtimeBootId)
    : undefined;
  const ledger = new PostgresInvocationLedger(database, {
    ...invocationCrypto,
    ...(replicaIdentity && runtimeBootId ? {
      replicaId: replicaIdentity.replicaId,
      runtimeIdentity: replicaIdentity.runtimeIdentity,
      bootId: runtimeBootId,
    } : {}),
  });
  const connectorConfig = new PostgresConnectorConfigRepository(database);
  const parityRepository = new PostgresConnectorParityRepository(
    database,
    invocationCrypto.fieldCrypto,
    backupEffectControl,
  );
  const vaultRuntime = config.vaultRuntime === null
    ? undefined
    : config.vaultRuntime ?? connectorVaultRuntimeFromEnv(process.env);
  const usageOutbox = new PostgresUsageOutbox(database, backupEffectControl);
  const registry = new AdapterRegistry();
  const transport = config.providerTransport ?? new FetchProviderTransport({
    maxResponseBytes: config.maxProviderResponseBytes,
    allowHosts: config.providerAllowHosts,
    allowPrivateNetworks: config.allowPrivateProviderNetworks,
  });
  const costControl: ConnectorCostControlClient | undefined = config.costControl
    ? new HttpConnectorCostControlClient(config.costControl.baseUrl, config.costControl.token, config.costControl.fetcher)
    : undefined;
  const runtime = new DurableConnectorRuntime(
    ledger,
    connectorConfig,
    quota,
    usageOutbox,
    registry,
    transport,
    config.credentialCipher,
    config.grantVerifier,
    vaultRuntime?.secretResolver,
    config.providerTestGrantVerifier,
    parityRepository,
    costControl,
  );
  const replicaRuntimeControl = config.runtimeControl
    ? new PostgresConnectorReplicaRuntimeControl(database, replicaIdentity!, undefined,
      {
        countAllUnresolvedInvocations: isolatedRestoreRehearsal,
        ...(runtimeBootId ? { bootId: runtimeBootId } : {}),
      })
    : undefined;
  const runtimeHealth = async () => {
    const [postgres, redisHealth] = await Promise.all([
      database.ping().then((healthy) => ({ state: healthy ? 'HEALTHY' as const : 'UNAVAILABLE' as const,
        observedAt: new Date().toISOString() }))
        .catch(() => ({ state: 'UNAVAILABLE' as const, observedAt: new Date().toISOString() })),
      redis.ping().then((value) => ({ state: value === 'PONG' ? 'HEALTHY' as const : 'UNAVAILABLE' as const,
        observedAt: new Date().toISOString() }))
        .catch(() => ({ state: 'UNAVAILABLE' as const, observedAt: new Date().toISOString() })),
    ]);
    const observedAt = new Date().toISOString();
    return {
      observedAt,
      postgres,
      redis: redisHealth,
    };
  };
  const http: ConnectorHttpDependencies = {
    management: new DurableConnectorManagement(connectorConfig, config.credentialCipher, registry, vaultRuntime?.secretResolver),
    parityManagement: createConnectorParityManagement({
      repository: parityRepository,
      ...(vaultRuntime === undefined ? {} : { secretWriter: vaultRuntime.secretWriter }),
      vaultMount: config.vaultMount ?? process.env.VAULT_KV_MOUNT ?? 'secret',
    }),
    runtime,
    ...(replicaRuntimeControl ? { replicaRuntimeControl } : {}),
    ...(replicaRuntimeControl ? { runtimeHealth } : {}),
    capabilities: () => ({ adapters: registry.list() }),
    ready: async () => true,
    identityVerifier: config.serviceIdentityVerifier,
    ...(isolatedRestoreRehearsal ? { isolatedReadOnly: true } : {}),
  };
  const server = createConnectorServer(http);
  const usageDispatcher = !isolatedRestoreRehearsal && config.usageSink
    ? new UsageOutboxDispatcher(usageOutbox, config.usageSink, config.usageDispatcher)
    : undefined;
  const lifecycle = new ConnectorLifecycle({
    server,
    closeDependencies: async () => {
      vaultRuntime?.stop();
      await Promise.all([database.close(), redis.close()]);
    },
    drainTimeoutMs: config.drainTimeoutMs,
    usageDispatcher,
    initiallyDraining: isolatedRestoreRehearsal,
  });
  http.acceptingInvocations = () => lifecycle.isAccepting();
  if (isolatedRestoreRehearsal) {
    http.restoreExternalEffects = () => connectorRestoreEffectStatus({
      accepting: lifecycle.isAccepting(),
      usageDelivery: usageDispatcher !== undefined,
      migrations: false,
    });
  }
  return {
    dependencies: {
      ...http,
      ready: async () => (
        (await database.ping())
        && (await redis.ping()) === 'PONG'
        && http.ready()
      ),
    },
    lifecycle,
    start: async () => {
      if (isolatedRestoreRehearsal) {
        if (!replicaRuntimeControl) throw new Error('Connector restore rehearsal runtime control is unavailable.');
        await replicaRuntimeControl.claimPreseededDrain();
        await vaultRuntime?.startForRestoreProbe();
        await database.ping();
        await redis.ping();
      } else {
        await vaultRuntime?.start();
        await database.migrate();
        await replicaRuntimeControl?.register();
      }
      await lifecycle.start(config.port, config.host);
    },
    shutdown: (options) => lifecycle.shutdown(options),
    address: () => lifecycle.address(),
  };
}

function connectorRestoreEffectStatus(input: {
  accepting: boolean;
  usageDelivery: boolean;
  migrations: boolean;
}): NonNullable<ConnectorReplicaRuntimeObservation['externalEffects']> {
  const admission = input.accepting ? 'ENABLED' : 'DISABLED';
  return {
    admission,
    dispatch: 'DISABLED',
    providerInvocation: input.accepting ? 'ENABLED' : 'DISABLED',
    connectorPoll: 'DISABLED',
    usageDelivery: input.usageDelivery ? 'ENABLED' : 'DISABLED',
    webhookDelivery: 'DISABLED',
    alertEmission: 'DISABLED',
    cleanup: 'DISABLED',
    historicalMaintenance: 'DISABLED',
    migrations: input.migrations ? 'ENABLED' : 'DISABLED',
  };
}

function parseRedisUrl(url: string): { host: string; port: number; password?: string; tls?: object } {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    password: parsed.password || undefined,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
  };
}
