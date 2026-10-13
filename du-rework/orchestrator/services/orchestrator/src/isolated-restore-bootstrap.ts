#!/usr/bin/env node
/**
 * Restore-only Orchestrator entrypoint. Runtime identity and secrets come from
 * root-pinned, read-only files; they are never copied into process.env, argv,
 * child environment, or logs. The start gate is checked before createApp can
 * open PostgreSQL/Redis or any listener.
 */
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { createApp, type ServerConfig } from './server';
import { TrustedIsolatedRuntimeConfigSchema } from './modules/maintenance/trusted-backup-adapter';
import { VaultTransitProvider } from './modules/encryption/vault-transit-provider';
import type { SecretCatalogKeyring } from './modules/secrets/secret-revision-resolver';

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KEY_REF = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
// These paths identify files inside the Linux restore container, regardless
// of the host OS used to validate or build this entrypoint.
const targetPath = path.posix;
const TOKEN = z.string().min(32).max(4096).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const FilePinSchema = z.object({ path: z.string().min(1).max(4096), sha256: z.string().regex(SHA256) }).strict();

const RuntimeSecretsSchema = z.object({
  schemaVersion: z.literal(1),
  service: z.literal('orchestrator'),
  serviceRuntime: z.object({
    serviceRuntimeId: z.string().regex(SAFE),
    runtimeIdentity: z.string().regex(SAFE),
    replicaId: z.string().regex(SAFE),
    slot: z.enum(['blue', 'green']),
    revision: z.string().regex(SAFE),
    imageDigest: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/i),
    controlToken: TOKEN,
  }).strict(),
  admin: z.object({
    localServiceSecret: TOKEN,
    shellCookieSecret: TOKEN,
  }).strict(),
  vaultTransit: z.object({
    vaultAddress: z.string().url().max(2048),
    allowedKeyRefs: z.record(z.string().regex(KEY_REF), z.string().regex(SAFE))
      .refine((value) => Object.keys(value).length > 0),
    transitMount: z.string().regex(SAFE).optional(),
    requestTimeoutMs: z.number().int().min(1).max(60_000).optional(),
    metadataKeyRef: z.string().regex(KEY_REF),
    publicUploadKeyRef: z.string().regex(KEY_REF),
    publicUploadKeyVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    publicUploadMaxBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    encryptToken: TOKEN,
    decryptToken: TOKEN,
  }).strict(),
  secretCatalogKeyring: z.object({
    activeVersion: z.string().regex(KEY_VERSION),
    keys: z.record(z.string().regex(KEY_VERSION), z.string().min(1).max(128)),
  }).strict(),
  // Optional legacy profile-file key. It is accepted only when the app
  // composition has an explicit in-memory profile crypto input; no env write
  // is used as a compatibility shortcut.
  profileCipherKey: z.string().min(32).max(4096).optional(),
}).strict().superRefine((value, ctx) => {
  const { serviceRuntime, admin, vaultTransit } = value;
  if (serviceRuntime.serviceRuntimeId !== serviceRuntime.runtimeIdentity
      || serviceRuntime.replicaId !== serviceRuntime.runtimeIdentity) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['serviceRuntime'], message: 'runtime identifiers must agree' });
  }
  if (vaultTransit.encryptToken === vaultTransit.decryptToken) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['vaultTransit'], message: 'Transit identities must be distinct' });
  }
  if (vaultTransit.allowedKeyRefs[vaultTransit.metadataKeyRef] === undefined
      || vaultTransit.allowedKeyRefs[vaultTransit.publicUploadKeyRef] === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['vaultTransit', 'allowedKeyRefs'], message: 'required Transit refs must be allowlisted' });
  }
  const keys = [serviceRuntime.controlToken, admin.localServiceSecret, admin.shellCookieSecret,
    vaultTransit.encryptToken, vaultTransit.decryptToken];
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['admin'], message: 'service credentials must be distinct' });
  }
});

export type IsolatedOrchestratorRuntimeSecrets = z.infer<typeof RuntimeSecretsSchema>;
export type IsolatedOrchestratorRuntimeConfig = z.infer<typeof TrustedIsolatedRuntimeConfigSchema>;

export interface IsolatedRestoreBootstrapArgs {
  configFile: string;
  configSha256: string;
  secretsFile: string;
  secretsSha256: string;
  pgPasswordFile: string;
  pgPasswordSha256: string;
  gateDirectory: string;
  runtimeIdentity: string;
  targetGenerationId: string;
  imageDigest: string;
}

