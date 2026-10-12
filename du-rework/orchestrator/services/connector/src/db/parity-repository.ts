import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  canonicalize,
  ConnectorRecipeSchema,
  ConnectorParityRevisionSchema,
  ConnectorCredentialSourceSchema,
  matchesVaultRevisionBinding,
  TenantActiveConnectorCatalogItemSchema,
  TenantActiveConnectorCatalogPageSchema,
  type TenantActiveConnectorCatalogPage,
  type TenantActiveConnectorCatalogQuery,
  type ConnectorParityRevision,
  type ConnectorRecipe,
  type VaultCredentialSource,
} from '@du/contracts';
import { ConnectorError } from '../errors';
import { isSealedInvocationField, type InvocationFieldCrypto } from './invocation-crypto';
import { assertConnectorBackupEffectGateOpen, lockConnectorBackupEffectGate, type ConnectorBackupConfigWritePort } from './backup-effect-fences';
import type { SqlClient } from './sql';

export interface ConnectorParityCredentialImportSource {
  catalogVersionRef: string;
  catalogKeyVersion: string;
}

export interface ConnectorParityStoredRevision extends ConnectorParityRevision {
  credentialSource: VaultCredentialSource | null;
}

export interface ConnectorParityIntentInput {
  tenantId: string;
  connectorId: string;
  idempotencyKey: string;
  payloadHash: string;
  operation: 'DRAFT' | 'ROLLBACK';
  expectedHeadRevision: number;
  sourceRevision?: number;
  recipe: ConnectorRecipe;
  credentialRef: string | null;
  credentialVersion: number | null;
  credentialSource: VaultCredentialSource | null;
  credentialImportSource: ConnectorParityCredentialImportSource | null;
  vaultExpectedVersion: number | null;
  vaultTargetVersion: number | null;
  vaultSecretSha256: string | null;
}

export interface ConnectorParityClaimInput {
  tenantId: string;
  connectorId: string;
  expectedHeadRevision: number;
  idempotencyKey: string;
}

export interface ConnectorParityClaimResult {
  claimed: boolean;
  expectedHeadRevision: number;
}

export interface ConnectorParityRetirementInput {
  tenantId: string;
  connectorId: string;
  revision: number;
  expectedCurrentRevision: number;
  idempotencyKey: string;
  reason: 'OPERATOR_RETIRE' | 'LEGACY_DISABLED_IMPORT' | 'PROFILE_UNBOUND';
}

export interface ConnectorParityRetirementResult {
  retired: boolean;
  currentRevision: number | null;
}

interface IntentRow {
  tenant_id: string;
  connector_id: string;
  idempotency_key: string;
  payload_hash: string;
  state: 'PENDING' | 'COMPLETED';
  operation: 'DRAFT' | 'ROLLBACK';
  revision: number;
  expected_head_revision: number;
  source_revision: number | null;
  recipe_envelope: unknown;
  credential_ref: string | null;
  credential_version: number | null;
  credential_source: unknown;
  credential_import_source: unknown;
  vault_expected_version: number | null;
  vault_target_version: number | null;
  vault_secret_sha256: string | null;
  backup_effect_id: string | null;
}

interface RevisionRow extends Omit<IntentRow, 'idempotency_key' | 'payload_hash' | 'operation' | 'expected_head_revision' | 'source_revision' | 'credential_import_source' | 'vault_expected_version' | 'vault_target_version' | 'vault_secret_sha256' | 'state'> {
  state: 'PENDING' | 'ACTIVE' | 'RETIRED';
  created_at: string | Date;
  updated_at: string | Date;
}

interface CatalogCursor {
  version: 1;
  tenantId: string;
  queryHash: string;
  limit: number;
  afterConnectorId: string;
  afterRevision: number;
  expiresAt: number;
}

const CATALOG_CURSOR_TTL_MS = 15 * 60_000;
const CATALOG_SCAN_BATCH = 500;
const CATALOG_MAX_SCAN = 5_000;

export interface ConnectorParityIntentResult {
  created: boolean;
  payloadHash: string;
  state: 'PENDING' | 'COMPLETED';
  revision: number;
  expectedHeadRevision: number;
  vaultExpectedVersion: number | null;
  vaultTargetVersion: number | null;
  vaultSecretSha256: string | null;
  credentialSource: VaultCredentialSource | null;
  credentialRef: string | null;
  credentialVersion: number | null;
  credentialImportSource: ConnectorParityCredentialImportSource | null;
  recipe: ConnectorRecipe;
  revisionResult?: ConnectorParityStoredRevision;
  /** Internal permit handle; management responses never serialize this field. */
  backupEffectId?: string | null;
}

/** Tenant-scoped immutable typed-recipe revisions and write-ahead idempotency. */
export class PostgresConnectorParityRepository {
  public constructor(
    private readonly db: SqlClient,
    private readonly crypto?: InvocationFieldCrypto,
    private readonly backupConfigWrites?: ConnectorBackupConfigWritePort,
  ) {}

  private requireCrypto(): InvocationFieldCrypto {
    if (!this.crypto) throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Connector recipe encryption is not configured.');
    return this.crypto;
  }

