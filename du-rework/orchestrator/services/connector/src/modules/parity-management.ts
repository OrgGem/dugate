import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalize,
  isTenantUuid,
  ConnectorRecipeSchema,
  ConnectorParityRevisionSchema,
  TenantActiveConnectorCatalogQuerySchema,
  TenantConnectorRecipeCatalogQuerySchema,
  type TenantActiveConnectorCatalogPage,
  type TenantActiveConnectorCatalogQuery,
  type TenantConnectorRecipeCatalogPage,
  type TenantConnectorRecipeCatalogQuery,
  type ConnectorParityDraftResult,
  type ConnectorParityRevision,
  type ConnectorRecipe,
  type EncryptedDbCredentialSource,
  type VaultCredentialSource,
} from '@du/contracts';
import { ConnectorError } from '../errors';
import type {
  ConnectorParityClaimInput,
  ConnectorParityClaimResult,
  ConnectorParityCredentialImportSource,
  ConnectorParityCredentialCopyFrom,
  ConnectorParityIntentInput,
  ConnectorParityIntentResult,
  ConnectorParityRetirementInput,
  ConnectorParityRetirementResult,
  ConnectorParityStoredRevision,
  PostgresConnectorParityRepository,
} from '../db/parity-repository';
import type { PostgresTypedCredentialStore } from '../db/credential-store';
import type { VaultKv2SecretWriter, VaultKv2SecretWritePlan } from '../vault/writer';

const CONNECTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CATALOG_VERSION_REF = /^[0-9a-f-]{36}@[1-9][0-9]{0,8}$/i;
const CATALOG_KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VAULT_ACCOUNT = 'recipe';

export type ConnectorInternalCredentialChange =
  | { action: 'keep' }
  | { action: 'replace'; secret: string }
  | { action: 'clear'; confirm: true }
  | { action: 'vault-ref'; reference: string };

export interface ConnectorInternalDraftUpsert {
  tenantId: string;
  connectorId: string;
  expectedHeadRevision: number;
  recipe: ConnectorRecipe;
  credentialChange: ConnectorInternalCredentialChange;
  credentialImportSource?: ConnectorParityCredentialImportSource;
  idempotencyKey: string;
}

export interface ConnectorInternalRollbackDraft {
  tenantId: string;
  connectorId: string;
  sourceRevision: number;
  expectedHeadRevision: number;
  idempotencyKey: string;
}

export interface ConnectorParityManagementPort {
  listActiveConnectorRevisions(query: TenantActiveConnectorCatalogQuery): Promise<TenantActiveConnectorCatalogPage>;
  listConnectorRecipeCatalog(query: TenantConnectorRecipeCatalogQuery): Promise<TenantConnectorRecipeCatalogPage>;
  hasTypedChain(tenantId: string, connectorId: string): Promise<boolean>;
  claimRecipeDraft(input: ConnectorParityClaimInput): Promise<ConnectorParityClaimResult>;
  getRevision(tenantId: string, connectorId: string, revision: number): Promise<ConnectorParityRevision | undefined>;
  upsertDraft(input: ConnectorInternalDraftUpsert): Promise<ConnectorParityDraftResult>;
  activateRevision(tenantId: string, connectorId: string, revision: number, expectedCurrentRevision: number): Promise<{ activated: boolean; currentRevision: number | null }>;
  retireRevision(input: ConnectorParityRetirementInput): Promise<ConnectorParityRetirementResult>;
  createRollbackDraft(input: ConnectorInternalRollbackDraft): Promise<ConnectorParityDraftResult>;
  getRuntimeRevision(tenantId: string, connectorId: string, revision: number): Promise<ConnectorParityStoredRevision | undefined>;
  getCurrentRuntimeRevision(tenantId: string, connectorId: string): Promise<ConnectorParityStoredRevision | undefined>;
}

export interface ConnectorParityManagementOptions {
  repository: PostgresConnectorParityRepository;
  secretWriter?: VaultKv2SecretWriter;
  /** True only when the bound encrypted-DB writer is composed with the repository. */
  typedCredentialStorage?: boolean;
  /** Used only to migrate existing encrypted-db credentials into configured Vault. */
  typedCredentialStore?: PostgresTypedCredentialStore;
  vaultMount?: string;
}

