import { createHash, randomUUID } from 'node:crypto';
import {
  CostAdjustmentCommandResultSchema,
  CostAdjustmentCommandSchema,
  CostAdjustmentEvidencePageSchema,
  CostAdjustmentHistoryEntrySchema,
  CostAdjustmentHistoryPageSchema,
  CostAdjustmentOriginalAttributionSchema,
  CostAdjustmentQuerySchema,
  CostAdjustmentEvidenceQuerySchema,
  UsageEventSchema,
  canonicalize,
  type CostAdjustmentCommand,
  type CostAdjustmentCommandResult,
  type CostAdjustmentEvidencePage,
  type CostAdjustmentHistoryPage,
  type CostAdjustmentQuery,
  type CostAdjustmentEvidenceQuery,
  type CostAdjustmentOriginalAttribution,
  type UsageEvent,
} from '@du/contracts';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Db } from '../../db/db';
import { HttpError, conflict, forbidden, notFound, unavailable, unprocessable, zodIssuesToProblem } from '../../http/errors';
import type { AuditService } from '../audit/audit';
import type { BackupSnapshotWriteGate } from '../maintenance/backup-effect-fence';
import { appendLocalUserUsageFence, usageReadScopeFingerprint, type LocalUserUsageReadScope } from '../usage/read-scope';
import { projectEffectiveCharge, type EffectiveChargeAdjustmentRow } from '../usage/effective-charges';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_ADJUSTMENT_CHAIN = 10_000;

/** Server-derived identity context supplied by the authenticated internal route. */
export interface AdjustmentReader {
  kind: 'platform' | 'tenant_operator' | 'local_user' | 'viewer';
  authKind: 'cookie' | 'bearer';
  tenantId: string | null;
  principalId: string | null;
  role: 'admin' | 'operator' | 'viewer';
  roleVersion: number | null;
  csrfOk?: boolean;
  localUserScope?: LocalUserUsageReadScope;
  /** Opaque server-extracted cookie-session ID used only for live revalidation. */
  sessionId?: string;
  /** Audit-only identity claims from the verified server session. */
  issuer?: string;
  sub?: string;
}

/** Exact server-resolved evidence pins. Object and sidecar bytes have both
 * been streamed and checked against these hashes/sizes before this is returned. */
export interface CostAdjustmentEvidencePin {
  artifactId: string;
  tenantId: string;
  fileName: string | null;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  /** Authenticated storage-metadata semantics. This is the exact digest and
   * size committed in the artifact row; it may describe ciphertext for the
   * public-upload gateway while the fields above describe logical plaintext. */
  databaseMetadata: {
    kind: 'gateway-ciphertext' | 'worker-plaintext' | 'legacy-plaintext';
    sizeBytes: number;
    sha256: string;
  };
  /** Checksum and size of the exact encrypted object bytes at storageVersionId. */
  objectSizeBytes: number;
  objectSha256: string;
  storageGenerationId: string;
  storageVersionId: string;
  sidecarVersionId: string;
  sidecarSha256: string;
  sidecarSizeBytes: number;
  createdAt: string;
}

export interface CostAdjustmentArtifactResolver {
  resolveCostAdjustmentEvidencePin(input: { tenantId: string; artifactId: string }): Promise<CostAdjustmentEvidencePin | null>;
}

export interface CostAdjustmentServiceDependencies {
  db: Db;
  audit: Pick<AuditService, 'record'>;
  artifacts: CostAdjustmentArtifactResolver;
  /** Optional only so read-only composition can start; writes fail closed when absent. */
  backupSnapshotWriteGate?: BackupSnapshotWriteGate;
  /** Rechecks the cookie session, current app role and roleVersion after slow
   * evidence verification. Called after the backup gate and before write locks. */
  assertWriterCurrent?: (actor: AdjustmentReader, client: Pick<PoolClient, 'query'>) => Promise<void>;
  now?: () => Date;
}

interface RootRow extends QueryResultRow {
  event_id: string;
  operation_id: string;
  task_id: string;
  payload: unknown;
  cost_reservation_group_id: string | null;
  received_at: Date | string;
  tenant_id: string;
  api_key_id: string | null;
  profile_id: string | null;
  profile_revision: number | null;
  business_id: string;
  business_version: string;
  action: string;
}

interface GroupRow extends QueryResultRow {
  reservation_group_id: string;
  tenant_id: string;
  operation_id: string;
  task_id: string;
  invocation_id: string;
  attempt: string | number;
  state: string;
  usage_event_id: string | null;
}

interface WindowRow extends QueryResultRow {
  budget_id: string;
  budget_revision: string | number;
  scope_key: string;
  period: 'daily' | 'monthly';
  window_start: Date | string;
  window_end: Date | string;
  state: string;
  usage_event_id: string | null;
}

interface HeadRow extends QueryResultRow {
  root_event_id: string;
  tenant_id: string;
  adjustment_revision: string | number;
  head_adjustment_event_id: string | null;
  initial_charge_microusd: string | number;
  gross_charge_microusd: string | number;
  refunded_microusd: string | number;
  net_charge_microusd: string | number;
}

interface EvidenceDbRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  operation_id: string | null;
  purpose: string;
  state: string;
  file_name: string | null;
  mime_type: string;
  size_bytes: string | number | null;
  sha256: string | null;
  storage_generation_id: string | null;
  storage_version_id: string | null;
  manifest_version_id: string | null;
  created_at: Date | string;
  created_at_key: string;
}

interface CommandRow extends QueryResultRow {
  request_hash: string;
  result: unknown;
}

