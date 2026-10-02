import { createConnectorComposition } from './composition';
import { HmacServiceIdentityVerifier } from './identity';
import { ContractSignedGrantVerifier, HmacSignedGrantSource } from './contract-grants';
import { AesCredentialCipher } from './services';
import { HttpUsageSink } from './usage-dispatcher';

const port = parsePositiveInteger(process.env.CONNECTOR_PORT ?? process.env.PORT, 8080);
const composition = createConnectorComposition({
  port,
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: requiredEnvironment('DATABASE_URL'),
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  redisKeyPrefix: process.env.REDIS_KEY_PREFIX ?? 'du:connector:',
  migrationDirectory: process.env.CONNECTOR_MIGRATION_DIRECTORY,
  drainTimeoutMs: parsePositiveInteger(process.env.DRAIN_TIMEOUT_MS, 30_000),
  serviceIdentityVerifier: new HmacServiceIdentityVerifier(requiredSecret('SERVICE_IDENTITY_SECRET')),
  grantVerifier: new ContractSignedGrantVerifier(
    new HmacSignedGrantSource(requiredSecret('INVOCATION_GRANT_SECRET')),
  ),
  credentialCipher: new AesCredentialCipher(requiredSecret('CONNECTOR_ENCRYPTION_KEY')),
  providerAllowHosts: process.env.PROVIDER_ALLOW_HOSTS
    ? process.env.PROVIDER_ALLOW_HOSTS.split(',').map((host) => host.trim()).filter(Boolean)
    : undefined,
  allowPrivateProviderNetworks: process.env.ALLOW_PRIVATE_PROVIDER_NETWORKS === 'true',
  usageSink: process.env.USAGE_SINK_URL && process.env.USAGE_SINK_TOKEN
    ? new HttpUsageSink(process.env.USAGE_SINK_URL, process.env.USAGE_SINK_TOKEN)
    : undefined,
});

let shuttingDown = false;

async function main(): Promise<void> {
  await composition.start();
}

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  void composition.shutdown()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${value}.`);
  }
  return parsed;
}

function requiredSecret(name: string): Uint8Array {
  const value = requiredEnvironment(name);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength !== 32) throw new Error(`${name} must be a base64-encoded 32-byte secret.`);
  return decoded;
}
