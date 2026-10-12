import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import { ConnectorReplicaIdentitySchema } from '@du/contracts';
import { createConnectorComposition, type ConnectorComposition, type ConnectorConfig } from './composition';
import { HmacServiceIdentityVerifier } from './identity';
import {
  ContractSignedGrantVerifier,
  ContractSignedProviderTestGrantVerifier,
  HmacSignedGrantSource,
} from './contract-grants';
import { AesCredentialCipher } from './services';
import {
  resolveInvocationStorageCryptoFromEnv,
} from './db/invocation-crypto';

const CONFIG_PATH = '/run/du-restore/runtime-config.json';
const SECRETS_PATH = '/run/du-restore/runtime-secrets.json';
const PG_PASSWORD_PATH = '/run/du-restore/pg-password';
const GATE_DIR = '/run/du-restore/start-gate';
const MAX_PINNED_FILE_BYTES = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const IMAGE_DIGEST = /^.+@sha256:[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Per-launch file generated only by the trusted restore runner. */
export interface ConnectorRestoreRuntimeConfig {
  schemaVersion: 1;
  service: 'connector';
  clusterName: string;
  runtimeIdentity: string;
  revision: string;
  imageDigest: string;
  replicaId: string;
  slot: 'blue' | 'green';
  bindHost: '0.0.0.0';
  port: number;
  database: { host: string; port: number; user: string; sslMode: 'disable' | 'require' | 'verify-full' };
  redis: { host: string; port: number };
  databaseName: string;
  targetGenerationId: string;
}

export const ConnectorRestoreRuntimeConfigSchema = { parse: parseConnectorRestoreRuntimeConfig };

interface ConnectorRestoreInvocationKeys {
  keyRef: string;
  activeVersion: number;
  keys: Record<string, string>;
}

/** Secret file is mounted read-only, available only to the dedicated UID/GID. */
export interface ConnectorRestoreRuntimeSecrets {
  schemaVersion: 1;
  service: 'connector';
  serviceRuntime: ReturnType<typeof ConnectorReplicaIdentitySchema.parse>;
  serviceIdentitySecretBase64: string;
  invocationGrantSecretBase64: string;
  credentialEncryptionKeyBase64: string;
  invocationEncryptionKeys: ConnectorRestoreInvocationKeys;
  redisPassword?: string;
}

export const ConnectorRestoreRuntimeSecretsSchema = { parse: parseConnectorRestoreRuntimeSecrets };

interface ConnectorRestorePgPasswordFile { schemaVersion: 1; password: string }

export interface ConnectorRestoreBootstrapArgs {
  configPath: string;
  configSha256: string;
  secretsPath: string;
  secretsSha256: string;
  pgPasswordPath: string;
  pgPasswordSha256: string;
  gateDir: string;
  runtimeIdentity: string;
  targetGenerationId: string;
  imageDigest: string;
}

export interface ConnectorRestoreBootstrapFiles {
  config: ConnectorRestoreRuntimeConfig;
  secrets: ConnectorRestoreRuntimeSecrets;
  pgPassword: string;
  gateDir: string;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Connector restore file is invalid.');
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || required.some((key) => !(key in value))) {
    throw new Error('Connector restore file schema is invalid.');
  }
}

function boundedString(value: unknown, max: number, label: string, min = 1): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) throw new Error(`${label} is invalid.`);
  return value;
}

function safeId(value: unknown, label: string): string {
  const parsed = boundedString(value, 128, label);
  if (!SAFE_ID.test(parsed)) throw new Error(`${label} is invalid.`);
  return parsed;
}