export function createConnectorParityManagement(options: ConnectorParityManagementOptions): ConnectorParityManagementPort {
  const mount = options.vaultMount ?? 'secret';
  const repository = options.repository;

  return {
    async listActiveConnectorRevisions(query) {
      const parsed = TenantActiveConnectorCatalogQuerySchema.safeParse(query);
      if (!parsed.success) throw new ConnectorError('INVALID_INPUT', 'Tenant Connector catalog query is invalid.');
      return repository.listActiveRevisions(parsed.data);
    },

    async listConnectorRecipeCatalog(query) {
      const parsed = TenantConnectorRecipeCatalogQuerySchema.safeParse(query);
      if (!parsed.success) throw new ConnectorError('INVALID_INPUT', 'Tenant typed Connector catalog query is invalid.');
      return repository.listRecipeCatalog(parsed.data);
    },

    async hasTypedChain(tenantId, connectorId) {
      validateScope(tenantId, connectorId);
      return repository.hasTypedChain(tenantId, connectorId);
    },

    async claimRecipeDraft(input) {
      validateScope(input.tenantId, input.connectorId);
      if (!Number.isSafeInteger(input.expectedHeadRevision) || input.expectedHeadRevision < 0
        || typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) {
        throw new ConnectorError('INVALID_INPUT', 'Connector draft claim is invalid.');
      }
      return repository.claimRecipeDraft(input);
    },

    async getRevision(tenantId, connectorId, revision) {
      validateScope(tenantId, connectorId);
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new ConnectorError('INVALID_INPUT', 'Connector recipe revision is invalid.');
      }
      const stored = await repository.getRevision(tenantId, connectorId, revision);
      return stored ? publicRevision(stored) : undefined;
    },

    async getRuntimeRevision(tenantId, connectorId, revision) {
      return repository.getRevision(tenantId, connectorId, revision);
    },

    async getCurrentRuntimeRevision(tenantId, connectorId) {
      return repository.getActiveRevision(tenantId, connectorId);
    },

    async activateRevision(tenantId, connectorId, revision, expectedCurrentRevision) {
      if (!Number.isSafeInteger(expectedCurrentRevision) || expectedCurrentRevision < 0) {
        throw new ConnectorError('INVALID_INPUT', 'Expected current Connector recipe revision is invalid.');
      }
      return repository.activate(tenantId, connectorId, revision, expectedCurrentRevision);
    },

    async retireRevision(input) {
      validateScope(input.tenantId, input.connectorId);
      if (!Number.isSafeInteger(input.revision) || input.revision < 1
        || !Number.isSafeInteger(input.expectedCurrentRevision) || input.expectedCurrentRevision < 0
        || typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200
        || !['OPERATOR_RETIRE', 'LEGACY_DISABLED_IMPORT', 'PROFILE_UNBOUND'].includes(input.reason)) {
        throw new ConnectorError('INVALID_INPUT', 'Connector recipe retirement request is invalid.');
      }
      return repository.retireRevision(input);
    },

    async upsertDraft(input) {
      validateScope(input.tenantId, input.connectorId);
      if (!Number.isSafeInteger(input.expectedHeadRevision) || input.expectedHeadRevision < 0
        || typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) {
        throw new ConnectorError('INVALID_INPUT', 'Connector recipe draft request is invalid.');
      }
      // This check is intentionally before idempotency/head reads and before
      // any KV2 metadata or secret write. Backend must preflight the chain
      // before resolving Catalog values; this independently enforces it.
      await repository.assertDraftClaim({
        tenantId: input.tenantId,
        connectorId: input.connectorId,
        expectedHeadRevision: input.expectedHeadRevision,
        idempotencyKey: input.idempotencyKey,
      });
      const parsedRecipe = ConnectorRecipeSchema.safeParse(input.recipe);
      if (!parsedRecipe.success) throw new ConnectorError('INVALID_INPUT', 'Connector recipe is invalid.');
      if (input.credentialChange.action === 'vault-ref') {
        throw new ConnectorError('INVALID_INPUT', 'Catalog references must be resolved by the Orchestrator before Connector import.');
      }
      const source = validateImportSource(input.credentialImportSource, input.credentialChange);
      const secretHash = input.credentialChange.action === 'replace'
        ? sha256(input.credentialChange.secret)
        : null;
      const payloadHash = sha256(canonicalize({
        tenantId: input.tenantId,
        connectorId: input.connectorId,
        expectedHeadRevision: input.expectedHeadRevision,
        recipe: parsedRecipe.data,
        credentialChange: input.credentialChange.action === 'replace'
          ? { action: 'replace', secretSha256: secretHash }
          : input.credentialChange,
        credentialImportSource: source,
      }));

      // Exact replay lookup is deliberately before any head or Vault metadata
      // read. A pending write only reconciles its already-planned exact KV2
      // version and cannot allocate a new revision or a second Vault version.
      let intent = await repository.getIntent(input.tenantId, input.connectorId, input.idempotencyKey);
      let replayed = Boolean(intent);
      let plannedVaultSecret: string | undefined;
      if (intent) assertSamePayload(intent, payloadHash);

      if (!intent) {
        const head = await repository.getHead(input.tenantId, input.connectorId);
        if (head !== input.expectedHeadRevision) throw new ConnectorError('BINDING_DENIED', 'Connector recipe head changed.');
        const headRevision = input.expectedHeadRevision > 0
          ? await repository.getRevision(input.tenantId, input.connectorId, input.expectedHeadRevision)
          : undefined;
        const credential = await resolveCredentialPlan({
          change: input.credentialChange,
          recipe: parsedRecipe.data,
          current: headRevision,
          tenantId: input.tenantId,
          connectorId: input.connectorId,
          mount,
          writer: options.secretWriter,
          typedCredentialStorage: options.typedCredentialStorage === true,
          typedCredentialStore: options.typedCredentialStore,
          secretHash,
        });
        plannedVaultSecret = credential.credentialSecret;
        const draft: ConnectorParityIntentInput = {
          tenantId: input.tenantId,
          connectorId: input.connectorId,
          idempotencyKey: input.idempotencyKey,
          payloadHash,
          operation: 'DRAFT',
          expectedHeadRevision: input.expectedHeadRevision,
          recipe: parsedRecipe.data,
          ...credential,
          credentialImportSource: source,
          ...(input.credentialChange.action === 'replace' && credential.credentialSource?.kind === 'encrypted-db'
            ? { credentialSecret: input.credentialChange.secret }
            : {}),
        };
        intent = await repository.beginIntent(draft);
        assertSamePayload(intent, payloadHash);
        replayed = !intent.created;
      }
      if (intent.state === 'COMPLETED') {
        if (!intent.revisionResult) throw new ConnectorError('CREDENTIAL_INVALID', 'Completed Connector draft result is missing.');
        return draftResult(intent.revisionResult, true);
      }
      if (intent.vaultTargetVersion !== null) {
        const plannedSecret = input.credentialChange.action === 'replace'
          ? input.credentialChange.secret
          : plannedVaultSecret ?? await reopenDraftKeepSource(input, repository, options.typedCredentialStore);
        await writePlannedVaultCredential(repository, intent, options.secretWriter, plannedSecret);
      } else if (!await repository.activateConfigWrite(intent.backupEffectId)) {
        throw new ConnectorError('CONNECTOR_DISABLED', 'Connector configuration effects are held for a maintenance backup.');
      }
      const completed = await repository.finalizeIntent(input.tenantId, input.connectorId, input.idempotencyKey);
      if (!completed.revisionResult) throw new ConnectorError('CREDENTIAL_INVALID', 'Connector draft result is missing after completion.');
      return draftResult(completed.revisionResult, replayed);
    },

    async createRollbackDraft(input) {
      validateScope(input.tenantId, input.connectorId);
      if (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 1
        || !Number.isSafeInteger(input.expectedHeadRevision) || input.expectedHeadRevision < 0) {
        throw new ConnectorError('INVALID_INPUT', 'Rollback revision is invalid.');
      }
      const payloadHash = sha256(canonicalize({
        tenantId: input.tenantId,
        connectorId: input.connectorId,
        sourceRevision: input.sourceRevision,
        expectedHeadRevision: input.expectedHeadRevision,
      }));
      let intent = await repository.getIntent(input.tenantId, input.connectorId, input.idempotencyKey);
      let replayed = Boolean(intent);
      let plannedVaultSecret: string | undefined;
      if (intent) assertSamePayload(intent, payloadHash);
      if (!intent) {
        const head = await repository.getHead(input.tenantId, input.connectorId);
        if (head !== input.expectedHeadRevision) throw new ConnectorError('BINDING_DENIED', 'Connector recipe head changed.');
        const sourceRevision = await repository.getRevision(input.tenantId, input.connectorId, input.sourceRevision);
        if (!sourceRevision) throw new ConnectorError('INVALID_INPUT', 'Rollback source revision was not found in this tenant.');
        const credential = await resolveRollbackCredentialPlan(sourceRevision, {
          tenantId: input.tenantId,
          connectorId: input.connectorId,
          mount,
          writer: options.secretWriter,
          typedCredentialStorage: options.typedCredentialStorage === true,
          typedCredentialStore: options.typedCredentialStore,
        });
        plannedVaultSecret = credential.credentialSecret;
        intent = await repository.beginIntent({
          tenantId: input.tenantId,
          connectorId: input.connectorId,
          idempotencyKey: input.idempotencyKey,
          payloadHash,
          operation: 'ROLLBACK',
          expectedHeadRevision: input.expectedHeadRevision,
          sourceRevision: input.sourceRevision,
          recipe: sourceRevision.recipe,
          ...credential,
          credentialImportSource: null,
        });
        assertSamePayload(intent, payloadHash);
        replayed = !intent.created;
      }
      if (intent.state === 'PENDING') {
        if (intent.vaultTargetVersion !== null) {
          const plannedSecret = plannedVaultSecret
            ?? await reopenRollbackSource(input, repository, options.typedCredentialStore);
          await writePlannedVaultCredential(repository, intent, options.secretWriter, plannedSecret);
        } else if (!await repository.activateConfigWrite(intent.backupEffectId)) {
          throw new ConnectorError('CONNECTOR_DISABLED', 'Connector configuration effects are held for a maintenance backup.');
        }
        intent = await repository.finalizeIntent(input.tenantId, input.connectorId, input.idempotencyKey);
      }
      if (!intent.revisionResult) throw new ConnectorError('CREDENTIAL_INVALID', 'Rollback draft result is missing.');
      return draftResult(intent.revisionResult, replayed);
    },
  };
}

