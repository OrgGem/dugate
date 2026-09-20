import { ConnectorError } from '../errors';
import type {
  AdapterConfig,
  ConnectorErrorCode,
  InvocationLedger,
  InvocationRecord,
  InvocationState,
  LocalInvocationRequest,
  NormalizedProviderResult,
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
  next_poll_at: string | null;
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
      const existing = await tx.query<InvocationRow>(
        'SELECT * FROM connector_invocations WHERE invocation_id = $1 FOR UPDATE',
        [request.invocationId],
      );
      if (existing.rows[0]) {
        const record = toRecord(existing.rows[0]);
        return record.inputHash === inputHash
          ? { kind: 'replay' as const, record }
          : { kind: 'conflict' as const, record };
      }
      const inserted = await tx.query<InvocationRow>(
        `INSERT INTO connector_invocations
          (invocation_id, tenant_id, operation_id, task_id, step_key, input_hash, request, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'IN_FLIGHT')
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
      return { kind: 'claimed' as const, record: toRecord(inserted.rows[0]) };
    });
  }

  public async complete(invocationId: string, result: NormalizedProviderResult): Promise<InvocationRecord> {
    const updated = await this.db.query<InvocationRow>(
      `UPDATE connector_invocations
       SET state = 'SUCCEEDED', result = $2::jsonb, provider_request_id = $3, updated_at = now()
       WHERE invocation_id = $1 AND state IN ('IN_FLIGHT', 'PENDING')
       RETURNING *`,
      [invocationId, JSON.stringify(result), result.providerRequestId ?? null],
    );
    return this.requireUpdated(updated.rows[0], invocationId);
  }

  public async fail(invocationId: string, errorCode: ConnectorErrorCode): Promise<InvocationRecord> {
    const updated = await this.db.query<InvocationRow>(
      `UPDATE connector_invocations
       SET state = 'FAILED', error_code = $2, updated_at = now()
       WHERE invocation_id = $1 AND state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
       RETURNING *`,
      [invocationId, errorCode],
    );
    return this.requireUpdated(updated.rows[0], invocationId);
  }

  public async cancel(invocationId: string): Promise<InvocationRecord> {
    const updated = await this.db.query<InvocationRow>(
      `UPDATE connector_invocations SET state = 'CANCELLED', error_code = 'CANCELLED', updated_at = now()
       WHERE invocation_id = $1 AND state IN ('IN_FLIGHT', 'PENDING') RETURNING *`,
      [invocationId],
    );
    return this.requireUpdated(updated.rows[0], invocationId);
  }

  public async markUnknown(invocationId: string): Promise<InvocationRecord> {
    return this.updateState(invocationId, 'UNKNOWN', 'INVOCATION_UNKNOWN');
  }

  public async markPending(invocationId: string, nextPollAt: string): Promise<InvocationRecord> {
    const updated = await this.db.query<InvocationRow>(
      `UPDATE connector_invocations SET state = 'PENDING', next_poll_at = $2, updated_at = now()
       WHERE invocation_id = $1 AND state IN ('IN_FLIGHT', 'PENDING') RETURNING *`,
      [invocationId, nextPollAt],
    );
    return this.requireUpdated(updated.rows[0], invocationId);
  }

  private async updateState(
    invocationId: string,
    state: InvocationState,
    errorCode: ConnectorErrorCode,
  ): Promise<InvocationRecord> {
    const updated = await this.db.query<InvocationRow>(
      `UPDATE connector_invocations SET state = $2, error_code = $3, updated_at = now()
       WHERE invocation_id = $1 AND state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED') RETURNING *`,
      [invocationId, state, errorCode],
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
  state: 'ACTIVE' | 'DISABLED';
}

export interface CredentialSecretStore {
  put(credentialRef: string, encryptedValue: Uint8Array): Promise<string>;
  revoke(credentialRef: string): Promise<void>;
}

export interface ConnectorConfigRepository extends CredentialSecretStore {
  list(): Promise<ConnectorRevision[]>;
  get(connectorId: string): Promise<ConnectorRevision | undefined>;
  getRevision(connectorId: string, revision: number): Promise<ConnectorRevision | undefined>;
  createRevision(input: Omit<ConnectorRevision, 'revision'>): Promise<ConnectorRevision>;
  disable(connectorId: string): Promise<void>;
  getActiveCredential(credentialRef: string): Promise<Uint8Array | undefined>;
}

export class PostgresConnectorConfigRepository implements ConnectorConfigRepository {
  public constructor(private readonly db: SqlClient) {}

  public async list(): Promise<ConnectorRevision[]> {
    const result = await this.db.query<{
      connector_id: string; revision: number; adapter: string; config: AdapterConfig;
      credential_ref: string; state: 'ACTIVE' | 'DISABLED';
    }>('SELECT connector_id, revision, adapter, config, credential_ref, state FROM connector_revisions ORDER BY connector_id, revision');
    return result.rows.map(toRevision);
  }

  public async get(connectorId: string): Promise<ConnectorRevision | undefined> {
    const result = await this.db.query<{
      connector_id: string; revision: number; adapter: string; config: AdapterConfig;
      credential_ref: string; state: 'ACTIVE' | 'DISABLED';
    }>(
      `SELECT connector_id, revision, adapter, config, credential_ref, state
       FROM connector_revisions WHERE connector_id = $1 ORDER BY revision DESC LIMIT 1`,
      [connectorId],
    );
    return result.rows[0] ? toRevision(result.rows[0]) : undefined;
  }

  public async getRevision(connectorId: string, revision: number): Promise<ConnectorRevision | undefined> {
    const result = await this.db.query<{
      connector_id: string; revision: number; adapter: string; config: AdapterConfig;
      credential_ref: string; state: 'ACTIVE' | 'DISABLED';
    }>(
      `SELECT connector_id, revision, adapter, config, credential_ref, state
       FROM connector_revisions WHERE connector_id = $1 AND revision = $2`,
      [connectorId, revision],
    );
    return result.rows[0] ? toRevision(result.rows[0]) : undefined;
  }

  public async put(credentialRef: string, encryptedValue: Uint8Array): Promise<string> {
    const id = `${credentialRef}:${Date.now()}`;
    await this.db.query(
      'INSERT INTO secret_versions (id, credential_ref, encrypted_value) VALUES ($1, $2, $3)',
      [id, credentialRef, Buffer.from(encryptedValue)],
    );
    return id;
  }

  public async createRevision(input: Omit<ConnectorRevision, 'revision'>): Promise<ConnectorRevision> {
    return this.db.transaction(async (tx) => {
      const latest = await tx.query<{ revision: number }>(
        'SELECT revision FROM connector_revisions WHERE connector_id = $1 ORDER BY revision DESC LIMIT 1 FOR UPDATE',
        [input.connectorId],
      );
      const revision = Number(latest.rows[0]?.revision ?? 0) + 1;
      const result = await tx.query<{
        connector_id: string; revision: number; adapter: string; config: AdapterConfig;
        credential_ref: string; state: 'ACTIVE' | 'DISABLED';
      }>(
        `INSERT INTO connector_revisions
          (connector_id, revision, adapter, config, credential_ref, state)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING *`,
        [
          input.connectorId,
          revision,
          input.adapter,
          JSON.stringify(input.config),
          input.credentialRef,
          input.state,
        ],
      );
      return toRevision(result.rows[0]);
    });
  }

  public async disable(connectorId: string): Promise<void> {
    await this.db.query(
      'UPDATE connector_revisions SET state = $2 WHERE connector_id = $1',
      [connectorId, 'DISABLED'],
    );
  }

  public async getActiveCredential(credentialRef: string): Promise<Uint8Array | undefined> {
    const result = await this.db.query<{ encrypted_value: Uint8Array }>(
      `SELECT encrypted_value FROM secret_versions
       WHERE credential_ref = $1 AND revoked_at IS NULL
       ORDER BY rotated_at DESC LIMIT 1`,
      [credentialRef],
    );
    const value = result.rows[0]?.encrypted_value;
    return value ? new Uint8Array(value) : undefined;
  }

  public async revoke(credentialRef: string): Promise<void> {
    await this.db.query(
      'UPDATE secret_versions SET revoked_at = now() WHERE credential_ref = $1 AND revoked_at IS NULL',
      [credentialRef],
    );
  }

}

function toRevision(row: {
  connector_id: string;
  revision: number;
  adapter: string;
  config: AdapterConfig;
  credential_ref: string;
  state: 'ACTIVE' | 'DISABLED';
}): ConnectorRevision {
  return {
    connectorId: row.connector_id,
    revision: row.revision,
    adapter: row.adapter,
    config: row.config,
    credentialRef: row.credential_ref,
    state: row.state,
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
    nextPollAt: row.next_poll_at ?? undefined,
    updatedAt: row.updated_at,
  };
}
