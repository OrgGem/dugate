# Runbook: Artifact storage (DATA-01/02)

**Status:** The PostgreSQL and S3 storage facades are implemented. Production
bucket, IAM/KMS, alert delivery, backup/restore, and failover readiness must be
verified per environment before this runbook is used as a live change plan.
See the [G-DATA plan](../../tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md).

## Storage contract

Orchestrator owns artifact metadata and grants. The selected backend and exact
storage generation are persisted per artifact as `storage_backend` and
`storage_version_id`; public and worker artifact references do not expose
bucket keys or storage credentials. Both backends implement
`ArtifactStorageFacade`:

- **S3:** Orchestrator issues a bounded, short-lived presigned upload grant.
  The bucket must have versioning enabled. Finalize validates tenant/artifact
  metadata, reads the exact object version, and verifies byte count and
  SHA-256 before persisting the version ID. Authorized reads use that pinned
  version, never an unversioned “latest” object.
- **PostgreSQL backend:** Uploads pass through the grant-protected Orchestrator
  blob route into `artifact_blobs`. Finalize verifies the stored bytes; the
  content SHA-256 is the immutable generation ID. These bytes consume database
  capacity and are included in the PostgreSQL backup/restore domain.

The packaged process selects its write backend at startup with
`ARTIFACT_STORAGE_BACKEND` (`postgres` by default or `s3`). S3 mode requires
`ARTIFACT_S3_BUCKET`; set `ARTIFACT_S3_REGION`, `ARTIFACT_S3_ENDPOINT`, and
`ARTIFACT_S3_FORCE_PATH_STYLE` only as required by the target. The bucket must
have versioning enabled. In S3 mode, `ARTIFACT_STORAGE_MIGRATION_WINDOW=true`
enables DATA-05 dual-read behavior; when unset, the source also defaults to
dual-read compatibility. Set the flag explicitly to `false` only after the
migration inventory is clear to enable S3-only cutover and fail closed on
unresolved legacy references. A true migration flag requires S3 backend.

This configuration is **not automatic failover**. Artifact reads follow each
row's persisted backend. In S3 mode the PostgreSQL facade remains available for
PostgreSQL-backed rows. In PostgreSQL-only mode the S3 client is not created,
so S3-backed rows cannot be read until S3 mode is restored. Switching to
PostgreSQL does not copy existing objects, rewrite metadata, or make prior S3
artifacts available from the DB.

The standard health endpoint checks dependencies but does not probe artifact
I/O. A green health result is not evidence that S3 grants, uploads, finalize,
or reads work.

## Symptoms and first response

Use this runbook for upload, finalize, or read failures; `STORAGE_UNAVAILABLE`;
an unreadable `READY` artifact; size/hash/version mismatch; prolonged
`STAGING`; or unexpected PostgreSQL blob growth.

1. Record UTC time, environment, release/config revision, operation/task/
   artifact IDs, backend, error code, and correlation ID. Keep signed grant
   URLs, bearer tokens, object keys, filenames, bytes, and credentials out of
   tickets and general logs.
2. Check Orchestrator DB/Redis health, then check the approved S3 status,
   network route, workload identity/IAM, KMS access, bucket versioning, and
   storage request/error metrics separately. Classify `STORAGE_UNAVAILABLE`
   as a service/path failure. Treat version, metadata, size, or checksum errors
   as integrity failures; do not mask those by changing backend.
3. With a read-only DB role, inspect aggregate backend/state counts:

   ```sql
   SELECT storage_backend, state, count(*) AS artifacts,
          min(updated_at) AS oldest_updated_at
   FROM artifacts
   GROUP BY storage_backend, state
   ORDER BY storage_backend, state;
   ```

   For one artifact, inspect only metadata and PostgreSQL blob presence; do not
   return the storage key or bytes:

   ```sql
   SELECT a.id, a.tenant_id, a.operation_id, a.task_id, a.purpose,
          a.state, a.storage_backend, a.storage_version_id,
          a.size_bytes, a.sha256,
          CASE WHEN a.storage_backend = 'postgres' THEN EXISTS (
            SELECT 1 FROM artifact_blobs b WHERE b.storage_key = a.storage_key
          ) ELSE NULL END AS postgres_blob_present
   FROM artifacts a
   WHERE a.id = $1;
   ```

4. Preserve metadata, all S3 object versions, and database backups while the
   incident is open. Do not mark an artifact `READY`, edit hashes/version IDs,
   delete blobs, or clean `STAGING` by age. Check operation/checkpoint refs
   through approved application or operator views before any cleanup request.

## S3 outage and controlled PostgreSQL write mode

### Transient `STORAGE_UNAVAILABLE`

