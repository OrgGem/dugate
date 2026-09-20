import { createConnectorServer, type ConnectorHttpDependencies } from './http/server';
import { ConnectorLifecycle } from './lifecycle';
import { PgSqlClient } from './db/pg-client';
import { IoredisEvalClient } from './redis-client';
import { RedisQuotaStore } from './quota-redis';
import { PostgresInvocationLedger, PostgresConnectorConfigRepository } from './db/repository';
import { PostgresUsageOutbox } from './db/usage-outbox';
import type { QuotaStore } from './types';
import type { GrantVerifier } from './grants';
import { AdapterRegistry } from './adapters/registry';
import { FetchProviderTransport } from './adapters/transport';
import { AesCredentialCipher, DurableConnectorManagement, DurableConnectorRuntime } from './services';
import type { UsageSink, UsageDispatcherOptions } from './usage-dispatcher';
import { UsageOutboxDispatcher } from './usage-dispatcher';

export interface ConnectorConfig {
  port: number;
  host?: string;
  databaseUrl: string;
  redisUrl: string;
  redisKeyPrefix?: string;
  migrationDirectory?: string;
  drainTimeoutMs?: number;
  serviceIdentityVerifier?: ConnectorHttpDependencies['identityVerifier'];
  grantVerifier?: GrantVerifier;
  credentialCipher?: AesCredentialCipher;
  providerTransport?: FetchProviderTransport;
  maxProviderResponseBytes?: number;
  providerAllowHosts?: readonly string[];
  allowPrivateProviderNetworks?: boolean;
  usageSink?: UsageSink;
  usageDispatcher?: UsageDispatcherOptions;
}

export interface ConnectorComposition {
  dependencies: ConnectorHttpDependencies;
  lifecycle: ConnectorLifecycle;
  start(): Promise<void>;
  shutdown(): Promise<void>;
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
  if (overrides) {
    const dependencies: ConnectorHttpDependencies = {
      ...overrides.http,
      ready: async () => {
        const [database, redis] = await Promise.all([
          overrides.pingDatabase?.() ?? true,
          overrides.pingRedis?.() ?? true,
        ]);
        return database && redis && await overrides.http.ready();
      },
    };
    const server = createConnectorServer(dependencies);
    const lifecycle = new ConnectorLifecycle({
      server,
      closeDependencies: overrides.close ?? (async () => {}),
      drainTimeoutMs: config.drainTimeoutMs,
    });
    dependencies.acceptingInvocations = () => lifecycle.isAccepting();
    return {
      dependencies,
      lifecycle,
      start: () => lifecycle.start(config.port, config.host),
      shutdown: () => lifecycle.shutdown(),
      address: () => lifecycle.address(),
    };
  }

  if (!config.serviceIdentityVerifier || !config.grantVerifier || !config.credentialCipher) {
    throw new Error('Connector security configuration is required.');
  }
  const database = new PgSqlClient({
    connectionString: config.databaseUrl,
    migrationDirectory: config.migrationDirectory,
  });
  const redis = new IoredisEvalClient({ ...parseRedisUrl(config.redisUrl) });
  const quota = new RedisQuotaStore(redis, config.redisKeyPrefix);
  const ledger = new PostgresInvocationLedger(database);
  const connectorConfig = new PostgresConnectorConfigRepository(database);
  const usageOutbox = new PostgresUsageOutbox(database);
  const registry = new AdapterRegistry();
  const transport = config.providerTransport ?? new FetchProviderTransport({
    maxResponseBytes: config.maxProviderResponseBytes,
    allowHosts: config.providerAllowHosts,
    allowPrivateNetworks: config.allowPrivateProviderNetworks,
  });
  const runtime = new DurableConnectorRuntime(
    ledger,
    connectorConfig,
    quota,
    usageOutbox,
    registry,
    transport,
    config.credentialCipher,
    config.grantVerifier,
  );
  const http: ConnectorHttpDependencies = {
    management: new DurableConnectorManagement(connectorConfig, config.credentialCipher, registry),
    runtime,
    capabilities: () => ({ adapters: registry.list() }),
    ready: async () => true,
    identityVerifier: config.serviceIdentityVerifier,
  };
  const server = createConnectorServer(http);
  const lifecycle = new ConnectorLifecycle({
    server,
    closeDependencies: async () => {
      await Promise.all([database.close(), redis.close()]);
    },
    drainTimeoutMs: config.drainTimeoutMs,
    usageDispatcher: config.usageSink
      ? new UsageOutboxDispatcher(usageOutbox, config.usageSink, config.usageDispatcher)
      : undefined,
  });
  http.acceptingInvocations = () => lifecycle.isAccepting();
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
      await database.migrate();
      await lifecycle.start(config.port, config.host);
    },
    shutdown: () => lifecycle.shutdown(),
    address: () => lifecycle.address(),
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
