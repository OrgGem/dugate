# LDBA-05 connector adapter receipt

## Result

The offline projection module and its focused test were added. This is a partial implementation of the dispatch acceptance. No database was contacted, no migration was run, no existing connector source or migration was changed, and no gate was ticked.

Files created:

- orchestrator/services/connector/src/db/legacy-connector-adapter.ts
- orchestrator/services/connector/tests/legacy-connector-adapter.test.ts
- coordination/reports/ldba-05-connector-adapter.md

## Projection behavior

The module projects a single ExternalApiConnection row into a revision record and a secret version record. It performs no SQL or filesystem access.

- The source id is copied byte-for-byte to connectorId. No UUID parse or cast is used. The source id and generated secret version id remain text, matching 001_connector.sql lines 2, 13, and 25 and the verified LDBA-00 mapping at lines 63-75 of coordination/reports/ldba-00-schema-mapping.md.
- The first connector revision is 1. The connector id and credential reference are deterministic text values. The secret version id is also deterministic text and identifies version 1.
- credential_ref is legacy-db:connector: followed by the original text id. credential_source is legacy-db with the same reference.
- tenantId is the empty text value because migration 008 requires legacy-db rows to remain unbound. The repository enforces this at services/connector/src/db/repository.ts lines 520-575 and 928. This conflicts with the generic legacy-default tenant decision in the plan and needs coordinator disposition.
- authSecret is passed to the existing AesCredentialCipher. The existing cipher uses AES-256-GCM at services/connector/src/services.ts lines 24-48. Production wiring requires CONNECTOR_ENCRYPTION_KEY and validates a base64 32-byte value at services/connector/src/entrypoint.ts lines 22 and 63-82. The adapter stops if no cipher is supplied, the secret is absent, encryption throws, or the returned bytes are not a plausible AES-GCM envelope. It never assigns authSecret to config or encryptedValue.
- The projection omits rotated_at so the target default now() records import time. There is no source timestamp specific to secret rotation, so this is not a claim about the historical rotation time.
- createdAt maps to the revision createdAt value. A timezone-free source timestamp string is interpreted as UTC. sourceUpdatedAt is retained only as projection metadata because connector_revisions has no updated_at column in migrations 001-009. Revision 1 cannot recover a later source modification time, so that time is not available from the target row.

### Config field map

All 17 config fields recorded in the LDBA-00 mapping are retained under their original key names. staticFormFields and extraHeaders are parsed from JSON text; malformed JSON stops the row.

| Legacy field | Projection key or derived value |
|---|---|
| name | config.name |
| slug | config.slug; kept as connection metadata, not the AdapterRegistry id |
| description | config.description |
| endpointUrl | config.endpointUrl; baseUrl and path are derived after URL validation |
| httpMethod | config.httpMethod; only POST is currently accepted |
| authType | config.authType; only API_KEY_HEADER is currently accepted |
| authKeyHeader | config.authKeyHeader and credentialSlot header mapping |
| promptFieldName | config.promptFieldName and requestMapping |
| fileFieldName | config.fileFieldName, requestMapping, and transport selection |
| fileUrlFieldName | config.fileUrlFieldName |
| defaultPrompt | config.defaultPrompt |
| staticFormFields | config.staticFormFields after JSON parsing |
| extraHeaders | config.extraHeaders after JSON parsing and config.headers |
| responseContentPath | config.responseContentPath and responseMapping content |
| sessionIdResponsePath | config.sessionIdResponsePath and responseMapping sessionRef |
| sessionIdFieldName | config.sessionIdFieldName and requestMapping sessionRef |
| timeoutSec | config.timeoutSec and derived timeoutMs |

The adapter identifier is selected from the current registry values json-http and multipart-http at services/connector/src/adapters/registry.ts lines 5-15 and http.ts lines 28 and 93. A non-empty fileFieldName selects multipart-http; otherwise json-http is selected. The source slug is not copied into adapter.

## State map and schema discrepancies

| Legacy state | Projected state | Disposition |
|---|---|---|
| ENABLED | ACTIVE | Intended as a name change preserving the enabled and routable meaning |
| DISABLED | RETIRED | Matches the existing normalization in 006_connector_revision_lifecycle.sql lines 12-21, but RETIRED is terminal and may remove legacy re-enable behavior |
| Any other value | No projection | The row stops with UNMAPPABLE_STATE |

The dispatch description of the target state union is stale. Migration 006 lines 12-21 and services/connector/src/db/repository.ts lines 490-498 define PENDING, ACTIVE, and RETIRED. Migration 001 lines 1-9 shows the initial state constraint, which migration 006 replaces.

The ExternalApiOverride mapping cannot currently satisfy the requested revision pin. The target table in orchestrator/services/orchestrator/migrations/0026_profile_policy.sql lines 121-139 has connection_id uuid and no revision column. Its unique key is connection_id, api_key_id, endpoint_slug, and step_id. A connector revision pin cannot be persisted there. The source Connector identifier must remain text, while this target column is UUID. No migration or schema change was made to bridge the mismatch. Override rows are therefore not projected by this module.

## Verification

Runtime: Node v24.21.0. Working directory for both commands: D:/Git/dugate/du-rework/orchestrator/services/connector.

Command: node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/legacy-connector-adapter.test.ts

Literal output:

Test Suites: 1 passed, 1 total
Tests: 8 passed, 8 total
Time: 3.028 s, estimated 7 s
REAL_EXIT=0

Command: node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json

Literal result: no output; REAL_EXIT=0.

The eight offline tests cover text identity, config projection, revision 1, AES-GCM ciphertext and decrypt roundtrip, missing cipher, missing secret, state mapping and rejection, unsupported method/auth type, malformed JSON, and unsafe endpoint userinfo. The unsupported-state fixture is one synthetic value and is rejected. No test data came from a database.

Both new files contain zero double-quote characters and no trailing whitespace. No test covers a live database or persists an override row.

## Open items for coordinator

1. The request restricts repository access to du-rework, while the dispatch asks for a direct read of root lib/db/schema.ts. That source file was not read. The field list above uses the previously verified LDBA-00 receipt at lines 63-75; exact source defaults and nullability were not independently rechecked in this lane.
2. Decide how connector_prompt_overrides can pin a concrete connector revision without changing its current schema, and reconcile its UUID connection_id with the text connector id.
3. Reconcile the plan legacy-default tenant with migration 008 and the repository rule that legacy-db rows use the unbound empty tenant value.
4. Confirm the intended disposition for DISABLED rows, since the current target maps them to terminal RETIRED.
5. The current multipart adapter uses its own request field names and does not consume all preserved legacy fields such as staticFormFields, fileUrlFieldName, or defaultPrompt. This projection preserves those values but does not prove execution parity for every legacy connection.
6. Rows with a missing authSecret stop. The dispatch does not define whether unauthenticated legacy connectors are valid and how they should be represented.

No commit, staging, push, migration execution, or database access was performed.
