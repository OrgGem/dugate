# ORV14 Connector cost and typed-recipe source checkpoint

Status: **Connector source frozen for independent verification**. This freezes the Connector producer/runtime leaf and its owned contracts/tests at the hashes in `coordination/reports/raw/orv14-cost/`. It is not an end-to-end verification claim.

The Connector now performs authenticated cost preflight after rendering and before provider transport, records the durable RUNNING transition before send, leaves ambiguous sends UNKNOWN without replay, and emits usage through the immutable outbox. Billable cost comes only from validated safe-integer units and the frozen trusted price. Provider-reported cost is retained as an optional `{costMicrousd,currency:'USD',source:'provider-response',status:'unverified'}` diagnostic; it does not affect billing, reservation, or settlement. Cached-input units are bounded by input units and priced separately when the frozen tier defines a cached rate. Invalid units remain pending/unpriced rather than becoming zero-cost measured usage.

Tenant-scoped typed recipe management uses `connector:management` on these internal routes:

- `POST /internal/admin/connector-revisions/:id/claim` reserves an unowned connector ID or verifies same-tenant ownership, with durable exact-key replay before mutable-head CAS.
- `GET /internal/admin/connector-revisions/:id/:revision?tenantId=...` reads one exact immutable revision.
- `PUT /internal/admin/connector-revisions/:id/draft` creates an immutable PENDING revision with CAS and durable idempotency. The private `credentialImportSource` is accepted only with a resolved replace operation and is retained as opaque provenance; the credential value is never returned.
- `POST /internal/admin/connector-revisions/:id/:revision/activate` CASes activation.
- `POST /internal/admin/connector-revisions/:id/rollback/draft` clones an exact prior revision into a new PENDING revision.
- `POST /internal/admin/connector-revisions/:id/:revision/retire` retires an exact PENDING or active revision by CAS while retaining its recipe and credential pin.

Typed recipes are stored encrypted with tenant/connector/revision-bound AAD; the runtime resolves the exact pinned typed revision and credential. Migrations `013_connector_recipe_revisions.sql` and `014_connector_recipe_retirement.sql` are registered with the Connector migration runner.

Owner validation ran from `/workspace/dugate/du-rework` on 2026-10-11:

- `node orchestrator/services/connector/node_modules/jest/bin/jest.js --config orchestrator/services/connector/jest.config.cjs --runInBand orchestrator/services/connector/tests/orv14-*.test.ts` — 6 suites, 28 tests passed.
- `node orchestrator/services/connector/node_modules/typescript/bin/tsc --noEmit -p orchestrator/services/connector/tsconfig.json` — exit 0.
- `git diff --check -- orchestrator/services/connector orchestrator/packages/contracts/src/connector.ts orchestrator/packages/contracts/src/usage-metrics.ts` — exit 0.

Raw logs and source hash manifests are in `coordination/reports/raw/orv14-cost/`. The source manifests include all Connector source files, all ORV14 Connector owner tests, shared contract sources, and the currently consumed contract declarations/runtime. The independent verifier still needs to exercise the actual PostgreSQL migration chain, authenticated cost-control service, Vault staging/lost-ack replay, real preflight denial/no-send and successful dispatch/outbox settlement, UNKNOWN hold/reconciliation, and tenant isolation against an isolated fixture.
