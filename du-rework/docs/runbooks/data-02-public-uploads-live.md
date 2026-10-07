# DATA-02 / DATA-03: live public upload and URL-ingestion pilot

## Purpose and safety boundary

This runbook prepares and de-risks the two live legs that keep `G-DATA` open:
the **public** multipart branch `POST /api/v1/uploads` (init -> binary part PUT ->
complete -> submit) and the **DATA-03** worker leg (bounded URL acquisition ->
private S3 immutable version -> `READY` -> outbox). Both legs currently have
offline evidence only.

- Run it **only** inside one claimed exclusive DB/S3 window (one Tester owns it),
  with `DU_LIVE_INFRA=1`, per `du-rework/AGENTS.md`. Implementation lanes prepare
  and review; they do not open the window.
- Suites write only suite-owned tenants, api keys, businesses, operations, tasks
  and artifacts. Never migrate, truncate, `FLUSHDB`, or reuse production buckets.
- No product source edit is part of this procedure. A red step is evidence, not a
  thing to patch mid-window.
- Do not paste credentials, presigned URLs, or object bytes into tickets or logs;
  record variable **names** and sanitized results only.

## Why the previous live attempt went red (root cause, verified against source)

Tester receipt `T-DATA-LIVE-3R` (`coordination/reports/tester.md:7249`) reported
three multipart-init calls answered **HTTP 503** plus **`InvalidAccessKeyId`** from
the `afterAll` `ListObjectVersions`, with a readiness probe that had returned 200.
`T-DATA-LIVE-4` (`coordination/reports/tester-antigravity.md:98`) then ran the same
suite green 5/5 twice on the same endpoint and bucket after extracting the pilot
root credentials, and attributed the red to a credential set that did not match.
Source confirms the mechanism, and adds a diagnostic trap worth knowing:

1. The Orchestrator builds its S3 client **without explicit credentials**
   (`orchestrator/services/orchestrator/src/server.ts:261-266`), so identity comes from the AWS
   SDK default provider chain - in practice `AWS_ACCESS_KEY_ID` /
   `AWS_SECRET_ACCESS_KEY` in the process environment. A key pair that is present
   but does not belong to **this** MinIO instance is therefore accepted silently at
   boot and fails only on the first S3 call.
2. Every storage fault is collapsed into one code. The S3 facade wraps
   `CreateMultipartUpload` (and its siblings) in a bare `catch` that throws
   `ArtifactStorageError('STORAGE_UNAVAILABLE')`
   (`orchestrator/services/orchestrator/src/modules/artifacts/s3-storage-facade.ts:426-429`), and
   the HTTP layer maps that to **503 `TEMPORARY_UNAVAILABLE`**
   (`orchestrator/services/orchestrator/src/http/errors.ts:61-62`). The underlying S3 error name
   is dropped.
3. Consequence: **503 at multipart init in this stack is not an outage signal.** It
   is the same answer you get from `InvalidAccessKeyId`, `AccessDenied`,
   `NoSuchBucket`, a dead endpoint, or a real transient fault. Do not chase the
   MinIO process health first - verify the credential identity first (preflight step 4
   below), because it costs seconds and the app-side signal cannot distinguish them.
4. Second trap: the pilot MinIO is **not** described in
   `du-rework/infra/docker-compose.yml` (that file has PostgreSQL `:5433`, Redis
   `:6380` and an opt-in connector profile only). Endpoint, root credentials and
   bucket are hand-assembled per window, so "it worked for another Tester" is not a
   precondition. Record the bring-up in the window receipt (image/tag, published port,
   where the root credentials came from).
5. Bucket naming: the live pilot bucket is `du-artifacts-live2` and the offline
   fixture bucket is `du-artifacts-test`
   (`orchestrator/services/orchestrator/tests/s3-multipart-storage-offline.test.ts:23`).
   `du-uploads` is **not** a bucket anywhere in `du-rework`; the only occurrence is
   the namespace salt inside the public replay-key derivation
   (`modules/artifacts/multipart-service.ts:86`, `'du-uploads|' + tenantId + '|' +
   idempotencyKey`). Do not create a bucket named `du-uploads` for these tests.