function fail(code: string): never { throw new Error(code); }

/** Parse the fixed host CLI contract. Unknown/duplicate flags are rejected. */
export function parseIsolatedRestoreBootstrapArgs(argv: readonly string[]): IsolatedRestoreBootstrapArgs {
  const names: Readonly<Record<string, keyof IsolatedRestoreBootstrapArgs>> = {
    '--config': 'configFile', '--config-sha256': 'configSha256',
    '--secrets': 'secretsFile', '--secrets-sha256': 'secretsSha256',
    '--pg-password-file': 'pgPasswordFile', '--pg-password-sha256': 'pgPasswordSha256',
    '--gate-dir': 'gateDirectory', '--runtime-identity': 'runtimeIdentity',
    '--target-generation-id': 'targetGenerationId', '--image-digest': 'imageDigest',
  };
  const result: Partial<IsolatedRestoreBootstrapArgs> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !value || !Object.hasOwn(names, flag)) fail('RESTORE_BOOTSTRAP_ARGUMENTS_INVALID');
    const key = names[flag]!;
    if (Object.hasOwn(result, key)) fail('RESTORE_BOOTSTRAP_ARGUMENTS_INVALID');
    result[key] = value;
  }
  const required: (keyof IsolatedRestoreBootstrapArgs)[] = [
    'configFile', 'configSha256', 'secretsFile', 'secretsSha256', 'pgPasswordFile', 'pgPasswordSha256',
    'gateDirectory', 'runtimeIdentity', 'targetGenerationId', 'imageDigest',
  ];
  if (argv.length !== required.length * 2 || required.some((key) => typeof result[key] !== 'string')) {
    fail('RESTORE_BOOTSTRAP_ARGUMENTS_INVALID');
  }
  const parsed = result as IsolatedRestoreBootstrapArgs;
  for (const digest of [parsed.configSha256, parsed.secretsSha256, parsed.pgPasswordSha256]) {
    if (!SHA256.test(digest)) fail('RESTORE_BOOTSTRAP_ARGUMENTS_INVALID');
  }
  for (const file of [parsed.configFile, parsed.secretsFile, parsed.pgPasswordFile]) {
    if (!targetPath.isAbsolute(file) || targetPath.normalize(file) !== file) fail('RESTORE_BOOTSTRAP_ARGUMENTS_INVALID');
  }
  if (parsed.gateDirectory !== '/run/du-restore/start-gate'
      || !SAFE.test(parsed.runtimeIdentity)
      || !z.string().uuid().safeParse(parsed.targetGenerationId).success
      || !/^.+@sha256:[a-f0-9]{64}$/i.test(parsed.imageDigest)) {
    fail('RESTORE_BOOTSTRAP_ARGUMENTS_INVALID');
  }
  return parsed;
}

/** Read a root-pinned, group-readable mount without following links or races. */
export async function readIsolatedRestorePinnedFile(
  filePath: string,
  expectedSha256: string,
  maximumBytes = 1024 * 1024,
): Promise<Buffer> {
  if (!targetPath.isAbsolute(filePath) || targetPath.normalize(filePath) !== filePath || !SHA256.test(expectedSha256)) {
    fail('RESTORE_BOOTSTRAP_FILE_PIN_INVALID');
  }
  try {
    const [resolved, before, parent] = await Promise.all([
      realpath(filePath), lstat(filePath), lstat(targetPath.dirname(filePath)),
    ]);
    if (resolved !== filePath || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1
        || !parent.isDirectory() || parent.isSymbolicLink()
        || before.uid !== 0 || before.gid !== 1000 || parent.uid !== 0
        || (before.mode & 0o007) !== 0 || (before.mode & 0o020) !== 0
        || (before.mode & 0o040) === 0 || (parent.mode & 0o022) !== 0
        || before.size < 1 || before.size > maximumBytes) {
      fail('RESTORE_BOOTSTRAP_FILE_UNTRUSTED');
    }
    const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      const parentAfter = await lstat(targetPath.dirname(filePath));
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
          || opened.uid !== before.uid || opened.gid !== before.gid || opened.mode !== before.mode
          || parentAfter.dev !== parent.dev || parentAfter.ino !== parent.ino) {
        fail('RESTORE_BOOTSTRAP_FILE_CHANGED');
      }
      const bytes = await handle.readFile();
      if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
        bytes.fill(0);
        fail('RESTORE_BOOTSTRAP_FILE_DIGEST_MISMATCH');
      }
      return bytes;
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('RESTORE_BOOTSTRAP_')) throw error;
    fail('RESTORE_BOOTSTRAP_FILE_UNAVAILABLE');
  }
}

