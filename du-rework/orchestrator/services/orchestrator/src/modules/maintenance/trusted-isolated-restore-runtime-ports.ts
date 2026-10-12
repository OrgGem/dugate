import { createCipheriv, createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, chown, lstat, mkdir, open, realpath, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { Script } from 'node:vm';
import { isIP } from 'node:net';
import https from 'node:https';
import path from 'node:path';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { CryptoStorageFacade, CRYPTO_STORAGE_MAX_DECRYPT_BYTES, CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES,
  type EncryptedStorageManifest, type EncryptedStorageObject } from '../encryption/crypto-storage-facade';
import { PUBLIC_UPLOAD_PURPOSE } from '../encryption/artifact-read-decrypt';
import { decryptSecretValue } from '../secrets/secret-catalog-store';
import { createMetadataCrypto, metadataPlaintextHash, type MetadataContext } from '../runtime/metadata-crypto';
import { createMaintenanceRecoveryKeyResolver } from './recovery-key-file';
import {
  readTrustedIsolatedRestoreRuntimeManifest,
  TrustedRestoreReaderConfigSchema,
  TrustedIsolatedRuntimeConfigSchema,
  type TrustedMaintenanceManifest,
} from './trusted-backup-adapter';
import type {
  ApplicationRestoreObservation,
  DatabaseControlObservation,
  DatabaseCountsObservation,
  OwnedRestoreRuntimeHandle,
  RestoreArtifactDownloadObservation,
  RestoreArtifactRecoveryItem,
  RestoreApplicationReaderPort,
  RestoreDatabaseControlPort,
  RestoreDatabaseIdentity,
  RestoreDatabaseReaderPort,
  RestoreRecoveryReaderPort,
  RestoreRuntimeHealthPort,
  RestoreRuntimeLaunchPlan,
  RestoreRuntimeLaunchPort,
  RuntimeHealthObservation,
  RestoreSourceIsolationPort,
  RestoreSourceRef,
  SourceIsolationObservation,
} from './trusted-isolated-restore-probe';

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
const RECOVERY_REF = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,511}$/;
const DB_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/;
const SOURCE_REFS: readonly RestoreSourceRef[] = [
  'orchestratorSourceDb', 'connectorSourceDb', 'sourceCatalogKeyring', 'sourceConnectorRecoveryRegistry',
  'sourceMetadataTransit', 'sourceArtifactTransit', 'sourceVault',
];
const MAX_STDOUT = 2 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 90_000;
const CLEANUP_TIMEOUT_MS = 45_000;
const GATE_WAIT_TIMEOUT_MS = 60_000;

type Manifest = TrustedMaintenanceManifest;
type HostConfig = Manifest['isolatedHost'];
type RuntimePorts = {
  launch: RestoreRuntimeLaunchPort;
  health: RestoreRuntimeHealthPort;
  control: RestoreDatabaseControlPort;
  sourceIsolation: RestoreSourceIsolationPort;
  databaseReader: RestoreDatabaseReaderPort;
  applicationReader: RestoreApplicationReaderPort;
  recoveryReader: RestoreRecoveryReaderPort;
};
type RuntimeState = {
  handle: OwnedRestoreRuntimeHandle;
  plan: RestoreRuntimeLaunchPlan;
  id: string;
  pid: number;
  workDirectory: string;
  gateDirectory: string;
  configPath: string;
  cidFilePath: string;
  ready: boolean;
  stopped: boolean;
  lastBootId?: string;
  lastObservation?: Record<string, unknown>;
};

type ArtifactRow = {
  artifactId: string;
  tenantId: string;
  storageKey: string;
  storageVersionId: string;
  manifestVersionId: string | null;
  uploadToken: string;
  mimeType: string;
  storedSha256: string;
  storedByteSize: number;
  generationId: string;
  purpose: string;
  apiKeyId: string;
};

const LoginCredentialSchema = z.object({ username: z.string().min(1).max(256), password: z.string().min(1).max(4096) }).strict();
const ApiKeyCredentialSchema = z.object({ apiKey: z.string().min(16).max(4096), apiKeyId: z.string().uuid() }).strict();

function failure(code: string): Error { return new Error(code); }
function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nowIso(): string { return new Date().toISOString(); }
function abortIfNeeded(signal: AbortSignal): void { if (signal.aborted) throw failure('RESTORE_RUNTIME_PROBE_TIMEOUT'); }

async function readRootPinnedFile(file: { path: string; sha256: string }, maximum = 4 * 1024 * 1024): Promise<Buffer> {
  if (!path.isAbsolute(file.path) || path.normalize(file.path) !== file.path || !SHA256.test(file.sha256)) {
    throw failure('RESTORE_RUNTIME_PIN_INVALID');
  }
  const real = await realpath(file.path);
  const [target, parent] = await Promise.all([lstat(file.path), lstat(path.dirname(file.path))]);
  if (real !== file.path || !target.isFile() || target.isSymbolicLink() || target.nlink !== 1 || !parent.isDirectory() || parent.isSymbolicLink()
    || target.uid !== 0 || parent.uid !== 0 || (target.mode & 0o022) !== 0 || (parent.mode & 0o022) !== 0
    || target.size < 1 || target.size > maximum) throw failure('RESTORE_RUNTIME_PIN_INVALID');
  const handle = await open(file.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    const currentParent = await lstat(path.dirname(file.path));
    if (opened.dev !== target.dev || opened.ino !== target.ino || opened.size !== target.size || opened.uid !== target.uid
      || opened.gid !== target.gid || opened.mode !== target.mode || currentParent.dev !== parent.dev || currentParent.ino !== parent.ino) {
      throw failure('RESTORE_RUNTIME_PIN_CHANGED');
    }
    const bytes = await handle.readFile();
    if (sha256(bytes) !== file.sha256) throw failure('RESTORE_RUNTIME_PIN_DIGEST_MISMATCH');
    return bytes;
  } finally { await handle.close(); }
}

async function readProtectedPinnedFile(
  file: { path: string; sha256: string },
  maximum = 64 * 1024,
  runtimeReader = false,
): Promise<Buffer> {
  const bytes = await readRootPinnedFile(file, maximum);
  const details = await stat(file.path);
  if ((details.mode & fsConstants.S_IROTH) !== 0 || (details.mode & fsConstants.S_IWOTH) !== 0
    || (runtimeReader && (details.gid !== 1000 || (details.mode & fsConstants.S_IRGRP) === 0))
    || (!runtimeReader && details.gid !== 0 && (details.gid !== 1000 || (details.mode & fsConstants.S_IRGRP) === 0))) {
    bytes.fill(0);
    throw failure('RESTORE_RUNTIME_SECRET_PIN_UNTRUSTED');
  }
  return bytes;
}

type CommandResult = { exitCode: number; stdout: Buffer; timedOut: boolean };

/** Bounded command runner: no shell, no inherited application credentials, no stderr capture. */
function runCommand(
  executable: string,
  args: readonly string[],
  input: { signal: AbortSignal; timeoutMs?: number; stdin?: Buffer; maxStdoutBytes?: number },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const signal = input.signal;
    if (signal.aborted) { reject(failure('RESTORE_RUNTIME_PROBE_TIMEOUT')); return; }
    let child: ChildProcess;
    let stdout = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;
    const timeout = input.timeoutMs ?? COMMAND_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (code: number | null, error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', onAbort);
      if (error || timedOut || code !== 0) { reject(failure(timedOut || signal.aborted ? 'RESTORE_RUNTIME_COMMAND_TIMEOUT' : 'RESTORE_RUNTIME_COMMAND_FAILED')); return; }
      resolve({ exitCode: code, stdout, timedOut: false });
    };
    const terminate = () => {
      timedOut = true;
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch { /* already exited */ }
      killTimer = setTimeout(() => {
        try {
          if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { /* already exited */ }
      }, 750);
      killTimer.unref?.();
    };
    const onAbort = () => terminate();
    try {
      child = spawn(executable, [...args], {
        shell: false, detached: process.platform !== 'win32', windowsHide: true,
        env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', NO_COLOR: '1' },
        stdio: [input.stdin ? 'pipe' : 'ignore', 'pipe', 'ignore'],
      });
    } catch (error) { finish(null, error); return; }
    child.stdout?.on('data', (chunk: Buffer) => {
      const next = stdout.length + chunk.length;
      if (next > (input.maxStdoutBytes ?? MAX_STDOUT)) { terminate(); return; }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.once('error', (error) => finish(null, error));
    child.once('close', (code) => finish(code));
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(terminate, timeout);
    timer.unref?.();
    if (input.stdin) child.stdin?.end(input.stdin);
  });
}

function requireZeroOrThrow(code: number, stdout: Buffer, expectJson = false): unknown {
  if (code !== 0) throw failure('RESTORE_RUNTIME_COMMAND_FAILED');
  if (!expectJson) return undefined;
  try { return JSON.parse(stdout.toString('utf8')) as unknown; } catch { throw failure('RESTORE_RUNTIME_COMMAND_OUTPUT_INVALID'); }
}

function applyTemplate(args: readonly string[], values: Readonly<Record<string, string>>): string[] {
  return args.map((arg) => arg.replace(/\$\{([A-Z_]+)\}/g, (_whole, key: string) => {
    const value = values[key];
    if (value === undefined || /[\u0000\r\n]/.test(value)) throw failure('RESTORE_RUNTIME_ARGV_TEMPLATE_INVALID');
    return value;
  }));
}

function parseContainerInspection(text: string): {
  id: string; image: string; user: string; running: boolean; pid: number; mode: string; networks: Array<{ name: string; id: string }>;
} {
  const parts = text.trim().split('|');
  if (parts.length !== 7) throw failure('RESTORE_RUNTIME_INSPECTION_INVALID');
  const id = parts[0] ?? '';
  const image = parts[1] ?? '';
  const user = parts[2] ?? '';
  const running = parts[3] === 'true';
  const pid = Number(parts[4]);
  const mode = parts[5] ?? '';
  const networksText = parts[6] ?? '';
  const networks: Array<{ name: string; id: string }> = [];
  if (networksText !== '') {
    for (const entry of networksText.split(';').filter(Boolean)) {
      const match = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,127})=([a-f0-9]{64})$/i.exec(entry);
      if (!match) throw failure('RESTORE_RUNTIME_INSPECTION_INVALID');
      networks.push({ name: match[1]!, id: match[2]! });
    }
  }
  if (!/^[a-f0-9]{64}$/i.test(id) || !image || !user || !Number.isSafeInteger(pid) || pid < 0
    || (parts[3] !== 'true' && parts[3] !== 'false')) throw failure('RESTORE_RUNTIME_INSPECTION_INVALID');
  return { id, image, user, running, pid, mode, networks };
}

type NftRule = Record<string, unknown>;

function nftMatch(rule: NftRule, protocol: 'ip' | 'ip6' | 'tcp', field: 'daddr' | 'dport', expected: string | number): boolean {
  if (!Array.isArray(rule.expr)) return false;
  return rule.expr.some((entry) => {
    if (!isRecord(entry) || !isRecord(entry.match)) return false;
    const match = entry.match;
    if (match.op !== '==') return false;
    const left = match.left;
    if (!isRecord(left) || !isRecord(left.payload)) return false;
    return left.payload.protocol === protocol && left.payload.field === field && match.right === expected;
  });
}

function nftTcp(rule: NftRule): boolean {
  if (!Array.isArray(rule.expr)) return false;
  return rule.expr.some((entry) => isRecord(entry) && isRecord(entry.match)
    && entry.match.op === '==' && isRecord(entry.match.left) && isRecord(entry.match.left.meta)
    && entry.match.left.meta.key === 'l4proto' && entry.match.right === 'tcp');
}

function nftVerdict(rule: NftRule, verdict: 'drop' | 'reject' | 'accept'): boolean {
  return Array.isArray(rule.expr) && rule.expr.some((entry) => isRecord(entry) && verdict in entry);
}

function hasBoundedEstablishedAccept(rule: NftRule): boolean {
  if (!Array.isArray(rule.expr)) return false;
  return rule.expr.some((entry) => isRecord(entry) && isRecord(entry.match)
    && entry.match.op === 'in' && isRecord(entry.match.left) && isRecord(entry.match.left.ct)
    && entry.match.left.ct.key === 'state' && isRecord(entry.match.right)
    && Array.isArray(entry.match.right.set)
    && entry.match.right.set.length > 0
    && entry.match.right.set.every((state) => state === 'established' || state === 'related'));
}

export function verifyNftPolicy(
  value: unknown,
  host: {
    networkPolicy: { sourceRuleIds: Record<RestoreSourceRef, string> };
    sourceEndpoints: Record<RestoreSourceRef, { host: string; port: number }>;
  },
): void {
  if (!isRecord(value) || !Array.isArray(value.nftables)) throw failure('RESTORE_RUNTIME_NETWORK_POLICY_INVALID');
  const entries = value.nftables;
  const chains = entries.flatMap((entry) => isRecord(entry) && isRecord(entry.chain) ? [entry.chain] : []);
  const rules: NftRule[] = entries.flatMap((entry) => isRecord(entry) && isRecord(entry.rule) ? [entry.rule] : []);
  const outputChains = chains.filter((chain) => chain.family === 'inet' && chain.table === 'du_restore'
    && chain.name === 'output' && chain.hook === 'output');
  const output = outputChains[0];
  if (outputChains.length !== 1 || !output || output.policy !== 'drop') throw failure('RESTORE_RUNTIME_NETWORK_POLICY_INVALID');
  for (const ref of SOURCE_REFS) {
    const endpoint = host.sourceEndpoints[ref];
    const ip = endpoint.host.startsWith('[') ? endpoint.host.slice(1, -1) : endpoint.host;
    const addressProtocol = isIP(ip) === 6 ? 'ip6' : 'ip';
    const ruleId = host.networkPolicy.sourceRuleIds[ref];
    const named = rules.filter((candidate) => candidate.family === 'inet' && candidate.table === 'du_restore'
      && candidate.chain === 'output' && candidate.comment === ruleId);
    const rule = named[0];
    if (named.length !== 1 || !rule || !nftMatch(rule, addressProtocol, 'daddr', ip)
      || !nftMatch(rule, 'tcp', 'dport', endpoint.port) || !nftTcp(rule)
      || !(nftVerdict(rule, 'drop') || nftVerdict(rule, 'reject'))) {
      throw failure('RESTORE_RUNTIME_NETWORK_POLICY_INVALID');
    }
  }
  for (const rule of rules.filter((candidate) => candidate.family === 'inet' && candidate.table === 'du_restore'
    && candidate.chain === 'output' && nftVerdict(candidate, 'accept'))) {
    if (hasBoundedEstablishedAccept(rule)) continue;
    // Broad accepts can shadow a later source-specific deny rule. Every new
    // outbound flow must therefore have a concrete destination and port.
    const hasAnyExactDestination = Array.isArray(rule.expr) && rule.expr.some((entry) => {
      if (!isRecord(entry) || !isRecord(entry.match) || entry.match.op !== '==') return false;
      const left = entry.match.left;
      return isRecord(left) && isRecord(left.payload) && left.payload.field === 'daddr'
        && (left.payload.protocol === 'ip' || left.payload.protocol === 'ip6')
        && typeof entry.match.right === 'string' && isIP(entry.match.right) !== 0;
    });
    const hasPort = Array.isArray(rule.expr) && rule.expr.some((entry) => isRecord(entry)
      && isRecord(entry.match) && entry.match.op === '==' && isRecord(entry.match.left)
      && isRecord(entry.match.left.payload) && entry.match.left.payload.protocol === 'tcp'
      && entry.match.left.payload.field === 'dport' && Number.isInteger(entry.match.right)
      && Number(entry.match.right) > 0 && Number(entry.match.right) <= 65535);
    if (!hasAnyExactDestination || !hasPort || !nftTcp(rule)) throw failure('RESTORE_RUNTIME_NETWORK_POLICY_INVALID');
    const destinationIsSource = SOURCE_REFS.some((ref) => {
      const endpoint = host.sourceEndpoints[ref];
      const ip = endpoint.host.startsWith('[') ? endpoint.host.slice(1, -1) : endpoint.host;
      const protocol = isIP(ip) === 6 ? 'ip6' : 'ip';
      return nftMatch(rule, protocol, 'daddr', ip);
    });
    if (destinationIsSource) throw failure('RESTORE_RUNTIME_NETWORK_POLICY_INVALID');
  }
}

function conninfo(serviceName: string, databaseName: string): string {
  if (!SAFE.test(serviceName) || !DB_NAME.test(databaseName)) throw failure('RESTORE_RUNTIME_DATABASE_IDENTITY_INVALID');
  return `service=${serviceName} dbname=${databaseName}`;
}

