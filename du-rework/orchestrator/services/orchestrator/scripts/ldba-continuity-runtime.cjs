'use strict';

const path = require('node:path');

/**
 * Construct the same server-side secret import stack used by createApp. This
 * is deliberately tied to normal compiled Orchestrator modules: there is no
 * plaintext HTTP endpoint and no test callback that can stand in for the
 * catalog or Connector import journals.
 */
function createTrustedSecretImportRuntime(options = {}) {
  const root = options.distRoot || path.resolve(__dirname, '../dist');
  const load = relative => require(path.join(root, relative));
  const { createDb } = load('db/db.js');
  const { createAuditService } = load('modules/audit/audit.js');
  const { parseSecretCatalogKeyring } = load('modules/secrets/secret-revision-resolver.js');
  const { writeImportedManagedSecret } = load('modules/secrets/secret-catalog-store.js');
  const { createMetadataCrypto } = load('modules/runtime/metadata-crypto.js');
  const { adaptKeyProviderForMetadata } = load('modules/encryption/metadata-key-adapter.js');
  const { buildEncryptionBootOptions } = load('modules/encryption/boot-options.js');
  const { assertConnectorComposition } = load('main.js');
  const { createConnectorManagementStore } = load('modules/connectors/connector-management-store.js');
  const { connectorBaseUrlResolver } = load('app/bootstrap/create-app.js');
  const { createConnectorSecretImportService } = load('modules/connectors/connector-secret-imports.js');
  const { createBackupSnapshotWriteGate } = load('modules/maintenance/backup-effect-fence.js');

  const databaseUrl = options.databaseUrl || process.env.LDBA03_TARGET_DATABASE_URL;
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) fail('TARGET_DATABASE_URL_REQUIRED');
  const boot = buildEncryptionBootOptions(process.env);
  if (!boot?.metadataEncryption) fail('METADATA_ENCRYPTION_REQUIRED');
  const keyring = parseSecretCatalogKeyring(process.env);
  if (!keyring) fail('SECRET_CATALOG_KEYRING_REQUIRED');
  const connectorComposition = assertConnectorComposition(process.env);
  if (!connectorComposition.connectorBaseUrls || !connectorComposition.connectorManagementAuthorizationForRequest) {
    fail('CONNECTOR_MANAGEMENT_REQUIRED');
  }

  const db = createDb(databaseUrl);
  const backupSnapshotWriteGate = createBackupSnapshotWriteGate();
  const audit = createAuditService(db);
  const metadataCrypto = createMetadataCrypto(
    adaptKeyProviderForMetadata(boot.metadataEncryption.keyProvider),
    boot.metadataEncryption.keyRef,
  );
  const connectorManagement = createConnectorManagementStore({
    baseUrlFor: connectorBaseUrlResolver(connectorComposition.connectorBaseUrls),
    authorizationForRequest: connectorComposition.connectorManagementAuthorizationForRequest,
  });
  const connectorSecretImports = createConnectorSecretImportService({
    db,
    audit,
    metadataCrypto,
    catalogKeyring: keyring,
    backupSnapshotWriteGate,
    connector: {
      claimRecipeDraft: input => connectorManagement.claimRecipeDraft(input),
      upsertResolvedRecipeDraft: input => connectorManagement.upsertResolvedRecipeDraft(input),
    },
  });
  let closed = false;
  return {
    capabilities: Object.freeze({ typedConnectorRetirement: typeof connectorManagement.retireRecipeRevision === 'function' }),
    async writeImportedSecret(input) {
      if (closed) fail('SECRET_IMPORT_RUNTIME_CLOSED');
      return writeImportedManagedSecret(db, audit, input, {
        keyring,
        backupSnapshotWriteGate,
        actor: { actor: 'ldba-continuity-runner', actorRole: 'platform' },
      });
    },
    async importConnectorCredential(connectorId, publicDraft, idempotencyKey) {
      if (closed) fail('SECRET_IMPORT_RUNTIME_CLOSED');
      return connectorSecretImports.importCredential(connectorId, publicDraft, {
        actor: 'ldba-continuity-runner', role: 'platform', correlationId: idempotencyKey,
      });
    },
    async upsertConnectorRecipeDraft(input) {
      if (closed) fail('SECRET_IMPORT_RUNTIME_CLOSED');
      return connectorManagement.upsertRecipeDraft(input);
    },
    async readConnectorRevision(tenantId, connectorId, revision) {
      if (closed) fail('SECRET_IMPORT_RUNTIME_CLOSED');
      return connectorManagement.getRecipeRevision({ tenantId, connectorId, revision });
    },
    async activateConnectorRevision(tenantId, connectorId, revision, expectedCurrentRevision) {
      if (closed) fail('SECRET_IMPORT_RUNTIME_CLOSED');
      return connectorManagement.activateRecipeRevision({ tenantId, connectorId, revision, expectedCurrentRevision });
    },
    async retireConnectorRevision(tenantId, connectorId, revision, expectedCurrentRevision, idempotencyKey, reason = 'LEGACY_DISABLED_IMPORT') {
      if (closed) fail('SECRET_IMPORT_RUNTIME_CLOSED');
      if (typeof connectorManagement.retireRecipeRevision !== 'function') fail('TYPED_CONNECTOR_RETIREMENT_UNAVAILABLE');
      if (!Number.isSafeInteger(expectedCurrentRevision) || expectedCurrentRevision < 0
          || typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 200
          || reason !== 'LEGACY_DISABLED_IMPORT') fail('TYPED_CONNECTOR_RETIREMENT_INPUT_INVALID');
      return connectorManagement.retireRecipeRevision({ tenantId, connectorId, revision,
        expectedCurrentRevision, idempotencyKey, reason });
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const key of Object.values(keyring.keys)) if (Buffer.isBuffer(key)) key.fill(0);
      await db.close();
    },
  };
}

function fail(code) { throw Object.assign(new Error(code), { code }); }

module.exports = { createTrustedSecretImportRuntime };
