# DATA-05: PostgreSQL artifact blobs to S3

## Purpose and safety boundary

This runbook moves READY artifact bytes from PostgreSQL `artifact_blobs` to the
versioned S3 bucket configured for the Orchestrator. It uses the immutable S3
version pin stored on each `artifacts` row. PostgreSQL blobs stay in place as
rollback copies throughout all four stages.

The migration CLI requires all of the following before it opens PostgreSQL or
S3: S3 storage selected, the dual-read window enabled, a backup confirmation,
an operator rollback sign-off reference, and an explicit migration command
confirmation. It does not connect to Redis. It never drops `artifact_blobs`.

Prerequisites:

- Apply the normal schema migrations, including `0003_artifacts_grants.sql`
  and `0013_artifact_storage_version.sql`; verify the migration ledger first.
- Use a private S3 bucket with versioning enabled and permissions for
  `PutObject`, `HeadObject`, `GetObject`, and exact-version `DeleteObject`.
- Verify a recoverable PostgreSQL backup that includes `artifact_blobs` and
  `artifacts`. Record its backup ID and the rollback approver/ticket.
- Schedule a change window, identify the on-call owner, and confirm the
  Orchestrator deployment can use the S3 credential provider chain.
- Do not start the batch until the backup and rollback sign-off are recorded.

## Stage 1: Dual-read window

1. Configure every Orchestrator instance consistently. Set
   `ARTIFACT_STORAGE_BACKEND=s3`, `ARTIFACT_S3_BUCKET`, and
   `ARTIFACT_STORAGE_MIGRATION_WINDOW=true`. Set `ARTIFACT_S3_REGION` and
   `ARTIFACT_S3_ENDPOINT` only when required by the deployment. Keep the
   PostgreSQL blob table and its backup available.
2. Run the normal schema verification command:

   ```powershell
   pnpm --filter @du/orchestrator migrate:verify
   ```

3. Restart the Orchestrator instances and verify readiness and one newly
   submitted artifact. In this mode, new artifact records and grants use S3.
   READY records still pointing to PostgreSQL are read from S3 first when a
   verified S3 copy is present; a missing S3 object falls back to PostgreSQL.
   Integrity mismatches, authorization failures, and S3 service errors do not
   silently fall back.
4. Confirm legacy upload grants issued before this change have completed or
   expired. Do not treat an unresolved STAGING/EXPIRED PostgreSQL reference as
   migrated.

## Stage 2: Batch migration and SHA-256 verification

The batch processes one READY artifact at a time. It locks the artifact row,
reads its matching tenant-scoped bytea, computes source size and SHA-256, and
compares those values with persisted metadata. It imports bytes using the S3
facade, reads and verifies the exact returned `VersionId`, then commits the S3
backend/version pin. A retry reuses an already imported matching S3 version.
Each PostgreSQL blob remains untouched.

After the backup and rollback sign-off, set these one-shot command variables in
the migration process environment:

```powershell
$env:ARTIFACT_STORAGE_BACKEND = 's3'
$env:ARTIFACT_STORAGE_MIGRATION_WINDOW = 'true'
$env:ARTIFACT_S3_BUCKET = '<private-versioned-bucket>'
$env:ARTIFACT_BLOB_BACKUP_VERIFIED = 'true'
$env:ARTIFACT_BLOB_ROLLBACK_SIGNOFF = '<change-ticket-or-approver-reference>'
$env:ARTIFACT_BLOB_MIGRATION_CONFIRM = 'YES'
pnpm --filter @du/orchestrator migrate:artifact-blobs
```

The command builds the Orchestrator, connects only to PostgreSQL and S3, emits
one JSON summary, and exits `0` only when the inventory has no unresolved
references. Exit `2` means the run completed but still has blockers; exit `1`
means a safe startup/processing guard failed. Error output uses stable codes
and does not include provider exception text, credentials, or URLs.

Read the summary counters:

- `eligibleReadyArtifacts`: tenant-matched READY PostgreSQL artifacts available
  for backfill. `migratedArtifacts` should cover these over the run.
- `legacyArtifactReferences`: any non-DELETED artifact still using PostgreSQL,
  including missing blobs and unfinished rows.
