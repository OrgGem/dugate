import { createHash } from 'node:crypto';
import type {
  IsolatedRestoreRuntimeProbe,
  IsolatedRestoreRuntimeProbeResult,
} from './trusted-backup-adapter';

type ProbeInput = Parameters<IsolatedRestoreRuntimeProbe['run']>[0];
type ProbeResult = Awaited<ReturnType<IsolatedRestoreRuntimeProbe['run']>>;
type ProbeRuntime = ProbeInput['expectedRuntime'];
type ExpectedCounts = ProbeInput['expectedCounts'];

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
const SAFE_KEY_REF = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const DB_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/;
const IMAGE_DIGEST = /^.+@sha256:[a-f0-9]{64}$/i;
const MAX_RUNTIME_MS = 60 * 60 * 1000;
const DEFAULT_RUNTIME_MS = 15 * 60 * 1000;
const DEFAULT_MAX_EVIDENCE_ROWS = 250_000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const MAX_FINAL_EVIDENCE_BYTES = 2 * 1024 * 1024;
const STREAM_CLOSE_TIMEOUT_MS = 5_000;
const OWNED_STOP_TIMEOUT_MS = 30_000;

export type RestoreRuntimeKind = 'orchestrator' | 'connector';
export type RestoreSourceRef =
  | 'orchestratorSourceDb'
  | 'connectorSourceDb'
  | 'sourceCatalogKeyring'
  | 'sourceConnectorRecoveryRegistry'
  | 'sourceMetadataTransit'
  | 'sourceArtifactTransit'
  | 'sourceVault';

export type DisabledExternalEffect =
  | 'admission'
  | 'dispatch'
  | 'providerInvocation'
  | 'connectorPoll'
  | 'usageDelivery'
  | 'webhookDelivery'
  | 'alertEmission'
  | 'cleanup'
  | 'historicalMaintenance'
  | 'migrations';

export type RestoreExternalEffectState = 'DISABLED' | 'ENABLED' | 'UNKNOWN';

/** A parsed libpq service/database pair. Passwords, URLs and arbitrary conninfo
 * options are deliberately not represented by this probe contract. */
export interface RestoreDatabaseIdentity {
  serviceName: string;
  databaseName: string;
}

export interface RestoreRuntimeLaunchPlan {
  kind: RestoreRuntimeKind;
  clusterName: string;
  runtimeIdentity: string;
  revision: string;
  imageDigest: string;
  replicaId?: string;
  slot?: 'blue' | 'green';
  database: RestoreDatabaseIdentity;
  targetGenerationId: string;
  sourceRuntimeIdentities: readonly string[];
  /** Must be installed before the first listener starts. */
  externalEffects: Readonly<Record<DisabledExternalEffect, 'DISABLED'>>;
  /** The launcher applies this in the target network namespace before start. */
  network: {
    defaultEgress: 'DENY';
    blockedSourceRefs: readonly RestoreSourceRef[];
    allowedPurposes: readonly ['isolatedDatabases', 'targetArtifactGeneration', 'independentRecoveryReaders', 'localHealth'];
  };
}

/** Opaque ownership handle returned only after the exact target process starts. */
export interface OwnedRestoreRuntimeHandle {
  kind: RestoreRuntimeKind;
  handleId: string;
}

export interface RestoreRuntimeLaunchPort {
  /** Must create the pinned process/image with the supplied safety profile in
   * place before it binds any listener. It may not use a source or serving slot. */
  start(plan: RestoreRuntimeLaunchPlan, input: { signal: AbortSignal }): Promise<OwnedRestoreRuntimeHandle>;
  /** Stops only the exact returned handle and waits until that process is gone. */
  stopAndWait(handle: OwnedRestoreRuntimeHandle, input: { signal: AbortSignal }): Promise<void>;
}

export interface RuntimeControlAcknowledgement {
  state: 'DRAINING' | 'OPEN' | 'PAUSED' | 'UNKNOWN';
  revision: number;
  acknowledgedAt: string | null;
  bootId: string;
}

export interface RuntimeHealthObservation {
  observedAt: string;
  workObservedAt: string;
  /** Serving readiness is expected to be DRAINING during restore rehearsal. */
  readiness: 'DRAINING' | 'NOT_READY' | 'UNKNOWN';
  liveness: 'LIVE' | 'NOT_LIVE' | 'UNKNOWN';
  livenessObservedAt: string;
  dependencies: {
    postgres: { state: 'HEALTHY' | 'UNAVAILABLE' | 'UNKNOWN'; observedAt: string };
    redis: { state: 'HEALTHY' | 'UNAVAILABLE' | 'UNKNOWN'; observedAt: string };
  };
  clusterName: string;
  runtimeIdentity: string;
  revision: string;
  imageDigest: string;
  bootId: string;
  control: RuntimeControlAcknowledgement;
  externalEffects: Readonly<Record<DisabledExternalEffect, RestoreExternalEffectState>>;
  work: {
    activeRequests?: number;
    activeDispatches?: number;
    maintenanceExecutions?: number;
    processActiveInvocations?: number;
    processActivePolls?: number;
    processActiveUsageSends?: number;
    unresolvedInvocationHolds?: number;
    /** Present on Connector observations; UNKNOWN is retained history. */
    effectPermits?: {
      prepared: number;
      active: number;
      settling: number;
      unknown: number;
    };
    /** Aggregate persisted by Connector, including UNKNOWN history. */
    unclosedEffectPermits?: number;
    unknownUsageDeliveries?: number;
  };
  replicaId?: string;
  slot?: 'blue' | 'green';
}

export interface DatabaseControlObservation {
  observedAt: string;
  clusterName: string;
  desiredState: 'DRAINING' | 'OPEN' | 'PAUSED' | 'UNKNOWN';
  revision: number;
  acknowledgedState: 'DRAINING' | 'OPEN' | 'PAUSED' | 'UNKNOWN';
  acknowledgedRevision: number;
  acknowledgedAt: string | null;
  acknowledgedBootId: string;
}

export interface RestoreRuntimeHealthPort {
  /** Reads the live local listener associated with this owned process handle. */
  observeOrchestrator(handle: OwnedRestoreRuntimeHandle, input: { signal: AbortSignal }): Promise<RuntimeHealthObservation>;
  /** Reads the live local listener associated with this owned process handle. */
  observeConnector(handle: OwnedRestoreRuntimeHandle, input: { signal: AbortSignal }): Promise<RuntimeHealthObservation>;
}

export interface RestoreDatabaseControlPort {
  /** Reads the restored control row through the named protected libpq service. */
  readOrchestrator(database: RestoreDatabaseIdentity, input: { signal: AbortSignal }): Promise<DatabaseControlObservation>;
  /** Reads the restored replica control row through the named protected libpq service. */
  readConnector(database: RestoreDatabaseIdentity, input: { signal: AbortSignal }): Promise<DatabaseControlObservation>;
}

export interface SourceIsolationObservation {
  observedAt: string;
  contextRuntimeIdentity: string;
  contextBootId: string;
  destinationRef: RestoreSourceRef;
  /** A completed network-layer denial/failed connection, never an HTTP status. */
  outcome: 'BLOCKED_BY_POLICY' | 'CONNECTION_REFUSED' | 'NO_ROUTE' | 'TIMED_OUT' | 'DNS_DENIED'
    | 'CONNECTED' | 'HTTP_RESPONSE' | 'UNKNOWN';
  responseStatus: number | null;
  networkPolicyState: 'ENFORCED' | 'NOT_ENFORCED' | 'UNKNOWN';
  networkPolicyRevision: string;
}

export interface RestoreSourceIsolationPort {
  /** Must execute from the exact isolated runtime network namespace, against a
   * protected endpoint pin. It cannot stop or modify source services. */
  probeFromRuntime(
    handle: OwnedRestoreRuntimeHandle,
    destinationRef: RestoreSourceRef,
    input: { signal: AbortSignal },
  ): Promise<SourceIsolationObservation>;
}

export interface DatabaseCountsObservation {
  observedAt: string;
  counts: ExpectedCounts;
}

export interface ApplicationRestoreObservation {
  observedAt: string;
  login: {
    statusCode: number;
    authenticatedPrincipalSha256: string;
  };
  history: {
    statusCode: number;
    totalRecords: number;
    returnedRecords: readonly {
      operationIdSha256: string;
      state: string;
      hasResult: boolean;
      resultSha256: string | null;
    }[];
  };
}

export interface RestoreArtifactRecoveryItem {
  artifactId: string;
  tenantId: string;
  uploadToken: string;
  /** Digest of the owning operation's API-key ID; the key itself is never
   * returned from the recovery reader. */
  apiKeyIdSha256: string;
  storageGenerationId: string;
  storageVersionId: string;
  manifestVersionId: string | null;
  keyRef: string;
  keyVersion: number;
  contentType: string;
  ciphertextSha256: string;
  ciphertextByteSize: number;
  plaintextSha256: string;
  plaintextByteSize: number;
  sidecarCiphertextSha256: string | null;
  sidecarPlaintextSha256: string | null;
}

export interface RestoreSecretCatalogRecoveryItem {
  recordIdSha256: string;
  keyVersion: string;
  recordKind: 'revision' | 'currentSecret';
  ciphertextSha256: string;
  plaintextSha256: string;
}

export interface RestoreConnectorInvocationRecoveryItem {
  envelopeIdSha256: string;
  keyRef: string;
  keyVersion: number;
  ciphertextSha256: string;
  plaintextSha256: string;
}

export interface RestoreConnectorCredentialRecoveryItem {
  secretVersionIdSha256: string;
  keyVersion: string;
  ciphertextSha256: string;
  plaintextSha256: string;
}

