import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { isIP } from 'node:net';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { QueryResultRow } from 'pg';
import type { Db } from '../../db/db';
import type { ArtifactService } from '../artifacts/artifacts';
import {
  ARTIFACT_SIDECAR_CONTENT_TYPE,
  manifestKeyFor,
  manifestObjectMetadata,
  sealedObjectMetadata,
} from '../artifacts/artifact-encryption';
import type { StorageGenerationService } from '../artifacts/storage-generations';
import { backupTargetPinDigest, type BackupAdapter, type BackupTarget, type BackupTargetPreviewDescriptor, type MaintenanceExecutionFence } from './maintenance-service';
import type { BackupArtifactEffectObservation, BackupArtifactEffectPort, BackupArtifactSnapshotPin, BackupCapabilitySnapshot } from './backup-effect-fence';
import type { ReplicaRuntimeObservation } from './replica-runtime-safety';
import { matchesVaultAccountPath, VaultKv2PinSchema, type MaintenanceScope } from '@du/contracts';
import type { ConnectorBackupEffectFenceObservation } from '@du/contracts';
import { registerActiveMaintenanceCommand } from './active-command-shutdown';

const SHA256 = /^[a-f0-9]{64}$/;
const SECRET_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@[1-9][0-9]{0,8}$/i;
const ExternalKeyRef = z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,511}$/);
const TransitKeyRef = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/);
const SafeId = z.string().min(1).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const AbsolutePath = z.string().min(1).max(4096).refine((value) => path.isAbsolute(value) && path.normalize(value) === value);
const FilePin = z.object({ path: AbsolutePath, sha256: z.string().regex(SHA256) }).strict();
const ToolPin = FilePin;

/** Use the canonical artifact reader/gateway sidecar path on restore writes. */
export function restoredArtifactManifestObjectKey(storageKey: string): string {
  return manifestKeyFor(storageKey);
}
export function restoredArtifactWriteMetadata(input: {
  storageKey: string;
  artifactId: string;
  tenantId: string;
  sealed: boolean;
}): { ciphertext?: Record<string, string>; manifest?: Record<string, string> } {
  if (!input.sealed) return {};
  const manifestKey = restoredArtifactManifestObjectKey(input.storageKey);
  return {
    ciphertext: sealedObjectMetadata({ artifactId: input.artifactId, tenantId: input.tenantId, manifestKey }),
    manifest: manifestObjectMetadata({ artifactId: input.artifactId, tenantId: input.tenantId }),
  };
}
const ArgvSchema = z.array(z.string().min(1).max(4096).refine((value) => !/[\u0000\r\n]/.test(value)))
  .min(1).max(96);
const LocalServiceUrl = z.string().url().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
});
const RestoreSourceRefSchema = z.enum([
  'orchestratorSourceDb', 'connectorSourceDb', 'sourceCatalogKeyring', 'sourceConnectorRecoveryRegistry',
  'sourceMetadataTransit', 'sourceArtifactTransit', 'sourceVault',
]);
const RestoreSourceEndpointSchema = z.object({
  protocol: z.enum(['tcp', 'http', 'https']),
  host: z.string().min(1).max(253).refine((value) => isIP(value) !== 0
    || (value.startsWith('[') && value.endsWith(']') && isIP(value.slice(1, -1)) === 6),
  'source-isolation probes must pin literal IP addresses; DNS would leave an untracked egress path'),
  port: z.number().int().min(1).max(65535),
  ruleId: z.string().min(1).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
}).strict();
const RestoreSourceMapSchema = z.object({
  orchestratorSourceDb: RestoreSourceEndpointSchema,
  connectorSourceDb: RestoreSourceEndpointSchema,
  sourceCatalogKeyring: RestoreSourceEndpointSchema,
  sourceConnectorRecoveryRegistry: RestoreSourceEndpointSchema,
  sourceMetadataTransit: RestoreSourceEndpointSchema,
  sourceArtifactTransit: RestoreSourceEndpointSchema,
  sourceVault: RestoreSourceEndpointSchema,
}).strict();
const TransitMapSchema = z.record(TransitKeyRef, SafeId);
export const TrustedRestoreReaderConfigSchema = z.object({
  schemaVersion: z.literal(1),
  /** The host replaces this only with the exact staged generation from the
   * durable restore request; no caller-provided endpoint or credential is accepted. */
  targetStorageGenerationId: z.literal('${TARGET_STORAGE_GENERATION_ID}'),
  recoveryKeyRegistry: FilePin,
  objectStore: z.object({
    endpoint: z.string().url().max(2048), bucket: z.string().min(1).max(255), region: SafeId,
    forcePathStyle: z.boolean(),
    credentialSource: z.object({ kind: z.literal('restored-catalog'), credentialVersionRef: z.string().regex(SECRET_REF), ownerTenantId: z.string().uuid() }).strict(),
    caFile: FilePin, clientIdentityFile: FilePin,
  }).strict(),
  transit: z.object({
    endpoint: z.string().url().max(2048), caFile: FilePin, tokenFile: FilePin,
    keyNameByRef: z.object({ artifactTransit: TransitMapSchema, metadataTransit: TransitMapSchema }).strict(),
  }).strict(),
  vault: z.object({ endpoint: z.string().url().max(2048), caFile: FilePin, tokenFile: FilePin }).strict(),
  connectorVaultCredentialPins: z.array(z.object({
    recordKind: z.enum(['revision','draft']), tenantId: z.string().uuid(), connectorId: SafeId,
    revision: z.number().int().positive(), account: SafeId, mount: SafeId, path: z.string().min(1).max(1024),
    key: SafeId, version: z.number().int().positive(),
  }).strict()).max(100_000),
}).strict();
export type TrustedRestoreReaderConfig = z.infer<typeof TrustedRestoreReaderConfigSchema>;
const LiteralIpAddress = z.string().min(1).max(64).refine((value) => isIP(value) !== 0,
  'isolated service endpoints must be literal IP addresses, not DNS names');
export const TrustedIsolatedRuntimeConfigSchema = z.object({
  schemaVersion: z.literal(1),
  service: z.enum(['orchestrator', 'connector']),
  clusterName: SafeId,
  runtimeIdentity: SafeId,
  revision: SafeId,
  imageDigest: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/i),
  replicaId: SafeId.optional(),
  slot: z.enum(['blue', 'green']).optional(),
  bindHost: z.literal('0.0.0.0'),
  port: z.number().int().min(1).max(65535),
  internalHost: z.literal('127.0.0.1').optional(),
  internalPort: z.number().int().min(1).max(65535).optional(),
  /** The rendered Admin shell is a separate loopback-only listener used for
   * restored-process login/history probes. */
  adminShellHost: z.literal('127.0.0.1').optional(),
  adminShellPort: z.number().int().min(1).max(65535).optional(),
  database: z.object({
    host: LiteralIpAddress,
    port: z.number().int().min(1).max(65535),
    user: SafeId,
    sslMode: z.enum(['disable', 'require', 'verify-full']),
  }).strict(),
  redis: z.object({ host: LiteralIpAddress, port: z.number().int().min(1).max(65535) }).strict(),
  /** Present only in the derived per-launch config; must equal the new
   * databaseName from the trusted restore plan, never the caller's source DB. */
  databaseName: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/).optional(),
  /** Present only in the derived per-launch config and pinned to the staged
   * isolated generation selected by the durable restore job. */
  targetGenerationId: z.string().uuid().optional(),
}).strict().superRefine((config, ctx) => {
  if (config.service === 'orchestrator' && (config.replicaId !== undefined || config.slot === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['replicaId'], message: 'Orchestrator runtime config requires a slot and derives replica identity from runtimeIdentity' });
  }
  if (config.service === 'orchestrator' && (config.internalHost !== '127.0.0.1' || config.internalPort === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['internalPort'], message: 'Orchestrator requires its loopback-only internal listener' });
  }
  if (config.service === 'orchestrator' && (config.adminShellHost !== '127.0.0.1' || config.adminShellPort === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['adminShellPort'], message: 'Orchestrator requires its loopback-only Admin shell listener' });
  }
  if (config.service === 'connector' && (config.internalHost !== undefined || config.internalPort !== undefined
    || config.adminShellHost !== undefined || config.adminShellPort !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['internalPort'], message: 'Connector restore runtime does not have a second listener' });
  }
  if (config.service === 'connector' && (!config.replicaId || !config.slot)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['replicaId'], message: 'Connector runtime config requires exact replicaId and slot pins' });
  }
});
export type TrustedIsolatedRuntimeConfig = z.infer<typeof TrustedIsolatedRuntimeConfigSchema>;
const RuntimeConfigFilesSchema = z.object({ orchestrator: FilePin, connector: FilePin }).strict();
const RuntimeSecretsFilesSchema = z.object({ orchestrator: FilePin, connector: FilePin }).strict();
const PgPasswordFilesSchema = z.object({ orchestrator: FilePin, connector: FilePin }).strict();
const IsolatedHostSchema = z.object({
  /** Dedicated non-web executor identity; never supplied by the maintenance request. */
  hostRunnerIdentity: SafeId,
  runtimeUid: z.literal(1000),
  runtimeGid: z.literal(1000),
  runtimeConfigFiles: RuntimeConfigFilesSchema,
  runtimeSecretsFiles: RuntimeSecretsFilesSchema,
  pgPasswordFiles: PgPasswordFilesSchema,
  launcher: z.object({
    executable: ToolPin,
    startArgs: z.object({ orchestrator: ArgvSchema, connector: ArgvSchema }).strict(),
    /** Exact precreated target-only Docker network; attach occurs after nft policy installation. */
    targetNetwork: z.object({ id: z.string().regex(/^[a-f0-9]{64}$/i), name: SafeId }).strict(),
    attachNetworkArgs: ArgvSchema,
    inspectArgs: ArgvSchema,
    execArgs: ArgvSchema,
    stopArgs: ArgvSchema,
  }).strict(),
  networkPolicy: z.object({
    revision: z.string().regex(SHA256),
    rulesFile: FilePin,
    /** Must enter the verified container network namespace before applying or listing rules. */
    namespaceTool: ToolPin,
    nftTool: ToolPin,
    sourceRuleIds: z.object({
      orchestratorSourceDb: SafeId,
      connectorSourceDb: SafeId,
      sourceCatalogKeyring: SafeId,
      sourceConnectorRecoveryRegistry: SafeId,
      sourceMetadataTransit: SafeId,
      sourceArtifactTransit: SafeId,
      sourceVault: SafeId,
    }).strict(),
  }).strict(),
  sourceEndpoints: RestoreSourceMapSchema,
  localRuntime: z.object({
    orchestrator: z.object({
      baseUrl: LocalServiceUrl,
      internalBaseUrl: LocalServiceUrl,
      healthPath: z.literal('/health'),
      observationPath: z.literal('/api/internal/service-runtime/observation'),
      tokenFile: FilePin,
    }).strict(),
    connector: z.object({
      baseUrl: LocalServiceUrl,
      healthPath: z.literal('/health/live'),
      observationPath: z.literal('/internal/admin/runtime-control/observe'),
      tokenFile: FilePin,
    }).strict(),
  }).strict(),
  login: z.object({ url: LocalServiceUrl, credentialFile: FilePin }).strict(),
  artifact: z.object({
    baseUrl: LocalServiceUrl,
    historyPath: z.literal('/admin/api/operations'),
    detailPath: z.literal('/admin/api/operations/{operationId}'),
    downloadPath: z.literal('/api/v1/artifacts/{artifactId}/download'),
    apiKeyCredentialFile: FilePin,
  }).strict(),
  libpq: z.object({
    serviceFile: FilePin,
    passFile: FilePin,
    orchestratorService: SafeId,
    connectorService: SafeId,
  }).strict(),
  recoveryReaders: z.object({
    configFile: FilePin,
    objectStore: z.object({ endpoint: z.string().url().max(2048), caFile: FilePin, clientIdentityFile: FilePin }).strict(),
    transit: z.object({ endpoint: z.string().url().max(2048), caFile: FilePin, tokenFile: FilePin }).strict(),
    vault: z.object({ endpoint: z.string().url().max(2048), caFile: FilePin, tokenFile: FilePin }).strict(),
  }).strict(),
}).strict();
const ReplicaPin = z.object({
  slot: z.enum(['blue','green']), replicaId: SafeId, runtimeIdentity: SafeId,
  revision: SafeId, imageDigest: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/i),
}).strict();
const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  hostId: SafeId,
  ownerTenantId: z.string().uuid(),
  bundleDirectory: AbsolutePath,
  workDirectory: AbsolutePath,
  orchestratorSourceClusterName: SafeId,
  connectorSourceClusterName: SafeId,
  orchestratorRestoreClusterName: SafeId,
  connectorRestoreClusterName: SafeId,
  services: z.object({ orchestratorSource: SafeId, connectorSource: SafeId, orchestratorRestoreAdmin: SafeId, connectorRestoreAdmin: SafeId }).strict(),
  restoreOwnerRole: SafeId,
  libpqServiceFile: FilePin,
  passfile: FilePin,
  tools: z.object({ pgDump: ToolPin, pgRestore: ToolPin, createdb: ToolPin, psql: ToolPin }).strict(),
  /** The six source runtime identities/control targets come from a separate
   * rollout manifest whose digest and root host identity are pinned here. */
  rolloutManifest: FilePin,
  backupRecoveryKey: z.object({ escrowRef:ExternalKeyRef,keyVersion:SafeId,fingerprintSha256:z.string().regex(SHA256) }).strict(),
  secretCatalogRecoveryKeys: z.array(z.object({ escrowRef:ExternalKeyRef,keyVersion:SafeId,fingerprintSha256:z.string().regex(SHA256) }).strict()).max(256),
  connectorCredentialRecoveryKey: z.object({ escrowRef:ExternalKeyRef,keyVersion:SafeId,fingerprintSha256:z.string().regex(SHA256) }).strict(),
  connectorInvocationRecoveryKeys: z.array(z.object({ keyRef:TransitKeyRef,keyVersion:z.number().int().min(1).max(2_147_483_647),fingerprintSha256:z.string().regex(SHA256) }).strict()).max(256),
  metadataTransitKeyPins: z.array(z.object({ keyRef:TransitKeyRef,keyVersion:z.number().int().min(1).max(2_147_483_647) }).strict()).max(256),
  connectorVaultCredentialPins: z.array(z.object({ recordKind:z.enum(['revision','draft']),tenantId:z.string().uuid(),connectorId:SafeId,revision:z.number().int().positive(),account:SafeId,mount:SafeId,path:z.string().min(1).max(1024),key:SafeId,version:z.number().int().positive() }).strict()).max(100_000),
  credentialVersionPins: z.array(z.object({ reference:z.string().regex(SECRET_REF),ownerTenantId:z.string().uuid() }).strict()).max(512),
  credentialVersionRefs: z.array(z.string().regex(SECRET_REF)).max(256),
  artifactTransitKeyPins: z.array(z.object({keyRef:TransitKeyRef,keyVersion:z.number().int().min(1).max(2_147_483_647)}).strict()).max(256),
  isolatedStorage: z.object({
    endpoint: z.string().url(), bucket: z.string().min(1).max(255), region: SafeId,
    forcePathStyle: z.boolean(), credentialVersionRef: z.string().regex(SECRET_REF), ownerTenantId: z.string().uuid(),
  }).strict(),
  sourceRuntimeIdentities: z.array(SafeId).min(2).max(8),
  isolatedRuntime: z.object({
    orchestratorRuntimeIdentity: SafeId, orchestratorSlot: z.enum(['blue','green']), orchestratorRevision: SafeId,
    orchestratorImageDigest: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/i),
    connectorRuntimeIdentity: SafeId, connectorReplicaId: SafeId, connectorSlot: z.enum(['blue','green']), connectorRevision: SafeId,
    connectorImageDigest: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/i),
  }).strict(),
  connectorReplicas: z.array(ReplicaPin).min(1).max(2),
  isolatedHost: IsolatedHostSchema,
  maxBundleBytes: z.number().int().min(1024 * 1024).max(1024 * 1024 * 1024 * 500),
  maxArtifactBytes: z.number().int().min(1).max(1024 * 1024 * 1024),
  toolTimeoutMs: z.number().int().min(10_000).max(6 * 60 * 60 * 1000).default(60 * 60 * 1000),
}).strict().superRefine((manifest, ctx) => {
  if (manifest.hostId !== manifest.isolatedHost.hostRunnerIdentity) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['isolatedHost', 'hostRunnerIdentity'],
      message: 'the manifest host identity and isolated host-runner identity must match' });
  }
  const names = [manifest.orchestratorSourceClusterName, manifest.connectorSourceClusterName,
    manifest.orchestratorRestoreClusterName, manifest.connectorRestoreClusterName];
  if (new Set(names).size !== names.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['orchestratorRestoreClusterName'], message: 'source and isolated restore cluster names must all be distinct' });
  }
  if (new Set(manifest.connectorReplicas.map((item) => item.replicaId)).size !== manifest.connectorReplicas.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['connectorReplicas'], message: 'connector replica IDs must be unique' });
  }
  for (const sourceRef of RestoreSourceRefSchema.options) {
    if (manifest.isolatedHost.sourceEndpoints[sourceRef].ruleId !== manifest.isolatedHost.networkPolicy.sourceRuleIds[sourceRef]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['isolatedHost', 'sourceEndpoints', sourceRef, 'ruleId'],
        message: 'each source probe endpoint must bind to its exact network policy rule' });
    }
  }
  if (manifest.isolatedHost.libpq.serviceFile.path !== manifest.libpqServiceFile.path
    || manifest.isolatedHost.libpq.serviceFile.sha256 !== manifest.libpqServiceFile.sha256
    || manifest.isolatedHost.libpq.passFile.path !== manifest.passfile.path
    || manifest.isolatedHost.libpq.passFile.sha256 !== manifest.passfile.sha256) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['isolatedHost', 'libpq'],
      message: 'isolated runtime libpq pins must match the trusted source/restore service files' });
  }
  if (manifest.isolatedHost.libpq.orchestratorService === manifest.isolatedHost.libpq.connectorService) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['isolatedHost', 'libpq'],
      message: 'isolated runtime database services must be distinct' });
  }
  if (manifest.isolatedHost.localRuntime.orchestrator.tokenFile.path === manifest.isolatedHost.localRuntime.connector.tokenFile.path
    || manifest.isolatedHost.localRuntime.orchestrator.tokenFile.sha256 === manifest.isolatedHost.localRuntime.connector.tokenFile.sha256) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['isolatedHost', 'localRuntime'],
      message: 'Orchestrator and Connector local observation credentials must be distinct' });
  }
  const orchestratorOrigin = new URL(manifest.isolatedHost.localRuntime.orchestrator.baseUrl).origin;
  if (new URL(manifest.isolatedHost.login.url).pathname !== '/admin/login'
    || new URL(manifest.isolatedHost.login.url).origin !== orchestratorOrigin
    || !manifest.isolatedHost.localRuntime.orchestrator.internalBaseUrl.startsWith('http://127.0.0.1:')
    || new URL(manifest.isolatedHost.artifact.baseUrl).origin !== orchestratorOrigin) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['isolatedHost', 'login'],
      message: 'login and artifact application probes must use the pinned local Orchestrator origin and login route' });
  }
  if (new Set(Object.values(manifest.isolatedHost.networkPolicy.sourceRuleIds)).size !== RestoreSourceRefSchema.options.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['isolatedHost', 'networkPolicy', 'sourceRuleIds'],
      message: 'each forbidden source requires its own pinned deny rule' });
  }
  if (manifest.isolatedHost.networkPolicy.revision !== manifest.isolatedHost.networkPolicy.rulesFile.sha256
    || path.basename(manifest.isolatedHost.launcher.executable.path) !== 'docker'
    || path.basename(manifest.isolatedHost.networkPolicy.namespaceTool.path) !== 'nsenter'
    || path.basename(manifest.isolatedHost.networkPolicy.nftTool.path) !== 'nft') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['isolatedHost', 'networkPolicy'],
      message: 'isolated launch must use Docker; network policy must use pinned nsenter+nft inside the isolated target namespace and exact rules-file digest' });
  }
  for (const [service,args] of Object.entries(manifest.isolatedHost.launcher.startArgs)) {
    const networkIndex = args.indexOf('--network');
    if (networkIndex < 0 || args[networkIndex + 1] !== 'none'
      || args.some((arg) => arg.startsWith('--network=') && arg !== '--network=none')
      || args[args.indexOf('--user') + 1] !== '1000:1000'
      || !args.includes('${RUNTIME_IDENTITY}') || !args.includes('${IMAGE_DIGEST}')
      || !args.includes('${RUNTIME_CONFIG_FILE}') || !args.includes('${RUNTIME_SECRETS_FILE}')
      || !args.includes('${PG_PASSWORD_FILE}') || !args.includes('${START_GATE_DIR}')
      || !args.includes('${CONTROL_TOKEN_FILE}')
      || !args.includes('--cidfile') || !args.includes('${CID_FILE}')
      || !args.includes('node') || !args.includes('dist/isolated-restore-bootstrap.js')
      || !args.some((arg) => arg.includes('dst=/run/du-restore/runtime-config.json,readonly'))
      || !args.some((arg) => arg.includes('dst=/run/du-restore/runtime-secrets.json,readonly'))
      || !args.some((arg) => arg.includes('dst=/run/du-restore/pg-password,readonly'))
      || !args.some((arg) => arg.includes('dst=/run/du-restore/start-gate,readonly'))
      || !args.some((arg) => arg.includes('dst=/run/du-restore/control-token,readonly'))
      || args.some((arg) => arg === '--env' || arg.startsWith('--env='))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['isolatedHost','launcher','startArgs',service],
        message: 'isolated bootstrap must start without network as UID/GID 1000 with pinned read-only config/secrets/password/gate mounts and no Docker environment secrets' });
    }
  }
  if (canonical(manifest.isolatedHost.launcher.attachNetworkArgs) !== canonical(['network','connect','${TARGET_NETWORK_ID}','${CONTAINER_ID}'])) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['isolatedHost','launcher','attachNetworkArgs'],
      message: 'only the exact manifest-pinned target network may be attached after namespace policy verification' });
  }
  if (manifest.isolatedHost.login.credentialFile.path === manifest.isolatedHost.artifact.apiKeyCredentialFile.path
    || manifest.isolatedHost.login.credentialFile.sha256 === manifest.isolatedHost.artifact.apiKeyCredentialFile.sha256) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['isolatedHost', 'artifact', 'apiKeyCredentialFile'],
      message: 'admin login and artifact API key credentials must be distinct protected files' });
  }
  if (new Set(manifest.sourceRuntimeIdentities).size !== manifest.sourceRuntimeIdentities.length
    || manifest.connectorReplicas.some((item) => !manifest.sourceRuntimeIdentities.includes(item.runtimeIdentity))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceRuntimeIdentities'], message: 'source runtime identities must be unique and include every Connector replica' });
  }
  if (manifest.sourceRuntimeIdentities.includes(manifest.isolatedRuntime.orchestratorRuntimeIdentity)
    || manifest.sourceRuntimeIdentities.includes(manifest.isolatedRuntime.connectorRuntimeIdentity)
    || manifest.isolatedRuntime.orchestratorRuntimeIdentity === manifest.isolatedRuntime.connectorRuntimeIdentity
    || manifest.connectorReplicas.some((item) => item.replicaId === manifest.isolatedRuntime.connectorReplicaId
      || item.runtimeIdentity === manifest.isolatedRuntime.connectorRuntimeIdentity)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['isolatedRuntime'], message: 'isolated process identities must be distinct from source identities and each other' });
  }
  if (new Set(manifest.secretCatalogRecoveryKeys.map((pin) => pin.keyVersion)).size !== manifest.secretCatalogRecoveryKeys.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['secretCatalogRecoveryKeys'], message: 'secret catalog key versions must be unique' });
  }
  const invocationPairs = manifest.connectorInvocationRecoveryKeys.map((pin)=>`${pin.keyRef}@${pin.keyVersion}`);
  const metadataPairs = manifest.metadataTransitKeyPins.map((pin)=>`${pin.keyRef}@${pin.keyVersion}`);
  const vaultDigests = manifest.connectorVaultCredentialPins.map((pin)=>sha(Buffer.from(canonical(pin))));
  if (new Set(invocationPairs).size !== invocationPairs.length) ctx.addIssue({code:z.ZodIssueCode.custom,path:['connectorInvocationRecoveryKeys'],message:'Connector invocation key versions must be unique'});
  if (new Set(metadataPairs).size !== metadataPairs.length) ctx.addIssue({code:z.ZodIssueCode.custom,path:['metadataTransitKeyPins'],message:'metadata Transit pins must be unique'});
  if (new Set(vaultDigests).size !== vaultDigests.length) ctx.addIssue({code:z.ZodIssueCode.custom,path:['connectorVaultCredentialPins'],message:'Vault credential pins must be unique'});
});
export type TrustedMaintenanceManifest = z.infer<typeof ManifestSchema>;
type Manifest = TrustedMaintenanceManifest;
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function assertSourceDenyRules(manifest: Manifest, raw: Buffer): void {
  const text = raw.toString('utf8');
  if (!text || text.includes('\0') || Buffer.from(text, 'utf8').compare(raw) !== 0
    || !/\btable\s+inet\s+du_restore\s*\{[\s\S]*\bchain\s+output\s*\{[^}]*\bhook\s+output\b[^}]*\bpolicy\s+drop\s*;/m.test(text)) {
    throw fail('RESTORE_NETWORK_POLICY_INVALID');
  }
  for (const sourceRef of RestoreSourceRefSchema.options) {
    const endpoint = manifest.isolatedHost.sourceEndpoints[sourceRef];
    const ruleId = manifest.isolatedHost.networkPolicy.sourceRuleIds[sourceRef];
    const ip = endpoint.host.startsWith('[') ? endpoint.host.slice(1, -1) : endpoint.host;
    const family = isIP(ip) === 6 ? 'ip6' : 'ip';
    const expected = new RegExp(`^\\s*${family}\\s+daddr\\s+${escapeRegExp(ip)}\\s+tcp\\s+dport\\s+${endpoint.port}\\s+(?:drop|reject)\\s+comment\\s+['\"]${escapeRegExp(ruleId)}['\"]\\s*$`, 'gm');
    const matches = text.match(expected) ?? [];
    if (matches.length !== 1) throw fail('RESTORE_NETWORK_POLICY_INVALID');
    const shadowingAccept = new RegExp(`^\\s*${family}\\s+daddr\\s+${escapeRegExp(ip)}\\s+tcp\\s+dport\\s+${endpoint.port}\\s+accept\\b`, 'm');
    if (shadowingAccept.test(text)) throw fail('RESTORE_NETWORK_POLICY_INVALID');
  }
}
type RecoveryKeyPurpose = 'backup_bundle' | 'secret_catalog' | 'connector_invocation' | 'connector_credential';
type SecretCatalogRecoveryKeyPin = { keyVersion:string; fingerprintSha256:string };
type SecretCatalogKeyCount = { keyVersion:string; revisionCount:number; currentSecretCount:number };
type ConnectorInvocationKeyPin = { keyRef:string;keyVersion:number;fingerprintSha256:string };
type ConnectorInvocationKeyCount = { keyRef:string;keyVersion:number;envelopeCount:number };
type MetadataTransitKeyPin = { keyRef:string;keyVersion:number };
type MetadataTransitKeyCount = MetadataTransitKeyPin & {envelopeCount:number};
type ConnectorVaultCredentialPin = Manifest['connectorVaultCredentialPins'][number];

