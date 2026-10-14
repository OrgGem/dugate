import { randomUUID } from 'node:crypto';
import {
  ConnectorDraftUpsertSchema,
  ConnectorParityDraftResultSchema,
  isTenantUuid,
  type ConnectorDraftUpsert,
  type ConnectorParityDraftResult,
} from '@du/contracts';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Db } from '../../db/db';
import { HttpError } from '../../http/errors';
import type { AuditService } from '../audit/audit';
import { decryptSecretValue } from '../secrets/secret-catalog-store';
import type { SecretCatalogKeyring } from '../secrets/secret-revision-resolver';
import type { BackupSnapshotWriteGate } from '../maintenance/backup-effect-fence';
import type { MetadataCrypto, SealedMetadata } from '../runtime/metadata-crypto';
import { metadataPlaintextHash } from '../runtime/metadata-crypto';

// Existing Vault-backed revisions use `recipe-<uuid>`; the encrypted-db
// writer uses a canonical UUID. These are the only opaque reference shapes
// accepted from the trusted Connector response.
const IMPORTED_CREDENTIAL_REF = /^(?:recipe-)?[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONNECTOR_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;
const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const IMPORT_LEASE_MS = 90_000;

export interface ConnectorSecretImportActor {
  actor: string;
  /** Only a currently authorized platform Admin may change shared connectors. */
  role: 'platform';
  issuer?: string;
  sub?: string;
  correlationId?: string;
}

export interface ConnectorSecretImportSource {
  catalogVersionRef: string;
  catalogKeyVersion: string;
}

export interface ResolvedConnectorSecretDraft {
  tenantId: string;
  connectorId: string;
  expectedHeadRevision: number;
  recipe: ConnectorDraftUpsert['recipe'];
  credentialChange: { action: 'replace'; secret: string };
  credentialImportSource: ConnectorSecretImportSource;
  idempotencyKey: string;
}

export interface ConnectorSecretImportSubmitter {
  claimRecipeDraft(input: {
    tenantId: string;
    connectorId: string;
    expectedHeadRevision: number;
    idempotencyKey: string;
  }): Promise<{ claimed: boolean; expectedHeadRevision: number }>;
  upsertResolvedRecipeDraft(input: ResolvedConnectorSecretDraft): Promise<ConnectorParityDraftResult>;
}

export interface ConnectorSecretImportServiceOptions {
  db: Db;
  audit: AuditService;
  metadataCrypto?: MetadataCrypto;
  catalogKeyring?: SecretCatalogKeyring;
  backupSnapshotWriteGate?: BackupSnapshotWriteGate;
  connector: ConnectorSecretImportSubmitter;
  now?: () => Date;
}

interface ImportRow extends QueryResultRow {
  import_id: string;
  tenant_id: string;
  connector_id: string;
  idempotency_key: string;
  request_hash: string;
  source_secret_id: string;
  source_revision: number | string;
  source_key_version: string;
  state: 'PENDING' | 'COMPLETED';
  resolved_payload: unknown;
  result: unknown;
  lease_token: string | null;
  lease_until: Date | string | null;
}

interface CatalogHeadRow extends QueryResultRow {
  secret_id: string;
  tenant_id: string;
  revision: number | string;
  purpose: string;
  services: string[];
  provider_kind: 'managed_value' | 'vault_reference';
  state: 'ACTIVE' | 'DISABLED' | 'REVOKED';
  encrypted_value: unknown;
  encryption_key_version: string | null;
}

interface ResolvedPayload {
  tenantId: string;
  connectorId: string;
  expectedHeadRevision: number;
  recipe: ConnectorDraftUpsert['recipe'];
  credentialChange: { action: 'replace'; secret: string };
  credentialImportSource: ConnectorSecretImportSource;
  idempotencyKey: string;
}

function conflict(message: string): never { throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', message); }
function invalid(message: string): never { throw new HttpError(422, 'INVALID_SCHEMA', message); }
function unavailable(): never {
  throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'Connector credential import is pending; retry with the same Idempotency-Key');
}

function context(tenantId: string, importId: string) {
  return { tenantId, slot: 'connector_secret_imports.resolved_payload' as const, refId: importId };
}

function parseResolvedPayload(value: unknown): ResolvedPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(503, 'SECRET_IMPORT_UNAVAILABLE', 'stored Connector credential import is invalid');
  }
  const row = value as Record<string, unknown>;
  const source = row.credentialImportSource as Record<string, unknown> | null;
  if (row.credentialChange === null || typeof row.credentialChange !== 'object') {
    throw new HttpError(503, 'SECRET_IMPORT_UNAVAILABLE', 'stored Connector credential import is invalid');
  }
  const credential = row.credentialChange as Record<string, unknown>;
  if (!isTenantUuid(row.tenantId)
      || typeof row.connectorId !== 'string' || !CONNECTOR_ID.test(row.connectorId)
      || !Number.isSafeInteger(row.expectedHeadRevision) || (row.expectedHeadRevision as number) < 0
      || typeof row.idempotencyKey !== 'string' || row.idempotencyKey.length < 8
      || credential.action !== 'replace' || typeof credential.secret !== 'string'
      || credential.secret.length < 1 || credential.secret.length > 16_384 || credential.secret.includes('\0')
      || !source || typeof source.catalogVersionRef !== 'string' || !/^([0-9a-f-]{36})@[1-9][0-9]{0,8}$/i.test(source.catalogVersionRef)
      || typeof source.catalogKeyVersion !== 'string' || !KEY_VERSION.test(source.catalogKeyVersion)) {
    throw new HttpError(503, 'SECRET_IMPORT_UNAVAILABLE', 'stored Connector credential import is invalid');
  }
  const request = ConnectorDraftUpsertSchema.safeParse({
    tenantId: row.tenantId,
    expectedHeadRevision: row.expectedHeadRevision,
    recipe: row.recipe,
    credentialChange: { action: 'replace', secret: credential.secret },
    idempotencyKey: row.idempotencyKey,
  });
  if (!request.success) throw new HttpError(503, 'SECRET_IMPORT_UNAVAILABLE', 'stored Connector credential import is invalid');
  return {
    tenantId: request.data.tenantId,
    connectorId: row.connectorId,
    expectedHeadRevision: request.data.expectedHeadRevision,
    recipe: request.data.recipe,
    credentialChange: { action: 'replace', secret: credential.secret },
    credentialImportSource: {
      catalogVersionRef: source.catalogVersionRef,
      catalogKeyVersion: source.catalogKeyVersion,
    },
    idempotencyKey: request.data.idempotencyKey,
  };
}

