import { randomUUID } from 'node:crypto';
import {
  GlobalSettingsMutationResultSchema,
  GlobalSettingsPublishRequestSchema,
  GlobalSettingsRollbackRequestSchema,
  PlatformRetentionDraftRequestSchema,
  PlatformRetentionReadSchema,
  PlatformRetentionRevisionSchema,
  PlatformRetentionSettingsSchema,
  TenantAiDefaultsSchema,
  TenantAiDraftRequestSchema,
  TenantAiRevisionSchema,
  TenantAiTestRequestSchema,
  TenantAiTestResultSchema,
  TenantGlobalSettingsReadSchema,
  TenantPromptDefaultsSchema,
  TenantPromptDraftRequestSchema,
  TenantPromptRevisionSchema,
  TenantDefaultsSnapshotSchema,
  type GlobalSettingsMutationResult,
  type GlobalSettingsPublishRequest,
  type GlobalSettingsRollbackRequest,
  type PlatformRetentionDraftRequest,
  type PlatformRetentionRead,
  type PlatformRetentionSettings,
  type TenantAiDefaults,
  type TenantAiDraftRequest,
  type TenantAiRevision,
  type TenantAiTestRequest,
  type TenantAiTestResult,
  type TenantDefaultsSnapshot,
  type TenantGlobalSettingsRead,
  type TenantPromptDefaults,
  type TenantPromptDraftRequest,
  type TenantPromptRevision,
  type ProviderTestRequest,
  type ProviderTestResult,
} from '@du/contracts';
import type { PoolClient } from 'pg';
import type { Db } from '../../db/db';
import { HttpError } from '../../http/errors';
import type { AuditService } from '../audit/audit';
import type { BackupSnapshotWriteGate } from '../maintenance/backup-effect-fence';
import type { ConnectorManagementStore } from '../connectors/connector-management-store';
import type { MetadataCrypto } from '../runtime/metadata-crypto';
import { metadataPlaintextHash } from '../runtime/metadata-crypto';
import { DEFAULT_TENANT_AI_DEFAULTS, DEFAULT_TENANT_PROMPTS } from './defaults';
import { createTenantDefaultsSnapshot } from './snapshot';

const DEFAULT_RETENTION: PlatformRetentionSettings = {
  cacheTtlHours: 168,
  outputRetentionDays: 0,
  cleanupIntervalSeconds: 3600,
};
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_HISTORY = 50;

export interface GlobalSettingsActor {
  label: string;
  issuer?: string;
  sub?: string;
  role?: string;
}

export interface GlobalSettingsServiceOptions {
  metadataCrypto?: MetadataCrypto;
  connectorManagement?: ConnectorManagementStore;
  backupSnapshotWriteGate?: BackupSnapshotWriteGate;
  providerTestAvailable?: boolean;
  /** Runs after the durable platform retention head changes. */
  onRetentionPolicyChanged?: () => void;
  now?: () => Date;
}

interface TenantHeadRow {
  tenant_id: string;
  stream: 'ai' | 'prompts';
  active_revision: number | null;
  draft_revision: number | null;
  next_revision: number;
}
interface TenantRevisionRow {
  tenant_id: string;
  stream: 'ai' | 'prompts';
  revision: number;
  state: 'DRAFT' | 'TESTED' | 'PUBLISHED' | 'SUPERSEDED';
  payload_ref: unknown;
  content_digest: string;
  actor: string;
  tested_at: Date | string | null;
  source_revision: number | null;
  published_at?: Date | string | null;
  created_at: Date | string;
}
interface RetentionRow {
  revision: number;
  state: 'DRAFT' | 'TESTED' | 'PUBLISHED' | 'SUPERSEDED';
  settings: unknown;
  digest: string;
  actor: string;
  source_revision: number | null;
  published_at?: Date | string | null;
  created_at: Date | string;
}

function invalid(message: string): never { throw new HttpError(422, 'INVALID_SCHEMA', message); }
function conflict(message: string): never { throw new HttpError(409, 'STATE_CONFLICT', message); }
function iso(value: Date | string | null): string | null {
  return value === null ? null : (value instanceof Date ? value.toISOString() : new Date(value).toISOString());
}
function digest(value: unknown): string { return `sha256:${metadataPlaintextHash(value)}`; }
function requireTenant(tenantId: string): void {
  if (!TENANT_ID.test(tenantId)) invalid('tenantId must be a UUID');
}
function requireCrypto(crypto: MetadataCrypto | undefined): MetadataCrypto {
  if (!crypto) throw new HttpError(503, 'METADATA_ENCRYPTION_REQUIRED', 'tenant-global settings require metadata encryption');
  return crypto;
}
function revisionContext(tenantId: string, stream: 'ai' | 'prompts', revision: number) {
  return { tenantId, slot: 'global_settings.tenant_revision' as const, refId: `${tenantId}:${stream}:${revision}` };
}
function safeParse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) invalid(message);
  return parsed.data;
}

function payloadSchema(stream: 'ai' | 'prompts') {
  return stream === 'ai' ? TenantAiDefaultsSchema : TenantPromptDefaultsSchema;
}

function testablePromptDefaults(value: TenantPromptDefaults): boolean {
  return ['{file1}', '{file2}'].every((token) => value.compare.includes(token))
    && ['{user_prompt}', '{input_content}'].every((token) => value.generate.includes(token));
}

function decodeIdempotencyResult(value: unknown): GlobalSettingsMutationResult {
  return safeParse(GlobalSettingsMutationResultSchema, value, 'stored global settings idempotency result is invalid');
}