## Environment matrix

Read from source, not assumed. Names only; never commit values.

| Variable | Read by | Notes |
|---|---|---|
| `DATABASE_URL` | `createApp`, migration CLI | pilot: `127.0.0.1:5433/du_orchestrator_test` |
| `REDIS_URL` | `createApp` | pilot: `127.0.0.1:6380` |
| `DU_LIVE_INFRA` | live suites | must be exactly `1`; otherwise the suite self-skips |
| `ARTIFACT_S3_ENDPOINT` | suite default `http://127.0.0.1:9003`; deployed process via `main.ts:86` | custom endpoint implies path style |
| `ARTIFACT_S3_BUCKET` | suite default `du-artifacts-live2`; `main.ts:84` requires it when backend is `s3` | private, versioning enabled |
| `ARTIFACT_S3_REGION` | `main.ts:85` | the suite pins `us-east-1` itself |
| `ARTIFACT_S3_FORCE_PATH_STYLE` | `main.ts:87`; `server.ts:264` defaults it to `true` whenever an endpoint is set | set explicitly anyway |
| `ARTIFACT_STORAGE_BACKEND` | deployed process only (`main.ts:75`, default `postgres`) | the live suite passes `artifactStorage` in code instead |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | AWS SDK default chain (both the app client and the suite client) | the suite refuses to run without them (`tests/data-02-04-live-s3.test.ts:239`) |

## Preflight (do all of it before spending the window)

1. Claim the window and confirm it is empty; note the claim timestamp.
2. Bring up the storage endpoint and record how credentials were obtained.
   Readiness alone is not credential validity - `/minio/health/ready` answers 200
   for a bucket you cannot access.
3. Confirm the schema, including the two multipart-relevant migrations:

   ```powershell
   pnpm --filter @du/orchestrator run migrate:status
   pnpm --filter @du/orchestrator run migrate:verify
   ```

   Expect `0015_artifact_multipart.sql` and `0016_public_upload_token_index.sql`
   both applied. `0015` is asserted in-suite; `0016` blocked `T-DATA-LIVE-2` earlier
   and is required by the public replay path.
4. **Verify the identity before booting the app**, with a direct call the app never
   mediates, so the answer is the raw S3 error name rather than a masked 503:

   ```powershell
   aws --endpoint-url=$env:ARTIFACT_S3_ENDPOINT s3api list-objects-v2 --bucket $env:ARTIFACT_S3_BUCKET --max-items 1
   ```

   Expect exit 0. `InvalidAccessKeyId` / `AccessDenied` / `NoSuchBucket` here is the
   whole explanation for a later 503, and costs seconds instead of a window.
   Record only the error code, never the key id.
5. Confirm the bucket is private and versioned (anonymous GET must be refused):
   the green pilot logged `privateAnonymousGet=403`.
6. Confirm no stale S3 keys leak from the shell profile. `AWS_PROFILE` or a
   `~/.aws/credentials` entry is silent until the first call; prefer an explicit
   `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` pair in the window shell and unset
   `AWS_PROFILE`.

## Scenario A - public multipart lifecycle `/api/v1/uploads`

Routes are JSON-only and tenant-scoped by `x-api-key`
(`orchestrator/services/orchestrator/src/server.ts:899-924`); the replay key is the body
`uploadToken`, or a per-tenant derivation of the `Idempotency-Key` header
(`multipart-service.ts:82-92`). Public `complete` **is** the verified
`STAGING -> READY` edge for this branch.

