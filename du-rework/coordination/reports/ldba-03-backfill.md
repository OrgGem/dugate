# LDBA-03 backfill script receipt

Status: implementation and synthetic offline verification complete; real A2 remains blocked. No gate was ticked.

## Scope and artifacts

Added only the standalone transform runner, its dedicated offline test, and this receipt:

- `orchestrator/services/orchestrator/scripts/ldba-03-backfill.cjs`
- `orchestrator/services/orchestrator/tests/ldba-03-backfill-offline.test.cjs`
- `coordination/reports/ldba-03-backfill.md`

No existing product source, test, migration, plan, or other documentation was changed. No DB connection, migration run, live object read, commit, stage, or push occurred.

## Transform and safety behavior

The dispatch prose says eight legacy tables, while the verified mapping and source schema enumerate nine. The runner covers all nine: `Operation`, `ApiKey`, `ExternalApiConnection`, `ExternalApiOverride`, `ProfileEndpoint`, `AppSetting`, `FileCache`, `User`, and `UserProfileAssignment`.

The runner requires matching A1 evidence for the exact frozen source version, scans through an injected source adapter, validates rows before writes, reports row-level failures and omissions, and delegates immutable inspection and atomic batch writes to an injected sink. It rejects unknown operation and API-key states, invalid UUID text, malformed JSON, non-UTC-naive timestamps, invalid encrypted file-URL cipher text, unsafe decimal inputs, and unresolved transforms. It does not delete source rows. Workflow duplicate selection is deterministic and conflicting latest rows fail closed. FileCache bytes must come from an injected reader and match source size and MD5 before bytes are planned for target blob storage.

The runner has explicit stop conditions for unresolved callbacks under LDBA-01 L3, identity conversion under LDBA-04, connector secret preparation under LDBA-05, and workflow registry validation and sealing under LDBA-06. FileCache also requires an approved byte reader, token policy, and purpose policy. Synthetic test callbacks exercise these interfaces only; they are not approved production adapters.

Source timestamps are read as timezone-free text and converted using a fixed UTC interpretation. The inspected root Compose and Docker configuration do not pin a runtime timezone, so the actual legacy runtime timezone remains unproven. If legacy naive values represent local wall time, the UTC interpretation can shift instants; A1 must resolve this before a real backfill.

## Tenant model correction

The Orchestrator tenant key `legacy-default` is a name, not a UUID. Target `migrations/0001_platform_v1.sql:7-12` defines `id uuid DEFAULT gen_random_uuid()` and `name text NOT NULL`, with no unique constraint on `name`. The runner no longer derives or hardcodes a UUID and does not use the development fixture fallback UUID.

At runtime the sink must return every UUID matching the name `legacy-default`. Zero matches in read-only preflight returns `PREFLIGHT_TENANT_PENDING` without seeding. Execute mode seeds only by calling `seedTenantByName` with the name; the adapter contract requires the parameterized equivalent of `INSERT INTO tenants (name) VALUES ($1)` with only the name bound, so PostgreSQL generates the UUID. The runner then resolves the name again and threads that runtime UUID through UUID-tenant transforms. More than one match fails closed. Because the schema has no unique name constraint, the real adapter must serialize resolve-and-seed, such as with an advisory lock. No real adapter or DB DML was provided or exercised in this task. A seed made before a later transform or target failure can remain as an empty tenant row; the runner does not delete it.

Connector revisions use a separate tenant model. `services/connector/src/db/migrations/008_connector_revision_binding.sql:3-8,16-20` documents legacy rows as unbound and defines `tenant_id TEXT NOT NULL DEFAULT ''`; `007_connector_credential_source.sql:1-13` preserves the legacy credential reference as `legacy-db`. The transform now requires `tenant_id` to remain empty, `account_id` to remain null, and the `legacy-db` credential reference to match `credential_ref`. Connector IDs and secret-version IDs remain text. No Orchestrator UUID or `legacy-default` name is written into connector tenant fields.

## Offline verification

Commands were run from `du-rework/orchestrator/services/orchestrator` with synthetic in-memory adapters only:

- `node --check scripts/ldba-03-backfill.cjs` — exit code 0, no output.
- `node --check tests/ldba-03-backfill-offline.test.cjs` — exit code 0, no output.
- `node --test tests/ldba-03-backfill-offline.test.cjs` — exit code 0. Literal summary: `ℹ tests 20`, `ℹ pass 20`, `ℹ fail 0`, `ℹ skipped 0`.

Tests cover generated runtime tenant UUID use, name-only seeding, read-only preflight when the tenant is absent, duplicate tenant names, separate unbound connector semantics, and the existing fail-closed transforms. These results establish only synthetic offline behavior. No PostgreSQL, Redis, S3, DB window, migration application, or actual A2 execution is claimed.

## Open items for coordinator

- Provide A1 view evidence for the same frozen source version before A2. No such evidence was supplied here.
- Supply and review the real source and sink adapter. It must resolve all rows by tenant name, serialize seed because name is not unique, insert only `tenants.name`, and rely on the DB-generated UUID.
- Establish the actual legacy timestamp timezone and confirm or correct the fixed UTC interpretation before converting persisted timestamps.
- Resolve L3 callback history and obtain the LDBA-04, LDBA-05, and LDBA-06 adapters and policies before their corresponding rows can transform.
- Approve the source object reader, artifact token, and purpose policies before FileCache rows can transform.

No DB, build, or migration command was run. No gate was ticked. No commit, git add, or push was performed.
