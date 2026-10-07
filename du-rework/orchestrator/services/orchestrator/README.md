# Orchestrator

Durable public and runtime API for the DUGate rework. The current vertical
slice covers submission, transactional outbox dispatch, task leases and
checkpoints, completion/result retrieval, and Connector usage ingestion.

## Development

From `du-rework/`, install/build the pnpm workspace first. The integration
suite requires isolated PostgreSQL and Redis plus an approved test-DB window:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @du/orchestrator test:unit
docker compose -f infra/docker-compose.yml up -d postgres redis
pnpm --filter @du/orchestrator test
```

Defaults used by the suite are PostgreSQL
`postgresql://du:du-test-only@localhost:5433/du_orchestrator_test` and Redis
`redis://localhost:6380`. Override them with `DATABASE_URL` and `REDIS_URL`,
but never use the legacy DUGate or production DB. For standalone startup,
migration order, Docker limitations, and Public API examples, see the
[root README](../../README.md).

## Server configuration

`createApp` accepts `port`, `databaseUrl`, `redisUrl`, and these optional
settings:

- `runtimeToken`: worker/runtime bearer credential. Runtime endpoints are open
  for development when it is omitted.
- `workerIdentityTokensByBusiness`: maps each business ID to its worker bearer;
  the platform `runtimeToken` does not establish a worker's business identity.
  The standalone entrypoint reads this map from
  `WORKER_IDENTITY_TOKENS_BY_BUSINESS` as a JSON object. Worker tokens must be
  non-empty, unique, and distinct from platform credentials; malformed config
  fails boot without logging the supplied values.
- `usageToken`: dedicated Connector bearer credential for usage ingestion.
  Ingestion is disabled when it is omitted; the runtime token is not accepted.
- `autoDispatch`: starts the outbox sweeper unless explicitly set to `false`.
- `artifactStorage`: defaults to PostgreSQL bytea storage. The standalone
  process reads `ARTIFACT_STORAGE_BACKEND=postgres|s3`; S3 also requires
  `ARTIFACT_S3_BUCKET` and accepts `ARTIFACT_S3_REGION`, `ARTIFACT_S3_ENDPOINT`,
  and `ARTIFACT_S3_FORCE_PATH_STYLE=true|false`. Set
  `ARTIFACT_STORAGE_MIGRATION_WINDOW=true` with S3 enabled to force new artifact
  writes to S3 while READY reads try S3 first and fall back to the retained
  PostgreSQL copy only when the S3 object is absent.
- Multipart artifact upload (`DATA-02`) is available only with the S3 backend:
  a PostgreSQL-only deployment answers 409 `MULTIPART_NOT_AVAILABLE` rather than
  routing the bytes somewhere else. Geometry, ceilings and TTLs default to the
  `MULTIPART_*` wire bounds exported by `@du/contracts` and can only be narrowed
  through `multipartLimits`. The §6 policy was signed 2026-09-25, so the
  standalone process now reads `MULTIPART_PART_SIZE_BYTES`,
  `MULTIPART_MAX_TOTAL_BYTES`, `MULTIPART_SESSION_TTL_MS` and
  `MULTIPART_PART_URL_TTL_MS` (positive integers; values above the wire bound
  clamp to it, unparseable values fail boot). One part is capped at **64 MiB**
  by the signed policy even though S3 admits 5 GiB: the producer buffers exactly
  one part while hashing it, and the worker SDK refuses a larger geometry, so a
  higher ceiling would mint sessions no peer can fill.
- Client source uploads use the public branch (`POST /api/v1/uploads`, then
  `PUT /api/v1/uploads/{id}/content`, with `x-api-key` + tenant fencing) when
  the encrypted public upload gateway is configured. The response includes
  the upload URL; a direct public `/{id}/part` call is rejected. A PostgreSQL-
  only deployment without the gateway cannot serve this path. See the
  [current Public API guidance](../../README.md#tích-hợp-qua-public-api).
DATA-05 migration code is exported from the Orchestrator package. Run it only
after migrations `0003` and `0013` have been applied and the S3 versioned bucket
is ready. Its completion report counts legacy references, missing blobs,
orphaned blobs, and READY S3 rows without a version. It retains
`artifact_blobs` as the rollback copy; table deletion is intentionally outside
the migration module and requires separate backup and rollback sign-off.

## Usage ingestion

`POST /api/runtime/v1/usage-events` accepts either the frozen
`UsageEventSchema` object emitted by Connector's HTTP usage sink or a frozen
`UsageIngestBatchSchema` envelope containing 1–500 events. It returns
`UsageIngestAckSchema`: `{ accepted: string[], duplicates: string[] }`.

Events are append-only and durable in PostgreSQL. `eventId` is the idempotency
key: an identical replay is reported as a duplicate and a different payload
with the same ID returns `409 IDEMPOTENCY_CONFLICT`. Every task must belong to
the supplied operation, and a rejected batch rolls back atomically. Terminal
task state intentionally does not block ingestion because provider usage may
arrive after completion.

`GET /api/v1/operations/{id}/result` projects stored token and micro-USD totals.
No events produces `measurement: 'pending'`; all-measured events produce
`'measured'`; any estimated event makes the aggregate `'estimated'`.

## Current limits

The repository is not release-ready. Do not infer deployment or encryption
acceptance from an individual route or offline suite. See the current
[task board and release gates](../../../tasks/README.md) and the
[API compatibility plan](../../../tasks/API-COMPAT-DUGATE-2026-09-28.md);
legacy `/api/v1/docs/{action}` facade routes are not yet implemented.