interface Eligibility {
  event: UsageEvent | null;
  attribution: CostAdjustmentOriginalAttribution | null;
  blockers: string[];
  pins: Array<{
    budgetId: string;
    budgetRevision: number;
    scopeKey: string;
    period: 'daily' | 'monthly';
    windowStart: string;
    windowEnd: string;
  }>;
  group: GroupRow | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function digestCanonical(value: unknown): string {
  return `sha256:${sha256(canonicalize(value))}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toIso(value: Date | string, field: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw unavailable(`stored cost adjustment ${field} is invalid`);
  return date.toISOString();
}

function safeInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  let parsed: bigint;
  try { parsed = BigInt(value as string | number); } catch { throw unavailable(`stored cost adjustment ${field} is invalid`); }
  if (parsed < 0n || parsed > MAX_SAFE) throw unavailable(`stored cost adjustment ${field} is outside the supported range`);
  return Number(parsed);
}

function addSafe(left: number, right: number, field: string): number {
  const sum = BigInt(left) + BigInt(right);
  if (sum > MAX_SAFE) throw unavailable(`cost adjustment ${field} exceeds the supported range`);
  return Number(sum);
}

function normalizeHexDigest(value: string): string | null {
  const normalized = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
  return HEX_SHA256.test(normalized) ? normalized : null;
}

function assertEvidencePin(pin: CostAdjustmentEvidencePin, tenantId: string, artifactId: string): void {
  const metadata = pin?.databaseMetadata;
  const metadataKind = metadata?.kind;
  const metadataSize = metadata?.sizeBytes;
  const metadataDigest = metadata?.sha256;
  const logicalDigest = normalizeHexDigest(pin?.sha256 ?? '');
  const objectDigest = normalizeHexDigest(pin?.objectSha256 ?? '');
  const databaseDigest = typeof metadataDigest === 'string' ? normalizeHexDigest(metadataDigest) : null;
  const validMetadataKind = metadataKind === 'gateway-ciphertext'
    || metadataKind === 'worker-plaintext'
    || metadataKind === 'legacy-plaintext';
  const metadataMatchesMeaning = metadataKind === 'gateway-ciphertext'
    ? metadataSize === pin?.objectSizeBytes && databaseDigest !== null && databaseDigest === objectDigest
    : (metadataKind === 'worker-plaintext' || metadataKind === 'legacy-plaintext')
      ? metadataSize === pin?.sizeBytes && databaseDigest !== null && databaseDigest === logicalDigest
      : false;
  if (!pin || pin.tenantId !== tenantId || pin.artifactId !== artifactId || !UUID.test(pin.storageGenerationId)
    || typeof pin.fileName !== 'string' && pin.fileName !== null
    || (pin.fileName !== null && pin.fileName.length > 512)
    || typeof pin.mimeType !== 'string' || pin.mimeType.length < 1 || pin.mimeType.length > 256
    || !Number.isSafeInteger(pin.sizeBytes) || pin.sizeBytes < 1
    || !Number.isSafeInteger(pin.objectSizeBytes) || pin.objectSizeBytes < 1
    || !Number.isSafeInteger(pin.sidecarSizeBytes) || pin.sidecarSizeBytes <= 0
    || !normalizeHexDigest(pin.sha256) || !normalizeHexDigest(pin.objectSha256) || !normalizeHexDigest(pin.sidecarSha256)
    || !validMetadataKind || !Number.isSafeInteger(metadataSize) || metadataSize < 1
    || !databaseDigest || !metadataMatchesMeaning
    || typeof pin.storageVersionId !== 'string' || pin.storageVersionId.length < 1 || pin.storageVersionId.length > 512
    || typeof pin.sidecarVersionId !== 'string' || pin.sidecarVersionId.length < 1 || pin.sidecarVersionId.length > 512
    || !Number.isFinite(Date.parse(pin.createdAt))) {
    throw unprocessable('COST_ADJUSTMENT_EVIDENCE_UNAVAILABLE', 'The selected evidence is unavailable or has incomplete immutable storage pins.');
  }
}

function authorizeRead(actor: AdjustmentReader, tenantId: string): LocalUserUsageReadScope | undefined {
  if (actor.kind === 'platform' && actor.role === 'admin') return undefined;
  if ((actor.kind === 'tenant_operator' && actor.role === 'operator')
      || (actor.kind === 'viewer' && actor.role === 'viewer')) {
    if (actor.tenantId !== tenantId) throw notFound('not found');
    return undefined;
  }
  if (actor.kind === 'local_user' && actor.role === 'operator') {
    const scope = actor.localUserScope;
    if (!scope || actor.tenantId !== tenantId || scope.tenantId !== tenantId
      || actor.roleVersion !== scope.roleVersion || !Number.isSafeInteger(scope.roleVersion) || scope.roleVersion < 1) {
      throw notFound('not found');
    }
    return scope;
  }
  throw forbidden('current admin read scope is required');
}

function authorizeWriter(actor: AdjustmentReader): { actorPrincipalId: string; actorKind: 'local-user' | 'oidc-admin' } {
  const hasIssuer = typeof actor.issuer === 'string' && actor.issuer.length > 0;
  const hasSubject = typeof actor.sub === 'string' && actor.sub.length > 0;
  const oidcAdmin = hasIssuer && hasSubject;
  const currentLocalRole = !hasIssuer && !hasSubject
    && Number.isSafeInteger(actor.roleVersion) && (actor.roleVersion ?? 0) >= 1;
  if (actor.kind !== 'platform' || actor.authKind !== 'cookie' || actor.role !== 'admin'
      || actor.csrfOk !== true || !actor.principalId || !UUID.test(actor.principalId)
      || (!oidcAdmin && !currentLocalRole) || (hasIssuer !== hasSubject)
      || (oidcAdmin && actor.roleVersion !== null)) {
    throw forbidden('a current platform Admin session with CSRF protection is required');
  }
  return {
    actorPrincipalId: actor.principalId,
    actorKind: oidcAdmin ? 'oidc-admin' : 'local-user',
  };
}

function encodeHistoryCursor(input: { tenantId: string; rootEventId: string; queryHash: string; beforeRevision: number }): string {
  return Buffer.from(JSON.stringify({ version: 1, ...input }), 'utf8').toString('base64url');
}

function decodeHistoryCursor(value: string): { tenantId: string; rootEventId: string; queryHash: string; beforeRevision: number } {
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) throw new Error('noncanonical');
    const raw = JSON.parse(decoded.toString('utf8')) as Record<string, unknown>;
    if (raw['version'] !== 1 || typeof raw['tenantId'] !== 'string' || !UUID.test(raw['tenantId'])
      || typeof raw['rootEventId'] !== 'string' || raw['rootEventId'].length < 1 || raw['rootEventId'].length > 128
      || typeof raw['queryHash'] !== 'string' || !HEX_SHA256.test(raw['queryHash'])
      || !Number.isSafeInteger(raw['beforeRevision']) || Number(raw['beforeRevision']) < 1) throw new Error('shape');
    return { tenantId: raw['tenantId'], rootEventId: raw['rootEventId'], queryHash: raw['queryHash'], beforeRevision: Number(raw['beforeRevision']) };
  } catch {
    throw new HttpError(422, 'INVALID_ARGUMENT', 'cost adjustment cursor is invalid for this query');
  }
}

function historyQueryHash(tenantId: string, rootEventId: string, scope?: LocalUserUsageReadScope): string {
  return sha256(canonicalize({ tenantId, rootEventId, scope: usageReadScopeFingerprint(scope) }));
}

function evidenceQueryHash(query: CostAdjustmentEvidenceQuery, scope?: LocalUserUsageReadScope): string {
  return sha256(canonicalize({ tenantId: query.tenantId, q: query.q ?? null, scope: usageReadScopeFingerprint(scope) }));
}

function encodeEvidenceCursor(input: { tenantId: string; queryHash: string; afterCreatedAt: string; afterArtifactId: string }): string {
  return Buffer.from(JSON.stringify({ version: 1, ...input }), 'utf8').toString('base64url');
}

function decodeEvidenceCursor(value: string): { tenantId: string; queryHash: string; afterCreatedAt: string; afterArtifactId: string } {
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) throw new Error('noncanonical');
    const raw = JSON.parse(decoded.toString('utf8')) as Record<string, unknown>;
    if (raw['version'] !== 1 || typeof raw['tenantId'] !== 'string' || !UUID.test(raw['tenantId'])
      || typeof raw['queryHash'] !== 'string' || !HEX_SHA256.test(raw['queryHash'])
      || typeof raw['afterCreatedAt'] !== 'string' || !Number.isFinite(Date.parse(raw['afterCreatedAt']))
      || typeof raw['afterArtifactId'] !== 'string' || !UUID.test(raw['afterArtifactId'])) throw new Error('shape');
    return { tenantId: raw['tenantId'], queryHash: raw['queryHash'], afterCreatedAt: raw['afterCreatedAt'], afterArtifactId: raw['afterArtifactId'] };
  } catch {
    throw new HttpError(422, 'INVALID_ARGUMENT', 'cost evidence cursor is invalid for this query');
  }
}

function rootRawPayload(payload: unknown): Record<string, unknown> | null {
  return isRecord(payload) ? payload : null;
}

function mapWindow(row: WindowRow) {
  return {
    budgetId: row.budget_id,
    budgetRevision: safeInteger(row.budget_revision, 'budget revision')!,
    scopeKey: row.scope_key,
    period: row.period,
    windowStart: toIso(row.window_start, 'quota window start'),
    windowEnd: toIso(row.window_end, 'quota window end'),
  };
}

async function loadEligibility(
  client: Pick<PoolClient, 'query'>,
  root: RootRow,
  options: { lockGroup?: boolean } = {},
): Promise<Eligibility> {
  const blockers = new Set<string>();
  const payload = rootRawPayload(root.payload);
  const parsed = UsageEventSchema.safeParse(root.payload);
  const event = parsed.success && parsed.data.eventId === root.event_id ? parsed.data : null;
  const provenance = event?.costProvenance;
  if (!event || !provenance || provenance.tenantId !== root.tenant_id) {
    blockers.add('UNPRICED_OR_UNTRUSTED');
    blockers.add('ATTRIBUTION_INCOMPLETE');
  }
  const hasTrustedCost = Boolean(event && payload && Object.hasOwn(payload, 'costMicrousd')
    && Number.isSafeInteger(payload['costMicrousd']) && Number(payload['costMicrousd']) >= 0
    && (event.costStatus === 'measured' || event.costStatus === 'estimated'));
  if (!hasTrustedCost) blockers.add('UNPRICED_OR_UNTRUSTED');
  if (!provenance?.priceSnapshot || provenance.priceRevision === null
      || provenance.priceSnapshot.priceVersion < 1) blockers.add('PRICE_PROVENANCE_INCOMPLETE');
  if (provenance && event && ((event.provider !== undefined && event.provider !== provenance.priceSnapshot?.provider)
      || (event.model !== undefined && event.model !== provenance.priceSnapshot?.modelId))) {
    blockers.add('PRICE_PROVENANCE_INCOMPLETE');
  }

  let group: GroupRow | null = null;
  const linkedGroupId = root.cost_reservation_group_id;
  if (!linkedGroupId || !provenance || linkedGroupId !== provenance.reservationGroupId) {
    blockers.add('SETTLEMENT_INCOMPLETE');
    if (event?.costStatus === 'pending') blockers.add('RESERVATION_UNKNOWN');
  } else {
    const selected = await client.query<GroupRow>(
      `SELECT reservation_group_id::text AS reservation_group_id,tenant_id::text AS tenant_id,
              operation_id::text AS operation_id,task_id::text AS task_id,invocation_id,attempt,
              state,usage_event_id
         FROM cost_reservation_groups WHERE reservation_group_id=$1${options.lockGroup ? ' FOR UPDATE' : ''}`,
      [linkedGroupId],
    );
    group = selected.rows[0] ?? null;
    if (!group || group.tenant_id !== root.tenant_id || group.operation_id !== root.operation_id
      || group.task_id !== root.task_id || group.invocation_id !== event?.invocationId
      || Number(group.attempt) !== provenance.attempt) {
      blockers.add('ATTRIBUTION_INCOMPLETE');
      blockers.add('SETTLEMENT_INCOMPLETE');
    } else if (group.state === 'UNKNOWN') {
      blockers.add('RESERVATION_UNKNOWN');
    } else if (group.state !== 'SETTLED' || group.usage_event_id !== root.event_id) {
      blockers.add('SETTLEMENT_INCOMPLETE');
    }
  }

  const pins: Eligibility['pins'] = [];
  if (group) {
    const selected = await client.query<WindowRow>(
      `SELECT budget_id::text AS budget_id,budget_revision,scope_key,period,window_start,window_end,state,usage_event_id
         FROM cost_budget_holds WHERE reservation_group_id=$1 ORDER BY budget_id`,
      [group.reservation_group_id],
    );
    for (const row of selected.rows) {
      pins.push(mapWindow(row));
      if (row.state !== 'SETTLED' || row.usage_event_id !== root.event_id) blockers.add('SETTLEMENT_INCOMPLETE');
    }
    const expected = (provenance?.budgetPins ?? []).map((pin) => `${pin.budgetId}:${pin.revision}`).sort();
    const actual = pins.map((pin) => `${pin.budgetId}:${pin.budgetRevision}`).sort();
    if (canonicalize(expected) !== canonicalize(actual)) blockers.add('SETTLEMENT_INCOMPLETE');
  }

  let attribution: CostAdjustmentOriginalAttribution | null = null;
  if (event && provenance && provenance.priceSnapshot) {
    const actualProvider = provenance.priceSnapshot.provider;
    const actualModel = provenance.priceSnapshot.modelId;
    const occursAt = toIso(event.occurredAt, 'original occurredAt');
    const candidate = {
      tenantId: root.tenant_id,
      apiKeyId: root.api_key_id,
      profileId: root.profile_id,
      profileRevision: root.profile_revision,
      businessId: provenance.businessId,
      businessVersion: provenance.businessVersion,
      action: provenance.action,
      operationId: root.operation_id,
      taskId: root.task_id,
      invocationId: event.invocationId,
      attempt: provenance.attempt,
      connectorId: provenance.connectorId,
      connectorRevision: provenance.connectorRevision,
      provider: actualProvider,
      model: actualModel,
      occurredAt: occursAt,
      quotaWindowPins: pins,
      priceRevision: provenance.priceRevision,
      priceSnapshotDigest: digestCanonical(provenance.priceSnapshot),
      provenanceDigest: digestCanonical(provenance),
      costStatus: event.costStatus === 'estimated' ? 'estimated' : 'measured',
      inputTokens: event.units.inputTokens,
      outputTokens: event.units.outputTokens,
      cachedInputTokens: event.units.cachedInputTokens ?? 0,
      pages: event.units.pages ?? 0,
      durationMs: provenance.durationMs,
    };
    const parsedAttribution = CostAdjustmentOriginalAttributionSchema.safeParse(candidate);
    if (!parsedAttribution.success || provenance.tenantId !== root.tenant_id
      || provenance.apiKeyId !== root.api_key_id || provenance.profileId !== root.profile_id
      || provenance.profileRevision !== root.profile_revision || provenance.businessId !== root.business_id
      || provenance.businessVersion !== root.business_version || provenance.action !== root.action) {
      blockers.add('ATTRIBUTION_INCOMPLETE');
    } else {
      attribution = parsedAttribution.data;
    }
  } else {
    blockers.add('PRICE_PROVENANCE_INCOMPLETE');
  }
  return { event, attribution, blockers: [...blockers].sort(), pins, group };
}

async function readRoot(
  client: Pick<PoolClient, 'query'>,
  tenantId: string,
  eventId: string,
  scope?: LocalUserUsageReadScope,
  lockRow = false,
): Promise<RootRow | null> {
  const params: unknown[] = [eventId, tenantId];
  const where = ['ue.event_id=$1', 'o.tenant_id=$2'];
  const bind = (value: unknown): string => { params.push(value); return `$${params.length}`; };
  appendLocalUserUsageFence(where, bind, scope);
  const selected = await client.query<RootRow>(
    `SELECT ue.event_id,ue.operation_id::text AS operation_id,ue.task_id::text AS task_id,ue.payload,
            ue.cost_reservation_group_id::text AS cost_reservation_group_id,ue.received_at,
            o.tenant_id::text AS tenant_id,o.api_key_id::text AS api_key_id,o.profile_id::text AS profile_id,
            o.profile_revision,o.business_id,o.business_version,o.action
       FROM usage_events ue JOIN operations o ON o.id=ue.operation_id
      WHERE ${where.join(' AND ')} LIMIT 1${lockRow ? ' FOR UPDATE OF ue' : ''}`,
    params,
  );
  return selected.rows[0] ?? null;
}

function mapAdjustment(row: EffectiveChargeAdjustmentRow & Record<string, unknown>) {
  const mapped = {
    adjustmentEventId: row.adjustment_event_id,
    rootEventId: row.root_event_id,
    adjustmentRevision: safeInteger(row.adjustment_revision, 'adjustment revision'),
    previousAdjustmentEventId: row.previous_adjustment_event_id,
    kind: row.kind,
    targetChargeMicrousd: safeInteger(row.target_charge_microusd, 'target charge'),
    refundMicrousd: safeInteger(row.refund_microusd, 'refund amount'),
    initialChargeMicrousd: safeInteger(row.initial_charge_microusd, 'initial charge'),
    grossChargeMicrousd: safeInteger(row.gross_charge_microusd, 'gross charge'),
    refundedMicrousd: safeInteger(row.refunded_microusd, 'refunded amount'),
    netChargeMicrousd: safeInteger(row.net_charge_microusd, 'net charge'),
    effectiveAt: toIso(row.effective_at, 'effective time'),
    quotaWindowPins: row.quota_window_pins,
    recordedAt: toIso(row.recorded_at, 'recorded time'),
    evidenceArtifactId: String(row['evidence_artifact_id']),
    evidenceStorageGenerationId: String(row['evidence_storage_generation_id']),
    evidenceSha256: `sha256:${String(row['evidence_sha256']).replace(/^sha256:/, '')}`,
    evidenceSizeBytes: safeInteger(row['evidence_size_bytes'], 'evidence size'),
    evidenceObjectSizeBytes: safeInteger(row['evidence_object_size_bytes'], 'evidence object size'),
    evidenceObjectSha256: row['evidence_object_sha256'] === null || row['evidence_object_sha256'] === undefined
      ? null
      : `sha256:${String(row['evidence_object_sha256']).replace(/^sha256:/, '')}`,
    evidenceObjectProofComplete: row['evidence_object_size_bytes'] !== null
      && row['evidence_object_size_bytes'] !== undefined
      && row['evidence_object_sha256'] !== null
      && row['evidence_object_sha256'] !== undefined,
    evidenceObjectVersionId: String(row['evidence_object_version_id']),
    evidenceSidecarVersionId: String(row['evidence_sidecar_version_id']),
    evidenceSidecarSha256: `sha256:${String(row['evidence_sidecar_sha256']).replace(/^sha256:/, '')}`,
    evidenceSidecarSizeBytes: safeInteger(row['evidence_sidecar_size_bytes'], 'evidence sidecar size'),
    authority: 'platform-admin-approved' as const,
    actorPrincipalId: String(row['actor_principal_id']),
    actorKind: row['actor_kind'],
    reason: String(row['reason']),
  };
  const parsed = CostAdjustmentHistoryEntrySchema.safeParse(mapped);
  if (!parsed.success) throw unavailable('stored financial adjustment history failed validation');
  return parsed.data;
}

function replayResult(raw: unknown): CostAdjustmentCommandResult {
  const parsed = CostAdjustmentCommandResultSchema.safeParse(raw);
  if (!parsed.success) throw unavailable('stored financial adjustment replay result is invalid');
  return { ...parsed.data, replayed: true };
}

function idempotencyActorFingerprint(tenantId: string, principalId: string): string {
  return sha256(canonicalize({ purpose: 'cost-adjustment', tenantId, principalId }));
}

function requestHash(command: CostAdjustmentCommand): string {
  return sha256(canonicalize(command));
}

function validateIdempotencyKey(value: string): void {
  if (typeof value !== 'string' || value.length < 8 || value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new HttpError(422, 'INVALID_ARGUMENT', 'Idempotency-Key is invalid');
  }
}

async function lockAdvisory(client: Pick<PoolClient, 'query'>, key: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

function quotaLockKey(pin: Eligibility['pins'][number]): string {
  // Matches reservation-groups.ts lockGroupWindows() encoding exactly.
  return JSON.stringify([pin.scopeKey, pin.windowStart, pin.windowEnd]);
}

async function lockQuotaWindows(client: Pick<PoolClient, 'query'>, pins: Eligibility['pins']): Promise<void> {
  const keys = [...new Set(pins.map(quotaLockKey))].sort();
  for (const key of keys) await lockAdvisory(client, `cost-quota:${key}`);
}

function validateEvidenceDbMatch(row: EvidenceDbRow | undefined, pin: CostAdjustmentEvidencePin): void {
  if (!row || row.id !== pin.artifactId || row.tenant_id !== pin.tenantId || row.state !== 'READY' || row.purpose !== 'input'
    || row.storage_generation_id !== pin.storageGenerationId || row.storage_version_id !== pin.storageVersionId
    || row.manifest_version_id !== pin.sidecarVersionId || row.file_name !== pin.fileName || row.mime_type !== pin.mimeType
    || safeInteger(row.size_bytes, 'artifact database metadata size') !== pin.databaseMetadata.sizeBytes
    || normalizeHexDigest(row.sha256 ?? '') !== normalizeHexDigest(pin.databaseMetadata.sha256)) {
    throw unprocessable('COST_ADJUSTMENT_EVIDENCE_CHANGED', 'The selected evidence no longer matches its verified immutable storage pins.');
  }
}

function makeAuditInput(command: CostAdjustmentCommand, actor: AdjustmentReader, revision: number) {
  return {
    tenantId: command.tenantId,
    actor: `admin:${actor.principalId}`,
    actorIssuer: actor.issuer,
    actorSub: actor.sub,
    actorRole: 'admin',
    action: command.kind === 'correction' ? 'cost_adjustment.correction' : 'cost_adjustment.refund',
    resource: `usage-event:${command.rootEventId}@${revision}`,
    severity: 'warning' as const,
  };
}

export function createCostAdjustmentService(deps: CostAdjustmentServiceDependencies) {
  const now = deps.now ?? (() => new Date());

  return {
    async getHistory(input: CostAdjustmentQuery, actor: AdjustmentReader): Promise<CostAdjustmentHistoryPage> {
      const parsedQuery = CostAdjustmentQuerySchema.safeParse(input);
      if (!parsedQuery.success) throw zodIssuesToProblem(parsedQuery.error.issues);
      const query = parsedQuery.data;
      const scope = authorizeRead(actor, query.tenantId);
      if (query.cursor) {
        const cursor = decodeHistoryCursor(query.cursor);
        if (cursor.tenantId !== query.tenantId || cursor.rootEventId !== query.rootEventId
          || cursor.queryHash !== historyQueryHash(query.tenantId, query.rootEventId, scope)) {
          throw new HttpError(422, 'INVALID_ARGUMENT', 'cost adjustment cursor is invalid for this query');
        }
      }
      const beforeRevision = query.cursor ? decodeHistoryCursor(query.cursor).beforeRevision : Number.MAX_SAFE_INTEGER;
      return deps.db.tx(async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const root = await readRoot(client, query.tenantId, query.rootEventId, scope);
        if (!root) {
          return CostAdjustmentHistoryPageSchema.parse({
            tenantId: query.tenantId, rootEventId: query.rootEventId, adjustmentRevision: 0,
            headAdjustmentEventId: null, eligible: false, blockers: ['ROOT_NOT_FOUND'],
            initialChargeMicrousd: null, grossChargeMicrousd: null, refundedMicrousd: null,
            netChargeMicrousd: null, originalAttribution: null, items: [], limit: query.limit, nextCursor: null,
          });
        }
        const eligibility = await loadEligibility(client, root);
        const adjustmentsResult = await client.query<EffectiveChargeAdjustmentRow>(
          `SELECT adjustment_event_id::text AS adjustment_event_id,root_event_id,tenant_id::text AS tenant_id,
                  adjustment_revision::text AS adjustment_revision,previous_adjustment_event_id::text AS previous_adjustment_event_id,
                  kind,target_charge_microusd::text AS target_charge_microusd,refund_microusd::text AS refund_microusd,
                  initial_charge_microusd::text AS initial_charge_microusd,gross_charge_microusd::text AS gross_charge_microusd,
                  refunded_microusd::text AS refunded_microusd,net_charge_microusd::text AS net_charge_microusd,
                  effective_at,quota_window_pins,recorded_at,
                  evidence_object_size_bytes,evidence_object_sha256
             FROM usage_financial_adjustments WHERE root_event_id=$1 AND tenant_id=$2
             ORDER BY adjustment_revision ASC LIMIT $3`,
          [query.rootEventId, query.tenantId, MAX_ADJUSTMENT_CHAIN + 1],
        );
        if (adjustmentsResult.rows.length > MAX_ADJUSTMENT_CHAIN) throw unavailable('financial adjustment history exceeds its safe processing bound');
        if (adjustmentsResult.rows.some((row) => row.evidence_object_size_bytes === null
            || row.evidence_object_size_bytes === undefined || row.evidence_object_sha256 === null
            || row.evidence_object_sha256 === undefined)) {
          eligibility.blockers.push('EVIDENCE_PIN_INCOMPLETE');
        }
        const projection = projectEffectiveCharge(root, adjustmentsResult.rows);
        const headResult = await client.query<HeadRow>(
          `SELECT root_event_id,tenant_id::text AS tenant_id,adjustment_revision::text AS adjustment_revision,
                  head_adjustment_event_id::text AS head_adjustment_event_id,
                  initial_charge_microusd::text AS initial_charge_microusd,gross_charge_microusd::text AS gross_charge_microusd,
                  refunded_microusd::text AS refunded_microusd,net_charge_microusd::text AS net_charge_microusd
             FROM usage_financial_adjustment_heads WHERE root_event_id=$1 AND tenant_id=$2`,
          [query.rootEventId, query.tenantId],
        );
        const head = headResult.rows[0];
        if (adjustmentsResult.rows.length > 0 && !head) throw unavailable('financial adjustment head is missing for a committed ledger');
        if (head && (Number(head.adjustment_revision) !== projection.adjustmentRevision
          || head.head_adjustment_event_id !== projection.headAdjustmentEventId
          || safeInteger(head.initial_charge_microusd, 'head initial charge') !== projection.initialChargeMicrousd
          || safeInteger(head.gross_charge_microusd, 'head gross charge') !== projection.grossChargeMicrousd
          || safeInteger(head.refunded_microusd, 'head refunds') !== projection.refundedMicrousd
          || safeInteger(head.net_charge_microusd, 'head net charge') !== projection.netChargeMicrousd)) {
          throw unavailable('financial adjustment head does not match its append-only ledger');
        }
        const pageResult = await client.query<EffectiveChargeAdjustmentRow & Record<string, unknown>>(
          `SELECT adjustment_event_id::text AS adjustment_event_id,root_event_id,tenant_id::text AS tenant_id,
                  adjustment_revision::text AS adjustment_revision,previous_adjustment_event_id::text AS previous_adjustment_event_id,
                  kind,target_charge_microusd::text AS target_charge_microusd,refund_microusd::text AS refund_microusd,
                  initial_charge_microusd::text AS initial_charge_microusd,gross_charge_microusd::text AS gross_charge_microusd,
                  refunded_microusd::text AS refunded_microusd,net_charge_microusd::text AS net_charge_microusd,
                  effective_at,quota_window_pins,recorded_at,evidence_artifact_id::text AS evidence_artifact_id,
                  evidence_storage_generation_id::text AS evidence_storage_generation_id,evidence_sha256,
                  evidence_size_bytes,evidence_object_version_id,evidence_object_size_bytes,evidence_object_sha256,
                  evidence_sidecar_version_id,evidence_sidecar_sha256,
                  evidence_sidecar_size_bytes,actor_principal_id::text AS actor_principal_id,actor_kind,reason
             FROM usage_financial_adjustments WHERE root_event_id=$1 AND tenant_id=$2 AND adjustment_revision<$3
             ORDER BY adjustment_revision DESC LIMIT $4`,
          [query.rootEventId, query.tenantId, beforeRevision, query.limit + 1],
        );
        const hasMore = pageResult.rows.length > query.limit;
        const rows = pageResult.rows.slice(0, query.limit);
        const items = rows.map(mapAdjustment);
        let nextCursor: string | null = null;
        if (hasMore && rows.length > 0) {
          nextCursor = encodeHistoryCursor({ tenantId: query.tenantId, rootEventId: query.rootEventId,
            queryHash: historyQueryHash(query.tenantId, query.rootEventId, scope), beforeRevision: Number(rows[rows.length - 1]!.adjustment_revision) });
        }
        return CostAdjustmentHistoryPageSchema.parse({
          tenantId: query.tenantId,
          rootEventId: query.rootEventId,
          adjustmentRevision: projection.adjustmentRevision,
          headAdjustmentEventId: projection.headAdjustmentEventId,
          eligible: eligibility.blockers.length === 0,
          blockers: eligibility.blockers,
          initialChargeMicrousd: projection.initialChargeMicrousd,
          grossChargeMicrousd: projection.grossChargeMicrousd,
          refundedMicrousd: projection.refundedMicrousd,
          netChargeMicrousd: projection.netChargeMicrousd,
          originalAttribution: eligibility.attribution,
          items,
          limit: query.limit,
          nextCursor,
        });
      });
    },

    async listEvidence(input: CostAdjustmentEvidenceQuery, actor: AdjustmentReader): Promise<CostAdjustmentEvidencePage> {
      const parsedQuery = CostAdjustmentEvidenceQuerySchema.safeParse(input);
      if (!parsedQuery.success) throw zodIssuesToProblem(parsedQuery.error.issues);
      const query = parsedQuery.data;
      const scope = authorizeRead(actor, query.tenantId);
      const queryHash = evidenceQueryHash(query, scope);
      let cursor: ReturnType<typeof decodeEvidenceCursor> | undefined;
      if (query.cursor) {
        cursor = decodeEvidenceCursor(query.cursor);
        if (cursor.tenantId !== query.tenantId || cursor.queryHash !== queryHash) {
          throw new HttpError(422, 'INVALID_ARGUMENT', 'cost evidence cursor is invalid for this query');
        }
      }
      const params: unknown[] = [query.tenantId];
      const where = ["a.tenant_id=$1", "a.state='READY'", "a.purpose='input'", 'a.size_bytes IS NOT NULL',
        'a.sha256 IS NOT NULL', 'a.storage_generation_id IS NOT NULL', 'a.storage_version_id IS NOT NULL',
        'a.manifest_version_id IS NOT NULL'];
      const bind = (value: unknown): string => { params.push(value); return `$${params.length}`; };
      appendLocalUserUsageFence(where, bind, scope);
      if (query.q) {
        params.push(`%${query.q.replace(/[\\%_]/g, '\\$&')}%`);
        where.push(`a.file_name ILIKE $${params.length} ESCAPE '\\'`);
      }
      if (cursor) {
        params.push(cursor.afterCreatedAt, cursor.afterArtifactId);
        const created = `$${params.length - 1}`;
        const id = `$${params.length}`;
        where.push(`(a.created_at < ${created} OR (a.created_at = ${created} AND a.id < ${id}::uuid))`);
      }
      params.push(query.limit + 1);
      const candidates = await deps.db.query<EvidenceDbRow>(
        `SELECT a.id::text AS id,a.tenant_id::text AS tenant_id,a.operation_id::text AS operation_id,
                a.purpose,a.state,a.file_name,a.mime_type,a.size_bytes::text AS size_bytes,a.sha256,
                a.storage_generation_id::text AS storage_generation_id,a.storage_version_id,a.manifest_version_id,
                a.created_at,a.created_at::text AS created_at_key
           FROM artifacts a LEFT JOIN operations o ON o.id=a.operation_id
          WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC,a.id DESC LIMIT $${params.length}`,
        params,
      );
      const rows = candidates.rows.slice(0, query.limit);
      const verified: CostAdjustmentEvidencePin[] = [];
      for (const row of rows) {
        try {
          const pin = await deps.artifacts.resolveCostAdjustmentEvidencePin({ tenantId: query.tenantId, artifactId: row.id });
          if (!pin) continue;
          assertEvidencePin(pin, query.tenantId, row.id);
          const stableRow: EvidenceDbRow = row;
          validateEvidenceDbMatch(stableRow, pin);
          verified.push(pin);
        } catch (error) {
          if (error instanceof HttpError && error.status < 500) continue;
          throw unavailable('evidence storage verification is temporarily unavailable');
        }
      }
      let nextCursor: string | null = null;
      if (candidates.rows.length > query.limit && rows.length > 0) {
        const last = rows[rows.length - 1]!;
        nextCursor = encodeEvidenceCursor({ tenantId: query.tenantId, queryHash,
          // Keep PostgreSQL's textual timestamp precision (microseconds); JS
          // Date truncation can otherwise skip rows sharing a millisecond.
          afterCreatedAt: last.created_at_key, afterArtifactId: last.id });
      }
      return CostAdjustmentEvidencePageSchema.parse({
        tenantId: query.tenantId,
        items: verified.map((pin) => ({
          artifactId: pin.artifactId,
          fileName: pin.fileName,
          mimeType: pin.mimeType,
          sizeBytes: pin.sizeBytes,
          sha256: `sha256:${normalizeHexDigest(pin.sha256)}`,
          createdAt: toIso(pin.createdAt, 'evidence createdAt'),
        })),
        limit: query.limit,
        nextCursor,
      });
    },

    async adjust(input: CostAdjustmentCommand, actor: AdjustmentReader, idempotencyKey: string): Promise<CostAdjustmentCommandResult> {
      const writer = authorizeWriter(actor);
      const assertWriterCurrent = deps.assertWriterCurrent;
      if (!assertWriterCurrent) throw unavailable('Financial adjustment is disabled because current Admin authority cannot be revalidated.');
      if (!actor.sessionId || actor.sessionId.length > 512) throw forbidden('a current Admin cookie session is required');
      const parsedCommand = CostAdjustmentCommandSchema.safeParse(input);
      if (!parsedCommand.success) throw zodIssuesToProblem(parsedCommand.error.issues);
      const command = parsedCommand.data;
      validateIdempotencyKey(idempotencyKey);
      const actorFingerprint = idempotencyActorFingerprint(command.tenantId, writer.actorPrincipalId);
      const commandHash = requestHash(command);

      // An exact committed replay has no write effects and may return while a
      // backup snapshot fence is held. Authentication and request identity
      // are still checked before looking up the command.
      const prior = await deps.db.tx(async (client) => {
        // A replay has no write effects and may bypass the backup gate, but
        // it must still recheck the live Admin session before reading money.
        await assertWriterCurrent(actor, client);
        return client.query<CommandRow>(
          `SELECT request_hash,result FROM usage_financial_adjustment_commands
            WHERE tenant_id=$1 AND actor_fingerprint=$2 AND idempotency_key=$3`,
          [command.tenantId, actorFingerprint, idempotencyKey],
        );
      });
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== commandHash) throw conflict('IDEMPOTENCY_CONFLICT', 'Idempotency-Key is already bound to a different financial adjustment.');
        if (prior.rows[0].result !== null) return replayResult(prior.rows[0].result);
        throw conflict('COST_ADJUSTMENT_IN_PROGRESS', 'The financial adjustment command is still being completed.');
      }

      const evidence = await deps.artifacts.resolveCostAdjustmentEvidencePin({ tenantId: command.tenantId, artifactId: command.evidenceArtifactId });
      if (!evidence) throw unprocessable('COST_ADJUSTMENT_EVIDENCE_UNAVAILABLE', 'The selected evidence is unavailable or cannot be verified.');
      assertEvidencePin(evidence, command.tenantId, command.evidenceArtifactId);

      if (!deps.backupSnapshotWriteGate) throw unavailable('Financial adjustment is disabled because the backup write gate is unavailable.');
      return deps.db.tx(async (client) => {
        // This must be the transaction's first row lock and remains held
        // through ledger, head, command and audit commit.
        await deps.backupSnapshotWriteGate!.assertWriteAllowed(client, {
          tenantId: command.tenantId, domain: 'financial-adjustment',
          requestKey: sha256(`${actorFingerprint}:${idempotencyKey}`),
        });
        await assertWriterCurrent(actor, client);
        await lockAdvisory(client, `cost-policy-selection:${command.tenantId}`);
        await client.query(
          `INSERT INTO usage_financial_adjustment_commands(tenant_id,actor_fingerprint,idempotency_key,request_hash)
           VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [command.tenantId, actorFingerprint, idempotencyKey, commandHash],
        );
        const commandSelected = await client.query<CommandRow>(
          `SELECT request_hash,result FROM usage_financial_adjustment_commands
            WHERE tenant_id=$1 AND actor_fingerprint=$2 AND idempotency_key=$3 FOR UPDATE`,
          [command.tenantId, actorFingerprint, idempotencyKey],
        );
        const commandRow = commandSelected.rows[0];
        if (!commandRow) throw unavailable('financial adjustment command could not be persisted');
        if (commandRow.request_hash !== commandHash) throw conflict('IDEMPOTENCY_CONFLICT', 'Idempotency-Key is already bound to a different financial adjustment.');
        if (commandRow.result !== null) return replayResult(commandRow.result);