export interface RestoreMetadataTransitRecoveryItem {
  envelopeIdSha256: string;
  keyRef: string;
  keyVersion: number;
  ciphertextSha256: string;
  plaintextSha256: string;
}

export interface RestoreVaultCredentialReadItem {
  observedAt: string;
  pinSha256: string;
  requestedVersion: number;
  observedVersion: number;
  valueSha256: string;
}

export interface RecoveryKeyObservation {
  keyRef?: string;
  keyVersion: string | number;
  fingerprintSha256: string;
  registryIdentity: string;
  observedAt: string;
}

export interface RecoveryObservation<TItem> {
  key: RecoveryKeyObservation;
  /** Items are yielded only after exact-version retrieval and authenticated
   * open/read succeeds. The helper derives every count from this stream. */
  items: AsyncIterable<TItem> | Iterable<TItem>;
}

export interface RestoreRecoveryReaderPort {
  /** The reader is independently pinned and must reject restored/source keyrings. */
  recoverArtifactTransitKey(input: {
    database: RestoreDatabaseIdentity;
    targetGenerationId: string;
    pin: { keyRef: string; keyVersion: number };
    signal: AbortSignal;
  }): Promise<RecoveryObservation<RestoreArtifactRecoveryItem>>;
  recoverSecretCatalogKey(input: {
    database: RestoreDatabaseIdentity;
    pin: { keyVersion: string; fingerprintSha256: string };
    signal: AbortSignal;
  }): Promise<RecoveryObservation<RestoreSecretCatalogRecoveryItem>>;
  recoverConnectorInvocationKey(input: {
    database: RestoreDatabaseIdentity;
    pin: { keyRef: string; keyVersion: number; fingerprintSha256: string };
    signal: AbortSignal;
  }): Promise<RecoveryObservation<RestoreConnectorInvocationRecoveryItem>>;
  recoverConnectorCredentialKey(input: {
    database: RestoreDatabaseIdentity;
    pin: { keyVersion: string; fingerprintSha256: string };
    signal: AbortSignal;
  }): Promise<RecoveryObservation<RestoreConnectorCredentialRecoveryItem>>;
  recoverMetadataTransitKey(input: {
    database: RestoreDatabaseIdentity;
    pin: { keyRef: string; keyVersion: number };
    signal: AbortSignal;
  }): Promise<RecoveryObservation<RestoreMetadataTransitRecoveryItem>>;
  /** Reads the pinned KV2 version through the independently configured Vault reader. */
  readVaultCredential(input: {
    pinSha256: string;
    signal: AbortSignal;
  }): Promise<RestoreVaultCredentialReadItem>;
}

export interface RestoreArtifactDownloadObservation {
  statusCode: number;
  storageGenerationId: string;
  storageVersionId: string;
  manifestVersionId: string | null;
  contentType: string;
  body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}

export interface RestoreApplicationReaderPort {
  /** Performs a real login using a pre-provisioned protected verification
   * identity and reads history from the newly launched local application. It
   * must not create/reset users or return a cookie, password or raw user ID. */
  exerciseLoginAndHistory(
    handle: OwnedRestoreRuntimeHandle,
    input: { database: RestoreDatabaseIdentity; expectedOperationCount: number; signal: AbortSignal },
  ): Promise<ApplicationRestoreObservation>;
  /** Selects one already authenticated artifact row whose owner matches the
   * protected verification API key. The implementation must re-read and
   * verify that relationship from the restored database. */
  selectArtifactForDownload(
    handle: OwnedRestoreRuntimeHandle,
    items: readonly RestoreArtifactRecoveryItem[],
    input: { signal: AbortSignal },
  ): Promise<RestoreArtifactRecoveryItem>;
  /** Downloads through the newly launched application, using the exact pinned
   * artifact row selected by authenticated recovery. */
  downloadArtifact(
    handle: OwnedRestoreRuntimeHandle,
    input: {
      artifact: RestoreArtifactRecoveryItem;
      targetGenerationId: string;
      signal: AbortSignal;
    },
  ): Promise<RestoreArtifactDownloadObservation>;
}

export interface RestoreDatabaseReaderPort {
  /** Counts are queried from the restored databases; expected bundle counts
   * are only a comparison, never copied into the result as observations. */
  readCounts(input: {
    orchestrator: RestoreDatabaseIdentity;
    connector: RestoreDatabaseIdentity;
    targetGenerationId: string;
    signal: AbortSignal;
  }): Promise<DatabaseCountsObservation>;
}

export interface TrustedIsolatedRestoreProbeOptions {
  launch: RestoreRuntimeLaunchPort;
  health: RestoreRuntimeHealthPort;
  control: RestoreDatabaseControlPort;
  sourceIsolation: RestoreSourceIsolationPort;
  databaseReader: RestoreDatabaseReaderPort;
  applicationReader: RestoreApplicationReaderPort;
  recoveryReader: RestoreRecoveryReaderPort;
  /** Bound the complete owned runtime and observation lifecycle. */
  maxRuntimeMs?: number;
  /** Bounds the number of rows authenticated by any one key-family reader. */
  maxEvidenceRows?: number;
  /** Bounds the application-level download stream. */
  maxDownloadBytes?: number;
  now?: () => Date;
}

interface SanitizedEvidence {
  sha256: string;
  count: number;
}

interface ProcessResult {
  health: RuntimeHealthObservation;
  control: DatabaseControlObservation;
}

const SOURCE_REFS: readonly RestoreSourceRef[] = [
  'orchestratorSourceDb',
  'connectorSourceDb',
  'sourceCatalogKeyring',
  'sourceConnectorRecoveryRegistry',
  'sourceMetadataTransit',
  'sourceArtifactTransit',
  'sourceVault',
];

const EFFECTS: readonly DisabledExternalEffect[] = [
  'admission', 'dispatch', 'providerInvocation', 'connectorPoll', 'usageDelivery',
  'webhookDelivery', 'alertEmission', 'cleanup', 'historicalMaintenance', 'migrations',
];