async function resolveCredentialPlan(input: {
  change: ConnectorInternalCredentialChange;
  recipe: ConnectorRecipe;
  current: ConnectorParityStoredRevision | undefined;
  tenantId: string;
  connectorId: string;
  mount: string;
  writer?: VaultKv2SecretWriter;
  typedCredentialStorage: boolean;
  typedCredentialStore?: PostgresTypedCredentialStore;
  secretHash: string | null;
}): Promise<Pick<ConnectorParityIntentInput,
  'credentialRef' | 'credentialVersion' | 'credentialSource' | 'vaultExpectedVersion' | 'vaultTargetVersion' | 'vaultSecretSha256' | 'credentialSecret'>
  & { credentialCopyFrom?: ConnectorParityCredentialCopyFrom }> {
  if (input.change.action === 'clear') {
    if (input.recipe.auth.kind !== 'none') {
      throw new ConnectorError('INVALID_INPUT', 'Clear credential requires a recipe with authentication disabled.');
    }
    return emptyCredentialPlan();
  }
  if (input.recipe.auth.kind === 'none') {
    if (input.change.action === 'replace' || input.change.action === 'vault-ref') {
      throw new ConnectorError('INVALID_INPUT', 'A credential cannot be staged for a recipe with authentication disabled.');
    }
    return emptyCredentialPlan();
  }
  if (input.change.action === 'keep') {
    const current = input.current;
    if (!current?.credentialRef || !current.credentialVersion || !current.credentialSource) {
      throw new ConnectorError('CREDENTIAL_INVALID', 'The current recipe has no credential to keep.');
    }
    if (current.credentialSource.kind === 'encrypted-db') {
      if (!input.typedCredentialStorage) {
        throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Typed Connector credential encryption is not configured.');
      }
      if (input.writer) {
        const retainedSecret = await readEncryptedDbCredential(input.typedCredentialStore, current);
        return {
          ...await planVaultCredential({
            tenantId: input.tenantId,
            connectorId: input.connectorId,
            mount: input.mount,
            writer: input.writer,
            secretHash: sha256(retainedSecret),
          }),
          credentialSecret: retainedSecret,
        };
      }
      const credentialRef = randomUUID();
      const credentialSource: EncryptedDbCredentialSource = {
        kind: 'encrypted-db',
        credentialRef,
        version: 1,
      };
      return {
        credentialRef,
        credentialVersion: credentialSource.version,
        credentialSource,
        credentialCopyFrom: {
          revision: current.revision,
          credentialRef: current.credentialRef,
          credentialVersion: current.credentialVersion,
          credentialSource: current.credentialSource,
        },
        vaultExpectedVersion: null,
        vaultTargetVersion: null,
        vaultSecretSha256: null,
      };
    }
    return {
      credentialRef: current.credentialRef,
      credentialVersion: current.credentialVersion,
      credentialSource: current.credentialSource,
      vaultExpectedVersion: null,
      vaultTargetVersion: null,
      vaultSecretSha256: null,
    };
  }
  if (input.change.action !== 'replace') throw new ConnectorError('INVALID_INPUT', 'Credential change is invalid.');
  if (!input.secretHash) throw new ConnectorError('INVALID_INPUT', 'Connector credential value is invalid.');
  if (!input.writer) {
    if (!input.typedCredentialStorage) {
      throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Typed Connector credential encryption is not configured.');
    }
    const credentialRef = randomUUID();
    const credentialSource: EncryptedDbCredentialSource = { kind: 'encrypted-db', credentialRef, version: 1 };
    return {
      credentialRef,
      credentialVersion: credentialSource.version,
      credentialSource,
      vaultExpectedVersion: null,
      vaultTargetVersion: null,
      vaultSecretSha256: null,
    };
  }
  return planVaultCredential({
    tenantId: input.tenantId,
    connectorId: input.connectorId,
    mount: input.mount,
    writer: input.writer,
    secretHash: input.secretHash,
  });
}