function parseJsonBuffer(bytes: Buffer, code: string): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch { return fail(code); }
  finally { bytes.fill(0); }
}

export function parseIsolatedOrchestratorRuntimeConfig(raw: unknown, args: IsolatedRestoreBootstrapArgs): IsolatedOrchestratorRuntimeConfig {
  const parsed = TrustedIsolatedRuntimeConfigSchema.safeParse(raw);
  if (!parsed.success || parsed.data.service !== 'orchestrator'
      || !parsed.data.databaseName || parsed.data.targetGenerationId !== args.targetGenerationId
      || parsed.data.runtimeIdentity !== args.runtimeIdentity || parsed.data.imageDigest !== args.imageDigest
      || parsed.data.slot === undefined || parsed.data.internalHost !== '127.0.0.1'
      || parsed.data.internalPort !== 3002 || parsed.data.adminShellHost !== '127.0.0.1'
      || parsed.data.adminShellPort === undefined) {
    fail('RESTORE_BOOTSTRAP_RUNTIME_CONFIG_INVALID');
  }
  return parsed.data;
}

export function parseIsolatedOrchestratorRuntimeSecrets(raw: unknown, config: IsolatedOrchestratorRuntimeConfig,
  mountedControlToken: string): IsolatedOrchestratorRuntimeSecrets {
  const parsed = RuntimeSecretsSchema.safeParse(raw);
  if (!parsed.success) fail('RESTORE_BOOTSTRAP_RUNTIME_SECRETS_INVALID');
  const value = parsed.data;
  const runtime = value.serviceRuntime;
  if (runtime.runtimeIdentity !== config.runtimeIdentity || runtime.serviceRuntimeId !== config.runtimeIdentity
      || runtime.replicaId !== config.runtimeIdentity || runtime.slot !== config.slot
      || runtime.revision !== config.revision || runtime.imageDigest !== config.imageDigest
      || runtime.controlToken !== mountedControlToken) {
    fail('RESTORE_BOOTSTRAP_RUNTIME_IDENTITY_MISMATCH');
  }
  const active = value.secretCatalogKeyring.activeVersion;
  if (!Object.hasOwn(value.secretCatalogKeyring.keys, active)) fail('RESTORE_BOOTSTRAP_SECRET_KEYRING_INVALID');
  for (const [version, encoded] of Object.entries(value.secretCatalogKeyring.keys)) {
    if (!KEY_VERSION.test(version)) fail('RESTORE_BOOTSTRAP_SECRET_KEYRING_INVALID');
    const key = Buffer.from(encoded, 'base64');
    const valid = key.length === 32 && key.toString('base64') === encoded;
    key.fill(0);
    if (!valid) fail('RESTORE_BOOTSTRAP_SECRET_KEYRING_INVALID');
  }
  const address = new URL(value.vaultTransit.vaultAddress);
  if (address.protocol !== 'https:' || address.username || address.password || address.search || address.hash) {
    fail('RESTORE_BOOTSTRAP_VAULT_CONFIG_INVALID');
  }
  return value;
}

function decodeKeyring(secrets: IsolatedOrchestratorRuntimeSecrets): SecretCatalogKeyring {
  const keys: Record<string, Buffer> = Object.create(null) as Record<string, Buffer>;
  for (const [version, encoded] of Object.entries(secrets.secretCatalogKeyring.keys)) {
    keys[version] = Buffer.from(encoded, 'base64');
  }
  return { activeVersion: secrets.secretCatalogKeyring.activeVersion, keys };
}

function databaseUrl(config: IsolatedOrchestratorRuntimeConfig, password: string): string {
  const url = new URL('postgresql://localhost');
  url.username = config.database.user;
  url.password = password;
  url.hostname = config.database.host;
  url.port = String(config.database.port);
  url.pathname = '/' + config.databaseName;
  url.searchParams.set('sslmode', config.database.sslMode);
  return url.toString();
}