function port(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function parseConnectorRestoreRuntimeConfig(value: unknown): ConnectorRestoreRuntimeConfig {
  const row = object(value);
  exactKeys(row, ['schemaVersion', 'service', 'clusterName', 'runtimeIdentity', 'revision', 'imageDigest',
    'replicaId', 'slot', 'bindHost', 'port', 'database', 'redis', 'databaseName', 'targetGenerationId']);
  const imageDigest = boundedString(row.imageDigest, 512, 'image digest');
  if (row.schemaVersion !== 1 || row.service !== 'connector' || row.bindHost !== '0.0.0.0'
    || (row.slot !== 'blue' && row.slot !== 'green') || !IMAGE_DIGEST.test(imageDigest)
    || typeof row.targetGenerationId !== 'string' || !UUID.test(row.targetGenerationId)) {
    throw new Error('Connector restore runtime config is invalid.');
  }
  const database = object(row.database);
  exactKeys(database, ['host', 'port', 'user', 'sslMode']);
  const databaseHost = boundedString(database.host, 64, 'database host');
  if (isIP(databaseHost.startsWith('[') && databaseHost.endsWith(']') ? databaseHost.slice(1, -1) : databaseHost) === 0
    || (database.sslMode !== 'disable' && database.sslMode !== 'require' && database.sslMode !== 'verify-full')) {
    throw new Error('Connector restore database config is invalid.');
  }
  const redis = object(row.redis);
  exactKeys(redis, ['host', 'port']);
  const redisHost = boundedString(redis.host, 64, 'redis host');
  if (isIP(redisHost.startsWith('[') && redisHost.endsWith(']') ? redisHost.slice(1, -1) : redisHost) === 0) {
    throw new Error('Connector restore Redis config is invalid.');
  }
  const databaseName = boundedString(row.databaseName, 63, 'database name');
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/.test(databaseName)) throw new Error('Connector restore database name is invalid.');
  return {
    schemaVersion: 1, service: 'connector', clusterName: boundedString(row.clusterName, 256, 'cluster name'),
    runtimeIdentity: safeId(row.runtimeIdentity, 'runtime identity'), revision: safeId(row.revision, 'revision'),
    imageDigest, replicaId: safeId(row.replicaId, 'replica id'), slot: row.slot,
    bindHost: '0.0.0.0', port: port(row.port, 'Connector port'),
    database: { host: databaseHost, port: port(database.port, 'Postgres port'), user: safeId(database.user, 'Postgres user'), sslMode: database.sslMode },
    redis: { host: redisHost, port: port(redis.port, 'Redis port') }, databaseName, targetGenerationId: row.targetGenerationId,
  };
}

function decodeSecretMaterial(value: unknown, label: string): string {
  const encoded = boundedString(value, 4096, label);
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== encoded) {
    decoded.fill(0);
    throw new Error(`${label} is invalid.`);
  }
  decoded.fill(0);
  return encoded;
}

function parseConnectorRestoreRuntimeSecrets(value: unknown): ConnectorRestoreRuntimeSecrets {
  const row = object(value);
  exactKeys(row, ['schemaVersion', 'service', 'serviceRuntime', 'serviceIdentitySecretBase64',
    'invocationGrantSecretBase64', 'credentialEncryptionKeyBase64', 'invocationEncryptionKeys'], ['redisPassword']);
  if (row.schemaVersion !== 1 || row.service !== 'connector') throw new Error('Connector restore runtime secrets are invalid.');
  const identity = ConnectorReplicaIdentitySchema.parse(row.serviceRuntime);
  const source = object(row.invocationEncryptionKeys);
  exactKeys(source, ['keyRef', 'activeVersion', 'keys']);
  const keyRef = boundedString(source.keyRef, 256, 'invocation key reference');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/.test(keyRef)
    || typeof source.activeVersion !== 'number' || !Number.isSafeInteger(source.activeVersion)
    || source.activeVersion < 1 || source.activeVersion > 2_147_483_647) {
    throw new Error('Connector restore invocation keys are invalid.');
  }
  const keys = object(source.keys);
  if (Object.keys(keys).length < 1 || Object.keys(keys).some((version) => !/^[1-9][0-9]{0,9}$/.test(version))) {
    throw new Error('Connector restore invocation key versions are invalid.');
  }
  const checkedKeys: Record<string, string> = {};
  for (const [version, material] of Object.entries(keys)) checkedKeys[version] = decodeSecretMaterial(material, 'invocation key');
  if (checkedKeys[String(source.activeVersion)] === undefined) throw new Error('Connector restore active invocation key is absent.');
  const redisPassword = row.redisPassword === undefined ? undefined : boundedString(row.redisPassword, 4096, 'Redis password');
  return {
    schemaVersion: 1, service: 'connector', serviceRuntime: identity,
    serviceIdentitySecretBase64: decodeSecretMaterial(row.serviceIdentitySecretBase64, 'service identity key'),
    invocationGrantSecretBase64: decodeSecretMaterial(row.invocationGrantSecretBase64, 'invocation grant key'),
    credentialEncryptionKeyBase64: decodeSecretMaterial(row.credentialEncryptionKeyBase64, 'credential encryption key'),
    invocationEncryptionKeys: { keyRef, activeVersion: source.activeVersion, keys: checkedKeys },
    ...(redisPassword === undefined ? {} : { redisPassword }),
  };
}