async function resolveRollbackCredentialPlan(
  revision: ConnectorParityStoredRevision,
  options: {
    tenantId: string;
    connectorId: string;
    mount: string;
    writer?: VaultKv2SecretWriter;
    typedCredentialStorage: boolean;
    typedCredentialStore?: PostgresTypedCredentialStore;
  },
): Promise<Pick<ConnectorParityIntentInput,
  'credentialRef' | 'credentialVersion' | 'credentialSource' | 'vaultExpectedVersion' | 'vaultTargetVersion' | 'vaultSecretSha256' | 'credentialSecret'>
  & { credentialCopyFrom?: ConnectorParityCredentialCopyFrom }> {
  const source = revision.credentialSource;
  if (!source || !revision.credentialRef || revision.credentialVersion === null) return emptyCredentialPlan();
  if (source.kind === 'encrypted-db') {
    if (!options.typedCredentialStorage) {
      throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Typed Connector credential encryption is not configured.');
    }
    if (options.writer) {
      const retainedSecret = await readEncryptedDbCredential(options.typedCredentialStore, revision);
      return {
        ...await planVaultCredential({
          tenantId: options.tenantId,
          connectorId: options.connectorId,
          mount: options.mount,
          writer: options.writer,
          secretHash: sha256(retainedSecret),
        }),
        credentialSecret: retainedSecret,
      };
    }
    const credentialRef = randomUUID();
    const credentialSource: EncryptedDbCredentialSource = { kind: 'encrypted-db', credentialRef, version: 1 };
    return {
      credentialRef,
      credentialVersion: credentialSource.version,
      credentialSource,
      credentialCopyFrom: {
        revision: revision.revision,
        credentialRef: revision.credentialRef,
        credentialVersion: revision.credentialVersion,
        credentialSource: source,
      },
      vaultExpectedVersion: null,
      vaultTargetVersion: null,
      vaultSecretSha256: null,
    };
  }
  return {
    credentialRef: revision.credentialRef,
    credentialVersion: revision.credentialVersion,
    credentialSource: source,
    vaultExpectedVersion: null,
    vaultTargetVersion: null,
    vaultSecretSha256: null,
  };
}