interface ArtifactRow extends QueryResultRow {
  id: string; tenant_id: string; file_name: string; mime_type: string; size_bytes: number | string;
  sha256: string; storage_backend: string; storage_generation_id: string | null; storage_key: string;
  storage_version_id: string | null; manifest_version_id: string | null; state: string;
}
interface ArtifactTransitKeyPin { keyRef: string; keyVersion: number; }
interface StorageRow extends QueryResultRow {
  revision: number | string;
  generation_id: string; backend: string; endpoint: string; bucket: string; region: string;
  force_path_style: boolean; credential_version_ref: string | null; credential_owner_tenant_id: string | null;
  url_ttl_seconds: number | null; state: string;
}

export interface MaintenanceBackupFenceProof {
  observedAt: string;
  admission: { fenced: true; inFlight: number };
  orchestratorDispatch: { fenced: true; inFlight: number };
  providerIssuance: { fenced: true; inFlight: number };
  connectorInvocationPolling: { fenced: true; inFlight: number };
  artifactMutation: { fenced: true; inFlight: number };
  connectorUsageDelivery: { fenced: true; inFlight: number };
  evidence: {
    fenceId: string;
    fenceRevision: number;
    priorControlStates: Record<string, unknown>;
    replicaObservations: Array<ReplicaRuntimeObservation & { bootId?: string }>;
    connectorFences: ConnectorBackupEffectFenceObservation[];
    artifactEffects: BackupArtifactEffectObservation;
    execution: { jobId:string;itemId:string;ownerRuntimeIdentity:string;ownerBootId:string;executionFence:number;executionTokenSha256:string };
  };
  evidenceSha256: string;
}
export interface MaintenanceBackupFence {
  acquire(input: { backupId: string; reason: string; execution: MaintenanceExecutionFence }): Promise<{
    fenceId: string; fenceRevision: number; proof: MaintenanceBackupFenceProof;
  }>;
  release(input: {
    backupId: string; fenceId: string; fenceRevision: number; execution: MaintenanceExecutionFence; restorePriorState: true;
  }): Promise<void>;
}

export interface IsolatedRestoreRuntimeProbeResult extends Record<string, unknown> {
  observedAt: string;
  evidenceSha256: string;
  orchestrator: {
    clusterName: string; runtimeIdentity: string; revision: string; imageDigest: string;
    controlState: 'DRAINING'; controlRevision: number; observedAt: string; workObservedAt: string;
    activeRequests: 0; activeDispatches: 0; maintenanceExecutions: 0;
  };
  connector: {
    clusterName: string; runtimeIdentity: string; replicaId: string; slot: 'blue' | 'green'; revision: string; imageDigest: string;
    controlState: 'DRAINING'; controlRevision: number; observedAt: string; workObservedAt: string;
    activeInvocations: 0; processActiveInvocations: 0; processActivePolls: 0; processActiveUsageSends: 0;
    unresolvedInvocationHolds: number;
    effectPermits: { prepared:number; active:number; settling:number; unknown:number };
    unclosedEffectPermits: number; unknownUsageDeliveries: number;
  };
  recoverySourceIsolation: { observedAt:string; sourceOrchestratorReachable:false; sourceConnectorReachable:false; sourceCatalogKeyringReachable:false;
    sourceConnectorRecoveryRegistryReachable:false; sourceMetadataTransitReachable:false; sourceArtifactTransitReachable:false; sourceVaultReachable:false;
    independentRecoveryKeyReachable:true; independentSecretCatalogRecoveryReachable:true; connectorRecoveryRegistryReachable:true;
    metadataTransitReachable:true; vaultCredentialReaderReachable:true; artifactTransitReachable:true };
  artifactTransitKeyRecoveries: Array<{keyRef:string;keyVersion:number;verifiedArtifactCount:number;evidenceSha256:string}>;
  secretCatalogKeyRecoveries: Array<{keyVersion:string;verifiedRevisionCount:number;verifiedCurrentSecretCount:number;evidenceSha256:string}>;
  connectorInvocationKeyRecoveries: Array<{keyRef:string;keyVersion:number;verifiedEnvelopeCount:number;evidenceSha256:string}>;
  connectorCredentialRecovery: {keyVersion:string;verifiedSecretVersionCount:number;evidenceSha256:string};
  metadataTransitKeyRecoveries: Array<{keyRef:string;keyVersion:number;verifiedEnvelopeCount:number;evidenceSha256:string}>;
  vaultCredentialRecoveries: Array<{pinSha256:string;verifiedRead:true;evidenceSha256:string}>;
  checks: { login: 'PASSED'; history: 'PASSED'; artifactDecryption: 'PASSED'; artifactDownload: 'PASSED'; artifactTransitKeyRecovery:'PASSED'; secretCatalogDecryption:'PASSED'; connectorInvocationDecryption:'PASSED'; connectorCredentialDecryption:'PASSED'; metadataTransitDecryption:'PASSED'; vaultCredentialReads:'PASSED'; dispatchDisabled: 'PASSED'; providerCallsDisabled: 'PASSED'; usageDeliveryDisabled: 'PASSED'; externalEffects: Record<'admission'|'dispatch'|'providerInvocation'|'connectorPoll'|'usageDelivery'|'webhookDelivery'|'alertEmission'|'cleanup'|'historicalMaintenance'|'migrations','PASSED'> };
  externalEffects: Record<'admission'|'dispatch'|'providerInvocation'|'connectorPoll'|'usageDelivery'|'webhookDelivery'|'alertEmission'|'cleanup'|'historicalMaintenance'|'migrations','DISABLED'>;
  counts: BundleIndex['counts'];
}
export interface IsolatedRestoreRuntimeProbe {
  /** Launch/probe actual local isolated runtimes over the restored DBs and staged S3 generation. */
  run(input: {
    backupId: string;
    orchestratorDatabase: string;
    connectorDatabase: string;
    orchestratorClusterName: string;
    connectorClusterName: string;
    targetGenerationId: string;
    sourceRuntimeIdentities: readonly string[];
    expectedRuntime: Manifest['isolatedRuntime'];
    expectedCounts: BundleIndex['counts'];
    expectedArtifactTransitKeyPins: readonly ArtifactTransitKeyPin[];
    expectedSecretCatalogRecoveryKeys: readonly SecretCatalogRecoveryKeyPin[];
    expectedSecretCatalogKeyCounts: readonly SecretCatalogKeyCount[];
    expectedConnectorInvocationRecoveryKeys: readonly ConnectorInvocationKeyPin[];
    expectedConnectorInvocationKeyCounts: readonly ConnectorInvocationKeyCount[];
    expectedConnectorCredentialKey: {keyVersion:string;fingerprintSha256:string};
    expectedConnectorSecretVersionCount: number;
    expectedMetadataTransitKeyCounts: readonly MetadataTransitKeyCount[];
    expectedVaultCredentialPinDigests: readonly string[];
    services: { orchestrator: string; connector: string };
    dispatchDisabled: true;
    providerCallsDisabled: true;
    usageDeliveryDisabled: true;
  }): Promise<IsolatedRestoreRuntimeProbeResult>;
}

export interface TrustedMaintenanceBackupAdapterOptions {
  manifestPath: string;
  expectedManifestSha256: string;
  db: Db;
  storageGenerations: StorageGenerationService;
  artifacts: Pick<ArtifactService, 'openPinnedObjectsForMaintenanceBackup'>;
  /** Required per-backup closure evidence for still-valid direct upload grants. */
  backupArtifactEffects: Pick<BackupArtifactEffectPort, 'snapshotOpenCapabilities'>;
  /** Resolve an exact independently retained key; never use restored/source Catalog or current runtime keyrings. */
  resolveRecoveryKey(input: { purpose:RecoveryKeyPurpose; escrowRef:string; keyVersion:string }): Promise<Buffer>;
  /** Verify retained managed storage credential metadata and exact revision. */
  verifySecretVersion(reference: string, ownerTenantId: string, purpose: 'storage.credential' | 'maintenance.backup_encryption'): Promise<void>;
  backupFence: MaintenanceBackupFence;
  isolatedRuntimeProbe: IsolatedRestoreRuntimeProbe;
  now?: () => Date;
  spawn?: typeof spawn;
}

interface Component {
  name: string;
  sha256: string;
  cipherByteSize: number;
  plainByteSize: number;
  nonce: string;
  tag: string;
}
interface BundleIndex {
  schemaVersion: 7;
  backupId: string;
  createdAt: string;
  backupFenceProof: MaintenanceBackupFenceProof;
  backupRecoveryKey: {keyVersion:string;fingerprintSha256:string};
  secretCatalogRecoveryKeys: SecretCatalogRecoveryKeyPin[];
  secretCatalogKeyCounts: SecretCatalogKeyCount[];
  connectorCredentialRecoveryKey: {keyVersion:string;fingerprintSha256:string};
  connectorInvocationRecoveryKeys: ConnectorInvocationKeyPin[];
  connectorInvocationKeyCounts: ConnectorInvocationKeyCount[];
  metadataTransitKeyCounts: MetadataTransitKeyCount[];
  connectorVaultCredentialPinDigests: string[];
  connectorReferencedSecretVersionCount: number;
  sourceClusterNames: { orchestrator: string; connector: string };
  components: Component[];
  counts: {
    operations: number; artifacts: number; readyArtifacts: number; secretRevisions: number; storageGenerations: number;
    secretCatalogImports: number; connectorSecretImports: number;
    globalSettingsRevisions: number; retentionRevisions: number; budgetRevisions: number;
    priceRevisions: number; reservationGroups: number; budgetHolds: number;
    financialAdjustments: number; financialAdjustmentHeads: number; financialAdjustmentCommands: number;
    connectorInvocations: number; connectorUsageEvents: number; connectorSecretVersions: number;
    connectorRevisions: number; connectorRuntimeControls: number; connectorParityChains: number;
    connectorParityRevisions: number; connectorParityClaimIntents: number; connectorParityDraftIntents: number;
    artifactObjectBytes: number; artifactManifestBytes: number;
  };
  credentialVersionRefs: string[];
  credentialVersionPins: Array<{ reference:string; ownerTenantId:string }>;
  encryptionKeyVersionRefs: string[];
  artifactTransitKeyPins: ArtifactTransitKeyPin[];
  snapshotArtifactCount?: number;
  capabilitySnapshot?: Pick<BackupCapabilitySnapshot,'openCapabilities'|'includedExactVersion'|'excludedIncomplete'|'evidenceSha256'>;
}
interface ArtifactBackupEntry {
  artifactId: string; tenantId: string; storageBackend: string; storageGenerationId: string | null;
  storageKey: string; storageVersionId: string; manifestVersionId: string | null;
  contentComponent: string; manifestComponent: string | null; fileName: string; mimeType: string;
  sizeBytes: number; sha256: string; storageObjectBytes: number; manifestObjectBytes: number | null;
  artifactTransitKeyPins: ArtifactTransitKeyPin[];
}

const ComponentSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
    .refine((value) => !value.includes('..') && !value.includes('/') && !value.includes('\\')),
  sha256: z.string().regex(SHA256), cipherByteSize: z.number().int().positive(), plainByteSize: z.number().int().nonnegative(),
  nonce: z.string().regex(/^[A-Za-z0-9+/]{16}$/), tag: z.string().regex(/^[A-Za-z0-9+/]{22}==$/),
}).strict();
const BundleIndexSchema = z.object({
  schemaVersion: z.literal(7), backupId: z.string().uuid(), createdAt: z.string().datetime(),
  backupFenceProof: z.object({
    observedAt:z.string().datetime(),
    admission:z.object({fenced:z.literal(true),inFlight:z.number().int().nonnegative()}).strict(),
    orchestratorDispatch:z.object({fenced:z.literal(true),inFlight:z.number().int().nonnegative()}).strict(),
    providerIssuance:z.object({fenced:z.literal(true),inFlight:z.number().int().nonnegative()}).strict(),
    connectorInvocationPolling:z.object({fenced:z.literal(true),inFlight:z.number().int().nonnegative()}).strict(),
    artifactMutation:z.object({fenced:z.literal(true),inFlight:z.number().int().nonnegative()}).strict(),
    connectorUsageDelivery:z.object({fenced:z.literal(true),inFlight:z.number().int().nonnegative()}).strict(),
    evidence:z.object({
      fenceId:z.string().uuid(),fenceRevision:z.number().int().min(1),priorControlStates:z.record(z.unknown()),
      replicaObservations:z.array(z.record(z.unknown())).length(6),
      connectorFences:z.array(z.record(z.unknown())).length(2),artifactEffects:z.record(z.unknown()),
      execution:z.object({jobId:z.string().uuid(),itemId:SafeId,ownerRuntimeIdentity:SafeId,ownerBootId:z.string().uuid(),
        executionFence:z.number().int().min(1),executionTokenSha256:z.string().regex(SHA256)}).strict(),
    }).strict(),
    evidenceSha256:z.string().regex(SHA256),
  }).strict(),
  backupRecoveryKey: z.object({keyVersion:SafeId,fingerprintSha256:z.string().regex(SHA256)}).strict(),
  secretCatalogRecoveryKeys: z.array(z.object({keyVersion:SafeId,fingerprintSha256:z.string().regex(SHA256)}).strict()).max(256),
  secretCatalogKeyCounts: z.array(z.object({keyVersion:SafeId,revisionCount:z.number().int().nonnegative(),currentSecretCount:z.number().int().nonnegative()}).strict()).max(256),
  connectorCredentialRecoveryKey: z.object({keyVersion:SafeId,fingerprintSha256:z.string().regex(SHA256)}).strict(),
  connectorInvocationRecoveryKeys: z.array(z.object({keyRef:TransitKeyRef,keyVersion:z.number().int().min(1).max(2_147_483_647),fingerprintSha256:z.string().regex(SHA256)}).strict()).max(256),
  connectorInvocationKeyCounts: z.array(z.object({keyRef:TransitKeyRef,keyVersion:z.number().int().min(1).max(2_147_483_647),envelopeCount:z.number().int().nonnegative()}).strict()).max(512),
  metadataTransitKeyCounts: z.array(z.object({keyRef:TransitKeyRef,keyVersion:z.number().int().min(1).max(2_147_483_647),envelopeCount:z.number().int().nonnegative()}).strict()).max(512),
  connectorVaultCredentialPinDigests: z.array(z.string().regex(SHA256)).max(100_000),
  connectorReferencedSecretVersionCount: z.number().int().nonnegative(),
  sourceClusterNames: z.object({ orchestrator: SafeId, connector: SafeId }).strict(),
  components: z.array(ComponentSchema).min(3).max(2_000_000),
  counts: z.object({ operations: z.number().int().nonnegative(), artifacts: z.number().int().nonnegative(),
    readyArtifacts: z.number().int().nonnegative(),
    secretRevisions: z.number().int().nonnegative(), storageGenerations: z.number().int().nonnegative(),
    secretCatalogImports:z.number().int().nonnegative(),connectorSecretImports:z.number().int().nonnegative(),
    globalSettingsRevisions: z.number().int().nonnegative(), retentionRevisions: z.number().int().nonnegative(),
    budgetRevisions: z.number().int().nonnegative(), priceRevisions: z.number().int().nonnegative(),
    reservationGroups: z.number().int().nonnegative(), budgetHolds: z.number().int().nonnegative(),
    financialAdjustments:z.number().int().nonnegative(),financialAdjustmentHeads:z.number().int().nonnegative(),
    financialAdjustmentCommands:z.number().int().nonnegative(),
    connectorInvocations: z.number().int().nonnegative(), connectorUsageEvents: z.number().int().nonnegative(),
    connectorSecretVersions: z.number().int().nonnegative(), connectorRevisions: z.number().int().nonnegative(),
    connectorRuntimeControls: z.number().int().nonnegative(), connectorParityChains: z.number().int().nonnegative(),
    connectorParityRevisions: z.number().int().nonnegative(), connectorParityClaimIntents: z.number().int().nonnegative(),
    connectorParityDraftIntents: z.number().int().nonnegative(), artifactObjectBytes: z.number().int().nonnegative(),
    artifactManifestBytes: z.number().int().nonnegative() }).strict(),
  credentialVersionRefs: z.array(z.string().regex(SECRET_REF)).max(256),
  credentialVersionPins: z.array(z.object({ reference:z.string().regex(SECRET_REF),ownerTenantId:z.string().uuid() }).strict()).max(512),
  encryptionKeyVersionRefs: z.array(z.string().min(1).max(512)).max(2048),
  artifactTransitKeyPins: z.array(z.object({keyRef:TransitKeyRef,keyVersion:z.number().int().min(1).max(2_147_483_647)}).strict()).max(256),
  snapshotArtifactCount:z.number().int().nonnegative().optional(),
  capabilitySnapshot: z.object({
    openCapabilities:z.number().int().nonnegative(),includedExactVersion:z.number().int().nonnegative(),
    excludedIncomplete:z.number().int().nonnegative(),evidenceSha256:z.string().regex(SHA256),
  }).strict().optional(),
}).strict().superRefine((index, ctx) => {
  if (new Set(index.components.map((entry) => entry.name)).size !== index.components.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['components'], message: 'component names must be unique' });
  }
  for (const required of ['orchestrator.dump', 'connector.dump', 'artifact-index.json']) {
    if (!index.components.some((entry) => entry.name === required)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['components'], message: `required component ${required} is missing` });
    }
  }
  const pinsByRef = new Map(index.credentialVersionPins.map((pin) => [pin.reference,pin.ownerTenantId]));
  if (pinsByRef.size !== index.credentialVersionPins.length
    || index.credentialVersionRefs.some((reference) => !pinsByRef.has(reference))
    || pinsByRef.size !== index.credentialVersionRefs.length) {
    ctx.addIssue({ code:z.ZodIssueCode.custom,path:['credentialVersionPins'],message:'every credential reference must have one immutable owner-tenant pin' });
  }
  const transitIds = index.artifactTransitKeyPins.map((pin) => `${pin.keyRef}@${pin.keyVersion}`);
  const catalogVersions = index.secretCatalogRecoveryKeys.map((pin) => pin.keyVersion);
  const catalogCounts = index.secretCatalogKeyCounts.map((pin) => pin.keyVersion);
  const invocationIds = index.connectorInvocationRecoveryKeys.map((pin)=>`${pin.keyRef}@${pin.keyVersion}`);
  const invocationCounts = index.connectorInvocationKeyCounts.map((pin)=>`${pin.keyRef}@${pin.keyVersion}`);
  const metadataIds = index.metadataTransitKeyCounts.map((pin)=>`${pin.keyRef}@${pin.keyVersion}`);
  const expectedKeys = [`backup-recovery:${index.backupRecoveryKey.keyVersion}:${index.backupRecoveryKey.fingerprintSha256}`,
    ...index.secretCatalogRecoveryKeys.map((pin) => `secret-catalog:${pin.keyVersion}:${pin.fingerprintSha256}`),
    `connector-credential:${index.connectorCredentialRecoveryKey.keyVersion}:${index.connectorCredentialRecoveryKey.fingerprintSha256}`,
    ...index.connectorInvocationRecoveryKeys.map((pin)=>`connector-invocation:${pin.keyRef}@${pin.keyVersion}:${pin.fingerprintSha256}`),
    ...index.metadataTransitKeyCounts.map((pin)=>`orchestrator-transit:${pin.keyRef}@${pin.keyVersion}`),
    ...transitIds].sort();
  if (new Set(transitIds).size !== transitIds.length || new Set(catalogVersions).size !== catalogVersions.length
    || new Set(catalogCounts).size !== catalogCounts.length || canonical(catalogVersions.slice().sort()) !== canonical(catalogCounts.slice().sort())
    || new Set(invocationIds).size !== invocationIds.length || new Set(invocationCounts).size !== invocationCounts.length
    || new Set(metadataIds).size !== metadataIds.length || canonical(invocationIds.slice().sort()) !== canonical(invocationCounts.slice().sort())
    || new Set(index.connectorVaultCredentialPinDigests).size !== index.connectorVaultCredentialPinDigests.length
    || canonical(index.encryptionKeyVersionRefs) !== canonical(expectedKeys)) {
    ctx.addIssue({code:z.ZodIssueCode.custom,path:['encryptionKeyVersionRefs'],message:'key refs and per-version counts must exactly match the bundle, Catalog, and artifact Transit pins'});
  }
});
const ArtifactIndexSchema = z.object({
  backupId: z.string().uuid(), artifacts: z.array(z.object({
    artifactId: z.string().uuid(), tenantId: z.string().uuid(), storageBackend: z.string().min(1).max(32),
    storageGenerationId: z.string().uuid().nullable(), storageKey: z.string().min(1).max(2048),
    storageVersionId: z.string().min(1).max(1024), manifestVersionId: z.string().min(1).max(1024).nullable(),
    contentComponent: z.string().min(1).max(128), manifestComponent: z.string().min(1).max(128).nullable(),
    fileName: z.string().min(1).max(1024), mimeType: z.string().min(1).max(255),
    sizeBytes: z.number().int().nonnegative(), sha256: z.string().regex(SHA256),
    storageObjectBytes: z.number().int().positive(), manifestObjectBytes: z.number().int().positive().nullable(),
    artifactTransitKeyPins: z.array(z.object({keyRef:TransitKeyRef,keyVersion:z.number().int().min(1).max(2_147_483_647)}).strict()).max(16),
  }).strict()).max(1_000_000),
}).strict();

function fail(code: string): Error { const error = new Error(code); error.name = code; return error; }
function sha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function digest(value: unknown): string { return sha(Buffer.from(canonical(value), 'utf8')); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function isRecord(value:unknown):value is Record<string,unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function sealedEnvelopeKey(value:unknown):{keyRef:string;keyVersion:number}|null {
  if (!isRecord(value) || !Object.hasOwn(value,'dek')) return null;
  const dek = value['dek'];
  if (!isRecord(dek) || value['version'] !== 1 || value['algorithm'] !== 'aes-256-gcm'
    || typeof value['keyRef'] !== 'string' || value['keyRef'].length < 1 || value['keyRef'].length > 256
    || dek['version'] !== 1 || typeof dek['keyName'] !== 'string' || dek['keyName'].length < 1 || dek['keyName'].length > 256
    || !Number.isSafeInteger(dek['keyVersion']) || (dek['keyVersion'] as number) < 1 || (dek['keyVersion'] as number) > 2_147_483_647
    || typeof dek['wrappedKey'] !== 'string' || typeof value['nonce'] !== 'string' || typeof value['tag'] !== 'string'
    || typeof value['aad'] !== 'string' || typeof value['ciphertext'] !== 'string'
    || typeof value['plaintextSha256'] !== 'string' || !SHA256.test(value['plaintextSha256'])) {
    throw fail('SEALED_METADATA_ENVELOPE_INVALID');
  }
  if (value['keyRef'] !== dek['keyName']) throw fail('SEALED_METADATA_KEY_REFERENCE_MISMATCH');
  return {keyRef:dek['keyName'],keyVersion:dek['keyVersion'] as number};
}
function addCount<T extends string | number>(map:Map<string,number>, key:T, count:number):void {
  const prior = map.get(String(key)) ?? 0;
  const next = prior + count;
  if (!Number.isSafeInteger(next) || next < 0) throw fail('CRYPTO_PIN_COUNT_INVALID');
  map.set(String(key),next);
}
function q(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
function requirePlatform(scope: MaintenanceScope): void { if (scope.kind !== 'platform') throw fail('BACKUP_SCOPE_UNSUPPORTED'); }
function noGroupWorldWrite(mode: number): boolean { return (mode & (fsConstants.S_IWGRP | fsConstants.S_IWOTH)) === 0; }
function recoveryKeyPinId(pin: Pick<Manifest['backupRecoveryKey'],'keyVersion'|'fingerprintSha256'>): string {
  return `backup-recovery:${pin.keyVersion}:${pin.fingerprintSha256}`;
}
function secretCatalogKeyPinId(pin: SecretCatalogRecoveryKeyPin): string {
  return `secret-catalog:${pin.keyVersion}:${pin.fingerprintSha256}`;
}
function connectorCredentialKeyPinId(pin: Pick<Manifest['connectorCredentialRecoveryKey'],'keyVersion'|'fingerprintSha256'>): string {
  return `connector-credential:${pin.keyVersion}:${pin.fingerprintSha256}`;
}
function connectorInvocationKeyPinId(pin: ConnectorInvocationKeyPin): string {
  return `connector-invocation:${pin.keyRef}@${pin.keyVersion}:${pin.fingerprintSha256}`;
}
function metadataTransitPinId(pin: MetadataTransitKeyPin): string { return `orchestrator-transit:${pin.keyRef}@${pin.keyVersion}`; }
function transitKeyPinId(pin: ArtifactTransitKeyPin): string { return `${pin.keyRef}@${pin.keyVersion}`; }

async function readBoundedStream(stream: Readable, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.length;
    if (!Number.isSafeInteger(total) || total > maximum) throw fail('BACKUP_ARTIFACT_MANIFEST_TOO_LARGE');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks,total);
}

function parseArtifactTransitPin(bytes: Buffer, row: ArtifactRow): ArtifactTransitKeyPin[] {
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString('utf8')) as unknown; } catch { throw fail('BACKUP_ARTIFACT_MANIFEST_INVALID'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('BACKUP_ARTIFACT_MANIFEST_INVALID');
  const outer = raw as Record<string, unknown>;
  let encryption: unknown = raw;
  if ('encryption' in outer || 'kind' in outer || 'artifactId' in outer) {
    if (outer.version !== 1 || !['single','chunked'].includes(String(outer.kind))
      || outer.artifactId !== row.id || outer.tenantId !== row.tenant_id
      || outer.objectVersion !== row.storage_version_id || !outer.encryption
      || typeof outer.encryption !== 'object' || Array.isArray(outer.encryption)) throw fail('BACKUP_ARTIFACT_MANIFEST_BINDING_MISMATCH');
    encryption = outer.encryption;
  }
  if (!encryption || typeof encryption !== 'object' || Array.isArray(encryption)) throw fail('BACKUP_ARTIFACT_MANIFEST_INVALID');
  const wrapped = (encryption as Record<string, unknown>).dek;
  if (!wrapped || typeof wrapped !== 'object' || Array.isArray(wrapped)) throw fail('BACKUP_ARTIFACT_DEK_PIN_MISSING');
  const parsed = z.object({keyRef:TransitKeyRef,keyVersion:z.number().int().min(1).max(2_147_483_647)}).passthrough().safeParse(wrapped);
  if (!parsed.success) throw fail('BACKUP_ARTIFACT_DEK_PIN_INVALID');
  return [{keyRef:parsed.data.keyRef,keyVersion:parsed.data.keyVersion}];
}

interface PinnedReadPolicy {
  /** The contents are credentials or key material, not public manifest metadata. */
  protectedSecret?: boolean;
  /** The pinned consumer runs as this group and needs group-read access. */
  runtimeReaderGid?: number;
}

function assertPinnedMetadata(details: Awaited<ReturnType<typeof stat>>, parent: Awaited<ReturnType<typeof lstat>>, policy?: PinnedReadPolicy): void {
  const mode = Number(details.mode);
  const parentMode = Number(parent.mode);
  const uid = Number(details.uid);
  const parentUid = Number(parent.uid);
  if (!details.isFile() || !parent.isDirectory() || parent.isSymbolicLink()
    || uid !== 0 || parentUid !== 0 || !noGroupWorldWrite(mode) || !noGroupWorldWrite(parentMode)) {
    throw fail('BACKUP_MANIFEST_UNTRUSTED');
  }
  if (!policy?.protectedSecret) return;
  if ((mode & fsConstants.S_IROTH) !== 0 || (mode & fsConstants.S_IWOTH) !== 0) {
    throw fail('BACKUP_SECRET_PIN_UNTRUSTED');
  }
  if (policy.runtimeReaderGid !== undefined) {
    if (Number(details.gid) !== policy.runtimeReaderGid || (mode & fsConstants.S_IRGRP) === 0) {
      throw fail('BACKUP_SECRET_PIN_UNTRUSTED');
    }
  } else if (Number(details.gid) !== 0 && (Number(details.gid) !== 1000 || (mode & fsConstants.S_IRGRP) === 0)) {
    throw fail('BACKUP_SECRET_PIN_UNTRUSTED');
  }
}

async function readPinnedFile(filePath: string, expected: string, maximum = 2 * 1024 * 1024, policy?: PinnedReadPolicy): Promise<Buffer> {
  if (path.resolve(filePath) !== filePath || await realpath(filePath) !== filePath) throw fail('BACKUP_MANIFEST_UNTRUSTED');
  const target = await lstat(filePath, { bigint: false });
  const parent = await lstat(path.dirname(filePath), { bigint: false });
  const details = await stat(filePath, { bigint: false });
  if (!target.isFile() || target.isSymbolicLink() || details.nlink !== 1 || details.size < 1 || details.size > maximum) {
    throw fail('BACKUP_MANIFEST_UNTRUSTED');
  }
  assertPinnedMetadata(details, parent, policy);
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: false });
    const currentParent = await lstat(path.dirname(filePath), { bigint: false });
    if (String(opened.dev) !== String(details.dev) || String(opened.ino) !== String(details.ino) || Number(opened.size) !== Number(details.size)
      || Number(opened.uid) !== Number(details.uid) || Number(opened.gid) !== Number(details.gid) || Number(opened.mode) !== Number(details.mode)
      || String(currentParent.dev) !== String(parent.dev) || String(currentParent.ino) !== String(parent.ino)) throw fail('BACKUP_MANIFEST_CHANGED');
    assertPinnedMetadata(opened, currentParent, policy);
    const bytes = await handle.readFile();
    if (sha(bytes) !== expected) throw fail('BACKUP_MANIFEST_DIGEST_MISMATCH');
    return bytes;
  } finally { await handle.close(); }
}

async function readProtectedPinnedFile(filePath: string, expected: string, maximum = 4 * 1024 * 1024,
  runtimeReaderGid?: number): Promise<Buffer> {
  return readPinnedFile(filePath, expected, maximum, { protectedSecret: true,
    ...(runtimeReaderGid === undefined ? {} : { runtimeReaderGid }) });
}

/** Returns the one root-pinned host identity after validating the complete
 * manifest digest and schema. Central bootstrap must compare its configured
 * host identity to this value before opening database or Docker resources. */
export async function readTrustedMaintenanceHostIdentity(input: {
  manifestPath: string;
  expectedManifestSha256: string;
}): Promise<string> {
  if (!input || !AbsolutePath.safeParse(input.manifestPath).success || !SHA256.test(input.expectedManifestSha256)) {
    throw fail('BACKUP_MANIFEST_UNTRUSTED');
  }
  const bytes = await readPinnedFile(input.manifestPath, input.expectedManifestSha256, 2 * 1024 * 1024);
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString('utf8')) as unknown; } catch { throw fail('BACKUP_MANIFEST_INVALID'); }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) throw fail('BACKUP_MANIFEST_INVALID');
  const { hostId, isolatedHost } = parsed.data;
  if (hostId !== isolatedHost.hostRunnerIdentity) throw fail('BACKUP_HOST_IDENTITY_MISMATCH');
  return hostId;
}

/** Safe web-plane projection for preview only. It reads the root-owned outer
 * manifest but never opens key/password/token/tool pins or runs a host command. */
export async function readTrustedMaintenanceTargetDescriptors(input: {
  manifestPath: string;
  expectedManifestSha256: string;
}): Promise<{
  hostId: string;
  backupTargets: BackupTargetPreviewDescriptor[];
  restore: { enabled: true; isolated: true; sourceClusters: string[]; targetClusters: string[]; targetBackend: 's3' };
}> {
  if (!input || !AbsolutePath.safeParse(input.manifestPath).success || !SHA256.test(input.expectedManifestSha256)) {
    throw fail('BACKUP_MANIFEST_UNTRUSTED');
  }
  const bytes = await readPinnedFile(input.manifestPath, input.expectedManifestSha256, 2 * 1024 * 1024);
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString('utf8')) as unknown; } catch { throw fail('BACKUP_MANIFEST_INVALID'); }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success || parsed.data.hostId !== parsed.data.isolatedHost.hostRunnerIdentity) throw fail('BACKUP_MANIFEST_INVALID');
  const manifest = parsed.data;
  const pins = targetVersionProjection(manifest,input.expectedManifestSha256);
  return {
    hostId: manifest.hostId,
    backupTargets: [pins],
    restore: { enabled: true, isolated: true,
      sourceClusters: [manifest.orchestratorSourceClusterName, manifest.connectorSourceClusterName],
      targetClusters: [manifest.orchestratorRestoreClusterName, manifest.connectorRestoreClusterName], targetBackend: 's3' },
  };
}

/** Compute the nonsecret, immutable target identity from root-pinned metadata.
 * Database/key/tool validation remains in the host executor. */
function targetVersionProjection(man: Manifest, manifestSha256: string): BackupTargetPreviewDescriptor & {
  credentialVersionRefs: string[]; encryptionKeyVersionRefs: string[];
} {
  if (!SHA256.test(manifestSha256)) throw fail('BACKUP_MANIFEST_DIGEST_INVALID');
  const credentialOwners = new Map<string,string>();
  const addCredential = (reference: string, ownerTenantId: string) => {
    if (!SECRET_REF.test(reference) || !z.string().uuid().safeParse(ownerTenantId).success) throw fail('BACKUP_SECRET_OWNER_MISSING');
    const existing = credentialOwners.get(reference);
    if (existing && existing !== ownerTenantId) throw fail('BACKUP_SECRET_OWNER_CONFLICT');
    credentialOwners.set(reference,ownerTenantId);
  };
  for (const pin of man.credentialVersionPins) addCredential(pin.reference,pin.ownerTenantId);
  for (const reference of man.credentialVersionRefs) addCredential(reference,man.ownerTenantId);
  addCredential(man.isolatedStorage.credentialVersionRef,man.isolatedStorage.ownerTenantId);
  const credentialVersionRefs = [...credentialOwners.keys()].sort();
  const secretCatalogRecoveryKeys = man.secretCatalogRecoveryKeys.map(({keyVersion,fingerprintSha256})=>({keyVersion,fingerprintSha256}));
  const connectorCredentialRecoveryKey = {keyVersion:man.connectorCredentialRecoveryKey.keyVersion,
    fingerprintSha256:man.connectorCredentialRecoveryKey.fingerprintSha256};
  const connectorInvocationRecoveryKeys = man.connectorInvocationRecoveryKeys.map(({keyRef,keyVersion,fingerprintSha256})=>({keyRef,keyVersion,fingerprintSha256}));
  const encryptionKeyVersionRefs = [...new Set([
    recoveryKeyPinId(man.backupRecoveryKey),
    ...secretCatalogRecoveryKeys.map(secretCatalogKeyPinId),
    connectorCredentialKeyPinId(connectorCredentialRecoveryKey),
    ...connectorInvocationRecoveryKeys.map(connectorInvocationKeyPinId),
    ...man.metadataTransitKeyPins.map(metadataTransitPinId),
    ...man.artifactTransitKeyPins.map(transitKeyPinId),
  ])].sort();
  const identity = { name:'platform-primary',kind:'postgres' as const,manifestSha256,
    credentialVersionRefs,encryptionKeyVersionRefs };
  return { name:identity.name,kind:identity.kind,allowlisted:true,immutable:true,manifestSha256,
    targetPinDigest:backupTargetPinDigest(identity),supportedScopes:['platform'],
    credentialVersionRefs,encryptionKeyVersionRefs };
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const resolved = await realpath(directory);
  const details = await lstat(directory);
  if (resolved !== directory || !details.isDirectory() || details.isSymbolicLink() || !noGroupWorldWrite(details.mode)) {
    throw fail('BACKUP_DIRECTORY_UNTRUSTED');
  }
  await chmod(directory, 0o700);
}

async function validateRuntimeConfigPins(manifest: Manifest): Promise<void> {
  const checks = [
    {
      service: 'orchestrator' as const,
      pin: manifest.isolatedHost.runtimeConfigFiles.orchestrator,
      clusterName: manifest.orchestratorRestoreClusterName,
      runtimeIdentity: manifest.isolatedRuntime.orchestratorRuntimeIdentity,
      slot: manifest.isolatedRuntime.orchestratorSlot,
      revision: manifest.isolatedRuntime.orchestratorRevision,
      imageDigest: manifest.isolatedRuntime.orchestratorImageDigest,
    },
    {
      service: 'connector' as const,
      pin: manifest.isolatedHost.runtimeConfigFiles.connector,
      clusterName: manifest.connectorRestoreClusterName,
      runtimeIdentity: manifest.isolatedRuntime.connectorRuntimeIdentity,
      revision: manifest.isolatedRuntime.connectorRevision,
      imageDigest: manifest.isolatedRuntime.connectorImageDigest,
      replicaId: manifest.isolatedRuntime.connectorReplicaId,
      slot: manifest.isolatedRuntime.connectorSlot,
    },
  ];
  for (const expected of checks) {
    const bytes = await readPinnedFile(expected.pin.path, expected.pin.sha256, 256 * 1024);
    let raw: unknown;
    try { raw = JSON.parse(bytes.toString('utf8')) as unknown; } catch { throw fail('RESTORE_RUNTIME_CONFIG_INVALID'); }
    const parsed = TrustedIsolatedRuntimeConfigSchema.safeParse(raw);
    if (!parsed.success) throw fail('RESTORE_RUNTIME_CONFIG_INVALID');
    const config = parsed.data;
    if (config.service !== expected.service || config.clusterName !== expected.clusterName
      || config.runtimeIdentity !== expected.runtimeIdentity || config.revision !== expected.revision
      || config.imageDigest !== expected.imageDigest || config.databaseName !== undefined || config.targetGenerationId !== undefined
      || config.slot !== expected.slot
      || (expected.service === 'orchestrator'
        && config.internalPort !== Number(new URL(manifest.isolatedHost.localRuntime.orchestrator.internalBaseUrl).port))
      || (expected.service === 'connector' && config.replicaId !== expected.replicaId)
      || (expected.service === 'orchestrator' && config.replicaId !== undefined)) {
      throw fail('RESTORE_RUNTIME_CONFIG_MISMATCH');
    }
  }
}