        const root = await readRoot(client, command.tenantId, command.rootEventId, undefined, true);
        if (!root) throw notFound('not found');
        const eligibility = await loadEligibility(client, root);
        if (eligibility.group) {
          await lockAdvisory(client, `cost-group:${eligibility.group.reservation_group_id}`);
          const locked = await client.query<GroupRow>(
            `SELECT reservation_group_id::text AS reservation_group_id,tenant_id::text AS tenant_id,
                    operation_id::text AS operation_id,task_id::text AS task_id,invocation_id,attempt,state,usage_event_id
               FROM cost_reservation_groups WHERE reservation_group_id=$1 FOR UPDATE`,
            [eligibility.group.reservation_group_id],
          );
          eligibility.group = locked.rows[0] ?? null;
          if (!eligibility.group || eligibility.group.state !== 'SETTLED' || eligibility.group.usage_event_id !== root.event_id) {
            if (eligibility.group?.state === 'UNKNOWN') throw unprocessable('COST_ADJUSTMENT_INELIGIBLE', 'An unresolved invocation cannot receive a financial adjustment.');
            throw unprocessable('COST_ADJUSTMENT_INELIGIBLE', 'The original usage settlement is incomplete.');
          }
        }
        if (eligibility.blockers.length > 0 || !eligibility.event || !eligibility.attribution || !eligibility.group) {
          const blocker = eligibility.blockers.includes('RESERVATION_UNKNOWN')
            ? 'An unresolved invocation cannot receive a financial adjustment.'
            : 'The original usage event lacks complete trusted pricing, attribution, or settlement evidence.';
          throw unprocessable('COST_ADJUSTMENT_INELIGIBLE', blocker);
        }