async function planVaultCredential(input: {
  tenantId: string;
  connectorId: string;
  mount: string;
  writer: VaultKv2SecretWriter;
  secretHash: string;
}): Promise<Pick<ConnectorParityIntentInput,
  'credentialRef' | 'credentialVersion' | 'credentialSource' | 'vaultExpectedVersion' | 'vaultTargetVersion' | 'vaultSecretSha256'>> {
  const path = `du/tenants/${input.tenantId}/connectors/${input.connectorId}/accounts/${VAULT_ACCOUNT}`;
  const key = `credential-${randomUUID()}`;
  const planBase = { account: VAULT_ACCOUNT, mount: input.mount, path, key };
  const expectedVersion = await input.writer.currentVersion(planBase);
  if (expectedVersion >= 2_147_483_646) throw new ConnectorError('PROVIDER_UNAVAILABLE', 'Vault credential version limit was reached.');
  const targetVersion = expectedVersion + 1;
  const credentialSource: VaultCredentialSource = {
    kind: 'vault-kv2',
    ...planBase,
    version: targetVersion,
  };
  return {
    credentialRef: `recipe-${randomUUID()}`,
    credentialVersion: targetVersion,
    credentialSource,
    vaultExpectedVersion: expectedVersion,
    vaultTargetVersion: targetVersion,
    vaultSecretSha256: input.secretHash,
  };
}