async function findReplay(
  client: PoolClient,
  scope: string,
  key: string,
  requestHash: string,
): Promise<GlobalSettingsMutationResult | null> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`global-settings:${scope}:${key}`]);
  const result = await client.query<{ request_hash: string; result: unknown }>(
    'SELECT request_hash,result FROM global_settings_idempotency WHERE scope_key=$1 AND idempotency_key=$2 FOR UPDATE',
    [scope, key],
  );
  if (!result.rowCount) return null;
  if (result.rows[0]!.request_hash !== requestHash) conflict('Idempotency-Key was reused with different settings');
  return { ...decodeIdempotencyResult(result.rows[0]!.result), replayed: true };
}

async function remember(
  client: PoolClient,
  scope: string,
  key: string,
  requestHash: string,
  result: unknown,
): Promise<void> {
  await client.query(
    `INSERT INTO global_settings_idempotency(scope_key,idempotency_key,request_hash,result)
     VALUES($1,$2,$3,$4)`,
    [scope, key, requestHash, JSON.stringify(result)],
  );
}

async function rememberAny(client: PoolClient, scope: string, key: string, requestHash: string, result: unknown): Promise<void> {
  await client.query(
    `INSERT INTO global_settings_idempotency(scope_key,idempotency_key,request_hash,result)
     VALUES($1,$2,$3,$4)`,
    [scope, key, requestHash, JSON.stringify(result)],
  );
}

/**
 * A provider-test ACK can be lost after Connector accepted the invocation.
 * UNKNOWN is therefore retryable only as an evidence lookup through the same
 * provider-test idempotency key; definitive results remain immutable.
 */
function isUnresolvedTenantAiTest(result: TenantAiTestResult): boolean {
  // INVOCATION_UNKNOWN was the persisted code before retryable UNKNOWN was
  // normalized to the global-settings result vocabulary.
  return result.errorCode === 'PROVIDER_TEST_UNKNOWN' || result.errorCode === 'INVOCATION_UNKNOWN';
}

export async function persistTenantAiTestResult(
  client: PoolClient,
  scope: string,
  key: string,
  requestHash: string,
  result: TenantAiTestResult,
): Promise<{ result: TenantAiTestResult; changed: boolean }> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`global-settings:${scope}:${key}`]);
  const existing = await client.query<{ request_hash: string; result: unknown }>(
    'SELECT request_hash,result FROM global_settings_idempotency WHERE scope_key=$1 AND idempotency_key=$2 FOR UPDATE',
    [scope, key],
  );
  if (!existing.rowCount) {
    await rememberAny(client, scope, key, requestHash, result);
    return { result, changed: true };
  }
  const stored = existing.rows[0]!;
  if (stored.request_hash !== requestHash) conflict('Idempotency-Key was reused with different settings');
  const previous = safeParse(TenantAiTestResultSchema, stored.result, 'stored AI test idempotency result is invalid');
  if (!isUnresolvedTenantAiTest(previous) || isUnresolvedTenantAiTest(result)) {
    return { result: previous, changed: false };
  }
  await client.query(
    'UPDATE global_settings_idempotency SET result=$3 WHERE scope_key=$1 AND idempotency_key=$2 AND request_hash=$4',
    [scope, key, JSON.stringify(result), requestHash],
  );
  return { result, changed: true };
}

async function ensureTenantHead(client: PoolClient, tenantId: string, stream: 'ai' | 'prompts'): Promise<void> {
  await client.query(
    `INSERT INTO global_settings_tenant_heads(tenant_id,stream)
     SELECT $1,$2 WHERE EXISTS(SELECT 1 FROM tenants WHERE id=$1)
     ON CONFLICT(tenant_id,stream) DO NOTHING`,
    [tenantId, stream],
  );
  const found = await client.query('SELECT tenant_id FROM global_settings_tenant_heads WHERE tenant_id=$1 AND stream=$2', [tenantId, stream]);
  if (!found.rowCount) throw new HttpError(404, 'NOT_FOUND', 'tenant was not found');
}

async function readHead(db: Db, tenantId: string, stream: 'ai' | 'prompts'): Promise<TenantHeadRow> {
  const result = await db.query<TenantHeadRow>(
    'SELECT tenant_id,stream,active_revision,draft_revision,next_revision FROM global_settings_tenant_heads WHERE tenant_id=$1 AND stream=$2',
    [tenantId, stream],
  );
  if (result.rowCount) return result.rows[0]!;
  const tenant = await db.query('SELECT id FROM tenants WHERE id=$1', [tenantId]);
  if (!tenant.rowCount) throw new HttpError(404, 'NOT_FOUND', 'tenant was not found');
  return { tenant_id: tenantId, stream, active_revision: null, draft_revision: null, next_revision: 0 };
}

async function openRevision(
  row: TenantRevisionRow,
  crypto: MetadataCrypto | undefined,
): Promise<TenantAiDefaults | TenantPromptDefaults> {
  const seam = requireCrypto(crypto);
  const opened = await seam.readStored(row.payload_ref, revisionContext(row.tenant_id, row.stream, row.revision), false);
  if (digest(opened) !== row.content_digest) throw new HttpError(503, 'SETTINGS_INTEGRITY_ERROR', 'global settings revision failed its integrity check');
  return row.stream === 'ai'
    ? safeParse(TenantAiDefaultsSchema, opened, 'stored global settings revision has an invalid shape')
    : safeParse(TenantPromptDefaultsSchema, opened, 'stored global settings revision has an invalid shape');
}