function parsePgPasswordFile(value: unknown): ConnectorRestorePgPasswordFile {
  const row = object(value);
  exactKeys(row, ['schemaVersion', 'password']);
  if (row.schemaVersion !== 1) throw new Error('Connector restore Postgres password file is invalid.');
  return { schemaVersion: 1, password: boundedString(row.password, 4096, 'Postgres password') };
}

export function parseConnectorRestoreBootstrapArgs(argv: readonly string[]): ConnectorRestoreBootstrapArgs {
  const allowed = new Set([
    '--config', '--config-sha256', '--secrets', '--secrets-sha256',
    '--pg-password-file', '--pg-password-sha256', '--gate-dir',
    '--runtime-identity', '--target-generation-id', '--image-digest',
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !allowed.has(key) || !value || value.startsWith('--') || values.has(key)) {
      throw new Error('Connector restore bootstrap arguments are invalid.');
    }
    values.set(key, value);
  }
  if (values.size !== allowed.size) throw new Error('Connector restore bootstrap arguments are incomplete.');
  const result: ConnectorRestoreBootstrapArgs = {
    configPath: values.get('--config')!,
    configSha256: values.get('--config-sha256')!,
    secretsPath: values.get('--secrets')!,
    secretsSha256: values.get('--secrets-sha256')!,
    pgPasswordPath: values.get('--pg-password-file')!,
    pgPasswordSha256: values.get('--pg-password-sha256')!,
    gateDir: values.get('--gate-dir')!,
    runtimeIdentity: values.get('--runtime-identity')!,
    targetGenerationId: values.get('--target-generation-id')!,
    imageDigest: values.get('--image-digest')!,
  };
  if (result.configPath !== CONFIG_PATH || result.secretsPath !== SECRETS_PATH
    || result.pgPasswordPath !== PG_PASSWORD_PATH || result.gateDir !== GATE_DIR
    || !SHA256.test(result.configSha256) || !SHA256.test(result.secretsSha256)
    || !SHA256.test(result.pgPasswordSha256) || !SAFE_ID.test(result.runtimeIdentity)
    || !UUID.test(result.targetGenerationId) || result.imageDigest.length > 512
    || !IMAGE_DIGEST.test(result.imageDigest)) {
    throw new Error('Connector restore bootstrap pins are invalid.');
  }
  return result;
}