async function validateManifestPins(manifest: Manifest): Promise<void> {
  const isolatedHost = manifest.isolatedHost;
  const publicPins = [
    manifest.libpqServiceFile, isolatedHost.launcher.executable,
    isolatedHost.networkPolicy.namespaceTool, isolatedHost.networkPolicy.nftTool,
    isolatedHost.networkPolicy.rulesFile,
    isolatedHost.recoveryReaders.objectStore.caFile, isolatedHost.recoveryReaders.transit.caFile,
    isolatedHost.recoveryReaders.vault.caFile,
  ];
  const protectedHostPins = [
    manifest.passfile, isolatedHost.libpq.passFile,
    isolatedHost.login.credentialFile, isolatedHost.artifact.apiKeyCredentialFile,
    isolatedHost.recoveryReaders.configFile, isolatedHost.recoveryReaders.objectStore.clientIdentityFile,
    isolatedHost.recoveryReaders.transit.tokenFile, isolatedHost.recoveryReaders.vault.tokenFile,
  ];
  const runtimeSecretPins = [
    ...Object.values(isolatedHost.runtimeConfigFiles),
    ...Object.values(isolatedHost.runtimeSecretsFiles), ...Object.values(isolatedHost.pgPasswordFiles),
    isolatedHost.localRuntime.orchestrator.tokenFile, isolatedHost.localRuntime.connector.tokenFile,
  ];
  await Promise.all(publicPins.map((pin) => readPinnedFile(pin.path, pin.sha256, 256 * 1024 * 1024)));
  await Promise.all(protectedHostPins.map((pin) => readProtectedPinnedFile(pin.path, pin.sha256)));
  await Promise.all(runtimeSecretPins.map((pin) => readProtectedPinnedFile(pin.path, pin.sha256, 4 * 1024 * 1024, 1000)));
  const recoveryConfigBytes = await readProtectedPinnedFile(isolatedHost.recoveryReaders.configFile.path,
    isolatedHost.recoveryReaders.configFile.sha256, 2 * 1024 * 1024);
  let recoveryRaw: unknown;
  try { recoveryRaw = JSON.parse(recoveryConfigBytes.toString('utf8')) as unknown; } catch { throw fail('RESTORE_RECOVERY_CONFIG_INVALID'); }
  const recoveryParsed = TrustedRestoreReaderConfigSchema.safeParse(recoveryRaw);
  if (!recoveryParsed.success) throw fail('RESTORE_RECOVERY_CONFIG_INVALID');
  const recovery = recoveryParsed.data;
  const expectedArtifactRefs = [...new Set(manifest.artifactTransitKeyPins.map((pin) => pin.keyRef))].sort();
  const expectedMetadataRefs = [...new Set(manifest.metadataTransitKeyPins.map((pin) => pin.keyRef))].sort();
  const actualArtifactRefs = Object.keys(recovery.transit.keyNameByRef.artifactTransit).sort();
  const actualMetadataRefs = Object.keys(recovery.transit.keyNameByRef.metadataTransit).sort();
  if (recovery.targetStorageGenerationId !== '${TARGET_STORAGE_GENERATION_ID}'
    || recovery.objectStore.endpoint !== manifest.isolatedStorage.endpoint
    || recovery.objectStore.bucket !== manifest.isolatedStorage.bucket
    || recovery.objectStore.region !== manifest.isolatedStorage.region
    || recovery.objectStore.forcePathStyle !== manifest.isolatedStorage.forcePathStyle
    || recovery.objectStore.credentialSource.credentialVersionRef !== manifest.isolatedStorage.credentialVersionRef
    || recovery.objectStore.credentialSource.ownerTenantId !== manifest.isolatedStorage.ownerTenantId
    || recovery.objectStore.endpoint !== isolatedHost.recoveryReaders.objectStore.endpoint
    || !samePin(recovery.objectStore.caFile, isolatedHost.recoveryReaders.objectStore.caFile)
    || !samePin(recovery.objectStore.clientIdentityFile, isolatedHost.recoveryReaders.objectStore.clientIdentityFile)
    || recovery.transit.endpoint !== isolatedHost.recoveryReaders.transit.endpoint
    || !samePin(recovery.transit.caFile, isolatedHost.recoveryReaders.transit.caFile)
    || !samePin(recovery.transit.tokenFile, isolatedHost.recoveryReaders.transit.tokenFile)
    || recovery.vault.endpoint !== isolatedHost.recoveryReaders.vault.endpoint
    || !samePin(recovery.vault.caFile, isolatedHost.recoveryReaders.vault.caFile)
    || !samePin(recovery.vault.tokenFile, isolatedHost.recoveryReaders.vault.tokenFile)
    || canonical(actualArtifactRefs) !== canonical(expectedArtifactRefs)
    || canonical(actualMetadataRefs) !== canonical(expectedMetadataRefs)
    || canonical(recovery.connectorVaultCredentialPins) !== canonical(manifest.connectorVaultCredentialPins)) {
    throw fail('RESTORE_RECOVERY_CONFIG_MISMATCH');
  }
  await readProtectedPinnedFile(recovery.recoveryKeyRegistry.path, recovery.recoveryKeyRegistry.sha256, 4 * 1024 * 1024);
  const executablePins = [
    ...Object.values(manifest.tools), isolatedHost.launcher.executable,
    isolatedHost.networkPolicy.namespaceTool, isolatedHost.networkPolicy.nftTool,
  ];
  await Promise.all(executablePins.map(async (tool) => {
    await readPinnedFile(tool.path, tool.sha256, 256 * 1024 * 1024);
    const info = await stat(tool.path);
    if ((info.mode & (fsConstants.S_IXUSR | fsConstants.S_IXGRP | fsConstants.S_IXOTH)) === 0) throw fail('BACKUP_TOOL_UNTRUSTED');
  }));
  const policyBytes = await readPinnedFile(isolatedHost.networkPolicy.rulesFile.path, isolatedHost.networkPolicy.rulesFile.sha256, 1024 * 1024);
  assertSourceDenyRules(manifest, policyBytes);
  await validateRuntimeConfigPins(manifest);
}

function samePin(left: z.infer<typeof FilePin>, right: z.infer<typeof FilePin>): boolean {
  return left.path === right.path && left.sha256 === right.sha256;
}

/** Fully validates the root-pinned manifest and every referenced immutable file
 * before returning metadata to the trusted runtime-port implementation. File
 * contents are never returned by this API. */
export async function readTrustedIsolatedRestoreRuntimeManifest(input: {
  manifestPath: string;
  expectedManifestSha256: string;
}): Promise<TrustedMaintenanceManifest> {
  if (!input || !AbsolutePath.safeParse(input.manifestPath).success || !SHA256.test(input.expectedManifestSha256)) {
    throw fail('BACKUP_MANIFEST_UNTRUSTED');
  }
  const raw = await readPinnedFile(input.manifestPath, input.expectedManifestSha256, 2 * 1024 * 1024);
  let parsedJson: unknown;
  try { parsedJson = JSON.parse(raw.toString('utf8')) as unknown; } catch { throw fail('BACKUP_MANIFEST_INVALID'); }
  const parsed = ManifestSchema.safeParse(parsedJson);
  if (!parsed.success) throw fail('BACKUP_MANIFEST_INVALID');
  await validateManifestPins(parsed.data);
  return parsed.data;
}

function componentPath(directory: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw fail('BACKUP_COMPONENT_NAME_INVALID');
  }
  const output = path.join(directory, `${name}.enc`);
  if (path.dirname(output) !== directory) throw fail('BACKUP_COMPONENT_NAME_INVALID');
  return output;
}

async function hashFile(filePath: string, maximum: number): Promise<{ sha256: string; byteSize: number }> {
  const hash = createHash('sha256');
  let byteSize = 0;
  for await (const chunk of createReadStream(filePath)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    byteSize += bytes.byteLength;
    if (!Number.isSafeInteger(byteSize) || byteSize > maximum) throw fail('BACKUP_COMPONENT_TOO_LARGE');
    hash.update(bytes);
  }
  return { sha256: hash.digest('hex'), byteSize };
}

function runTool(executable: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number, spawnImpl: typeof spawn): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    let settled = false;
    let timedOut = false;
    let interrupted = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let unregisterStop: (() => void) | undefined;
    const finish = (code: number | null, error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      unregisterStop?.();
      if (timedOut || interrupted || error) { reject(fail('MAINTENANCE_BACKUP_COMMAND_OUTCOME_UNKNOWN')); return; }
      if (code !== 0) { reject(fail('MAINTENANCE_BACKUP_COMMAND_FAILED')); return; }
      resolve();
    };
    try { child = spawnImpl(executable,[...args],{ shell:false, detached:process.platform !== 'win32', windowsHide:true, env:{ ...env }, stdio:['ignore','ignore','ignore'] }); }
    catch (error) { finish(null,error); return; }
    const terminate = (shutdown: boolean) => {
      if (settled || timedOut || interrupted) return;
      if (shutdown) interrupted = true;
      else timedOut = true;
      try {
        if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid,'SIGTERM');
        else child.kill('SIGTERM');
      } catch { /* process may already have exited */ }
      killTimer = setTimeout(() => {
        try {
          if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid,'SIGKILL');
          else child.kill('SIGKILL');
        } catch { /* process may already have exited */ }
      },750);
      killTimer.unref?.();
    };
    unregisterStop = registerActiveMaintenanceCommand(() => terminate(true));
    timer = setTimeout(() => terminate(false),timeoutMs);
    timer.unref?.();
    child.once('error',(error) => finish(null,error));
    child.once('close',(code) => finish(code));
  });
}

async function encryptReadable(input: Readable, output: string, key: Buffer, backupId: string, name: string, keyRef: string, maxPlainBytes: number): Promise<Component> {
  if (componentPath(path.dirname(output), name) !== output) throw fail('BACKUP_COMPONENT_NAME_INVALID');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(Buffer.from(`${backupId}\0${name}\0${keyRef}`));
  const hash = createHash('sha256');
  let plainByteSize = 0;
  let cipherByteSize = 0;
  const plainMeter = new Transform({ transform(chunk: Buffer, _encoding, done) {
    plainByteSize += chunk.length;
    if (!Number.isSafeInteger(plainByteSize) || plainByteSize > maxPlainBytes) { done(fail('BACKUP_COMPONENT_TOO_LARGE')); return; }
    done(null,chunk);
  } });
  const cipherMeter = new Transform({ transform(chunk: Buffer, _encoding, done) {
    cipherByteSize += chunk.length;
    hash.update(chunk);
    done(null,chunk);
  } });
  await pipeline(input,plainMeter,cipher,cipherMeter,createWriteStream(output,{ flags:'wx',mode:0o400 }));
  const tag = cipher.getAuthTag();
  return { name,sha256:hash.digest('hex'),cipherByteSize,plainByteSize,nonce:nonce.toString('base64'),tag:tag.toString('base64') };
}