function sqlLiteral(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

function parsePsqlPipeCounts(stdout: Buffer, keys: readonly string[]): Record<string, number> {
  const text = stdout.toString('utf8').trim();
  const values = text.split('|');
  if (values.length !== keys.length) throw failure('RESTORE_RUNTIME_DATABASE_COUNTS_INVALID');
  const output: Record<string, number> = {};
  for (let index = 0; index < keys.length; index += 1) {
    const value = Number(values[index]);
    if (!Number.isSafeInteger(value) || value < 0) throw failure('RESTORE_RUNTIME_DATABASE_COUNTS_INVALID');
    output[keys[index]!] = value;
  }
  return output;
}

const ORCH_COUNT_SQL = `SELECT
 (SELECT count(*) FROM operations)::bigint,
 (SELECT count(*) FROM artifacts WHERE state<>'DELETED')::bigint,
 (SELECT count(*) FROM artifacts WHERE state='READY')::bigint,
 (SELECT count(*) FROM secret_catalog_revisions)::bigint,
 (SELECT count(*) FROM storage_generations)::bigint,
 (SELECT count(*) FROM secret_catalog_imports)::bigint,
 (SELECT count(*) FROM connector_secret_imports)::bigint,
 (SELECT count(*) FROM global_settings_tenant_revisions)::bigint,
 (SELECT count(*) FROM global_settings_retention_revisions)::bigint,
 (SELECT count(*) FROM cost_budget_revisions)::bigint,
 (SELECT count(*) FROM cost_price_revisions)::bigint,
 (SELECT count(*) FROM cost_reservation_groups)::bigint,
 (SELECT count(*) FROM cost_budget_holds)::bigint,
 (SELECT count(*) FROM usage_financial_adjustments)::bigint,
 (SELECT count(*) FROM usage_financial_adjustment_heads)::bigint,
 (SELECT count(*) FROM usage_financial_adjustment_commands)::bigint`;
const CONN_COUNT_SQL = `SELECT
 (SELECT count(*) FROM connector_invocations)::bigint,
 (SELECT count(*) FROM connector_usage_outbox)::bigint,
 (SELECT count(*) FROM secret_versions)::bigint,
 (SELECT count(*) FROM connector_revisions)::bigint,
 (SELECT count(*) FROM connector_replica_runtime_controls)::bigint,
 (SELECT count(*) FROM connector_parity_chains)::bigint,
 (SELECT count(*) FROM connector_parity_revisions)::bigint,
 (SELECT count(*) FROM connector_parity_claim_intents)::bigint,
 (SELECT count(*) FROM connector_parity_draft_intents)::bigint`;
const ORCH_COUNT_KEYS = ['operations','artifacts','readyArtifacts','secretRevisions','storageGenerations','secretCatalogImports','connectorSecretImports',
  'globalSettingsRevisions','retentionRevisions','budgetRevisions','priceRevisions','reservationGroups','budgetHolds',
  'financialAdjustments','financialAdjustmentHeads','financialAdjustmentCommands'] as const;
const CONN_COUNT_KEYS = ['connectorInvocations','connectorUsageEvents','connectorSecretVersions','connectorRevisions','connectorRuntimeControls',
  'connectorParityChains','connectorParityRevisions','connectorParityClaimIntents','connectorParityDraftIntents'] as const;

function createTrustedPsqlReader(manifest: Manifest) {
  const host = manifest.isolatedHost;
  const env = {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', NO_COLOR: '1',
    PGSERVICEFILE: host.libpq.serviceFile.path, PGPASSFILE: host.libpq.passFile.path, PGCONNECT_TIMEOUT: '10',
  };
  const query = async (database: RestoreDatabaseIdentity, sql: string, signal: AbortSignal, max = 1024 * 1024) => {
    abortIfNeeded(signal);
    if (!manifest.tools.psql.path || !SAFE.test(database.serviceName) || !DB_NAME.test(database.databaseName)) {
      throw failure('RESTORE_RUNTIME_DATABASE_IDENTITY_INVALID');
    }
    const args = ['--no-psqlrc', '--quiet', `--dbname=${conninfo(database.serviceName, database.databaseName)}`, '--set=ON_ERROR_STOP=1',
      '--tuples-only', '--no-align', '--field-separator=|'];
    // Query text, including any protected comparison values, travels over
    // stdin. It never appears in the child process argv or process listings.
    return runToolWithEnv(manifest.tools.psql.path, args, env, signal, max, Buffer.from(`${sql.trimEnd()}\n`, 'utf8'));
  };
  const queryLines = (database: RestoreDatabaseIdentity, sql: string, signal: AbortSignal,
    limits: { maxBytes?: number; maxLineBytes?: number; timeoutMs?: number } = {}): AsyncIterable<string> => ({
    async *[Symbol.asyncIterator]() {
      abortIfNeeded(signal);
      if (!SAFE.test(database.serviceName) || !DB_NAME.test(database.databaseName)) throw failure('RESTORE_RUNTIME_DATABASE_IDENTITY_INVALID');
      const args = ['--no-psqlrc', '--quiet', `--dbname=${conninfo(database.serviceName, database.databaseName)}`, '--set=ON_ERROR_STOP=1',
        '--tuples-only', '--no-align', '--field-separator=|'];
      let child: ChildProcess;
      try { child = spawn(manifest.tools.psql.path, args, { shell: false, detached: process.platform !== 'win32', windowsHide: true,
        env, stdio: ['pipe','pipe','ignore'] }); }
      catch { throw failure('RESTORE_RUNTIME_DATABASE_QUERY_FAILED'); }
      let closed = false;
      let exitCode: number | null = null;
      let timedOut = false;
      let totalBytes = 0;
      let pending = Buffer.alloc(0);
      let grace: NodeJS.Timeout | undefined;
      const closedPromise = new Promise<void>((resolve) => child.once('close', (code) => { closed = true; exitCode = code; resolve(); }));
      const terminate = () => {
        timedOut = true;
        try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { /* child exited */ }
        grace = setTimeout(() => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* child exited */ } }, 750);
        grace.unref?.();
      };
      const onAbort = () => terminate();
      const timeout = setTimeout(terminate, limits.timeoutMs ?? 5 * 60_000);
      timeout.unref?.();
      signal.addEventListener('abort', onAbort, { once: true });
      child.stdin?.end(`${sql.trimEnd()}\n`);
      try {
        for await (const chunkValue of child.stdout!) {
          abortIfNeeded(signal);
          const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
          totalBytes += chunk.length;
          if (!Number.isSafeInteger(totalBytes) || totalBytes > (limits.maxBytes ?? 256 * 1024 * 1024)) {
            terminate(); throw failure('RESTORE_RUNTIME_DATABASE_OUTPUT_TOO_LARGE');
          }
          pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
          if (pending.length > (limits.maxLineBytes ?? 4 * 1024 * 1024) && pending.indexOf(0x0a) < 0) {
            terminate(); throw failure('RESTORE_RUNTIME_DATABASE_ROW_TOO_LARGE');
          }
          for (;;) {
            const end = pending.indexOf(0x0a);
            if (end < 0) break;
            const line = pending.subarray(0, end).toString('utf8');
            pending = Buffer.from(pending.subarray(end + 1));
            if (line !== '') yield line;
          }
        }
        await closedPromise;
        abortIfNeeded(signal);
        if (timedOut || exitCode !== 0) throw failure(timedOut ? 'RESTORE_RUNTIME_DATABASE_QUERY_TIMEOUT' : 'RESTORE_RUNTIME_DATABASE_QUERY_FAILED');
        if (pending.length) {
          if (pending.length > (limits.maxLineBytes ?? 4 * 1024 * 1024)) throw failure('RESTORE_RUNTIME_DATABASE_ROW_TOO_LARGE');
          yield pending.toString('utf8');
        }
      } catch (error) {
        if (!closed) terminate();
        await Promise.race([closedPromise, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
        throw error instanceof Error && /^RESTORE_/.test(error.message) ? error : failure('RESTORE_RUNTIME_DATABASE_QUERY_FAILED');
      } finally {
        clearTimeout(timeout);
        if (grace) clearTimeout(grace);
        signal.removeEventListener('abort', onAbort);
        if (!closed) { terminate(); await Promise.race([closedPromise, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]); }
      }
    },
  });
  return { query, queryLines };
}

type RecoveryRuntime = {
  config: z.infer<typeof TrustedRestoreReaderConfigSchema>;
  registryIdentity: string;
  resolveKey: ReturnType<typeof createMaintenanceRecoveryKeyResolver>;
};

async function loadRecoveryRuntime(manifest: Manifest): Promise<RecoveryRuntime> {
  const host = manifest.isolatedHost;
  const configBytes = await readProtectedPinnedFile(host.recoveryReaders.configFile, 2 * 1024 * 1024);
  let raw: unknown;
  try { raw = JSON.parse(configBytes.toString('utf8')) as unknown; }
  catch { configBytes.fill(0); throw failure('RESTORE_RECOVERY_CONFIG_INVALID'); }
  configBytes.fill(0);
  const parsed = TrustedRestoreReaderConfigSchema.safeParse(raw);
  if (!parsed.success) throw failure('RESTORE_RECOVERY_CONFIG_INVALID');
  const config = parsed.data;
  if (config.targetStorageGenerationId !== '${TARGET_STORAGE_GENERATION_ID}'
    || config.objectStore.endpoint !== manifest.isolatedStorage.endpoint
    || config.objectStore.bucket !== manifest.isolatedStorage.bucket
    || config.objectStore.region !== manifest.isolatedStorage.region
    || config.objectStore.forcePathStyle !== manifest.isolatedStorage.forcePathStyle
    || config.objectStore.credentialSource.credentialVersionRef !== manifest.isolatedStorage.credentialVersionRef
    || config.objectStore.credentialSource.ownerTenantId !== manifest.isolatedStorage.ownerTenantId
    || config.objectStore.endpoint !== host.recoveryReaders.objectStore.endpoint
    || config.objectStore.caFile.path !== host.recoveryReaders.objectStore.caFile.path
    || config.objectStore.caFile.sha256 !== host.recoveryReaders.objectStore.caFile.sha256
    || config.objectStore.clientIdentityFile.path !== host.recoveryReaders.objectStore.clientIdentityFile.path
    || config.objectStore.clientIdentityFile.sha256 !== host.recoveryReaders.objectStore.clientIdentityFile.sha256
    || config.transit.endpoint !== host.recoveryReaders.transit.endpoint
    || config.transit.caFile.path !== host.recoveryReaders.transit.caFile.path
    || config.transit.caFile.sha256 !== host.recoveryReaders.transit.caFile.sha256
    || config.transit.tokenFile.path !== host.recoveryReaders.transit.tokenFile.path
    || config.transit.tokenFile.sha256 !== host.recoveryReaders.transit.tokenFile.sha256
    || config.vault.endpoint !== host.recoveryReaders.vault.endpoint
    || config.vault.caFile.path !== host.recoveryReaders.vault.caFile.path
    || config.vault.caFile.sha256 !== host.recoveryReaders.vault.caFile.sha256
    || config.vault.tokenFile.path !== host.recoveryReaders.vault.tokenFile.path
    || config.vault.tokenFile.sha256 !== host.recoveryReaders.vault.tokenFile.sha256
    || JSON.stringify(config.connectorVaultCredentialPins) !== JSON.stringify(manifest.connectorVaultCredentialPins)) {
    throw failure('RESTORE_RECOVERY_CONFIG_PIN_MISMATCH');
  }
  const registryBytes = await readRootPinnedFile(config.recoveryKeyRegistry, 4 * 1024 * 1024);
  const registryIdentity = sha256(registryBytes);
  registryBytes.fill(0);
  return {
    config,
    registryIdentity,
    resolveKey: createMaintenanceRecoveryKeyResolver({
      secretCatalogRegistry: { filePath: config.recoveryKeyRegistry.path, sha256: config.recoveryKeyRegistry.sha256 },
    }),
  };
}

function readHttpsJson(
  url: URL,
  input: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: Buffer; ca: Buffer; signal: AbortSignal; maxBytes?: number },
): Promise<{ status: number; body: unknown }> {
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw failure('RESTORE_RECOVERY_ENDPOINT_INVALID');
  abortIfNeeded(input.signal);
  const agent = new https.Agent({ ca: input.ca, rejectUnauthorized: true, keepAlive: false, maxSockets: 1 });
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let length = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: unknown, value?: { status: number; body: unknown }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
      agent.destroy();
      if (error) reject(error); else resolve(value!);
    };
    const request = https.request(url, {
      method: input.method, headers: input.headers, agent, timeout: 15_000, rejectUnauthorized: true,
    }, (response) => {
      response.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > (input.maxBytes ?? 8 * 1024 * 1024)) { request.destroy(failure('RESTORE_RECOVERY_RESPONSE_TOO_LARGE')); return; }
        chunks.push(Buffer.from(chunk));
      });
      response.once('end', () => {
        const bytes = Buffer.concat(chunks, length);
        let body: unknown;
        try { body = JSON.parse(bytes.toString('utf8')) as unknown; }
        catch { finish(failure('RESTORE_RECOVERY_RESPONSE_INVALID')); return; }
        finish(undefined, { status: response.statusCode ?? 0, body });
      });
      response.once('error', (error) => finish(error));
    });
    const onAbort = () => request.destroy(failure('RESTORE_RUNTIME_PROBE_TIMEOUT'));
    input.signal.addEventListener('abort', onAbort, { once: true });
    request.once('error', (error) => finish(error));
    request.setTimeout(15_000, () => request.destroy(failure('RESTORE_RECOVERY_TIMEOUT')));
    timer = setTimeout(() => request.destroy(failure('RESTORE_RECOVERY_TIMEOUT')), 15_000);
    timer.unref?.();
    if (input.body) request.write(input.body);
    request.end();
  });
}

async function unwrapTransitDek(
  runtime: RecoveryRuntime,
  family: 'artifactTransit' | 'metadataTransit',
  wrapped: { keyRef: string; keyVersion: number; ciphertext: string },
  signal: AbortSignal,
): Promise<Buffer> {
  const keyName = runtime.config.transit.keyNameByRef[family][wrapped.keyRef];
  if (!keyName || !Number.isSafeInteger(wrapped.keyVersion) || wrapped.keyVersion < 1
    || !wrapped.ciphertext.startsWith(`vault:v${wrapped.keyVersion}:`)) throw failure('RESTORE_TRANSIT_KEY_PIN_MISMATCH');
  const ca = await readProtectedPinnedFile(runtime.config.transit.caFile, 1024 * 1024);
  const tokenBytes = await readProtectedPinnedFile(runtime.config.transit.tokenFile, 64 * 1024);
  const token = tokenBytes.toString('utf8').trim();
  tokenBytes.fill(0);
  if (!token || /[\r\n\u0000]/.test(token)) { ca.fill(0); throw failure('RESTORE_TRANSIT_IDENTITY_INVALID'); }
  const endpoint = new URL(`/v1/transit/decrypt/${encodeURIComponent(keyName)}`, runtime.config.transit.endpoint);
  try {
    const response = await readHttpsJson(endpoint, {
      method: 'POST', ca, signal,
      headers: { 'content-type': 'application/json', 'x-vault-token': token, accept: 'application/json' },
      body: Buffer.from(JSON.stringify({ ciphertext: wrapped.ciphertext }), 'utf8'), maxBytes: 64 * 1024,
    });
    if (response.status !== 200 || !isRecord(response.body) || !isRecord(response.body.data)
      || typeof response.body.data.plaintext !== 'string') throw failure('RESTORE_TRANSIT_DECRYPT_FAILED');
    const plaintext = Buffer.from(response.body.data.plaintext, 'base64');
    if (plaintext.length !== 32 || plaintext.toString('base64') !== response.body.data.plaintext) {
      plaintext.fill(0); throw failure('RESTORE_TRANSIT_DEK_INVALID');
    }
    return plaintext;
  } finally { ca.fill(0); }
}

async function transitVersionFingerprint(
  runtime: RecoveryRuntime,
  family: 'artifactTransit' | 'metadataTransit',
  keyRef: string,
  keyVersion: number,
  signal: AbortSignal,
): Promise<string> {
  const keyName = runtime.config.transit.keyNameByRef[family][keyRef];
  if (!keyName || !Number.isSafeInteger(keyVersion) || keyVersion < 1) throw failure('RESTORE_TRANSIT_KEY_PIN_MISMATCH');
  const ca = await readProtectedPinnedFile(runtime.config.transit.caFile, 1024 * 1024);
  const tokenBytes = await readProtectedPinnedFile(runtime.config.transit.tokenFile, 64 * 1024);
  const token = tokenBytes.toString('utf8').trim();
  tokenBytes.fill(0);
  if (!token || /[\r\n\u0000]/.test(token)) { ca.fill(0); throw failure('RESTORE_TRANSIT_IDENTITY_INVALID'); }
  try {
    const url = new URL(`/v1/transit/keys/${encodeURIComponent(keyName)}`, runtime.config.transit.endpoint);
    const response = await readHttpsJson(url, { method: 'GET', ca, signal,
      headers: { 'x-vault-token': token, accept: 'application/json' }, maxBytes: 256 * 1024 });
    if (response.status !== 200 || !isRecord(response.body) || !isRecord(response.body.data)
      || !isRecord(response.body.data.keys) || !isRecord(response.body.data.keys[String(keyVersion)])) {
      throw failure('RESTORE_TRANSIT_VERSION_UNAVAILABLE');
    }
    const minimum = Number(response.body.data.min_decryption_version ?? 1);
    const latest = Number(response.body.data.latest_version ?? 0);
    if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(latest) || minimum > keyVersion || latest < keyVersion) {
      throw failure('RESTORE_TRANSIT_VERSION_UNAVAILABLE');
    }
    return canonicalHash(response.body.data.keys[String(keyVersion)]);
  } finally { ca.fill(0); }
}

const StorageCredentialSchema = z.object({
  accessKeyId: z.string().min(16).max(128).refine((value) => value.trim() === value && !/[\u0000-\u0020\u007f]/.test(value)),
  secretAccessKey: z.string().min(20).max(256).refine((value) => value.trim() === value && !/[\u0000-\u0020\u007f]/.test(value)),
  sessionToken: z.string().min(1).max(4096).refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)).optional(),
}).strict();
const S3ClientIdentitySchema = z.object({ schemaVersion: z.literal(1), certificatePem: z.string().min(1).max(1024 * 1024),
  privateKeyPem: z.string().min(1).max(1024 * 1024) }).strict();