async function readEncryptedDbCredential(
  store: PostgresTypedCredentialStore | undefined,
  revision: ConnectorParityStoredRevision,
): Promise<string> {
  const source = revision.credentialSource;
  if (!store || !source || source.kind !== 'encrypted-db'
    || !revision.credentialRef || revision.credentialVersion === null
    || source.credentialRef !== revision.credentialRef || source.version !== revision.credentialVersion) {
    throw new ConnectorError('CREDENTIAL_INVALID', 'Encrypted Connector credential source is unavailable.');
  }
  return store.resolve({
    tenantId: revision.tenantId,
    connectorId: revision.connectorId,
    revision: revision.revision,
    credentialRef: revision.credentialRef,
    credentialVersion: revision.credentialVersion,
  }, source);
}

async function reopenDraftKeepSource(
  input: ConnectorInternalDraftUpsert,
  repository: PostgresConnectorParityRepository,
  store: PostgresTypedCredentialStore | undefined,
): Promise<string> {
  if (input.credentialChange.action !== 'keep' || input.expectedHeadRevision < 1) {
    throw new ConnectorError('CREDENTIAL_INVALID', 'Pending Vault credential migration cannot be reconciled.');
  }
  const sourceRevision = await repository.getRevision(input.tenantId, input.connectorId, input.expectedHeadRevision);
  if (!sourceRevision) throw new ConnectorError('CREDENTIAL_INVALID', 'Pending Vault credential migration source is unavailable.');
  return readEncryptedDbCredential(store, sourceRevision);
}

async function reopenRollbackSource(
  input: ConnectorInternalRollbackDraft,
  repository: PostgresConnectorParityRepository,
  store: PostgresTypedCredentialStore | undefined,
): Promise<string> {
  const sourceRevision = await repository.getRevision(input.tenantId, input.connectorId, input.sourceRevision);
  if (!sourceRevision) throw new ConnectorError('CREDENTIAL_INVALID', 'Pending Vault rollback source is unavailable.');
  return readEncryptedDbCredential(store, sourceRevision);
}