function revisionProjection(row: TenantRevisionRow, settings: TenantAiDefaults | TenantPromptDefaults): TenantAiRevision | TenantPromptRevision {
  const common = {
    tenantId: row.tenant_id,
    revision: Number(row.revision),
    state: row.state,
    settings,
    digest: row.content_digest,
    createdAt: iso(row.created_at)!,
    actor: row.actor,
    sourceRevision: row.source_revision === null ? null : Number(row.source_revision),
  };
  return row.stream === 'ai'
    ? TenantAiRevisionSchema.parse({ ...common, testedAt: iso(row.tested_at) })
    : TenantPromptRevisionSchema.parse(common);
}

async function loadTenantRevisions(
  db: Db,
  tenantId: string,
  stream: 'ai' | 'prompts',
  crypto: MetadataCrypto | undefined,
): Promise<{ head: TenantHeadRow; active: TenantAiRevision | TenantPromptRevision | null; draft: TenantAiRevision | TenantPromptRevision | null; history: Array<TenantAiRevision | TenantPromptRevision> }> {
  const head = await readHead(db, tenantId, stream);
    const result = await db.query<TenantRevisionRow>(
      `SELECT tenant_id,stream,revision,state,payload_ref,content_digest,actor,tested_at,source_revision,published_at,created_at
     FROM global_settings_tenant_revisions WHERE tenant_id=$1 AND stream=$2 ORDER BY revision DESC LIMIT $3`,
    [tenantId, stream, MAX_HISTORY],
  );
  const details = await Promise.all(result.rows.map(async (row) => revisionProjection(row, await openRevision(row, crypto))));
  const find = (n: number | null) => n === null ? null : details.find((item) => item.revision === n) ?? null;
  return { head, active: find(head.active_revision), draft: find(head.draft_revision), history: details };
}

async function lockHead(client: PoolClient, tenantId: string, stream: 'ai' | 'prompts'): Promise<TenantHeadRow> {
  await ensureTenantHead(client, tenantId, stream);
  const result = await client.query<TenantHeadRow>(
    'SELECT tenant_id,stream,active_revision,draft_revision,next_revision FROM global_settings_tenant_heads WHERE tenant_id=$1 AND stream=$2 FOR UPDATE',
    [tenantId, stream],
  );
  return result.rows[0]!;
}

function mutationResult(tenantId: string | null, stream: GlobalSettingsMutationResult['stream'], revision: number, activeRevision: number, replayed = false): GlobalSettingsMutationResult {
  return GlobalSettingsMutationResultSchema.parse({ tenantId, stream, revision, activeRevision, replayed });
}

function requestHashWithoutKey<T extends { idempotencyKey: string }>(request: T): string {
  const { idempotencyKey: _key, ...intent } = request;
  return digest(intent);
}

async function quickReplay<T>(
  db: Db,
  scope: string,
  key: string,
  requestHash: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): Promise<T | null> {
  const result = await db.query<{ request_hash: string; result: unknown }>(
    'SELECT request_hash,result FROM global_settings_idempotency WHERE scope_key=$1 AND idempotency_key=$2',
    [scope, key],
  );
  if (!result.rowCount) return null;
  if (result.rows[0]!.request_hash !== requestHash) conflict('Idempotency-Key was reused with different settings');
  const parsed = schema.safeParse(result.rows[0]!.result);
  if (!parsed.success) throw new HttpError(503, 'SETTINGS_INTEGRITY_ERROR', 'stored settings idempotency result is invalid');
  return parsed.data;
}

async function sealedPayload(
  crypto: MetadataCrypto | undefined,
  tenantId: string,
  stream: 'ai' | 'prompts',
  revision: number,
  payload: TenantAiDefaults | TenantPromptDefaults,
): Promise<string> {
  const envelope = await requireCrypto(crypto).seal(payload, revisionContext(tenantId, stream, revision));
  return JSON.stringify(envelope);
}