async function closeStoredBody(
  body: unknown,
  iterator: AsyncIterator<Uint8Array>,
): Promise<void> {
  const target = body as {
    cancel?: (reason?: unknown) => Promise<unknown> | unknown;
    destroy?: (error?: Error) => unknown;
  };
  let close: Promise<unknown>;
  try {
    if (body instanceof Readable) {
      const closed = finished(body, { cleanup: true }).then(() => undefined, () => undefined);
      body.destroy();
      close = closed;
    } else if (typeof target.cancel === 'function') {
      close = Promise.resolve(target.cancel.call(body, failure('RESTORE_OBJECT_READ_CANCELLED')));
    } else if (typeof iterator.return === 'function') {
      close = Promise.resolve(iterator.return());
    } else if (typeof target.destroy === 'function') {
      target.destroy.call(body);
      throw failure('RESTORE_OBJECT_STREAM_CLOSE_UNCONFIRMED');
    } else {
      throw failure('RESTORE_OBJECT_STREAM_CLOSE_UNAVAILABLE');
    }
  } catch {
    throw failure('RESTORE_OBJECT_STREAM_CLOSE_FAILED');
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), 2_000);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([close.then(() => 'closed' as const, () => 'failed' as const), timeout]);
    if (outcome !== 'closed') throw failure('RESTORE_OBJECT_STREAM_CLOSE_FAILED');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readStoredBody(body: unknown, maximumBytes: number, signal: AbortSignal): Promise<Buffer> {
  if (!body || typeof body !== 'object' || !(Symbol.asyncIterator in body)) throw failure('RESTORE_OBJECT_BODY_INVALID');
  const iterator = (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let size = 0;
  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  const deadline = Date.now() + 120_000;
  const boundedNext = async (): Promise<IteratorResult<Uint8Array>> => {
    abortIfNeeded(signal);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw failure('RESTORE_OBJECT_READ_TIMEOUT');
    let cancel!: (error: Error) => void;
    const stop = new Promise<never>((_resolve, reject) => { cancel = reject; });
    abortListener = () => cancel(failure('RESTORE_RUNTIME_PROBE_TIMEOUT'));
    signal.addEventListener('abort', abortListener, { once: true });
    timer = setTimeout(() => cancel(failure('RESTORE_OBJECT_READ_TIMEOUT')), remaining);
    timer.unref?.();
    try { return await Promise.race([iterator.next(), stop]); }
    finally {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (abortListener) signal.removeEventListener('abort', abortListener);
      abortListener = undefined;
    }
  };
  try {
    for (;;) {
      const next = await boundedNext();
      if (next.done) break;
      const value = next.value;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      size += chunk.length;
      if (!Number.isSafeInteger(size) || size > maximumBytes) throw failure('RESTORE_OBJECT_SIZE_LIMIT');
      chunks.push(chunk);
    }
  } catch (error) {
    try { await closeStoredBody(body, iterator); }
    catch { for (const chunk of chunks) chunk.fill(0); throw failure('RESTORE_OBJECT_STREAM_CLOSE_FAILED'); }
    for (const chunk of chunks) chunk.fill(0);
    throw error;
  }
  const result = Buffer.concat(chunks, size);
  for (const chunk of chunks) chunk.fill(0);
  return result;
}

async function* hashBoundedStoredStream(
  body: unknown,
  expectedBytes: number,
  expectedSha256: string,
  signal: AbortSignal,
): AsyncGenerator<Buffer> {
  if (!body || typeof body !== 'object' || !(Symbol.asyncIterator in body)
    || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || !SHA256.test(expectedSha256)) {
    throw failure('RESTORE_OBJECT_BODY_INVALID');
  }
  const iterator = (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  const hash = createHash('sha256');
  const deadline = Date.now() + 120_000;
  let bytes = 0;
  let completed = false;
  try {
    for (;;) {
      abortIfNeeded(signal);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw failure('RESTORE_OBJECT_READ_TIMEOUT');
      let timer: NodeJS.Timeout | undefined;
      let abortListener: (() => void) | undefined;
      let cancel!: (error: Error) => void;
      const stop = new Promise<never>((_resolve, reject) => { cancel = reject; });
      abortListener = () => cancel(failure('RESTORE_RUNTIME_PROBE_TIMEOUT'));
      signal.addEventListener('abort', abortListener, { once: true });
      timer = setTimeout(() => cancel(failure('RESTORE_OBJECT_READ_TIMEOUT')), remaining);
      timer.unref?.();
      let next: IteratorResult<Uint8Array>;
      try { next = await Promise.race([iterator.next(), stop]); }
      finally {
        if (timer) clearTimeout(timer);
        if (abortListener) signal.removeEventListener('abort', abortListener);
      }
      if (next.done) {
        completed = true;
        break;
      }
      if (!(next.value instanceof Uint8Array)) throw failure('RESTORE_OBJECT_BODY_INVALID');
      const chunk = Buffer.from(next.value);
      bytes += chunk.length;
      if (!Number.isSafeInteger(bytes) || bytes > expectedBytes) throw failure('RESTORE_OBJECT_SIZE_MISMATCH');
      hash.update(chunk);
      yield chunk;
    }
    if (bytes !== expectedBytes || hash.digest('hex') !== expectedSha256) throw failure('RESTORE_OBJECT_CHECKSUM_MISMATCH');
  } finally {
    if (!completed) {
      await closeStoredBody(body, iterator);
    }
  }
}

function parseHexText(value: string | undefined): string {
  if (!value || !/^(?:[0-9a-f]{2})+$/i.test(value)) throw failure('RESTORE_RUNTIME_DATABASE_OUTPUT_INVALID');
  const bytes = Buffer.from(value, 'hex');
  const result = bytes.toString('utf8');
  if (!Buffer.from(result, 'utf8').equals(bytes)) throw failure('RESTORE_RUNTIME_DATABASE_OUTPUT_INVALID');
  return result;
}

function artifactTransitPin(raw: unknown, row: ArtifactRow): { keyRef: string; keyVersion: number; encryption: Record<string, unknown>; kind: 'single' | 'chunked' } {
  if (!isRecord(raw)) throw failure('RESTORE_ARTIFACT_SIDECAR_INVALID');
  let encryption: unknown = raw;
  let kind: 'single' | 'chunked' = 'single';
  if ('encryption' in raw || 'kind' in raw || 'artifactId' in raw) {
    const allowed = ['version','kind','artifactId','tenantId','objectVersion','ciphertextSizeBytes','ciphertextSha256','encryption'];
    if (raw.version !== 1 || (raw.kind !== 'single' && raw.kind !== 'chunked')
      || Object.keys(raw).some((key) => !allowed.includes(key)) || Object.keys(raw).length !== allowed.length
      || raw.artifactId !== row.artifactId || raw.tenantId !== row.tenantId || raw.objectVersion !== row.uploadToken
      || !isRecord(raw.encryption) || raw.ciphertextSha256 !== row.storedSha256 || raw.ciphertextSizeBytes !== row.storedByteSize
      || !row.storageVersionId || !row.manifestVersionId) throw failure('RESTORE_ARTIFACT_SIDECAR_INVALID');
    kind = raw.kind; encryption = raw.encryption;
  } else if ('chunks' in raw) kind = 'chunked';
  if (!isRecord(encryption)) throw failure('RESTORE_ARTIFACT_SIDECAR_INVALID');
  if (kind === 'chunked' && !('chunks' in encryption)) throw failure('RESTORE_ARTIFACT_SIDECAR_INVALID');
  if (kind === 'single' && ('chunks' in encryption)) throw failure('RESTORE_ARTIFACT_SIDECAR_INVALID');
  const dek = encryption.dek;
  if (!isRecord(dek) || typeof dek.keyRef !== 'string' || !RECOVERY_REF.test(dek.keyRef)
    || !Number.isSafeInteger(dek.keyVersion) || Number(dek.keyVersion) < 1 || typeof dek.ciphertext !== 'string') {
    throw failure('RESTORE_ARTIFACT_TRANSIT_PIN_INVALID');
  }
  return { keyRef: dek.keyRef, keyVersion: Number(dek.keyVersion), encryption, kind };
}

function openTransitKeyProvider(runtime: RecoveryRuntime, signal: AbortSignal) {
  return {
    async wrapDek(): Promise<never> { throw failure('RESTORE_TRANSIT_WRAP_NOT_ALLOWED'); },
    async unwrapDek(wrapped: { keyRef: string; keyVersion: number; ciphertext: string }): Promise<Buffer> {
      return unwrapTransitDek(runtime, 'artifactTransit', wrapped, signal);
    },
  };
}

function canonicalHash(value: unknown): string {
  const canonical = (node: unknown): string => {
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return JSON.stringify(node);
    if (typeof node === 'number' && Number.isFinite(node)) return JSON.stringify(node);
    if (Array.isArray(node)) return `[${node.map(canonical).join(',')}]`;
    if (isRecord(node)) return `{${Object.keys(node).sort().map((key) => `${JSON.stringify(key)}:${canonical(node[key])}`).join(',')}}`;
    throw failure('RESTORE_RECOVERY_JSON_INVALID');
  };
  return sha256(canonical(value));
}

type RecoveryRegistryPurpose = 'secret_catalog' | 'connector_invocation' | 'connector_credential';
type RecoveryRegistryRow = { purpose: RecoveryRegistryPurpose; escrowRef: string; keyVersion: string; fingerprintSha256: string; filePath: string };

async function recoveryRegistryRows(runtime: RecoveryRuntime): Promise<RecoveryRegistryRow[]> {
  const bytes = await readRootPinnedFile(runtime.config.recoveryKeyRegistry, 4 * 1024 * 1024);
  try {
    if (sha256(bytes) !== runtime.config.recoveryKeyRegistry.sha256) throw failure('RESTORE_RECOVERY_REGISTRY_PIN_MISMATCH');
    const raw = JSON.parse(bytes.toString('utf8')) as unknown;
    if (!isRecord(raw) || raw.version !== 2 || !Array.isArray(raw.keys) || raw.keys.length > 256
      || Object.keys(raw).some((key) => key !== 'version' && key !== 'keys')) throw failure('RESTORE_RECOVERY_REGISTRY_INVALID');
    const rows: RecoveryRegistryRow[] = [];
    const seen = new Set<string>();
    for (const entry of raw.keys) {
      if (!isRecord(entry) || !['secret_catalog','connector_invocation','connector_credential'].includes(String(entry.purpose))
        || typeof entry.escrowRef !== 'string' || !RECOVERY_REF.test(entry.escrowRef)
        || typeof entry.keyVersion !== 'string' || !SAFE.test(entry.keyVersion)
        || typeof entry.fingerprintSha256 !== 'string' || !SHA256.test(entry.fingerprintSha256)
        || typeof entry.filePath !== 'string' || !path.isAbsolute(entry.filePath) || path.normalize(entry.filePath) !== entry.filePath) {
        throw failure('RESTORE_RECOVERY_REGISTRY_INVALID');
      }
      const purpose = entry.purpose as RecoveryRegistryPurpose;
      const id = `${purpose}\0${entry.escrowRef}\0${entry.keyVersion}`;
      if (seen.has(id)) throw failure('RESTORE_RECOVERY_REGISTRY_INVALID');
      seen.add(id);
      rows.push({ purpose, escrowRef: entry.escrowRef, keyVersion: entry.keyVersion,
        fingerprintSha256: entry.fingerprintSha256, filePath: entry.filePath });
    }
    return rows;
  } catch { throw failure('RESTORE_RECOVERY_REGISTRY_INVALID'); }
  finally { bytes.fill(0); }
}

async function resolvePinnedRecoveryKey(runtime: RecoveryRuntime, input: {
  purpose: RecoveryRegistryPurpose; keyVersion: string; fingerprintSha256: string; escrowRef?: string;
}): Promise<{ escrowRef: string; key: Buffer }> {
  const rows = (await recoveryRegistryRows(runtime)).filter((row) => row.purpose === input.purpose
    && row.keyVersion === input.keyVersion && row.fingerprintSha256 === input.fingerprintSha256
    && (input.escrowRef === undefined || row.escrowRef === input.escrowRef));
  if (rows.length !== 1) throw failure('RESTORE_RECOVERY_KEY_REGISTRY_MISMATCH');
  const row = rows[0]!;
  const key = await runtime.resolveKey({ purpose: input.purpose, escrowRef: row.escrowRef, keyVersion: row.keyVersion });
  if (!Buffer.isBuffer(key) || sha256(key) !== row.fingerprintSha256) { key?.fill?.(0); throw failure('RESTORE_RECOVERY_KEY_FINGERPRINT_MISMATCH'); }
  return { escrowRef: row.escrowRef, key };
}

function openConnectorInvocationEnvelope(envelope: unknown, context: { tenantId: string; slot: string; refId: string }, keyRef: string, keyVersion: number, kek: Buffer): Buffer {
  if (!isRecord(envelope) || envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm'
    || envelope.keyRef !== keyRef || !isRecord(envelope.dek) || envelope.dek.keyName !== keyRef
    || envelope.dek.version !== 1 || envelope.dek.keyVersion !== keyVersion
    || typeof envelope.dek.wrappedKey !== 'string' || typeof envelope.nonce !== 'string'
    || typeof envelope.tag !== 'string' || typeof envelope.aad !== 'string' || typeof envelope.ciphertext !== 'string') {
    throw failure('RESTORE_CONNECTOR_INVOCATION_ENVELOPE_INVALID');
  }
  const aad = createHash('sha256').update(`${context.tenantId}|${context.slot}|${context.refId}`, 'utf8').digest();
  const suppliedAad = Buffer.from(envelope.aad, 'base64');
  if (suppliedAad.toString('base64') !== envelope.aad || !suppliedAad.equals(aad)) throw failure('RESTORE_CONNECTOR_INVOCATION_CONTEXT_MISMATCH');
  const wrapped = Buffer.from(envelope.dek.wrappedKey, 'base64');
  if (wrapped.toString('base64') !== envelope.dek.wrappedKey || wrapped.length !== 60) throw failure('RESTORE_CONNECTOR_INVOCATION_DEK_INVALID');
  const kekAad = Buffer.from(`du-connector-invocation-kek:v1|${keyRef}|${keyVersion}`, 'utf8');
  let dek: Buffer;
  try {
    const unwrap = createDecipheriv('aes-256-gcm', kek, wrapped.subarray(0, 12), { authTagLength: 16 });
    unwrap.setAAD(kekAad); unwrap.setAuthTag(wrapped.subarray(12, 28));
    dek = Buffer.concat([unwrap.update(wrapped.subarray(28)), unwrap.final()]);
  } catch { throw failure('RESTORE_CONNECTOR_INVOCATION_DEK_AUTH_FAILED'); }
  try {
    if (dek.length !== 32) throw failure('RESTORE_CONNECTOR_INVOCATION_DEK_INVALID');
    const nonce = Buffer.from(envelope.nonce, 'base64'); const tag = Buffer.from(envelope.tag, 'base64');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    if (nonce.toString('base64') !== envelope.nonce || nonce.length !== 12 || tag.toString('base64') !== envelope.tag || tag.length !== 16
      || ciphertext.toString('base64') !== envelope.ciphertext || ciphertext.length < 1) throw failure('RESTORE_CONNECTOR_INVOCATION_ENVELOPE_INVALID');
    const decipher = createDecipheriv('aes-256-gcm', dek, nonce, { authTagLength: 16 });
    decipher.setAAD(aad); decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (typeof envelope.plaintextSha256 === 'string' && sha256(plaintext) !== envelope.plaintextSha256) {
      plaintext.fill(0); throw failure('RESTORE_CONNECTOR_INVOCATION_PLAINTEXT_HASH_MISMATCH');
    }
    JSON.parse(plaintext.toString('utf8'));
    return plaintext;
  } catch (error) { throw error instanceof Error && /^RESTORE_/.test(error.message) ? error : failure('RESTORE_CONNECTOR_INVOCATION_AUTH_FAILED'); }
  finally { dek.fill(0); wrapped.fill(0); aad.fill(0); suppliedAad.fill(0); kekAad.fill(0); }
}

export function metadataRecoveryRefId(slot: string, storedRefId: string): string {
  if (slot !== 'connector_prompt_overrides.prompt_override') return storedRefId;
  let tuple: unknown;
  try { tuple = JSON.parse(storedRefId) as unknown; }
  catch { throw failure('RESTORE_METADATA_CONTEXT_INVALID'); }
  if (!Array.isArray(tuple) || tuple.length !== 4 || tuple.some((item) => typeof item !== 'string')) {
    throw failure('RESTORE_METADATA_CONTEXT_INVALID');
  }
  return JSON.stringify(tuple);
}

function runToolWithEnv(executable: string, args: readonly string[], env: NodeJS.ProcessEnv, signal: AbortSignal, maxStdoutBytes: number, stdin?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(failure('RESTORE_RUNTIME_PROBE_TIMEOUT')); return; }
    let child: ChildProcess;
    let output = Buffer.alloc(0);
    let timer: NodeJS.Timeout | undefined;
    let killed = false;
    let settled = false;
    const finish = (code: number | null, cause?: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (cause || killed || code !== 0) reject(failure(killed || signal.aborted ? 'RESTORE_RUNTIME_COMMAND_TIMEOUT' : 'RESTORE_RUNTIME_DATABASE_QUERY_FAILED'));
      else resolve(output);
    };
    const stop = () => {
      killed = true;
      try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { /* exited */ }
      setTimeout(() => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* exited */ } }, 750).unref?.();
    };
    const abort = () => stop();
    try {
      child = spawn(executable, [...args], { shell: false, detached: process.platform !== 'win32', windowsHide: true,
        env, stdio: [stdin ? 'pipe' : 'ignore','pipe','ignore'] });
    } catch (cause) { finish(null, cause); return; }
    child.stdout?.on('data', (chunk: Buffer) => {
      if (output.length + chunk.length > maxStdoutBytes) { stop(); return; }
      output = Buffer.concat([output, chunk]);
    });
    child.once('error', (cause) => finish(null, cause));
    child.once('close', (code) => finish(code));
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(stop, COMMAND_TIMEOUT_MS); timer.unref?.();
    if (stdin) child.stdin?.end(stdin);
  });
}

function parseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw failure('RESTORE_RUNTIME_LOCAL_URL_INVALID'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1','localhost','[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash) throw failure('RESTORE_RUNTIME_LOCAL_URL_INVALID');
  return url;
}