function fail(code: string): Error {
  return new Error(code);
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw fail('RESTORE_RUNTIME_PROBE_EVIDENCE_INVALID');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (!isRecord(value)) throw fail('RESTORE_RUNTIME_PROBE_EVIDENCE_INVALID');
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

function checkedCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function checkedRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function checkedFresh(value: unknown, nowMs: number): value is string {
  if (typeof value !== 'string') return false;
  const observed = Date.parse(value);
  return Number.isFinite(observed) && observed <= nowMs + 1000 && nowMs - observed <= 60_000;
}

function checkedUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validateCounts(value: unknown): value is ExpectedCounts {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length >= 10 && keys.every((key) => SAFE_ID.test(key) && checkedCount(value[key]));
}

function sameJson(left: unknown, right: unknown): boolean {
  try { return canonical(left) === canonical(right); } catch { return false; }
}

function parseDatabaseIdentity(conninfo: string, expectedDatabaseName: string): RestoreDatabaseIdentity {
  if (typeof conninfo !== 'string' || conninfo.length > 256 || !DB_NAME.test(expectedDatabaseName)) {
    throw fail('RESTORE_RUNTIME_PROBE_DATABASE_IDENTITY_INVALID');
  }
  // The adapter passes `service=<name> dbname=<name>`, never a URL. Restrict
  // this further so no credential/host/port can enter child args or readers.
  const match = /^service=([A-Za-z0-9][A-Za-z0-9_.:-]{0,95}) dbname=([A-Za-z0-9_][A-Za-z0-9_-]{0,62})$/.exec(conninfo);
  const serviceName = match?.[1];
  const databaseName = match?.[2];
  if (!serviceName || !databaseName || databaseName !== expectedDatabaseName) {
    throw fail('RESTORE_RUNTIME_PROBE_DATABASE_IDENTITY_INVALID');
  }
  return { serviceName, databaseName };
}

function validateInput(input: ProbeInput): { orchestrator: RestoreDatabaseIdentity; connector: RestoreDatabaseIdentity } {
  if (!isRecord(input) || !SAFE_ID.test(input.backupId) || !checkedUuid(input.targetGenerationId)
    || !DB_NAME.test(input.orchestratorDatabase) || !DB_NAME.test(input.connectorDatabase)
    || !SAFE_ID.test(input.orchestratorClusterName) || !SAFE_ID.test(input.connectorClusterName)
    || !validateCounts(input.expectedCounts) || input.dispatchDisabled !== true
    || input.providerCallsDisabled !== true || input.usageDeliveryDisabled !== true
    || !Array.isArray(input.sourceRuntimeIdentities) || input.sourceRuntimeIdentities.length < 2
    || input.sourceRuntimeIdentities.length > 8 || input.sourceRuntimeIdentities.some((id) => typeof id !== 'string' || !SAFE_ID.test(id))
    || new Set(input.sourceRuntimeIdentities).size !== input.sourceRuntimeIdentities.length) {
    throw fail('RESTORE_RUNTIME_PROBE_INPUT_INVALID');
  }
  const runtime = input.expectedRuntime;
  if (!isRecord(runtime) || !SAFE_ID.test(runtime.orchestratorRuntimeIdentity) || !SAFE_ID.test(runtime.orchestratorRevision)
    || typeof runtime.orchestratorImageDigest !== 'string' || !IMAGE_DIGEST.test(runtime.orchestratorImageDigest)
    || (runtime.orchestratorSlot !== 'blue' && runtime.orchestratorSlot !== 'green')
    || !SAFE_ID.test(runtime.connectorRuntimeIdentity) || !SAFE_ID.test(runtime.connectorReplicaId)
    || (runtime.connectorSlot !== 'blue' && runtime.connectorSlot !== 'green')
    || !SAFE_ID.test(runtime.connectorRevision) || typeof runtime.connectorImageDigest !== 'string'
    || !IMAGE_DIGEST.test(runtime.connectorImageDigest)
    || runtime.orchestratorRuntimeIdentity === runtime.connectorRuntimeIdentity
    || input.sourceRuntimeIdentities.includes(runtime.orchestratorRuntimeIdentity)
    || input.sourceRuntimeIdentities.includes(runtime.connectorRuntimeIdentity)) {
    throw fail('RESTORE_RUNTIME_PROBE_RUNTIME_PIN_INVALID');
  }
  const transitPins = input.expectedArtifactTransitKeyPins;
  const catalogPins = input.expectedSecretCatalogRecoveryKeys;
  const catalogCounts = input.expectedSecretCatalogKeyCounts;
  const invocationPins = input.expectedConnectorInvocationRecoveryKeys;
  const invocationCounts = input.expectedConnectorInvocationKeyCounts;
  const metadataCounts = input.expectedMetadataTransitKeyCounts;
  const vaultPins = input.expectedVaultCredentialPinDigests;
  if (!Array.isArray(transitPins) || !Array.isArray(catalogPins) || !Array.isArray(catalogCounts)
    || !Array.isArray(invocationPins) || !Array.isArray(invocationCounts) || !Array.isArray(metadataCounts)
    || !Array.isArray(vaultPins) || !isRecord(input.expectedConnectorCredentialKey)
    || !isRecord(input.services) || typeof input.services.orchestrator !== 'string' || typeof input.services.connector !== 'string'
    || !SAFE_ID.test(input.expectedConnectorCredentialKey.keyVersion)
    || typeof input.expectedConnectorCredentialKey.fingerprintSha256 !== 'string'
    || !SHA256.test(input.expectedConnectorCredentialKey.fingerprintSha256)
    || !checkedCount(input.expectedConnectorSecretVersionCount)) {
    throw fail('RESTORE_RUNTIME_PROBE_RECOVERY_PINS_INVALID');
  }
  const requireUnique = (ids: string[]) => ids.every((id) => typeof id === 'string') && new Set(ids).size === ids.length;
  const transitIds = transitPins.map((pin) => `${pin.keyRef}@${pin.keyVersion}`);
  const catalogIds = catalogPins.map((pin) => pin.keyVersion);
  const catalogCountIds = catalogCounts.map((pin) => pin.keyVersion);
  const invocationIds = invocationPins.map((pin) => `${pin.keyRef}@${pin.keyVersion}`);
  const invocationCountIds = invocationCounts.map((pin) => `${pin.keyRef}@${pin.keyVersion}`);
  const metadataIds = metadataCounts.map((pin) => `${pin.keyRef}@${pin.keyVersion}`);
  if (!transitPins.every((pin) => typeof pin.keyRef === 'string' && SAFE_KEY_REF.test(pin.keyRef) && checkedCount(pin.keyVersion) && pin.keyVersion > 0)
    || !catalogPins.every((pin) => typeof pin.keyVersion === 'string' && SAFE_ID.test(pin.keyVersion) && SHA256.test(pin.fingerprintSha256))
    || !catalogCounts.every((pin) => typeof pin.keyVersion === 'string' && SAFE_ID.test(pin.keyVersion) && checkedCount(pin.revisionCount) && checkedCount(pin.currentSecretCount))
    || !invocationPins.every((pin) => typeof pin.keyRef === 'string' && SAFE_KEY_REF.test(pin.keyRef) && checkedCount(pin.keyVersion) && pin.keyVersion > 0 && SHA256.test(pin.fingerprintSha256))
    || !invocationCounts.every((pin) => typeof pin.keyRef === 'string' && SAFE_KEY_REF.test(pin.keyRef) && checkedCount(pin.keyVersion) && pin.keyVersion > 0 && checkedCount(pin.envelopeCount))
    || !metadataCounts.every((pin) => typeof pin.keyRef === 'string' && SAFE_KEY_REF.test(pin.keyRef) && checkedCount(pin.keyVersion) && pin.keyVersion > 0 && checkedCount(pin.envelopeCount))
    || !vaultPins.every((pin) => typeof pin === 'string' && SHA256.test(pin))
    || !requireUnique(transitIds) || !requireUnique(catalogIds) || !requireUnique(catalogCountIds)
    || !requireUnique(invocationIds) || !requireUnique(invocationCountIds) || !requireUnique(metadataIds)
    || !requireUnique([...vaultPins])) {
    throw fail('RESTORE_RUNTIME_PROBE_RECOVERY_PINS_INVALID');
  }
  if (!sameJson(catalogIds.sort(), catalogCountIds.sort()) || !sameJson(invocationIds.sort(), invocationCountIds.sort())) {
    throw fail('RESTORE_RUNTIME_PROBE_RECOVERY_COUNTS_INVALID');
  }
  // A zero-count or absent family cannot be promoted to a reachable/decrypted
  // proof. The exact-version reader must exercise at least one pin per family.
  if (transitPins.length === 0 || catalogPins.length === 0 || invocationPins.length === 0
    || metadataCounts.length === 0 || vaultPins.length === 0) {
    throw fail('RESTORE_RUNTIME_PROBE_RECOVERY_FAMILY_MISSING');
  }
  const orchestrator = parseDatabaseIdentity(input.services.orchestrator, input.orchestratorDatabase);
  const connector = parseDatabaseIdentity(input.services.connector, input.connectorDatabase);
  if (orchestrator.serviceName === connector.serviceName || orchestrator.databaseName === connector.databaseName) {
    throw fail('RESTORE_RUNTIME_PROBE_DATABASE_IDENTITY_INVALID');
  }
  return { orchestrator, connector };
}

function buildExternalEffects(): Readonly<Record<DisabledExternalEffect, 'DISABLED'>> {
  return Object.freeze({
    admission: 'DISABLED', dispatch: 'DISABLED', providerInvocation: 'DISABLED', connectorPoll: 'DISABLED',
    usageDelivery: 'DISABLED', webhookDelivery: 'DISABLED', alertEmission: 'DISABLED', cleanup: 'DISABLED',
    historicalMaintenance: 'DISABLED', migrations: 'DISABLED',
  });
}

function launchPlan(kind: RestoreRuntimeKind, input: ProbeInput, db: RestoreDatabaseIdentity): RestoreRuntimeLaunchPlan {
  const expected = input.expectedRuntime;
  const plan: RestoreRuntimeLaunchPlan = {
    kind,
    clusterName: kind === 'orchestrator' ? input.orchestratorClusterName : input.connectorClusterName,
    runtimeIdentity: kind === 'orchestrator' ? expected.orchestratorRuntimeIdentity : expected.connectorRuntimeIdentity,
    revision: kind === 'orchestrator' ? expected.orchestratorRevision : expected.connectorRevision,
    imageDigest: kind === 'orchestrator' ? expected.orchestratorImageDigest : expected.connectorImageDigest,
    database: db,
    targetGenerationId: input.targetGenerationId,
    sourceRuntimeIdentities: [...input.sourceRuntimeIdentities],
    externalEffects: buildExternalEffects(),
    network: {
      defaultEgress: 'DENY',
      blockedSourceRefs: SOURCE_REFS,
      allowedPurposes: ['isolatedDatabases', 'targetArtifactGeneration', 'independentRecoveryReaders', 'localHealth'],
    },
  };
  if (kind === 'connector') {
    return { ...plan, replicaId: expected.connectorReplicaId, slot: expected.connectorSlot };
  }
  return { ...plan, slot: expected.orchestratorSlot };
}

function checkPorts(options: TrustedIsolatedRestoreProbeOptions): void {
  if (!options || !options.launch || typeof options.launch.start !== 'function' || typeof options.launch.stopAndWait !== 'function'
    || !options.health || typeof options.health.observeOrchestrator !== 'function' || typeof options.health.observeConnector !== 'function'
    || !options.control || typeof options.control.readOrchestrator !== 'function' || typeof options.control.readConnector !== 'function'
    || !options.sourceIsolation || typeof options.sourceIsolation.probeFromRuntime !== 'function'
    || !options.databaseReader || typeof options.databaseReader.readCounts !== 'function'
    || !options.applicationReader || typeof options.applicationReader.exerciseLoginAndHistory !== 'function'
    || typeof options.applicationReader.downloadArtifact !== 'function'
    || !options.recoveryReader || typeof options.recoveryReader.recoverArtifactTransitKey !== 'function'
    || typeof options.recoveryReader.recoverSecretCatalogKey !== 'function'
    || typeof options.recoveryReader.recoverConnectorInvocationKey !== 'function'
    || typeof options.recoveryReader.recoverConnectorCredentialKey !== 'function'
    || typeof options.recoveryReader.recoverMetadataTransitKey !== 'function'
    || typeof options.recoveryReader.readVaultCredential !== 'function') {
    throw fail('RESTORE_RUNTIME_PROBE_PORTS_REQUIRED');
  }
  const runtime = options.maxRuntimeMs ?? DEFAULT_RUNTIME_MS;
  const rows = options.maxEvidenceRows ?? DEFAULT_MAX_EVIDENCE_ROWS;
  const bytes = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  if (!Number.isSafeInteger(runtime) || runtime < 1000 || runtime > MAX_RUNTIME_MS
    || !Number.isSafeInteger(rows) || rows < 1 || rows > 1_000_000
    || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > DEFAULT_MAX_DOWNLOAD_BYTES) {
    throw fail('RESTORE_RUNTIME_PROBE_LIMIT_INVALID');
  }
}

function validateObservationTimes(observations: readonly string[], nowMs: number): void {
  if (observations.some((value) => !checkedFresh(value, nowMs))) throw fail('RESTORE_RUNTIME_PROBE_OBSERVATION_STALE');
}

function validateHealth(
  kind: RestoreRuntimeKind,
  observation: RuntimeHealthObservation,
  input: ProbeInput,
  nowMs: number,
): void {
  if (!observation || typeof observation !== 'object') throw fail('RESTORE_RUNTIME_IDENTITY_OR_DRAIN_UNVERIFIED');
  const expected = input.expectedRuntime;
  const identityMatches = kind === 'orchestrator'
    ? observation.clusterName === input.orchestratorClusterName
      && observation.runtimeIdentity === expected.orchestratorRuntimeIdentity
      && observation.slot === expected.orchestratorSlot
      && observation.revision === expected.orchestratorRevision
      && observation.imageDigest === expected.orchestratorImageDigest
    : observation.clusterName === input.connectorClusterName
      && observation.runtimeIdentity === expected.connectorRuntimeIdentity
      && observation.revision === expected.connectorRevision
      && observation.imageDigest === expected.connectorImageDigest
      && observation.replicaId === expected.connectorReplicaId
      && observation.slot === expected.connectorSlot;
  if (!observation || observation.readiness !== 'DRAINING' || observation.liveness !== 'LIVE'
    || !identityMatches
    || typeof observation.bootId !== 'string' || !SAFE_ID.test(observation.bootId)
    || !checkedFresh(observation.livenessObservedAt, nowMs)
    || !observation.dependencies
    || observation.dependencies.postgres?.state !== 'HEALTHY'
    || observation.dependencies.redis?.state !== 'HEALTHY'
    || !checkedFresh(observation.dependencies.postgres?.observedAt, nowMs)
    || !checkedFresh(observation.dependencies.redis?.observedAt, nowMs)
    || !observation.control || observation.control.state !== 'DRAINING'
    || !checkedRevision(observation.control.revision) || observation.control.revision < 1
    || observation.control.bootId !== observation.bootId || !checkedFresh(observation.control.acknowledgedAt, nowMs)
    || !EFFECTS.every((effect) => observation.externalEffects?.[effect] === 'DISABLED')) {
    throw fail('RESTORE_RUNTIME_IDENTITY_OR_DRAIN_UNVERIFIED');
  }
  if (kind === 'orchestrator') {
    if (!checkedCount(observation.work?.activeRequests) || !checkedCount(observation.work?.activeDispatches)
      || !checkedCount(observation.work?.maintenanceExecutions) || observation.work.activeRequests !== 0
      || observation.work.activeDispatches !== 0 || observation.work.maintenanceExecutions !== 0) {
      throw fail('RESTORE_RUNTIME_ORCHESTRATOR_WORK_ACTIVE');
    }
  } else {
    const permits = observation.work?.effectPermits;
    if (!permits || !checkedCount(permits.prepared) || !checkedCount(permits.active)
      || !checkedCount(permits.settling) || !checkedCount(permits.unknown)
      || !checkedCount(observation.work?.processActiveInvocations) || !checkedCount(observation.work?.processActivePolls)
      || !checkedCount(observation.work?.processActiveUsageSends) || !checkedCount(observation.work?.unresolvedInvocationHolds)
      || !checkedCount(observation.work?.unclosedEffectPermits) || !checkedCount(observation.work?.unknownUsageDeliveries)
      || observation.work.unclosedEffectPermits !== permits.prepared + permits.active + permits.settling + permits.unknown
      || permits.prepared !== 0 || permits.active !== 0 || permits.settling !== 0
      || observation.work.processActiveInvocations !== 0 || observation.work.processActivePolls !== 0
      || observation.work.processActiveUsageSends !== 0) {
      throw fail('RESTORE_RUNTIME_CONNECTOR_PROCESS_WORK_ACTIVE');
    }
  }
  validateObservationTimes([observation.observedAt, observation.workObservedAt], nowMs);
}

function validateControl(
  kind: RestoreRuntimeKind,
  observation: DatabaseControlObservation,
  health: RuntimeHealthObservation,
  input: ProbeInput,
  nowMs: number,
): void {
  const expectedCluster = kind === 'orchestrator' ? input.orchestratorClusterName : input.connectorClusterName;
  if (!observation || observation.clusterName !== expectedCluster || observation.desiredState !== 'DRAINING'
    || !checkedRevision(observation.revision) || observation.acknowledgedState !== 'DRAINING'
    || observation.acknowledgedRevision !== observation.revision || observation.acknowledgedBootId !== health.bootId
    || observation.acknowledgedRevision !== health.control.revision
    || observation.acknowledgedAt !== health.control.acknowledgedAt
    || !checkedFresh(observation.acknowledgedAt, nowMs) || !checkedFresh(observation.observedAt, nowMs)) {
    throw fail('RESTORE_RUNTIME_DRAIN_ACK_INVALID');
  }
}

async function abortable<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw fail('RESTORE_RUNTIME_PROBE_TIMEOUT');
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(fail('RESTORE_RUNTIME_PROBE_TIMEOUT'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(operation).then((value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    }, () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(fail('RESTORE_RUNTIME_PROBE_PORT_FAILED'));
    });
  });
}