- `orphanBlobRows`: bytea rows with no matching artifact and tenant.
- `readyS3ArtifactsWithoutVersion`: READY S3 artifacts missing an immutable
  version pin.
- `unresolvedReferences`: the sum of those three blocker classes. Completion
  requires this value to be zero and `failedArtifacts` to be zero. A nonzero
  `legacyBlobRows` count is expected because migrated rows are retained as
  rollback copies.

If the process stops or reports `incomplete`, leave the dual-read window on,
review the stable issue codes, repair the underlying source/permission/data
problem, and rerun the same command. The backfill is idempotent. Do not delete
or rewrite a PostgreSQL source blob to clear a blocker.

## Stage 3: Final cutover to S3-only

Proceed only after a completed migration summary shows:

- `unresolvedReferences: 0` and `failedArtifacts: 0`;
- `legacyArtifactReferences: 0`, `orphanBlobRows: 0`, and
  `readyS3ArtifactsWithoutVersion: 0`;
- a verified PostgreSQL backup and rollback sign-off remain available.

1. Keep `ARTIFACT_STORAGE_BACKEND=s3` and set
   `ARTIFACT_STORAGE_MIGRATION_WINDOW=false` on every instance. Restart the
   service so no instance remains in dual-read mode.
2. The service now treats missing S3 data as a storage conflict and never reads
   the PostgreSQL fallback. New grants and writes continue to use S3.
3. Run a controlled smoke check against a known migrated artifact and a newly
   written artifact. Confirm the artifact state is READY, its `storageVersionId`
   is populated, and returned bytes match the expected size and SHA-256.
4. Monitor stable storage error codes, 409 `STATE_CONFLICT` responses, S3
   availability, and the unresolved-reference inventory during the change
   window. If a legacy PostgreSQL reference is discovered, restore
   `ARTIFACT_STORAGE_MIGRATION_WINDOW=true`, investigate, and rerun inventory.
5. Keep `artifact_blobs`, its backup, and versioned S3 objects. This task does
   not authorize table deletion or backup expiry.

## Stage 4: Safe rollback procedure

### Application rollback while S3 is healthy

1. Pause the cutover rollout and record the active deployment version and
   incident/change reference. Keep `ARTIFACT_STORAGE_BACKEND=s3` so artifacts
   created after migration remain readable.
2. Roll back the application release and set
   `ARTIFACT_STORAGE_MIGRATION_WINDOW=true`. This restores dual-read behavior:
   S3 remains preferred and retained PostgreSQL blobs can serve migrated legacy
   artifacts whose S3 object is absent.
3. Verify reads of a migrated legacy artifact and of an artifact created after
   migration before resuming traffic. Do not remove S3 configuration; newer
   artifacts may exist only in S3.

### Full storage rollback to PostgreSQL

Do not switch `ARTIFACT_STORAGE_BACKEND=postgres` while any active artifact
exists only in S3. New artifacts created during the migration/cutover window
are intentionally written only to S3 and have no automatic PostgreSQL copy.
The retained `artifact_blobs` rows are a rollback source for the legacy set,
not a complete backup of all later writes.

Before a PostgreSQL-only rollback, pause artifact submissions and complete a
separately reviewed S3-to-PostgreSQL reverse copy for every active S3-only
artifact. Verify tenant, size, and SHA-256 against the pinned S3 version, and
obtain backup/rollback sign-off. If the S3 service itself is unavailable,
restore S3 access or its versioned replica first; do not claim a PostgreSQL-only
rollback is complete until the reverse-copy inventory is zero. Never delete S3
versions or drop `artifact_blobs` as part of an emergency rollback.

## Offline cutover test harness

The offline regression case in
`services/orchestrator/tests/artifact-storage-service.test.ts` configures
`migrationWindow: false`, verifies new upload grants select S3, and proves an
unresolved legacy row fails closed without reading `artifact_blobs`. Run it
without a database window:

```powershell
pnpm --filter @du/orchestrator test -- --runTestsByPath tests/artifact-storage-service.test.ts
```

Related full migration inventory/hash/retry coverage is in
`services/orchestrator/tests/storage-migration.test.ts` and the S3 adapter
contract coverage is in `services/orchestrator/tests/s3-storage-facade.test.ts`.