const HTTP_SCRIPT = String.raw`const fs=require('node:fs');
const http=require('node:http');
const https=require('node:https');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const limit=input.maxBodyBytes||1048576;
function request(url,method='GET',headers={},body=null){return new Promise((resolve,reject)=>{const u=new URL(url);const lib=u.protocol==='https:'?https:http;const req=lib.request(u,{method,headers,timeout:15000},res=>{const chunks=[];let n=0;res.on('data',c=>{n+=c.length;if(n>limit){req.destroy(new Error('limit'));return;}chunks.push(c)});res.on('end',()=>resolve({status:res.statusCode||0,headers:res.headers,body:Buffer.concat(chunks)}))});req.on('timeout',()=>req.destroy(new Error('timeout')));req.on('error',reject);if(body)req.write(body);req.end()})}
function cookies(headers){const set=headers['set-cookie']||[];return (Array.isArray(set)?set:[set]).map(s=>String(s).split(';')[0]).filter(Boolean).join('; ')}
function inputValue(html,name){const re=new RegExp("name=[\"']"+name+"[\"'][^>]*value=[\"']([^\"']+)[\"']|value=[\"']([^\"']+)[\"'][^>]*name=[\"']"+name+"[\"']","i");const m=re.exec(html);return m&&(m[1]||m[2])||null}
function emit(v){process.stdout.write(JSON.stringify(v))}
(async()=>{try{
 if(input.action==='health'){const h=await request(input.url);if(h.status<200||h.status>=300)throw Error('health');emit({status:h.status});return}
 if(input.action==='observe-orchestrator'){const token=fs.readFileSync(input.tokenFile,'utf8').trim();const h=await request(input.url,'GET',{authorization:'Bearer '+token,accept:'application/json'});emit({status:h.status,body:JSON.parse(h.body.toString('utf8'))});return}
 if(input.action==='observe-connector'){const token=fs.readFileSync(input.tokenFile,'utf8').trim();const h=await request(input.url,'POST',{authorization:'Bearer '+token,'x-service-scope':'connector:runtime-control','content-type':'application/json',accept:'application/json'},JSON.stringify(input.identity));emit({status:h.status,body:JSON.parse(h.body.toString('utf8'))});return}
 if(input.action==='observe-connector-effects'){const token=fs.readFileSync(input.tokenFile,'utf8').trim();const body={...input.identity,fenceId:input.fenceId,expectedFenceRevision:0};const h=await request(input.url,'POST',{authorization:'Bearer '+token,'x-service-scope':'connector:runtime-control','content-type':'application/json',accept:'application/json'},JSON.stringify(body));emit({status:h.status,body:JSON.parse(h.body.toString('utf8'))});return}
 if(input.action==='source-probe'){const net=require('node:net');const host=input.host.startsWith('[')&&input.host.endsWith(']')?input.host.slice(1,-1):input.host;const family=net.isIP(host);if(!family)throw Error('source-pin');const port=input.port;const socket=net.createConnection({host,port,family});let done=false;const finish=v=>{if(done)return;done=true;socket.destroy();emit(v)};socket.setTimeout(input.timeoutMs||2500,()=>finish({connected:false,errorCode:'ETIMEDOUT',responseStatus:null}));socket.once('connect',()=>finish({connected:true,errorCode:null,responseStatus:null}));socket.once('error',e=>finish({connected:false,errorCode:String(e.code||'EUNKNOWN'),responseStatus:null})) ;return}
 if(input.action==='login-history'){
  const cred=input.credential;const url=new URL(input.loginUrl);const page=await request(input.loginUrl);if(page.status!==200)throw Error('login-page');
  const csrf=inputValue(page.body.toString('utf8'),'csrf');if(!csrf)throw Error('csrf');let cookie=cookies(page.headers);
  const form=new URLSearchParams({username:cred.username,password:cred.password,csrf,redirect:'/admin'}).toString();
  const login=await request(input.loginUrl,'POST',{cookie,'content-type':'application/x-www-form-urlencoded','content-length':String(Buffer.byteLength(form))},form);
  const loginCookie=cookies(login.headers);if(loginCookie)cookie=[cookie,loginCookie].filter(Boolean).join('; ');
  if(login.status!==302)throw Error('login');
  const session=await request(new URL('/admin/api/session',url.origin).toString(),'GET',{cookie,accept:'application/json'});
  if(session.status!==200)throw Error('session');const sessionJson=JSON.parse(session.body.toString('utf8'));
  const principal=sessionJson.principal||sessionJson.user||sessionJson.sub;if(!principal)throw Error('principal');
  const records=[];let cursor=null,total=null;for(let pageNo=0;pageNo<10000;pageNo++){
    const u=new URL('/admin/api/operations',url.origin);u.searchParams.set('limit','100');if(cursor)u.searchParams.set('cursor',cursor);
    const r=await request(u.toString(),'GET',{cookie,accept:'application/json'});if(r.status!==200)throw Error('history');const j=JSON.parse(r.body.toString('utf8'));
    const items=j.items;if(!Array.isArray(items))throw Error('history-shape');if(total===null&&Number.isSafeInteger(j.total))total=j.total;
    for(const item of items){if(!item||typeof item.id!=='string')throw Error('history-row');let result=null;let hasResult=false;
      if(item.result!==undefined&&item.result!==null){hasResult=true;result=require('node:crypto').createHash('sha256').update(JSON.stringify(item.result)).digest('hex')}
      records.push({idHash:require('node:crypto').createHash('sha256').update(item.id).digest('hex'),state:String(item.state||item.status||'UNKNOWN'),hasResult,resultSha256:result});
    }
    cursor=j.nextCursor||null;if(!cursor)break;if(pageNo===9999)throw Error('history-limit');
  }
  emit({loginStatus:login.status,historyStatus:200,totalRecords:total===null?records.length:total,records,principalSha256:require('node:crypto').createHash('sha256').update(JSON.stringify(principal)).digest('hex')});return
 }
 if(input.action==='artifact-download'){
  const key=input.apiKey;const url=input.url;const r=await request(url,'GET',{'x-api-key':key.apiKey,'accept':'application/octet-stream'});
  emit({status:r.status,contentType:String(r.headers['content-type']||'').split(';')[0],bytes:r.body.toString('base64')});return
 }
 throw Error('action')
}catch(_){process.exitCode=4}})();`;

// The child program is code-owned, but TypeScript does not parse String.raw
// template contents. Compile it under Node before any target process can start.
try { new Script(HTTP_SCRIPT, { filename: 'du-restore-fixed-http-probe.js' }); }
catch { throw failure('RESTORE_RUNTIME_FIXED_PROBE_PROGRAM_INVALID'); }

function encodeInput(value: unknown): Buffer { return Buffer.from(JSON.stringify(value), 'utf8'); }

function parseJsonStdout(result: CommandResult): unknown { return requireZeroOrThrow(result.exitCode, result.stdout, true); }

function asIso(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw failure('RESTORE_RUNTIME_OBSERVATION_INVALID');
  return new Date(value).toISOString();
}

function count(value: unknown): number {
  const number = typeof value === 'string' ? Number(value) : value;
  if (!Number.isSafeInteger(number) || Number(number) < 0) throw failure('RESTORE_RUNTIME_OBSERVATION_INVALID');
  return Number(number);
}

function disabledEffects(value: unknown): Record<string, 'DISABLED'> {
  const expected = ['admission','dispatch','providerInvocation','connectorPoll','usageDelivery','webhookDelivery','alertEmission','cleanup','historicalMaintenance','migrations'];
  if (!isRecord(value) || expected.some((key) => value[key] !== 'DISABLED') || Object.keys(value).length !== expected.length) {
    throw failure('RESTORE_RUNTIME_EXTERNAL_EFFECTS_UNVERIFIED');
  }
  return Object.fromEntries(expected.map((key) => [key,'DISABLED'])) as Record<string,'DISABLED'>;
}

function mapOrchestratorHealth(raw: unknown): ReturnType<RestoreRuntimeHealthPort['observeOrchestrator']> extends Promise<infer T> ? T : never {
  if (!isRecord(raw) || raw.service !== 'orchestrator' || !isRecord(raw.work) || !Array.isArray(raw.dependencies)) throw failure('RESTORE_RUNTIME_OBSERVATION_INVALID');
  const dependencies: unknown[] = raw.dependencies;
  const dep = (name: string) => {
    const row = dependencies.find((entry: unknown) => isRecord(entry) && entry.dependencyId === name);
    if (!isRecord(row)) throw failure('RESTORE_RUNTIME_OBSERVATION_INVALID');
    return { state: row.state, observedAt: asIso(row.observedAt) };
  };
  const work = raw.work as Record<string, unknown>;
  const workCount = (key: string) => {
    const item = work[key];
    if (!isRecord(item)) throw failure('RESTORE_RUNTIME_OBSERVATION_INVALID');
    return count(item.count);
  };
  const externalEffects = disabledEffects(raw.externalEffects);
  const result = {
    observedAt: asIso(raw.observedAt), workObservedAt: asIso(raw.workObservedAt), readiness: raw.readiness,
    liveness: raw.liveness, livenessObservedAt: asIso(raw.livenessObservedAt), dependencies: { postgres: dep('postgres'), redis: dep('redis') },
    clusterName: raw.clusterName, runtimeIdentity: raw.runtimeIdentity, revision: raw.revision, imageDigest: raw.imageDigest,
    bootId: raw.bootId, slot: raw.slot,
      control: { state: raw.controlState, revision: count(raw.controlRevision), acknowledgedAt: raw.controlAcknowledgedAt,
        bootId: raw.controlAcknowledgedBootId },
    externalEffects,
    work: {
      activeRequests: workCount('orchestratorRequests'), activeDispatches: workCount('dispatches'),
        maintenanceExecutions: workCount('maintenanceExecutions'),
    },
  };
  return result as never;
}

function mapConnectorHealth(raw: unknown, effects: unknown): ReturnType<RestoreRuntimeHealthPort['observeConnector']> extends Promise<infer T> ? T : never {
  if (!isRecord(raw) || raw.service !== 'connector' || !isRecord(raw.work) || !isRecord(effects) || !isRecord(effects.work) || !isRecord(effects.fence)) {
    throw failure('RESTORE_RUNTIME_OBSERVATION_INVALID');
  }
  const dependencies = raw.dependencies;
  if (!isRecord(dependencies) || !isRecord(dependencies.postgres) || !isRecord(dependencies.redis)) throw failure('RESTORE_RUNTIME_OBSERVATION_INVALID');
  const work = raw.work;
  const fenceWork = effects.work;
  const effectPermits = fenceWork.effectPermits;
  if (!isRecord(effectPermits)) throw failure('RESTORE_RUNTIME_OBSERVATION_INVALID');
  if (typeof raw.bootId !== 'string' || effects.fence.bootId !== raw.bootId) throw failure('RESTORE_RUNTIME_OBSERVATION_INVALID');
  const result = {
    observedAt: asIso(raw.observedAt), workObservedAt: asIso(raw.workObservedAt), readiness: raw.readiness,
    liveness: raw.liveness, livenessObservedAt: asIso(raw.livenessObservedAt),
    dependencies: {
      postgres: { state: dependencies.postgres.state, observedAt: asIso(dependencies.postgres.observedAt) },
      redis: { state: dependencies.redis.state, observedAt: asIso(dependencies.redis.observedAt) },
    },
    clusterName: raw.clusterName, runtimeIdentity: raw.runtimeIdentity, revision: raw.revision, imageDigest: raw.imageDigest,
    bootId: raw.bootId,
    replicaId: raw.replicaId, slot: raw.slot,
    control: { state: raw.controlState, revision: count(raw.controlRevision), acknowledgedAt: raw.controlAcknowledgedAt,
      bootId: raw.controlAcknowledgedBootId },
    externalEffects: disabledEffects(raw.externalEffects),
    work: {
      processActiveInvocations: count(fenceWork.processActiveInvocations), processActivePolls: count(fenceWork.processActivePolls),
      processActiveUsageSends: count(fenceWork.processActiveUsageSends), unresolvedInvocationHolds: count(fenceWork.unresolvedInvocationHolds),
      effectPermits: { prepared: count(effectPermits.prepared), active: count(effectPermits.active), settling: count(effectPermits.settling), unknown: count(effectPermits.unknown) },
      unclosedEffectPermits: count(fenceWork.unclosedEffectPermits), unknownUsageDeliveries: count(fenceWork.unknownUsageDeliveries),
    },
  };
  return result as never;
}

function executeArgs(host: HostConfig, cid: string, script: string, stdin: Buffer, signal: AbortSignal, max = MAX_STDOUT): Promise<CommandResult> {
  const args = ['exec','-i','--user',`${host.runtimeUid}:${host.runtimeGid}`,cid,'node','-e',script];
  return runCommand(host.launcher.executable.path, args, { signal, timeoutMs: COMMAND_TIMEOUT_MS, stdin, maxStdoutBytes: max });
}

function containerInspection(manifest: Manifest, cid: string, signal: AbortSignal): Promise<CommandResult> {
  const host = manifest.isolatedHost;
  const args = applyTemplate(host.launcher.inspectArgs, { CONTAINER_ID: cid });
  if (args.some((arg) => arg === '--format={{.Config.Env}}' || arg.includes('.Config.Env') || arg.includes('.Mounts'))) {
    throw failure('RESTORE_RUNTIME_INSPECTION_TEMPLATE_INVALID');
  }
  return runCommand(host.launcher.executable.path, args, { signal, timeoutMs: COMMAND_TIMEOUT_MS, maxStdoutBytes: 64 * 1024 });
}

function verifyInspection(manifest: Manifest, state: RuntimeState, raw: string, stage: 'dormant' | 'attached' | 'running'): void {
  const seen = parseContainerInspection(raw);
  const host = manifest.isolatedHost;
  if (seen.id.toLowerCase() !== state.id.toLowerCase() || seen.image !== state.plan.imageDigest || seen.user !== `${host.runtimeUid}:${host.runtimeGid}`
    || !seen.running || seen.pid < 1) throw failure('RESTORE_RUNTIME_IDENTITY_UNVERIFIED');
  if (stage === 'dormant' && seen.mode !== 'none') throw failure('RESTORE_RUNTIME_NETWORK_POLICY_INVALID');
  if ((stage === 'attached' || stage === 'running') && (seen.networks.length !== 1
    || seen.networks[0]?.id.toLowerCase() !== host.launcher.targetNetwork.id.toLowerCase()
    || seen.networks[0]?.name !== host.launcher.targetNetwork.name)) throw failure('RESTORE_RUNTIME_NETWORK_POLICY_INVALID');
  state.pid = seen.pid;
}

async function nftCommand(manifest: Manifest, state: RuntimeState, operation: 'apply' | 'inspect', signal: AbortSignal): Promise<CommandResult> {
  const host = manifest.isolatedHost;
  const args = operation === 'apply'
    ? ['--net',`/proc/${state.pid}/ns/net`,host.networkPolicy.nftTool.path,'-f',host.networkPolicy.rulesFile.path]
    : ['--net',`/proc/${state.pid}/ns/net`,host.networkPolicy.nftTool.path,'-j','list','table','inet','du_restore'];
  return runCommand(host.networkPolicy.namespaceTool.path, args, {
    signal, timeoutMs: COMMAND_TIMEOUT_MS, maxStdoutBytes: operation === 'inspect' ? 1024 * 1024 : 4096,
  });
}

function parseRuntimeConfig(bytes: Buffer, plan: RestoreRuntimeLaunchPlan): Record<string, unknown> {
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString('utf8')) as unknown; } catch { throw failure('RESTORE_RUNTIME_CONFIG_INVALID'); }
  const parsed = TrustedIsolatedRuntimeConfigSchema.safeParse(raw);
  if (!parsed.success) throw failure('RESTORE_RUNTIME_CONFIG_INVALID');
  const config = parsed.data;
  if (config.service !== plan.kind || config.clusterName !== plan.clusterName || config.runtimeIdentity !== plan.runtimeIdentity
    || config.revision !== plan.revision || config.imageDigest !== plan.imageDigest || config.databaseName !== plan.database.databaseName
    || config.targetGenerationId !== plan.targetGenerationId || config.slot !== plan.slot
    || (plan.kind === 'connector' && config.replicaId !== plan.replicaId)) {
    throw failure('RESTORE_RUNTIME_CONFIG_IDENTITY_MISMATCH');
  }
  return config;
}

async function writePrivateFile(directory: string, name: string, bytes: Buffer): Promise<string> {
  const output = path.join(directory, name);
  if (path.dirname(output) !== directory) throw failure('RESTORE_RUNTIME_PRIVATE_FILE_INVALID');
  const handle = await open(output, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    await handle.chown(0, 1000);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o440);
  } finally { await handle.close(); }
  return output;
}

async function readCreatedContainerId(cidFilePath: string, cidDirectory: string): Promise<string | null> {
  if (!path.isAbsolute(cidFilePath) || path.dirname(cidFilePath) !== cidDirectory
    || path.basename(cidFilePath) !== 'container.cid') throw failure('RESTORE_RUNTIME_CID_FILE_UNTRUSTED');
  let before;
  try { before = await lstat(cidFilePath); }
  catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw failure('RESTORE_RUNTIME_CID_FILE_UNTRUSTED');
  }
  const parent = await lstat(cidDirectory);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== 0
    || (before.mode & 0o022) !== 0 || before.size < 64 || before.size > 66
    || !parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || parent.gid !== 0
    || (parent.mode & 0o077) !== 0 || (parent.mode & 0o700) !== 0o700 || await realpath(cidFilePath) !== cidFilePath) {
    throw failure('RESTORE_RUNTIME_CID_FILE_UNTRUSTED');
  }
  const handle = await open(cidFilePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    const currentParent = await lstat(cidDirectory);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.uid !== before.uid || after.gid !== before.gid || currentParent.dev !== parent.dev || currentParent.ino !== parent.ino) {
      throw failure('RESTORE_RUNTIME_CID_FILE_CHANGED');
    }
    await handle.chmod(0o600);
    const protectedStat = await handle.stat();
    if ((protectedStat.mode & 0o077) !== 0 || protectedStat.uid !== 0 || protectedStat.nlink !== 1) {
      throw failure('RESTORE_RUNTIME_CID_FILE_UNTRUSTED');
    }
    const bytes = await handle.readFile();
    const text = bytes.toString('ascii');
    if (!/^[a-f0-9]{64}(?:\r?\n)?$/i.test(text)) throw failure('RESTORE_RUNTIME_CID_FILE_INVALID');
    return text.trim().toLowerCase();
  } finally { await handle.close(); }
}

async function makePrivateCidDirectory(workDirectory: string): Promise<string> {
  const directory = path.join(workDirectory, 'cid');
  await mkdir(directory, { mode: 0o700 });
  await chown(directory, 0, 0);
  await chmod(directory, 0o700);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0
    || (info.mode & 0o077) !== 0 || await realpath(directory) !== directory) {
    throw failure('RESTORE_RUNTIME_CID_DIRECTORY_UNTRUSTED');
  }
  return directory;
}

async function makePrivateDirectory(parent: string, name: string): Promise<string> {
  const directory = path.join(parent, name);
  await mkdir(directory, { mode: 0o700 });
  await chown(directory, 0, 1000);
  await chmod(directory, 0o750);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 1000
    || (info.mode & 0o027) !== 0 || (info.mode & 0o050) !== 0o050 || await realpath(directory) !== directory) {
    throw failure('RESTORE_RUNTIME_PRIVATE_DIRECTORY_INVALID');
  }
  return directory;
}