async function writePlannedVaultCredential(
  repository: PostgresConnectorParityRepository,
  intent: ConnectorParityIntentResult,
  writer: VaultKv2SecretWriter | undefined,
  secret: string,
): Promise<void> {
  const source = intent.credentialSource;
  if (!writer || !source || source.kind !== 'vault-kv2' || intent.vaultExpectedVersion === null
    || intent.vaultTargetVersion === null || !intent.vaultSecretSha256
    || source.version !== intent.vaultTargetVersion) {
    throw new ConnectorError('CREDENTIAL_INVALID', 'Pending Connector credential write cannot be reconciled.');
  }
  if (sha256(secret) !== intent.vaultSecretSha256) {
    throw new ConnectorError('INPUT_HASH_MISMATCH', 'Staged Connector credential differs from its exact replay.');
  }
  const plan: VaultKv2SecretWritePlan = {
    account: source.account,
    mount: source.mount,
    path: source.path,
    key: source.key,
    expectedVersion: intent.vaultExpectedVersion,
    targetVersion: intent.vaultTargetVersion,
    secretSha256: intent.vaultSecretSha256,
  };
  if (!await repository.activateConfigWrite(intent.backupEffectId)) {
    throw new ConnectorError('CONNECTOR_DISABLED', 'Connector configuration effects are held for a maintenance backup.');
  }
  let actualVersion: number;
  try {
    actualVersion = await writer.writePlanned(plan, secret);
  } catch (error) {
    await repository.markConfigWriteUnknown(intent.backupEffectId, 'VAULT_WRITE_AMBIGUOUS');
    throw error;
  }
  if (actualVersion !== intent.vaultTargetVersion) {
    await repository.markConfigWriteUnknown(intent.backupEffectId, 'VAULT_VERSION_MISMATCH');
    throw new ConnectorError('CREDENTIAL_INVALID', 'Vault returned a different credential version.');
  }
}

function emptyCredentialPlan() {
  return {
    credentialRef: null,
    credentialVersion: null,
    credentialSource: null,
    vaultExpectedVersion: null,
    vaultTargetVersion: null,
    vaultSecretSha256: null,
  };
}

function validateScope(tenantId: string, connectorId: string): void {
  if (!isTenantUuid(tenantId)
    || !CONNECTOR_ID.test(connectorId) || connectorId.includes('..')) {
    throw new ConnectorError('INVALID_INPUT', 'Tenant or Connector identifier is invalid.');
  }
}

function validateImportSource(
  value: ConnectorParityCredentialImportSource | undefined,
  change: ConnectorInternalCredentialChange,
): ConnectorParityCredentialImportSource | null {
  if (value === undefined) return null;
  if (change.action !== 'replace'
    || !CATALOG_VERSION_REF.test(value.catalogVersionRef)
    || !CATALOG_KEY_VERSION.test(value.catalogKeyVersion)) {
    throw new ConnectorError('INVALID_INPUT', 'Catalog import provenance is invalid.');
  }
  return { catalogVersionRef: value.catalogVersionRef, catalogKeyVersion: value.catalogKeyVersion };
}

function assertSamePayload(intent: { revision: number; payloadHash?: string } | undefined, expected: string): void {
  // Repository's public intent object intentionally does not echo the hash.
  // The dedicated read below receives it through this hidden property for the
  // service only; see `attachIntentHash` at the repository boundary.
  if (intent?.payloadHash !== undefined && intent.payloadHash !== expected) {
    throw new ConnectorError('INPUT_HASH_MISMATCH', 'Idempotency key was used for a different connector draft.');
  }
}

function publicRevision(revision: ConnectorParityStoredRevision): ConnectorParityRevision {
  return ConnectorParityRevisionSchema.parse({
    tenantId: revision.tenantId,
    connectorId: revision.connectorId,
    revision: revision.revision,
    state: revision.state,
    recipe: revision.recipe,
    credentialRef: revision.credentialRef,
    credentialVersion: revision.credentialVersion,
    expectedHeadRevision: revision.expectedHeadRevision,
  });
}

function draftResult(revision: ConnectorParityStoredRevision, replayed: boolean): ConnectorParityDraftResult {
  const parsed = ConnectorParityRevisionSchema.parse(publicRevision(revision));
  return { revision: parsed, expectedHeadRevision: parsed.expectedHeadRevision, replayed };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