  private context(tenantId: string, connectorId: string, revision: number) {
    return {
      tenantId,
      slot: 'connector_parity_revisions.recipe' as const,
      refId: `${connectorId}:${revision}`,
    };
  }

  private async sealRecipe(tenantId: string, connectorId: string, revision: number, recipe: ConnectorRecipe): Promise<unknown> {
    const parsed = ConnectorRecipeSchema.safeParse(recipe);
    if (!parsed.success) throw new ConnectorError('INVALID_INPUT', 'Connector recipe is invalid.');
    try { return await this.requireCrypto().seal(parsed.data, this.context(tenantId, connectorId, revision)); }
    catch { throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Connector recipe encryption failed.'); }
  }

  private async openRecipe(row: Pick<RevisionRow, 'tenant_id' | 'connector_id' | 'revision' | 'recipe_envelope'>): Promise<ConnectorRecipe> {
    if (!isSealedInvocationField(row.recipe_envelope)) {
      throw new ConnectorError('CREDENTIAL_INVALID', 'Stored connector recipe is not protected.');
    }
    let value: unknown;
    try { value = await this.requireCrypto().open(row.recipe_envelope, this.context(row.tenant_id, row.connector_id, Number(row.revision))); }
    catch { throw new ConnectorError('CREDENTIAL_INVALID', 'Stored connector recipe could not be opened.'); }
    const parsed = ConnectorRecipeSchema.safeParse(value);
    if (!parsed.success) throw new ConnectorError('CREDENTIAL_INVALID', 'Stored connector recipe is invalid.');
    return parsed.data;
  }

  /** Reserve the globally unique connector handle for one tenant before a
   * resolved Catalog credential can be sent to the draft endpoint. The receipt
   * is checked before head CAS so an accepted retry remains valid after the
   * draft advances the chain. */
  public async claimRecipeDraft(input: ConnectorParityClaimInput): Promise<ConnectorParityClaimResult> {
    const payloadHash = claimPayloadHash(input);
    return this.db.transaction(async (tx) => {
      const backupFence = await lockConnectorBackupEffectGate(tx);
      assertConnectorBackupEffectGateOpen(backupFence);
      await lockConnectorChain(tx, input.connectorId);
      const owner = await tx.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM connector_parity_chains WHERE connector_id=$1 FOR UPDATE`,
        [input.connectorId],
      );
      if (owner.rows[0] && !sameTenant(owner.rows[0].tenant_id, input.tenantId)) {
        return { claimed: false, expectedHeadRevision: input.expectedHeadRevision };
      }

      const receipt = await tx.query<{ payload_hash: string }>(
        `SELECT payload_hash FROM connector_parity_claim_intents
         WHERE tenant_id=$1 AND connector_id=$2 AND idempotency_key=$3 FOR UPDATE`,
        [input.tenantId, input.connectorId, input.idempotencyKey],
      );
      if (receipt.rows[0]) {
        if (receipt.rows[0].payload_hash !== payloadHash) {
          throw new ConnectorError('INPUT_HASH_MISMATCH', 'Connector draft claim key was used for a different request.');
        }
        return { claimed: true, expectedHeadRevision: input.expectedHeadRevision };
      }

      const head = await tx.query<{ revision: number }>(
        `SELECT revision FROM connector_parity_revisions
         WHERE tenant_id=$1 AND connector_id=$2 ORDER BY revision DESC LIMIT 1`,
        [input.tenantId, input.connectorId],
      );
      const actualHead = Number(head.rows[0]?.revision ?? 0);
      if (actualHead !== input.expectedHeadRevision) {
        return { claimed: false, expectedHeadRevision: input.expectedHeadRevision };
      }
      const pending = await tx.query<{ idempotency_key: string }>(
        `SELECT idempotency_key FROM connector_parity_draft_intents
         WHERE tenant_id=$1 AND connector_id=$2 AND state='PENDING' LIMIT 1`,
        [input.tenantId, input.connectorId],
      );
      if (pending.rows[0]) return { claimed: false, expectedHeadRevision: input.expectedHeadRevision };

      if (!owner.rows[0]) {
        await tx.query(
          `INSERT INTO connector_parity_chains (connector_id,tenant_id) VALUES ($1,$2)
           ON CONFLICT (connector_id) DO NOTHING`,
          [input.connectorId, input.tenantId],
        );
        const insertedOwner = await tx.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM connector_parity_chains WHERE connector_id=$1 FOR UPDATE`,
          [input.connectorId],
        );
        if (!insertedOwner.rows[0] || !sameTenant(insertedOwner.rows[0].tenant_id, input.tenantId)) {
          return { claimed: false, expectedHeadRevision: input.expectedHeadRevision };
        }
      }
      await tx.query(
        `INSERT INTO connector_parity_claim_intents
          (tenant_id,connector_id,idempotency_key,payload_hash,expected_head_revision)
         VALUES ($1,$2,$3,$4,$5)`,
        [input.tenantId, input.connectorId, input.idempotencyKey, payloadHash, input.expectedHeadRevision],
      );
      return { claimed: true, expectedHeadRevision: input.expectedHeadRevision };
    });
  }

  /** Called before any mutable head or Vault metadata read in draft handling. */
  public async assertDraftClaim(input: ConnectorParityClaimInput): Promise<void> {
    const result = await this.db.query<{ payload_hash: string; tenant_id: string }>(
      `SELECT c.tenant_id, i.payload_hash
       FROM connector_parity_chains c
       JOIN connector_parity_claim_intents i
         ON i.connector_id=c.connector_id AND i.tenant_id=c.tenant_id
       WHERE c.connector_id=$1 AND c.tenant_id=$2 AND i.idempotency_key=$3`,
      [input.connectorId, input.tenantId, input.idempotencyKey],
    );
    const row = result.rows[0];
    if (!row) throw new ConnectorError('BINDING_DENIED', 'Connector draft claim is required.');
    if (row.payload_hash !== claimPayloadHash(input)) {
      throw new ConnectorError('INPUT_HASH_MISMATCH', 'Connector draft claim does not match this request.');
    }
  }

  /** Whether this connector has opted into the typed tenant-owned chain. */
  public async hasTypedChain(tenantId: string, connectorId: string): Promise<boolean> {
    const result = await this.db.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM connector_parity_chains WHERE connector_id=$1`,
      [connectorId],
    );
    if (!result.rows[0]) return false;
    if (!sameTenant(result.rows[0].tenant_id, tenantId)) throw new ConnectorError('BINDING_DENIED', 'Connector revision binding is invalid.');
    return true;
  }

  public async getIntent(tenantId: string, connectorId: string, idempotencyKey: string): Promise<ConnectorParityIntentResult | undefined> {
    const result = await this.db.query<IntentRow>(
      `SELECT * FROM connector_parity_draft_intents
       WHERE tenant_id=$1 AND connector_id=$2 AND idempotency_key=$3`,
      [tenantId, connectorId, idempotencyKey],
    );
    return result.rows[0] ? this.toIntentResult(this.db, result.rows[0], false) : undefined;
  }

  public async beginIntent(input: ConnectorParityIntentInput): Promise<ConnectorParityIntentResult> {
    if (!/^[a-f0-9]{64}$/.test(input.payloadHash)) throw new ConnectorError('INVALID_INPUT', 'Draft identity is invalid.');
    const parsedRecipe = ConnectorRecipeSchema.safeParse(input.recipe);
    if (!parsedRecipe.success) throw new ConnectorError('INVALID_INPUT', 'Connector recipe is invalid.');
    return this.db.transaction(async (tx) => {
      const backupFence = await lockConnectorBackupEffectGate(tx);
      assertConnectorBackupEffectGateOpen(backupFence);
      if (!this.backupConfigWrites) {
        throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Connector backup config-write fence is not configured.');
      }
      await lockConnectorChain(tx, input.connectorId);
      const owner = await tx.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM connector_parity_chains WHERE connector_id=$1 FOR UPDATE`,
        [input.connectorId],
      );
      if (!owner.rows[0] || !sameTenant(owner.rows[0].tenant_id, input.tenantId)) {
        throw new ConnectorError('BINDING_DENIED', 'Connector recipe chain is not owned by this tenant.');
      }
      if (input.operation === 'DRAFT') {
        const claim = await tx.query<{ payload_hash: string }>(
          `SELECT payload_hash FROM connector_parity_claim_intents
           WHERE tenant_id=$1 AND connector_id=$2 AND idempotency_key=$3 FOR UPDATE`,
          [input.tenantId, input.connectorId, input.idempotencyKey],
        );
        if (!claim.rows[0] || claim.rows[0].payload_hash !== claimPayloadHash({
          tenantId: input.tenantId,
          connectorId: input.connectorId,
          expectedHeadRevision: input.expectedHeadRevision,
        })) {
          throw new ConnectorError('BINDING_DENIED', 'Connector draft claim is required.');
        }
      }
      const prior = await tx.query<IntentRow>(
        `SELECT * FROM connector_parity_draft_intents
         WHERE tenant_id=$1 AND connector_id=$2 AND idempotency_key=$3 FOR UPDATE`,
        [input.tenantId, input.connectorId, input.idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].payload_hash !== input.payloadHash) {
          throw new ConnectorError('INPUT_HASH_MISMATCH', 'Idempotency key was used for a different connector draft.');
        }
        return this.toIntentResult(tx, prior.rows[0], false);
      }
      const pending = await tx.query<{ idempotency_key: string }>(
        `SELECT idempotency_key FROM connector_parity_draft_intents
         WHERE tenant_id=$1 AND connector_id=$2 AND state='PENDING' LIMIT 1 FOR UPDATE`,
        [input.tenantId, input.connectorId],
      );
      if (pending.rows[0]) {
        throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Another Connector draft requires write reconciliation.', { safeToRetry: true });
      }
      const head = await tx.query<{ revision: number }>(
        `SELECT revision FROM connector_parity_revisions
         WHERE tenant_id=$1 AND connector_id=$2 ORDER BY revision DESC LIMIT 1`,
        [input.tenantId, input.connectorId],
      );
      const actualHead = Number(head.rows[0]?.revision ?? 0);
      if (actualHead !== input.expectedHeadRevision) {
        throw new ConnectorError('BINDING_DENIED', 'Connector recipe head changed.');
      }
      const revision = actualHead + 1;
      // Reseal under the actual revision AAD, not the placeholder used above.
      const sealed = await this.sealRecipe(input.tenantId, input.connectorId, revision, parsedRecipe.data);
      const backupEffectId = randomUUID();
      await this.backupConfigWrites.prepare(tx, {
        effectId: backupEffectId,
        tenantId: input.tenantId,
        connectorId: input.connectorId,
        idempotencyKey: input.idempotencyKey,
      });
      const inserted = await tx.query<IntentRow>(
        `INSERT INTO connector_parity_draft_intents
          (tenant_id,connector_id,idempotency_key,payload_hash,state,operation,revision,expected_head_revision,
           source_revision,recipe_envelope,credential_ref,credential_version,credential_source,
           credential_import_source,vault_expected_version,vault_target_version,vault_secret_sha256,backup_effect_id)
         VALUES ($1,$2,$3,$4,'PENDING',$5,$6,$7,$8,$9::jsonb,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17)
         RETURNING *`,
        [
          input.tenantId, input.connectorId, input.idempotencyKey, input.payloadHash, input.operation,
          revision, input.expectedHeadRevision, input.sourceRevision ?? null, JSON.stringify(sealed),
          input.credentialRef, input.credentialVersion,
          input.credentialSource === null ? null : JSON.stringify(input.credentialSource),
          input.credentialImportSource === null ? null : JSON.stringify(input.credentialImportSource),
          input.vaultExpectedVersion, input.vaultTargetVersion, input.vaultSecretSha256, backupEffectId,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Connector draft intent could not be stored.');
      return this.toIntentResult(tx, row, true);
    });
  }

  public async finalizeIntent(tenantId: string, connectorId: string, idempotencyKey: string): Promise<ConnectorParityIntentResult> {
    return this.db.transaction(async (tx) => {
      await lockConnectorBackupEffectGate(tx);
      await lockConnectorChain(tx, connectorId);
      const intentResult = await tx.query<IntentRow>(
        `SELECT * FROM connector_parity_draft_intents
         WHERE tenant_id=$1 AND connector_id=$2 AND idempotency_key=$3 FOR UPDATE`,
        [tenantId, connectorId, idempotencyKey],
      );
      const intent = intentResult.rows[0];
      if (!intent) throw new ConnectorError('INVALID_INPUT', 'Connector draft intent was not found.');
      if (intent.state === 'COMPLETED') return this.toIntentResult(tx, intent, false);
      if (!intent.backup_effect_id || !this.backupConfigWrites) {
        throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Connector backup config-write permit is unavailable.');
      }
      const owner = await tx.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM connector_parity_chains WHERE connector_id=$1 FOR UPDATE`,
        [connectorId],
      );
      if (!owner.rows[0] || !sameTenant(owner.rows[0].tenant_id, tenantId)) {
        throw new ConnectorError('BINDING_DENIED', 'Connector recipe chain is not owned by this tenant.');
      }
      if (intent.vault_target_version !== null && Number(intent.credential_version) !== Number(intent.vault_target_version)) {
        throw new ConnectorError('CREDENTIAL_INVALID', 'Connector draft credential version does not match its write plan.');
      }
      const source = intent.credential_source === null ? null : intent.credential_source as VaultCredentialSource;
      const inserted = await tx.query<RevisionRow>(
        `INSERT INTO connector_parity_revisions
          (tenant_id,connector_id,revision,state,recipe_envelope,credential_ref,credential_version,credential_source)
         VALUES ($1,$2,$3,'PENDING',$4::jsonb,$5,$6,$7::jsonb)
         ON CONFLICT (tenant_id,connector_id,revision) DO NOTHING
         RETURNING *`,
        [tenantId, connectorId, intent.revision, JSON.stringify(intent.recipe_envelope), intent.credential_ref,
          intent.credential_version, source === null ? null : JSON.stringify(source)],
      );
      if (!inserted.rows[0]) {
        const existing = await tx.query<RevisionRow>(
          `SELECT * FROM connector_parity_revisions WHERE tenant_id=$1 AND connector_id=$2 AND revision=$3 FOR UPDATE`,
          [tenantId, connectorId, intent.revision],
        );
        if (!existing.rows[0] || existing.rows[0].credential_ref !== intent.credential_ref
          || existing.rows[0].credential_version !== intent.credential_version) {
          throw new ConnectorError('BINDING_DENIED', 'Connector draft revision conflicts with an existing row.');
        }
      }
      await tx.query(
        `UPDATE connector_parity_draft_intents SET state='COMPLETED',updated_at=now()
         WHERE tenant_id=$1 AND connector_id=$2 AND idempotency_key=$3 AND state='PENDING'`,
        [tenantId, connectorId, idempotencyKey],
      );
      await this.backupConfigWrites.complete(tx, intent.backup_effect_id);
      const finalized = await tx.query<IntentRow>(
        `SELECT * FROM connector_parity_draft_intents
         WHERE tenant_id=$1 AND connector_id=$2 AND idempotency_key=$3`,
        [tenantId, connectorId, idempotencyKey],
      );
      if (!finalized.rows[0]) throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Connector draft completion could not be persisted.');
      return this.toIntentResult(tx, finalized.rows[0], false);
    });
  }

  public async activateConfigWrite(effectId: string | null | undefined): Promise<boolean> {
    if (!effectId || !this.backupConfigWrites) {
      throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Connector backup config-write fence is not configured.');
    }
    return this.backupConfigWrites.activate(effectId);
  }

  public async markConfigWriteUnknown(effectId: string | null | undefined, reasonCode: string): Promise<void> {
    if (!effectId || !this.backupConfigWrites) {
      throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Connector backup config-write fence is not configured.');
    }
    await this.backupConfigWrites.markUnknown(effectId, reasonCode);
  }

  public async getRevision(tenantId: string, connectorId: string, revision: number): Promise<ConnectorParityStoredRevision | undefined> {
    return this.readRevision(this.db, tenantId, connectorId, revision);
  }

  private async readRevision(client: SqlClient, tenantId: string, connectorId: string, revision: number): Promise<ConnectorParityStoredRevision | undefined> {
    const result = await client.query<RevisionRow>(
      `SELECT * FROM connector_parity_revisions WHERE tenant_id=$1 AND connector_id=$2 AND revision=$3`,
      [tenantId, connectorId, revision],
    );
    return result.rows[0] ? this.toRevision(result.rows[0]) : undefined;
  }

  public async getHead(tenantId: string, connectorId: string): Promise<number> {
    const result = await this.db.query<{ revision: number }>(
      `SELECT revision FROM connector_parity_revisions WHERE tenant_id=$1 AND connector_id=$2 ORDER BY revision DESC LIMIT 1`,
      [tenantId, connectorId],
    );
    return Number(result.rows[0]?.revision ?? 0);
  }

  public async getActiveRevision(tenantId: string, connectorId: string): Promise<ConnectorParityStoredRevision | undefined> {
    const result = await this.db.query<RevisionRow>(
      `SELECT * FROM connector_parity_revisions WHERE tenant_id=$1 AND connector_id=$2 AND state='ACTIVE'`,
      [tenantId, connectorId],
    );
    return result.rows[0] ? this.toRevision(result.rows[0]) : undefined;
  }

  /** List only tenant-owned ACTIVE typed recipes. Cursors are HMAC-bound to
   * tenant, normalized query and page size; every recipe is opened from its
   * immutable envelope and projected to safe metadata. */
  public async listActiveRevisions(query: TenantActiveConnectorCatalogQuery): Promise<TenantActiveConnectorCatalogPage> {
    const normalizedQuery = query.q?.trim().toLocaleLowerCase('en-US') ?? '';
    const queryHash = createHash('sha256').update(normalizedQuery).digest('hex');
    const key = await this.catalogCursorKey();
    try {
      let after: Pick<CatalogCursor, 'afterConnectorId' | 'afterRevision'> | null = query.cursor
        ? parseCatalogCursor(query.cursor, key, query.tenantId, queryHash, query.limit)
        : null;
      const items: TenantActiveConnectorCatalogPage['items'] = [];
      let scanned = 0;
      let hasUnscanned = false;

      while (scanned < CATALOG_MAX_SCAN && items.length < query.limit) {
        const result = await this.db.query<RevisionRow>(
          `SELECT * FROM connector_parity_revisions
            WHERE tenant_id=$1 AND state='ACTIVE'
              AND ($2::text IS NULL OR (connector_id,revision)>($2::text,$3::integer))
            ORDER BY connector_id,revision LIMIT $4`,
          [query.tenantId, after?.afterConnectorId ?? null, after?.afterRevision ?? null,
            Math.min(CATALOG_SCAN_BATCH, CATALOG_MAX_SCAN - scanned)],
        );
        if (result.rows.length === 0) break;
        for (let index = 0; index < result.rows.length; index += 1) {
          const row = result.rows[index]!;
          const recipe = await this.openRecipe(row);
          const model = modelFromRecipe(recipe);
          const item = TenantActiveConnectorCatalogItemSchema.parse({
            tenantId: row.tenant_id,
            connectorId: row.connector_id,
            revision: Number(row.revision),
            adapter: recipe.adapter,
            provider: providerForAdapter(recipe.adapter),
            model,
            credentialConfigured: row.credential_ref !== null,
            updatedAt: isoString(row.updated_at),
          });
          after = { afterConnectorId: row.connector_id, afterRevision: Number(row.revision) };
          scanned += 1;
          if (!normalizedQuery || [item.connectorId, item.adapter, item.provider, item.model ?? '']
            .some((value) => value.toLocaleLowerCase('en-US').includes(normalizedQuery))) {
            items.push(item);
            if (items.length === query.limit) {
              hasUnscanned = index < result.rows.length - 1 || result.rows.length === CATALOG_SCAN_BATCH;
              break;
            }
          }
          if (scanned >= CATALOG_MAX_SCAN) {
            hasUnscanned = result.rows.length === CATALOG_SCAN_BATCH;
            break;
          }
        }
        if (items.length === query.limit || scanned >= CATALOG_MAX_SCAN) break;
        if (result.rows.length < CATALOG_SCAN_BATCH) break;
      }

      const nextCursor = hasUnscanned && after
        ? createCatalogCursor({
          version: 1,
          tenantId: query.tenantId,
          queryHash,
          limit: query.limit,
          afterConnectorId: after.afterConnectorId,
          afterRevision: after.afterRevision,
          expiresAt: Date.now() + CATALOG_CURSOR_TTL_MS,
        }, key)
        : null;
      return TenantActiveConnectorCatalogPageSchema.parse({ tenantId: query.tenantId, items, limit: query.limit, nextCursor });
    } finally {
      key.fill(0);
    }
  }

  private async catalogCursorKey(): Promise<Buffer> {
    const existing = await this.db.query<{ key_bytes: Buffer }>(
      `SELECT key_bytes FROM connector_tenant_catalog_cursor_key WHERE singleton_id=1`,
    );
    if (existing.rows[0]) return Buffer.from(existing.rows[0].key_bytes);
    return this.db.transaction(async (tx) => {
      const gate = await lockConnectorBackupEffectGate(tx);
      assertConnectorBackupEffectGateOpen(gate);
      await tx.query(
        `INSERT INTO connector_tenant_catalog_cursor_key(singleton_id,key_bytes)
          VALUES(1,$1) ON CONFLICT(singleton_id) DO NOTHING`, [randomBytes(32)],
      );
      const created = await tx.query<{ key_bytes: Buffer }>(
        `SELECT key_bytes FROM connector_tenant_catalog_cursor_key WHERE singleton_id=1`,
      );
      if (!created.rows[0] || !Buffer.isBuffer(created.rows[0].key_bytes) || created.rows[0].key_bytes.byteLength !== 32) {
        throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Connector catalog cursor signing key is unavailable.');
      }
      return Buffer.from(created.rows[0].key_bytes);
    });
  }

  public async activate(tenantId: string, connectorId: string, revision: number, expectedCurrentRevision: number): Promise<{ activated: boolean; currentRevision: number | null }> {
    return this.db.transaction(async (tx) => {
      const backupFence = await lockConnectorBackupEffectGate(tx);
      if (backupFence.state !== 'OPEN') throw new ConnectorError('CONNECTOR_DISABLED', 'Connector configuration writes are held for a maintenance backup.');
      await lockConnectorChain(tx, connectorId);
      const owner = await tx.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM connector_parity_chains WHERE connector_id=$1 FOR UPDATE`,
        [connectorId],
      );
      if (owner.rows[0]?.tenant_id !== tenantId) return { activated: false, currentRevision: null };
      const current = await tx.query<{ revision: number }>(
        `SELECT revision FROM connector_parity_revisions WHERE tenant_id=$1 AND connector_id=$2 AND state='ACTIVE' FOR UPDATE`,
        [tenantId, connectorId],
      );
      const currentRevision = current.rows[0] ? Number(current.rows[0].revision) : null;
      if ((currentRevision ?? 0) !== expectedCurrentRevision) return { activated: false, currentRevision };
      const target = await tx.query<{ state: string }>(
        `SELECT state FROM connector_parity_revisions WHERE tenant_id=$1 AND connector_id=$2 AND revision=$3 FOR UPDATE`,
        [tenantId, connectorId, revision],
      );
      if (target.rows[0]?.state !== 'PENDING') return { activated: false, currentRevision };
      if (currentRevision !== null) {
        await tx.query(
          `UPDATE connector_parity_revisions SET state='RETIRED',updated_at=now()
           WHERE tenant_id=$1 AND connector_id=$2 AND revision=$3 AND state='ACTIVE'`,
          [tenantId, connectorId, currentRevision],
        );
      }
      await tx.query(
        `UPDATE connector_parity_revisions SET state='ACTIVE',updated_at=now()
         WHERE tenant_id=$1 AND connector_id=$2 AND revision=$3 AND state='PENDING'`,
        [tenantId, connectorId, revision],
      );
      return { activated: true, currentRevision: revision };
    });
  }

  /** CAS retire a typed PENDING or ACTIVE revision while retaining every
   * immutable recipe and credential pin. Exact replay returns the durable
   * original acknowledgement before reading mutable current state. */
  public async retireRevision(input: ConnectorParityRetirementInput): Promise<ConnectorParityRetirementResult> {
    const payloadHash = createHash('sha256').update(canonicalize({
      tenantId: input.tenantId,
      connectorId: input.connectorId,
      revision: input.revision,
      expectedCurrentRevision: input.expectedCurrentRevision,
      reason: input.reason,
    })).digest('hex');
    return this.db.transaction(async (tx) => {
      const backupFence = await lockConnectorBackupEffectGate(tx);
      if (backupFence.state !== 'OPEN') {
        // A previously committed idempotency receipt is an immutable read
        // replay and remains safe during a held snapshot. New retirement
        // intents and any state change are refused.
        const prior = await tx.query<{payload_hash:string;retired:boolean;current_revision:number|null}>(
          `SELECT payload_hash,retired,current_revision FROM connector_parity_retire_intents
            WHERE tenant_id=$1 AND connector_id=$2 AND idempotency_key=$3`,
          [input.tenantId,input.connectorId,input.idempotencyKey],
        );
        if (prior.rows[0]) {
          if (prior.rows[0].payload_hash !== payloadHash) throw new ConnectorError('INPUT_HASH_MISMATCH', 'Connector retirement key was used for a different request.');
          return { retired: prior.rows[0].retired, currentRevision: prior.rows[0].current_revision === null ? null : Number(prior.rows[0].current_revision) };
        }
        throw new ConnectorError('CONNECTOR_DISABLED', 'Connector configuration writes are held for a maintenance backup.');
      }
      await lockConnectorChain(tx, input.connectorId);
      const owner = await tx.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM connector_parity_chains WHERE connector_id=$1 FOR UPDATE`,
        [input.connectorId],
      );
      if (!owner.rows[0] || !sameTenant(owner.rows[0].tenant_id, input.tenantId)) {
        return { retired: false, currentRevision: null };
      }

      const receipt = await tx.query<{
        payload_hash: string;
        retired: boolean;
        current_revision: number | null;
      }>(
        `SELECT payload_hash,retired,current_revision FROM connector_parity_retire_intents
         WHERE tenant_id=$1 AND connector_id=$2 AND idempotency_key=$3 FOR UPDATE`,
        [input.tenantId, input.connectorId, input.idempotencyKey],
      );
      if (receipt.rows[0]) {
        if (receipt.rows[0].payload_hash !== payloadHash) {
          throw new ConnectorError('INPUT_HASH_MISMATCH', 'Connector retirement key was used for a different request.');
        }
        return {
          retired: receipt.rows[0].retired,
          currentRevision: receipt.rows[0].current_revision === null ? null : Number(receipt.rows[0].current_revision),
        };
      }

      const pendingIntent = await tx.query<{ idempotency_key: string }>(
        `SELECT idempotency_key FROM connector_parity_draft_intents
         WHERE tenant_id=$1 AND connector_id=$2 AND state='PENDING' LIMIT 1`,
        [input.tenantId, input.connectorId],
      );
      const current = await tx.query<{ revision: number }>(
        `SELECT revision FROM connector_parity_revisions
         WHERE tenant_id=$1 AND connector_id=$2 AND state='ACTIVE' FOR UPDATE`,
        [input.tenantId, input.connectorId],
      );
      const activeRevision = current.rows[0] ? Number(current.rows[0].revision) : null;
      const currentMatches = (activeRevision ?? 0) === input.expectedCurrentRevision;
      const target = pendingIntent.rows.length === 0 && currentMatches
        ? await tx.query<{ state: 'PENDING' | 'ACTIVE' | 'RETIRED' }>(
          `SELECT state FROM connector_parity_revisions
           WHERE tenant_id=$1 AND connector_id=$2 AND revision=$3 FOR UPDATE`,
          [input.tenantId, input.connectorId, input.revision],
        )
        : { rows: [] as Array<{ state: 'PENDING' | 'ACTIVE' | 'RETIRED' }> };
      const targetState = target.rows[0]?.state;
      const canRetire = targetState === 'PENDING'
        || (targetState === 'ACTIVE' && activeRevision === input.revision);
      const retired = pendingIntent.rows.length === 0 && currentMatches && canRetire;
      let currentRevision = activeRevision;
      if (retired) {
        await tx.query(
          `UPDATE connector_parity_revisions SET state='RETIRED',updated_at=now()
           WHERE tenant_id=$1 AND connector_id=$2 AND revision=$3 AND state=$4`,
          [input.tenantId, input.connectorId, input.revision, targetState],
        );
        if (targetState === 'ACTIVE') currentRevision = null;
      }
      await tx.query(
        `INSERT INTO connector_parity_retire_intents
          (tenant_id,connector_id,revision,idempotency_key,payload_hash,reason,retired,current_revision)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [input.tenantId, input.connectorId, input.revision, input.idempotencyKey, payloadHash,
          input.reason, retired, currentRevision],
      );
      return { retired, currentRevision };
    });
  }

  private async toIntentResult(client: SqlClient, row: IntentRow, created: boolean): Promise<ConnectorParityIntentResult> {
    let recipe: ConnectorRecipe;
    try {
      if (!isSealedInvocationField(row.recipe_envelope)) throw new Error('not sealed');
      const opened = await this.requireCrypto().open(row.recipe_envelope, this.context(row.tenant_id, row.connector_id, Number(row.revision)));
      recipe = ConnectorRecipeSchema.parse(opened);
    } catch {
      throw new ConnectorError('CREDENTIAL_INVALID', 'Connector draft recipe could not be opened.');
    }
    const source = row.credential_source === null ? null : row.credential_source as VaultCredentialSource;
    const base = {
      created,
      payloadHash: row.payload_hash,
      state: row.state,
      revision: Number(row.revision),
      expectedHeadRevision: Number(row.expected_head_revision),
      vaultExpectedVersion: row.vault_expected_version === null ? null : Number(row.vault_expected_version),
      vaultTargetVersion: row.vault_target_version === null ? null : Number(row.vault_target_version),
      vaultSecretSha256: row.vault_secret_sha256,
      credentialSource: source,
      credentialRef: row.credential_ref,
      credentialVersion: row.credential_version === null ? null : Number(row.credential_version),
      credentialImportSource: row.credential_import_source === null ? null : row.credential_import_source as ConnectorParityCredentialImportSource,
      recipe,
      backupEffectId: row.backup_effect_id,
    };
    if (row.state === 'COMPLETED') {
      // Transaction callers must read the materialized revision through the
      // same connection. A pool-level read here can race the commit (or read
      // from a different snapshot) and falsely report a completed intent with
      // no revision row.
      const revision = await this.readRevision(client, row.tenant_id, row.connector_id, Number(row.revision));
      if (!revision) throw new ConnectorError('CREDENTIAL_INVALID', 'Completed Connector draft has no revision row.');
      return { ...base, revisionResult: revision };
    }
    return base;
  }

  private async toRevision(row: RevisionRow): Promise<ConnectorParityStoredRevision> {
    const expectedHeadRevision = Number(row.revision) - 1;
    let credentialSource: VaultCredentialSource | null = null;
    if (row.credential_source !== null) {
      const parsedSource = ConnectorCredentialSourceSchema.safeParse(row.credential_source);
      if (!parsedSource.success || parsedSource.data.kind !== 'vault-kv2'
        || parsedSource.data.version !== Number(row.credential_version)
        || parsedSource.data.account !== 'recipe'
        || !matchesVaultRevisionBinding(parsedSource.data, {
          tenantId: row.tenant_id,
          connectorId: row.connector_id,
          accountId: 'recipe',
        })) {
        throw new ConnectorError('CREDENTIAL_INVALID', 'Stored Connector recipe credential binding is invalid.');
      }
      credentialSource = parsedSource.data;
    }
    if ((row.credential_ref === null) !== (credentialSource === null)
      || (row.credential_version === null) !== (credentialSource === null)) {
      throw new ConnectorError('CREDENTIAL_INVALID', 'Stored Connector recipe credential pin is incomplete.');
    }
    const result = ConnectorParityRevisionSchema.parse({
      tenantId: row.tenant_id,
      connectorId: row.connector_id,
      revision: Number(row.revision),
      state: row.state,
      recipe: await this.openRecipe(row),
      credentialRef: row.credential_ref,
      credentialVersion: row.credential_version === null ? null : Number(row.credential_version),
      expectedHeadRevision,
    });
    return { ...result, credentialSource };
  }
}