function expectedPlan(manifest: Manifest, plan: RestoreRuntimeLaunchPlan): void {
  const runtime = manifest.isolatedRuntime;
  const expected = plan.kind === 'orchestrator'
    ? { identity: runtime.orchestratorRuntimeIdentity, revision: runtime.orchestratorRevision, image: runtime.orchestratorImageDigest,
      slot: runtime.orchestratorSlot, cluster: manifest.orchestratorRestoreClusterName, service: manifest.isolatedHost.libpq.orchestratorService }
    : { identity: runtime.connectorRuntimeIdentity, revision: runtime.connectorRevision, image: runtime.connectorImageDigest,
      slot: runtime.connectorSlot,
      cluster: manifest.connectorRestoreClusterName, service: manifest.isolatedHost.libpq.connectorService };
  if (plan.runtimeIdentity !== expected.identity || plan.revision !== expected.revision || plan.imageDigest !== expected.image
    || plan.clusterName !== expected.cluster || plan.database.serviceName !== expected.service
    || plan.slot !== expected.slot
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(plan.targetGenerationId)) {
    throw failure('RESTORE_RUNTIME_PLAN_NOT_MANIFEST_PINNED');
  }
  if (plan.kind === 'connector') {
    if (plan.replicaId !== runtime.connectorReplicaId) throw failure('RESTORE_RUNTIME_PLAN_NOT_MANIFEST_PINNED');
  }
  if (plan.sourceRuntimeIdentities.length !== manifest.sourceRuntimeIdentities.length
    || plan.sourceRuntimeIdentities.some((item) => !manifest.sourceRuntimeIdentities.includes(item))) throw failure('RESTORE_RUNTIME_SOURCE_IDENTITIES_INVALID');
}

function makeSourceObservation(raw: unknown, ref: RestoreSourceRef, state: RuntimeState, networkPolicyRevision: string): SourceIsolationObservation {
  if (!isRecord(raw) || typeof raw.connected !== 'boolean' || raw.responseStatus !== null || typeof raw.errorCode !== 'string' && raw.errorCode !== null) {
    throw failure('RESTORE_SOURCE_PROBE_OUTPUT_INVALID');
  }
  const outcome = raw.connected ? 'CONNECTED'
    : raw.errorCode === 'EPERM' || raw.errorCode === 'EACCES' ? 'BLOCKED_BY_POLICY'
      : ['ENETUNREACH','EHOSTUNREACH','ENETDOWN'].includes(String(raw.errorCode)) ? 'NO_ROUTE'
        : raw.errorCode === 'ECONNREFUSED' ? 'CONNECTION_REFUSED'
          : raw.errorCode === 'ETIMEDOUT' ? 'TIMED_OUT' : 'UNKNOWN';
  if (!state.lastBootId || !SHA256.test(networkPolicyRevision)) throw failure('RESTORE_RUNTIME_SOURCE_CONTEXT_UNVERIFIED');
  return {
    observedAt: nowIso(), contextRuntimeIdentity: state.plan.runtimeIdentity,
    contextBootId: state.lastBootId, destinationRef: ref, outcome,
    responseStatus: null, networkPolicyState: 'ENFORCED', networkPolicyRevision,
  };
}

export interface TrustedIsolatedRestoreRuntimePortsOptions {
  manifestPath: string;
  expectedManifestSha256: string;
}

/**
 * Concrete host-runner ports for the restore probe. This factory never accepts
 * a callback that supplies evidence: Docker, nft, psql and target-local HTTP
 * are invoked directly with digest-pinned deployment tools and bounded IO.
 */