/** Build a fail-closed read-only restore app config without consulting env. */
export function buildIsolatedRestoreServerConfig(
  config: IsolatedOrchestratorRuntimeConfig,
  secrets: IsolatedOrchestratorRuntimeSecrets,
  databasePassword: string,
): ServerConfig {
  const runtime = secrets.serviceRuntime;
  const vault = secrets.vaultTransit;
  const keyProvider = new VaultTransitProvider({
    vaultAddress: vault.vaultAddress,
    allowedKeyRefs: vault.allowedKeyRefs,
    encryptIdentity: { token: () => vault.encryptToken },
    decryptIdentity: { token: () => vault.decryptToken },
    ...(vault.transitMount ? { transitMount: vault.transitMount } : {}),
    ...(vault.requestTimeoutMs ? { requestTimeoutMs: vault.requestTimeoutMs } : {}),
  });
  const keyring = decodeKeyring(secrets);
  return {
    port: config.port,
    host: config.bindHost,
    internalPort: config.internalPort,
    internalHost: config.internalHost,
    adminShellPort: config.adminShellPort,
    adminShellHost: config.adminShellHost,
    databaseUrl: databaseUrl(config, databasePassword),
    redisUrl: `redis://${config.redis.host}:${config.redis.port}`,
    serviceRuntime: {
      serviceRuntimeId: runtime.serviceRuntimeId,
      runtimeIdentity: runtime.runtimeIdentity,
      replicaId: runtime.replicaId,
      slot: runtime.slot,
      revision: runtime.revision,
      imageDigest: runtime.imageDigest,
      controlToken: runtime.controlToken,
    },
    isolatedRuntimeMode: 'restore-rehearsal',
    autoMigrate: false,
    autoDispatch: false,
    leaseRecoveryIntervalMs: 0,
    webhookDispatchIntervalMs: 0,
    ingestionConsumer: { intervalMs: 0 },
    adminLocalAuthEnabled: true,
    adminLocalServiceSecret: secrets.admin.localServiceSecret,
    adminShellCookieSecret: secrets.admin.shellCookieSecret,
    adminIdentityAuth: { mode: 'local', localEnabled: true, oidc: null },
    secretCatalogKeyring: keyring,
    cryptoConfig: { allowedKeyRefs: Object.keys(vault.allowedKeyRefs) },
    metadataEncryption: { keyProvider, keyRef: vault.metadataKeyRef },
    publicUploadEncryption: {
      keyProvider,
      keyRef: vault.publicUploadKeyRef,
      ...(vault.publicUploadKeyVersion === undefined ? {} : { keyVersion: vault.publicUploadKeyVersion }),
      ...(vault.publicUploadMaxBytes === undefined ? {} : { maxBytes: vault.publicUploadMaxBytes }),
    },
    ...(secrets.profileCipherKey ? { profileCipherKey: secrets.profileCipherKey } : {}),
    encryptionPolicy: {
      dataMode: 'real',
      metadataEncryption: true,
      publicUploadEncryption: true,
      metadataPlaintextReadMode: 'forbid',
      profileCipherKeyPresent: Boolean(secrets.profileCipherKey),
    },
  };
}

function decodePassword(bytes: Buffer): string {
  try {
    const password = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (password.length < 1 || password.length > 4096 || /[\u0000-\u001f\u007f]/.test(password)) {
      fail('RESTORE_BOOTSTRAP_DATABASE_PASSWORD_INVALID');
    }
    return password;
  } catch { return fail('RESTORE_BOOTSTRAP_DATABASE_PASSWORD_INVALID'); }
  finally { bytes.fill(0); }
}