export function createGlobalSettingsService(
  db: Db,
  audit: AuditService,
  options: GlobalSettingsServiceOptions = {},
) {
  const crypto = options.metadataCrypto;
  const now = options.now ?? (() => new Date());

  async function assertSnapshotWriteAllowed(client: PoolClient, tenantId: string | null, requestHash: string): Promise<void> {
    if (!options.backupSnapshotWriteGate) {
      throw new HttpError(503, 'BACKUP_WRITE_GATE_UNAVAILABLE', 'settings writes require the backup snapshot gate');
    }
    await options.backupSnapshotWriteGate.assertWriteAllowed(client, {
      tenantId,
      domain: 'global-settings-publication',
      requestKey: requestHash.replace(/^sha256:/, ''),
    });
  }

  async function getTenantDefaultsSnapshot(tenantId: string): Promise<TenantDefaultsSnapshot> {
    requireTenant(tenantId);
    const aiStream = await loadTenantRevisions(db, tenantId, 'ai', crypto);
    const promptStream = await loadTenantRevisions(db, tenantId, 'prompts', crypto);
    const ai = aiStream.active?.settings as TenantAiDefaults | undefined;
    const prompts = promptStream.active?.settings as TenantPromptDefaults | undefined;
    const base = {
      aiRevision: aiStream.head.active_revision === null ? null : Number(aiStream.head.active_revision),
      promptRevision: promptStream.head.active_revision === null ? null : Number(promptStream.head.active_revision),
      ai: ai ?? DEFAULT_TENANT_AI_DEFAULTS,
      prompts: prompts ?? DEFAULT_TENANT_PROMPTS,
    };
    return createTenantDefaultsSnapshot(base);
  }

  async function readTenant(tenantId: string): Promise<TenantGlobalSettingsRead> {
    requireTenant(tenantId);
    const [ai, prompts, effective] = await Promise.all([
      loadTenantRevisions(db, tenantId, 'ai', crypto),
      loadTenantRevisions(db, tenantId, 'prompts', crypto),
      getTenantDefaultsSnapshot(tenantId),
    ]);
    return TenantGlobalSettingsReadSchema.parse({
      tenantId,
      ai: { activeRevision: ai.head.active_revision === null ? null : Number(ai.head.active_revision), draft: ai.draft, history: ai.history },
      prompts: { activeRevision: prompts.head.active_revision === null ? null : Number(prompts.head.active_revision), draft: prompts.draft, history: prompts.history },
      effective,
      capability: {
        editable: Boolean(crypto),
        // A health/probe endpoint cannot attest that an invocation succeeded.
        // The BFF advertises testing only when the signed provider-test path
        // is composed with its Connector and grant dependencies.
        testable: Boolean(options.providerTestAvailable),
        reasonCode: crypto ? null : 'METADATA_ENCRYPTION_REQUIRED',
      },
    });
  }

  async function createTenantDraft<T extends TenantAiDraftRequest | TenantPromptDraftRequest>(
    tenantId: string,
    stream: 'ai' | 'prompts',
    raw: T,
    actor: GlobalSettingsActor,
  ): Promise<TenantAiRevision | TenantPromptRevision | GlobalSettingsMutationResult> {
    requireTenant(tenantId);
    requireCrypto(crypto);
    const parsed = stream === 'ai'
      ? safeParse(TenantAiDraftRequestSchema, raw, 'invalid AI settings draft')
      : safeParse(TenantPromptDraftRequestSchema, raw, 'invalid prompt settings draft');
    const payload = stream === 'ai'
      ? safeParse(TenantAiDefaultsSchema, parsed.settings, 'invalid AI defaults')
      : safeParse(TenantPromptDefaultsSchema, parsed.settings, 'invalid prompt defaults');
    if (stream === 'prompts' && !testablePromptDefaults(payload as TenantPromptDefaults)) {
      invalid('compare must include {file1} and {file2}; generate must include {user_prompt} and {input_content}');
    }
    const scope = `${tenantId}:${stream}:draft`;
    const requestHash = requestHashWithoutKey(parsed);
    const replayed = await quickReplay(db, scope, parsed.idempotencyKey, requestHash, GlobalSettingsMutationResultSchema);
    if (replayed) return { ...replayed, replayed: true };
    // Candidate encryption is done before the transaction so a remote key
    // provider never holds a PostgreSQL row lock while it is called.
    const candidateHead = await readHead(db, tenantId, stream);
    const candidateRevision = Number(candidateHead.next_revision) + 1;
    const payloadRef = await sealedPayload(crypto, tenantId, stream, candidateRevision, payload);
    const contentDigest = digest(payload);
    return db.tx(async (client) => {
      await assertSnapshotWriteAllowed(client, tenantId, requestHash);
      const replay = await findReplay(client, scope, parsed.idempotencyKey, requestHash);
      if (replay) return replay;
      const head = await lockHead(client, tenantId, stream);
      if (Number(head.next_revision) + 1 !== candidateRevision) conflict('settings changed while creating the draft; reload and retry');
      if (head.active_revision !== parsed.expectedActiveRevision) conflict('active settings revision changed; reload before saving');
      if (parsed.sourceRevision !== undefined && parsed.sourceRevision !== null) {
        const source = await client.query('SELECT revision FROM global_settings_tenant_revisions WHERE tenant_id=$1 AND stream=$2 AND revision=$3', [tenantId, stream, parsed.sourceRevision]);
        if (!source.rowCount) throw new HttpError(404, 'NOT_FOUND', 'source settings revision was not found');
      }
      await client.query(
        `INSERT INTO global_settings_tenant_revisions(tenant_id,stream,revision,state,payload_ref,content_digest,actor,source_revision)
         VALUES($1,$2,$3,'DRAFT',$4,$5,$6,$7)`,
        [tenantId, stream, candidateRevision, payloadRef, contentDigest, actor.label, parsed.sourceRevision ?? null],
      );
      await client.query(
        `UPDATE global_settings_tenant_revisions SET state='SUPERSEDED'
         WHERE tenant_id=$1 AND stream=$2 AND revision=$3 AND state='DRAFT'`,
        [tenantId, stream, head.draft_revision],
      );
      await client.query(
        'UPDATE global_settings_tenant_heads SET draft_revision=$3,next_revision=$4 WHERE tenant_id=$1 AND stream=$2',
        [tenantId, stream, candidateRevision, candidateRevision],
      );
      const result = mutationResult(tenantId, stream === 'ai' ? 'tenant-ai' : 'tenant-prompts', candidateRevision, Number(head.active_revision ?? 0));
      await audit.record({
        tenantId, actor: actor.label, actorIssuer: actor.issuer, actorSub: actor.sub, actorRole: actor.role,
        action: `settings.${stream}.draft`, resource: `tenant:${tenantId}:${stream}:revision:${candidateRevision}`,
        severity: 'info',
      }, client);
      await remember(client, scope, parsed.idempotencyKey, requestHash, result);
      return result;
    });
  }

  async function testTenantAiRevision(
    tenantId: string,
    raw: TenantAiTestRequest,
    actor: GlobalSettingsActor,
    executeProviderTest?: (input: ProviderTestRequest) => Promise<ProviderTestResult>,
  ): Promise<TenantAiTestResult> {
    requireTenant(tenantId);
    const request = safeParse(TenantAiTestRequestSchema, raw, 'invalid AI test request');
    const scope = `${tenantId}:ai:test`;
    const requestHash = requestHashWithoutKey(request);
    const replay = await quickReplay(db, scope, request.idempotencyKey, requestHash, TenantAiTestResultSchema);
    if (replay && !isUnresolvedTenantAiTest(replay)) return replay;
    if (!executeProviderTest) throw new HttpError(503, 'CONNECTOR_TEST_UNAVAILABLE', 'authorized provider-test service is not configured');
    const row = await db.query<TenantRevisionRow>(
      `SELECT tenant_id,stream,revision,state,payload_ref,content_digest,actor,tested_at,source_revision,published_at,created_at
       FROM global_settings_tenant_revisions WHERE tenant_id=$1 AND stream='ai' AND revision=$2`,
      [tenantId, request.revision],
    );
    if (!row.rowCount) throw new HttpError(404, 'NOT_FOUND', 'AI settings revision was not found');
    const revision = row.rows[0]!;
    if (revision.state !== 'DRAFT' && revision.state !== 'TESTED') conflict('only an AI draft can be tested');
    const settings = await openRevision(revision, crypto) as TenantAiDefaults;
    let ok = false;
    let errorCode: string | null = null;
    if (!settings.connectorId || settings.connectorRevision === null) {
      errorCode = 'CONNECTION_NOT_CONFIGURED';
    } else {
      const connectorRevision = options.connectorManagement
        ? await options.connectorManagement.getRecipeRevision({ tenantId, connectorId: settings.connectorId, revision: settings.connectorRevision })
        : undefined;
      if (!connectorRevision) throw new HttpError(404, 'NOT_FOUND', 'selected Connector revision was not found in this tenant');
      if (connectorRevision.state === 'PENDING' && !request.bindingSlot) {
        errorCode = 'CANDIDATE_BINDING_SLOT_REQUIRED';
      } else {
      const tested = await executeProviderTest({
        tenantId,
        apiKeyId: request.apiKeyId,
        profileId: request.profileId,
        expectedProfileRevision: request.expectedProfileRevision,
        businessId: request.businessId,
        businessVersion: request.businessVersion,
        action: request.action,
        endpointSlug: request.endpointSlug,
        connectorId: settings.connectorId,
        revision: settings.connectorRevision,
        ...(connectorRevision.state === 'PENDING' && request.bindingSlot ? { bindingSlot: request.bindingSlot } : {}),
        model: settings.model,
        prompt: request.prompt,
        parameters: request.parameters,
        artifactIds: request.artifactIds,
        timeoutMs: request.timeoutMs,
        idempotencyKey: request.idempotencyKey,
      });
      ok = tested.state === 'SUCCEEDED' && tested.usageEventId !== null;
      errorCode = ok ? null : tested.state === 'UNKNOWN'
        ? 'PROVIDER_TEST_UNKNOWN'
        : tested.errorCode ?? 'PROVIDER_TEST_FAILED';
      }
    }
    const testedAt = now().toISOString();
    const result = TenantAiTestResultSchema.parse({ tenantId, revision: request.revision, ok, testedAt, errorCode });
    return db.tx(async (client) => {
      await assertSnapshotWriteAllowed(client, tenantId, requestHash);
      const locked = await client.query<{ state: string }>(
        "SELECT state FROM global_settings_tenant_revisions WHERE tenant_id=$1 AND stream='ai' AND revision=$2 FOR UPDATE",
        [tenantId, request.revision],
      );
      if (!locked.rowCount || !['DRAFT', 'TESTED'].includes(locked.rows[0]!.state)) conflict('AI settings revision changed during test');
      const stored = await persistTenantAiTestResult(client, scope, request.idempotencyKey, requestHash, result);
      if (stored.result.ok) {
        await client.query("UPDATE global_settings_tenant_revisions SET state='TESTED',tested_at=$3 WHERE tenant_id=$1 AND stream='ai' AND revision=$2", [tenantId, request.revision, stored.result.testedAt]);
      }
      if (stored.changed) {
        await audit.record({ tenantId, actor: actor.label, actorIssuer: actor.issuer, actorSub: actor.sub, actorRole: actor.role,
          action: 'settings.ai.test', resource: `tenant:${tenantId}:ai:revision:${request.revision}`, severity: stored.result.ok ? 'success' : 'warning' }, client);
      }
      return stored.result;
    });
  }

  async function publishTenantRevision(
    tenantId: string,
    stream: 'ai' | 'prompts',
    raw: GlobalSettingsPublishRequest,
    actor: GlobalSettingsActor,
  ): Promise<GlobalSettingsMutationResult> {
    requireTenant(tenantId);
    const request = safeParse(GlobalSettingsPublishRequestSchema, raw, 'invalid publish request');
    const scope = `${tenantId}:${stream}:publish`;
    const requestHash = requestHashWithoutKey(request);
    return db.tx(async (client) => {
      await assertSnapshotWriteAllowed(client, tenantId, requestHash);
      const replay = await findReplay(client, scope, request.idempotencyKey, requestHash);
      if (replay) return replay;
      const head = await lockHead(client, tenantId, stream);
      if (head.active_revision !== request.expectedActiveRevision) conflict('active settings revision changed; reload before publishing');
      if (head.draft_revision !== request.draftRevision) conflict('the requested settings revision is no longer the current draft');
      const result = await client.query<TenantRevisionRow>(
        `SELECT tenant_id,stream,revision,state,payload_ref,content_digest,actor,tested_at,source_revision,created_at
         FROM global_settings_tenant_revisions WHERE tenant_id=$1 AND stream=$2 AND revision=$3 FOR UPDATE`,
        [tenantId, stream, request.draftRevision],
      );
      if (!result.rowCount) throw new HttpError(404, 'NOT_FOUND', 'settings revision was not found');
      const row = result.rows[0]!;
      const payload = await openRevision(row, crypto);
      if (stream === 'ai') {
        if (row.state !== 'TESTED' || !row.tested_at) conflict('test the selected AI connection successfully before publishing');
        const ai = payload as TenantAiDefaults;
        if (!ai.connectorId || ai.connectorRevision === null) invalid('AI defaults require a tested Connector revision before publishing');
      } else if (row.state !== 'DRAFT' && row.state !== 'TESTED') {
        conflict('only the current prompt draft can be published');
      }
      await client.query(
        `UPDATE global_settings_tenant_revisions SET state='SUPERSEDED'
         WHERE tenant_id=$1 AND stream=$2 AND revision=$3 AND state='PUBLISHED'`,
        [tenantId, stream, head.active_revision],
      );
      await client.query(
        `UPDATE global_settings_tenant_revisions SET state='PUBLISHED',published_at=clock_timestamp()
         WHERE tenant_id=$1 AND stream=$2 AND revision=$3`,
        [tenantId, stream, request.draftRevision],
      );
      await client.query(
        `UPDATE global_settings_tenant_heads SET active_revision=$3,draft_revision=NULL
         WHERE tenant_id=$1 AND stream=$2`,
        [tenantId, stream, request.draftRevision],
      );
      const resultDto = mutationResult(tenantId, stream === 'ai' ? 'tenant-ai' : 'tenant-prompts', request.draftRevision, request.draftRevision);
      await audit.record({ tenantId, actor: actor.label, actorIssuer: actor.issuer, actorSub: actor.sub, actorRole: actor.role,
        action: `settings.${stream}.publish`, resource: `tenant:${tenantId}:${stream}:revision:${request.draftRevision}`, severity: 'success' }, client);
      await remember(client, scope, request.idempotencyKey, requestHash, resultDto);
      return resultDto;
    });
  }

  async function rollbackTenantRevision(
    tenantId: string,
    stream: 'ai' | 'prompts',
    raw: GlobalSettingsRollbackRequest,
    actor: GlobalSettingsActor,
  ): Promise<GlobalSettingsMutationResult> {
    requireTenant(tenantId);
    requireCrypto(crypto);
    const request = safeParse(GlobalSettingsRollbackRequestSchema, raw, 'invalid rollback request');
    const scope = `${tenantId}:${stream}:rollback`;
    const requestHash = requestHashWithoutKey(request);
    const sourceResult = await db.query<TenantRevisionRow>(
      `SELECT tenant_id,stream,revision,state,payload_ref,content_digest,actor,tested_at,source_revision,published_at,created_at
       FROM global_settings_tenant_revisions WHERE tenant_id=$1 AND stream=$2 AND revision=$3`,
      [tenantId, stream, request.targetRevision],
    );
    if (!sourceResult.rowCount) throw new HttpError(404, 'NOT_FOUND', 'rollback target was not found');
    const source = sourceResult.rows[0]!;
    if (!source.published_at) invalid('rollback target must be a previously published revision');
    const payload = await openRevision(source, crypto);
    if (stream === 'ai') {
      const settings = payload as TenantAiDefaults;
      if (!settings.connectorId || settings.connectorRevision === null) invalid('rollback target has no Connector revision');
    }
    const candidateHead = await readHead(db, tenantId, stream);
    const candidateRevision = Number(candidateHead.next_revision) + 1;
    const payloadRef = await sealedPayload(crypto, tenantId, stream, candidateRevision, payload);
    const contentDigest = digest(payload);
    return db.tx(async (client) => {
      await assertSnapshotWriteAllowed(client, tenantId, requestHash);
      const replay = await findReplay(client, scope, request.idempotencyKey, requestHash);
      if (replay) return replay;
      const head = await lockHead(client, tenantId, stream);
      if (Number(head.next_revision) + 1 !== candidateRevision) conflict('settings changed while preparing rollback; reload and retry');
      if (head.active_revision !== request.expectedActiveRevision) conflict('active settings revision changed; reload before rollback');
      if (stream === 'ai') {
        const settings = payload as TenantAiDefaults;
        const current = await options.connectorManagement?.getCurrent(settings.connectorId!);
        if (!current || current.revision !== settings.connectorRevision || current.tenantId !== tenantId || current.adapter !== settings.provider) {
          conflict('rollback target Connector revision is not currently available');
        }
      }
      await client.query(
        `INSERT INTO global_settings_tenant_revisions(tenant_id,stream,revision,state,payload_ref,content_digest,actor,source_revision,tested_at,published_at)
         VALUES($1,$2,$3,'PUBLISHED',$4,$5,$6,$7,CASE WHEN $2='ai' THEN clock_timestamp() ELSE NULL END,clock_timestamp())`,
        [tenantId, stream, candidateRevision, payloadRef, contentDigest, actor.label, request.targetRevision],
      );
      await client.query("UPDATE global_settings_tenant_revisions SET state='SUPERSEDED' WHERE tenant_id=$1 AND stream=$2 AND revision=$3 AND state='PUBLISHED'", [tenantId, stream, head.active_revision]);
      await client.query('UPDATE global_settings_tenant_heads SET active_revision=$3,draft_revision=NULL,next_revision=$3 WHERE tenant_id=$1 AND stream=$2', [tenantId, stream, candidateRevision]);
      const result = mutationResult(tenantId, stream === 'ai' ? 'tenant-ai' : 'tenant-prompts', candidateRevision, candidateRevision);
      await audit.record({ tenantId, actor: actor.label, actorIssuer: actor.issuer, actorSub: actor.sub, actorRole: actor.role,
        action: `settings.${stream}.rollback`, resource: `tenant:${tenantId}:${stream}:revision:${candidateRevision}:from:${request.targetRevision}`, severity: 'warning' }, client);
      await remember(client, scope, request.idempotencyKey, requestHash, result);
      return result;
    });
  }

  async function readRetention(): Promise<PlatformRetentionRead> {
    const head = await db.query<{ active_revision: number; draft_revision: number | null }>(
      'SELECT active_revision,draft_revision FROM global_settings_retention_head WHERE singleton=true',
    );
    const activeRevision = head.rows[0]?.active_revision ?? 0;
    const draftRevision = head.rows[0]?.draft_revision ?? null;
    const rows = await db.query<RetentionRow>(
      'SELECT revision,state,settings,digest,actor,source_revision,published_at,created_at FROM global_settings_retention_revisions ORDER BY revision DESC LIMIT $1',
      [MAX_HISTORY],
    );
    const history = rows.rows.map((row) => PlatformRetentionRevisionSchema.parse({
      revision: Number(row.revision), state: row.state,
      settings: PlatformRetentionSettingsSchema.parse(row.settings), digest: row.digest,
      actor: row.actor, sourceRevision: row.source_revision === null ? null : Number(row.source_revision), createdAt: iso(row.created_at)!,
    }));
    const active = history.find((row) => row.revision === Number(activeRevision)) ?? {
      revision: 0, settings: DEFAULT_RETENTION,
    };
    const draft = draftRevision === null ? null : history.find((row) => row.revision === Number(draftRevision)) ?? null;
    return PlatformRetentionReadSchema.parse({
      activeRevision: Number(activeRevision), effective: active.settings,
      draft, history,
      capability: { editable: true, reasonCode: null },
    });
  }

  async function getEffectiveRetentionPolicy() {
    const read = await readRetention();
    return {
      revision: read.activeRevision,
      ...read.effective,
    };
  }

  async function createRetentionDraft(raw: PlatformRetentionDraftRequest, actor: GlobalSettingsActor): Promise<GlobalSettingsMutationResult> {
    const request = safeParse(PlatformRetentionDraftRequestSchema, raw, 'invalid retention draft');
    const settings = safeParse(PlatformRetentionSettingsSchema, request.settings, 'invalid retention settings');
    const requestHash = requestHashWithoutKey(request);
    return db.tx(async (client) => {
      await assertSnapshotWriteAllowed(client, null, requestHash);
      const replay = await findReplay(client, 'platform-retention:draft', request.idempotencyKey, requestHash);
      if (replay) return replay;
      const head = await client.query<{ active_revision: number; next_revision: number }>(
        'SELECT active_revision,next_revision FROM global_settings_retention_head WHERE singleton=true FOR UPDATE',
      );
      if (!head.rowCount) throw new HttpError(503, 'SETTINGS_NOT_INITIALIZED', 'platform retention settings are not initialized');
      if (Number(head.rows[0]!.active_revision) !== request.expectedActiveRevision) conflict('retention revision changed; reload before saving');
      const revision = Number(head.rows[0]!.next_revision) + 1;
      const settingsDigest = digest(settings);
      if (request.sourceRevision !== undefined && request.sourceRevision !== null) {
        const source = await client.query<{ published_at: Date | string | null }>(
          'SELECT published_at FROM global_settings_retention_revisions WHERE revision=$1',
          [request.sourceRevision],
        );
        if (!source.rowCount) throw new HttpError(404, 'NOT_FOUND', 'source retention revision was not found');
      }
      await client.query(
        `INSERT INTO global_settings_retention_revisions(revision,state,settings,digest,actor,source_revision)
         VALUES($1,'DRAFT',$2,$3,$4,$5)`,
        [revision, JSON.stringify(settings), settingsDigest, actor.label, request.sourceRevision ?? null],
      );
      await client.query("UPDATE global_settings_retention_revisions SET state='SUPERSEDED' WHERE revision=(SELECT draft_revision FROM global_settings_retention_head WHERE singleton=true) AND state='DRAFT'");
      await client.query('UPDATE global_settings_retention_head SET draft_revision=$1,next_revision=$1 WHERE singleton=true', [revision]);
      const result = mutationResult(null, 'platform-retention', revision, request.expectedActiveRevision);
      await audit.record({ tenantId: null, actor: actor.label, actorIssuer: actor.issuer, actorSub: actor.sub, actorRole: actor.role,
        action: 'settings.retention.draft', resource: `platform:retention:revision:${revision}`, severity: 'info' }, client);
      await remember(client, 'platform-retention:draft', request.idempotencyKey, requestHash, result);
      return result;
    });
  }

  async function publishRetentionRevision(raw: GlobalSettingsPublishRequest, actor: GlobalSettingsActor): Promise<GlobalSettingsMutationResult> {
    const request = safeParse(GlobalSettingsPublishRequestSchema, raw, 'invalid retention publish request');
    const requestHash = requestHashWithoutKey(request);
    const result = await db.tx(async (client) => {
      await assertSnapshotWriteAllowed(client, null, requestHash);
      const replay = await findReplay(client, 'platform-retention:publish', request.idempotencyKey, requestHash);
      if (replay) return replay;
      const head = await client.query<{ active_revision: number; draft_revision: number | null }>(
        'SELECT active_revision,draft_revision FROM global_settings_retention_head WHERE singleton=true FOR UPDATE',
      );
      if (!head.rowCount) throw new HttpError(503, 'SETTINGS_NOT_INITIALIZED', 'platform retention settings are not initialized');
      if (Number(head.rows[0]!.active_revision) !== request.expectedActiveRevision) conflict('retention revision changed; reload before publishing');
      if (Number(head.rows[0]!.draft_revision) !== request.draftRevision) conflict('the requested retention revision is no longer the current draft');
      const row = await client.query("SELECT revision,settings FROM global_settings_retention_revisions WHERE revision=$1 AND state='DRAFT' FOR UPDATE", [request.draftRevision]);
      if (!row.rowCount) throw new HttpError(404, 'NOT_FOUND', 'retention draft was not found');
      const settings = PlatformRetentionSettingsSchema.parse(row.rows[0]!.settings);
      await client.query("UPDATE global_settings_retention_revisions SET state='SUPERSEDED' WHERE revision=$1 AND state='PUBLISHED'", [head.rows[0]!.active_revision]);
      await client.query("UPDATE global_settings_retention_revisions SET state='PUBLISHED',published_at=clock_timestamp() WHERE revision=$1", [request.draftRevision]);
      await client.query('UPDATE global_settings_retention_head SET active_revision=$1,draft_revision=NULL WHERE singleton=true', [request.draftRevision]);
      const result = mutationResult(null, 'platform-retention', request.draftRevision, request.draftRevision);
      await audit.record({ tenantId: null, actor: actor.label, actorIssuer: actor.issuer, actorSub: actor.sub, actorRole: actor.role,
        action: 'settings.retention.publish', resource: `platform:retention:revision:${request.draftRevision}`, severity: 'success' }, client);
      await remember(client, 'platform-retention:publish', request.idempotencyKey, requestHash, result);
      return result;
    });
    options.onRetentionPolicyChanged?.();
    return result;
  }

  async function rollbackRetentionRevision(raw: GlobalSettingsRollbackRequest, actor: GlobalSettingsActor): Promise<GlobalSettingsMutationResult> {
    const request = safeParse(GlobalSettingsRollbackRequestSchema, raw, 'invalid retention rollback request');
    const requestHash = requestHashWithoutKey(request);
    const result = await db.tx(async (client) => {
      await assertSnapshotWriteAllowed(client, null, requestHash);
      const replay = await findReplay(client, 'platform-retention:rollback', request.idempotencyKey, requestHash);
      if (replay) return replay;
      const head = await client.query<{ active_revision: number; next_revision: number }>(
        'SELECT active_revision,next_revision FROM global_settings_retention_head WHERE singleton=true FOR UPDATE',
      );
      if (!head.rowCount) throw new HttpError(503, 'SETTINGS_NOT_INITIALIZED', 'platform retention settings are not initialized');
      if (Number(head.rows[0]!.active_revision) !== request.expectedActiveRevision) conflict('retention revision changed; reload before rollback');
      const source = await client.query<{ settings: unknown; published_at: Date | string | null }>(
        'SELECT settings,published_at FROM global_settings_retention_revisions WHERE revision=$1', [request.targetRevision],
      );
      if (!source.rowCount || !source.rows[0]!.published_at) invalid('rollback target must be a previously published retention revision');
      const settings = PlatformRetentionSettingsSchema.parse(source.rows[0]!.settings);
      const revision = Number(head.rows[0]!.next_revision) + 1;
      await client.query(
        `INSERT INTO global_settings_retention_revisions(revision,state,settings,digest,actor,source_revision,published_at)
         VALUES($1,'PUBLISHED',$2,$3,$4,$5,clock_timestamp())`,
        [revision, JSON.stringify(settings), digest(settings), actor.label, request.targetRevision],
      );
      await client.query("UPDATE global_settings_retention_revisions SET state='SUPERSEDED' WHERE revision=$1 AND state='PUBLISHED'", [head.rows[0]!.active_revision]);
      await client.query('UPDATE global_settings_retention_head SET active_revision=$1,draft_revision=NULL,next_revision=$1 WHERE singleton=true', [revision]);
      const result = mutationResult(null, 'platform-retention', revision, revision);
      await audit.record({ tenantId: null, actor: actor.label, actorIssuer: actor.issuer, actorSub: actor.sub, actorRole: actor.role,
        action: 'settings.retention.rollback', resource: `platform:retention:revision:${revision}:from:${request.targetRevision}`, severity: 'warning' }, client);
      await remember(client, 'platform-retention:rollback', request.idempotencyKey, requestHash, result);
      return result;
    });
    options.onRetentionPolicyChanged?.();
    return result;
  }

  return {
    readTenant,
    getTenantDefaultsSnapshot,
    createTenantAiDraft: (tenantId: string, input: TenantAiDraftRequest, actor: GlobalSettingsActor) => createTenantDraft(tenantId, 'ai', input, actor),
    createTenantPromptDraft: (tenantId: string, input: TenantPromptDraftRequest, actor: GlobalSettingsActor) => createTenantDraft(tenantId, 'prompts', input, actor),
    testTenantAiRevision,
    publishTenantAiRevision: (tenantId: string, input: GlobalSettingsPublishRequest, actor: GlobalSettingsActor) => publishTenantRevision(tenantId, 'ai', input, actor),
    publishTenantPromptRevision: (tenantId: string, input: GlobalSettingsPublishRequest, actor: GlobalSettingsActor) => publishTenantRevision(tenantId, 'prompts', input, actor),
    rollbackTenantAiRevision: (tenantId: string, input: GlobalSettingsRollbackRequest, actor: GlobalSettingsActor) => rollbackTenantRevision(tenantId, 'ai', input, actor),
    rollbackTenantPromptRevision: (tenantId: string, input: GlobalSettingsRollbackRequest, actor: GlobalSettingsActor) => rollbackTenantRevision(tenantId, 'prompts', input, actor),
    readRetention,
    getEffectiveRetentionPolicy,
    createRetentionDraft,
    publishRetentionRevision,
    rollbackRetentionRevision,
  };
}

export type GlobalSettingsService = ReturnType<typeof createGlobalSettingsService>;