function raceProbe<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(fail('RESTORE_RUNTIME_PROBE_TIMEOUT'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(fail('RESTORE_RUNTIME_PROBE_TIMEOUT'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

interface RuntimeOwnership {
  handles: OwnedRestoreRuntimeHandle[];
  pendingStarts: Promise<void>[];
  lateCleanupFailed: boolean;
}

async function stopOneOwned(
  options: TrustedIsolatedRestoreProbeOptions,
  handle: OwnedRestoreRuntimeHandle,
): Promise<boolean> {
  const cleanupController = new AbortController();
  const timer = setTimeout(() => cleanupController.abort(), OWNED_STOP_TIMEOUT_MS);
  try {
    await abortable(() => options.launch.stopAndWait(handle, { signal: cleanupController.signal }), cleanupController.signal);
    return false;
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForPendingStarts(ownership: RuntimeOwnership): Promise<boolean> {
  if (ownership.pendingStarts.length === 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), OWNED_STOP_TIMEOUT_MS);
  });
  const settled = Promise.all(ownership.pendingStarts).then(() => 'settled' as const);
  const outcome = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  return outcome === 'timeout' || ownership.lateCleanupFailed;
}

async function stopOwned(options: TrustedIsolatedRestoreProbeOptions, ownership: RuntimeOwnership): Promise<boolean> {
  let failed = await waitForPendingStarts(ownership);
  for (const handle of [...ownership.handles].reverse()) {
    if (await stopOneOwned(options, handle)) failed = true;
  }
  return failed;
}

async function startOwned(
  options: TrustedIsolatedRestoreProbeOptions,
  plan: RestoreRuntimeLaunchPlan,
  signal: AbortSignal,
  ownership: RuntimeOwnership,
): Promise<OwnedRestoreRuntimeHandle> {
  const started = Promise.resolve().then(() => options.launch.start(plan, { signal }));
  const tracked = started.then(async (handle) => {
    assertOwnedHandle(handle, plan.kind);
    if (signal.aborted) {
      if (await stopOneOwned(options, handle)) {
        ownership.lateCleanupFailed = true;
        throw fail('RESTORE_RUNTIME_PROBE_CLEANUP_FAILED');
      }
      return handle;
    }
    ownership.handles.push(handle);
    return handle;
  });
  ownership.pendingStarts.push(tracked.then(() => undefined, () => undefined));
  return abortable(() => tracked, signal);
}

function assertOwnedHandle(handle: OwnedRestoreRuntimeHandle, kind: RestoreRuntimeKind): void {
  if (!handle || handle.kind !== kind || typeof handle.handleId !== 'string' || !SAFE_ID.test(handle.handleId)) {
    throw fail('RESTORE_RUNTIME_PROBE_HANDLE_INVALID');
  }
}

function countMapBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, number> {
  const result = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    result.set(key, (result.get(key) ?? 0) + 1);
  }
  return result;
}

function keyObservationMatches(
  observation: RecoveryKeyObservation,
  expectedVersion: string | number,
  expectedRef: string | undefined,
  expectedFingerprint: string | undefined,
  nowMs: number,
): void {
  if (!observation || observation.keyVersion !== expectedVersion || observation.keyRef !== expectedRef
    || !SHA256.test(observation.fingerprintSha256) || (expectedFingerprint && observation.fingerprintSha256 !== expectedFingerprint)
    || typeof observation.registryIdentity !== 'string' || !SAFE_ID.test(observation.registryIdentity)
    || !checkedFresh(observation.observedAt, nowMs)) {
    throw fail('RESTORE_RUNTIME_RECOVERY_KEY_UNVERIFIED');
  }
}

function validateArtifactRecoveryItem(item: RestoreArtifactRecoveryItem, pin: { keyRef: string; keyVersion: number }, targetGenerationId: string): void {
  if (!item || !checkedUuid(item.artifactId) || item.storageGenerationId !== targetGenerationId
    || !checkedUuid(item.tenantId) || !checkedUuid(item.uploadToken)
    || !SHA256.test(item.apiKeyIdSha256)
    || typeof item.storageVersionId !== 'string' || item.storageVersionId.length < 1 || item.storageVersionId.length > 512
    || (item.manifestVersionId !== null && (typeof item.manifestVersionId !== 'string' || item.manifestVersionId.length < 1 || item.manifestVersionId.length > 512))
    || item.keyRef !== pin.keyRef || item.keyVersion !== pin.keyVersion
    || typeof item.contentType !== 'string' || item.contentType.length < 1 || item.contentType.length > 255
    || !SHA256.test(item.ciphertextSha256) || !checkedCount(item.ciphertextByteSize) || !SHA256.test(item.plaintextSha256)
    || !checkedCount(item.plaintextByteSize) || (item.manifestVersionId === null
      ? item.sidecarCiphertextSha256 !== null || item.sidecarPlaintextSha256 !== null
      : !SHA256.test(item.sidecarCiphertextSha256 ?? '') || !SHA256.test(item.sidecarPlaintextSha256 ?? ''))) {
    throw fail('RESTORE_ARTIFACT_TRANSIT_DECRYPTION_UNVERIFIED');
  }
}

function validateCatalogItem(item: RestoreSecretCatalogRecoveryItem, keyVersion: string): void {
  if (!item || !SHA256.test(item.recordIdSha256) || item.keyVersion !== keyVersion
    || (item.recordKind !== 'revision' && item.recordKind !== 'currentSecret')
    || !SHA256.test(item.ciphertextSha256) || !SHA256.test(item.plaintextSha256)) {
    throw fail('RESTORE_SECRET_CATALOG_DECRYPTION_UNVERIFIED');
  }
}

function validateInvocationItem(item: RestoreConnectorInvocationRecoveryItem, pin: { keyRef: string; keyVersion: number }): void {
  if (!item || !SHA256.test(item.envelopeIdSha256) || item.keyRef !== pin.keyRef || item.keyVersion !== pin.keyVersion
    || !SHA256.test(item.ciphertextSha256) || !SHA256.test(item.plaintextSha256)) {
    throw fail('RESTORE_CONNECTOR_INVOCATION_DECRYPTION_UNVERIFIED');
  }
}

function validateCredentialItem(item: RestoreConnectorCredentialRecoveryItem, keyVersion: string): void {
  if (!item || !SHA256.test(item.secretVersionIdSha256) || item.keyVersion !== keyVersion
    || !SHA256.test(item.ciphertextSha256) || !SHA256.test(item.plaintextSha256)) {
    throw fail('RESTORE_CONNECTOR_CREDENTIAL_DECRYPTION_UNVERIFIED');
  }
}

function validateMetadataItem(item: RestoreMetadataTransitRecoveryItem, pin: { keyRef: string; keyVersion: number }): void {
  if (!item || !SHA256.test(item.envelopeIdSha256) || item.keyRef !== pin.keyRef || item.keyVersion !== pin.keyVersion
    || !SHA256.test(item.ciphertextSha256) || !SHA256.test(item.plaintextSha256)) {
    throw fail('RESTORE_METADATA_TRANSIT_DECRYPTION_UNVERIFIED');
  }
}

function iteratorFor<T>(iterable: AsyncIterable<T> | Iterable<T>): AsyncIterator<T> | Iterator<T> {
  if (Symbol.asyncIterator in Object(iterable)) return (iterable as AsyncIterable<T>)[Symbol.asyncIterator]();
  return (iterable as Iterable<T>)[Symbol.iterator]();
}

async function boundedIteratorClose<T>(
  iterable: AsyncIterable<T> | Iterable<T>,
  iterator: AsyncIterator<T> | Iterator<T>,
): Promise<void> {
  const target = iterable as AsyncIterable<T> & Iterable<T> & {
    cancel?: (reason?: unknown) => Promise<unknown> | unknown;
    destroy?: (error?: Error) => unknown;
    destroyed?: boolean;
  };
  let closeOperation: Promise<unknown> | undefined;
  try {
    if (typeof iterator.return === 'function') {
      closeOperation = Promise.resolve(iterator.return());
    } else if (typeof target.cancel === 'function') {
      closeOperation = Promise.resolve(target.cancel());
    } else if (typeof target.destroy === 'function' && target.destroyed !== true) {
      target.destroy();
    } else if (Symbol.asyncIterator in Object(iterable)) {
      throw fail('RESTORE_RUNTIME_PROBE_CLEANUP_FAILED');
    }
  } catch {
    throw fail('RESTORE_RUNTIME_PROBE_CLEANUP_FAILED');
  }
  if (!closeOperation) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), STREAM_CLOSE_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([closeOperation.then(() => 'closed' as const), timeout]);
    if (outcome !== 'closed') throw fail('RESTORE_RUNTIME_PROBE_CLEANUP_FAILED');
  } catch {
    throw fail('RESTORE_RUNTIME_PROBE_CLEANUP_FAILED');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function* iterateAbortably<T>(
  iterable: AsyncIterable<T> | Iterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const iterator = iteratorFor(iterable);
  let completed = false;
  try {
    while (true) {
      if (signal.aborted) throw fail('RESTORE_RUNTIME_PROBE_TIMEOUT');
      const next = await abortable(() => Promise.resolve(iterator.next()), signal);
      if (next.done) {
        completed = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!completed) await boundedIteratorClose(iterable, iterator);
  }
}

async function collectEvidence<T>(
  iterable: AsyncIterable<T> | Iterable<T>,
  validate: (item: T) => void,
  project: (item: T) => unknown,
  options: { signal: AbortSignal; maxRows: number },
): Promise<SanitizedEvidence> {
  const hash = createHash('sha256');
  let count = 0;
  for await (const item of iterateAbortably(iterable, options.signal)) {
    if (options.signal.aborted) throw fail('RESTORE_RUNTIME_PROBE_TIMEOUT');
    count += 1;
    if (count > options.maxRows) throw fail('RESTORE_RUNTIME_PROBE_EVIDENCE_LIMIT_EXCEEDED');
    validate(item);
    hash.update(canonical(project(item)));
    hash.update('\n');
  }
  return { sha256: hash.digest('hex'), count };
}

async function hashDownload(
  body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of iterateAbortably(body, signal)) {
    if (signal.aborted) throw fail('RESTORE_RUNTIME_PROBE_TIMEOUT');
    if (!(chunk instanceof Uint8Array)) throw fail('RESTORE_ARTIFACT_DOWNLOAD_INVALID');
    bytes += chunk.byteLength;
    if (!Number.isSafeInteger(bytes) || bytes > maxBytes) throw fail('RESTORE_ARTIFACT_DOWNLOAD_LIMIT_EXCEEDED');
    hash.update(chunk);
  }
  return { sha256: hash.digest('hex'), bytes };
}

function safeCounts(value: unknown): ExpectedCounts {
  if (!validateCounts(value)) throw fail('RESTORE_RUNTIME_PROBE_COUNT_OBSERVATION_INVALID');
  return value;
}

async function runProbe(
  options: TrustedIsolatedRestoreProbeOptions,
  input: ProbeInput,
  database: { orchestrator: RestoreDatabaseIdentity; connector: RestoreDatabaseIdentity },
  signal: AbortSignal,
  ownership: RuntimeOwnership,
): Promise<ProbeResult> {
  const now = options.now ?? (() => new Date());
  const probeStartedAt = now();
  if (!Number.isFinite(probeStartedAt.getTime())) throw fail('RESTORE_RUNTIME_PROBE_CLOCK_INVALID');
  const maxEvidenceRows = options.maxEvidenceRows ?? DEFAULT_MAX_EVIDENCE_ROWS;
  const maxDownloadBytes = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  const orchPlan = launchPlan('orchestrator', input, database.orchestrator);
  const connectorPlan = launchPlan('connector', input, database.connector);

  const orchHandle = await startOwned(options, orchPlan, signal, ownership);
  const connectorHandle = await startOwned(options, connectorPlan, signal, ownership);

  const orchHealth = await abortable(() => options.health.observeOrchestrator(orchHandle, { signal }), signal);
  validateHealth('orchestrator', orchHealth, input, now().getTime());
  const connectorHealth = await abortable(() => options.health.observeConnector(connectorHandle, { signal }), signal);
  validateHealth('connector', connectorHealth, input, now().getTime());

  const orchControl = await abortable(() => options.control.readOrchestrator(database.orchestrator, { signal }), signal);
  validateControl('orchestrator', orchControl, orchHealth, input, now().getTime());
  const connectorControl = await abortable(() => options.control.readConnector(database.connector, { signal }), signal);
  validateControl('connector', connectorControl, connectorHealth, input, now().getTime());

  const sourceObservations: SourceIsolationObservation[] = [];
  for (const [handle, health] of [[orchHandle, orchHealth], [connectorHandle, connectorHealth]] as const) {
    for (const destinationRef of SOURCE_REFS) {
      const observation = await abortable(
        () => options.sourceIsolation.probeFromRuntime(handle, destinationRef, { signal }), signal,
      );
      const sourceNow = now().getTime();
      if (!observation || observation.destinationRef !== destinationRef
        || observation.contextRuntimeIdentity !== health.runtimeIdentity || observation.contextBootId !== health.bootId
        || !checkedFresh(observation.observedAt, sourceNow)
        || observation.networkPolicyState !== 'ENFORCED' || typeof observation.networkPolicyRevision !== 'string'
        || !SHA256.test(observation.networkPolicyRevision) || observation.responseStatus !== null
        || !['BLOCKED_BY_POLICY', 'CONNECTION_REFUSED', 'NO_ROUTE', 'TIMED_OUT', 'DNS_DENIED'].includes(observation.outcome)) {
        // HTTP 401/403/500 is a response from a reachable source and must fail.
        throw fail('RESTORE_SOURCE_ISOLATION_UNVERIFIED');
      }
      sourceObservations.push(observation);
    }
  }

  const countsObservation = await abortable(() => options.databaseReader.readCounts({
    orchestrator: database.orchestrator, connector: database.connector, targetGenerationId: input.targetGenerationId, signal,
  }), signal);
  if (!countsObservation || !checkedFresh(countsObservation.observedAt, now().getTime())) {
    throw fail('RESTORE_RUNTIME_PROBE_COUNT_OBSERVATION_INVALID');
  }
  // The reader queries both restored databases and exact artifact objects,
  // then combines their disjoint table counts into the bundle's canonical map.
  const actualCounts = safeCounts(countsObservation?.counts);
  if (!sameJson(actualCounts, input.expectedCounts)) throw fail('RESTORE_RUNTIME_COUNT_RECONCILIATION_FAILED');

  const application = await abortable(() => options.applicationReader.exerciseLoginAndHistory(orchHandle, {
    database: database.orchestrator,
    expectedOperationCount: input.expectedCounts.operations,
    signal,
  }), signal);
  const afterApplication = now().getTime();
  if (!application || !checkedFresh(application.observedAt, afterApplication)
    || !application.login || !checkedCount(application.login.statusCode)
    || application.login.statusCode < 200 || application.login.statusCode >= 300
    || !SHA256.test(application.login.authenticatedPrincipalSha256)
    || !application.history || !checkedCount(application.history.statusCode)
    || application.history.statusCode < 200 || application.history.statusCode >= 300
    || application.history.totalRecords !== input.expectedCounts.operations
    || !Array.isArray(application.history.returnedRecords)
    || application.history.returnedRecords.length > maxEvidenceRows
    || application.history.returnedRecords.some((item) => !isRecord(item)
      || typeof item.operationIdSha256 !== 'string' || !SHA256.test(item.operationIdSha256)
      || typeof item.state !== 'string' || item.state.length < 1 || item.state.length > 64
      || typeof item.hasResult !== 'boolean'
      || (item.hasResult && (typeof item.resultSha256 !== 'string' || !SHA256.test(item.resultSha256)))
      || (!item.hasResult && item.resultSha256 !== null))) {
    throw fail('RESTORE_RUNTIME_LOGIN_OR_HISTORY_UNVERIFIED');
  }
  if (application.history.returnedRecords.length !== application.history.totalRecords) {
    throw fail('RESTORE_RUNTIME_LOGIN_OR_HISTORY_UNVERIFIED');
  }
  const historyRecordIds = application.history.returnedRecords.map((item) => item.operationIdSha256);
  if (new Set(historyRecordIds).size !== historyRecordIds.length) throw fail('RESTORE_RUNTIME_LOGIN_OR_HISTORY_UNVERIFIED');
  const historyDigest = sha256(canonical(application.history.returnedRecords));

  const recoveryObservationTimes: string[] = [];
  const artifactTransitRecoveries: Array<{ keyRef: string; keyVersion: number; verifiedArtifactCount: number; evidenceSha256: string }> = [];
  const artifactRowsById = new Map<string, RestoreArtifactRecoveryItem>();
  const transitPins = [...input.expectedArtifactTransitKeyPins].sort((a, b) => `${a.keyRef}@${a.keyVersion}`.localeCompare(`${b.keyRef}@${b.keyVersion}`));
  for (const pin of transitPins) {
    const recovery = await abortable(() => options.recoveryReader.recoverArtifactTransitKey({
      database: database.orchestrator, targetGenerationId: input.targetGenerationId, pin, signal,
    }), signal);
    const nowMs = now().getTime();
    keyObservationMatches(recovery?.key, pin.keyVersion, pin.keyRef, undefined, nowMs);
    recoveryObservationTimes.push(recovery.key.observedAt);
    const evidence = await collectEvidence(recovery.items, (item) => validateArtifactRecoveryItem(item, pin, input.targetGenerationId), (item) => {
      const typed = item as RestoreArtifactRecoveryItem;
      const artifactIdSha256 = sha256(typed.artifactId);
      const prior = artifactRowsById.get(artifactIdSha256);
      if (prior && (prior.storageVersionId !== typed.storageVersionId || prior.storageGenerationId !== typed.storageGenerationId)) {
        throw fail('RESTORE_ARTIFACT_PIN_DIVERGED');
      }
      artifactRowsById.set(artifactIdSha256, typed);
      return {
        artifactIdSha256, tenantId: typed.tenantId, uploadToken: typed.uploadToken,
        storageGenerationId: typed.storageGenerationId, storageVersionId: typed.storageVersionId,
        apiKeyIdSha256: typed.apiKeyIdSha256,
        manifestVersionId: typed.manifestVersionId, keyRef: typed.keyRef, keyVersion: typed.keyVersion,
        ciphertextSha256: typed.ciphertextSha256, ciphertextByteSize: typed.ciphertextByteSize,
        plaintextSha256: typed.plaintextSha256,
        plaintextByteSize: typed.plaintextByteSize, sidecarCiphertextSha256: typed.sidecarCiphertextSha256,
        sidecarPlaintextSha256: typed.sidecarPlaintextSha256,
      };
    }, { signal, maxRows: maxEvidenceRows });
    if (evidence.count < 1) throw fail('RESTORE_ARTIFACT_TRANSIT_DECRYPTION_UNVERIFIED');
    artifactTransitRecoveries.push({ keyRef: pin.keyRef, keyVersion: pin.keyVersion, verifiedArtifactCount: evidence.count, evidenceSha256: evidence.sha256 });
  }
  if (input.expectedCounts.readyArtifacts < 1 || artifactRowsById.size !== input.expectedCounts.readyArtifacts) {
    throw fail('RESTORE_ARTIFACT_TRANSIT_DECRYPTION_UNVERIFIED');
  }

  const secretCatalogRecoveries: Array<{ keyVersion: string; verifiedRevisionCount: number; verifiedCurrentSecretCount: number; evidenceSha256: string }> = [];
  const catalogPins = [...input.expectedSecretCatalogRecoveryKeys].sort((a, b) => a.keyVersion.localeCompare(b.keyVersion));
  const catalogCounts = new Map(input.expectedSecretCatalogKeyCounts.map((item) => [item.keyVersion, item]));
  for (const pin of catalogPins) {
    const recovery = await abortable(() => options.recoveryReader.recoverSecretCatalogKey({ database: database.orchestrator, pin, signal }), signal);
    keyObservationMatches(recovery?.key, pin.keyVersion, undefined, pin.fingerprintSha256, now().getTime());
    recoveryObservationTimes.push(recovery.key.observedAt);
    let revisionCount = 0;
    let currentSecretCount = 0;
    const seen = new Set<string>();
    const evidence = await collectEvidence(recovery.items, (item) => {
      validateCatalogItem(item, pin.keyVersion);
      if (seen.has(item.recordIdSha256)) throw fail('RESTORE_SECRET_CATALOG_DUPLICATE_RECORD');
      seen.add(item.recordIdSha256);
      if (item.recordKind === 'revision') revisionCount += 1;
      else currentSecretCount += 1;
    }, (item) => item, { signal, maxRows: maxEvidenceRows });
    const expected = catalogCounts.get(pin.keyVersion);
    if (!expected || revisionCount !== expected.revisionCount || currentSecretCount !== expected.currentSecretCount) {
      throw fail('RESTORE_SECRET_CATALOG_DECRYPTION_UNVERIFIED');
    }
    secretCatalogRecoveries.push({ keyVersion: pin.keyVersion, verifiedRevisionCount: revisionCount,
      verifiedCurrentSecretCount: currentSecretCount, evidenceSha256: evidence.sha256 });
  }

  const invocationRecoveries: Array<{ keyRef: string; keyVersion: number; verifiedEnvelopeCount: number; evidenceSha256: string }> = [];
  const invocationPins = [...input.expectedConnectorInvocationRecoveryKeys].sort((a, b) => `${a.keyRef}@${a.keyVersion}`.localeCompare(`${b.keyRef}@${b.keyVersion}`));
  const invocationCounts = new Map(input.expectedConnectorInvocationKeyCounts.map((item) => [`${item.keyRef}@${item.keyVersion}`, item.envelopeCount]));
  for (const pin of invocationPins) {
    const recovery = await abortable(() => options.recoveryReader.recoverConnectorInvocationKey({ database: database.connector, pin, signal }), signal);
    keyObservationMatches(recovery?.key, pin.keyVersion, pin.keyRef, pin.fingerprintSha256, now().getTime());
    recoveryObservationTimes.push(recovery.key.observedAt);
    const seen = new Set<string>();
    const evidence = await collectEvidence(recovery.items, (item) => {
      validateInvocationItem(item, pin);
      if (seen.has(item.envelopeIdSha256)) throw fail('RESTORE_CONNECTOR_INVOCATION_DUPLICATE_ENVELOPE');
      seen.add(item.envelopeIdSha256);
    }, (item) => item, { signal, maxRows: maxEvidenceRows });
    if (invocationCounts.get(`${pin.keyRef}@${pin.keyVersion}`) !== evidence.count) {
      throw fail('RESTORE_CONNECTOR_INVOCATION_DECRYPTION_UNVERIFIED');
    }
    invocationRecoveries.push({ keyRef: pin.keyRef, keyVersion: pin.keyVersion, verifiedEnvelopeCount: evidence.count, evidenceSha256: evidence.sha256 });
  }

  const credentialPin = input.expectedConnectorCredentialKey;
  const credentialRecovery = await abortable(() => options.recoveryReader.recoverConnectorCredentialKey({
    database: database.connector, pin: credentialPin, signal,
  }), signal);
  keyObservationMatches(credentialRecovery?.key, credentialPin.keyVersion, undefined, credentialPin.fingerprintSha256, now().getTime());
  recoveryObservationTimes.push(credentialRecovery.key.observedAt);
  const seenSecretVersions = new Set<string>();
  const credentialEvidence = await collectEvidence(credentialRecovery.items, (item) => {
    validateCredentialItem(item, credentialPin.keyVersion);
    if (seenSecretVersions.has(item.secretVersionIdSha256)) throw fail('RESTORE_CONNECTOR_CREDENTIAL_DUPLICATE_VERSION');
    seenSecretVersions.add(item.secretVersionIdSha256);
  }, (item) => item, { signal, maxRows: maxEvidenceRows });
  if (credentialEvidence.count !== input.expectedConnectorSecretVersionCount) {
    throw fail('RESTORE_CONNECTOR_CREDENTIAL_DECRYPTION_UNVERIFIED');
  }

  const metadataRecoveries: Array<{ keyRef: string; keyVersion: number; verifiedEnvelopeCount: number; evidenceSha256: string }> = [];
  const metadataPins = [...input.expectedMetadataTransitKeyCounts].sort((a, b) => `${a.keyRef}@${a.keyVersion}`.localeCompare(`${b.keyRef}@${b.keyVersion}`));
  for (const pin of metadataPins) {
    const recovery = await abortable(() => options.recoveryReader.recoverMetadataTransitKey({ database: database.orchestrator, pin, signal }), signal);
    keyObservationMatches(recovery?.key, pin.keyVersion, pin.keyRef, undefined, now().getTime());
    recoveryObservationTimes.push(recovery.key.observedAt);
    const seen = new Set<string>();
    const evidence = await collectEvidence(recovery.items, (item) => {
      validateMetadataItem(item, pin);
      if (seen.has(item.envelopeIdSha256)) throw fail('RESTORE_METADATA_TRANSIT_DUPLICATE_ENVELOPE');
      seen.add(item.envelopeIdSha256);
    }, (item) => item, { signal, maxRows: maxEvidenceRows });
    if (evidence.count !== pin.envelopeCount) throw fail('RESTORE_METADATA_TRANSIT_DECRYPTION_UNVERIFIED');
    metadataRecoveries.push({ keyRef: pin.keyRef, keyVersion: pin.keyVersion, verifiedEnvelopeCount: evidence.count, evidenceSha256: evidence.sha256 });
  }

  const vaultRecoveries: Array<{ pinSha256: string; verifiedRead: true; evidenceSha256: string }> = [];
  for (const pinSha256 of [...input.expectedVaultCredentialPinDigests].sort()) {
    const observation = await abortable(() => options.recoveryReader.readVaultCredential({ pinSha256, signal }), signal);
    if (!observation || observation.pinSha256 !== pinSha256 || !checkedCount(observation.requestedVersion)
      || observation.requestedVersion < 1 || observation.observedVersion !== observation.requestedVersion
      || !SHA256.test(observation.valueSha256) || !checkedFresh(observation.observedAt, now().getTime())) {
      throw fail('RESTORE_VAULT_CREDENTIAL_READ_UNVERIFIED');
    }
    recoveryObservationTimes.push(observation.observedAt);
    vaultRecoveries.push({ pinSha256, verifiedRead: true, evidenceSha256: sha256(canonical({
      pinSha256, requestedVersion: observation.requestedVersion, observedVersion: observation.observedVersion,
      valueSha256: observation.valueSha256, observedAt: observation.observedAt,
    })) });
  }

  if (artifactRowsById.size === 0) throw fail('RESTORE_ARTIFACT_DOWNLOAD_UNVERIFIED');
  const selectedDownloadItem = await abortable(() => options.applicationReader.selectArtifactForDownload(
    orchHandle, [...artifactRowsById.values()], { signal },
  ), signal);
  if (!selectedDownloadItem || !checkedUuid(selectedDownloadItem.artifactId)
    || !sameJson(artifactRowsById.get(sha256(selectedDownloadItem.artifactId)), selectedDownloadItem)) {
    throw fail('RESTORE_ARTIFACT_DOWNLOAD_UNVERIFIED');
  }
  const download = await abortable(() => options.applicationReader.downloadArtifact(orchHandle, {
    artifact: selectedDownloadItem,
    targetGenerationId: input.targetGenerationId,
    signal,
  }), signal);
  if (!download || download.statusCode !== 200 || download.storageGenerationId !== input.targetGenerationId
    || download.storageVersionId !== selectedDownloadItem.storageVersionId || download.manifestVersionId !== selectedDownloadItem.manifestVersionId
    || download.contentType !== selectedDownloadItem.contentType) {
    throw fail('RESTORE_ARTIFACT_DOWNLOAD_UNVERIFIED');
  }
  const downloadedBytes = await hashDownload(download.body, maxDownloadBytes, signal);
  if (downloadedBytes.sha256 !== selectedDownloadItem.plaintextSha256 || downloadedBytes.bytes !== selectedDownloadItem.plaintextByteSize) {
    throw fail('RESTORE_ARTIFACT_DOWNLOAD_UNVERIFIED');
  }

  // Re-run every source-off test from both exact target namespaces after
  // recovery work. Do these bounded reads concurrently so the first denial
  // cannot age out while the last source is checked.
  const finalTargets = [
    { handle: orchHandle, health: orchHealth },
    { handle: connectorHandle, health: connectorHealth },
  ] as const;
  const finalSourceObservations = await Promise.all(finalTargets.flatMap(({ handle, health }) => SOURCE_REFS.map(async (destinationRef) => {
    const observation = await abortable(
      () => options.sourceIsolation.probeFromRuntime(handle, destinationRef, { signal }), signal,
    );
    const sourceNow = now().getTime();
    if (!observation || observation.destinationRef !== destinationRef
      || observation.contextRuntimeIdentity !== health.runtimeIdentity || observation.contextBootId !== health.bootId
      || !checkedFresh(observation.observedAt, sourceNow)
      || observation.networkPolicyState !== 'ENFORCED' || typeof observation.networkPolicyRevision !== 'string'
      || !SHA256.test(observation.networkPolicyRevision) || observation.responseStatus !== null
      || !['BLOCKED_BY_POLICY', 'CONNECTION_REFUSED', 'NO_ROUTE', 'TIMED_OUT', 'DNS_DENIED'].includes(observation.outcome)) {
      throw fail('RESTORE_SOURCE_ISOLATION_UNVERIFIED');
    }
    return observation;
  })));
  sourceObservations.push(...finalSourceObservations);

  // Final live/dependency/work observations and durable ACKs are deliberately
  // after all potentially slow recovery reads.
  const [finalOrchHealth, finalConnectorHealth] = await Promise.all([
    abortable(() => options.health.observeOrchestrator(orchHandle, { signal }), signal),
    abortable(() => options.health.observeConnector(connectorHandle, { signal }), signal),
  ]);
  const [finalOrchControl, finalConnectorControl] = await Promise.all([
    abortable(() => options.control.readOrchestrator(database.orchestrator, { signal }), signal),
    abortable(() => options.control.readConnector(database.connector, { signal }), signal),
  ]);
  const afterFinalObservations = now().getTime();
  if (!Number.isFinite(afterFinalObservations)) throw fail('RESTORE_RUNTIME_PROBE_CLOCK_INVALID');
  validateHealth('orchestrator', finalOrchHealth, input, afterFinalObservations);
  validateHealth('connector', finalConnectorHealth, input, afterFinalObservations);
  validateControl('orchestrator', finalOrchControl, finalOrchHealth, input, afterFinalObservations);
  validateControl('connector', finalConnectorControl, finalConnectorHealth, input, afterFinalObservations);
  if (finalOrchHealth.bootId !== orchHealth.bootId || finalConnectorHealth.bootId !== connectorHealth.bootId
    || finalOrchHealth.control.revision !== orchHealth.control.revision
    || finalConnectorHealth.control.revision !== connectorHealth.control.revision
    || finalOrchControl.revision !== orchControl.revision || finalConnectorControl.revision !== connectorControl.revision) {
    throw fail('RESTORE_RUNTIME_IDENTITY_OR_DRAIN_UNVERIFIED');
  }

  const finalNow = now();
  if (!Number.isFinite(finalNow.getTime())) throw fail('RESTORE_RUNTIME_PROBE_CLOCK_INVALID');
  const finalMs = finalNow.getTime();
  validateObservationTimes([
    finalOrchHealth.observedAt, finalOrchHealth.workObservedAt, finalOrchHealth.control.acknowledgedAt!,
    finalOrchHealth.livenessObservedAt, finalOrchHealth.dependencies.postgres.observedAt,
    finalOrchHealth.dependencies.redis.observedAt,
    finalConnectorHealth.observedAt, finalConnectorHealth.workObservedAt, finalConnectorHealth.control.acknowledgedAt!,
    finalConnectorHealth.livenessObservedAt, finalConnectorHealth.dependencies.postgres.observedAt,
    finalConnectorHealth.dependencies.redis.observedAt,
    finalOrchControl.observedAt, finalOrchControl.acknowledgedAt!, finalConnectorControl.observedAt, finalConnectorControl.acknowledgedAt!,
  ], finalMs);
  validateObservationTimes(finalSourceObservations.map((item) => item.observedAt), finalMs);
  const sourceObservedAt = finalSourceObservations.map((item) => item.observedAt)
    .sort((left, right) => Date.parse(left) - Date.parse(right)).at(-1)!;
  const recoveryObservedAt = recoveryObservationTimes
    .slice().sort((left, right) => Date.parse(left) - Date.parse(right)).at(-1);
  if (!recoveryObservedAt) throw fail('RESTORE_RUNTIME_RECOVERY_KEY_UNVERIFIED');
  const probeCompletedAt = finalNow.toISOString();
  const probeElapsedMs = finalMs - probeStartedAt.getTime();
  if (!Number.isFinite(probeElapsedMs) || probeElapsedMs < 0 || probeElapsedMs > (options.maxRuntimeMs ?? DEFAULT_RUNTIME_MS)) {
    throw fail('RESTORE_RUNTIME_PROBE_TIMEOUT');
  }
  const externalEffectChecks = Object.fromEntries(EFFECTS.map((effect) => {
    if (finalOrchHealth.externalEffects[effect] !== 'DISABLED'
      || finalConnectorHealth.externalEffects[effect] !== 'DISABLED') {
      throw fail('RESTORE_RUNTIME_EXTERNAL_EFFECTS_ENABLED');
    }
    return [effect, 'PASSED' as const];
  })) as Readonly<Record<DisabledExternalEffect, 'PASSED'>>;
  const checks = {
    login: 'PASSED' as const,
    history: 'PASSED' as const,
    artifactDecryption: 'PASSED' as const,
    artifactDownload: 'PASSED' as const,
    artifactTransitKeyRecovery: 'PASSED' as const,
    secretCatalogDecryption: 'PASSED' as const,
    connectorInvocationDecryption: 'PASSED' as const,
    connectorCredentialDecryption: 'PASSED' as const,
    metadataTransitDecryption: 'PASSED' as const,
    vaultCredentialReads: 'PASSED' as const,
    dispatchDisabled: 'PASSED' as const,
    providerCallsDisabled: 'PASSED' as const,
    usageDeliveryDisabled: 'PASSED' as const,
    externalEffects: externalEffectChecks,
  };
  const recoverySourceIsolation = {
    observedAt: sourceObservedAt,
    evidenceSha256: sha256(canonical(sourceObservations.map((observation) => ({
      observedAt: observation.observedAt,
      contextRuntimeIdentity: observation.contextRuntimeIdentity,
      contextBootId: observation.contextBootId,
      destinationRef: observation.destinationRef,
      outcome: observation.outcome,
      responseStatus: observation.responseStatus,
      networkPolicyState: observation.networkPolicyState,
      networkPolicyRevision: observation.networkPolicyRevision,
    })))),
    observationCount: sourceObservations.length,
    sourceOrchestratorReachable: false as const,
    sourceConnectorReachable: false as const,
    sourceCatalogKeyringReachable: false as const,
    sourceConnectorRecoveryRegistryReachable: false as const,
    sourceMetadataTransitReachable: false as const,
    sourceArtifactTransitReachable: false as const,
    sourceVaultReachable: false as const,
    independentRecoveryKeyReachable: true as const,
    independentSecretCatalogRecoveryReachable: true as const,
    connectorRecoveryRegistryReachable: true as const,
    metadataTransitReachable: true as const,
    vaultCredentialReaderReachable: true as const,
    artifactTransitReachable: true as const,
  };
  const core = {
    observedAt: finalOrchHealth.observedAt,
    probeStartedAt: probeStartedAt.toISOString(),
    probeCompletedAt,
    probeElapsedMs,
    orchestrator: {
      clusterName: finalOrchHealth.clusterName,
      runtimeIdentity: finalOrchHealth.runtimeIdentity,
      revision: finalOrchHealth.revision,
      imageDigest: finalOrchHealth.imageDigest,
      controlState: 'DRAINING' as const,
      controlRevision: finalOrchControl.revision,
      observedAt: finalOrchHealth.observedAt,
      workObservedAt: finalOrchHealth.workObservedAt,
      activeRequests: finalOrchHealth.work.activeRequests as 0,
      activeDispatches: finalOrchHealth.work.activeDispatches as 0,
      maintenanceExecutions: finalOrchHealth.work.maintenanceExecutions as 0,
    },
    connector: {
      clusterName: finalConnectorHealth.clusterName,
      runtimeIdentity: finalConnectorHealth.runtimeIdentity,
      replicaId: finalConnectorHealth.replicaId!,
      slot: finalConnectorHealth.slot!,
      revision: finalConnectorHealth.revision,
      imageDigest: finalConnectorHealth.imageDigest,
      controlState: 'DRAINING' as const,
      controlRevision: finalConnectorControl.revision,
      observedAt: finalConnectorHealth.observedAt,
      workObservedAt: finalConnectorHealth.workObservedAt,
      // The legacy adapter field is explicitly process activity. Historical
      // pending/UNKNOWN invocation rows are reported separately below.
      activeInvocations: finalConnectorHealth.work.processActiveInvocations as 0,
      processActiveInvocations: finalConnectorHealth.work.processActiveInvocations,
      processActivePolls: finalConnectorHealth.work.processActivePolls,
      processActiveUsageSends: finalConnectorHealth.work.processActiveUsageSends,
      unresolvedInvocationHolds: finalConnectorHealth.work.unresolvedInvocationHolds,
      effectPermits: finalConnectorHealth.work.effectPermits!,
      unclosedEffectPermits: finalConnectorHealth.work.effectPermits!.prepared + finalConnectorHealth.work.effectPermits!.active
        + finalConnectorHealth.work.effectPermits!.settling + finalConnectorHealth.work.effectPermits!.unknown,
      unknownUsageDeliveries: finalConnectorHealth.work.unknownUsageDeliveries,
    },
    recoverySourceIsolation,
    artifactTransitKeyRecoveries: artifactTransitRecoveries,
    secretCatalogKeyRecoveries: secretCatalogRecoveries,
    connectorInvocationKeyRecoveries: invocationRecoveries,
    connectorCredentialRecovery: {
      keyVersion: credentialPin.keyVersion,
      verifiedSecretVersionCount: credentialEvidence.count,
      evidenceSha256: credentialEvidence.sha256,
    },
    metadataTransitKeyRecoveries: metadataRecoveries,
    vaultCredentialRecoveries: vaultRecoveries,
    checks,
    counts: actualCounts,
    externalEffects: Object.fromEntries(EFFECTS.map((effect) => [effect, 'DISABLED'])) as Record<DisabledExternalEffect, 'DISABLED'>,
    applicationEvidence: {
      loginStatusCode: application.login.statusCode,
      authenticatedPrincipalSha256: application.login.authenticatedPrincipalSha256,
      historyStatusCode: application.history.statusCode,
      historyTotalRecords: application.history.totalRecords,
      historyReturnedRecords: application.history.returnedRecords.length,
      historyDigest,
      downloadedArtifactSha256: downloadedBytes.sha256,
      downloadedArtifactBytes: downloadedBytes.bytes,
      downloadedStorageGenerationId: input.targetGenerationId,
      downloadedStorageVersionIdSha256: sha256(selectedDownloadItem.storageVersionId),
      downloadedManifestVersionIdSha256: selectedDownloadItem.manifestVersionId ? sha256(selectedDownloadItem.manifestVersionId) : null,
    },
    recoveryObservedAt,
  };
  const serialized = canonical(core);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_FINAL_EVIDENCE_BYTES) throw fail('RESTORE_RUNTIME_PROBE_EVIDENCE_LIMIT_EXCEEDED');
  const result = { ...core, evidenceSha256: sha256(serialized) };
  return result as unknown as ProbeResult;
}

/**
 * Creates the trusted isolated runtime probe used by the backup adapter.
 * All ports are mandatory trusted service boundaries; the probe does not take
 * caller-supplied PASSED values or work counters. It launches exact isolated
 * targets, checks fresh process/DB observations, verifies source-off network
 * behavior, reads the restored databases, and derives recovery evidence from
 * per-record authenticated reader results.
 */
export function createTrustedIsolatedRestoreProbe(options: TrustedIsolatedRestoreProbeOptions): IsolatedRestoreRuntimeProbe {
  checkPorts(options);
  return {
    async run(input): Promise<IsolatedRestoreRuntimeProbeResult> {
      const database = validateInput(input);
      const controller = new AbortController();
      const ownership: RuntimeOwnership = { handles: [], pendingStarts: [], lateCleanupFailed: false };
      const timeout = setTimeout(() => controller.abort(), options.maxRuntimeMs ?? DEFAULT_RUNTIME_MS);
      let result: ProbeResult | undefined;
      let error: Error | undefined;
      let probeTeardownFailed = false;
      const runningProbe = runProbe(options, input, database, controller.signal, ownership);
      try {
        result = await raceProbe(runningProbe, controller.signal);
      } catch (cause) {
        controller.abort();
        error = cause instanceof Error && /^[A-Z0-9_]+$/.test(cause.message)
          ? cause
          : fail('RESTORE_RUNTIME_PROBE_FAILED');
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), STREAM_CLOSE_TIMEOUT_MS + 1000);
        });
        const settled = runningProbe.then(
          (lateResult) => ({ kind: 'resolved' as const, lateResult }),
          (lateError: unknown) => ({ kind: 'rejected' as const, lateError }),
        );
        const outcome = await Promise.race([settled, timedOut]);
        if (timer) clearTimeout(timer);
        if (outcome === 'timeout') probeTeardownFailed = true;
        else if (outcome.kind === 'rejected' && outcome.lateError instanceof Error
          && outcome.lateError.message === 'RESTORE_RUNTIME_PROBE_CLEANUP_FAILED') probeTeardownFailed = true;
      } finally {
        clearTimeout(timeout);
      }
      const cleanupFailed = await stopOwned(options, ownership);
      if (cleanupFailed || probeTeardownFailed || ownership.lateCleanupFailed) throw fail('RESTORE_RUNTIME_PROBE_CLEANUP_FAILED');
      if (error) throw error;
      if (!result) throw fail('RESTORE_RUNTIME_PROBE_FAILED');
      return result as IsolatedRestoreRuntimeProbeResult;
    },
  };
}