function claimPayloadHash(input: Pick<ConnectorParityClaimInput, 'tenantId' | 'connectorId' | 'expectedHeadRevision'>): string {
  return createHash('sha256').update(canonicalize({
    tenantId: input.tenantId,
    connectorId: input.connectorId,
    expectedHeadRevision: input.expectedHeadRevision,
  })).digest('hex');
}

async function lockConnectorChain(client: SqlClient, connectorId: string): Promise<void> {
  // The key deliberately excludes tenantId: one connector handle cannot be
  // claimed concurrently by two tenants during first creation.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`connector-parity-owner:${connectorId}`]);
}

function sameTenant(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function modelFromRecipe(recipe: ConnectorRecipe): string | null {
  const fieldName = recipe.request.modelField;
  if (!fieldName) return null;
  const field = recipe.request.fields.find((candidate) => candidate.name === fieldName && candidate.source === 'static');
  return typeof field?.value === 'string' && field.value.trim().length > 0 ? field.value.trim() : null;
}

function providerForAdapter(adapter: ConnectorRecipe['adapter']): string {
  if (adapter === 'json-http' || adapter === 'multipart-http') return 'custom';
  return adapter;
}

function isoString(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Connector catalog timestamp is invalid.');
  return parsed.toISOString();
}

function createCatalogCursor(cursor: CatalogCursor, key: Buffer): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  const signature = createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function parseCatalogCursor(
  token: string,
  key: Buffer,
  tenantId: string,
  queryHash: string,
  limit: number,
): Pick<CatalogCursor, 'afterConnectorId' | 'afterRevision'> {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new ConnectorError('INVALID_INPUT', 'Connector catalog cursor is invalid.');
  const expected = createHmac('sha256', key).update(parts[0]).digest();
  let actual: Buffer;
  try { actual = Buffer.from(parts[1], 'base64url'); }
  catch { throw new ConnectorError('INVALID_INPUT', 'Connector catalog cursor is invalid.'); }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)
    || actual.toString('base64url') !== parts[1]) {
    throw new ConnectorError('INVALID_INPUT', 'Connector catalog cursor is invalid.');
  }
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as unknown; }
  catch { throw new ConnectorError('INVALID_INPUT', 'Connector catalog cursor is invalid.'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConnectorError('INVALID_INPUT', 'Connector catalog cursor is invalid.');
  const value = raw as Partial<CatalogCursor>;
  if (value.version !== 1 || value.tenantId !== tenantId || value.queryHash !== queryHash || value.limit !== limit
    || typeof value.afterConnectorId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.afterConnectorId)
    || !Number.isSafeInteger(value.afterRevision) || Number(value.afterRevision) < 1
    || !Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= Date.now()
    || Number(value.expiresAt) > Date.now() + CATALOG_CURSOR_TTL_MS + 60_000) {
    throw new ConnectorError('INVALID_INPUT', 'Connector catalog cursor is expired or bound to a different query.');
  }
  return { afterConnectorId: value.afterConnectorId, afterRevision: Number(value.afterRevision) };
}
