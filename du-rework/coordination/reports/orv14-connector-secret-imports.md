# ORV14 Connector Secret Catalog import

The internal parity draft route accepts the existing opaque Catalog `vault-ref` command and delegates to the sealed server-side import journal. The importer resolves only an ACTIVE, current, same-tenant `connector.credential` managed value, seals the exact resolved replacement under the dedicated `connector_secret_imports.resolved_payload` AAD slot, and commits a PENDING journal row before calling Connector. Retries reuse that exact sealed payload and Connector idempotency key. A completed retry returns the stored masked `ConnectorParityDraftResult`; uncertain transport leaves the journal pending. Raw credentials are absent from the audit record and never appear in public request or response DTOs.

The factory for trusted in-process migration use is exported from `src/modules/connectors/connector-secret-imports.ts`:

```ts
createConnectorSecretImportService({
  db, audit, metadataCrypto, catalogKeyring,
  connector: { upsertResolvedRecipeDraft },
  now?,
})
```

Call `importCredential(connectorId, publicConnectorDraft, actor)`, where the strict public draft contains `credentialChange: { action: 'vault-ref', reference: secretId }`, and the server-created actor has `{ actor, role: 'platform', issuer?, sub?, correlationId? }`. The ordinary app bootstrap constructs this same factory and returns it as `app.connectorSecretImports`; it is also available to the normal compiled runner at `dist/modules/connectors/connector-secret-imports.js`.

For a direct CJS migration runner, construct the same dependencies from the built modules: `createDb(DATABASE_URL)`, `createAuditService(db)`, `parseSecretCatalogKeyring(process.env)`, `buildEncryptionBootOptions(process.env).metadataEncryption` followed by `createMetadataCrypto(adaptKeyProviderForMetadata(keyProvider), keyRef)`, and `createConnectorManagementStore` using the result of `assertConnectorComposition(process.env)` plus `connectorBaseUrlResolver`. The relevant keyring variables are `DU_SECRET_CATALOG_ACTIVE_KEY_VERSION` and `DU_SECRET_CATALOG_KEYRING_JSON`; metadata encryption uses the existing `DU_VAULT_TRANSIT_OPTIONS`, Vault Transit token, metadata-enabled, and metadata key-ref boot configuration. Do not replace the exact-version keyring or metadata crypto with defaults.

## Owner checks

- Focused Jest command from `orchestrator/services/orchestrator`: `/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/orv14-connector-secret-imports-owner.test.ts` — passed, 1 suite / 5 tests.
- Orchestrator `tsc -p tsconfig.json --noEmit --pretty false` — exit 2 from concurrent Cost Alerts/cost-control source against stale `@du/contracts` dist; no diagnostic names the importer, Connector store, route context, internal parity route, or create-app hunks. This is not a clean package typecheck.
- No shared Orchestrator `dist` build was run; the final build output remains with the independent verifier.

Source SHA-256 at owner freeze:

```text
c96a9c1c27c7a67945e274586993bcd5e199b609c915edbbf458b2b1af6d768b  orchestrator/services/orchestrator/src/modules/connectors/connector-secret-imports.ts
c2c603da5daa04a2e6a58f2d4a5e5935609dee0ba906fc4622ed132c4f44e175  orchestrator/services/orchestrator/src/modules/connectors/connector-management-store.ts
0b94eb4a68ecef4839e52af329f95289915183ec6eae57ed861aecc12515fff3  orchestrator/services/orchestrator/src/modules/runtime/metadata-crypto.ts
fbc35a4f235c5b42df23057af42a65cb34782a14fa0fb6c7913fb01c8b98392b  orchestrator/services/orchestrator/src/http/route-context.ts
19e5f594504efc423e2d68b3ba8719af4bc82dbca22db187e019c9f3806945c9  orchestrator/services/orchestrator/src/http/routes/internal-parity.ts
c67c0b59aadbefa46f2c1c691c1424bd851c332d69f1aa389f876375ed72c8fa  orchestrator/services/orchestrator/src/app/bootstrap/create-app.ts
457c8ef9a12a495fecc91f20d8f81af28bbdacb04422a1b477bad9fa45ec5e12  orchestrator/services/orchestrator/migrations/0060_connector_secret_imports.sql
9f876de8b565f28c7b1131b76c2fece7afe5d91192c7230369c4bb29ad5d52b5  orchestrator/services/orchestrator/tests/orv14-connector-secret-imports-owner.test.ts
```

## Claim gate amendment (2026-10-11)

Before opening the Catalog value, the importer now calls the signed Connector `claimRecipeDraft({tenantId,connectorId,expectedHeadRevision,idempotencyKey})` endpoint. A generic denied/mismatched claim returns 409 without reading Catalog. Exact owner/idempotency replay remains accepted after a successful stage advances the head; current owner authorization is rechecked on every importer retry. The importer also validates the returned credential ref against the producer's opaque `recipe-<UUID>` form and confirms tenant, connector, PENDING state, revision, and expected head before committing the masked result.

Updated importer source SHA-256: `887a82c3eb093873806def1acaf0e90576a44a6e4b2e3c556ab872264f4d848b`. Updated test SHA-256: `40ca5c0ee683ae9e892ba311ee50f47c6cb81f5400bf0e8e9080b094b04e42ea`. Latest focused importer + incident + operations + isolated runtime command passes 4 suites / 11 tests; full output: `coordination/reports/raw/orv14-backend/narrow-owner-tests.txt`.