export async function readConnectorRestoreBootstrapFiles(
  args: ConnectorRestoreBootstrapArgs,
): Promise<ConnectorRestoreBootstrapFiles> {
  const configRaw = await readProtectedPinnedFile(args.configPath, args.configSha256, 128 * 1024);
  const secretsRaw = await readProtectedPinnedFile(args.secretsPath, args.secretsSha256, MAX_PINNED_FILE_BYTES);
  const pgPasswordRaw = await readProtectedPinnedFile(args.pgPasswordPath, args.pgPasswordSha256, 16 * 1024);
  let configValue: unknown;
  let secretsValue: unknown;
  let pgPasswordValue: unknown;
  try {
    configValue = JSON.parse(configRaw.toString('utf8')) as unknown;
    secretsValue = JSON.parse(secretsRaw.toString('utf8')) as unknown;
    pgPasswordValue = JSON.parse(pgPasswordRaw.toString('utf8')) as unknown;
  } catch {
    throw new Error('Connector restore bootstrap file is invalid.');
  } finally {
    configRaw.fill(0);
    secretsRaw.fill(0);
    pgPasswordRaw.fill(0);
  }
  const config = ConnectorRestoreRuntimeConfigSchema.parse(configValue);
  const secrets = ConnectorRestoreRuntimeSecretsSchema.parse(secretsValue);
  const password = parsePgPasswordFile(pgPasswordValue);
  if (config.runtimeIdentity !== args.runtimeIdentity
    || config.targetGenerationId !== args.targetGenerationId || config.imageDigest !== args.imageDigest
    || secrets.serviceRuntime.runtimeIdentity !== config.runtimeIdentity
    || secrets.serviceRuntime.replicaId !== config.replicaId
    || secrets.serviceRuntime.slot !== config.slot
    || secrets.serviceRuntime.revision !== config.revision
    || secrets.serviceRuntime.imageDigest !== config.imageDigest) {
    throw new Error('Connector restore bootstrap identity pins do not match.');
  }
  return { config, secrets, pgPassword: password.password, gateDir: args.gateDir };
}

export interface ConnectorRestoreComposition {
  start(): Promise<void>;
  shutdown(options?: Parameters<ConnectorComposition['shutdown']>[0]): Promise<void>;
}

export async function startConnectorIsolatedRestore(
  files: ConnectorRestoreBootstrapFiles,
  dependencies: {
    waitForGate?: (gateDir: string, signal?: AbortSignal) => Promise<void>;
    createComposition?: (config: ConnectorConfig) => ConnectorRestoreComposition;
  } = {},
): Promise<ConnectorRestoreComposition> {
  await (dependencies.waitForGate ?? waitForConnectorRestoreGate)(files.gateDir);
  const { config, secrets } = files;
  const identity = ConnectorReplicaIdentitySchema.parse({
    slot: config.slot,
    runtimeIdentity: config.runtimeIdentity,
    replicaId: config.replicaId,
    revision: config.revision,
    imageDigest: config.imageDigest,
  });
  const invocationKeyConfig = JSON.stringify(secrets.invocationEncryptionKeys);
  const invocationStorageCrypto = resolveInvocationStorageCryptoFromEnv({
    CONNECTOR_INVOCATION_ENCRYPTION_KEYS: invocationKeyConfig,
    CONNECTOR_INVOCATION_LEGACY_PLAINTEXT_READS: 'false',
  });
  const configForComposition: ConnectorConfig = {
    port: config.port,
    host: config.bindHost,
    databaseUrl: postgresUrl(config),
    databasePassword: () => files.pgPassword,
    databaseSsl: config.database.sslMode === 'disable'
      ? false
      : { rejectUnauthorized: config.database.sslMode === 'verify-full' },
    redisUrl: redisUrl(config, secrets.redisPassword),
    serviceIdentityVerifier: new HmacServiceIdentityVerifier(decodeSecret(secrets.serviceIdentitySecretBase64)),
    grantVerifier: new ContractSignedGrantVerifier(new HmacSignedGrantSource(decodeSecret(secrets.invocationGrantSecretBase64))),
    providerTestGrantVerifier: new ContractSignedProviderTestGrantVerifier(new HmacSignedGrantSource(decodeSecret(secrets.invocationGrantSecretBase64))),
    credentialCipher: new AesCredentialCipher(decodeSecret(secrets.credentialEncryptionKeyBase64)),
    invocationStorageCrypto,
    runtimeControl: identity,
    isolatedRestoreRehearsal: true,
    vaultRuntime: null,
  };
  const composition = (dependencies.createComposition ?? createConnectorComposition)(configForComposition);
  try {
    await composition.start();
  } catch (error) {
    await composition.shutdown().catch(() => undefined);
    throw error;
  }
  return composition;
}