async function waitForStartGate(gateDirectory: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const markerPath = targetPath.join(gateDirectory, 'ready');
  while (Date.now() < deadline) {
    try {
      const [directory, marker] = await Promise.all([lstat(gateDirectory), lstat(markerPath)]);
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0
          || marker.isSymbolicLink() || !marker.isFile() || marker.uid !== 0 || marker.gid !== 1000
          || (marker.mode & 0o007) !== 0 || (marker.mode & 0o020) !== 0 || (marker.mode & 0o040) === 0) {
        fail('RESTORE_BOOTSTRAP_START_GATE_UNTRUSTED');
      }
      const handle = await open(markerPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      let bytes: Buffer;
      try { bytes = await handle.readFile(); } finally { await handle.close(); }
      const ready = bytes.equals(Buffer.from('ready\n', 'utf8'));
      bytes.fill(0);
      if (ready) return;
      fail('RESTORE_BOOTSTRAP_START_GATE_INVALID');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('RESTORE_BOOTSTRAP_START_GATE')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  fail('RESTORE_BOOTSTRAP_START_GATE_TIMEOUT');
}

async function readMountedControlToken(): Promise<string> {
  const filePath = '/run/du-restore/control-token';
  let fd;
  try {
    const [before, parent, resolved] = await Promise.all([
      lstat(filePath), lstat(targetPath.dirname(filePath)), realpath(filePath),
    ]);
    if (resolved !== filePath || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1
        || !parent.isDirectory() || parent.isSymbolicLink() || before.uid !== 0 || before.gid !== 1000
        || parent.uid !== 0 || (parent.mode & 0o022) !== 0
        || (before.mode & 0o007) !== 0 || (before.mode & 0o020) !== 0 || (before.mode & 0o040) === 0
        || before.size < 32 || before.size > 4096) {
      fail('RESTORE_BOOTSTRAP_CONTROL_TOKEN_UNTRUSTED');
    }
    fd = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await fd.stat();
    const parentAfter = await lstat(targetPath.dirname(filePath));
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
        || opened.uid !== before.uid || opened.gid !== before.gid || opened.mode !== before.mode
        || parentAfter.dev !== parent.dev || parentAfter.ino !== parent.ino) {
      fail('RESTORE_BOOTSTRAP_CONTROL_TOKEN_CHANGED');
    }
    const bytes = await fd.readFile();
    try {
      const tokenWithNewline = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const token = tokenWithNewline.replace(/\r?\n$/, '');
      if (token.length < 32 || token.length > 4096 || /[\u0000-\u001f\u007f]/.test(token)) {
        fail('RESTORE_BOOTSTRAP_CONTROL_TOKEN_INVALID');
      }
      return token;
    } finally { bytes.fill(0); }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('RESTORE_BOOTSTRAP_')) throw error;
    return fail('RESTORE_BOOTSTRAP_CONTROL_TOKEN_UNAVAILABLE');
  } finally { await fd?.close().catch(() => undefined); }
}

/** Exposed for the shipped process and deterministic owner tests. */
export async function runIsolatedRestoreOrchestrator(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseIsolatedRestoreBootstrapArgs(argv);
  const configBytes = await readIsolatedRestorePinnedFile(args.configFile, args.configSha256, 64 * 1024);
  const config = parseIsolatedOrchestratorRuntimeConfig(parseJsonBuffer(configBytes, 'RESTORE_BOOTSTRAP_RUNTIME_CONFIG_INVALID'), args);
  const secretsBytes = await readIsolatedRestorePinnedFile(args.secretsFile, args.secretsSha256, 256 * 1024);
  const rawSecrets = parseJsonBuffer(secretsBytes, 'RESTORE_BOOTSTRAP_RUNTIME_SECRETS_INVALID');
  // The Host manifest pins the source token file and mounts that exact file
  // read-only at this fixed path. Validate the mount before comparing it with
  // the separately pinned runtime secrets.
  const controlToken = await readMountedControlToken();
  const secrets = parseIsolatedOrchestratorRuntimeSecrets(rawSecrets, config, controlToken);
  const passwordBytes = await readIsolatedRestorePinnedFile(args.pgPasswordFile, args.pgPasswordSha256, 8192);
  const password = decodePassword(passwordBytes);
  await waitForStartGate(args.gateDirectory);
  const app = await createApp(buildIsolatedRestoreServerConfig(config, secrets, password));
  try {
    await app.listen();
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close().catch(() => undefined);
  };
  process.once('SIGTERM', () => { void close().finally(() => { process.exitCode = 0; }); });
  process.once('SIGINT', () => { void close().finally(() => { process.exitCode = 0; }); });
}

if (require.main === module) {
  void runIsolatedRestoreOrchestrator().catch((error: unknown) => {
    const code = error instanceof Error && /^RESTORE_BOOTSTRAP_[A-Z0-9_]+$/.test(error.message)
      ? error.message : 'RESTORE_BOOTSTRAP_FAILED';
    process.stderr.write(code + '\n');
    process.exitCode = 1;
  });
}