function parseResult(value: unknown): ConnectorParityDraftResult {
  const parsed = ConnectorParityDraftResultSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(503, 'SECRET_IMPORT_UNAVAILABLE', 'stored Connector import result is invalid');
  return parsed.data;
}

function activeCatalogKey(keyring: SecretCatalogKeyring | undefined, version: string | null): Buffer {
  if (!keyring || !version || !KEY_VERSION.test(version)) {
    throw new HttpError(503, 'SECRET_KEY_VERSION_UNAVAILABLE', 'the exact Secret Catalog encryption key version is unavailable');
  }
  const key = keyring.keys[version];
  if (!key || !Buffer.isBuffer(key) || key.length !== 32) {
    throw new HttpError(503, 'SECRET_KEY_VERSION_UNAVAILABLE', 'the exact Secret Catalog encryption key version is unavailable');
  }
  return key;
}

async function readCurrentCatalogCredential(
  client: PoolClient,
  keyring: SecretCatalogKeyring | undefined,
  tenantId: string,
  secretId: string,
): Promise<{ secret: string; source: ConnectorSecretImportSource; revision: number; keyVersion: string }> {
  const selected = await client.query<CatalogHeadRow>(
    `SELECT c.secret_id,c.tenant_id,c.state,v.revision,v.purpose,v.services,v.provider_kind,
            v.state AS revision_state,v.encrypted_value,v.encryption_key_version
       FROM secret_catalog c
       JOIN secret_catalog_revisions v
         ON v.secret_id=c.secret_id AND v.tenant_id=c.tenant_id AND v.revision=c.revision
      WHERE c.secret_id=$1 AND c.tenant_id=$2
      FOR SHARE OF c,v`,
    [secretId, tenantId],
  );
  const row = selected.rows[0] as (CatalogHeadRow & { revision_state?: string }) | undefined;
  if (!row || row.state !== 'ACTIVE' || row.revision_state !== 'ACTIVE'
      || row.purpose !== 'connector.credential' || !row.services.includes('connector')
      || row.provider_kind !== 'managed_value' || !row.encrypted_value) {
    throw new HttpError(403, 'SECRET_REFERENCE_DENIED', 'the selected Catalog credential is not active for this Connector tenant');
  }
  const keyVersion = row.encryption_key_version;
  const key = activeCatalogKey(keyring, keyVersion);
  let secret: string;
  try { secret = decryptSecretValue(row.encrypted_value, key); }
  catch { throw new HttpError(503, 'SECRET_DECRYPTION_FAILED', 'the selected Catalog credential could not be decrypted'); }
  if (secret.length < 1 || secret.length > 16_384 || secret.includes('\0')) {
    throw new HttpError(422, 'SECRET_VALUE_INVALID', 'the selected Catalog credential is outside Connector limits');
  }
  const revision = Number(row.revision);
  return {
    secret,
    revision,
    keyVersion: keyVersion!,
    source: { catalogVersionRef: `${row.secret_id}@${revision}`, catalogKeyVersion: keyVersion! },
  };
}