async function decryptFile(input: string, output: string, component: Component, key: Buffer, backupId: string, keyRef: string): Promise<void> {
  const details = await lstat(input);
  if (!details.isFile() || details.isSymbolicLink() || details.size !== component.cipherByteSize || details.size < 1) throw fail('BACKUP_COMPONENT_INVALID');
  const checksum = await hashFile(input,component.cipherByteSize);
  if (checksum.sha256 !== component.sha256 || checksum.byteSize !== component.cipherByteSize) throw fail('BACKUP_COMPONENT_CHECKSUM_MISMATCH');
  const decipher = createDecipheriv('aes-256-gcm',key,Buffer.from(component.nonce,'base64'));
  decipher.setAAD(Buffer.from(`${backupId}\0${component.name}\0${keyRef}`));
  decipher.setAuthTag(Buffer.from(component.tag,'base64'));
  let plainByteSize = 0;
  const plainMeter = new Transform({ transform(chunk: Buffer, _encoding, done) {
    plainByteSize += chunk.length;
    if (!Number.isSafeInteger(plainByteSize) || plainByteSize > component.plainByteSize) { done(fail('BACKUP_COMPONENT_LENGTH_MISMATCH')); return; }
    done(null,chunk);
  } });
  try {
    await pipeline(createReadStream(input),decipher,plainMeter,createWriteStream(output,{flags:'wx',mode:0o600}));
    if (plainByteSize !== component.plainByteSize) throw fail('BACKUP_COMPONENT_LENGTH_MISMATCH');
  }
  catch { await rm(output,{force:true}); throw fail('BACKUP_COMPONENT_AUTHENTICATION_FAILED'); }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory,fsConstants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * Root-pinned backup and isolated restore adapter. It writes immutable,
 * checksummed AES-256-GCM bundles from both PostgreSQL planes and exact
 * artifact object versions. Restore targets must be explicitly isolated by
 * cluster identity and an allowlisted staged S3 generation.
 */
export function createTrustedMaintenanceBackupAdapter(options: TrustedMaintenanceBackupAdapterOptions): BackupAdapter {
  if (!SHA256.test(options.expectedManifestSha256)) throw fail('BACKUP_MANIFEST_DIGEST_INVALID');
  const now = options.now ?? (() => new Date());
  const spawnImpl = options.spawn ?? spawn;
  let loaded: Manifest | null = null;

  async function manifest(): Promise<Manifest> {
    if (loaded) return loaded;
    const candidate = await readTrustedIsolatedRestoreRuntimeManifest({
      manifestPath: options.manifestPath, expectedManifestSha256: options.expectedManifestSha256,
    });
    await ensurePrivateDirectory(candidate.bundleDirectory);
    await ensurePrivateDirectory(candidate.workDirectory);
    loaded = candidate;
    return candidate;
  }

  function privateEnv(man: Manifest): NodeJS.ProcessEnv {
    return { PATH:'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME:man.workDirectory,
      PGSERVICEFILE:man.libpqServiceFile.path, PGPASSFILE:man.passfile.path,
      LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'UTC',NO_COLOR:'1',PGCONNECT_TIMEOUT:'10' };
  }

  async function capturePsql(man: Manifest, service: string, sql: string, maxBytes = 4096): Promise<string> {
    const out = path.join(man.workDirectory,`psql-${randomBytes(8).toString('hex')}.txt`);
    await runTool(man.tools.psql.path,[`--dbname=service=${service}`,'--set=ON_ERROR_STOP=1','--tuples-only','--no-align','--field-separator=|',`--output=${out}`,`--command=${sql}`],privateEnv(man),30_000,spawnImpl);
    try {
      const data = await readFile(out);
      if (data.length > maxBytes) throw fail('BACKUP_PSQL_OUTPUT_TOO_LARGE');
      return data.toString('utf8').trim();
    } finally { await rm(out,{force:true}); }
  }

  async function connectorCryptoInventory(man:Manifest):Promise<{
    connectorInvocationKeyCounts:ConnectorInvocationKeyCount[];
    connectorReferencedSecretVersionCount:number;
    connectorVaultCredentialPinDigests:string[];
  }> {
    const invocationRows = await capturePsql(man,man.services.connectorSource,
      `WITH env(slot,envelope) AS (
         SELECT 'connector_invocations.request',request FROM connector_invocations
         UNION ALL SELECT 'connector_invocations.result',result FROM connector_invocations WHERE result IS NOT NULL
         UNION ALL SELECT 'connector_parity_revisions.recipe',recipe_envelope FROM connector_parity_revisions
         UNION ALL SELECT 'connector_parity_draft_intents.recipe',recipe_envelope FROM connector_parity_draft_intents
       )
       SELECT COALESCE(envelope->>'keyRef',''),COALESCE(envelope#>>'{dek,keyName}',''),
              COALESCE(envelope#>>'{dek,keyVersion}',''),count(*)::bigint
         FROM env WHERE jsonb_typeof(envelope)='object' AND envelope ? 'dek'
        GROUP BY 1,2,3 ORDER BY 1,2,3`,64*1024);
    const keyCountByPair = new Map<string,number>();
    for (const line of invocationRows.split('\n').filter(Boolean)) {
      const [keyRef,keyName,versionText,countText] = line.split('|');
      const keyVersion = Number(versionText);
      const count = Number(countText);
      if (!keyRef || keyRef !== keyName || !Number.isSafeInteger(keyVersion) || keyVersion < 1
        || !Number.isSafeInteger(count) || count < 1) throw fail('CONNECTOR_INVOCATION_ENVELOPE_INVALID');
      addCount(keyCountByPair,`${keyRef}@${keyVersion}`,count);
    }

    const requiredSealed = await capturePsql(man,man.services.connectorSource,
      `WITH env(slot,envelope) AS (
         SELECT 'connector_invocations.request',request FROM connector_invocations
         UNION ALL SELECT 'connector_invocations.result',result FROM connector_invocations WHERE result IS NOT NULL
         UNION ALL SELECT 'connector_parity_revisions.recipe',recipe_envelope FROM connector_parity_revisions
         UNION ALL SELECT 'connector_parity_draft_intents.recipe',recipe_envelope FROM connector_parity_draft_intents
       )
       SELECT slot,count(*)::bigint,count(*) FILTER (WHERE jsonb_typeof(envelope)='object' AND envelope ? 'dek')::bigint
         FROM env GROUP BY slot ORDER BY slot`,64*1024);
    for (const line of requiredSealed.split('\n').filter(Boolean)) {
      const [slot,totalText,sealedText] = line.split('|');
      const total = Number(totalText), sealed = Number(sealedText);
      if (!slot || !Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(sealed) || sealed < 0 || total !== sealed) {
        throw fail('CONNECTOR_INVOCATION_ENVELOPE_UNSEALED');
      }
    }

    const sessions = await capturePsql(man,man.services.connectorSource,
      `SELECT encode(convert_to(invocation_id,'UTF8'),'hex'),encode(convert_to(tenant_id,'UTF8'),'hex'),encode(convert_to(session_ref,'UTF8'),'hex')
         FROM connector_invocations WHERE session_ref IS NOT NULL ORDER BY invocation_id`,64*1024*1024);
    for (const line of sessions.split('\n').filter(Boolean)) {
      const [invocationHex,tenantHex,sessionHex] = line.split('|');
      if (!invocationHex || !tenantHex || !sessionHex || !/^(?:[0-9a-f]{2})+$/i.test(invocationHex)
        || !/^(?:[0-9a-f]{2})+$/i.test(tenantHex) || !/^(?:[0-9a-f]{2})+$/i.test(sessionHex)) throw fail('CONNECTOR_SESSION_REF_INVENTORY_INVALID');
      const invocationId = Buffer.from(invocationHex,'hex').toString('utf8');
      const tenantId = Buffer.from(tenantHex,'hex').toString('utf8');
      const serialized = Buffer.from(sessionHex,'hex').toString('utf8');
      let envelope:unknown;
      try { envelope = JSON.parse(serialized) as unknown; } catch { throw fail('CONNECTOR_SESSION_REF_UNSEALED'); }
      const identity = sealedEnvelopeKey(envelope);
      if (!identity) throw fail('CONNECTOR_SESSION_REF_UNSEALED');
      if (!invocationId || !tenantId) throw fail('CONNECTOR_SESSION_REF_CONTEXT_INVALID');
      addCount(keyCountByPair,`${identity.keyRef}@${identity.keyVersion}`,1);
    }

    const pins = new Map(man.connectorInvocationRecoveryKeys.map((pin)=>[`${pin.keyRef}@${pin.keyVersion}`,pin]));
    if (pins.size !== man.connectorInvocationRecoveryKeys.length) throw fail('CONNECTOR_INVOCATION_KEY_PIN_DUPLICATE');
    for (const pair of keyCountByPair.keys()) if (!pins.has(pair)) throw fail('CONNECTOR_INVOCATION_RECOVERY_KEY_MISSING');
    for (const pin of man.connectorInvocationRecoveryKeys) {
      const key = await resolveRecoveryKey(pin,'connector_invocation');
      key.fill(0);
    }
    const connectorInvocationKeyCounts = man.connectorInvocationRecoveryKeys.slice()
      .sort((a,b)=>`${a.keyRef}@${a.keyVersion}`.localeCompare(`${b.keyRef}@${b.keyVersion}`))
      .map(({keyRef,keyVersion})=>({keyRef,keyVersion,envelopeCount:keyCountByPair.get(`${keyRef}@${keyVersion}`) ?? 0}));

    const credentialKey = await resolveRecoveryKey(man.connectorCredentialRecoveryKey,'connector_credential');
    credentialKey.fill(0);
    const legacyCountText = await capturePsql(man,man.services.connectorSource,
      `WITH credential_refs AS (
         SELECT credential_ref FROM connector_revisions
         UNION SELECT credential_ref FROM connector_parity_revisions WHERE credential_source->>'kind'='legacy-db'
         UNION SELECT credential_ref FROM connector_parity_draft_intents WHERE credential_source->>'kind'='legacy-db'
       ) SELECT count(*)::bigint FROM secret_versions versioned
          WHERE EXISTS (SELECT 1 FROM credential_refs refs WHERE refs.credential_ref=versioned.credential_ref)`,128);
    const connectorReferencedSecretVersionCount = Number(legacyCountText);
    if (!Number.isSafeInteger(connectorReferencedSecretVersionCount) || connectorReferencedSecretVersionCount < 0) throw fail('CONNECTOR_SECRET_VERSION_COUNT_INVALID');

    const vaultRaw = await capturePsql(man,man.services.connectorSource,
      `SELECT COALESCE(json_agg(json_build_object('recordKind',record_kind,'tenantId',tenant_id,'connectorId',connector_id,
         'revision',revision,'account',credential_source->>'account','mount',credential_source->>'mount',
         'path',credential_source->>'path','key',credential_source->>'key','version',(credential_source->>'version')::integer))::text,'[]')
       FROM (
         SELECT 'revision'::text AS record_kind,tenant_id::text AS tenant_id,connector_id,revision,credential_source
           FROM connector_parity_revisions WHERE credential_source->>'kind' IN ('vault-kv2','vault-kv-v2')
         UNION ALL
         SELECT 'draft'::text AS record_kind,tenant_id::text AS tenant_id,connector_id,revision,credential_source
           FROM connector_parity_draft_intents WHERE credential_source->>'kind' IN ('vault-kv2','vault-kv-v2')
       ) pinned`,16*1024*1024);
    let parsedVault:unknown;
    try { parsedVault = JSON.parse(vaultRaw || '[]') as unknown; } catch { throw fail('CONNECTOR_VAULT_PIN_INVENTORY_INVALID'); }
    if (!Array.isArray(parsedVault)) throw fail('CONNECTOR_VAULT_PIN_INVENTORY_INVALID');
    const observedVault = parsedVault.map((value)=>{
      if (!isRecord(value)) throw fail('CONNECTOR_VAULT_PIN_INVENTORY_INVALID');
      const parsed = z.object({recordKind:z.enum(['revision','draft']),tenantId:z.string().uuid(),connectorId:SafeId,
        revision:z.number().int().positive(),account:SafeId,mount:SafeId,path:z.string().min(1).max(1024),key:SafeId,version:z.number().int().positive()}).strict().safeParse(value);
      if (!parsed.success) throw fail('CONNECTOR_VAULT_PIN_INVENTORY_INVALID');
      const source = VaultKv2PinSchema.safeParse({account:parsed.data.account,mount:parsed.data.mount,path:parsed.data.path,key:parsed.data.key,version:parsed.data.version});
      if (!source.success || !matchesVaultAccountPath(source.data,{tenantId:parsed.data.tenantId,connectorId:parsed.data.connectorId})) {
        throw fail('CONNECTOR_VAULT_PIN_INVENTORY_INVALID');
      }
      return parsed.data;
    }).sort((a,b)=>sha(Buffer.from(canonical(a))).localeCompare(sha(Buffer.from(canonical(b)))));
    const expectedVault = man.connectorVaultCredentialPins.slice().sort((a,b)=>sha(Buffer.from(canonical(a))).localeCompare(sha(Buffer.from(canonical(b)))));
    if (canonical(observedVault) !== canonical(expectedVault)) throw fail('CONNECTOR_VAULT_PIN_SET_CHANGED');
    return {connectorInvocationKeyCounts,connectorReferencedSecretVersionCount,
      connectorVaultCredentialPinDigests:observedVault.map((pin)=>sha(Buffer.from(canonical(pin)))).sort()};
  }

  async function metadataTransitInventory(man:Manifest):Promise<MetadataTransitKeyCount[]> {
    // Return only opaque Transit refs, key versions, and counts. Ciphertext is
    // never copied into bundle metadata or the command output file.
    const result = await options.db.query<{key_ref:string;key_name:string;key_version:string;envelope_count:number|string}>(
      `WITH source_refs(slot,raw_value) AS (
         SELECT 'operations.input_ref',input_ref::text FROM operations WHERE input_ref IS NOT NULL
         UNION ALL SELECT 'tasks.payload_ref',payload_ref::text FROM tasks WHERE payload_ref IS NOT NULL
         UNION ALL SELECT 'human_waits.response_ref',response_ref::text FROM human_waits WHERE response_ref IS NOT NULL
         UNION ALL SELECT 'step_checkpoints.output_ref',output_ref::text FROM step_checkpoints WHERE output_ref IS NOT NULL
         UNION ALL SELECT 'step_checkpoints.session_ref',session_ref::text FROM step_checkpoints WHERE session_ref IS NOT NULL
         UNION ALL SELECT 'operations.prompt_overrides_ref',prompt_overrides_ref::text FROM operations WHERE prompt_overrides_ref IS NOT NULL
         UNION ALL SELECT 'tasks.result_ref',result_ref::text FROM tasks WHERE result_ref IS NOT NULL
         UNION ALL SELECT 'operations.result_ref',result_ref::text FROM operations WHERE result_ref IS NOT NULL
         UNION ALL SELECT 'legacy_workflow_schemas.schema_ref',schema_ref::text FROM legacy_workflow_schemas WHERE schema_ref IS NOT NULL
         UNION ALL SELECT 'settings_revisions.payload_ref',payload_ref::text FROM settings_revisions WHERE payload_ref IS NOT NULL
         UNION ALL SELECT 'connector_prompt_overrides.prompt_override',prompt_override::text FROM connector_prompt_overrides WHERE prompt_override IS NOT NULL
         UNION ALL SELECT 'global_settings_tenant_revisions.payload_ref',payload_ref::text FROM global_settings_tenant_revisions WHERE payload_ref IS NOT NULL
         UNION ALL SELECT 'operations.tenant_defaults_ref',tenant_defaults_ref::text FROM operations WHERE tenant_defaults_ref IS NOT NULL
         UNION ALL SELECT 'operations.connector_recipe_pins_ref',connector_recipe_pins_ref::text FROM operations WHERE connector_recipe_pins_ref IS NOT NULL
         UNION ALL SELECT 'connector_secret_imports.resolved_payload',resolved_payload::text FROM connector_secret_imports WHERE resolved_payload IS NOT NULL
       ), parsed AS (
         SELECT slot,CASE WHEN left(ltrim(raw_value),1)='{' THEN raw_value::jsonb ELSE '{}'::jsonb END AS envelope
           FROM source_refs
       )
       SELECT COALESCE(envelope->>'keyRef','') AS key_ref,
              COALESCE(envelope#>>'{dek,keyName}','') AS key_name,
              COALESCE(envelope#>>'{dek,keyVersion}','') AS key_version,count(*)::bigint AS envelope_count
         FROM parsed WHERE jsonb_typeof(envelope)='object' AND envelope ? 'dek'
        GROUP BY 1,2,3 ORDER BY 1,2,3 LIMIT 257`,
    );
    if (result.rows.length > 256) throw fail('METADATA_TRANSIT_PIN_LIMIT_EXCEEDED');
    const observed = new Map<string,number>();
    const configured = new Set(man.metadataTransitKeyPins.map((pin)=>`${pin.keyRef}@${pin.keyVersion}`));
    if (configured.size !== man.metadataTransitKeyPins.length) throw fail('METADATA_TRANSIT_PIN_DUPLICATE');
    for (const row of result.rows) {
      const keyVersion = Number(row.key_version);
      const count = Number(row.envelope_count);
      if (!row.key_ref || row.key_ref !== row.key_name || !Number.isSafeInteger(keyVersion) || keyVersion < 1
        || !Number.isSafeInteger(count) || count < 1) throw fail('METADATA_TRANSIT_ENVELOPE_INVALID');
      const pair = `${row.key_name}@${keyVersion}`;
      if (!configured.has(pair)) throw fail('METADATA_TRANSIT_RECOVERY_KEY_MISSING');
      addCount(observed,pair,count);
    }
    return man.metadataTransitKeyPins.slice().sort((a,b)=>metadataTransitPinId(a).localeCompare(metadataTransitPinId(b)))
      .map((pin)=>({...pin,envelopeCount:observed.get(`${pin.keyRef}@${pin.keyVersion}`) ?? 0}));
  }

  async function resolveRecoveryKey(pin: Manifest['backupRecoveryKey'] | Manifest['secretCatalogRecoveryKeys'][number]
    | Manifest['connectorInvocationRecoveryKeys'][number] | Manifest['connectorCredentialRecoveryKey'], purpose:RecoveryKeyPurpose): Promise<Buffer> {
    const escrowRef = 'keyRef' in pin ? pin.keyRef : pin.escrowRef;
    const key = await options.resolveRecoveryKey({ purpose,escrowRef,keyVersion:String(pin.keyVersion) });
    const isCredential = purpose === 'connector_credential';
    const credentialText = isCredential && Buffer.isBuffer(key) ? key.toString('utf8') : '';
    const decodedCredential = isCredential && Buffer.isBuffer(key) ? Buffer.from(credentialText,'base64') : null;
    const validCredential = isCredential && Buffer.isBuffer(key) && key.length === 44 && /^[A-Za-z0-9+/]{43}=$/.test(credentialText)
      && decodedCredential?.length === 32 && decodedCredential.toString('base64') === credentialText;
    if (!Buffer.isBuffer(key) || (isCredential ? !validCredential : key.length !== 32)) {
      if (Buffer.isBuffer(key)) key.fill(0);
      decodedCredential?.fill(0);
      throw fail(purpose === 'backup_bundle' ? 'BACKUP_ENCRYPTION_KEY_INVALID' : 'INDEPENDENT_RECOVERY_KEY_INVALID');
    }
    if (sha(key) !== pin.fingerprintSha256) {
      key.fill(0);
      decodedCredential?.fill(0);
      throw fail('INDEPENDENT_RECOVERY_KEY_PIN_MISMATCH');
    }
    decodedCredential?.fill(0);
    return key;
  }

  async function verifiedSecretCatalogKeyCounts(man:Manifest): Promise<SecretCatalogKeyCount[]> {
    const result = await options.db.query<{key_version:string|null;revision_count:number|string;current_secret_count:number|string}>(
      `SELECT key_version,sum(revision_count)::bigint AS revision_count,sum(current_secret_count)::bigint AS current_secret_count
         FROM (
           SELECT encryption_key_version AS key_version,count(*)::bigint AS revision_count,0::bigint AS current_secret_count
             FROM secret_catalog_revisions WHERE encrypted_value IS NOT NULL GROUP BY encryption_key_version
           UNION ALL
           SELECT encryption_key_version AS key_version,0::bigint AS revision_count,count(*)::bigint AS current_secret_count
             FROM secret_catalog WHERE encrypted_value IS NOT NULL GROUP BY encryption_key_version
         ) AS encrypted_secret_rows GROUP BY key_version ORDER BY key_version`,
    );
    const configured = new Map(man.secretCatalogRecoveryKeys.map((pin)=>[pin.keyVersion,pin]));
    const counts = new Map<string,SecretCatalogKeyCount>();
    for (const row of result.rows) {
      if (!row.key_version || !configured.has(row.key_version)) throw fail('SECRET_CATALOG_RECOVERY_KEY_MISSING');
      const revisionCount = Number(row.revision_count);
      const currentSecretCount = Number(row.current_secret_count);
      if (!Number.isSafeInteger(revisionCount) || revisionCount < 0 || !Number.isSafeInteger(currentSecretCount) || currentSecretCount < 0) {
        throw fail('SECRET_CATALOG_RECOVERY_KEY_COUNTS_INVALID');
      }
      counts.set(row.key_version,{keyVersion:row.key_version,revisionCount,currentSecretCount});
    }
    const backupKey = await resolveRecoveryKey(man.backupRecoveryKey,'backup_bundle');
    backupKey.fill(0);
    for (const pin of man.secretCatalogRecoveryKeys) {
      const key = await resolveRecoveryKey(pin,'secret_catalog');
      key.fill(0);
    }
    return man.secretCatalogRecoveryKeys.map((pin)=>counts.get(pin.keyVersion) ?? {keyVersion:pin.keyVersion,revisionCount:0,currentSecretCount:0})
      .sort((a,b)=>a.keyVersion.localeCompare(b.keyVersion));
  }

  async function verifiedTargetRefs(man: Manifest): Promise<{
    credentialVersionRefs:string[]; credentialVersionPins:Array<{reference:string;ownerTenantId:string}>;
    encryptionKeyVersionRefs:string[]; artifactTransitKeyPins:ArtifactTransitKeyPin[];
    secretCatalogRecoveryKeys:SecretCatalogRecoveryKeyPin[]; secretCatalogKeyCounts:SecretCatalogKeyCount[];
    connectorCredentialRecoveryKey:{keyVersion:string;fingerprintSha256:string};
    connectorInvocationRecoveryKeys:ConnectorInvocationKeyPin[]; connectorInvocationKeyCounts:ConnectorInvocationKeyCount[];
    connectorReferencedSecretVersionCount:number; connectorVaultCredentialPinDigests:string[];
    metadataTransitKeyCounts:MetadataTransitKeyCount[];
  }> {
    const rows = await options.db.query<{ credential_version_ref: string | null; credential_owner_tenant_id: string | null }>(
      `SELECT DISTINCT credential_version_ref,credential_owner_tenant_id FROM storage_generations
        WHERE credential_version_ref IS NOT NULL ORDER BY credential_version_ref,credential_owner_tenant_id`,
    );
    const ownerByRef = new Map<string,string>();
    const addCredentialPin = (reference:string,ownerTenantId:string|null|undefined) => {
      if (!ownerTenantId || !z.string().uuid().safeParse(ownerTenantId).success) throw fail('BACKUP_SECRET_OWNER_MISSING');
      const existing = ownerByRef.get(reference);
      if (existing && existing !== ownerTenantId) throw fail('BACKUP_SECRET_OWNER_CONFLICT');
      ownerByRef.set(reference,ownerTenantId);
    };
    for (const pin of man.credentialVersionPins) addCredentialPin(pin.reference,pin.ownerTenantId);
    for (const reference of man.credentialVersionRefs) addCredentialPin(reference,man.ownerTenantId);
    addCredentialPin(man.isolatedStorage.credentialVersionRef,man.isolatedStorage.ownerTenantId);
    // The preview projection is intentionally manifest-only. Every historical
    // generation credential must therefore have been captured in that pinned
    // inventory; a new DB-only reference invalidates the target rather than
    // silently changing the queued preview during Host execution.
    for (const row of rows.rows) {
      if (!row.credential_version_ref) continue;
      const pinnedOwner = ownerByRef.get(row.credential_version_ref);
      if (!pinnedOwner || pinnedOwner !== row.credential_owner_tenant_id) throw fail('BACKUP_STORAGE_CREDENTIAL_PIN_SET_CHANGED');
    }
    const credentialVersionPins = [...ownerByRef].map(([reference,ownerTenantId])=>({reference,ownerTenantId})).sort((a,b)=>a.reference.localeCompare(b.reference));
    const credentialVersionRefs = credentialVersionPins.map((pin)=>pin.reference);
    const artifactTransitKeyPins = [...man.artifactTransitKeyPins].sort((a,b)=>transitKeyPinId(a).localeCompare(transitKeyPinId(b)));
    const secretCatalogKeyCounts = await verifiedSecretCatalogKeyCounts(man);
    const secretCatalogRecoveryKeys = man.secretCatalogRecoveryKeys.map(({keyVersion,fingerprintSha256})=>({keyVersion,fingerprintSha256}))
      .sort((a,b)=>a.keyVersion.localeCompare(b.keyVersion));
    const connector = await connectorCryptoInventory(man);
    const metadataTransitKeyCounts = await metadataTransitInventory(man);
    const connectorInvocationRecoveryKeys = man.connectorInvocationRecoveryKeys.map(({keyRef,keyVersion,fingerprintSha256})=>({keyRef,keyVersion,fingerprintSha256}))
      .sort((a,b)=>connectorInvocationKeyPinId(a).localeCompare(connectorInvocationKeyPinId(b)));
    const connectorCredentialRecoveryKey = {keyVersion:man.connectorCredentialRecoveryKey.keyVersion,
      fingerprintSha256:man.connectorCredentialRecoveryKey.fingerprintSha256};
    const encryptionKeyVersionRefs = [...new Set([recoveryKeyPinId(man.backupRecoveryKey),
      ...secretCatalogRecoveryKeys.map(secretCatalogKeyPinId),connectorCredentialKeyPinId(connectorCredentialRecoveryKey),
      ...connectorInvocationRecoveryKeys.map(connectorInvocationKeyPinId),...metadataTransitKeyCounts.map(metadataTransitPinId),
      ...artifactTransitKeyPins.map(transitKeyPinId)])].sort();
    for (const pin of credentialVersionPins) await options.verifySecretVersion(pin.reference,pin.ownerTenantId,'storage.credential');
    return { credentialVersionRefs,credentialVersionPins,encryptionKeyVersionRefs,artifactTransitKeyPins,secretCatalogRecoveryKeys,secretCatalogKeyCounts,
      connectorCredentialRecoveryKey,connectorInvocationRecoveryKeys,connectorInvocationKeyCounts:connector.connectorInvocationKeyCounts,
      connectorReferencedSecretVersionCount:connector.connectorReferencedSecretVersionCount,
      connectorVaultCredentialPinDigests:connector.connectorVaultCredentialPinDigests,metadataTransitKeyCounts };
  }

  async function sourceCounts(man: Manifest): Promise<BundleIndex['counts']> {
    const orchestrator = await options.db.query<Record<string, number | string>>(
      `SELECT (SELECT count(*) FROM operations)::bigint AS operations,
              (SELECT count(*) FROM artifacts WHERE state<>'DELETED')::bigint AS artifacts,
              (SELECT count(*) FROM artifacts WHERE state='READY')::bigint AS ready_artifacts,
              (SELECT count(*) FROM secret_catalog_revisions)::bigint AS secret_revisions,
              (SELECT count(*) FROM storage_generations)::bigint AS storage_generations,
              (SELECT count(*) FROM global_settings_tenant_revisions)::bigint AS global_settings_revisions,
              (SELECT count(*) FROM secret_catalog_imports)::bigint AS secret_catalog_imports,
              (SELECT count(*) FROM connector_secret_imports)::bigint AS connector_secret_imports,
              (SELECT count(*) FROM global_settings_retention_revisions)::bigint AS retention_revisions,
              (SELECT count(*) FROM cost_budget_revisions)::bigint AS budget_revisions,
              (SELECT count(*) FROM cost_price_revisions)::bigint AS price_revisions,
              (SELECT count(*) FROM cost_reservation_groups)::bigint AS reservation_groups,
              (SELECT count(*) FROM cost_budget_holds)::bigint AS budget_holds,
              (SELECT count(*) FROM usage_financial_adjustments)::bigint AS financial_adjustments,
              (SELECT count(*) FROM usage_financial_adjustment_heads)::bigint AS financial_adjustment_heads,
              (SELECT count(*) FROM usage_financial_adjustment_commands)::bigint AS financial_adjustment_commands`,
    );
    const connectorText = await capturePsql(man,man.services.connectorSource,
      `SELECT (SELECT count(*) FROM connector_invocations)::bigint,
              (SELECT count(*) FROM connector_usage_outbox)::bigint,
              (SELECT count(*) FROM secret_versions)::bigint,
              (SELECT count(*) FROM connector_revisions)::bigint,
              (SELECT count(*) FROM connector_replica_runtime_controls)::bigint,
              (SELECT count(*) FROM connector_parity_chains)::bigint,
              (SELECT count(*) FROM connector_parity_revisions)::bigint,
              (SELECT count(*) FROM connector_parity_claim_intents)::bigint,
              (SELECT count(*) FROM connector_parity_draft_intents)::bigint`,256);
    const connector = connectorText.split('|').map((entry) => Number(entry));
    const source = orchestrator.rows[0];
    if (!source || connector.length !== 9 || connector.some((value) => !Number.isSafeInteger(value) || value < 0)) throw fail('BACKUP_SOURCE_COUNTS_INVALID');
    const count = (key: string) => Number(source[key] ?? NaN);
    const readyArtifacts = count('ready_artifacts');
    const values = [count('operations'),count('artifacts'),count('secret_revisions'),count('storage_generations'),
      count('secret_catalog_imports'),count('connector_secret_imports'),
      count('global_settings_revisions'),count('retention_revisions'),count('budget_revisions'),count('price_revisions'),
      count('reservation_groups'),count('budget_holds'),count('financial_adjustments'),
      count('financial_adjustment_heads'),count('financial_adjustment_commands')];
    if (values.some((value) => !Number.isSafeInteger(value) || value < 0)
      || !Number.isSafeInteger(readyArtifacts) || readyArtifacts < 0 || readyArtifacts > values[1]!) throw fail('BACKUP_SOURCE_COUNTS_INVALID');
    return { operations:values[0]!,artifacts:values[1]!,readyArtifacts,secretRevisions:values[2]!,storageGenerations:values[3]!,
      secretCatalogImports:values[4]!,connectorSecretImports:values[5]!,globalSettingsRevisions:values[6]!,retentionRevisions:values[7]!,budgetRevisions:values[8]!,priceRevisions:values[9]!,
      reservationGroups:values[10]!,budgetHolds:values[11]!,financialAdjustments:values[12]!,
      financialAdjustmentHeads:values[13]!,financialAdjustmentCommands:values[14]!,connectorInvocations:connector[0]!,connectorUsageEvents:connector[1]!,
      connectorSecretVersions:connector[2]!,connectorRevisions:connector[3]!,connectorRuntimeControls:connector[4]!,
      connectorParityChains:connector[5]!,connectorParityRevisions:connector[6]!,connectorParityClaimIntents:connector[7]!,connectorParityDraftIntents:connector[8]!,
      artifactObjectBytes:0,artifactManifestBytes:0 };
  }

  async function verifySecretCatalogRecovery(man:Manifest,pins:readonly SecretCatalogRecoveryKeyPin[],counts:readonly SecretCatalogKeyCount[]): Promise<void> {
    const configured = man.secretCatalogRecoveryKeys.map(({keyVersion,fingerprintSha256})=>({keyVersion,fingerprintSha256}))
      .sort((a,b)=>a.keyVersion.localeCompare(b.keyVersion));
    if (canonical(pins) !== canonical(configured)
      || canonical(counts.map((item)=>item.keyVersion).slice().sort()) !== canonical(configured.map((item)=>item.keyVersion))) {
      throw fail('RESTORE_SECRET_CATALOG_KEY_PINS_INVALID');
    }
    for (const pin of man.secretCatalogRecoveryKeys) {
      const key = await resolveRecoveryKey(pin,'secret_catalog');
      key.fill(0);
    }
  }

  async function exportArtifacts(
    man: Manifest,
    backupId: string,
    directory: string,
    key: Buffer,
    components: Component[],
  ): Promise<{ path: string; count: number; artifactObjectBytes: number; artifactManifestBytes: number; artifactTransitKeyPins: ArtifactTransitKeyPin[]; snapshotPins: BackupArtifactSnapshotPin[] }> {
    const rows = await options.db.query<ArtifactRow>(
      `SELECT id,tenant_id,file_name,mime_type,size_bytes,sha256,storage_backend,storage_generation_id::text,
              storage_key,storage_version_id,manifest_version_id,state
         FROM artifacts WHERE state='READY' ORDER BY id`,
    );
    const entries: ArtifactBackupEntry[] = [];
    const allTransitPins = new Map<string,ArtifactTransitKeyPin>();
    let artifactObjectBytes = 0;
    let artifactManifestBytes = 0;
    let serializedIndexBytes = Buffer.byteLength(`{"backupId":${JSON.stringify(backupId)},"artifacts":[]}`);
    for (const row of rows.rows) {
      if (!row.storage_version_id || !row.storage_key || !row.storage_backend || !row.sha256 || !row.storage_generation_id) throw fail('BACKUP_ARTIFACT_PIN_MISSING');
      const stored = await options.artifacts.openPinnedObjectsForMaintenanceBackup({
        storageBackend:row.storage_backend,storageGenerationId:row.storage_generation_id,storageKey:row.storage_key,
        storageVersionId:row.storage_version_id,manifestVersionId:row.manifest_version_id,
      });
      const contentComponent = `object-${randomUUID()}`;
      const keyRef = recoveryKeyPinId(man.backupRecoveryKey);
      const content = await encryptReadable(stored.object,componentPath(directory,contentComponent),key,backupId,
        contentComponent,keyRef,man.maxArtifactBytes);
      components.push(content);
      artifactObjectBytes += content.plainByteSize;
      let manifestComponent: string | null = null;
      let manifestObjectBytes: number | null = null;
      let artifactTransitKeyPins: ArtifactTransitKeyPin[] = [];
      if (stored.manifest) {
        const sidecarBytes = await readBoundedStream(stored.manifest,16 * 1024);
        artifactTransitKeyPins = parseArtifactTransitPin(sidecarBytes,row);
        for (const pin of artifactTransitKeyPins) {
          if (!man.artifactTransitKeyPins.some((allowed) => allowed.keyRef === pin.keyRef && allowed.keyVersion === pin.keyVersion)) {
            throw fail('BACKUP_ARTIFACT_TRANSIT_KEY_NOT_ALLOWLISTED');
          }
          allTransitPins.set(transitKeyPinId(pin),pin);
        }
        manifestComponent = `sidecar-${randomUUID()}`;
        const sealed = await encryptReadable(Readable.from([sidecarBytes]),componentPath(directory,manifestComponent),key,backupId,
          manifestComponent,keyRef,16 * 1024);
        manifestObjectBytes = sealed.plainByteSize;
        artifactManifestBytes += sealed.plainByteSize;
        components.push(sealed);
      } else if (row.manifest_version_id) {
        throw fail('BACKUP_ARTIFACT_MANIFEST_MISSING');
      }
      const entry: ArtifactBackupEntry = { artifactId:row.id,tenantId:row.tenant_id,storageBackend:row.storage_backend,
        storageGenerationId:row.storage_generation_id,storageKey:row.storage_key,storageVersionId:row.storage_version_id,
        manifestVersionId:row.manifest_version_id,contentComponent,manifestComponent,
        fileName:row.file_name ?? `artifact-${row.id}`,mimeType:row.mime_type,
        sizeBytes:Number(row.size_bytes),sha256:row.sha256,storageObjectBytes:content.plainByteSize,
        manifestObjectBytes,artifactTransitKeyPins };
      serializedIndexBytes += Buffer.byteLength(JSON.stringify(entry)) + (entries.length ? 1 : 0);
      if (serializedIndexBytes > Math.min(man.maxBundleBytes,64 * 1024 * 1024)) throw fail('BACKUP_ARTIFACT_INDEX_TOO_LARGE');
      entries.push(entry);
    }
    const indexPath = path.join(directory,'artifact-index.json');
    await writeFile(indexPath,JSON.stringify({ backupId,artifacts:entries }),{flag:'wx',mode:0o600});
    const snapshotPins = entries.map((entry) => ({ artifactId:entry.artifactId,
      storageGenerationId:entry.storageGenerationId!,storageVersionId:entry.storageVersionId,
      manifestVersionId:entry.manifestVersionId }));
    if (snapshotPins.some((entry)=>!entry.storageGenerationId)) throw fail('BACKUP_STORAGE_GENERATION_PIN_MISSING');
    return { path:indexPath,count:entries.length,artifactObjectBytes,artifactManifestBytes,
      artifactTransitKeyPins:[...allTransitPins.values()].sort((a,b)=>transitKeyPinId(a).localeCompare(transitKeyPinId(b))),snapshotPins };
  }

  async function runDump(man: Manifest, service: string, target: string): Promise<void> {
    await runTool(man.tools.pgDump.path,[`--dbname=service=${service}`,'--format=custom','--no-owner','--no-acl',`--file=${target}`],privateEnv(man),man.toolTimeoutMs,spawnImpl);
    const details = await stat(target);
    if (!details.isFile() || details.size < 1 || details.size > man.maxBundleBytes) throw fail('BACKUP_DUMP_SIZE_INVALID');
  }

  async function readBundle(man: Manifest, bundleRef: string, expectedSha256: string, backupId: string): Promise<{ directory:string; index:BundleIndex }> {
    if (!SHA256.test(expectedSha256) || path.resolve(bundleRef) !== bundleRef || path.dirname(bundleRef) !== man.bundleDirectory
      || path.basename(bundleRef) !== `${backupId}.bundle`) throw fail('BACKUP_BUNDLE_REFERENCE_INVALID');
    const directoryInfo = await lstat(bundleRef);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || await realpath(bundleRef) !== bundleRef
      || !noGroupWorldWrite(directoryInfo.mode)) throw fail('BACKUP_BUNDLE_INVALID');
    const manifestPath = path.join(bundleRef,'manifest.json');
    const manifestInfo = await lstat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 64 * 1024 * 1024
      || await realpath(manifestPath) !== manifestPath) throw fail('BACKUP_BUNDLE_INVALID');
    const bytes = await readFile(manifestPath);
    if (sha(bytes) !== expectedSha256) throw fail('BACKUP_BUNDLE_CHECKSUM_MISMATCH');
    let raw: unknown;
    try { raw = JSON.parse(bytes.toString('utf8')) as unknown; } catch { throw fail('BACKUP_BUNDLE_INVALID'); }
    const parsed = BundleIndexSchema.safeParse(raw);
    if (!parsed.success || parsed.data.backupId !== backupId
      || digest(parsed.data.backupFenceProof.evidence) !== parsed.data.backupFenceProof.evidenceSha256
      || parsed.data.backupFenceProof.admission.inFlight !== 0
      || parsed.data.backupFenceProof.orchestratorDispatch.inFlight !== 0
      || parsed.data.backupFenceProof.providerIssuance.inFlight !== 0
      || parsed.data.backupFenceProof.connectorInvocationPolling.inFlight !== 0
      || parsed.data.backupFenceProof.artifactMutation.inFlight !== 0
      || parsed.data.backupFenceProof.connectorUsageDelivery.inFlight !== 0) throw fail('BACKUP_BUNDLE_INVALID');
    const index = parsed.data as unknown as BundleIndex;
    const expectedFiles = new Set(['manifest.json']);
    let totalBytes = bytes.length;
    for (const component of index.components) {
      const componentFile = componentPath(bundleRef,component.name);
      expectedFiles.add(path.basename(componentFile));
      const info = await lstat(componentFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== component.cipherByteSize
        || await realpath(componentFile) !== componentFile || !noGroupWorldWrite(info.mode)) throw fail('BACKUP_COMPONENT_INVALID');
      const observed = await hashFile(componentFile,man.maxBundleBytes);
      if (observed.sha256 !== component.sha256 || observed.byteSize !== component.cipherByteSize) throw fail('BACKUP_COMPONENT_CHECKSUM_MISMATCH');
      totalBytes += observed.byteSize;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > man.maxBundleBytes) throw fail('BACKUP_BUNDLE_TOO_LARGE');
    }
    const actualFiles = await readdir(bundleRef);
    if (actualFiles.length !== expectedFiles.size || actualFiles.some((name) => !expectedFiles.has(name))) throw fail('BACKUP_BUNDLE_CONTENT_SET_MISMATCH');
    return { directory:bundleRef,index };
  }

  async function assertExecutionFence(execution: MaintenanceExecutionFence): Promise<void> {
    const result = await options.db.query(
      `SELECT 1 FROM maintenance_job_items
        WHERE job_id=$1 AND item_id=$2 AND status='RUNNING' AND owner_runtime_identity=$3
          AND owner_boot_id=$4 AND execution_fence=$5 AND backup_execution_token_sha256=$6 AND claim_until>now()`,
      [execution.jobId,execution.itemId,execution.ownerRuntimeIdentity,execution.ownerBootId,
        execution.executionFence,sha(Buffer.from(execution.executionToken))],
    );
    if (!result.rowCount) throw fail('MAINTENANCE_EXECUTION_FENCE_LOST');
  }

  async function claimRestoreAttempt(backupId: string, targetGenerationId: string, execution: MaintenanceExecutionFence): Promise<unknown | null> {
    return options.db.tx(async (client) => {
      const inserted = await client.query(
        `INSERT INTO maintenance_restore_attempts(backup_id,target_generation_id,job_id,item_id,owner_runtime_identity,
             execution_fence,owner_boot_id,execution_token_sha256,state)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'RUNNING')
         ON CONFLICT(backup_id,target_generation_id) DO NOTHING RETURNING backup_id`,
        [backupId,targetGenerationId,execution.jobId,execution.itemId,execution.ownerRuntimeIdentity,
          execution.executionFence,execution.ownerBootId,sha(Buffer.from(execution.executionToken))],
      );
      if (inserted.rowCount) return null;
      const previous = await client.query<{ state: string; result: unknown }>(
        `SELECT state,result FROM maintenance_restore_attempts WHERE backup_id=$1 AND target_generation_id=$2 FOR UPDATE`,
        [backupId,targetGenerationId],
      );
      if (previous.rows[0]?.state === 'SUCCEEDED' && previous.rows[0].result) return previous.rows[0].result;
      throw fail('RESTORE_ATTEMPT_ALREADY_STARTED');
    });
  }

  async function finishRestoreAttempt(backupId: string, targetGenerationId: string, execution: MaintenanceExecutionFence,
    state: 'UNKNOWN' | 'SUCCEEDED', result: unknown = null): Promise<void> {
    const updated = await options.db.query(
      `UPDATE maintenance_restore_attempts SET state=$6,result=$7,updated_at=now(),completed_at=CASE WHEN $6='SUCCEEDED' THEN now() ELSE NULL END
        WHERE backup_id=$1 AND target_generation_id=$2 AND job_id=$3 AND item_id=$4
          AND owner_runtime_identity=$5 AND execution_fence=$8 AND owner_boot_id=$9
          AND execution_token_sha256=$10 AND state='RUNNING'`,
      [backupId,targetGenerationId,execution.jobId,execution.itemId,execution.ownerRuntimeIdentity,state,
        result === null ? null : JSON.stringify(result),execution.executionFence,execution.ownerBootId,
        sha(Buffer.from(execution.executionToken))],
    );
    if (!updated.rowCount) throw fail('RESTORE_ATTEMPT_OWNER_FENCE_LOST');
  }

  function validateProbe(man: Manifest, bundle: BundleIndex, result: IsolatedRestoreRuntimeProbeResult,
    expectedCounts: BundleIndex['counts'], expectedTransitPins: readonly ArtifactTransitKeyPin[],
    expectedSecretCatalogKeys: readonly SecretCatalogRecoveryKeyPin[], expectedSecretCatalogCounts: readonly SecretCatalogKeyCount[],
    expectedConnectorInvocationKeys:readonly ConnectorInvocationKeyPin[],expectedConnectorInvocationCounts:readonly ConnectorInvocationKeyCount[],
    expectedConnectorCredentialKey:{keyVersion:string;fingerprintSha256:string},expectedConnectorSecretVersionCount:number,
    expectedMetadataTransitCounts:readonly MetadataTransitKeyCount[],expectedVaultCredentialPinDigests:readonly string[]): void {
    if (!result || typeof result !== 'object' || !result.orchestrator || !result.connector || !result.recoverySourceIsolation
      || !result.checks || !Array.isArray(result.artifactTransitKeyRecoveries) || !Array.isArray(result.secretCatalogKeyRecoveries)
      || !Array.isArray(result.connectorInvocationKeyRecoveries) || !Array.isArray(result.metadataTransitKeyRecoveries)
      || !Array.isArray(result.vaultCredentialRecoveries)
      || !result.connectorCredentialRecovery || typeof result.connectorCredentialRecovery !== 'object'
      || !result.counts || !result.evidenceSha256) throw fail('RESTORE_RUNTIME_PROBE_INVALID');
    const unsigned = { ...result } as Record<string, unknown>;
    delete unsigned.evidenceSha256;
    if (!SHA256.test(result.evidenceSha256) || sha(Buffer.from(canonical(unsigned))) !== result.evidenceSha256) throw fail('RESTORE_RUNTIME_PROBE_DIGEST_INVALID');
    const current = now().getTime();
    const fresh = (value: string) => {
      const observed = Date.parse(value);
      return Number.isFinite(observed) && observed <= current + 1_000 && current - observed <= 60_000;
    };
    const orch = result.orchestrator;
    const conn = result.connector;
    if (!fresh(result.observedAt) || !fresh(orch.observedAt) || !fresh(orch.workObservedAt)
      || !fresh(conn.observedAt) || !fresh(conn.workObservedAt) || !fresh(result.recoverySourceIsolation.observedAt)
      || result.recoverySourceIsolation.sourceOrchestratorReachable !== false
      || result.recoverySourceIsolation.sourceConnectorReachable !== false
      || result.recoverySourceIsolation.sourceCatalogKeyringReachable !== false
      || result.recoverySourceIsolation.sourceConnectorRecoveryRegistryReachable !== false
      || result.recoverySourceIsolation.sourceMetadataTransitReachable !== false
      || result.recoverySourceIsolation.sourceArtifactTransitReachable !== false
      || result.recoverySourceIsolation.sourceVaultReachable !== false
      || result.recoverySourceIsolation.independentRecoveryKeyReachable !== true
      || result.recoverySourceIsolation.independentSecretCatalogRecoveryReachable !== true
      || result.recoverySourceIsolation.connectorRecoveryRegistryReachable !== true
      || result.recoverySourceIsolation.metadataTransitReachable !== true
      || result.recoverySourceIsolation.vaultCredentialReaderReachable !== true
      || result.recoverySourceIsolation.artifactTransitReachable !== true
      || orch.clusterName !== man.orchestratorRestoreClusterName
      || orch.runtimeIdentity !== man.isolatedRuntime.orchestratorRuntimeIdentity
      || orch.revision !== man.isolatedRuntime.orchestratorRevision
      || orch.imageDigest !== man.isolatedRuntime.orchestratorImageDigest
      || orch.controlState !== 'DRAINING' || !Number.isSafeInteger(orch.controlRevision) || orch.controlRevision < 1
      || orch.activeRequests !== 0 || orch.activeDispatches !== 0 || orch.maintenanceExecutions !== 0
      || conn.clusterName !== man.connectorRestoreClusterName
      || conn.runtimeIdentity !== man.isolatedRuntime.connectorRuntimeIdentity
      || conn.replicaId !== man.isolatedRuntime.connectorReplicaId || conn.slot !== man.isolatedRuntime.connectorSlot
      || conn.revision !== man.isolatedRuntime.connectorRevision || conn.imageDigest !== man.isolatedRuntime.connectorImageDigest
      || conn.controlState !== 'DRAINING' || !Number.isSafeInteger(conn.controlRevision) || conn.controlRevision < 1
      || conn.activeInvocations !== 0 || conn.processActiveInvocations !== 0 || conn.processActivePolls !== 0
      || conn.processActiveUsageSends !== 0
      || ![conn.unresolvedInvocationHolds,conn.unclosedEffectPermits,conn.unknownUsageDeliveries,
        conn.effectPermits.prepared,conn.effectPermits.active,conn.effectPermits.settling,conn.effectPermits.unknown]
        .every((value)=>Number.isSafeInteger(value)&&value>=0)
      || conn.effectPermits.prepared !== 0 || conn.effectPermits.active !== 0 || conn.effectPermits.settling !== 0
      || conn.unclosedEffectPermits !== conn.effectPermits.prepared+conn.effectPermits.active+conn.effectPermits.settling+conn.effectPermits.unknown) {
      throw fail('RESTORE_RUNTIME_IDENTITY_OR_DRAIN_UNVERIFIED');
    }
    if (result.checks.login !== 'PASSED' || result.checks.history !== 'PASSED'
      || result.checks.artifactDecryption !== 'PASSED' || result.checks.artifactDownload !== 'PASSED'
      || result.checks.artifactTransitKeyRecovery !== 'PASSED' || result.checks.secretCatalogDecryption !== 'PASSED' || result.checks.dispatchDisabled !== 'PASSED'
      || result.checks.connectorInvocationDecryption !== 'PASSED' || result.checks.connectorCredentialDecryption !== 'PASSED'
      || result.checks.metadataTransitDecryption !== 'PASSED' || result.checks.vaultCredentialReads !== 'PASSED'
      || result.checks.providerCallsDisabled !== 'PASSED' || result.checks.usageDeliveryDisabled !== 'PASSED'
      || Object.values(result.checks.externalEffects).some((status)=>status!=='PASSED')
      || Object.values(result.externalEffects).some((status)=>status!=='DISABLED')) throw fail('RESTORE_RUNTIME_PROBES_FAILED');
    const observedTransit = result.artifactTransitKeyRecoveries.map((proof) => `${proof.keyRef}@${proof.keyVersion}`).sort();
    const expectedTransit = expectedTransitPins.map(transitKeyPinId).sort();
    if (canonical(observedTransit) !== canonical(expectedTransit)
      || result.artifactTransitKeyRecoveries.some((proof) => !Number.isSafeInteger(proof.verifiedArtifactCount)
        || proof.verifiedArtifactCount < 1 || !SHA256.test(proof.evidenceSha256))) throw fail('RESTORE_ARTIFACT_KEY_RECOVERY_UNVERIFIED');
    const observedCatalog = result.secretCatalogKeyRecoveries.map((proof)=>proof.keyVersion).sort();
    const expectedCatalog = expectedSecretCatalogKeys.map((pin)=>pin.keyVersion).sort();
    const countsByVersion = new Map(expectedSecretCatalogCounts.map((item)=>[item.keyVersion,item]));
    if (canonical(observedCatalog) !== canonical(expectedCatalog)
      || result.secretCatalogKeyRecoveries.some((proof)=>{
        const expected = countsByVersion.get(proof.keyVersion);
        return !expected || proof.verifiedRevisionCount !== expected.revisionCount
          || proof.verifiedCurrentSecretCount !== expected.currentSecretCount || !SHA256.test(proof.evidenceSha256);
      })) throw fail('RESTORE_SECRET_CATALOG_KEY_RECOVERY_UNVERIFIED');
    const observedInvocation = result.connectorInvocationKeyRecoveries.map((proof)=>`${proof.keyRef}@${proof.keyVersion}`).sort();
    const expectedInvocation = expectedConnectorInvocationKeys.map((pin)=>`${pin.keyRef}@${pin.keyVersion}`).sort();
    const invocationCounts = new Map(expectedConnectorInvocationCounts.map((item)=>[`${item.keyRef}@${item.keyVersion}`,item.envelopeCount]));
    if (canonical(observedInvocation) !== canonical(expectedInvocation)
      || result.connectorInvocationKeyRecoveries.some((proof)=>invocationCounts.get(`${proof.keyRef}@${proof.keyVersion}`) !== proof.verifiedEnvelopeCount
        || !Number.isSafeInteger(proof.verifiedEnvelopeCount) || proof.verifiedEnvelopeCount < 0 || !SHA256.test(proof.evidenceSha256))) {
      throw fail('RESTORE_CONNECTOR_INVOCATION_KEY_RECOVERY_UNVERIFIED');
    }
    if (result.connectorCredentialRecovery.keyVersion !== expectedConnectorCredentialKey.keyVersion
      || result.connectorCredentialRecovery.verifiedSecretVersionCount !== expectedConnectorSecretVersionCount
      || !SHA256.test(result.connectorCredentialRecovery.evidenceSha256)) throw fail('RESTORE_CONNECTOR_CREDENTIAL_RECOVERY_UNVERIFIED');
    const observedMetadata = result.metadataTransitKeyRecoveries.map((proof)=>`${proof.keyRef}@${proof.keyVersion}`).sort();
    const expectedMetadata = expectedMetadataTransitCounts.map((pin)=>`${pin.keyRef}@${pin.keyVersion}`).sort();
    const metadataCounts = new Map(expectedMetadataTransitCounts.map((item)=>[`${item.keyRef}@${item.keyVersion}`,item.envelopeCount]));
    if (canonical(observedMetadata) !== canonical(expectedMetadata)
      || result.metadataTransitKeyRecoveries.some((proof)=>metadataCounts.get(`${proof.keyRef}@${proof.keyVersion}`) !== proof.verifiedEnvelopeCount
        || !Number.isSafeInteger(proof.verifiedEnvelopeCount) || proof.verifiedEnvelopeCount < 0 || !SHA256.test(proof.evidenceSha256))) {
      throw fail('RESTORE_METADATA_TRANSIT_RECOVERY_UNVERIFIED');
    }
    const observedVault = result.vaultCredentialRecoveries.map((proof)=>proof.pinSha256).sort();
    if (canonical(observedVault) !== canonical([...expectedVaultCredentialPinDigests].sort())
      || result.vaultCredentialRecoveries.some((proof)=>proof.verifiedRead !== true || !SHA256.test(proof.evidenceSha256))) {
      throw fail('RESTORE_VAULT_CREDENTIAL_READ_UNVERIFIED');
    }
    if (canonical(result.counts) !== canonical(expectedCounts)
      || bundle.sourceClusterNames.orchestrator === man.orchestratorRestoreClusterName
      || bundle.sourceClusterNames.connector === man.connectorRestoreClusterName) throw fail('RESTORE_RUNTIME_COUNT_RECONCILIATION_FAILED');
  }

  async function restoreBundle(input: Parameters<BackupAdapter['restoreBundle']>[0]) {
    const man = await manifest();
    if (!input.isolated || !input.dispatchDisabled || !input.providerCallsDisabled) throw fail('RESTORE_ISOLATION_REQUIRED');
    await assertExecutionFence(input.execution);
    const targetResult = await options.db.query<StorageRow>(
      `SELECT generation_id,revision,backend,endpoint,bucket,region,force_path_style,credential_version_ref,credential_owner_tenant_id,url_ttl_seconds,state
         FROM storage_generations WHERE generation_id=$1`,[input.targetGenerationId],
    );
    const target = targetResult.rows[0];
    if (!target || target.state !== 'STAGED' || target.backend !== 's3'
      || target.endpoint !== man.isolatedStorage.endpoint || target.bucket !== man.isolatedStorage.bucket
      || target.region !== man.isolatedStorage.region || target.force_path_style !== man.isolatedStorage.forcePathStyle
      || target.credential_version_ref !== man.isolatedStorage.credentialVersionRef
      || target.credential_owner_tenant_id !== man.isolatedStorage.ownerTenantId) throw fail('RESTORE_TARGET_NOT_ISOLATED');
    const bundle = await readBundle(man,input.bundleRef,input.expectedSha256,input.backupId);
    if (bundle.index.sourceClusterNames.orchestrator === man.orchestratorRestoreClusterName
      || bundle.index.sourceClusterNames.connector === man.connectorRestoreClusterName) throw fail('RESTORE_CLUSTER_IDENTITY_MISMATCH');
    const configuredCatalogPins = man.secretCatalogRecoveryKeys.map(({keyVersion,fingerprintSha256})=>({keyVersion,fingerprintSha256}))
      .sort((a,b)=>a.keyVersion.localeCompare(b.keyVersion));
    if (bundle.index.backupRecoveryKey.keyVersion !== man.backupRecoveryKey.keyVersion
      || bundle.index.backupRecoveryKey.fingerprintSha256 !== man.backupRecoveryKey.fingerprintSha256
      || canonical(bundle.index.secretCatalogRecoveryKeys) !== canonical(configuredCatalogPins)
      || canonical(bundle.index.connectorCredentialRecoveryKey) !== canonical({keyVersion:man.connectorCredentialRecoveryKey.keyVersion,
        fingerprintSha256:man.connectorCredentialRecoveryKey.fingerprintSha256})
      || canonical(bundle.index.connectorInvocationRecoveryKeys) !== canonical(man.connectorInvocationRecoveryKeys.map(({keyRef,keyVersion,fingerprintSha256})=>({keyRef,keyVersion,fingerprintSha256}))
        .sort((a,b)=>connectorInvocationKeyPinId(a).localeCompare(connectorInvocationKeyPinId(b))))
      || canonical(bundle.index.metadataTransitKeyCounts.map(({keyRef,keyVersion})=>({keyRef,keyVersion}))
        .sort((a,b)=>metadataTransitPinId(a).localeCompare(metadataTransitPinId(b)))) !== canonical(man.metadataTransitKeyPins
        .slice().sort((a,b)=>metadataTransitPinId(a).localeCompare(metadataTransitPinId(b))))
      || canonical(bundle.index.connectorVaultCredentialPinDigests) !== canonical(man.connectorVaultCredentialPins.map((pin)=>sha(Buffer.from(canonical(pin)))).sort())
      || bundle.index.artifactTransitKeyPins.some((pin) => !man.artifactTransitKeyPins.some((allowed) => allowed.keyRef === pin.keyRef && allowed.keyVersion === pin.keyVersion))) {
      throw fail('RESTORE_CRYPTO_PIN_MISMATCH');
    }
    await verifySecretCatalogRecovery(man,bundle.index.secretCatalogRecoveryKeys,bundle.index.secretCatalogKeyCounts);
    for (const pin of man.connectorInvocationRecoveryKeys) {
      const key = await resolveRecoveryKey(pin,'connector_invocation');
      key.fill(0);
    }
    const connectorCredentialKey = await resolveRecoveryKey(man.connectorCredentialRecoveryKey,'connector_credential');
    connectorCredentialKey.fill(0);
    for (const pin of bundle.index.credentialVersionPins) await options.verifySecretVersion(pin.reference,pin.ownerTenantId,'storage.credential');
    const key = await resolveRecoveryKey(man.backupRecoveryKey,'backup_bundle');
    const work = path.join(man.workDirectory,`restore-${input.backupId}-${randomBytes(6).toString('hex')}`);
    let workCreated = false;
    let attemptClaimed = false;
    try {
      await mkdir(work,{recursive:false,mode:0o700});
      workCreated = true;
      const decrypted = new Map<string,string>();
      for (const component of bundle.index.components) {
        const inputPath = componentPath(bundle.directory,component.name);
        const info = await lstat(inputPath);
        if (!info.isFile() || info.isSymbolicLink()) throw fail('BACKUP_COMPONENT_INVALID');
        const outputPath = path.join(work,component.name);
        await decryptFile(inputPath,outputPath,component,key,input.backupId,recoveryKeyPinId(bundle.index.backupRecoveryKey));
        decrypted.set(component.name,outputPath);
      }
      const artifactIndexRaw = JSON.parse(await readFile(decrypted.get('artifact-index.json')!,'utf8')) as unknown;
      const artifactIndexParsed = ArtifactIndexSchema.safeParse(artifactIndexRaw);
      if (!artifactIndexParsed.success || artifactIndexParsed.data.backupId !== input.backupId
        || artifactIndexParsed.data.artifacts.length !== bundle.index.counts.artifacts) throw fail('RESTORE_ARTIFACT_INDEX_INVALID');
      const artifactIndex = artifactIndexParsed.data;
      const restoredTransitPins = [...new Map(artifactIndex.artifacts.flatMap((entry) => entry.artifactTransitKeyPins)
        .map((pin) => [transitKeyPinId(pin),pin])).values()].sort((a,b)=>transitKeyPinId(a).localeCompare(transitKeyPinId(b)));
      if (canonical(restoredTransitPins) !== canonical(bundle.index.artifactTransitKeyPins)) throw fail('RESTORE_ARTIFACT_KEY_PIN_MISMATCH');
      const artifactBytes = artifactIndex.artifacts.reduce((sum,entry) => sum + entry.storageObjectBytes,0);
      const manifestBytes = artifactIndex.artifacts.reduce((sum,entry) => sum + (entry.manifestObjectBytes ?? 0),0);
      if (artifactBytes !== bundle.index.counts.artifactObjectBytes || manifestBytes !== bundle.index.counts.artifactManifestBytes) {
        throw fail('RESTORE_ARTIFACT_BYTES_INVALID');
      }
      const previous = await claimRestoreAttempt(input.backupId,input.targetGenerationId,input.execution);
      if (previous) return previous as Awaited<ReturnType<BackupAdapter['restoreBundle']>>;
      attemptClaimed = true;
      await assertExecutionFence(input.execution);

      const orchIdentity = await capturePsql(man,man.services.orchestratorRestoreAdmin,"SELECT current_setting('cluster_name',true)",256);
      const connectorIdentity = await capturePsql(man,man.services.connectorRestoreAdmin,"SELECT current_setting('cluster_name',true)",256);
      if (orchIdentity !== man.orchestratorRestoreClusterName || connectorIdentity !== man.connectorRestoreClusterName
        || orchIdentity === bundle.index.sourceClusterNames.orchestrator || connectorIdentity === bundle.index.sourceClusterNames.connector) {
        throw fail('RESTORE_CLUSTER_IDENTITY_MISMATCH');
      }
      const suffix = `${input.backupId.replaceAll('-','').slice(0,12)}${input.targetGenerationId.replaceAll('-','').slice(0,12)}`;
      const orchDb = `du_restore_o_${suffix}`;
      const connectorDb = `du_restore_c_${suffix}`;
      const existingOrchestrator = await capturePsql(man,man.services.orchestratorRestoreAdmin,
        `SELECT count(*) FROM pg_database WHERE datname IN (${q(orchDb)},${q(connectorDb)})`,256);
      const existingConnector = await capturePsql(man,man.services.connectorRestoreAdmin,
        `SELECT count(*) FROM pg_database WHERE datname IN (${q(orchDb)},${q(connectorDb)})`,256);
      if (Number(existingOrchestrator) !== 0 || Number(existingConnector) !== 0) throw fail('RESTORE_DATABASE_ALREADY_EXISTS');
      const create = async (service:string,name:string) => {
        await assertExecutionFence(input.execution);
        await runTool(man.tools.createdb.path,[`--maintenance-db=service=${service}`,`--owner=${man.restoreOwnerRole}`,name],privateEnv(man),60_000,spawnImpl);
      };
      await create(man.services.orchestratorRestoreAdmin,orchDb);
      await create(man.services.connectorRestoreAdmin,connectorDb);
      const restore = async (service:string,name:string,dump:string) => {
        await assertExecutionFence(input.execution);
        await runTool(man.tools.pgRestore.path,[`--dbname=service=${service} dbname=${name}`,'--no-owner','--no-acl','--exit-on-error','--single-transaction',dump],privateEnv(man),man.toolTimeoutMs,spawnImpl);
      };
      await restore(man.services.orchestratorRestoreAdmin,orchDb,decrypted.get('orchestrator.dump')!);
      await restore(man.services.connectorRestoreAdmin,connectorDb,decrypted.get('connector.dump')!);
      const facade = options.storageGenerations.forGeneration(input.targetGenerationId);
      const remapped: Array<{artifactId:string;storageKey:string;storageVersionId:string;manifestVersionId:string|null}> = [];
      for (const entry of artifactIndex.artifacts) {
        await assertExecutionFence(input.execution);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry.artifactId)
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry.tenantId)) throw fail('RESTORE_ARTIFACT_ID_INVALID');
        const storageKey = `maintenance-restore/${input.backupId}/${input.targetGenerationId}/${entry.artifactId}/ciphertext`;
        const ciphertextPath = decrypted.get(entry.contentComponent);
        if (!ciphertextPath || !facade.putServerObjectStream) throw fail('RESTORE_STORAGE_WRITE_UNAVAILABLE');
        const restoredMetadata = restoredArtifactWriteMetadata({ storageKey, artifactId: entry.artifactId,
          tenantId: entry.tenantId, sealed: entry.manifestComponent !== null });
        const stored = await facade.putServerObjectStream({objectKey:storageKey,artifactId:entry.artifactId,tenantId:entry.tenantId,
          source:createReadStream(ciphertextPath),contentLength:entry.storageObjectBytes,contentType:'application/octet-stream',
          ...(restoredMetadata.ciphertext ? { metadata: restoredMetadata.ciphertext } : {})});
        if (!stored.versionId) throw fail('RESTORE_STORAGE_VERSION_UNAVAILABLE');
        let manifestVersionId: string | null = null;
        if (entry.manifestComponent) {
          const manifestPath = decrypted.get(entry.manifestComponent);
          if (!manifestPath || !facade.putServerObjectStream || entry.manifestObjectBytes === null) throw fail('RESTORE_STORAGE_WRITE_UNAVAILABLE');
          const manifestStored = await facade.putServerObjectStream({objectKey:restoredArtifactManifestObjectKey(storageKey),artifactId:entry.artifactId,tenantId:entry.tenantId,
            source:createReadStream(manifestPath),contentLength:entry.manifestObjectBytes,contentType:ARTIFACT_SIDECAR_CONTENT_TYPE,
            ...(restoredMetadata.manifest ? { metadata: restoredMetadata.manifest } : {})});
          if (!manifestStored.versionId) throw fail('RESTORE_STORAGE_VERSION_UNAVAILABLE');
          manifestVersionId = manifestStored.versionId;
        }
        remapped.push({artifactId:entry.artifactId,storageKey,storageVersionId:stored.versionId,manifestVersionId});
      }
      const controlSql = `INSERT INTO runtime_control_scopes(scope_kind,scope_id,desired_state,revision,reason,actor)
        VALUES('platform','all','DRAINING',nextval('runtime_control_revision_seq'),'isolated restore safety fence','maintenance-restore')
        ON CONFLICT(scope_kind,scope_id) DO UPDATE SET desired_state='DRAINING',revision=nextval('runtime_control_revision_seq'),
          reason='isolated restore safety fence',actor='maintenance-restore',updated_at=now();`;
      const storageSql = await makeStorageRestoreSql(options.db,input.targetGenerationId);
      const artifactSql = remapped.map((entry) => `DO $artifact$
      BEGIN
        UPDATE artifacts SET storage_generation_id=${q(input.targetGenerationId)}::uuid,storage_backend='s3',storage_key=${q(entry.storageKey)},
          storage_version_id=${q(entry.storageVersionId)},manifest_version_id=${entry.manifestVersionId === null?'NULL':q(entry.manifestVersionId)}
          WHERE id=${q(entry.artifactId)}::uuid AND state<>'DELETED';
        IF NOT FOUND THEN RAISE EXCEPTION 'RESTORE_ARTIFACT_ROW_MISSING'; END IF;
      END $artifact$;`).join('\n');
      const orchSqlFile = path.join(work,'isolate-orchestrator.sql');
      await writeFile(orchSqlFile,`${controlSql}\n${storageSql}\n${artifactSql}\n`,{flag:'wx',mode:0o600});
      await assertExecutionFence(input.execution);
      await runTool(man.tools.psql.path,[`--dbname=service=${man.services.orchestratorRestoreAdmin} dbname=${orchDb}`,'--set=ON_ERROR_STOP=1','--single-transaction',`--file=${orchSqlFile}`],privateEnv(man),60_000,spawnImpl);
      const connectorSqlFile = path.join(work,'isolate-connector.sql');
      const controls = `UPDATE connector_replica_runtime_controls SET control_revision=control_revision+1,control_state='DRAINING',requested_at=now(),acknowledged_at='-infinity',updated_at=now();
        INSERT INTO connector_replica_runtime_controls(replica_id,slot,runtime_identity,revision,image_digest,control_revision,control_state,requested_at,acknowledged_at)
        VALUES(${q(man.isolatedRuntime.connectorReplicaId)},${q(man.isolatedRuntime.connectorSlot)},${q(man.isolatedRuntime.connectorRuntimeIdentity)},
          ${q(man.isolatedRuntime.connectorRevision)},${q(man.isolatedRuntime.connectorImageDigest)},1,'DRAINING',now(),'-infinity');`;
      await writeFile(connectorSqlFile,`${controls}\n`,{flag:'wx',mode:0o600});
      await assertExecutionFence(input.execution);
      await runTool(man.tools.psql.path,[`--dbname=service=${man.services.connectorRestoreAdmin} dbname=${connectorDb}`,'--set=ON_ERROR_STOP=1','--single-transaction',`--file=${connectorSqlFile}`],privateEnv(man),60_000,spawnImpl);
      const expectedCounts = { ...bundle.index.counts,connectorRuntimeControls:bundle.index.counts.connectorRuntimeControls + 1 };
      const reconciled = await reconcile(man,man.services.orchestratorRestoreAdmin,man.services.connectorRestoreAdmin,orchDb,connectorDb,expectedCounts,spawnImpl);
      const secretCatalogReconciled = await reconcileSecretCatalogKeyCounts(man,man.services.orchestratorRestoreAdmin,orchDb,bundle.index.secretCatalogKeyCounts,spawnImpl);
      const manifestCount = artifactIndex.artifacts.length;
      const connectorSecretsReconciled = await reconcileConnectorSecretVersionCount(man,man.services.connectorRestoreAdmin,connectorDb,
        bundle.index.connectorReferencedSecretVersionCount,spawnImpl);
      if (!reconciled || !secretCatalogReconciled || !connectorSecretsReconciled || remapped.length !== manifestCount) throw fail('RESTORE_RECONCILIATION_FAILED');
      await assertExecutionFence(input.execution);
      const runtimeProbe = await options.isolatedRuntimeProbe.run({backupId:input.backupId,orchestratorDatabase:orchDb,connectorDatabase:connectorDb,
        orchestratorClusterName:man.orchestratorRestoreClusterName,connectorClusterName:man.connectorRestoreClusterName,
        targetGenerationId:input.targetGenerationId,sourceRuntimeIdentities:man.sourceRuntimeIdentities,expectedRuntime:man.isolatedRuntime,
        expectedCounts,expectedArtifactTransitKeyPins:bundle.index.artifactTransitKeyPins,
        expectedSecretCatalogRecoveryKeys:bundle.index.secretCatalogRecoveryKeys,expectedSecretCatalogKeyCounts:bundle.index.secretCatalogKeyCounts,
        expectedConnectorInvocationRecoveryKeys:bundle.index.connectorInvocationRecoveryKeys,
        expectedConnectorInvocationKeyCounts:bundle.index.connectorInvocationKeyCounts,
        expectedConnectorCredentialKey:bundle.index.connectorCredentialRecoveryKey,
        expectedConnectorSecretVersionCount:bundle.index.connectorReferencedSecretVersionCount,
        expectedMetadataTransitKeyCounts:bundle.index.metadataTransitKeyCounts,
        expectedVaultCredentialPinDigests:bundle.index.connectorVaultCredentialPinDigests,
        services:{orchestrator:`service=${man.services.orchestratorRestoreAdmin} dbname=${orchDb}`,
          connector:`service=${man.services.connectorRestoreAdmin} dbname=${connectorDb}`},dispatchDisabled:true,providerCallsDisabled:true,usageDeliveryDisabled:true});
      validateProbe(man,bundle.index,runtimeProbe,expectedCounts,bundle.index.artifactTransitKeyPins,
        bundle.index.secretCatalogRecoveryKeys,bundle.index.secretCatalogKeyCounts,bundle.index.connectorInvocationRecoveryKeys,
        bundle.index.connectorInvocationKeyCounts,bundle.index.connectorCredentialRecoveryKey,bundle.index.connectorReferencedSecretVersionCount,
        bundle.index.metadataTransitKeyCounts,bundle.index.connectorVaultCredentialPinDigests);
      const result = { isolated:true as const,dispatchDisabled:true as const,providerCallsDisabled:true as const,checksummed:true as const,
        reconciled:true as const,counts:{artifacts:manifestCount,objects:remapped.length+remapped.filter((entry)=>entry.manifestVersionId!==null).length,
          keys:bundle.index.encryptionKeyVersionRefs.length},targetGenerationId:input.targetGenerationId,cutover:'NOT_PERFORMED' as const,runtimeProbe };
      await rm(work,{recursive:true,force:false});
      workCreated = false;
      try { await lstat(work); throw fail('RESTORE_PLAINTEXT_CLEANUP_UNVERIFIED'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await finishRestoreAttempt(input.backupId,input.targetGenerationId,input.execution,'SUCCEEDED',result);
      attemptClaimed = false;
      return result;
    } catch (error) {
      if (attemptClaimed) await finishRestoreAttempt(input.backupId,input.targetGenerationId,input.execution,'UNKNOWN');
      throw error;
    } finally {
      key.fill(0);
      if (workCreated) {
        await rm(work,{recursive:true,force:false});
        try { await lstat(work); throw fail('RESTORE_PLAINTEXT_CLEANUP_UNVERIFIED'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
  }

  return {
    trusted:true as const,
    async listTargets(): Promise<readonly BackupTarget[]> {
      const man = await manifest();
      const refs = await verifiedTargetRefs(man);
      const pinned = targetVersionProjection(man,options.expectedManifestSha256);
      if (canonical(refs.credentialVersionRefs) !== canonical(pinned.credentialVersionRefs)
        || canonical(refs.encryptionKeyVersionRefs) !== canonical(pinned.encryptionKeyVersionRefs)) {
        throw fail('BACKUP_TARGET_PIN_SET_CHANGED');
      }
      return [{name:pinned.name,descriptionCode:'BACKUP_TARGET_CONFIGURED',kind:pinned.kind,allowlisted:true,immutable:true,
        manifestSha256:pinned.manifestSha256,targetPinDigest:pinned.targetPinDigest,
        credentialVersionRefs:pinned.credentialVersionRefs,encryptionKeyVersionRefs:pinned.encryptionKeyVersionRefs,
        supportedScopes:pinned.supportedScopes}];
    },
    async createBundle(input) {
      const man = await manifest();
      requirePlatform(input.scope);
      if (input.target.name !== 'platform-primary') throw fail('BACKUP_TARGET_NOT_ALLOWLISTED');
      if (input.target.manifestSha256 !== options.expectedManifestSha256
        || input.target.targetPinDigest !== backupTargetPinDigest({ name:input.target.name,kind:input.target.kind,
          manifestSha256:input.target.manifestSha256,credentialVersionRefs:input.target.credentialVersionRefs,
          encryptionKeyVersionRefs:input.target.encryptionKeyVersionRefs })) throw fail('BACKUP_TARGET_PIN_INVALID');
      const refs = await verifiedTargetRefs(man);
      if (canonical(input.target.credentialVersionRefs) !== canonical(refs.credentialVersionRefs)
        || canonical(input.target.encryptionKeyVersionRefs) !== canonical(refs.encryptionKeyVersionRefs)
        || input.target.targetPinDigest !== targetVersionProjection(man,options.expectedManifestSha256).targetPinDigest) throw fail('BACKUP_VERSION_PIN_CHANGED');
      const key = await resolveRecoveryKey(man.backupRecoveryKey,'backup_bundle');
      let fence: Awaited<ReturnType<MaintenanceBackupFence['acquire']>> | null = null;
      const staging = path.join(man.workDirectory,`backup-${input.backupId}-${randomBytes(6).toString('hex')}`);
      const finalDirectory = path.join(man.bundleDirectory,`${input.backupId}.bundle`);
      let stagingCreated = false;
      try {
        fence = await options.backupFence.acquire({backupId:input.backupId,reason:'durable-platform-backup',execution:input.execution});
        assertFenceProof(fence.proof,now());
        await assertExecutionFence(input.execution);
        const fencedRefs = await verifiedTargetRefs(man);
        if (canonical(fencedRefs) !== canonical(refs)) throw fail('BACKUP_VERSION_PIN_CHANGED');
        try { await lstat(finalDirectory); throw fail('BACKUP_ID_ALREADY_EXISTS'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await mkdir(staging,{recursive:false,mode:0o700});
        stagingCreated = true;
        const sourceCluster = await capturePsql(man,man.services.orchestratorSource,"SELECT current_setting('cluster_name',true)",256);
        const connectorCluster = await capturePsql(man,man.services.connectorSource,"SELECT current_setting('cluster_name',true)",256);
        if (sourceCluster !== man.orchestratorSourceClusterName || connectorCluster !== man.connectorSourceClusterName
          || sourceCluster === man.orchestratorRestoreClusterName || connectorCluster === man.connectorRestoreClusterName) throw fail('BACKUP_SOURCE_CLUSTER_IDENTITY_MISMATCH');
        const counts = await sourceCounts(man);
        const components: Component[] = [];
        const artifactIndex = await exportArtifacts(man,input.backupId,staging,key,components);
        if (artifactIndex.count !== counts.readyArtifacts) throw fail('BACKUP_ARTIFACT_COUNT_MISMATCH');
        const capabilitySnapshot = await options.backupArtifactEffects.snapshotOpenCapabilities({
          backupId:input.backupId,artifactPins:artifactIndex.snapshotPins,
        });
        if (capabilitySnapshot.openCapabilities !== capabilitySnapshot.includedExactVersion + capabilitySnapshot.excludedIncomplete) {
          throw fail('BACKUP_CAPABILITY_SNAPSHOT_INCOMPLETE');
        }
        counts.artifactObjectBytes = artifactIndex.artifactObjectBytes;
        counts.artifactManifestBytes = artifactIndex.artifactManifestBytes;
        const orchDump = path.join(staging,'orchestrator.dump');
        const connectorDump = path.join(staging,'connector.dump');
        await runDump(man,man.services.orchestratorSource,orchDump);
        await assertExecutionFence(input.execution);
        await runDump(man,man.services.connectorSource,connectorDump);
        await assertExecutionFence(input.execution);
        const keyId = recoveryKeyPinId(man.backupRecoveryKey);
        for (const name of ['orchestrator.dump','connector.dump','artifact-index.json'] as const) {
          const source = path.join(staging,name);
          await assertExecutionFence(input.execution);
          const output = componentPath(staging,name);
          components.push(await encryptReadable(createReadStream(source),output,key,input.backupId,name,keyId,
            name === 'artifact-index.json' ? Math.min(man.maxBundleBytes,64 * 1024 * 1024) : man.maxBundleBytes));
          await rm(source,{force:true});
        }
        const allowedArtifactRefs = new Set(refs.artifactTransitKeyPins.map(transitKeyPinId));
        const actualEncryptionKeyVersionRefs = [...new Set([
          ...refs.encryptionKeyVersionRefs.filter((value)=>!allowedArtifactRefs.has(value)),
          ...artifactIndex.artifactTransitKeyPins.map(transitKeyPinId),
        ])].sort();
        const index: BundleIndex = { schemaVersion:7,backupId:input.backupId,createdAt:now().toISOString(),backupFenceProof:fence.proof,
          backupRecoveryKey:{keyVersion:man.backupRecoveryKey.keyVersion,fingerprintSha256:man.backupRecoveryKey.fingerprintSha256},
          secretCatalogRecoveryKeys:refs.secretCatalogRecoveryKeys,secretCatalogKeyCounts:refs.secretCatalogKeyCounts,
          connectorCredentialRecoveryKey:refs.connectorCredentialRecoveryKey,
          connectorInvocationRecoveryKeys:refs.connectorInvocationRecoveryKeys,connectorInvocationKeyCounts:refs.connectorInvocationKeyCounts,
          connectorReferencedSecretVersionCount:refs.connectorReferencedSecretVersionCount,
          metadataTransitKeyCounts:refs.metadataTransitKeyCounts,connectorVaultCredentialPinDigests:refs.connectorVaultCredentialPinDigests,
          capabilitySnapshot:{openCapabilities:capabilitySnapshot.openCapabilities,
            includedExactVersion:capabilitySnapshot.includedExactVersion,excludedIncomplete:capabilitySnapshot.excludedIncomplete,
            evidenceSha256:capabilitySnapshot.evidenceSha256},
          snapshotArtifactCount:artifactIndex.count,
          sourceClusterNames:{orchestrator:sourceCluster,connector:connectorCluster},components,counts,
          credentialVersionRefs:refs.credentialVersionRefs,credentialVersionPins:refs.credentialVersionPins,
          encryptionKeyVersionRefs:actualEncryptionKeyVersionRefs,artifactTransitKeyPins:artifactIndex.artifactTransitKeyPins };
        const manifestBytes = Buffer.from(canonical(index),'utf8');
        const manifestFile = path.join(staging,'manifest.json');
        await writeFile(manifestFile,manifestBytes,{flag:'wx',mode:0o400});
        const total = (await Promise.all(components.map(async (entry) => (await stat(componentPath(staging,entry.name))).size))).reduce((sum,value)=>sum+value,manifestBytes.length);
        if (total > man.maxBundleBytes) throw fail('BACKUP_BUNDLE_TOO_LARGE');
        const bundleSha = sha(manifestBytes);
        for (const component of components) await chmod(componentPath(staging,component.name),0o400);
        await chmod(staging,0o500);
        await assertExecutionFence(input.execution);
        await rename(staging,finalDirectory);
        stagingCreated = false;
        await fsyncDirectory(man.bundleDirectory);
        return {bundleRef:finalDirectory,sha256:bundleSha,byteSize:total,immutable:true as const,verified:true as const,
          credentialVersionRefs:refs.credentialVersionRefs,encryptionKeyVersionRefs:actualEncryptionKeyVersionRefs,
          manifest:{schemaVersion:7,sourceClusterNames:index.sourceClusterNames,createdAt:index.createdAt,counts,componentCount:components.length,bundleSha256:bundleSha}};
      } finally {
        try {
          if (fence) await options.backupFence.release({backupId:input.backupId,fenceId:fence.fenceId,
            fenceRevision:fence.fenceRevision,execution:input.execution,restorePriorState:true});
        } finally {
          key.fill(0);
          if (stagingCreated) {
            await chmod(staging,0o700).catch(()=>undefined);
            await rm(staging,{recursive:true,force:true});
            try { await lstat(staging); throw fail('BACKUP_PRIVATE_WORK_CLEANUP_UNVERIFIED'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
        }
      }
    },
    restoreBundle,
  };
}

function assertFenceProof(proof: MaintenanceBackupFenceProof, now: Date): void {
  const observed = Date.parse(proof.observedAt);
  const evidence = proof.evidence;
  const evidenceDigest = evidence ? digest(evidence) : '';
  const replicaKeys = evidence?.replicaObservations?.map((row) => `${row.service}:${row.slot}`) ?? [];
  const connectorFenceValid = evidence?.connectorFences?.length === 2
    && evidence.connectorFences.every((entry) => entry.fence.state === 'HELD'
      && entry.fence.fenceId === evidence.fenceId
      && entry.fence.fenceRevision === evidence.fenceRevision
      && entry.fence.acknowledgedAt !== null
      && entry.work.processActiveInvocations === 0
      && entry.work.processActivePolls === 0
      && entry.work.processActiveUsageSends === 0
      && entry.work.effectPermits.prepared === 0
      && entry.work.effectPermits.active === 0
      && entry.work.effectPermits.settling === 0
      && entry.work.effectPermits.unknown === 0
      && entry.work.unknownUsageDeliveries === 0
      && entry.work.unclosedEffectPermits === 0);
  const artifact = evidence?.artifactEffects;
  const artifactDurableWork = artifact
    ? artifact.preparedEffects + artifact.activeEffects + artifact.settlingEffects
    : Number.NaN;
  if (!Number.isFinite(observed) || observed > now.getTime() + 1_000 || now.getTime() - observed > 10_000
    || !evidence || !/^[0-9a-f-]{36}$/i.test(evidence.fenceId)
    || !Number.isSafeInteger(evidence.fenceRevision) || evidence.fenceRevision < 1
    || !evidence.execution?.jobId || !evidence.execution?.itemId || !evidence.execution?.ownerRuntimeIdentity
    || !evidence.execution?.ownerBootId || !Number.isSafeInteger(evidence.execution?.executionFence)
    || !/^[a-f0-9]{64}$/.test(evidence.execution?.executionTokenSha256 ?? '')
    || proof.evidenceSha256 !== evidenceDigest
    || replicaKeys.length !== 6 || new Set(replicaKeys).size !== 6
    || !connectorFenceValid
    || !artifact || artifact.processActiveEffects !== 0 || artifactDurableWork !== 0
    || artifact.unknownEffects !== 0 || artifact.unclosedEffects !== 0
    || !Number.isSafeInteger(artifact.unresolvedCapabilities) || artifact.unresolvedCapabilities < 0
    || proof.admission.fenced !== true || proof.admission.inFlight !== 0
    || proof.orchestratorDispatch.fenced !== true || proof.orchestratorDispatch.inFlight !== 0
    || proof.providerIssuance.fenced !== true || proof.providerIssuance.inFlight !== 0
    || proof.connectorInvocationPolling.fenced !== true || proof.connectorInvocationPolling.inFlight !== 0
    || proof.artifactMutation.fenced !== true || proof.artifactMutation.inFlight !== 0
    || proof.connectorUsageDelivery.fenced !== true || proof.connectorUsageDelivery.inFlight !== 0) {
    throw fail('BACKUP_FENCE_NOT_QUIESCENT');
  }
}

async function makeStorageRestoreSql(db: Db, generationId: string): Promise<string> {
  const result = await db.query<StorageRow>(
    `SELECT generation_id,revision,backend,endpoint,bucket,region,force_path_style,credential_version_ref,credential_owner_tenant_id,url_ttl_seconds,state
       FROM storage_generations WHERE generation_id=$1`,[generationId],
  );
  const row = result.rows[0];
  if (!row || row.state !== 'STAGED' || row.backend !== 's3' || !row.credential_version_ref || !row.credential_owner_tenant_id) throw fail('RESTORE_TARGET_NOT_ISOLATED');
  const urlTtl = row.url_ttl_seconds === null ? 'NULL' : String(Number(row.url_ttl_seconds));
  return `DO $restore$
DECLARE
  selected_generation uuid;
  selected_revision bigint;
BEGIN
  SELECT generation_id,revision INTO selected_generation,selected_revision FROM storage_generations
    WHERE generation_id=${q(generationId)}::uuid FOR UPDATE;
  IF FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM storage_generations WHERE generation_id=selected_generation AND state='STAGED'
      AND backend='s3' AND endpoint=${q(row.endpoint)} AND bucket=${q(row.bucket)} AND region=${q(row.region)}
      AND force_path_style=${row.force_path_style} AND credential_version_ref=${q(row.credential_version_ref)}
      AND credential_owner_tenant_id=${q(row.credential_owner_tenant_id)}::uuid
      AND url_ttl_seconds IS NOT DISTINCT FROM ${urlTtl}) THEN
      RAISE EXCEPTION 'RESTORE_STORAGE_GENERATION_CAS_FAILED';
    END IF;
  ELSE
    SELECT COALESCE(MAX(revision),0)+1 INTO selected_revision FROM storage_generations;
    INSERT INTO storage_generations(generation_id,revision,backend,endpoint,bucket,region,force_path_style,credential_version_ref,credential_owner_tenant_id,url_ttl_seconds,state,created_by)
    VALUES(${q(generationId)}::uuid,selected_revision,'s3',${q(row.endpoint)},${q(row.bucket)},${q(row.region)},${row.force_path_style},${q(row.credential_version_ref)},${q(row.credential_owner_tenant_id)}::uuid,${urlTtl},'STAGED','maintenance-isolated-restore')
    RETURNING generation_id INTO selected_generation;
  END IF;
  UPDATE storage_generations SET state='RETIRED' WHERE state='ACTIVE' AND generation_id<>selected_generation;
  UPDATE storage_generations SET state='ACTIVE',activated_at=now() WHERE generation_id=selected_generation AND state='STAGED';
  IF NOT FOUND THEN RAISE EXCEPTION 'RESTORE_STORAGE_GENERATION_ACTIVATION_FAILED'; END IF;
  UPDATE storage_generation_state SET active_generation_id=selected_generation,revision=revision+1,updated_at=now() WHERE singleton=true;
  IF NOT FOUND THEN RAISE EXCEPTION 'RESTORE_STORAGE_POINTER_MISSING'; END IF;
END $restore$;`;
}

async function reconcile(man: Manifest, orchestratorService: string, connectorService: string, orchestratorDb: string, connectorDb: string, expected: BundleIndex['counts'], spawnImpl: typeof spawn): Promise<boolean> {
  const orch = (await captureTool(man,`service=${orchestratorService} dbname=${orchestratorDb}`,
    `SELECT (SELECT count(*) FROM operations)::bigint,(SELECT count(*) FROM artifacts WHERE state<>'DELETED')::bigint,
      (SELECT count(*) FROM artifacts WHERE state='READY')::bigint,
      (SELECT count(*) FROM secret_catalog_revisions)::bigint,(SELECT count(*) FROM storage_generations)::bigint,
      (SELECT count(*) FROM global_settings_tenant_revisions)::bigint,(SELECT count(*) FROM secret_catalog_imports)::bigint,
      (SELECT count(*) FROM connector_secret_imports)::bigint,(SELECT count(*) FROM global_settings_retention_revisions)::bigint,
      (SELECT count(*) FROM cost_budget_revisions)::bigint,(SELECT count(*) FROM cost_price_revisions)::bigint,
      (SELECT count(*) FROM cost_reservation_groups)::bigint,(SELECT count(*) FROM cost_budget_holds)::bigint,
      (SELECT count(*) FROM usage_financial_adjustments)::bigint,
      (SELECT count(*) FROM usage_financial_adjustment_heads)::bigint,
      (SELECT count(*) FROM usage_financial_adjustment_commands)::bigint`,spawnImpl)).split('|').map(Number);
  const conn = (await captureTool(man,`service=${connectorService} dbname=${connectorDb}`,
    `SELECT (SELECT count(*) FROM connector_invocations)::bigint,(SELECT count(*) FROM connector_usage_outbox)::bigint,
      (SELECT count(*) FROM secret_versions)::bigint,(SELECT count(*) FROM connector_revisions)::bigint,
      (SELECT count(*) FROM connector_replica_runtime_controls)::bigint,(SELECT count(*) FROM connector_parity_chains)::bigint,
      (SELECT count(*) FROM connector_parity_revisions)::bigint,(SELECT count(*) FROM connector_parity_claim_intents)::bigint,
      (SELECT count(*) FROM connector_parity_draft_intents)::bigint`,spawnImpl)).split('|').map(Number);
  const expectedOrchestrator = [expected.operations,expected.artifacts,expected.readyArtifacts,expected.secretRevisions,expected.storageGenerations,
    expected.globalSettingsRevisions,expected.secretCatalogImports,expected.connectorSecretImports,expected.retentionRevisions,expected.budgetRevisions,expected.priceRevisions,
    expected.reservationGroups,expected.budgetHolds,expected.financialAdjustments,
    expected.financialAdjustmentHeads,expected.financialAdjustmentCommands];
  const expectedConnector = [expected.connectorInvocations,expected.connectorUsageEvents,expected.connectorSecretVersions,
    expected.connectorRevisions,expected.connectorRuntimeControls,expected.connectorParityChains,expected.connectorParityRevisions,
    expected.connectorParityClaimIntents,expected.connectorParityDraftIntents];
  return orch.length === expectedOrchestrator.length && conn.length === expectedConnector.length
    && orch.every((value,index) => Number.isSafeInteger(value) && value === expectedOrchestrator[index])
    && conn.every((value,index) => Number.isSafeInteger(value) && value === expectedConnector[index]);
}

async function reconcileConnectorSecretVersionCount(man:Manifest,service:string,database:string,
  expected:number,spawnImpl:typeof spawn):Promise<boolean> {
  const value = await captureTool(man,`service=${service} dbname=${database}`,
    `WITH credential_refs AS (
       SELECT credential_ref FROM connector_revisions
       UNION SELECT credential_ref FROM connector_parity_revisions WHERE credential_source->>'kind'='legacy-db'
       UNION SELECT credential_ref FROM connector_parity_draft_intents WHERE credential_source->>'kind'='legacy-db'
     ) SELECT count(*)::bigint FROM secret_versions versioned
        WHERE EXISTS (SELECT 1 FROM credential_refs refs WHERE refs.credential_ref=versioned.credential_ref)`,spawnImpl);
  const actual = Number(value);
  return Number.isSafeInteger(actual) && actual === expected;
}

async function reconcileSecretCatalogKeyCounts(man:Manifest,service:string,database:string,
  expected:readonly SecretCatalogKeyCount[],spawnImpl:typeof spawn):Promise<boolean> {
  const raw = await captureTool(man,`service=${service} dbname=${database}`,
    `SELECT key_version,sum(revision_count)::bigint,sum(current_secret_count)::bigint FROM (
       SELECT encryption_key_version AS key_version,count(*)::bigint AS revision_count,0::bigint AS current_secret_count
         FROM secret_catalog_revisions WHERE encrypted_value IS NOT NULL GROUP BY encryption_key_version
       UNION ALL
       SELECT encryption_key_version AS key_version,0::bigint AS revision_count,count(*)::bigint AS current_secret_count
         FROM secret_catalog WHERE encrypted_value IS NOT NULL GROUP BY encryption_key_version
     ) AS encrypted_secret_rows GROUP BY key_version ORDER BY key_version`,spawnImpl);
  const actual = raw ? raw.split('\n').map((line)=>{
    const [keyVersion,revisionText,currentText] = line.split('|');
    return {keyVersion,revisionCount:Number(revisionText),currentSecretCount:Number(currentText)};
  }) : [];
  if (actual.some((item)=>!item.keyVersion || !Number.isSafeInteger(item.revisionCount) || item.revisionCount < 0
    || !Number.isSafeInteger(item.currentSecretCount) || item.currentSecretCount < 0)) return false;
  const expectedNonzero = expected.filter((item)=>item.revisionCount > 0 || item.currentSecretCount > 0)
    .slice().sort((a,b)=>a.keyVersion.localeCompare(b.keyVersion));
  actual.sort((a,b)=>a.keyVersion!.localeCompare(b.keyVersion!));
  return canonical(actual) === canonical(expectedNonzero);
}

async function captureTool(man: Manifest, connection: string, sql: string, spawnImpl: typeof spawn): Promise<string> {
  const out = path.join(man.workDirectory,`verify-${randomBytes(8).toString('hex')}.txt`);
  await runTool(man.tools.psql.path,[`--dbname=${connection}`,'--set=ON_ERROR_STOP=1','--tuples-only','--no-align','--field-separator=|',`--output=${out}`,`--command=${sql}`],
    { PATH:'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',HOME:man.workDirectory,PGSERVICEFILE:man.libpqServiceFile.path,PGPASSFILE:man.passfile.path,LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'UTC',NO_COLOR:'1',PGCONNECT_TIMEOUT:'10' },30_000,spawnImpl);
  try { const bytes = await readFile(out); if (bytes.length > 4096) throw fail('RESTORE_RECONCILIATION_OUTPUT_INVALID'); return bytes.toString('utf8').trim(); }
  finally { await rm(out,{force:true}); }
}
