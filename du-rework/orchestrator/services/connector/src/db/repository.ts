import { createHash } from 'node:crypto';
import {
  canonicalize,
  UsageEventSchema,
  ConnectorSignalSnapshotSchema,
  type ConnectorProviderTestEvidence,
  type ConnectorProviderTestEvidenceQuery,
  type ConnectorSignalSnapshot,
  type ConnectorSignalSnapshotQuery,
} from '@du/contracts';
import { toContractUsageEvent, usageEventId, type UsageEvent } from '../usage';
import { PostgresUsageOutbox } from './usage-outbox';
import { ConnectorError } from '../errors';
import {
  ConnectorRevisionBindingSchema,
  ConnectorRevisionConfigSchema,
  matchesVaultRevisionBinding,
} from '@du/contracts';
import { parseCredentialSource, type CredentialSource } from '../vault/resolver';
import { randomUUID } from 'node:crypto';
import {
  InvocationFieldCryptoError,
  isSealedInvocationField,
  type InvocationCryptoContext,
  type InvocationFieldCrypto,
} from './invocation-crypto';
import type {
  AdapterConfig,
  ConnectorErrorCode,
  InvocationLedger,
  InvocationRecord,
  InvocationState,
  LocalInvocationRequest,
  NormalizedProviderResult,
  QuotaLease,
} from '../types';
import type { SqlClient } from './sql';
import {
  assertConnectorBackupEffectGateOpen,
  insertConnectorEffectPermit,
  lockConnectorBackupEffectGate,
} from './backup-effect-fences';

interface InvocationRow {
  invocation_id: string;
  tenant_id: string;
  operation_id: string;
  task_id: string;
  step_key: string;
  input_hash: string;
  request: unknown;
  state: InvocationState;
  result: unknown;
  error_code: ConnectorErrorCode | null;
  provider_request_id: string | null;
  session_ref: string | null;
  next_poll_at: string | Date | null;
  poll_lease_token: string | null;
  poll_lease_expires_at: string | Date | null;
  quota_lease_key: string | null;
  quota_lease_id: string | null;
  quota_lease_expires_at: string | Date | null;
  provider_poll_attempts: number;
  state_version?: number | string;
  provider_effect_id?: string | null;
  poll_effect_id?: string | null;
  updated_at: string;
}

export interface PostgresInvocationLedgerOptions {
  /**
   * SEC-ENC-02 (SD-01): seals `request`, `result` and `session_ref` before any
   * SQL statement runs, and opens them only when a record is authorized and
   * read back. Absent = fail closed: sensitive writes/reads are refused
   * rather than persisted in plaintext. Wire at composition via
   * `resolveInvocationStorageCryptoFromEnv` (db/invocation-crypto.ts).
   */
  readonly fieldCrypto?: InvocationFieldCrypto;
  /**
   * Bounded historical/migration window: a stored value that is not an
   * envelope is returned as-is so pre-encryption rows stay readable while a
   * backfill runs. Default false (strict). Never affects writes: writes are
   * always sealed or refused.
   */
  readonly legacyPlaintextReads?: boolean;
  /** Boot-pinned owner used by the Connector replica drain fence. Absent for
   * pre-rollout-compatible deployments; when present, first claims lock and
   * verify this replica's durable OPEN control row in the same transaction. */
  readonly replicaId?: string;
  /** Process identity and boot nonce bind durable effect ownership. */
  readonly runtimeIdentity?: string;
  readonly bootId?: string;
}

export class PostgresInvocationLedger implements InvocationLedger {
  private readonly fieldCrypto?: InvocationFieldCrypto;
  private readonly legacyPlaintextReads: boolean;
  private readonly replicaId?: string;
  private readonly runtimeIdentity?: string;
  private readonly bootId?: string;

  public constructor(
    private readonly db: SqlClient,
    options: PostgresInvocationLedgerOptions = {},
  ) {
    this.fieldCrypto = options.fieldCrypto;
    this.legacyPlaintextReads = options.legacyPlaintextReads === true;
    this.replicaId = options.replicaId;
    this.runtimeIdentity = options.runtimeIdentity;
    this.bootId = options.bootId;
  }