        const adjustmentRows = await client.query<EffectiveChargeAdjustmentRow>(
          `SELECT adjustment_event_id::text AS adjustment_event_id,root_event_id,tenant_id::text AS tenant_id,
                  adjustment_revision::text AS adjustment_revision,previous_adjustment_event_id::text AS previous_adjustment_event_id,
                  kind,target_charge_microusd::text AS target_charge_microusd,refund_microusd::text AS refund_microusd,
                  initial_charge_microusd::text AS initial_charge_microusd,gross_charge_microusd::text AS gross_charge_microusd,
                  refunded_microusd::text AS refunded_microusd,net_charge_microusd::text AS net_charge_microusd,
                  effective_at,quota_window_pins,recorded_at,
                  evidence_object_size_bytes,evidence_object_sha256
             FROM usage_financial_adjustments WHERE root_event_id=$1 AND tenant_id=$2
             ORDER BY adjustment_revision ASC LIMIT $3`,
          [command.rootEventId, command.tenantId, MAX_ADJUSTMENT_CHAIN + 1],
        );
        if (adjustmentRows.rows.length > MAX_ADJUSTMENT_CHAIN) throw unavailable('financial adjustment history exceeds its safe processing bound');
        if (adjustmentRows.rows.some((row) => row.evidence_object_size_bytes === null
            || row.evidence_object_size_bytes === undefined || row.evidence_object_sha256 === null
            || row.evidence_object_sha256 === undefined)) {
          throw unprocessable('COST_ADJUSTMENT_EVIDENCE_PIN_INCOMPLETE', 'Earlier history lacks a verifiable raw storage-object proof, so it cannot be extended.');
        }
        const projection = projectEffectiveCharge(root, adjustmentRows.rows);
        const initial = projection.initialChargeMicrousd;
        const currentGross = projection.grossChargeMicrousd;
        const currentRefunded = projection.refundedMicrousd;
        const currentNet = projection.netChargeMicrousd;
        if (initial === null || currentGross === null || currentRefunded === null || currentNet === null || !projection.event) {
          throw unprocessable('COST_ADJUSTMENT_INELIGIBLE', 'The original charge amount is not available as a trusted integer.');
        }