export async function runConnectorIsolatedRestoreBootstrap(argv = process.argv.slice(2)): Promise<void> {
  if (process.getuid?.() !== 1000 || process.getgid?.() !== 1000) {
    throw new Error('Connector isolated restore bootstrap must run as its pinned UID/GID.');
  }
  const args = parseConnectorRestoreBootstrapArgs(argv);
  const files = await readConnectorRestoreBootstrapFiles(args);
  const composition = await startConnectorIsolatedRestore(files);
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void composition.shutdown().finally(resolve);
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
}

async function waitForConnectorRestoreGate(gateDir: string, signal?: AbortSignal): Promise<void> {
  if (gateDir !== GATE_DIR) throw new Error('Connector restore startup gate path is invalid.');
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Connector restore startup was stopped.');
    try {
      const directory = await lstat(gateDir);
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0 || directory.gid !== 1000
        || (directory.mode & 0o007) !== 0 || (directory.mode & 0o020) !== 0 || (directory.mode & 0o100) === 0) {
        throw new Error('Connector restore startup gate is unsafe.');
      }
      const gatePath = path.join(gateDir, 'ready');
      const bytes = await readProtectedPinnedFile(gatePath, undefined, 32);
      const ready = bytes.toString('utf8') === 'ready\n';
      bytes.fill(0);
      if (ready) return;
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Connector restore startup gate was not released.');
}

async function readProtectedPinnedFile(filePath: string, expectedSha256: string | undefined, maxBytes: number): Promise<Buffer> {
  if (!path.isAbsolute(filePath) || path.normalize(filePath) !== filePath) throw new Error('Connector restore file path is unsafe.');
  const parentPath = path.dirname(filePath);
  const parent = await lstat(parentPath);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || parent.gid !== 1000
    || (parent.mode & 0o007) !== 0 || (parent.mode & 0o020) !== 0 || (parent.mode & 0o100) === 0) {
    throw new Error('Connector restore file parent is unsafe.');
  }
  if (await realpath(parentPath) !== parentPath) throw new Error('Connector restore file parent is unsafe.');
  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.uid !== 0 || before.gid !== 1000 || before.nlink !== 1
      || (before.mode & 0o040) === 0 || (before.mode & 0o020) !== 0 || (before.mode & 0o007) !== 0
      || (before.mode & 0o111) !== 0
      || before.size < 1 || before.size > maxBytes) throw new Error('Connector restore file permissions are unsafe.');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytes.byteLength !== after.size) {
      bytes.fill(0);
      throw new Error('Connector restore file changed while it was read.');
    }
    if (expectedSha256 !== undefined
      && createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
      bytes.fill(0);
      throw new Error('Connector restore file digest is invalid.');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function postgresUrl(config: ConnectorRestoreRuntimeConfig): string {
  const host = config.database.host;
  const database = encodeURIComponent(config.databaseName);
  return `postgresql://${encodeURIComponent(config.database.user)}@${host}:${config.database.port}/${database}`;
}

function redisUrl(config: ConnectorRestoreRuntimeConfig, password?: string): string {
  const host = config.redis.host;
  const credentials = password === undefined ? '' : `:${encodeURIComponent(password)}@`;
  return `redis://${credentials}${host}:${config.redis.port}/0`;
}

function decodeSecret(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.byteLength !== 32 || decoded.toString('base64') !== value) {
    decoded.fill(0);
    throw new Error('Connector restore secret is invalid.');
  }
  return decoded;
}

if (require.main === module) {
  void runConnectorIsolatedRestoreBootstrap().catch(() => {
    process.stderr.write('Connector isolated restore bootstrap failed.\n');
    process.exitCode = 1;
  });
}
