import { ConnectorError } from '../errors';
import {
  ConnectorRevisionBindingSchema,
  ConnectorRevisionConfigSchema,
  matchesVaultRevisionBinding,
} from '@du/contracts';
import { parseCredentialSource, type CredentialSource } from '../vault/resolver';
import { randomUUID } from 'node:crypto';
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
  next_poll_at: string | Date | null;
  poll_lease_token: string | null;
  poll_lease_expires_at: string | Date | null;
  quota_lease_key: string | null;
  quota_lease_id: string | null;
  quota_lease_expires_at: string | Date | null;
  provider_poll_attempts: number;
  updated_at: string;
}

export class PostgresInvocationLedger implements InvocationLedger {
  public constructor(private readonly db: SqlClient) {}

  public async get(invocationId: string): Promise<InvocationRecord | undefined> {
    const result = await this.db.query<InvocationRow>(
      'SELECT * FROM connector_invocations WHERE invocation_id = $1',
      [invocationId],
    );
    return result.rows[0] ? toRecord(result.rows[0]) : undefined;
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
      const inserted = await tx.query<InvocationRow>(
        `INSERT INTO connector_invocations
          (invocation_id, tenant_id, operation_id, task_id, step_key, input_hash, request, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'IN_FLIGHT')
         ON CONFLICT (invocation_id) DO NOTHING
         RETURNING *`,
        [
          request.invocationId,
          request.tenantId,
          request.operationId,
          request.taskId,
          request.stepKey,
          inputHash,
          JSON.stringify(request),
        ],
      );
      if (inserted.rows[0]) {
        return { kind: 'claimed' as const, record: toRecord(inserted.rows[0]) };
      }

      // A concurrent first claimant may have inserted this ID after our
      // INSERT began. ON CONFLICT makes that a replay/conflict path instead
      // of surfacing a primary-key violation as an HTTP 500.
      const existing = await tx.query<InvocationRow>(
        'SELECT * FROM connector_invocations WHERE invocation_id = $1 FOR UPDATE',
        [request.invocationId],
      );
      if (!existing.rows[0]) {
        throw new ConnectorError('INVOCATION_UNKNOWN', 'Invocation claim could not be reconciled.');
      }
      const record = toRecord(existing.rows[0]);
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
    const updated = await this.db.query<Pick<InvocationRow, 'poll_lease_token'>>(
      `UPDATE connector_invocations
       SET state = 'POLLING', poll_lease_token = $4,
           poll_lease_expires_at = $3::timestamptz + ($5 * interval '1 millisecond'),
           updated_at = now()
       WHERE invocation_id = $1 AND input_hash = $2 AND (
         (state = 'PENDING' AND next_poll_at IS NOT NULL AND next_poll_at <= $3)
         OR (state = 'POLLING' AND poll_lease_token IS NOT NULL AND poll_lease_expires_at <= $3)
       )
       RETURNING poll_lease_token`,
      [invocationId, inputHash, new Date(now).toISOString(), token, leaseMs],
    );
    return updated.rows[0]?.poll_lease_token ?? undefined;
  }

  public async complete(
    invocationId: string,
    result: NormalizedProviderResult,
    pollLeaseToken?: string,
  ): Promise<InvocationRecord> {
    const claimPredicate = pollLeaseToken === undefined
      ? "state = 'IN_FLIGHT'"
      : "state = 'POLLING' AND poll_lease_token = $4";
    const updated = await this.db.query<InvocationRow>(
      `UPDATE connector_invocations
       SET state = 'SUCCEEDED', result = $2::jsonb, provider_request_id = $3,
           poll_lease_token = NULL, poll_lease_expires_at = NULL,
           quota_lease_key = NULL, quota_lease_id = NULL, quota_lease_expires_at = NULL,
           updated_at = now()
       WHERE invocation_id = $1 AND ${claimPredicate}
       RETURNING *`,
      pollLeaseToken === undefined
        ? [invocationId, JSON.stringify(result), result.providerRequestId ?? null]
        : [invocationId, JSON.stringify(result), result.providerRequestId ?? null, pollLeaseToken],
    );
    return this.requireUpdated(updated.rows[0], invocationId);
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
    return this.requireUpdated(updated.rows[0], invocationId);
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
    return this.requireUpdated(updated.rows[0], invocationId);
  }

  public async markUnknown(invocationId: string, pollLeaseToken?: string): Promise<InvocationRecord> {
    return this.updateState(invocationId, 'UNKNOWN', 'INVOCATION_UNKNOWN', pollLeaseToken);
  }

  public async markPending(
    invocationId: string,
    nextPollAt: string,
    providerRequestId?: string,
    pollLeaseToken?: string,
    quotaLease?: QuotaLease,
    providerPollAttempt = false,
  ): Promise<InvocationRecord> {
    const quotaValues = quotaLease === undefined
      ? [null, null, null]
      : [quotaLease.key, quotaLease.leaseId, new Date(quotaLease.expiresAt).toISOString()];
    const updated = await this.db.query<InvocationRow>(
      `UPDATE connector_invocations
       SET state = 'PENDING', next_poll_at = $2, provider_request_id = COALESCE($3, provider_request_id),
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
      ],
    );
    return this.requireUpdated(updated.rows[0], invocationId);
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

  private requireUpdated(row: InvocationRow | undefined, invocationId: string): InvocationRecord {
    if (!row) throw new ConnectorError('INVOCATION_UNKNOWN', `Invocation ${invocationId} cannot be updated.`);
    return toRecord(row);
  }
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
    await this.db.query(
      'INSERT INTO secret_versions (id, credential_ref, encrypted_value) VALUES ($1, $2, $3)',
      [id, credentialRef, Buffer.from(encryptedValue)],
    );
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
    await this.db.query(
      'UPDATE connector_revisions SET state = $3'
        + " WHERE connector_id = $1 AND revision = $2 AND tenant_id = $4 AND state = 'PENDING'",
      [connectorId, revision, 'RETIRED', scopeParam(scope)],
    );
  }

  public async disable(connectorId: string, scope?: RevisionScope): Promise<void> {
    await this.db.query(
      'UPDATE connector_revisions SET state = $2 WHERE connector_id = $1 AND tenant_id = $3',
      [connectorId, 'RETIRED', scopeParam(scope)],
    );
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
    await this.db.query(
      'UPDATE secret_versions s SET revoked_at = now() WHERE s.credential_ref = $1 AND s.revoked_at IS NULL'
        + ' AND EXISTS (SELECT 1 FROM connector_revisions r'
        + " WHERE r.credential_ref = s.credential_ref AND (r.tenant_id = $2 OR r.tenant_id = ''))",
      [credentialRef, scopeParam(scope)],
    );
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


function toRecord(row: InvocationRow): InvocationRecord {
  return {
    request: row.request as LocalInvocationRequest,
    inputHash: row.input_hash,
    state: row.state,
    result: row.result as NormalizedProviderResult | undefined,
    errorCode: row.error_code ?? undefined,
    providerRequestId: row.provider_request_id ?? undefined,
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