        await client.query(
          `INSERT INTO usage_financial_adjustment_heads(root_event_id,tenant_id,adjustment_revision,head_adjustment_event_id,
              initial_charge_microusd,gross_charge_microusd,refunded_microusd,net_charge_microusd)
           VALUES($1,$2,0,NULL,$3,$3,0,$3) ON CONFLICT(root_event_id) DO NOTHING`,
          [command.rootEventId, command.tenantId, initial],
        );
        const headSelected = await client.query<HeadRow>(
          `SELECT root_event_id,tenant_id::text AS tenant_id,adjustment_revision::text AS adjustment_revision,
                  head_adjustment_event_id::text AS head_adjustment_event_id,
                  initial_charge_microusd::text AS initial_charge_microusd,gross_charge_microusd::text AS gross_charge_microusd,
                  refunded_microusd::text AS refunded_microusd,net_charge_microusd::text AS net_charge_microusd
             FROM usage_financial_adjustment_heads WHERE root_event_id=$1 AND tenant_id=$2 FOR UPDATE`,
          [command.rootEventId, command.tenantId],
        );
        const head = headSelected.rows[0];
        if (!head || Number(head.adjustment_revision) !== projection.adjustmentRevision
          || head.head_adjustment_event_id !== projection.headAdjustmentEventId
          || safeInteger(head.initial_charge_microusd, 'head initial') !== initial
          || safeInteger(head.gross_charge_microusd, 'head gross') !== currentGross
          || safeInteger(head.refunded_microusd, 'head refunded') !== currentRefunded
          || safeInteger(head.net_charge_microusd, 'head net') !== currentNet) {
          throw unavailable('financial adjustment head does not match its append-only ledger');
        }
        if (projection.adjustmentRevision !== command.expectedAdjustmentRevision) {
          throw conflict('COST_ADJUSTMENT_CAS_CONFLICT', 'The financial adjustment history changed; reload the current history.');
        }