export function createTrustedIsolatedRestoreRuntimePorts(options: TrustedIsolatedRestoreRuntimePortsOptions): RuntimePorts {
  if (!options || !path.isAbsolute(options.manifestPath) || !SHA256.test(options.expectedManifestSha256)) {
    throw failure('RESTORE_RUNTIME_MANIFEST_REQUIRED');
  }
  let loaded: Promise<Manifest> | null = null;
  const states = new Map<string, RuntimeState>();
  const manifest = (): Promise<Manifest> => loaded ??= readTrustedIsolatedRestoreRuntimeManifest(options);
  const ownedState = (handle: OwnedRestoreRuntimeHandle): RuntimeState => {
    const state = states.get(handle.handleId);
    if (!state || state.handle.kind !== handle.kind || state.stopped) throw failure('RESTORE_RUNTIME_HANDLE_NOT_OWNED');
    return state;
  };
  const inspect = async (state: RuntimeState, stage: 'dormant' | 'attached' | 'running', signal: AbortSignal) => {
    const current = await manifest();
    const result = await containerInspection(current, state.id, signal);
    const text = result.stdout.toString('utf8').trim();
    verifyInspection(current, state, text, stage);
    return text;
  };
  const deleteOwned = async (state: RuntimeState, signal: AbortSignal): Promise<void> => {
    let error = false;
    try {
      const current = await manifest();
      const stopped = await runCommand(current.isolatedHost.launcher.executable.path,
        applyTemplate(current.isolatedHost.launcher.stopArgs, { CONTAINER_ID: state.id }), { signal, timeoutMs: CLEANUP_TIMEOUT_MS, maxStdoutBytes: 4096 });
      requireZeroOrThrow(stopped.exitCode, stopped.stdout);
      const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
      let confirmedStopped = false;
      while (Date.now() < deadline) {
        const info = await containerInspection(current, state.id, signal);
        const parts = info.stdout.toString('utf8').trim().split('|');
        if (parts.length !== 7 || parts[0]?.toLowerCase() !== state.id.toLowerCase()) throw failure('RESTORE_RUNTIME_PROBE_CLEANUP_FAILED');
        if (parts[3] === 'false') { confirmedStopped = true; break; }
        await new Promise<void>((resolve, reject) => {
          const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
          const timer = setTimeout(finish, 250);
          const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(failure('RESTORE_RUNTIME_PROBE_TIMEOUT')); };
          signal.addEventListener('abort', abort, { once: true });
          timer.unref?.();
        });
      }
      if (!confirmedStopped) throw failure('RESTORE_RUNTIME_PROBE_CLEANUP_FAILED');
      // Remove only the exact full container ID created and inspected above.
      const removed = await runCommand(current.isolatedHost.launcher.executable.path, ['rm','--force',state.id],
        { signal, timeoutMs: CLEANUP_TIMEOUT_MS, maxStdoutBytes: 4096 });
      if (removed.stdout.toString('utf8').trim().toLowerCase() !== state.id.toLowerCase()) throw failure('RESTORE_RUNTIME_PROBE_CLEANUP_FAILED');
    } catch { error = true; }
    if (!error) {
      try { await rm(state.workDirectory, { recursive: true, force: true }); } catch { error = true; }
    }
    if (!error) {
      states.delete(state.handle.handleId);
      state.stopped = true;
    } else {
      states.set(state.handle.handleId, state);
    }
    if (error) throw failure('RESTORE_RUNTIME_PROBE_CLEANUP_FAILED');
  };

  const launch = {
    async start(plan: RestoreRuntimeLaunchPlan, input: { signal: AbortSignal }): Promise<OwnedRestoreRuntimeHandle> {
      const current = await manifest();
      abortIfNeeded(input.signal);
      expectedPlan(current, plan);
      if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() !== 0) {
        throw failure('RESTORE_RUNTIME_HOST_EXECUTION_CONTEXT_INVALID');
      }
      if (plan.network.defaultEgress !== 'DENY' || plan.network.blockedSourceRefs.length !== SOURCE_REFS.length
        || SOURCE_REFS.some((ref) => !plan.network.blockedSourceRefs.includes(ref))) throw failure('RESTORE_RUNTIME_NETWORK_PLAN_INVALID');
      const host = current.isolatedHost;
      const runtimeConfigPin = host.runtimeConfigFiles[plan.kind];
      const runtimeSecretsPin = host.runtimeSecretsFiles[plan.kind];
      const pgPasswordPin = host.pgPasswordFiles[plan.kind];
      const baseBytes = await readRootPinnedFile(runtimeConfigPin);
      let rawBase: unknown;
      try { rawBase = JSON.parse(baseBytes.toString('utf8')) as unknown; } catch { throw failure('RESTORE_RUNTIME_CONFIG_INVALID'); }
      if (!isRecord(rawBase) || Object.prototype.hasOwnProperty.call(rawBase, 'databaseName')) throw failure('RESTORE_RUNTIME_CONFIG_INVALID');
      const derived = { ...rawBase, databaseName: plan.database.databaseName, targetGenerationId: plan.targetGenerationId };
      const derivedConfig = Buffer.from(JSON.stringify(derived), 'utf8');
      parseRuntimeConfig(derivedConfig, plan);
      const secretsBytes = await readProtectedPinnedFile(runtimeSecretsPin, 4 * 1024 * 1024, true);
      secretsBytes.fill(0);
      const passwordBytes = await readProtectedPinnedFile(pgPasswordPin, 64 * 1024, true);
      passwordBytes.fill(0);
      const controlTokenPin = host.localRuntime[plan.kind].tokenFile;
      const controlTokenBytes = await readProtectedPinnedFile(controlTokenPin, 64 * 1024, true);
      controlTokenBytes.fill(0);
      const suffix = randomUUID().replaceAll('-', '');
      const workDirectory = await makePrivateDirectory(current.workDirectory, `restore-runtime-${suffix}`);
      const gateDirectory = await makePrivateDirectory(workDirectory, 'start-gate');
      const cidDirectory = await makePrivateCidDirectory(workDirectory);
      const configPath = await writePrivateFile(workDirectory, 'runtime-config.json', derivedConfig);
      const cidFilePath = path.join(cidDirectory, 'container.cid');
      const handle: OwnedRestoreRuntimeHandle = { kind: plan.kind, handleId: `restore-${suffix}` };
      const state: RuntimeState = { handle, plan, id: '', pid: 0, workDirectory, gateDirectory, configPath, cidFilePath, ready: false, stopped: false };
      let containerCreated = false;
      try {
        abortIfNeeded(input.signal);
        const args = applyTemplate(host.launcher.startArgs[plan.kind], {
          RUNTIME_IDENTITY: plan.runtimeIdentity,
          IMAGE_DIGEST: plan.imageDigest,
          RUNTIME_CONFIG_FILE: configPath,
          RUNTIME_CONFIG_SHA256: sha256(derivedConfig),
          RUNTIME_SECRETS_FILE: runtimeSecretsPin.path,
          RUNTIME_SECRETS_SHA256: runtimeSecretsPin.sha256,
          PG_PASSWORD_FILE: pgPasswordPin.path,
          PG_PASSWORD_SHA256: pgPasswordPin.sha256,
          START_GATE_DIR: gateDirectory,
          CONTROL_TOKEN_FILE: controlTokenPin.path,
          CID_FILE: cidFilePath,
          TARGET_GENERATION_ID: plan.targetGenerationId,
        });
        const started = await runCommand(host.launcher.executable.path, args,
          { signal: input.signal, timeoutMs: START_TIMEOUT_MS, maxStdoutBytes: 4096 });
        const id = started.stdout.toString('utf8').trim().toLowerCase();
        const cidId = await readCreatedContainerId(cidFilePath, cidDirectory);
        if (!/^[a-f0-9]{64}$/.test(id) || !cidId || id !== cidId) {
          if (/^[a-f0-9]{64}$/.test(id)) state.id = id;
          else if (cidId) state.id = cidId;
          if (state.id) {
            containerCreated = true;
            state.handle = { kind: plan.kind, handleId: state.id };
            states.set(state.handle.handleId, state);
          }
          throw failure('RESTORE_RUNTIME_LAUNCH_FAILED');
        }
        state.id = id;
        containerCreated = true;
        state.handle = { kind: plan.kind, handleId: id };
        states.set(state.handle.handleId, state);
        await inspect(state, 'dormant', input.signal);
        const applied = await nftCommand(current, state, 'apply', input.signal);
        requireZeroOrThrow(applied.exitCode, applied.stdout);
        const listed = await nftCommand(current, state, 'inspect', input.signal);
        const policy = parseJsonStdout(listed);
        verifyNftPolicy(policy, host);
        const attachedArgs = applyTemplate(host.launcher.attachNetworkArgs, {
          TARGET_NETWORK_ID: host.launcher.targetNetwork.id, CONTAINER_ID: state.id,
        });
        const attached = await runCommand(host.launcher.executable.path, attachedArgs,
          { signal: input.signal, timeoutMs: COMMAND_TIMEOUT_MS, maxStdoutBytes: 4096 });
        requireZeroOrThrow(attached.exitCode, attached.stdout);
        await inspect(state, 'attached', input.signal);
        abortIfNeeded(input.signal);
        const markerPath = path.join(gateDirectory, 'ready');
        const marker = await open(markerPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
        try { await marker.chown(0, 1000); await marker.writeFile('ready\n'); await marker.sync(); await marker.chmod(0o440); }
        finally { await marker.close(); }
        state.ready = true;
        const deadline = Date.now() + GATE_WAIT_TIMEOUT_MS;
        let ready = false;
        while (Date.now() < deadline) {
          abortIfNeeded(input.signal);
          try {
            await inspect(state, 'running', input.signal);
            const h = await health.observeOrchestrator(state.handle, { signal: input.signal }).catch(() => null);
            const c = plan.kind === 'connector' ? await health.observeConnector(state.handle, { signal: input.signal }).catch(() => null) : null;
            if ((plan.kind === 'orchestrator' && h) || (plan.kind === 'connector' && c)) { ready = true; break; }
          } catch (error) { if (input.signal.aborted) throw error; }
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 500);
            const abort = () => { clearTimeout(timer); reject(failure('RESTORE_RUNTIME_PROBE_TIMEOUT')); };
            input.signal.addEventListener('abort', abort, { once: true });
            timer.unref?.();
          });
        }
        if (!ready) throw failure('RESTORE_RUNTIME_BOOTSTRAP_TIMEOUT');
        states.set(state.handle.handleId, state);
        return state.handle;
      } catch (cause) {
        if (!state.id) {
          try {
            const recoveredId = await readCreatedContainerId(cidFilePath, cidDirectory);
            if (recoveredId) {
              state.id = recoveredId;
              containerCreated = true;
              state.handle = { kind: plan.kind, handleId: recoveredId };
              states.set(state.handle.handleId, state);
            }
          } catch { throw failure('RESTORE_RUNTIME_PROBE_CLEANUP_FAILED'); }
        }
        if (containerCreated && state.id) {
          const cleanup = new AbortController();
          const kill = setTimeout(() => cleanup.abort(), CLEANUP_TIMEOUT_MS);
          try { await deleteOwned(state, cleanup.signal); } catch { throw failure('RESTORE_RUNTIME_PROBE_CLEANUP_FAILED'); }
          finally { clearTimeout(kill); }
        } else {
          try { await rm(workDirectory, { recursive: true, force: true }); } catch { throw failure('RESTORE_RUNTIME_PROBE_CLEANUP_FAILED'); }
        }
        if (input.signal.aborted) throw failure('RESTORE_RUNTIME_PROBE_TIMEOUT');
        throw cause instanceof Error && /^RESTORE_RUNTIME_/.test(cause.message) ? cause : failure('RESTORE_RUNTIME_LAUNCH_FAILED');
      }
    },
    async stopAndWait(handle: OwnedRestoreRuntimeHandle, input: { signal: AbortSignal }): Promise<void> {
      const state = ownedState(handle);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CLEANUP_TIMEOUT_MS);
      const onAbort = () => controller.abort();
      input.signal.addEventListener('abort', onAbort, { once: true });
      try { await deleteOwned(state, controller.signal); }
      finally { clearTimeout(timer); input.signal.removeEventListener('abort', onAbort); }
    },
  };

  const health: RestoreRuntimeHealthPort = {
    async observeOrchestrator(handle, input) {
      const state = ownedState(handle); const current = await manifest(); const spec = current.isolatedHost.localRuntime.orchestrator;
      const live = parseJsonStdout(await executeArgs(current.isolatedHost, state.id, HTTP_SCRIPT, encodeInput({
        action: 'health', url: new URL(spec.healthPath, spec.baseUrl).toString(),
      }), input.signal, 4096));
      if (!isRecord(live) || live.status !== 200) throw failure('RESTORE_RUNTIME_LIVENESS_UNVERIFIED');
      const result = await executeArgs(current.isolatedHost, state.id, HTTP_SCRIPT, encodeInput({
        action: 'observe-orchestrator', url: new URL(spec.observationPath, spec.internalBaseUrl).toString(), tokenFile: '/run/du-restore/control-token',
      }), input.signal, 256 * 1024);
      const parsed = parseJsonStdout(result);
      if (!isRecord(parsed) || parsed.status !== 200) throw failure('RESTORE_RUNTIME_OBSERVATION_UNAVAILABLE');
      const mapped = mapOrchestratorHealth(parsed.body);
      state.lastBootId = mapped.bootId;
      state.lastObservation = parsed.body as Record<string, unknown>;
      return mapped;
    },
    async observeConnector(handle, input) {
      const state = ownedState(handle); const current = await manifest(); const spec = current.isolatedHost.localRuntime.connector;
      const live = parseJsonStdout(await executeArgs(current.isolatedHost, state.id, HTTP_SCRIPT, encodeInput({
        action: 'health', url: new URL(spec.healthPath, spec.baseUrl).toString(),
      }), input.signal, 4096));
      if (!isRecord(live) || live.status !== 200) throw failure('RESTORE_RUNTIME_LIVENESS_UNVERIFIED');
      const identity = { slot: state.plan.slot, runtimeIdentity: state.plan.runtimeIdentity,
        replicaId: state.plan.replicaId, revision: state.plan.revision, imageDigest: state.plan.imageDigest };
      const common = { action: 'observe-connector', url: new URL(spec.observationPath, spec.baseUrl).toString(),
        tokenFile: '/run/du-restore/control-token', identity };
      const observed = parseJsonStdout(await executeArgs(current.isolatedHost, state.id, HTTP_SCRIPT, encodeInput(common), input.signal, 256 * 1024));
      if (!isRecord(observed) || observed.status !== 200) throw failure('RESTORE_RUNTIME_OBSERVATION_UNAVAILABLE');
      const effectUrl = new URL('/internal/admin/runtime-control/backup-effect-fence/observe', spec.baseUrl).toString();
      const effect = parseJsonStdout(await executeArgs(current.isolatedHost, state.id, HTTP_SCRIPT, encodeInput({
        action: 'observe-connector-effects', url: effectUrl, tokenFile: '/run/du-restore/control-token', identity,
        fenceId: randomUUID(),
      }), input.signal, 256 * 1024));
      if (!isRecord(effect) || effect.status !== 200) throw failure('RESTORE_RUNTIME_EFFECT_OBSERVATION_UNAVAILABLE');
      const mapped = mapConnectorHealth(observed.body, effect.body);
      state.lastBootId = mapped.bootId;
      state.lastObservation = observed.body as Record<string, unknown>;
      return mapped;
    },
  };

  const sourceIsolation = {
    async probeFromRuntime(handle: OwnedRestoreRuntimeHandle, destinationRef: RestoreSourceRef, input: { signal: AbortSignal }) {
      const state = ownedState(handle); const current = await manifest(); const endpoint = current.isolatedHost.sourceEndpoints[destinationRef];
      const sourceHost = endpoint?.host.startsWith('[') && endpoint.host.endsWith(']') ? endpoint.host.slice(1, -1) : endpoint?.host;
      if (!SOURCE_REFS.includes(destinationRef) || !endpoint || !sourceHost || isIP(sourceHost) === 0) throw failure('RESTORE_RUNTIME_SOURCE_PIN_INVALID');
      const listed = await nftCommand(current, state, 'inspect', input.signal);
      verifyNftPolicy(parseJsonStdout(listed), current.isolatedHost);
      const args = applyTemplate(current.isolatedHost.launcher.execArgs, {
        CONTAINER_ID: state.id, SOURCE_HOST: sourceHost, SOURCE_PORT: String(endpoint.port),
      });
      const probe = await runCommand(current.isolatedHost.launcher.executable.path, args,
        { signal: input.signal, timeoutMs: COMMAND_TIMEOUT_MS, maxStdoutBytes: 16 * 1024 });
      const raw = parseJsonStdout(probe);
      return makeSourceObservation(raw, destinationRef, state, current.isolatedHost.networkPolicy.revision);
    },
  };

  const psql = createTrustedPsqlReader;
  type TargetS3 = { client: S3Client; bucket: string; close(): void };
  async function openTargetS3(database: RestoreDatabaseIdentity, targetGenerationId: string, signal: AbortSignal): Promise<TargetS3> {
    const current = await manifest(); const recovery = await loadRecoveryRuntime(current);
    const query = psql(current).query;
    const targetText = await query(database,
      `SELECT generation_id::text||'|'||backend||'|'||encode(convert_to(endpoint,'UTF8'),'hex')||'|'||encode(convert_to(bucket,'UTF8'),'hex')||'|'||region||'|'||force_path_style::text||'|'||encode(convert_to(credential_version_ref,'UTF8'),'hex')||'|'||credential_owner_tenant_id::text||'|'||state
       FROM storage_generations WHERE generation_id=${sqlLiteral(targetGenerationId)}::uuid`, signal, 4096);
    const target = targetText.toString('utf8').trim().split('|');
    if (target.length !== 9 || target[0] !== targetGenerationId || target[1] !== 's3'
      || parseHexText(target[2]) !== recovery.config.objectStore.endpoint
      || parseHexText(target[3]) !== recovery.config.objectStore.bucket || target[4] !== recovery.config.objectStore.region
      || (target[5] !== 'true') !== recovery.config.objectStore.forcePathStyle
      || parseHexText(target[6]) !== recovery.config.objectStore.credentialSource.credentialVersionRef
      || target[7] !== recovery.config.objectStore.credentialSource.ownerTenantId || !['ACTIVE','STAGED'].includes(target[8] ?? '')) {
      throw failure('RESTORE_TARGET_STORAGE_GENERATION_UNVERIFIED');
    }
    const ref = recovery.config.objectStore.credentialSource.credentialVersionRef;
    const refMatch = /^([0-9a-f-]{36})@([1-9][0-9]{0,8})$/i.exec(ref);
    if (!refMatch) throw failure('RESTORE_TARGET_STORAGE_CREDENTIAL_PIN_INVALID');
    const credentialText = await query(database,
      `SELECT tenant_id::text||'|'||purpose||'|'||provider_kind||'|'||COALESCE(encryption_key_version,'')||'|'||encode(convert_to(encrypted_value::text,'UTF8'),'hex')
       FROM secret_catalog_revisions WHERE secret_id=${sqlLiteral(refMatch[1]!)}::uuid AND revision=${Number(refMatch[2])}`,
      signal, 128 * 1024);
    const credentialFields = credentialText.toString('utf8').trim().split('|');
    if (credentialFields.length !== 5 || credentialFields[0] !== recovery.config.objectStore.credentialSource.ownerTenantId
      || credentialFields[1] !== 'storage.credential' || credentialFields[2] !== 'managed_value' || !credentialFields[3] || !credentialFields[4]) {
      throw failure('RESTORE_TARGET_STORAGE_CREDENTIAL_UNAVAILABLE');
    }
    const keyPin = current.secretCatalogRecoveryKeys.find((pin) => pin.keyVersion === credentialFields[3]);
    if (!keyPin) throw failure('RESTORE_TARGET_STORAGE_CREDENTIAL_KEY_UNPINNED');
    const resolved = await resolvePinnedRecoveryKey(recovery, { purpose: 'secret_catalog', keyVersion: keyPin.keyVersion,
      fingerprintSha256: keyPin.fingerprintSha256, escrowRef: keyPin.escrowRef });
    let storageCredential: z.infer<typeof StorageCredentialSchema>;
    try {
      const envelope = JSON.parse(parseHexText(credentialFields[4]!)) as unknown;
      const plaintext = decryptSecretValue(envelope, resolved.key);
      try { storageCredential = StorageCredentialSchema.parse(JSON.parse(plaintext) as unknown); }
      finally { /* immutable JS strings are discarded at the end of this scope */ }
    } catch { throw failure('RESTORE_TARGET_STORAGE_CREDENTIAL_DECRYPT_FAILED'); }
    finally { resolved.key.fill(0); }
    const endpoint = new URL(recovery.config.objectStore.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
      throw failure('RESTORE_OBJECT_STORE_ENDPOINT_INVALID');
    }
    const ca = await readProtectedPinnedFile(recovery.config.objectStore.caFile, 1024 * 1024);
    const identityBytes = await readProtectedPinnedFile(recovery.config.objectStore.clientIdentityFile, 2 * 1024 * 1024);
    let cert: string; let privateKey: string;
    try {
      const identity = S3ClientIdentitySchema.parse(JSON.parse(identityBytes.toString('utf8')) as unknown);
      cert = identity.certificatePem; privateKey = identity.privateKeyPem;
    } catch { ca.fill(0); identityBytes.fill(0); throw failure('RESTORE_OBJECT_STORE_CLIENT_IDENTITY_INVALID'); }
    identityBytes.fill(0);
    const agent = new https.Agent({ ca, cert, key: privateKey, rejectUnauthorized: true, keepAlive: false, maxSockets: 8 });
    ca.fill(0);
    let requestHandler: unknown;
    try {
      const awsPath = require.resolve('@aws-sdk/client-s3');
      const handlerPath = require.resolve('@smithy/node-http-handler', { paths: [path.dirname(awsPath)] });
      const { NodeHttpHandler } = require(handlerPath) as { NodeHttpHandler: new (options: Record<string, unknown>) => unknown };
      requestHandler = new NodeHttpHandler({ httpsAgent: agent, connectionTimeout: 15_000, socketTimeout: 30_000 });
    } catch { agent.destroy(); throw failure('RESTORE_OBJECT_STORE_TRANSPORT_UNAVAILABLE'); }
    const client = new S3Client({ endpoint: endpoint.toString(), region: recovery.config.objectStore.region,
      forcePathStyle: recovery.config.objectStore.forcePathStyle, maxAttempts: 1,
      credentials: { accessKeyId: storageCredential.accessKeyId, secretAccessKey: storageCredential.secretAccessKey,
        ...(storageCredential.sessionToken ? { sessionToken: storageCredential.sessionToken } : {}) },
      requestHandler: requestHandler as never });
    storageCredential = { accessKeyId: '', secretAccessKey: '' };
    return { client, bucket: recovery.config.objectStore.bucket, close() { client.destroy(); agent.destroy(); } };
  }
  async function* targetArtifactRows(database: RestoreDatabaseIdentity, targetGenerationId: string, signal: AbortSignal): AsyncGenerator<ArtifactRow> {
    const current = await manifest();
    const sql = `SELECT encode(convert_to(a.id::text,'UTF8'),'hex')||'|'||encode(convert_to(a.tenant_id::text,'UTF8'),'hex')||'|'||encode(convert_to(a.storage_key,'UTF8'),'hex')||'|'||encode(convert_to(a.storage_version_id,'UTF8'),'hex')||'|'||COALESCE(encode(convert_to(a.manifest_version_id,'UTF8'),'hex'),'')||'|'||COALESCE(encode(convert_to(a.upload_token::text,'UTF8'),'hex'),'')||'|'||encode(convert_to(a.mime_type,'UTF8'),'hex')||'|'||COALESCE(a.sha256,'')||'|'||COALESCE(a.size_bytes::text,'')||'|'||encode(convert_to(a.storage_generation_id::text,'UTF8'),'hex')||'|'||a.purpose||'|'||COALESCE(encode(convert_to(CASE WHEN a.purpose='output' THEN
        (SELECT owner_op.api_key_id::text FROM operations owner_op WHERE owner_op.id=a.operation_id AND owner_op.tenant_id=a.tenant_id AND owner_op.deleted_at IS NULL AND owner_op.state='SUCCEEDED' LIMIT 1)
      ELSE (SELECT min(ref_op.api_key_id::text) FROM operations ref_op WHERE ref_op.tenant_id=a.tenant_id AND ref_op.deleted_at IS NULL AND ref_op.state='SUCCEEDED'
          AND COALESCE(ref_op.submit_artifacts,'[]'::jsonb) @> jsonb_build_array(jsonb_build_object('artifactId',a.id::text))) END,'UTF8'),'hex'),'')
      FROM artifacts a WHERE a.state='READY' AND a.storage_generation_id=${sqlLiteral(targetGenerationId)}::uuid ORDER BY a.id`;
    for await (const line of psql(current).queryLines(database, sql, signal, { maxBytes: 256 * 1024 * 1024 })) {
      abortIfNeeded(signal);
      const fields = line.split('|');
      if (fields.length !== 12) throw failure('RESTORE_ARTIFACT_ROW_INVALID');
      const [idHex, tenantHex, keyHex, versionHex, manifestHex, tokenHex, typeHex, storedSha, sizeText, generationHex, purpose, apiKeyHex] = fields;
      if (!idHex || !tenantHex || !keyHex || !versionHex || !tokenHex || !typeHex || !storedSha || !sizeText || !generationHex || !purpose) throw failure('RESTORE_ARTIFACT_ROW_INVALID');
      const row = { artifactId: parseHexText(idHex), tenantId: parseHexText(tenantHex), storageKey: parseHexText(keyHex),
        storageVersionId: parseHexText(versionHex), manifestVersionId: manifestHex ? parseHexText(manifestHex) : null,
        uploadToken: parseHexText(tokenHex), mimeType: parseHexText(typeHex), storedSha256: storedSha,
        storedByteSize: count(sizeText), generationId: parseHexText(generationHex), purpose,
        apiKeyId: apiKeyHex ? parseHexText(apiKeyHex) : '' };
  if (row.generationId !== targetGenerationId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.artifactId)
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.tenantId)
        || !row.storageKey || /[\u0000\r\n]/.test(row.storageKey) || !row.storageVersionId || !row.uploadToken || !SHA256.test(row.storedSha256)
        || (row.apiKeyId !== '' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.apiKeyId))) {
        throw failure('RESTORE_ARTIFACT_ROW_INVALID');
      }
      yield row;
    }
  }
  async function measureTargetArtifactBytes(database: RestoreDatabaseIdentity, targetGenerationId: string, signal: AbortSignal): Promise<{ objectBytes: number; manifestBytes: number }> {
    const storage = await openTargetS3(database, targetGenerationId, signal);
    let objectBytes = 0; let manifestBytes = 0;
    try {
      for await (const row of targetArtifactRows(database, targetGenerationId, signal)) {
        const head = await storage.client.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: row.storageKey, VersionId: row.storageVersionId }), { abortSignal: signal });
        if (!Number.isSafeInteger(head.ContentLength) || Number(head.ContentLength) !== row.storedByteSize
          || head.VersionId !== row.storageVersionId) throw failure('RESTORE_ARTIFACT_OBJECT_VERSION_UNVERIFIED');
        objectBytes += Number(head.ContentLength);
        if (!Number.isSafeInteger(objectBytes)) throw failure('RESTORE_ARTIFACT_BYTE_COUNT_INVALID');
        if (row.manifestVersionId !== null) {
          const manifestHead = await storage.client.send(new HeadObjectCommand({ Bucket: storage.bucket,
            Key: `${row.storageKey}.crypto-manifest.json`, VersionId: row.manifestVersionId }), { abortSignal: signal });
          if (!Number.isSafeInteger(manifestHead.ContentLength) || manifestHead.VersionId !== row.manifestVersionId) {
            throw failure('RESTORE_ARTIFACT_MANIFEST_VERSION_UNVERIFIED');
          }
          manifestBytes += Number(manifestHead.ContentLength);
          if (!Number.isSafeInteger(manifestBytes)) throw failure('RESTORE_ARTIFACT_BYTE_COUNT_INVALID');
        }
      }
      return { objectBytes, manifestBytes };
    } finally { storage.close(); }
  }
  async function decryptTargetArtifact(
    storage: TargetS3,
    runtime: RecoveryRuntime,
    row: ArtifactRow,
    expectedPin: { keyRef: string; keyVersion: number },
    signal: AbortSignal,
  ): Promise<RestoreArtifactRecoveryItem | null> {
    if (!row.storageVersionId || !row.manifestVersionId) throw failure('RESTORE_ARTIFACT_VERSION_PIN_MISSING');
    const sidecarKey = `${row.storageKey}.crypto-manifest.json`;
    const [objectHead, sidecarHead] = await Promise.all([
      storage.client.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: row.storageKey, VersionId: row.storageVersionId }), { abortSignal: signal }),
      storage.client.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: sidecarKey, VersionId: row.manifestVersionId }), { abortSignal: signal }),
    ]);
    if (objectHead.VersionId !== row.storageVersionId || objectHead.ContentLength !== row.storedByteSize
      || objectHead.Metadata?.artifactid !== row.artifactId || objectHead.Metadata?.tenantid !== row.tenantId
      || objectHead.Metadata?.['du-encrypted'] !== 'aes-256-gcm-v1' || objectHead.Metadata?.['du-manifest-key'] !== sidecarKey
      || sidecarHead.VersionId !== row.manifestVersionId || !Number.isSafeInteger(sidecarHead.ContentLength)
      || Number(sidecarHead.ContentLength) < 1 || Number(sidecarHead.ContentLength) > 16 * 1024 * 1024
      || sidecarHead.Metadata?.artifactid !== row.artifactId || sidecarHead.Metadata?.tenantid !== row.tenantId
      || sidecarHead.Metadata?.['du-encrypted'] !== 'manifest-v1') {
      throw failure('RESTORE_ARTIFACT_OBJECT_VERSION_UNVERIFIED');
    }
    const sidecarOutput = await storage.client.send(new GetObjectCommand({
      Bucket: storage.bucket, Key: sidecarKey, VersionId: row.manifestVersionId,
    }), { abortSignal: signal });
    const sidecarBytes = await readStoredBody(sidecarOutput.Body, 16 * 1024 * 1024, signal);
    if (sidecarBytes.length !== sidecarHead.ContentLength) { sidecarBytes.fill(0); throw failure('RESTORE_ARTIFACT_MANIFEST_SIZE_MISMATCH'); }
    const sidecarHash = sha256(sidecarBytes);
    let sidecar: unknown;
    try { sidecar = JSON.parse(sidecarBytes.toString('utf8')) as unknown; }
    catch { sidecarBytes.fill(0); throw failure('RESTORE_ARTIFACT_SIDECAR_INVALID'); }
    sidecarBytes.fill(0);
    const parsed = artifactTransitPin(sidecar, row);
    if (parsed.keyRef !== expectedPin.keyRef || parsed.keyVersion !== expectedPin.keyVersion) return null;
    const encryption = parsed.encryption;
    const plaintextSha256 = parsed.kind === 'chunked' ? encryption.fileSha256 : encryption.plaintextSha256;
    const plaintextByteSize = parsed.kind === 'chunked' ? encryption.totalSizeBytes : encryption.plaintextSizeBytes;
    if (typeof plaintextSha256 !== 'string' || !SHA256.test(plaintextSha256)
      || !Number.isSafeInteger(plaintextByteSize) || Number(plaintextByteSize) < 1
      || Number(plaintextByteSize) > CRYPTO_STORAGE_MAX_DECRYPT_BYTES) {
      throw failure('RESTORE_ARTIFACT_SIDECAR_INVALID');
    }
    const objectOutput = await storage.client.send(new GetObjectCommand({
      Bucket: storage.bucket, Key: row.storageKey, VersionId: row.storageVersionId,
    }), { abortSignal: signal });
    const ciphertext = hashBoundedStoredStream(objectOutput.Body, row.storedByteSize, row.storedSha256, signal);
    const facade = new CryptoStorageFacade(openTransitKeyProvider(runtime, signal), { maxPlaintextBytes: CRYPTO_STORAGE_MAX_DECRYPT_BYTES });
    const cryptoContext = { tenantId: row.tenantId, artifactId: row.artifactId,
      objectVersion: row.uploadToken, purpose: PUBLIC_UPLOAD_PURPOSE };
    let plaintext: Buffer;
    if (parsed.kind === 'single') {
      const bytes = await readStoredBody(ciphertext, CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES, signal);
      try {
        plaintext = await facade.decrypt({ ...(encryption as unknown as Omit<EncryptedStorageObject, 'ciphertext'>), ciphertext: bytes }, cryptoContext);
      } finally { bytes.fill(0); }
    } else {
      const opened = facade.decryptStream(ciphertext, encryption as unknown as EncryptedStorageManifest, cryptoContext);
      plaintext = await readStoredBody(opened, CRYPTO_STORAGE_MAX_DECRYPT_BYTES, signal);
    }
    const observedPlaintextSha = sha256(plaintext);
    const observedPlaintextSize = plaintext.length;
    plaintext.fill(0);
    if (observedPlaintextSha !== plaintextSha256 || observedPlaintextSize !== Number(plaintextByteSize)) {
      throw failure('RESTORE_ARTIFACT_PLAINTEXT_MISMATCH');
    }
    return {
      artifactId: row.artifactId,
      tenantId: row.tenantId,
      uploadToken: row.uploadToken,
      apiKeyIdSha256: sha256(row.apiKeyId),
      storageGenerationId: row.generationId,
      storageVersionId: row.storageVersionId,
      manifestVersionId: row.manifestVersionId,
      keyRef: parsed.keyRef,
      keyVersion: parsed.keyVersion,
      contentType: row.mimeType,
      ciphertextSha256: row.storedSha256,
      ciphertextByteSize: row.storedByteSize,
      plaintextSha256: observedPlaintextSha,
      plaintextByteSize: observedPlaintextSize,
      sidecarCiphertextSha256: sidecarHash,
      sidecarPlaintextSha256: sidecarHash,
    };
  }
  const databaseReader: RestoreDatabaseReaderPort = {
    async readCounts(input): Promise<DatabaseCountsObservation> {
      const current = await manifest(); const runQuery = psql(current).query;
      const [orch, conn] = await Promise.all([
        runQuery(input.orchestrator, ORCH_COUNT_SQL, input.signal, 64 * 1024),
        runQuery(input.connector, CONN_COUNT_SQL, input.signal, 64 * 1024),
      ]);
      const o = parsePsqlPipeCounts(orch, ORCH_COUNT_KEYS);
      const c = parsePsqlPipeCounts(conn, CONN_COUNT_KEYS);
      const storedArtifactBytes = await measureTargetArtifactBytes(input.orchestrator, input.targetGenerationId, input.signal);
      const counts = {
        operations: o.operations!, artifacts: o.artifacts!, readyArtifacts: o.readyArtifacts!,
        secretRevisions: o.secretRevisions!, storageGenerations: o.storageGenerations!,
        secretCatalogImports: o.secretCatalogImports!, connectorSecretImports: o.connectorSecretImports!, globalSettingsRevisions: o.globalSettingsRevisions!,
        retentionRevisions: o.retentionRevisions!, budgetRevisions: o.budgetRevisions!, priceRevisions: o.priceRevisions!,
        reservationGroups: o.reservationGroups!, budgetHolds: o.budgetHolds!, connectorInvocations: c.connectorInvocations!,
        connectorUsageEvents: c.connectorUsageEvents!, connectorSecretVersions: c.connectorSecretVersions!, connectorRevisions: c.connectorRevisions!,
        connectorRuntimeControls: c.connectorRuntimeControls!, connectorParityChains: c.connectorParityChains!, connectorParityRevisions: c.connectorParityRevisions!,
        connectorParityClaimIntents: c.connectorParityClaimIntents!, connectorParityDraftIntents: c.connectorParityDraftIntents!,
        financialAdjustments: o.financialAdjustments!, financialAdjustmentHeads: o.financialAdjustmentHeads!,
        financialAdjustmentCommands: o.financialAdjustmentCommands!, artifactObjectBytes: storedArtifactBytes.objectBytes,
        artifactManifestBytes: storedArtifactBytes.manifestBytes,
      };
      return { observedAt: nowIso(), counts };
    },
  };

  const control = {
    async readOrchestrator(database: RestoreDatabaseIdentity, input: { signal: AbortSignal }): Promise<DatabaseControlObservation> {
      const current = await manifest(); const query = psql(current).query;
      const runtimeIdentity = current.isolatedRuntime.orchestratorRuntimeIdentity;
      const sql = `SELECT runtime_identity,replica_id,slot,revision,image_digest,desired_control_state,desired_control_revision,control_state,control_revision,control_ack_boot_id::text,control_acknowledged_at,boot_id::text,NULLIF(current_setting('cluster_name',true),'') FROM orchestrator_service_runtimes WHERE service_runtime_id=${sqlLiteral(runtimeIdentity)} AND runtime_identity=${sqlLiteral(runtimeIdentity)}`;
      const result = await query(database, sql, input.signal, 4096);
      const fields = result.toString('utf8').trim().split('|');
      const identity = current.isolatedRuntime;
      if (fields.length !== 13 || fields[0] !== runtimeIdentity || fields[1] !== runtimeIdentity
        || fields[2] !== identity.orchestratorSlot || fields[3] !== identity.orchestratorRevision
        || fields[4] !== identity.orchestratorImageDigest || !fields[11] || fields[11] === '\\N'
        || !fields[9] || fields[9] === '\\N' || fields[9] !== fields[11]
        || fields[12] !== current.orchestratorRestoreClusterName) throw failure('RESTORE_RUNTIME_CONTROL_OBSERVATION_INVALID');
      const ackAt = fields[10] === '' || fields[10] === '\\N' ? null : new Date(fields[10]!).toISOString();
      return { observedAt: nowIso(), clusterName: fields[12],
        desiredState: fields[5] as DatabaseControlObservation['desiredState'], revision: count(fields[6]),
        acknowledgedState: fields[7] as DatabaseControlObservation['acknowledgedState'], acknowledgedRevision: count(fields[8]),
        acknowledgedAt: ackAt, acknowledgedBootId: fields[9]! };
    },
    async readConnector(database: RestoreDatabaseIdentity, input: { signal: AbortSignal }): Promise<DatabaseControlObservation> {
      const current = await manifest(); const query = psql(current).query;
      const replicaId = current.isolatedRuntime.connectorReplicaId;
      const sql = `SELECT runtime_identity,control_state,control_revision,acknowledged_at,slot,revision,image_digest,
        process_boot_id::text,acknowledged_boot_id::text,NULLIF(current_setting('cluster_name',true),'')
        FROM connector_replica_runtime_controls WHERE replica_id=${sqlLiteral(replicaId)}`;
      const result = await query(database, sql, input.signal, 4096);
      const fields = result.toString('utf8').trim().split('|');
      const state = [...states.values()].find((item) => item.handle.kind === 'connector' && item.plan.database.databaseName === database.databaseName);
      if (fields.length !== 10 || fields[0] !== current.isolatedRuntime.connectorRuntimeIdentity
        || fields[4] !== current.isolatedRuntime.connectorSlot || fields[5] !== current.isolatedRuntime.connectorRevision
        || fields[6] !== current.isolatedRuntime.connectorImageDigest || !state || !state.lastBootId
        || fields[7] !== state.lastBootId || !fields[8] || fields[8] !== fields[7]
        || fields[9] !== current.connectorRestoreClusterName) throw failure('RESTORE_RUNTIME_CONTROL_OBSERVATION_INVALID');
      const controlState = fields[1] as DatabaseControlObservation['desiredState'];
      const ackAt = fields[3] === '' || fields[3] === '\\N' ? null : new Date(fields[3]!).toISOString();
      return { observedAt: nowIso(), clusterName: fields[9]!,
        desiredState: controlState, revision: count(fields[2]), acknowledgedState: controlState, acknowledgedRevision: count(fields[2]),
        acknowledgedAt: ackAt, acknowledgedBootId: fields[8]! };
    },
  };

  const applicationReader: RestoreApplicationReaderPort = {
    async exerciseLoginAndHistory(handle, input): Promise<ApplicationRestoreObservation> {
      const state = ownedState(handle); const current = await manifest();
      const credentialBytes = await readProtectedPinnedFile(current.isolatedHost.login.credentialFile, 64 * 1024);
      let credential: z.infer<typeof LoginCredentialSchema>;
      try { credential = LoginCredentialSchema.parse(JSON.parse(credentialBytes.toString('utf8')) as unknown); }
      catch { credentialBytes.fill(0); throw failure('RESTORE_RUNTIME_LOGIN_CREDENTIAL_INVALID'); }
      credentialBytes.fill(0);
      const url = new URL(current.isolatedHost.login.url);
      let result: unknown;
      try {
        result = parseJsonStdout(await executeArgs(current.isolatedHost, state.id, HTTP_SCRIPT, encodeInput({
          action: 'login-history', loginUrl: url.toString(), credential, expectedOperationCount: input.expectedOperationCount,
        }), input.signal, 4 * 1024 * 1024));
      } finally { credential.password = ''; }
      if (!isRecord(result) || result.loginStatus !== 302 || result.historyStatus !== 200 || !Array.isArray(result.records)) {
        throw failure('RESTORE_RUNTIME_LOGIN_OR_HISTORY_UNVERIFIED');
      }
      const returnedRecords = result.records.map((row) => {
        if (!isRecord(row) || typeof row.idHash !== 'string' || typeof row.state !== 'string' || typeof row.hasResult !== 'boolean') {
          throw failure('RESTORE_RUNTIME_LOGIN_OR_HISTORY_UNVERIFIED');
        }
        const resultSha256 = row.resultSha256;
        if (!SHA256.test(row.idHash) || (resultSha256 !== null && typeof resultSha256 !== 'string')
          || (typeof resultSha256 === 'string' && !SHA256.test(resultSha256))) throw failure('RESTORE_RUNTIME_LOGIN_OR_HISTORY_UNVERIFIED');
        if (resultSha256 !== null && typeof resultSha256 !== 'string') throw failure('RESTORE_RUNTIME_LOGIN_OR_HISTORY_UNVERIFIED');
        return { operationIdSha256: row.idHash, state: row.state, hasResult: row.hasResult, resultSha256 };
      });
      return {
        observedAt: nowIso(), login: { statusCode: result.loginStatus as number, authenticatedPrincipalSha256: String(result.principalSha256) },
        history: { statusCode: result.historyStatus as number, totalRecords: count(result.totalRecords), returnedRecords },
      };
    },
    async selectArtifactForDownload(handle, items, input): Promise<RestoreArtifactRecoveryItem> {
      const state = ownedState(handle); abortIfNeeded(input.signal);
      const current = await manifest();
      const keyBytes = await readProtectedPinnedFile(current.isolatedHost.artifact.apiKeyCredentialFile, 64 * 1024);
      let apiKey: z.infer<typeof ApiKeyCredentialSchema>;
      try { apiKey = ApiKeyCredentialSchema.parse(JSON.parse(keyBytes.toString('utf8')) as unknown); }
      catch { keyBytes.fill(0); throw failure('RESTORE_ARTIFACT_API_KEY_CREDENTIAL_INVALID'); }
      keyBytes.fill(0);
      try {
        const digest = sha256(apiKey.apiKeyId);
        const candidates = items.filter((item) => item.apiKeyIdSha256 === digest);
        for (const item of candidates) {
          abortIfNeeded(input.signal);
          const sql = `SELECT 'true'::text FROM artifacts a WHERE a.id=${sqlLiteral(item.artifactId)}::uuid
            AND a.tenant_id=${sqlLiteral(item.tenantId)}::uuid AND a.state='READY' AND a.purpose IN ('input','output')
            AND a.storage_generation_id=${sqlLiteral(item.storageGenerationId)}::uuid
            AND a.storage_version_id=${sqlLiteral(item.storageVersionId)}
            AND a.manifest_version_id IS NOT DISTINCT FROM ${item.manifestVersionId === null ? 'NULL' : `${sqlLiteral(item.manifestVersionId)}::text`}
            AND a.upload_token=${sqlLiteral(item.uploadToken)}::uuid AND a.mime_type=${sqlLiteral(item.contentType)}
            AND a.sha256=${sqlLiteral(item.ciphertextSha256)} AND a.size_bytes=${item.ciphertextByteSize}
            AND EXISTS (SELECT 1 FROM api_keys k WHERE k.id=${sqlLiteral(apiKey.apiKeyId)}::uuid
              AND k.tenant_id=a.tenant_id AND k.status='ACTIVE' AND k.hash=${sqlLiteral(sha256(apiKey.apiKey))})
            AND ((a.purpose='output' AND EXISTS (SELECT 1 FROM operations owner_op WHERE owner_op.id=a.operation_id
              AND owner_op.tenant_id=a.tenant_id AND owner_op.api_key_id=${sqlLiteral(apiKey.apiKeyId)}::uuid
              AND owner_op.deleted_at IS NULL AND owner_op.state='SUCCEEDED'))
              OR EXISTS (SELECT 1 FROM operations ref_op WHERE ref_op.tenant_id=a.tenant_id
                AND ref_op.api_key_id=${sqlLiteral(apiKey.apiKeyId)}::uuid AND ref_op.deleted_at IS NULL
                AND ref_op.state='SUCCEEDED' AND COALESCE(ref_op.submit_artifacts,'[]'::jsonb) @>
                  jsonb_build_array(jsonb_build_object('artifactId',a.id::text))))`;
          const checked = (await psql(current).query(state.plan.database, sql, input.signal, 4096)).toString('utf8').trim();
          if (checked === 'true') return item;
          if (checked !== '') throw failure('RESTORE_ARTIFACT_OWNER_READ_INVALID');
        }
        throw failure('RESTORE_ARTIFACT_API_KEY_OWNER_MISMATCH');
      } finally { apiKey.apiKey = ''; }
    },
    async downloadArtifact(handle, input): Promise<RestoreArtifactDownloadObservation> {
      const state = ownedState(handle); const current = await manifest();
      const keyBytes = await readProtectedPinnedFile(current.isolatedHost.artifact.apiKeyCredentialFile, 64 * 1024);
      let apiKey: z.infer<typeof ApiKeyCredentialSchema>;
      try { apiKey = ApiKeyCredentialSchema.parse(JSON.parse(keyBytes.toString('utf8')) as unknown); }
      catch { keyBytes.fill(0); throw failure('RESTORE_ARTIFACT_API_KEY_CREDENTIAL_INVALID'); }
      keyBytes.fill(0);
      try {
        const item = input.artifact;
        if (item.storageGenerationId !== input.targetGenerationId || item.apiKeyIdSha256 !== sha256(apiKey.apiKeyId)) {
          throw failure('RESTORE_ARTIFACT_API_KEY_OWNER_MISMATCH');
        }
        // Re-read the exact DB row and the same ownership predicate enforced
        // by GET /api/v1/artifacts/:id/download immediately before the local
        // authenticated application request. The app itself performs the same
        // authorization again; this read supplies the immutable version facts
        // that the HTTP route deliberately does not echo.
        const sql = `SELECT 'true'::text FROM artifacts a WHERE a.id=${sqlLiteral(item.artifactId)}::uuid
          AND a.tenant_id=${sqlLiteral(item.tenantId)}::uuid AND a.state='READY' AND a.purpose IN ('input','output')
          AND a.storage_generation_id=${sqlLiteral(item.storageGenerationId)}::uuid
          AND a.storage_version_id=${sqlLiteral(item.storageVersionId)}
          AND a.manifest_version_id IS NOT DISTINCT FROM ${item.manifestVersionId === null ? 'NULL' : `${sqlLiteral(item.manifestVersionId)}::text`}
          AND a.upload_token=${sqlLiteral(item.uploadToken)}::uuid AND a.mime_type=${sqlLiteral(item.contentType)}
          AND a.sha256=${sqlLiteral(item.ciphertextSha256)} AND a.size_bytes=${item.ciphertextByteSize}
          AND EXISTS (SELECT 1 FROM api_keys k WHERE k.id=${sqlLiteral(apiKey.apiKeyId)}::uuid
            AND k.tenant_id=a.tenant_id AND k.status='ACTIVE' AND k.hash=${sqlLiteral(sha256(apiKey.apiKey))})
          AND ((a.purpose='output' AND EXISTS (SELECT 1 FROM operations owner_op WHERE owner_op.id=a.operation_id
            AND owner_op.tenant_id=a.tenant_id AND owner_op.api_key_id=${sqlLiteral(apiKey.apiKeyId)}::uuid
            AND owner_op.deleted_at IS NULL AND owner_op.state='SUCCEEDED'))
            OR EXISTS (SELECT 1 FROM operations ref_op WHERE ref_op.tenant_id=a.tenant_id
              AND ref_op.api_key_id=${sqlLiteral(apiKey.apiKeyId)}::uuid AND ref_op.deleted_at IS NULL
              AND ref_op.state='SUCCEEDED' AND COALESCE(ref_op.submit_artifacts,'[]'::jsonb) @>
                jsonb_build_array(jsonb_build_object('artifactId',a.id::text))))`;
        const checked = (await psql(current).query(state.plan.database, sql, input.signal, 4096)).toString('utf8').trim();
        if (checked !== 'true') throw failure('RESTORE_ARTIFACT_VERSION_CHANGED');
        const url = new URL(current.isolatedHost.artifact.downloadPath.replace('{artifactId}', encodeURIComponent(item.artifactId)), current.isolatedHost.artifact.baseUrl);
        const result = parseJsonStdout(await executeArgs(current.isolatedHost, state.id, HTTP_SCRIPT, encodeInput({
          action: 'artifact-download', url: url.toString(), apiKey, maxBodyBytes: CRYPTO_STORAGE_MAX_DECRYPT_BYTES,
        }), input.signal, 128 * 1024 * 1024));
        if (!isRecord(result) || count(result.status) !== 200 || typeof result.contentType !== 'string'
          || typeof result.bytes !== 'string' || result.contentType !== item.contentType) throw failure('RESTORE_ARTIFACT_DOWNLOAD_UNVERIFIED');
        const bytes = Buffer.from(result.bytes, 'base64');
        if (bytes.toString('base64') !== result.bytes || bytes.length > CRYPTO_STORAGE_MAX_DECRYPT_BYTES) {
          bytes.fill(0); throw failure('RESTORE_ARTIFACT_DOWNLOAD_LIMIT_EXCEEDED');
        }
        return { statusCode: 200, storageGenerationId: item.storageGenerationId,
          storageVersionId: item.storageVersionId, manifestVersionId: item.manifestVersionId,
          contentType: result.contentType, body: [bytes] };
      } finally { apiKey.apiKey = ''; }
    },
  };

  const recoveryReader: RestoreRecoveryReaderPort = {
    async recoverSecretCatalogKey(input) {
      const current = await manifest(); const runtime = await loadRecoveryRuntime(current);
      const pin = await resolvePinnedRecoveryKey(runtime, { purpose: 'secret_catalog', keyVersion: input.pin.keyVersion,
        fingerprintSha256: input.pin.fingerprintSha256 });
      const queryLines = psql(current).queryLines;
      const sql = `SELECT record_kind||'|'||encode(convert_to(secret_id,'UTF8'),'hex')||'|'||encode(convert_to(revision::text,'UTF8'),'hex')||'|'||encode(convert_to(encrypted_value::text,'UTF8'),'hex')
        FROM (
          SELECT 'revision'::text AS record_kind,secret_id::text,revision,encryption_key_version,encrypted_value FROM secret_catalog_revisions
          UNION ALL
          SELECT 'currentSecret'::text AS record_kind,secret_id::text,revision,encryption_key_version,encrypted_value FROM secret_catalog
        ) catalog_rows
        WHERE encryption_key_version=${sqlLiteral(input.pin.keyVersion)} AND encrypted_value IS NOT NULL
        ORDER BY record_kind,secret_id,revision`;
      const observedAt = nowIso();
      return {
        key: { keyVersion: input.pin.keyVersion, fingerprintSha256: input.pin.fingerprintSha256,
          registryIdentity: runtime.registryIdentity, observedAt },
        items: (async function* () {
          try {
            for await (const line of queryLines(input.database, sql, input.signal, { maxBytes: 128 * 1024 * 1024 })) {
              abortIfNeeded(input.signal);
              const [kind, idHex, revisionHex, ciphertextHex] = line.split('|');
              if ((kind !== 'revision' && kind !== 'currentSecret') || !idHex || !revisionHex || !ciphertextHex) {
                throw failure('RESTORE_SECRET_CATALOG_ROW_INVALID');
              }
              const secretId = parseHexText(idHex); const revision = parseHexText(revisionHex);
              const ciphertextText = parseHexText(ciphertextHex);
              let envelope: unknown;
              try { envelope = JSON.parse(ciphertextText) as unknown; } catch { throw failure('RESTORE_SECRET_CATALOG_ENVELOPE_INVALID'); }
              let plaintext: string;
              try { plaintext = decryptSecretValue(envelope, pin.key); } catch { throw failure('RESTORE_SECRET_CATALOG_AUTH_FAILED'); }
              const plaintextSha256 = sha256(plaintext);
              const ciphertextSha256 = sha256(ciphertextText);
              yield { recordIdSha256: sha256(`${kind}|${secretId}|${revision}`), keyVersion: input.pin.keyVersion,
                recordKind: kind, ciphertextSha256, plaintextSha256 };
              plaintext = '';
            }
          } finally { pin.key.fill(0); }
        })(),
      };
    },
    async recoverConnectorInvocationKey(input) {
      const current = await manifest(); const runtime = await loadRecoveryRuntime(current);
      const pin = await resolvePinnedRecoveryKey(runtime, { purpose: 'connector_invocation', keyVersion: String(input.pin.keyVersion),
        fingerprintSha256: input.pin.fingerprintSha256, escrowRef: input.pin.keyRef });
      const queryLines = psql(current).queryLines;
      const sql = `SELECT source_kind||'|'||encode(convert_to(tenant_id,'UTF8'),'hex')||'|'||encode(convert_to(source_id,'UTF8'),'hex')||'|'||encode(convert_to(slot,'UTF8'),'hex')||'|'||encode(convert_to(ref_id,'UTF8'),'hex')||'|'||encode(convert_to(raw_value,'UTF8'),'hex')
        FROM (
          SELECT 'request'::text AS source_kind,tenant_id::text,invocation_id AS source_id,'connector_invocations.request'::text AS slot,invocation_id AS ref_id,request::text AS raw_value FROM connector_invocations
          UNION ALL SELECT 'result',tenant_id::text,invocation_id,'connector_invocations.result',invocation_id,result::text FROM connector_invocations WHERE result IS NOT NULL
          UNION ALL SELECT 'session',tenant_id::text,invocation_id,'connector_invocations.session_ref',invocation_id,session_ref FROM connector_invocations WHERE session_ref IS NOT NULL
          UNION ALL SELECT 'revision',tenant_id::text,tenant_id::text||':'||connector_id||':'||revision::text,'connector_parity_revisions.recipe',connector_id||':'||revision::text,recipe_envelope::text FROM connector_parity_revisions
          UNION ALL SELECT 'draft',tenant_id::text,tenant_id::text||':'||connector_id||':'||idempotency_key,'connector_parity_revisions.recipe',connector_id||':'||revision::text,recipe_envelope::text FROM connector_parity_draft_intents
        ) invocation_rows ORDER BY source_kind,source_id`;
      const fingerprintSha256 = input.pin.fingerprintSha256;
      const observedAt = nowIso();
      return {
        key: { keyRef: input.pin.keyRef, keyVersion: input.pin.keyVersion, fingerprintSha256,
          registryIdentity: runtime.registryIdentity, observedAt },
        items: (async function* () {
          try {
            for await (const line of queryLines(input.database, sql, input.signal, { maxBytes: 256 * 1024 * 1024 })) {
              abortIfNeeded(input.signal);
              const [sourceKind, tenantHex, sourceIdHex, slotHex, refHex, rawHex] = line.split('|');
              if (!sourceKind || !tenantHex || !sourceIdHex || !slotHex || !refHex || !rawHex) throw failure('RESTORE_CONNECTOR_INVOCATION_ROW_INVALID');
              const tenantId = parseHexText(tenantHex); const sourceId = parseHexText(sourceIdHex);
              const slot = parseHexText(slotHex); const refId = parseHexText(refHex); const serialized = parseHexText(rawHex);
              let envelope: unknown;
              try { envelope = JSON.parse(serialized) as unknown; } catch { throw failure('RESTORE_CONNECTOR_INVOCATION_ENVELOPE_INVALID'); }
              if (!isRecord(envelope) || !isRecord(envelope.dek)) throw failure('RESTORE_CONNECTOR_INVOCATION_ENVELOPE_INVALID');
              if (envelope.keyRef !== input.pin.keyRef || envelope.dek.keyName !== input.pin.keyRef
                || envelope.dek.keyVersion !== input.pin.keyVersion) continue;
              const plaintext = openConnectorInvocationEnvelope(envelope, { tenantId, slot, refId }, input.pin.keyRef, input.pin.keyVersion, pin.key);
              const plaintextSha256 = sha256(plaintext); plaintext.fill(0);
              yield { envelopeIdSha256: sha256(`${sourceKind}|${tenantId}|${sourceId}|${slot}|${refId}`),
                keyRef: input.pin.keyRef, keyVersion: input.pin.keyVersion,
                ciphertextSha256: sha256(serialized), plaintextSha256 };
            }
          } finally { pin.key.fill(0); }
        })(),
      };
    },
    async recoverConnectorCredentialKey(input) {
      const current = await manifest(); const runtime = await loadRecoveryRuntime(current);
      const resolved = await resolvePinnedRecoveryKey(runtime, { purpose: 'connector_credential', keyVersion: input.pin.keyVersion,
        fingerprintSha256: input.pin.fingerprintSha256 });
      const encodedKey = Buffer.from(resolved.key);
      const kek = Buffer.from(encodedKey.toString('utf8'), 'base64');
      if (encodedKey.length !== 44 || !/^[A-Za-z0-9+/]{43}=$/.test(encodedKey.toString('utf8'))
        || kek.length !== 32 || kek.toString('base64') !== encodedKey.toString('utf8')) {
        encodedKey.fill(0); kek.fill(0); resolved.key.fill(0); throw failure('RESTORE_CONNECTOR_CREDENTIAL_KEY_INVALID');
      }
      const queryLines = psql(current).queryLines;
      const sql = `WITH credential_refs AS (
          SELECT credential_ref FROM connector_revisions
          UNION SELECT credential_ref FROM connector_parity_revisions WHERE credential_source->>'kind'='legacy-db'
          UNION SELECT credential_ref FROM connector_parity_draft_intents WHERE credential_source->>'kind'='legacy-db'
        ) SELECT encode(convert_to(versioned.id,'UTF8'),'hex')||'|'||encode(versioned.encrypted_value,'hex')
          FROM secret_versions versioned WHERE EXISTS
          (SELECT 1 FROM credential_refs refs WHERE refs.credential_ref=versioned.credential_ref) ORDER BY versioned.id`;
      const observedAt = nowIso();
      return {
        key: { keyVersion: input.pin.keyVersion, fingerprintSha256: input.pin.fingerprintSha256,
          registryIdentity: runtime.registryIdentity, observedAt },
        items: (async function* () {
          try {
            for await (const line of queryLines(input.database, sql, input.signal, { maxBytes: 128 * 1024 * 1024 })) {
              abortIfNeeded(input.signal);
              const [idHex, encryptedHex] = line.split('|');
              if (!idHex || !encryptedHex || !/^(?:[0-9a-f]{2})+$/i.test(encryptedHex)) throw failure('RESTORE_CONNECTOR_CREDENTIAL_ROW_INVALID');
              const id = parseHexText(idHex); const encrypted = Buffer.from(encryptedHex, 'hex');
              if (encrypted.length < 28) throw failure('RESTORE_CONNECTOR_CREDENTIAL_CIPHERTEXT_INVALID');
              let plaintext: Buffer;
              try {
                const decipher = createDecipheriv('aes-256-gcm', kek, encrypted.subarray(0, 12), { authTagLength: 16 });
                decipher.setAuthTag(encrypted.subarray(12, 28));
                plaintext = Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]);
              } catch { throw failure('RESTORE_CONNECTOR_CREDENTIAL_AUTH_FAILED'); }
              const item = { secretVersionIdSha256: sha256(id), keyVersion: input.pin.keyVersion,
                ciphertextSha256: sha256(encrypted), plaintextSha256: sha256(plaintext) };
              plaintext.fill(0); encrypted.fill(0); yield item;
            }
          } finally { kek.fill(0); encodedKey.fill(0); resolved.key.fill(0); }
        })(),
      };
    },
    async recoverMetadataTransitKey(input) {
      const current = await manifest(); const runtime = await loadRecoveryRuntime(current);
      const fingerprintSha256 = await transitVersionFingerprint(runtime, 'metadataTransit', input.pin.keyRef, input.pin.keyVersion, input.signal);
      const queryLines = psql(current).queryLines;
      const sql = `SELECT encode(convert_to(slot,'UTF8'),'hex')||'|'||encode(convert_to(tenant_id,'UTF8'),'hex')||'|'||encode(convert_to(ref_id,'UTF8'),'hex')||'|'||encode(convert_to(raw_value,'UTF8'),'hex')
        FROM (
          SELECT 'operations.input_ref'::text AS slot,tenant_id::text,id::text AS ref_id,input_ref::text AS raw_value FROM operations WHERE input_ref IS NOT NULL
          UNION ALL SELECT 'tasks.payload_ref',op.tenant_id::text,t.id::text,t.payload_ref::text FROM tasks t JOIN operations op ON op.id=t.operation_id WHERE t.payload_ref IS NOT NULL
          UNION ALL SELECT 'human_waits.response_ref',op.tenant_id::text,w.wait_id,w.response_ref::text FROM human_waits w JOIN operations op ON op.id=w.operation_id WHERE w.response_ref IS NOT NULL
          UNION ALL SELECT 'step_checkpoints.output_ref',op.tenant_id::text,c.task_id::text||':'||c.step_key,c.output_ref::text FROM step_checkpoints c JOIN tasks t ON t.id=c.task_id JOIN operations op ON op.id=t.operation_id WHERE c.output_ref IS NOT NULL
          UNION ALL SELECT 'step_checkpoints.session_ref',op.tenant_id::text,c.task_id::text||':'||c.step_key||':'||c.generation::text,c.session_ref::text FROM step_checkpoints c JOIN tasks t ON t.id=c.task_id JOIN operations op ON op.id=t.operation_id WHERE c.session_ref IS NOT NULL
          UNION ALL SELECT 'operations.prompt_overrides_ref',tenant_id::text,id::text,prompt_overrides_ref::text FROM operations WHERE prompt_overrides_ref IS NOT NULL
          UNION ALL SELECT 'tasks.result_ref',op.tenant_id::text,t.id::text,t.result_ref::text FROM tasks t JOIN operations op ON op.id=t.operation_id WHERE t.result_ref IS NOT NULL
          UNION ALL SELECT 'operations.result_ref',tenant_id::text,id::text,result_ref::text FROM operations WHERE result_ref IS NOT NULL
          UNION ALL SELECT 'legacy_workflow_schemas.schema_ref',tenant_id::text,slug||':'||revision::text,schema_ref::text FROM legacy_workflow_schemas
          UNION ALL SELECT 'settings_revisions.payload_ref',ss.tenant_id::text,sr.stream_id::text||':'||sr.revision::text,sr.payload_ref::text FROM settings_revisions sr JOIN settings_streams ss ON ss.id=sr.stream_id
          UNION ALL SELECT 'connector_prompt_overrides.prompt_override',tenant_id::text,json_build_array(connection_id,api_key_id,endpoint_slug,step_id)::text,prompt_override FROM connector_prompt_overrides WHERE prompt_override IS NOT NULL
          UNION ALL SELECT 'global_settings.tenant_revision',tenant_id::text,tenant_id::text||':'||stream||':'||revision::text,payload_ref::text FROM global_settings_tenant_revisions
          UNION ALL SELECT 'operations.tenant_defaults_ref',tenant_id::text,id::text,tenant_defaults_ref::text FROM operations WHERE tenant_defaults_ref IS NOT NULL
          UNION ALL SELECT 'operations.connector_recipe_pins_ref',tenant_id::text,id::text,connector_recipe_pins_ref::text FROM operations WHERE connector_recipe_pins_ref IS NOT NULL
          UNION ALL SELECT 'connector_secret_imports.resolved_payload',tenant_id::text,import_id::text,resolved_payload::text FROM connector_secret_imports
        ) metadata_rows ORDER BY slot,ref_id`;
      const observedAt = nowIso();
      return {
        key: { keyRef: input.pin.keyRef, keyVersion: input.pin.keyVersion, fingerprintSha256,
          registryIdentity: runtime.registryIdentity, observedAt },
        items: (async function* () {
          const provider = {
            async wrapDek(): Promise<never> { throw failure('RESTORE_TRANSIT_WRAP_NOT_ALLOWED'); },
            async unwrapDek(wrapped: { version: number; keyName: string; keyVersion: number; wrappedKey: string }): Promise<Buffer> {
              if (wrapped.keyName !== input.pin.keyRef || wrapped.keyVersion !== input.pin.keyVersion) throw failure('RESTORE_METADATA_TRANSIT_PIN_MISMATCH');
              return unwrapTransitDek(runtime, 'metadataTransit', { keyRef: wrapped.keyName, keyVersion: wrapped.keyVersion,
                ciphertext: wrapped.wrappedKey }, input.signal);
            },
          };
          const crypto = createMetadataCrypto(provider, input.pin.keyRef);
          for await (const line of queryLines(input.database, sql, input.signal, { maxBytes: 256 * 1024 * 1024 })) {
            abortIfNeeded(input.signal);
            const [slotHex, tenantHex, refHex, rawHex] = line.split('|');
            if (!slotHex || !tenantHex || !refHex || !rawHex) throw failure('RESTORE_METADATA_ROW_INVALID');
            const slot = parseHexText(slotHex); const tenantId = parseHexText(tenantHex); const refText = parseHexText(refHex);
            const serialized = parseHexText(rawHex);
            let envelope: unknown;
            try { envelope = JSON.parse(serialized) as unknown; } catch { continue; }
            if (!crypto.isSealed(envelope)) continue;
            if (envelope.keyRef !== input.pin.keyRef || envelope.dek.keyName !== input.pin.keyRef
              || envelope.dek.keyVersion !== input.pin.keyVersion) continue;
            const refId = metadataRecoveryRefId(slot, refText);
            const context: MetadataContext = { tenantId, slot: slot as MetadataContext['slot'], refId };
            let plaintext: unknown;
            try { plaintext = await crypto.open(envelope, context); } catch { throw failure('RESTORE_METADATA_AUTH_FAILED'); }
            if (metadataPlaintextHash(plaintext) !== envelope.plaintextSha256) throw failure('RESTORE_METADATA_PLAINTEXT_HASH_MISMATCH');
            yield { envelopeIdSha256: sha256(`${slot}|${tenantId}|${refId}`), keyRef: input.pin.keyRef,
              keyVersion: input.pin.keyVersion, ciphertextSha256: sha256(serialized), plaintextSha256: metadataPlaintextHash(plaintext) };
          }
        })(),
      };
    },
    async readVaultCredential(input) {
      const current = await manifest(); const runtime = await loadRecoveryRuntime(current);
      const matches = runtime.config.connectorVaultCredentialPins.filter((pin) => canonicalHash(pin) === input.pinSha256);
      if (matches.length !== 1) throw failure('RESTORE_VAULT_PIN_MISMATCH');
      const pin = matches[0]!;
      const ca = await readProtectedPinnedFile(runtime.config.vault.caFile, 1024 * 1024);
      const tokenBytes = await readProtectedPinnedFile(runtime.config.vault.tokenFile, 64 * 1024);
      const token = tokenBytes.toString('utf8').trim(); tokenBytes.fill(0);
      if (!token || /[\r\n\u0000]/.test(token)) { ca.fill(0); throw failure('RESTORE_VAULT_IDENTITY_INVALID'); }
      const mount = pin.mount.split('/').map(encodeURIComponent).join('/');
      const secretPath = pin.path.split('/').map(encodeURIComponent).join('/');
      const url = new URL(`/v1/${mount}/data/${secretPath}`, runtime.config.vault.endpoint);
      url.searchParams.set('version', String(pin.version));
      try {
        const response = await readHttpsJson(url, { method: 'GET', ca, signal: input.signal,
          headers: { 'x-vault-token': token, accept: 'application/json' }, maxBytes: 2 * 1024 * 1024 });
        if (response.status !== 200 || !isRecord(response.body) || !isRecord(response.body.data)
          || !isRecord(response.body.data.data) || !isRecord(response.body.data.metadata)
          || Number(response.body.data.metadata.version) !== pin.version || !(pin.key in response.body.data.data)) {
          throw failure('RESTORE_VAULT_EXACT_VERSION_UNVERIFIED');
        }
        return { observedAt: nowIso(), pinSha256: input.pinSha256, requestedVersion: pin.version,
          observedVersion: Number(response.body.data.metadata.version), valueSha256: canonicalHash(response.body.data.data[pin.key]) };
      } finally { ca.fill(0); }
    },
    async recoverArtifactTransitKey(input) {
      const current = await manifest(); const runtime = await loadRecoveryRuntime(current);
      const fingerprintSha256 = await transitVersionFingerprint(runtime, 'artifactTransit', input.pin.keyRef, input.pin.keyVersion, input.signal);
      const storage = await openTargetS3(input.database, input.targetGenerationId, input.signal);
      const observedAt = nowIso();
      return {
        key: { keyRef: input.pin.keyRef, keyVersion: input.pin.keyVersion, fingerprintSha256,
          registryIdentity: runtime.registryIdentity, observedAt },
        items: (async function* () {
          try {
            for await (const row of targetArtifactRows(input.database, input.targetGenerationId, input.signal)) {
              abortIfNeeded(input.signal);
              const verified = await decryptTargetArtifact(storage, runtime, row, input.pin, input.signal);
              if (verified) yield verified;
            }
          } finally { storage.close(); }
        })(),
      };
    },
  };

  return { launch, health, control, sourceIsolation, databaseReader, applicationReader, recoveryReader };
}