export function createConnectorSecretImportService(options: ConnectorSecretImportServiceOptions) {
  const now = options.now ?? (() => new Date());

  return {
    async importCredential(connectorId: string, rawInput: unknown, actor: ConnectorSecretImportActor): Promise<ConnectorParityDraftResult> {
      if (actor.role !== 'platform' || !actor.actor || actor.actor.length > 256) {
        throw new HttpError(403, 'PERMISSION_DENIED', 'Connector credential imports require a current platform Admin');
      }
      const crypto = options.metadataCrypto;
      if (!crypto) throw new HttpError(503, 'METADATA_ENCRYPTION_REQUIRED', 'Connector credential imports require metadata encryption');
      const publicInput = ConnectorDraftUpsertSchema.safeParse(rawInput);
      if (!publicInput.success) invalid('Connector draft request is invalid');
      if (publicInput.data.credentialChange.action !== 'vault-ref') {
        invalid('the Secret Catalog import path requires an opaque vault-ref credential change');
      }
      const { tenantId, idempotencyKey, expectedHeadRevision, recipe } = publicInput.data;
      if (!CONNECTOR_ID.test(connectorId)) invalid('connectorId is invalid');
      const catalogId = publicInput.data.credentialChange.reference;
      // This durable Connector-side claim proves current tenant ownership (or
      // reserves a genuinely unowned first revision) before Catalog plaintext
      // is opened. It also revalidates that owner on journal replays, while the
      // Connector claim's idempotency path tolerates the head advancing after
      // the original draft succeeds.
      const claim = await options.connector.claimRecipeDraft({
        tenantId, connectorId, expectedHeadRevision, idempotencyKey,
      });
      if (!claim.claimed || claim.expectedHeadRevision !== expectedHeadRevision) {
        throw new HttpError(409, 'CONNECTOR_SCOPE_CONFLICT', 'Connector tenant or draft revision is unavailable');
      }
      const requestHash = metadataPlaintextHash({
        tenantId, connectorId, expectedHeadRevision, recipe,
        credentialChange: { action: 'vault-ref', reference: catalogId },
        idempotencyKey,
      });
      const importId = randomUUID();
      const leaseToken = randomUUID();
      const timestamp = now();

      const reservation = await options.db.tx(async (client) => {
        if (!options.backupSnapshotWriteGate) {
          throw new HttpError(503, 'BACKUP_WRITE_GATE_UNAVAILABLE', 'Connector credential imports require the backup snapshot gate');
        }
        await options.backupSnapshotWriteGate.assertWriteAllowed(client, {
          tenantId,
          domain: 'secret-catalog-write',
          requestKey: `connector-secret-import:${requestHash.replace(/^sha256:/, '')}`,
        });
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `connector-secret-import:${tenantId}:${connectorId}:${idempotencyKey}`,
        ]);
        const existing = await client.query<ImportRow>(
          `SELECT import_id,tenant_id,connector_id,idempotency_key,request_hash,source_secret_id,source_revision,
                  source_key_version,state,resolved_payload,result,lease_token,lease_until
             FROM connector_secret_imports
            WHERE tenant_id=$1 AND connector_id=$2 AND idempotency_key=$3
            FOR UPDATE`,
          [tenantId, connectorId, idempotencyKey],
        );
        const row = existing.rows[0];
        if (row) {
          if (row.request_hash !== requestHash) conflict('Idempotency-Key was reused with different Connector import input');
          if (row.state === 'COMPLETED') return { kind: 'complete' as const, result: parseResult(row.result) };
          const leaseUntil = row.lease_until instanceof Date ? row.lease_until : row.lease_until ? new Date(row.lease_until) : null;
          if (row.lease_token && leaseUntil && leaseUntil.getTime() > timestamp.getTime()) {
            return { kind: 'busy' as const };
          }
          const claimed = await client.query(
            `UPDATE connector_secret_imports
                SET lease_token=$2,lease_until=$3,updated_at=$4
              WHERE import_id=$1 AND state='PENDING'`,
            [row.import_id, leaseToken, new Date(timestamp.getTime() + IMPORT_LEASE_MS), timestamp],
          );
          if (claimed.rowCount !== 1) return { kind: 'busy' as const };
          return { kind: 'claimed' as const, importId: row.import_id, payload: row.resolved_payload };
        }

        const credential = await readCurrentCatalogCredential(client, options.catalogKeyring, tenantId, catalogId);
        const payload: ResolvedPayload = {
          tenantId,
          connectorId,
          expectedHeadRevision,
          recipe,
          credentialChange: { action: 'replace', secret: credential.secret },
          credentialImportSource: credential.source,
          idempotencyKey,
        };
        const sealed = await crypto.seal(payload, context(tenantId, importId));
        await client.query(
          `INSERT INTO connector_secret_imports(
             import_id,tenant_id,connector_id,idempotency_key,request_hash,source_secret_id,source_revision,
             source_key_version,state,resolved_payload,lease_token,lease_until,created_by,created_by_issuer,created_by_sub,created_at,updated_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9,$10,$11,$12,$13,$14,$15,$15)`,
          [importId,tenantId,connectorId,idempotencyKey,requestHash,catalogId,credential.revision,
            credential.keyVersion,JSON.stringify(sealed),leaseToken,new Date(timestamp.getTime()+IMPORT_LEASE_MS),
            actor.actor,actor.issuer ?? null,actor.sub ?? null,timestamp],
        );
        await options.audit.record({
          tenantId, actor: actor.actor, actorIssuer: actor.issuer, actorSub: actor.sub, actorRole: 'platform',
          action: 'connector.secret-import.pending', resource: `connector:${connectorId}:secret-import:${importId}`,
          correlationId: actor.correlationId,
        }, client);
        return { kind: 'claimed' as const, importId, payload: sealed };
      });

      if (reservation.kind === 'complete') return { ...reservation.result, replayed: true };
      if (reservation.kind === 'busy') unavailable();

      let payload: ResolvedPayload;
      try {
        const opened = await crypto.open(reservation.payload as SealedMetadata, context(tenantId, reservation.importId));
        payload = parseResolvedPayload(opened);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(503, 'SECRET_IMPORT_UNAVAILABLE', 'stored Connector credential import could not be opened');
      }
      if (payload.tenantId !== tenantId || payload.connectorId !== connectorId || payload.idempotencyKey !== idempotencyKey) {
        throw new HttpError(503, 'SECRET_IMPORT_UNAVAILABLE', 'stored Connector credential import context is invalid');
      }

      let result: ConnectorParityDraftResult;
      try {
        result = ConnectorParityDraftResultSchema.parse(await options.connector.upsertResolvedRecipeDraft(payload));
        // This write-only import must produce the Connector's opaque generated
        // recipe credential reference, never a Vault path or echoed secret.
        // Also bind the producer response to this exact tenant/connector/CAS.
        if (result.revision.tenantId !== tenantId
            || result.revision.connectorId !== connectorId
            || result.revision.state !== 'PENDING'
            || result.revision.expectedHeadRevision !== expectedHeadRevision
            || result.expectedHeadRevision !== expectedHeadRevision
            || result.revision.revision !== expectedHeadRevision + 1
            || !result.revision.credentialRef
            || !IMPORTED_CREDENTIAL_REF.test(result.revision.credentialRef)
            || result.revision.credentialVersion === null) {
          throw new Error('Connector returned a result outside the imported draft contract');
        }
      } catch {
        // A transport or validation failure is ambiguous. Keep the durable
        // PENDING row and exact sealed payload; retries use the same Connector
        // idempotency key and never resolve the current Catalog head again.
        try {
          await options.db.tx(async (client) => {
            if (!options.backupSnapshotWriteGate) {
              throw new HttpError(503, 'BACKUP_WRITE_GATE_UNAVAILABLE', 'Connector credential imports require the backup snapshot gate');
            }
            await options.backupSnapshotWriteGate.assertWriteAllowed(client, {
              tenantId,
              domain: 'secret-catalog-write',
              requestKey: `connector-secret-import:${requestHash.replace(/^sha256:/, '')}`,
            });
            await client.query(
              `UPDATE connector_secret_imports SET lease_token=NULL,lease_until=NULL,updated_at=$2
                WHERE import_id=$1 AND state='PENDING' AND lease_token=$3`,
              [reservation.importId, now(), leaseToken],
            );
          });
        } catch { /* leave the durable pending lease to expire under a held fence */ }
        unavailable();
      }

      const finalized = await options.db.tx(async (client) => {
        if (!options.backupSnapshotWriteGate) {
          throw new HttpError(503, 'BACKUP_WRITE_GATE_UNAVAILABLE', 'Connector credential imports require the backup snapshot gate');
        }
        await options.backupSnapshotWriteGate.assertWriteAllowed(client, {
          tenantId,
          domain: 'secret-catalog-write',
          requestKey: `connector-secret-import:${requestHash.replace(/^sha256:/, '')}`,
        });
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `connector-secret-import:${tenantId}:${connectorId}:${idempotencyKey}`,
        ]);
        const update = await client.query(
          `UPDATE connector_secret_imports
              SET state='COMPLETED',result=$4,lease_token=NULL,lease_until=NULL,updated_at=$5
            WHERE import_id=$1 AND state='PENDING' AND lease_token=$2 AND request_hash=$3`,
          [reservation.importId,leaseToken,requestHash,JSON.stringify(result),now()],
        );
        if (update.rowCount !== 1) {
          const latest = await client.query<ImportRow>(
            `SELECT state,result FROM connector_secret_imports WHERE import_id=$1`, [reservation.importId],
          );
          const row = latest.rows[0];
          if (row?.state === 'COMPLETED') return parseResult(row.result);
          return null;
        }
        await options.audit.record({
          tenantId, actor: actor.actor, actorIssuer: actor.issuer, actorSub: actor.sub, actorRole: 'platform',
          action: 'connector.secret-import.completed', resource: `connector:${connectorId}:secret-import:${reservation.importId}`,
          correlationId: actor.correlationId, severity: 'success',
        }, client);
        return result;
      });
      if (!finalized) unavailable();
      return finalized;
    },
  };
}