        const artifactSelected = await client.query<EvidenceDbRow>(
          `SELECT id::text AS id,tenant_id::text AS tenant_id,operation_id::text AS operation_id,purpose,state,file_name,mime_type,
                  size_bytes::text AS size_bytes,sha256,storage_generation_id::text AS storage_generation_id,
                  storage_version_id,manifest_version_id,created_at
             FROM artifacts WHERE id=$1 AND tenant_id=$2 FOR SHARE`,
          [evidence.artifactId, evidence.tenantId],
        );
        validateEvidenceDbMatch(artifactSelected.rows[0], evidence);
        await lockQuotaWindows(client, eligibility.pins);

        const nextGross = command.kind === 'correction' ? command.targetChargeMicrousd : currentGross;
        const nextRefunded = command.kind === 'refund' ? addSafe(currentRefunded, command.refundMicrousd, 'refund total') : currentRefunded;
        if (nextGross < nextRefunded) throw unprocessable('COST_ADJUSTMENT_OVER_REFUND', 'A corrected gross charge cannot be lower than already accepted refunds.');
        if (command.kind === 'refund' && command.refundMicrousd > currentNet) throw unprocessable('COST_ADJUSTMENT_OVER_REFUND', 'A refund cannot exceed the current net charge.');
        if (command.kind === 'correction' && command.targetChargeMicrousd === currentGross) {
          const recordedAt = now();
          if (!Number.isFinite(recordedAt.getTime())) throw unavailable('financial adjustment clock is invalid');
          const result = CostAdjustmentCommandResultSchema.parse({
            outcome: 'NOOP', adjustmentEventId: null, rootEventId: command.rootEventId,
            adjustmentRevision: projection.adjustmentRevision, initialChargeMicrousd: initial,
            grossChargeMicrousd: currentGross, refundedMicrousd: currentRefunded, netChargeMicrousd: currentNet,
            effectiveAt: toIso(projection.event.occurredAt, 'original occurredAt'), recordedAt: recordedAt.toISOString(), replayed: false,
          });
          await deps.audit.record(makeAuditInput(command, actor, projection.adjustmentRevision), client);
          await client.query(
            `UPDATE usage_financial_adjustment_commands SET result=$4::jsonb,completed_at=$5
              WHERE tenant_id=$1 AND actor_fingerprint=$2 AND idempotency_key=$3`,
            [command.tenantId, actorFingerprint, idempotencyKey, JSON.stringify(result), recordedAt.toISOString()],
          );
          return result;
        }
        const nextRevision = projection.adjustmentRevision + 1;
        if (!Number.isSafeInteger(nextRevision)) throw unavailable('financial adjustment revision exceeds the supported range');
        const nextNet = nextGross - nextRefunded;
        const eventId = randomUUID();
        const recordedAt = now();
        if (!Number.isFinite(recordedAt.getTime())) throw unavailable('financial adjustment clock is invalid');
        const effectiveAt = toIso(projection.event.occurredAt, 'original occurredAt');
        const previous = projection.headAdjustmentEventId;
        const priceDigest = eligibility.attribution.priceSnapshotDigest;
        const provenanceDigest = eligibility.attribution.provenanceDigest;
        const evidenceObjectProofComplete = Number.isSafeInteger(evidence.objectSizeBytes)
          && evidence.objectSizeBytes > 0
          && normalizeHexDigest(evidence.objectSha256) !== null;
        if (!evidenceObjectProofComplete) {
          throw unprocessable('COST_ADJUSTMENT_EVIDENCE_PIN_INCOMPLETE', 'The selected evidence lacks a complete exact-version object proof.');
        }
        const adjustmentRecord = {
          adjustmentEventId: eventId,
          rootEventId: command.rootEventId,
          adjustmentRevision: nextRevision,
          previousAdjustmentEventId: previous,
          kind: command.kind,
          targetChargeMicrousd: command.kind === 'correction' ? command.targetChargeMicrousd : null,
          refundMicrousd: command.kind === 'refund' ? command.refundMicrousd : null,
          initialChargeMicrousd: initial,
          grossChargeMicrousd: nextGross,
          refundedMicrousd: nextRefunded,
          netChargeMicrousd: nextNet,
          effectiveAt,
          quotaWindowPins: eligibility.pins,
          recordedAt: recordedAt.toISOString(),
          evidenceArtifactId: evidence.artifactId,
          evidenceStorageGenerationId: evidence.storageGenerationId,
          evidenceSha256: `sha256:${normalizeHexDigest(evidence.sha256)}`,
          evidenceSizeBytes: evidence.sizeBytes,
          evidenceObjectSizeBytes: evidence.objectSizeBytes,
          evidenceObjectSha256: `sha256:${normalizeHexDigest(evidence.objectSha256)}`,
          evidenceObjectProofComplete,
          evidenceObjectVersionId: evidence.storageVersionId,
          evidenceSidecarVersionId: evidence.sidecarVersionId,
          evidenceSidecarSha256: `sha256:${normalizeHexDigest(evidence.sidecarSha256)}`,
          evidenceSidecarSizeBytes: evidence.sidecarSizeBytes,
          authority: 'platform-admin-approved' as const,
          actorPrincipalId: writer.actorPrincipalId,
          actorKind: writer.actorKind,
          reason: command.reason,
        };
        CostAdjustmentHistoryEntrySchema.parse(adjustmentRecord);
        await client.query(
          `INSERT INTO usage_financial_adjustments(
             adjustment_event_id,root_event_id,tenant_id,adjustment_revision,previous_adjustment_event_id,kind,
             target_charge_microusd,refund_microusd,initial_charge_microusd,gross_charge_microusd,refunded_microusd,
             net_charge_microusd,effective_at,quota_window_pins,original_attribution,price_snapshot_digest,provenance_digest,
             evidence_artifact_id,evidence_storage_generation_id,evidence_sha256,evidence_size_bytes,evidence_object_version_id,
             evidence_object_size_bytes,evidence_object_sha256,evidence_sidecar_version_id,evidence_sidecar_sha256,
             evidence_sidecar_size_bytes,actor_principal_id,actor_kind,reason,recorded_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,
                  $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)`,
          [eventId,command.rootEventId,command.tenantId,nextRevision,previous,command.kind,
            command.kind === 'correction' ? command.targetChargeMicrousd : null,
            command.kind === 'refund' ? command.refundMicrousd : null,
            initial,nextGross,nextRefunded,nextNet,effectiveAt,JSON.stringify(eligibility.pins),JSON.stringify(eligibility.attribution),
            priceDigest,provenanceDigest,evidence.artifactId,evidence.storageGenerationId,`sha256:${normalizeHexDigest(evidence.sha256)}`,
            evidence.sizeBytes,evidence.storageVersionId,evidence.objectSizeBytes,`sha256:${normalizeHexDigest(evidence.objectSha256)}`,
            evidence.sidecarVersionId,`sha256:${normalizeHexDigest(evidence.sidecarSha256)}`,
            evidence.sidecarSizeBytes,writer.actorPrincipalId,writer.actorKind,command.reason,recordedAt.toISOString()],
        );
        const updated = await client.query(
          `UPDATE usage_financial_adjustment_heads
              SET adjustment_revision=$3,head_adjustment_event_id=$4,initial_charge_microusd=$5,
                  gross_charge_microusd=$6,refunded_microusd=$7,net_charge_microusd=$8,updated_at=$9
            WHERE root_event_id=$1 AND tenant_id=$2 AND adjustment_revision=$10`,
          [command.rootEventId,command.tenantId,nextRevision,eventId,initial,nextGross,nextRefunded,nextNet,
            recordedAt.toISOString(),projection.adjustmentRevision],
        );
        if (updated.rowCount !== 1) throw conflict('COST_ADJUSTMENT_CAS_CONFLICT', 'The financial adjustment head changed; reload the current history.');
        const result = CostAdjustmentCommandResultSchema.parse({
          outcome: 'ADJUSTED', adjustmentEventId: eventId, rootEventId: command.rootEventId,
          adjustmentRevision: nextRevision, initialChargeMicrousd: initial, grossChargeMicrousd: nextGross,
          refundedMicrousd: nextRefunded, netChargeMicrousd: nextNet, effectiveAt,
          recordedAt: recordedAt.toISOString(), replayed: false,
        });
        await deps.audit.record(makeAuditInput(command, actor, nextRevision), client);
        await client.query(
          `UPDATE usage_financial_adjustment_commands SET result=$4::jsonb,completed_at=$5
            WHERE tenant_id=$1 AND actor_fingerprint=$2 AND idempotency_key=$3`,
          [command.tenantId,actorFingerprint,idempotencyKey,JSON.stringify(result),recordedAt.toISOString()],
        );
        return result;
      });
    },
  };
}