| # | Step | Expected |
|---|---|---|
| A1 | `POST /api/v1/uploads` with `x-api-key`, `uploadToken`, `purpose`, `mimeType`, `fileName`, `sizeBytes` >= 64 MiB + 1 | `201`, ack with `artifactId`, `partSizeBytes`, `partCount`, expiry; row in `STAGING` |
| A2 | Same init again with the same `uploadToken` | `200` replay, identical ack (no second row) |
| A3 | Same init, `Idempotency-Key` header instead of body token | accepted; second replay form proven |
| A4 | `POST /api/v1/uploads/:id/part` per part | `200` with absolute `partUrl` + `requiredHeaders` |
| A5 | `PUT` raw bytes to each `partUrl` (streamed, never a whole-file buffer) | storage `200` + `etag` |
| A6 | `POST /api/v1/.../complete` with the receipt list + whole-object `sha256` | `200`; row `READY`; bytes re-verified server-side |
| A7 | Repeat A6 after the response was lost (same token) | same result, `replayed: true`, no second finalize |
| A8 | `POST /api/v1/businesses/:id/actions/ingest` naming the artifact **before** A6 | `409 STATE_CONFLICT` (STAGING never submits) |
| A9 | Same submit after A6 | `202` accepted |
| A10 | Foreign tenant (tenant B key) complete/get/abort on tenant A artifact | `404`, no existence leak |
| A11 | Abort a fresh STAGING session | `200`, provider upload cleared |
| A12 | Expire a session (short TTL) and run the sweep hook | `scanned>=1 aborted>=1 purged>=1 failed=0`, `multipart_upload_id` cleared |
| A13 | Submit with an expired READY row | `404 NOT_FOUND` |
| A14 | RSS sample during A5 (peak minus baseline, sampled in the data path) | record the number; a whole-file retention shows a delta ~= object size |
| A15 | `init` with `sizeBytes` between 1 MiB and 64 MiB | **`422` today** - the public contract floor is `64 MiB + 1` (`orchestrator/packages/contracts/src/runtime.ts:255,274`) and no public binary route exists; this is the open T20-D1 decision, not a passing case |

Note for A15: the only route that accepts a binary request body is the runtime
blob PUT `PUT /api/runtime/v1/artifacts/blob/:key` (`server.ts:415-420`,
`binary: isBlobPut`), which is grant- and worker-scoped, not public. So a public
client still cannot deliver a 1 MiB - 64 MiB object. The SDK-side band policy
`resolveArtifactUploadBand` exists (`orchestrator/packages/worker-sdk/src/artifact-streams.ts`)
and pins the numbers; the server half needs its own packet.

## Scenario B - DATA-03 worker ingestion to S3 and `READY`

| # | Step | Expected |
|---|---|---|
| B1 | Public submit naming an HTTPS source URL | `202` + an ingestion task; the business task must not be claimable yet |
| B2 | Worker claims the ingestion task and calls `acquireSourceUrl` (pinned egress by default) | bytes land in a temp workspace, streamed, bounded by byte/idle/deadline budgets |
| B3 | Private-IP / loopback / metadata / rebinding / oversized / slow-stream URLs | refused before connect or mid-stream, typed `DESTINATION_DENIED` / `TOO_LARGE` / `TIMEOUT` / `IDLE_TIMEOUT`, **no** partial file left behind |
| B4 | Publish acquired bytes to private S3, finalize | pinned immutable version + SHA-256 recorded; source artifact becomes `READY` |
| B5 | Business task submit gate | admits only after the source is `READY`; a failed acquisition never creates `READY` |
| B6 | Kill the worker between B2 and B4, then retry | same SHA-256 and same committed version on retry; no orphan committed ref; outbox entry present exactly once |
| B7 | Change the source content or take it offline after B4 | retry still resolves to the pinned bytes, not the live URL |

## Evidence to record for each window

Per `du-rework/AGENTS.md` receipt rules: task/test IDs, exact command **and cwd**,
commit or build digest, timestamp, environment (variable names, endpoint host, bucket
name - never secret values), passed/failed/skipped counts, the **literal** exit code
from the wrapper, and the raw log path. Red steps stay quoted verbatim; a skipped
case is never written as a pass, and an older green does not override a newer red.

## What this runbook does not certify

- It is preparation. No scenario here is `ACCEPTED` until a Tester window produces the
  green receipt above, and DATA-02 / DATA-03 / DATA-04 / `G-DATA` stay open until then.
- A green Scenario A does not close DATA-04 (the 1 MiB - 64 MiB public route and the
  business parse budget are separate decisions), and a green Scenario B does not close
  DATA-03's server-side admission slice.
- Reading pilot root credentials out of a container (`docker inspect`) is a permitted
  test-harness shortcut, not an acceptable deployment credential path; the deployment
  owner still owes a least-privilege identity for the Orchestrator.