1. First restore the S3 path (network, IAM/KMS, service availability, or
   capacity) through the infrastructure change process. Preserve the current
   S3 configuration and retry through the normal application/task path after
   recovery; do not mint replacement grants or create duplicate artifacts by
   hand.
2. A temporary switch to `artifactStorage.backend = 'postgres'` is available
   only as a **PostgreSQL-only mode for new artifacts**, not transparent
   per-request failover. Before an approved rollout, verify PostgreSQL health,
   free storage/write capacity, backup coverage, and restore point. Identify
   operations that still need S3-backed inputs, outputs, or checkpoints. The
   PostgreSQL-only process cannot read those rows; keep affected submissions
   and workers paused using the normal admission/release controls, or do not
   switch.
3. If the service owner approves this bounded mode, deploy the config change
   through the release controller. Do not change `storage_backend` on existing
   rows or copy objects manually. Run a non-sensitive canary through grant,
   upload, finalize, and authorized read. Confirm the new row says
   `storage_backend='postgres'`, the stored size/SHA-256 match the fixture, and
   the scoped read succeeds. Monitor database capacity/latency and artifact
   errors before admitting the intended workload.
4. If S3-backed artifacts are still required by live work, treat the
   PostgreSQL-only switch as unavailable: hold artifact-dependent work and
   restore S3. The current single-backend startup config does not keep the S3
   facade online while choosing PostgreSQL for new writes.

### Return to S3 after recovery

1. Verify the approved bucket, versioning, identity/IAM and KMS permissions,
   network path, and S3 request metrics. Restore
   `artifactStorage.backend = 's3'` through the release controller.
2. Run a fresh S3 canary through grant, upload, finalize, and authorized read;
   confirm a non-null pinned S3 version, exact size/SHA-256, and tenant
   ownership. Also read a PostgreSQL-backed canary. S3 mode composes both
   facades, so rows written during PostgreSQL-only mode remain PostgreSQL
   backed and should continue to read from `artifact_blobs`.
3. Resume held work gradually. Verify representative referenced artifacts on
   their recorded backends, task progress, error rates, and PostgreSQL capacity
   for one alert window. Keep PostgreSQL-backed rows as-is; no backend rewrite
   is part of recovery.

If the outage involves a missing pinned version, suspended versioning, or
metadata/hash mismatch, stop the failover decision and page Data/Storage. A
backend switch does not repair integrity. Recover the exact generation from
the approved backup/replication source and verify it through the application.
Cross-bucket locator remap is not an operator capability in this snapshot;
keep affected work blocked and escalate to the G-DATA owner.

## PostgreSQL and S3 backup/restore checks

- **PostgreSQL-backed artifacts:** restore `artifacts` metadata and
  `artifact_blobs` from a consistent recovery point. In an isolated restore,
  verify foreign keys/references and sample authorized reads with matching
  size/hash before routing work to the restored service. Confirm the restored
  database has capacity for ongoing blob writes.
- **S3-backed artifacts:** preserve versioning and every referenced
  `storage_version_id`. Restore the matching database metadata and exact S3
  object generations. A database restore without its corresponding object
  versions can leave `READY` rows unreadable. Do not delete extra object
  versions during recovery; first reconcile them with restored metadata.
- **Mixed backend rows:** verify canaries for both backends after restoring S3
  mode. The database is still required for artifact metadata and grants even
  when bytes live in S3.
- **Cleanup:** no production orphan sweeper/restore rehearsal is asserted by
  this document. Age alone is not proof an artifact is unreferenced. Require a
  dry-run, complete operation/checkpoint reference check, audit trail, and
  rehearsed cleanup tool before deleting metadata, PostgreSQL blobs, or S3
  versions.

## Recovery exit criteria

Close only after the approved canary grant/upload/finalize/scoped-read succeeds
for every backend in use; size and SHA-256 match; ownership is enforced;
representative `READY` references are readable from their persisted backend
and generation; PostgreSQL capacity and S3 error rates are stable for one alert
window; and held tasks resume without duplicate effects. Record the config
revision, canary artifact IDs, metadata-only evidence, and backup/restore
decision in the incident/change record.

**References:** `../../services/orchestrator/src/modules/artifacts/storage-facade.ts`,
`../../services/orchestrator/src/modules/artifacts/artifacts.ts`,
`../../services/orchestrator/src/modules/artifacts/s3-storage-facade.ts`,
`../../services/orchestrator/src/modules/artifacts/postgres-storage-facade.ts`,
and migrations `../../services/orchestrator/migrations/0003_artifacts_grants.sql`,
`../../services/orchestrator/migrations/0013_artifact_storage_version.sql`.