  private requireCrypto(): InvocationFieldCrypto {
    if (!this.fieldCrypto) {
      // Fail closed: an unconfigured deployment must not persist or serve
      // tenant/provider content. The boot policy (SEC-ENC-05) turns this into
      // a startup refusal; until then no plaintext can enter the table.
      throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Invocation storage encryption is not configured.', {
        safeToRetry: false,
      });
    }
    return this.fieldCrypto;
  }

  private async sealField(context: InvocationCryptoContext, value: unknown): Promise<unknown> {
    const crypto = this.requireCrypto();
    try {
      return await crypto.seal(value, context);
    } catch (error) {
      throw mapInvocationCryptoFailure(error);
    }
  }

  private async openField(context: InvocationCryptoContext, value: unknown): Promise<unknown> {
    if (value === null || value === undefined) return value;
    if (isSealedInvocationField(value)) {
      const crypto = this.requireCrypto();
      try {
        return await crypto.open(value, context);
      } catch (error) {
        throw mapInvocationCryptoFailure(error);
      }
    }
    if (this.legacyPlaintextReads) return value;
    throw new ConnectorError('INVOCATION_UNKNOWN', 'Stored invocation data is not protected by an envelope.');
  }

  private async openSessionRef(row: InvocationRow): Promise<string> {
    const raw = row.session_ref;
    if (raw === null || raw === undefined) {
      throw new ConnectorError('INVOCATION_UNKNOWN', 'Stored invocation session failed protection.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined && isSealedInvocationField(parsed)) {
      const opened = await this.openField(
        { tenantId: row.tenant_id, slot: 'connector_invocations.session_ref', refId: row.invocation_id },
        parsed,
      );
      if (typeof opened !== 'string') {
        throw new ConnectorError('INVOCATION_UNKNOWN', 'Stored invocation session failed protection.');
      }
      return opened;
    }
    // Not an envelope: a pre-encryption session string is readable only inside
    // the explicit migration window.
    if (this.legacyPlaintextReads) return raw;
    throw new ConnectorError('INVOCATION_UNKNOWN', 'Stored invocation data is not protected by an envelope.');
  }

  private async tenantFor(invocationId: string): Promise<string | undefined> {
    const result = await this.db.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM connector_invocations WHERE invocation_id = $1',
      [invocationId],
    );
    return result.rows[0]?.tenant_id;
  }

  private async toRecord(row: InvocationRow): Promise<InvocationRecord> {
    const request = await this.openField(
      { tenantId: row.tenant_id, slot: 'connector_invocations.request', refId: row.invocation_id },
      row.request,
    ) as LocalInvocationRequest;
    const result = await this.openField(
      { tenantId: row.tenant_id, slot: 'connector_invocations.result', refId: row.invocation_id },
      row.result,
    ) as NormalizedProviderResult | undefined;
    const sessionRef = row.session_ref === null || row.session_ref === undefined
      ? undefined
      : await this.openSessionRef(row);
    return {
      request,
      inputHash: row.input_hash,
      state: row.state,
      result,
      errorCode: row.error_code ?? undefined,
      providerRequestId: row.provider_request_id ?? undefined,
      sessionRef,
      // pg returns TIMESTAMPTZ as Date; the contract requires an RFC3339 string.
      nextPollAt: row.next_poll_at == null ? undefined : new Date(row.next_poll_at).toISOString(),
      pollLeaseToken: row.poll_lease_token ?? undefined,
      pollLeaseExpiresAt: row.poll_lease_expires_at == null ? undefined : new Date(row.poll_lease_expires_at).toISOString(),
      quotaLease: row.quota_lease_key && row.quota_lease_id && row.quota_lease_expires_at != null
        ? {
          key: row.quota_lease_key,
          leaseId: row.quota_lease_id,
          expiresAt: new Date(row.quota_lease_expires_at).getTime(),
        }
        : undefined,
      providerPollAttempts: Number(row.provider_poll_attempts ?? 0),
      updatedAt: row.updated_at,
    };
  }

  public async get(invocationId: string): Promise<InvocationRecord | undefined> {
    const result = await this.db.query<InvocationRow>(
      'SELECT * FROM connector_invocations WHERE invocation_id = $1',
      [invocationId],
    );
    return result.rows[0] ? this.toRecord(result.rows[0]) : undefined;
  }

  /**
   * Read-only, tenant-pinned source proof for the admin provider-test recovery
   * path. It returns only rows whose encrypted request records the dedicated
   * test purpose and the exact operation/task/connector revision supplied by
   * the authenticated caller. A positive recovery requires both the durable
   * mapped result and its exact usage-outbox event.
   */
  public async getProviderTestEvidence(
    query: ConnectorProviderTestEvidenceQuery,
  ): Promise<ConnectorProviderTestEvidence | undefined> {
    const result = await this.db.query<InvocationRow>(
      `SELECT * FROM connector_invocations
       WHERE invocation_id = $1 AND tenant_id = $2 AND operation_id = $3 AND task_id = $4`,
      [query.invocationId, query.tenantId, query.operationId, query.taskId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const record = await this.toRecord(row);
    if (
      record.request.adminPurpose !== 'admin-provider-test'
      || record.request.connectorId !== query.connectorId
      || record.request.connectorRevision !== query.revision
      || record.request.operationId !== query.operationId
      || record.request.taskId !== query.taskId
      || record.request.tenantId !== query.tenantId
    ) return undefined;

    const storedResult = record.state === 'SUCCEEDED' ? record.result : undefined;
    let resultView: ConnectorProviderTestEvidence['result'] = null;
    let resultDigest: string | null = null;
    if (storedResult) {
      resultDigest = sha256(canonicalize(storedResult));
      const content = storedResult.providerTestContentSanitized === true && typeof storedResult.content === 'string'
        ? storedResult.content
        : null;
      resultView = {
        content: content === null ? null : content.slice(0, 16_384),
        ...(storedResult.providerTestContentSanitized === true ? { contentSanitized: true as const } : {}),
        contentTruncated: storedResult.providerTestContentTruncated === true || (content !== null && content.length > 16_384),
        statusCode: Number.isInteger(storedResult.providerStatusCode)
          ? storedResult.providerStatusCode!
          : null,
        latencyMs: Number.isSafeInteger(storedResult.providerLatencyMs)
          && storedResult.providerLatencyMs! >= 0
          ? storedResult.providerLatencyMs!
          : null,
        providerRequestId: typeof storedResult.providerRequestId === 'string'
          ? storedResult.providerRequestId.slice(0, 512)
          : null,
        resultDigest,
      };
    }

    let usageEvent: ConnectorProviderTestEvidence['usageEvent'] = null;
    if (storedResult) {
      const costContext = record.request.costContext;
      const costAttempt = costContext?.attempt;
      const expectedEventId = costContext === undefined
        ? `${query.invocationId}:1`
        : typeof costAttempt === 'number' && Number.isSafeInteger(costAttempt) && costAttempt > 0
          ? usageEventId(query.invocationId, costAttempt)
          : undefined;
      // A malformed persisted cost context cannot fall back to the legacy ID.
      // Doing so could associate this result with usage from another attempt.
      if (expectedEventId !== undefined) {
        const outbox = await this.db.query<{
          event_id: string;
          invocation_id: string;
          payload: unknown;
          delivered_at: string | Date | null;
        }>(
          `SELECT event_id, invocation_id, payload, delivered_at FROM connector_usage_outbox
           WHERE event_id = $1 AND invocation_id = $2`,
          [expectedEventId, query.invocationId],
        );
        const eventRow = outbox.rows[0];
        let parsedEvent: ReturnType<typeof UsageEventSchema.safeParse> | undefined;
        if (eventRow && typeof eventRow.payload === 'object' && eventRow.payload !== null && !Array.isArray(eventRow.payload)) {
          try {
            parsedEvent = UsageEventSchema.safeParse(toContractUsageEvent(eventRow.payload as UsageEvent));
          } catch {
            parsedEvent = undefined;
          }
        }
        if (
          eventRow
          && parsedEvent?.success
          && parsedEvent.data.eventId === expectedEventId
          && parsedEvent.data.invocationId === query.invocationId
          && parsedEvent.data.operationId === query.operationId
          && parsedEvent.data.taskId === query.taskId
          && Number.isFinite(Date.parse(parsedEvent.data.occurredAt))
        ) {
          const event = parsedEvent.data;
          usageEvent = {
            eventId: event.eventId,
            payloadDigest: sha256(canonicalize(event)),
            inputTokens: Number.isSafeInteger(event.units.inputTokens) ? event.units.inputTokens : null,
            outputTokens: Number.isSafeInteger(event.units.outputTokens) ? event.units.outputTokens : null,
            costMicrousd: Number.isSafeInteger(event.costMicrousd) ? event.costMicrousd : null,
            measurement: event.measurement ?? null,
            costStatus: event.costStatus ?? null,
            occurredAt: new Date(event.occurredAt).toISOString(),
            deliveredAt: eventRow.delivered_at === null ? null : normalizeTimestamp(eventRow.delivered_at),
          };
        }
      }
    }

    const stateVersion = Number(row.state_version ?? 1);
    if (!Number.isSafeInteger(stateVersion) || stateVersion < 1) {
      throw new ConnectorError('INVOCATION_UNKNOWN', 'Stored invocation source version is invalid.');
    }
    if (record.state === 'NEW') {
      throw new ConnectorError('INVOCATION_UNKNOWN', 'Stored invocation source state is invalid.');
    }
    const evidenceCore = {
      tenantId: query.tenantId,
      operationId: query.operationId,
      taskId: query.taskId,
      invocationId: query.invocationId,
      connectorId: query.connectorId,
      revision: query.revision,
      state: record.state,
      stateVersion,
      updatedAt: normalizeTimestamp(row.updated_at),
      errorCode: record.errorCode ?? null,
      result: resultView,
      usageEvent,
      recoveryReady: record.state === 'SUCCEEDED' && resultView !== null && usageEvent !== null,
    };
    return {
      ...evidenceCore,
      evidenceDigest: sha256(canonicalize({
        tenantId: query.tenantId,
        operationId: query.operationId,
        taskId: query.taskId,
        invocationId: query.invocationId,
        connectorId: query.connectorId,
        revision: query.revision,
        state: record.state,
        stateVersion,
        resultDigest,
        usagePayloadDigest: usageEvent?.payloadDigest ?? null,
      })),
    };
  }

  /** Tenant-fenced projection of persisted invocation and outbox evidence. */
  public async getSignalSnapshot(query: ConnectorSignalSnapshotQuery): Promise<ConnectorSignalSnapshot> {
    const sampledAt = new Date();
    const from = new Date(query.from).toISOString();
    const to = new Date(query.to).toISOString();
    const countRows = await this.db.query<{ state: string; count: string | number }>(
      `SELECT state,count(*)::text AS count FROM connector_invocations
       WHERE tenant_id=$1 AND updated_at >= $2 AND updated_at < $3 GROUP BY state`, [query.tenantId, from, to]);
    const invocationCounts: Record<string, number> = {
      NEW: 0, IN_FLIGHT: 0, PENDING: 0, POLLING: 0, SUCCEEDED: 0, FAILED: 0, UNKNOWN: 0, CANCELLED: 0,
    };
    for (const row of countRows.rows) {
      if (!Object.hasOwn(invocationCounts, row.state)) continue;
      const count = Number(row.count);
      if (!Number.isSafeInteger(count) || count < 0) throw new ConnectorError('INVOCATION_UNKNOWN', 'Stored connector state count is invalid.');
      invocationCounts[row.state] = count;
    }
    const failedRows = await this.db.query<{ error_code: string; count: string | number }>(
      `SELECT error_code,count(*)::text AS count FROM connector_invocations
       WHERE tenant_id=$1 AND state='FAILED' AND error_code IS NOT NULL AND updated_at >= $2 AND updated_at < $3
       GROUP BY error_code ORDER BY count(*) DESC,error_code LIMIT 65`, [query.tenantId, from, to]);
    const failedByCode = failedRows.rows.slice(0, 64).map((row) => ({ errorCode: row.error_code, count: Number(row.count) }));

    // Include invocations referenced by outbox events in the window even when
    // their latest state change occurred earlier; this keeps every returned
    // event reference joinable without widening the tenant fence.
    const invocationRows = await this.db.query<InvocationRow>(
      `SELECT i.* FROM connector_invocations i
       WHERE i.tenant_id=$1 AND (
         (i.updated_at >= $2 AND i.updated_at < $3)
         OR EXISTS (SELECT 1 FROM connector_usage_outbox u WHERE u.invocation_id=i.invocation_id AND u.created_at >= $2 AND u.created_at < $3)
       ) ORDER BY i.updated_at DESC,i.invocation_id DESC LIMIT 100`, [query.tenantId, from, to]);
    const records = await Promise.all(invocationRows.rows.map((row) => this.toRecord(row)));
    const affectedInvocations = records.map((record) => ({
      tenantId: query.tenantId,
      operationId: record.request.operationId,
      taskId: record.request.taskId,
      invocationId: record.request.invocationId,
      stepKey: record.request.stepKey,
      connectorId: typeof record.request.connectorId === 'string' ? record.request.connectorId : null,
      connectorRevision: Number.isSafeInteger(record.request.connectorRevision) && (record.request.connectorRevision ?? 0) > 0 ? record.request.connectorRevision! : null,
      state: record.state,
      errorCode: record.errorCode ?? null,
      updatedAt: record.updatedAt,
    }));
    const availableInvocations = new Set(affectedInvocations.map((row) => row.invocationId));

    const totalRows = await this.db.query<{
      pending: string | number;
      failed_delivery_attempts: string | number;
      oldest_pending_at: Date | string | null;
      max_attempts: string | number;
    }>(
      `SELECT count(*) FILTER (WHERE u.delivered_at IS NULL)::text AS pending,
              COALESCE(sum(u.failed_attempts),0)::text AS failed_delivery_attempts,
              min(u.created_at) FILTER (WHERE u.delivered_at IS NULL) AS oldest_pending_at,
              COALESCE(max(u.attempts),0)::text AS max_attempts
       FROM connector_usage_outbox u JOIN connector_invocations i ON i.invocation_id=u.invocation_id
       WHERE i.tenant_id=$1 AND u.created_at >= $2 AND u.created_at < $3`, [query.tenantId, from, to]);
    const total = totalRows.rows[0];
    const pending = Number(total?.pending ?? 0);
    const failedDeliveryAttempts = Number(total?.failed_delivery_attempts ?? 0);
    const maxAttempts = Number(total?.max_attempts ?? 0);
    if (![pending, failedDeliveryAttempts, maxAttempts].every((value) => Number.isSafeInteger(value) && value >= 0)) {
      throw new ConnectorError('INVOCATION_UNKNOWN', 'Stored usage outbox counts are invalid.');
    }
    const oldestPendingAt = total?.oldest_pending_at == null
      ? null
      : total.oldest_pending_at instanceof Date ? total.oldest_pending_at.toISOString() : new Date(total.oldest_pending_at).toISOString();
    const oldestPendingLagMs = oldestPendingAt === null ? null : Math.max(0, sampledAt.getTime() - Date.parse(oldestPendingAt));
    const outboxRows = await this.db.query<{
      event_id: string; operation_id: string; task_id: string; invocation_id: string;
      attempts: number; failed_attempts: number; created_at: Date | string; delivered_at: Date | string | null;
    }>(
      `SELECT u.event_id,i.operation_id,i.task_id,u.invocation_id,u.attempts,u.failed_attempts,u.created_at,u.delivered_at
       FROM connector_usage_outbox u JOIN connector_invocations i ON i.invocation_id=u.invocation_id
       WHERE i.tenant_id=$1 AND u.created_at >= $2 AND u.created_at < $3
       ORDER BY u.created_at DESC,u.event_id DESC LIMIT 100`, [query.tenantId, from, to]);
    const affected = outboxRows.rows.filter((row) => availableInvocations.has(row.invocation_id)).map((row) => ({
      eventId: row.event_id,
      operationId: row.operation_id,
      taskId: row.task_id,
      invocationId: row.invocation_id,
      state: row.delivered_at === null ? 'PENDING' as const : 'DELIVERED' as const,
      attempts: Number(row.attempts),
      failedAttempts: Number(row.failed_attempts),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      deliveredAt: row.delivered_at === null ? null : row.delivered_at instanceof Date ? row.delivered_at.toISOString() : new Date(row.delivered_at).toISOString(),
    }));

    return ConnectorSignalSnapshotSchema.parse({
      snapshotId: randomUUID(),
      sourceRef: `connector-ledger:${query.tenantId}`,
      tenantId: query.tenantId,
      from,
      to,
      sampledAt: sampledAt.toISOString(),
      freshness: 'fresh',
      invocationCounts,
      failedByCode,
      affectedInvocations,
      usageOutbox: { pending, failedDeliveryAttempts, oldestPendingAt, oldestPendingLagMs, maxAttempts, affected },
    });
  }

  public async claim(
    request: LocalInvocationRequest,
    inputHash: string,
  ): Promise<
    | { kind: 'claimed'; record: InvocationRecord }
    | { kind: 'replay'; record: InvocationRecord }
    | { kind: 'conflict'; record: InvocationRecord }
  > {
    return this.db.transaction(async (tx) => {
      // Lock the backup gate before the ordinary replica drain row. This is
      // the shared transaction boundary with hold/activate, so a first claim
      // cannot pass a concurrent backup-fence transition.
      const backupGate = this.bootId ? await lockConnectorBackupEffectGate(tx) : undefined;
      let replicaControlState: 'OPEN' | 'DRAINING' | undefined;
      if (this.replicaId) {
        // This row is the shared mutex with drain/resume. Holding its lock
        // through the invocation insert closes the zero-count → new-work race.
        const control = await tx.query<{ control_state: 'OPEN' | 'DRAINING' }>(
          'SELECT control_state FROM connector_replica_runtime_controls WHERE replica_id=$1 FOR UPDATE',
          [this.replicaId],
        );
        replicaControlState = control.rows[0]?.control_state;
        if (!replicaControlState) {
          throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Connector replica control is not registered.');
        }
      }
      // Existence pre-check: a replay opens the stored row (the caller must see
      // the original request anyway) and never needs a fresh DEK wrap. A key
      // provider outage therefore surfaces before any write is attempted.
      const existing = await tx.query<InvocationRow>(
        'SELECT * FROM connector_invocations WHERE invocation_id = $1',
        [request.invocationId],
      );
      if (existing.rows[0]) {
        const record = await this.toRecord(existing.rows[0]);
        return record.inputHash === inputHash
          ? { kind: 'replay' as const, record }
          : { kind: 'conflict' as const, record };
      }

      if (replicaControlState !== undefined && replicaControlState !== 'OPEN') {
        throw new ConnectorError('CONNECTOR_DISABLED', 'Connector replica is durably draining.');
      }
      if (backupGate) assertConnectorBackupEffectGateOpen(backupGate);

      // SEC-ENC-02: the request row never reaches SQL unsealed. The envelope is
      // bound to (tenant, request slot, invocationId); the sealed value is the
      // only copy written to the JSONB column.
      const sealedRequest = await this.sealField(
        { tenantId: request.tenantId, slot: 'connector_invocations.request', refId: request.invocationId },
        request,
      );
      const providerEffectId = this.bootId ? randomUUID() : null;
      const inserted = await tx.query<InvocationRow>(
        `INSERT INTO connector_invocations
          (invocation_id, tenant_id, operation_id, task_id, step_key, input_hash, request, state, owner_replica_id,provider_effect_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'IN_FLIGHT', $8,$9)
         ON CONFLICT (invocation_id) DO NOTHING
         RETURNING *`,
        [
          request.invocationId,
          request.tenantId,
          request.operationId,
          request.taskId,
          request.stepKey,
          inputHash,
          JSON.stringify(sealedRequest),
          this.replicaId ?? null,
          providerEffectId,
        ],
      );
      if (inserted.rows[0]) {
        if (providerEffectId && backupGate && this.bootId) {
          await insertConnectorEffectPermit(tx, {
            effectId: providerEffectId,
            domain: 'provider',
            operationId: request.operationId,
            invocationId: request.invocationId,
            replicaId: this.replicaId ?? 'unconfigured',
            runtimeIdentity: this.runtimeIdentity ?? 'unconfigured',
            bootId: this.bootId,
            fenceRevision: Number(backupGate.fence_revision),
          });
        }
        // The claimed record is built from the in-memory request rather than
        // unwrapping the envelope just written; behavior is identical and no
        // extra key operation is spent on the write path.
        return { kind: 'claimed' as const, record: recordFromClaim(request, inputHash, inserted.rows[0]) };
      }

      // A concurrent first claimant may have inserted this ID after our
      // pre-check. ON CONFLICT makes that a replay/conflict path instead of
      // surfacing a primary-key violation as an HTTP 500.
      const raced = await tx.query<InvocationRow>(
        'SELECT * FROM connector_invocations WHERE invocation_id = $1 FOR UPDATE',
        [request.invocationId],
      );
      if (!raced.rows[0]) {
        throw new ConnectorError('INVOCATION_UNKNOWN', 'Invocation claim could not be reconciled.');
      }
      const record = await this.toRecord(raced.rows[0]);
      return record.inputHash === inputHash
        ? { kind: 'replay' as const, record }
        : { kind: 'conflict' as const, record };
    });
  }

  public async claimPendingPoll(
    invocationId: string,
    inputHash: string,
    now: number,
    leaseMs: number,
  ): Promise<string | undefined> {
    const token = randomUUID();
    const effectId = this.bootId ? randomUUID() : null;
    const claim = async (tx: SqlClient): Promise<string | undefined> => {
      const gate = this.bootId ? await lockConnectorBackupEffectGate(tx) : undefined;
      if (gate && gate.state !== 'OPEN') return undefined;
      const updated = await tx.query<Pick<InvocationRow, 'poll_lease_token'> & { operation_id: string }>(
        `UPDATE connector_invocations
         SET state = 'POLLING', poll_lease_token = $4,
             poll_lease_expires_at = $3::timestamptz + ($5 * interval '1 millisecond'),
             poll_effect_id=$6,updated_at = now()
         WHERE invocation_id = $1 AND input_hash = $2 AND state = 'PENDING'
           AND next_poll_at IS NOT NULL AND next_poll_at <= $3
         RETURNING poll_lease_token,operation_id`,
        [invocationId, inputHash, new Date(now).toISOString(), token, leaseMs, effectId],
      );
      const row = updated.rows[0];
      if (!row) return undefined;
      if (effectId && gate && this.bootId) {
        await insertConnectorEffectPermit(tx, {
          effectId,
          domain: 'poll',
          operationId: row.operation_id,
          invocationId,
          replicaId: this.replicaId ?? 'unconfigured',
          runtimeIdentity: this.runtimeIdentity ?? 'unconfigured',
          bootId: this.bootId,
          ownerToken: token,
          fenceRevision: Number(gate.fence_revision),
        });
      }
      return row.poll_lease_token ?? undefined;
    };
    return this.bootId ? this.db.transaction(claim) : claim(this.db);
  }

  public async activateEffect(invocationId: string, pollLeaseToken?: string): Promise<boolean> {
    if (!this.bootId || !this.replicaId) return true;
    return this.db.transaction(async (tx) => {
      const gate = await lockConnectorBackupEffectGate(tx);
      const invocation = await tx.query<Pick<InvocationRow, 'provider_effect_id' | 'poll_effect_id' | 'state'>>(
        `SELECT provider_effect_id,poll_effect_id,state FROM connector_invocations WHERE invocation_id=$1 FOR UPDATE`,
        [invocationId],
      );
      const current = invocation.rows[0];
      if (!current) return false;
      const isPoll = pollLeaseToken !== undefined;
      const effectId = isPoll ? current.poll_effect_id : current.provider_effect_id;
      if (!effectId) return false;
      const permit = await tx.query<{ state: string; fence_revision: number | string }>(
        `SELECT state,fence_revision FROM connector_backup_effect_permits
          WHERE effect_id=$1 AND owner_replica_id=$2 AND owner_boot_id=$3 AND domain=$4
            AND ($5::uuid IS NULL OR owner_token=$5::uuid) FOR UPDATE`,
        [effectId, this.replicaId, this.bootId, isPoll ? 'poll' : 'provider', pollLeaseToken ?? null],
      );
      const row = permit.rows[0];
      if (!row || row.state !== 'PREPARED') return false;
      if (gate.state !== 'OPEN' || Number(row.fence_revision) !== Number(gate.fence_revision)) {
        const timestamp = new Date().toISOString();
        await tx.query(
          `UPDATE connector_backup_effect_permits SET state='CANCELLED',reason_code='BACKUP_FENCE_ACTIVE',settled_at=$2,updated_at=$2
            WHERE effect_id=$1 AND state='PREPARED'`, [effectId, timestamp],
        );
        if (isPoll) {
          await tx.query(
            `UPDATE connector_invocations SET state='PENDING',poll_lease_token=NULL,poll_lease_expires_at=NULL,
                poll_effect_id=NULL,updated_at=$3
              WHERE invocation_id=$1 AND state='POLLING' AND poll_lease_token=$2 AND poll_effect_id=$4`,
            [invocationId, pollLeaseToken, timestamp, effectId],
          );
        } else {
          await tx.query(
            `UPDATE connector_invocations SET state='FAILED',error_code='PROVIDER_UNAVAILABLE',provider_effect_id=NULL,updated_at=$2
              WHERE invocation_id=$1 AND state='IN_FLIGHT' AND provider_effect_id=$3`,
            [invocationId, timestamp, effectId],
          );
        }
        return false;
      }
      const updated = await tx.query(
        `UPDATE connector_backup_effect_permits SET state='ACTIVE',activated_at=$2,updated_at=$2
          WHERE effect_id=$1 AND state='PREPARED' AND fence_revision=$3`,
        [effectId, new Date().toISOString(), Number(gate.fence_revision)],
      );
      return updated.rowCount === 1;
    });
  }

  public async complete(
    invocationId: string,
    result: NormalizedProviderResult,
    pollLeaseToken?: string,
  ): Promise<InvocationRecord> {
    const tenantId = await this.tenantFor(invocationId);
    if (tenantId === undefined) {
      throw new ConnectorError('INVOCATION_UNKNOWN', `Invocation ${invocationId} cannot be updated.`);
    }
    // SEC-ENC-02: the result never reaches SQL unsealed.
    const sealedResult = await this.sealField(
      { tenantId, slot: 'connector_invocations.result', refId: invocationId },
      result,
    );
    const claimPredicate = pollLeaseToken === undefined
      ? "state = 'IN_FLIGHT'"
      : "state = 'POLLING' AND poll_lease_token = $4";
    const record = await this.db.transaction(async (tx) => {
    const updated = await tx.query<InvocationRow>(
      `UPDATE connector_invocations
       SET state = 'SUCCEEDED', result = $2::jsonb, provider_request_id = $3,
           poll_lease_token = NULL, poll_lease_expires_at = NULL,
           quota_lease_key = NULL, quota_lease_id = NULL, quota_lease_expires_at = NULL,
           updated_at = now()
       WHERE invocation_id = $1 AND ${claimPredicate}
       RETURNING *`,
      pollLeaseToken === undefined
        ? [invocationId, JSON.stringify(sealedResult), result.providerRequestId ?? null]
        : [invocationId, JSON.stringify(sealedResult), result.providerRequestId ?? null, pollLeaseToken],
    );
    const row = updated.rows[0];
    if (row && result.usage) {
      const event: UsageEvent = { eventId: `${invocationId}:1`, invocationId, operationId: row.operation_id, taskId: row.task_id, usage: result.usage, createdAt: new Date(row.updated_at).toISOString() };
      // Reject unusable provider usage before committing either completion or delivery.
      await new PostgresUsageOutbox(tx).append(event);
    }
    return this.requireUpdated(row, invocationId);
    });
    await this.settleEffect(invocationId, pollLeaseToken, 'COMPLETED');
    return record;
  }

  public async failPending(
    invocationId: string,
    inputHash: string,
    errorCode: ConnectorErrorCode,
  ): Promise<boolean> {
    const updated = await this.db.query<Pick<InvocationRow, 'invocation_id'>>(
      `UPDATE connector_invocations
       SET state = 'FAILED', error_code = $3,
           poll_lease_token = NULL, poll_lease_expires_at = NULL,
           quota_lease_key = NULL, quota_lease_id = NULL, quota_lease_expires_at = NULL,
           updated_at = now()
       WHERE invocation_id = $1 AND input_hash = $2 AND state = 'PENDING'
       RETURNING invocation_id`,
      [invocationId, inputHash, errorCode],
    );
    return Boolean(updated.rows[0]);
  }

  public async fail(
    invocationId: string,
    errorCode: ConnectorErrorCode,
    pollLeaseToken?: string,
  ): Promise<InvocationRecord> {
    const claimPredicate = pollLeaseToken === undefined
      ? "state = 'IN_FLIGHT'"
      : "state = 'POLLING' AND poll_lease_token = $3";
    const updated = await this.db.query<InvocationRow>(
      `UPDATE connector_invocations
       SET state = 'FAILED', error_code = $2, poll_lease_token = NULL,
           poll_lease_expires_at = NULL, quota_lease_key = NULL, quota_lease_id = NULL,
           quota_lease_expires_at = NULL, updated_at = now()
       WHERE invocation_id = $1 AND ${claimPredicate}
       RETURNING *`,
      pollLeaseToken === undefined ? [invocationId, errorCode] : [invocationId, errorCode, pollLeaseToken],
    );
    const record = await this.requireUpdated(updated.rows[0], invocationId);
    await this.settleEffect(invocationId, pollLeaseToken, 'COMPLETED');
    return record;
  }

  public async cancel(invocationId: string): Promise<InvocationRecord> {
    const updated = await this.db.query<InvocationRow>(
      `UPDATE connector_invocations SET state = 'CANCELLED', error_code = 'CANCELLED',
       poll_lease_token = NULL, poll_lease_expires_at = NULL,
       quota_lease_key = NULL, quota_lease_id = NULL, quota_lease_expires_at = NULL,
       updated_at = now()
       WHERE invocation_id = $1 AND state IN ('IN_FLIGHT', 'PENDING', 'POLLING') RETURNING *`,
      [invocationId],
    );
    const record = await this.requireUpdated(updated.rows[0], invocationId);
    await this.settleEffect(invocationId, undefined, 'CANCELLED');
    return record;
  }

  public async markUnknown(invocationId: string, pollLeaseToken?: string): Promise<InvocationRecord> {
    const record = await this.updateState(invocationId, 'UNKNOWN', 'INVOCATION_UNKNOWN', pollLeaseToken);
    await this.settleEffect(invocationId, pollLeaseToken, 'UNKNOWN');
    return record;
  }

  public async markPending(
    invocationId: string,
    nextPollAt: string,
    providerRequestId?: string,
    pollLeaseToken?: string,
    quotaLease?: QuotaLease,
    providerPollAttempt = false,
    sessionRef?: string | null,
  ): Promise<InvocationRecord> {
    const quotaValues = quotaLease === undefined
      ? [null, null, null]
      : [quotaLease.key, quotaLease.leaseId, new Date(quotaLease.expiresAt).toISOString()];
    // SEC-ENC-02: a new continuation session is sealed before the COALESCE
    // update. `undefined`/`null` keeps the stored value untouched, so the
    // quota-retry paths (which never carry a session) do not touch a key.
    let sealedSessionRef: string | null = null;
    if (sessionRef !== undefined && sessionRef !== null) {
      const tenantId = await this.tenantFor(invocationId);
      if (tenantId === undefined) {
        throw new ConnectorError('INVOCATION_UNKNOWN', `Invocation ${invocationId} cannot be updated.`);
      }
      const sealed = await this.sealField(
        { tenantId, slot: 'connector_invocations.session_ref', refId: invocationId },
        sessionRef,
      );
      sealedSessionRef = JSON.stringify(sealed);
    }
    const updated = await this.db.query<InvocationRow>(
      `UPDATE connector_invocations
       SET state = 'PENDING', next_poll_at = $2, provider_request_id = COALESCE($3, provider_request_id),
           session_ref = COALESCE($9, session_ref),
           poll_lease_token = NULL, poll_lease_expires_at = NULL,
           quota_lease_key = COALESCE($5, quota_lease_key),
           quota_lease_id = COALESCE($6, quota_lease_id),
           quota_lease_expires_at = COALESCE($7, quota_lease_expires_at),
           provider_poll_attempts = provider_poll_attempts + CASE WHEN $8 THEN 1 ELSE 0 END,
           updated_at = now()
       WHERE invocation_id = $1 AND (
         ($4::text IS NULL AND state = 'IN_FLIGHT')
         OR ($4::text IS NOT NULL AND state = 'POLLING' AND poll_lease_token = $4)
       ) RETURNING *`,
      [
        invocationId,
        nextPollAt,
        providerRequestId ?? null,
        pollLeaseToken ?? null,
        ...quotaValues,
        providerPollAttempt,
        sealedSessionRef,
      ],
    );
    const record = await this.requireUpdated(updated.rows[0], invocationId);
    await this.settleEffect(invocationId, pollLeaseToken, 'COMPLETED');
    return record;
  }

  private async settleEffect(
    invocationId: string,
    pollLeaseToken: string | undefined,
    outcome: 'COMPLETED' | 'CANCELLED' | 'UNKNOWN',
  ): Promise<void> {
    if (!this.bootId || !this.replicaId) return;
    await this.db.transaction(async (tx) => {
      // Keep the same fence → invocation → permit order as claim/activation.
      // Settlement still proceeds while HELD; the lock lets the backup
      // observer distinguish in-flight settlement from a closed effect.
      await lockConnectorBackupEffectGate(tx);
      const invocation = await tx.query<Pick<InvocationRow, 'provider_effect_id' | 'poll_effect_id'>>(
        `SELECT provider_effect_id,poll_effect_id FROM connector_invocations WHERE invocation_id=$1 FOR UPDATE`,
        [invocationId],
      );
      const effectId = pollLeaseToken !== undefined
        ? invocation.rows[0]?.poll_effect_id
        : invocation.rows[0]?.provider_effect_id;
      if (!effectId) return;
      if (outcome === 'UNKNOWN') {
        await tx.query(
          `UPDATE connector_backup_effect_permits SET state='UNKNOWN',reason_code='INVOCATION_UNKNOWN',updated_at=$4
            WHERE effect_id=$1 AND owner_replica_id=$2 AND owner_boot_id=$3
              AND state IN ('PREPARED','ACTIVE','SETTLING')`,
          [effectId, this.replicaId, this.bootId, new Date().toISOString()],
        );
        return;
      }
      await tx.query(
        `UPDATE connector_backup_effect_permits
            SET state=CASE WHEN state='PREPARED' THEN 'CANCELLED' WHEN $4='CANCELLED' THEN 'UNKNOWN' ELSE 'COMPLETED' END,
                settled_at=$5,updated_at=$5
          WHERE effect_id=$1 AND owner_replica_id=$2 AND owner_boot_id=$3
            AND state IN ('PREPARED','ACTIVE','SETTLING')`,
        [effectId, this.replicaId, this.bootId, outcome, new Date().toISOString()],
      );
      await tx.query(
        `UPDATE connector_invocations SET
            provider_effect_id=CASE WHEN $2::uuid IS NULL THEN NULL ELSE provider_effect_id END,
            poll_effect_id=CASE WHEN $2::uuid IS NOT NULL THEN NULL ELSE poll_effect_id END
          WHERE invocation_id=$1`, [invocationId, pollLeaseToken ?? null],
      );
    });
  }

  private async updateState(
    invocationId: string,
    state: InvocationState,
    errorCode: ConnectorErrorCode,
    pollLeaseToken?: string,
  ): Promise<InvocationRecord> {
    const claimPredicate = pollLeaseToken === undefined
      ? "state = 'IN_FLIGHT'"
      : "state = 'POLLING' AND poll_lease_token = $4";
    const updated = await this.db.query<InvocationRow>(
      `UPDATE connector_invocations SET state = $2, error_code = $3,
       poll_lease_token = NULL, poll_lease_expires_at = NULL, updated_at = now()
       WHERE invocation_id = $1 AND ${claimPredicate} RETURNING *`,
      pollLeaseToken === undefined
        ? [invocationId, state, errorCode]
        : [invocationId, state, errorCode, pollLeaseToken],
    );
    return this.requireUpdated(updated.rows[0], invocationId);
  }

  private async requireUpdated(row: InvocationRow | undefined, invocationId: string): Promise<InvocationRecord> {
    if (!row) throw new ConnectorError('INVOCATION_UNKNOWN', `Invocation ${invocationId} cannot be updated.`);
    return this.toRecord(row);
  }
}

/**
 * Build the claimed record from the in-memory request instead of unwrapping
 * the envelope that was just written. The row's non-content fields are copied
 * exactly as the INSERT ... RETURNING would have returned them.
 */
function recordFromClaim(
  request: LocalInvocationRequest,
  inputHash: string,
  row: InvocationRow,
): InvocationRecord {
  return {
    request,
    inputHash,
    state: row.state,
    updatedAt: row.updated_at,
    providerPollAttempts: Number(row.provider_poll_attempts ?? 0),
  };
}

/**
 * Map a crypto failure onto the connector's existing error taxonomy without
 * adding surface area to the wire contract:
 *   - key provider outage  -> PROVIDER_UNAVAILABLE (retryable, no write)
 *   - tamper / wrong row   -> INVOCATION_UNKNOWN (reconcile, never retry)
 * Messages are fixed and content-free: no plaintext, key, or ciphertext.
 */
function mapInvocationCryptoFailure(error: unknown): ConnectorError {
  if (error instanceof InvocationFieldCryptoError) {
    if (error.code === 'KEY_PROVIDER_FAILED') {
      return new ConnectorError('PROVIDER_UNAVAILABLE', 'Invocation storage key service is unavailable.', {
        safeToRetry: true,
      });
    }
    return new ConnectorError('INVOCATION_UNKNOWN', 'Stored invocation data failed authenticated protection.');
  }
  return new ConnectorError('INVOCATION_UNKNOWN', 'Invocation storage protection failed.');
}

export interface ConnectorRevision {
  connectorId: string;
  revision: number;
  adapter: string;
  config: AdapterConfig;
  credentialRef: string;
  state: 'PENDING' | 'ACTIVE' | 'RETIRED';
  /** Every persisted revision carries an explicit source discriminator. */
  credentialSource: CredentialSource;
  /**
   * W-VAULT01-BIND-1R (VAULT-01): the trusted tenant binding stored WITH the
   * row (migration 008). '' means the row predates binding and stays reachable
   * only through the unbound legacy selector; a bound row is only ever
   * selectable by its own tenant.
   */
  tenantId: string;
  /** vault-kv2 rows carry the account coordinate as its own column. */
  accountId?: string;
}

export type NewConnectorRevision = Omit<ConnectorRevision, 'revision' | 'credentialSource' | 'accountId' | 'tenantId'> & {
  /** Omission at the legacy create endpoint is normalized to an explicit legacy-db source. */
  credentialSource?: CredentialSource;
  /** Absent = unbound (legacy) binding; vault revisions require the trusted scope explicitly. */
  tenantId?: string;
  /** Independent account binding supplied by the trusted management writer. */
  accountId?: string;
};

/** W-VAULT01-BIND-1R: the unbound (pre-binding) tenant selector value. */
export const LEGACY_UNBOUND_TENANT_ID = '';

/**
 * W-VAULT-LEGACY-TRANSITION-1 input: the trusted transition request. The
 * credentialRef is a FRESH chain key derived by the management layer (the
 * shared legacy ref may never join a bound chain - migration 008), and
 * adapter/config are cloned from the validated legacy row.
 */
export interface LegacyTransitionInput {
  readonly connectorId: string;
  readonly adapter: string;
  readonly config: AdapterConfig;
  readonly credentialRef: string;
  readonly credentialSource: CredentialSource;
  readonly tenantId: string;
  readonly accountId: string;
}

export interface RevisionScope {
  /** Trusted tenant of the operation. Absent/empty = unbound legacy selector. */
  readonly tenantId?: string;
}

export interface RevisionBinding {
  readonly tenantId: string;
  readonly accountId?: string;
}

const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isBoundRevisionTenant(tenantId: string | undefined): boolean {
  return typeof tenantId === 'string' && tenantId.length > 0;
}

/**
 * W-VAULT01-BIND-1R: derive the trusted (tenant_id, connector_id, account_id)
 * binding a revision row may persist. A Vault ref cannot establish its own
 * trusted account or tenant: both are supplied independently by the management
 * writer and must match the parsed ref's exact canonical path. This mirrors
 * migration 008's row constraints before any SQL statement runs.
 */
export function deriveRevisionBinding(input: NewConnectorRevision): RevisionBinding {
  const claimed = input.tenantId ?? LEGACY_UNBOUND_TENANT_ID;
  if (claimed !== LEGACY_UNBOUND_TENANT_ID && !TENANT_ID_PATTERN.test(claimed)) {
    throw new ConnectorError('INVALID_INPUT', 'Revision tenant binding is not a valid tenant id.');
  }
  const source = parseCredentialSource(input.credentialSource ?? {
    kind: 'legacy-db',
    credentialRef: input.credentialRef,
  });
  if (source.kind === 'legacy-db') {
    if (claimed !== LEGACY_UNBOUND_TENANT_ID || input.accountId !== undefined) {
      throw new ConnectorError('BINDING_DENIED', 'Legacy-db revisions cannot carry a tenant binding.');
    }
    return { tenantId: LEGACY_UNBOUND_TENANT_ID };
  }
  if (!isBoundRevisionTenant(claimed) || !input.accountId) {
    throw new ConnectorError('INVALID_INPUT', 'vault-kv2 revisions require explicit tenantId and accountId bindings.');
  }
  const binding = {
    tenantId: claimed,
    connectorId: input.connectorId,
    accountId: input.accountId,
  };
  if (!ConnectorRevisionBindingSchema.safeParse(binding).success) {
    throw new ConnectorError('INVALID_INPUT', 'Vault revision binding is invalid.');
  }
  if (!matchesVaultRevisionBinding(source, binding)) {
    throw new ConnectorError('BINDING_DENIED', 'Vault source does not match the trusted revision binding.');
  }
  return { tenantId: claimed, accountId: input.accountId };
}

export interface CredentialSecretStore {
  put(credentialRef: string, encryptedValue: Uint8Array): Promise<string>;
  revoke(credentialRef: string, scope?: RevisionScope): Promise<void>;
}

export interface ConnectorConfigRepository extends CredentialSecretStore {
  list(): Promise<ConnectorRevision[]>;
  get(connectorId: string, scope?: RevisionScope): Promise<ConnectorRevision | undefined>;
  getRevision(connectorId: string, revision: number, scope?: RevisionScope): Promise<ConnectorRevision | undefined>;
  /** VAULT-06: the CURRENT routable revision of the SCOPE's chain = highest-numbered ACTIVE. */
  getActiveRevision(connectorId: string, scope?: RevisionScope): Promise<ConnectorRevision | undefined>;
  createRevision(input: NewConnectorRevision): Promise<ConnectorRevision>;
  /**
   * W-VAULT-LEGACY-TRANSITION-1: atomically open the BOUND chain for a
   * connector whose current row is still the unbound legacy-db revision.
   * Unlike createPendingRevision (clone CURRENT of the bound chain + CAS
   * activate - structurally impossible for the first bound revision, which
   * has no prior ACTIVE row), bootstrap validates the legacy precondition
   * and writes the ACTIVE first row in ONE transaction, so no window ever
   * exists where a routable chain has no ACTIVE row. Replays return the
   * existing bound ACTIVE row (replayed=true): the double-bootstrap race
   * converges instead of 500ing on the chain guard.
   */
  bootstrapVaultRevision(input: LegacyTransitionInput): Promise<{ revision: ConnectorRevision; replayed: boolean }>;
  disable(connectorId: string, scope?: RevisionScope): Promise<void>;
  getActiveCredential(credentialRef: string, scope?: RevisionScope): Promise<Uint8Array | undefined>;
  /**
   * VAULT-06: CAS activation — flip revision PENDING→ACTIVE and the current
   * ACTIVE→RETIRED ONLY while the current still equals expectedCurrent.
   * Single transaction, row-locked: two racing activations cannot both pass.
   * W-VAULT01-BIND-1R: the whole CAS runs inside the scope's tenant chain; a
   * foreign selector matches no rows and cannot flip anything.
   */
  activateRevision(connectorId: string, revision: number, expectedCurrentRevision: number, scope?: RevisionScope): Promise<boolean>;
  /** VAULT-06: retire a stranded PENDING (reconcile path). ACTIVE rows are untouched. */
  retireRevision(connectorId: string, revision: number, scope?: RevisionScope): Promise<void>;
}

interface RevisionRowShape {
  connector_id: string;
  revision: number;
  adapter: string;
  config: AdapterConfig;
  credential_ref: string;
  state: 'PENDING' | 'ACTIVE' | 'RETIRED';
  credential_source: unknown;
  tenant_id?: string | null;
  account_id?: string | null;
}

// W-VAULT01-BIND-1R: every revision read projects the binding columns, and
// every scoped statement carries tenant_id as a bound parameter — the DB only
// ever returns/touches rows whose trusted binding equals the selector.
const REVISION_COLUMNS =
  'connector_id, revision, adapter, config, credential_ref, state, credential_source, tenant_id, account_id';

function scopeParam(scope: RevisionScope | undefined): string {
  return scope?.tenantId ?? LEGACY_UNBOUND_TENANT_ID;
}

export class PostgresConnectorConfigRepository implements ConnectorConfigRepository {
  public constructor(private readonly db: SqlClient) {}

  public async list(): Promise<ConnectorRevision[]> {
    const result = await this.db.query<RevisionRowShape>(
      'SELECT ' + REVISION_COLUMNS + ' FROM connector_revisions ORDER BY connector_id, revision',
    );
    return result.rows.map(toRevision);
  }

  public async get(connectorId: string, scope?: RevisionScope): Promise<ConnectorRevision | undefined> {
    const result = await this.db.query<RevisionRowShape>(
      'SELECT ' + REVISION_COLUMNS
        + ' FROM connector_revisions WHERE connector_id = $1 AND tenant_id = $2 ORDER BY revision DESC LIMIT 1',
      [connectorId, scopeParam(scope)],
    );
    return result.rows[0] ? toRevision(result.rows[0]) : undefined;
  }

  public async getRevision(connectorId: string, revision: number, scope?: RevisionScope): Promise<ConnectorRevision | undefined> {
    // Dual predicate: a BOUND row is only ever visible to its own tenant (the
    // DB, not the caller, states the binding — migration 008 guarantees the
    // stored tenant_id is trusted); unbound '' rows keep the pre-binding
    // shared-legacy semantics until VAULT-06 migration retires them.
    const result = await this.db.query<RevisionRowShape>(
      'SELECT ' + REVISION_COLUMNS
        + " FROM connector_revisions WHERE connector_id = $1 AND revision = $2 AND (tenant_id = $3 OR tenant_id = '')"
        + ' ORDER BY CASE WHEN tenant_id = $3 THEN 0 ELSE 1 END LIMIT 1',
      [connectorId, revision, scopeParam(scope)],
    );
    return result.rows[0] ? toRevision(result.rows[0]) : undefined;
  }

  public async getActiveRevision(connectorId: string, scope?: RevisionScope): Promise<ConnectorRevision | undefined> {
    const result = await this.db.query<RevisionRowShape>(
      'SELECT ' + REVISION_COLUMNS
        + " FROM connector_revisions WHERE connector_id = $1 AND tenant_id = $2 AND state = 'ACTIVE' ORDER BY revision DESC LIMIT 1",
      [connectorId, scopeParam(scope)],
    );
    return result.rows[0] ? toRevision(result.rows[0]) : undefined;
  }

  public async put(credentialRef: string, encryptedValue: Uint8Array): Promise<string> {
    const id = credentialRef + ':' + String(Date.now());
    await this.db.transaction(async (tx) => {
      const gate = await lockConnectorBackupEffectGate(tx);
      assertConnectorBackupEffectGateOpen(gate);
      await tx.query(
        'INSERT INTO secret_versions (id, credential_ref, encrypted_value) VALUES ($1, $2, $3)',
        [id, credentialRef, Buffer.from(encryptedValue)],
      );
    });
    return id;
  }

  public async createRevision(input: NewConnectorRevision): Promise<ConnectorRevision> {
    // Binding is derived from the parsed source + trusted claim BEFORE any
    // statement runs; a spoofed combination never reaches the database.
    const binding = deriveRevisionBinding(input);
    const credentialSource = parseCredentialSource(input.credentialSource ?? {
      kind: 'legacy-db',
      credentialRef: input.credentialRef,
    });
    if (credentialSource.kind === 'vault-kv2') {
      if (!matchesVaultRevisionBinding(credentialSource, {
        tenantId: binding.tenantId,
        connectorId: input.connectorId,
        accountId: binding.accountId,
      })) {
        throw new ConnectorError('BINDING_DENIED', 'Vault source does not match the trusted revision binding.');
      }
    }
    if (credentialSource.kind === 'legacy-db' && credentialSource.credentialRef !== input.credentialRef) {
      throw new ConnectorError('CREDENTIAL_INVALID', 'Legacy credential source does not match credential_ref.');
    }
    try {
      ConnectorRevisionConfigSchema.parse(input.config);
    } catch {
      throw new ConnectorError('INVALID_INPUT', 'Connector revision config is invalid or contains credential material.');
    }
    return this.db.transaction(async (tx) => {
      // The backup singleton is the first lock in every mutable config path.
      // This makes legacy revision and credential writes share the same
      // snapshot boundary as typed recipe publication.
      const backupGate = await lockConnectorBackupEffectGate(tx);
      assertConnectorBackupEffectGateOpen(backupGate);
      const latest = await tx.query<{ revision: number }>(
        'SELECT revision FROM connector_revisions WHERE connector_id = $1 AND tenant_id = $2 ORDER BY revision DESC LIMIT 1 FOR UPDATE',
        [input.connectorId, binding.tenantId],
      );
      const revision = Number(latest.rows[0]?.revision ?? 0) + 1;
      const result = await tx.query<RevisionRowShape>(
        'INSERT INTO connector_revisions'
          + ' (connector_id, revision, adapter, config, credential_ref, state, credential_source, tenant_id, account_id)'
          + " VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8, $9) RETURNING *",
        [
          input.connectorId,
          revision,
          input.adapter,
          JSON.stringify(input.config),
          input.credentialRef,
          input.state,
          JSON.stringify(credentialSource),
          binding.tenantId,
          binding.accountId ?? null,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new ConnectorError('CREDENTIAL_INVALID', 'Connector revision could not be persisted.');
      return toRevision(row);
    });
  }

  public async bootstrapVaultRevision(
    input: LegacyTransitionInput,
  ): Promise<{ revision: ConnectorRevision; replayed: boolean }> {
    // Same before-any-SQL trust as createRevision: a legacy source carrying
    // a tenant claim, a malformed tenant, or a vault ref that disagrees
    // with its independent binding never reaches a statement.
    const binding = deriveRevisionBinding({
      connectorId: input.connectorId,
      adapter: input.adapter,
      config: input.config,
      credentialRef: input.credentialRef,
      state: 'ACTIVE',
      tenantId: input.tenantId,
      accountId: input.accountId,
      credentialSource: input.credentialSource,
    });
    const want = parseCredentialSource(input.credentialSource);
    return this.db.transaction(async (tx) => {
      const backupGate = await lockConnectorBackupEffectGate(tx);
      assertConnectorBackupEffectGateOpen(backupGate);
      // Serialize against concurrent bootstrap/activation of the TARGET
      // chain first: an already-open bound chain replays instead of
      // colliding with the migration 008 chain guard.
      const active = await tx.query<RevisionRowShape>(
        'SELECT ' + REVISION_COLUMNS + ' FROM connector_revisions'
          + " WHERE connector_id = $1 AND tenant_id = $2 AND state = 'ACTIVE' ORDER BY revision DESC LIMIT 1 FOR UPDATE",
        [input.connectorId, binding.tenantId],
      );
      const openRow = active.rows[0];
      if (openRow) {
        const current = toRevision(openRow);
        const got = current.credentialSource;
        const samePin = want.kind === 'vault-kv2' && got.kind === 'vault-kv2'
          && want.version === got.version && want.path === got.path
          && want.key === got.key && want.mount === got.mount;
        if (!samePin) {
          throw new ConnectorError('BINDING_DENIED', 'The bound chain is already open with a different source.');
        }
        return { revision: current, replayed: true };
      }
      // The legacy precondition is storage-enforced, not only a management
      // echo: the unbound chain must currently exist AND be legacy-db.
      const legacy = await tx.query<RevisionRowShape>(
        'SELECT ' + REVISION_COLUMNS + ' FROM connector_revisions'
          + " WHERE connector_id = $1 AND tenant_id = '' ORDER BY revision DESC LIMIT 1 FOR UPDATE",
        [input.connectorId],
      );
      const legacyRow = legacy.rows[0];
      if (!legacyRow) {
        throw new ConnectorError('INVALID_INPUT', 'No unbound legacy revision exists to transition.');
      }
      if (toRevision(legacyRow).credentialSource.kind !== 'legacy-db') {
        throw new ConnectorError('INVALID_INPUT', 'The current unbound revision is not legacy-db.');
      }
      const latest = await tx.query<{ revision: number }>(
        'SELECT revision FROM connector_revisions WHERE connector_id = $1 AND tenant_id = $2 ORDER BY revision DESC LIMIT 1 FOR UPDATE',
        [input.connectorId, binding.tenantId],
      );
      const revision = Number(latest.rows[0]?.revision ?? 0) + 1;
      const result = await tx.query<RevisionRowShape>(
        'INSERT INTO connector_revisions'
          + ' (connector_id, revision, adapter, config, credential_ref, state, credential_source, tenant_id, account_id)'
          + ' VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8, $9) RETURNING *',
        [
          input.connectorId,
          revision,
          input.adapter,
          JSON.stringify(input.config),
          input.credentialRef,
          'ACTIVE',
          JSON.stringify(want),
          binding.tenantId,
          binding.accountId ?? null,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new ConnectorError('CREDENTIAL_INVALID', 'Bootstrap revision could not be persisted.');
      }
      return { revision: toRevision(row), replayed: false };
    });
  }

  public async activateRevision(
    connectorId: string,
    revision: number,
    expectedCurrentRevision: number,
    scope?: RevisionScope,
  ): Promise<boolean> {
    const tenantId = scopeParam(scope);
    return this.db.transaction(async (tx) => {
      const backupGate = await lockConnectorBackupEffectGate(tx);
      assertConnectorBackupEffectGateOpen(backupGate);
      const current = await tx.query<{ revision: number }>(
        'SELECT revision FROM connector_revisions'
          + " WHERE connector_id = $1 AND tenant_id = $2 AND state = 'ACTIVE' FOR UPDATE",
        [connectorId, tenantId],
      );
      if (Number(current.rows[0]?.revision ?? -1) !== expectedCurrentRevision) return false;
      const target = await tx.query<{ state: string }>(
        'SELECT state FROM connector_revisions WHERE connector_id = $1 AND revision = $2 AND tenant_id = $3 FOR UPDATE',
        [connectorId, revision, tenantId],
      );
      if (target.rows[0]?.state !== 'PENDING') return false;
      const flipped = await tx.query(
        'UPDATE connector_revisions SET state = $4'
          + " WHERE connector_id = $1 AND revision = $2 AND tenant_id = $3 AND state = 'PENDING'",
        [connectorId, revision, tenantId, 'ACTIVE'],
      );
      if (!flipped.rowCount) return false;
      await tx.query(
        'UPDATE connector_revisions SET state = $3 WHERE connector_id = $1 AND revision = $2 AND tenant_id = $4',
        [connectorId, expectedCurrentRevision, 'RETIRED', tenantId],
      );
      return true;
    });
  }

  public async retireRevision(connectorId: string, revision: number, scope?: RevisionScope): Promise<void> {
    await this.db.transaction(async (tx) => {
      const backupGate = await lockConnectorBackupEffectGate(tx);
      assertConnectorBackupEffectGateOpen(backupGate);
      await tx.query(
        'UPDATE connector_revisions SET state = $3'
          + " WHERE connector_id = $1 AND revision = $2 AND tenant_id = $4 AND state = 'PENDING'",
        [connectorId, revision, 'RETIRED', scopeParam(scope)],
      );
    });
  }

  public async disable(connectorId: string, scope?: RevisionScope): Promise<void> {
    await this.db.transaction(async (tx) => {
      const backupGate = await lockConnectorBackupEffectGate(tx);
      assertConnectorBackupEffectGateOpen(backupGate);
      await tx.query(
        'UPDATE connector_revisions SET state = $2 WHERE connector_id = $1 AND tenant_id = $3',
        [connectorId, 'RETIRED', scopeParam(scope)],
      );
    });
  }

  public async getActiveCredential(credentialRef: string, scope?: RevisionScope): Promise<Uint8Array | undefined> {
    // Migration 008 forbids a bound credential_ref from being shared across
    // tenants/connectors or mixed with legacy rows. The explicit unbound
    // legacy branch below preserves pre-binding shared-secret behavior.
    const result = await this.db.query<{ encrypted_value: Uint8Array }>(
      'SELECT s.encrypted_value FROM secret_versions s'
        + ' WHERE s.credential_ref = $1 AND s.revoked_at IS NULL'
        + ' AND EXISTS (SELECT 1 FROM connector_revisions r'
        + " WHERE r.credential_ref = s.credential_ref AND (r.tenant_id = $2 OR r.tenant_id = ''))"
        + ' ORDER BY s.rotated_at DESC LIMIT 1',
      [credentialRef, scopeParam(scope)],
    );
    const value = result.rows[0]?.encrypted_value;
    return value ? new Uint8Array(value) : undefined;
  }

  public async revoke(credentialRef: string, scope?: RevisionScope): Promise<void> {
    await this.db.transaction(async (tx) => {
      const backupGate = await lockConnectorBackupEffectGate(tx);
      assertConnectorBackupEffectGateOpen(backupGate);
      await tx.query(
        'UPDATE secret_versions s SET revoked_at = now() WHERE s.credential_ref = $1 AND s.revoked_at IS NULL'
          + ' AND EXISTS (SELECT 1 FROM connector_revisions r'
          + " WHERE r.credential_ref = s.credential_ref AND (r.tenant_id = $2 OR r.tenant_id = ''))",
        [credentialRef, scopeParam(scope)],
      );
    });
  }

}

function toRevision(row: RevisionRowShape): ConnectorRevision {
  const credentialSource = parseCredentialSource(row.credential_source);
  const tenantId = row.tenant_id ?? LEGACY_UNBOUND_TENANT_ID;
  const accountId = row.account_id ?? undefined;
  if (credentialSource.kind === 'legacy-db' && credentialSource.credentialRef !== row.credential_ref) {
    throw new ConnectorError('CREDENTIAL_INVALID', 'Persisted legacy credential source does not match credential_ref.');
  }
  if (credentialSource.kind === 'vault-kv2'
    && (!accountId || !matchesVaultRevisionBinding(credentialSource, {
      tenantId,
      connectorId: row.connector_id,
      accountId,
    }))) {
    throw new ConnectorError('CREDENTIAL_INVALID', 'Persisted Vault source does not match its revision binding.');
  }
  if (credentialSource.kind === 'legacy-db' && (tenantId !== LEGACY_UNBOUND_TENANT_ID || accountId !== undefined)) {
    throw new ConnectorError('CREDENTIAL_INVALID', 'Persisted legacy credential binding is invalid.');
  }
  return {
    connectorId: row.connector_id,
    revision: row.revision,
    adapter: row.adapter,
    config: row.config,
    credentialRef: row.credential_ref,
    state: row.state,
    credentialSource,
    tenantId,
    ...(accountId === undefined ? {} : { accountId }),
  };
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function normalizeTimestamp(value: string | Date): string {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new ConnectorError('INVOCATION_UNKNOWN', 'Stored invocation timestamp is invalid.');
  }
  return timestamp.toISOString();
}
