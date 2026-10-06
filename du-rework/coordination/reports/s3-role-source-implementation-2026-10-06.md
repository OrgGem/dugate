# IAM S3 source ingestion — direct user request

Owner: codex_arch. Date: 2026-10-06. No AWS provisioning, deployment, commit, push or migration acceptance implied.

| Stage | Status |
|---|---|
| Code | Implemented in canonical source and refreshed Orchestrator candidate |
| Owner verification | 150 tests passed in 6 suites; isolated Node 24 image build and OpenAPI validation pass |
| Independent/live acceptance | OPEN: actual IAM workload role, customer bucket policy and SSE-KMS access were not exercised |

## Contract and identity

Public generic submissions retain `sourceUrl`. New supported shape:

```json
{"input":{"mode":"parse"},"sourceUrl":"s3://customer-documents/invoices/document.pdf"}
```

An optional `?versionId=<encoded-id>` pins a selected source version. URI keys are parsed without URL/filesystem dot-segment normalization. Reserved key characters must be percent-encoded. Bucket listing, arbitrary endpoint/credential/role-ARN query parameters, URI userinfo and unknown deployment-rule properties are rejected. The existing 2048-character submission source budget remains.

The Orchestrator ingestion consumer uses a distinct S3 client per configured source region, with **no explicit credentials**: AWS SDK default Node credential provider chain resolves the workload identity. Source clients do not inherit the internal artifact store's custom endpoint. No presigning is used. This supports same-account IAM permissions and direct cross-account bucket-policy grants to the workload role. Automatic per-request AssumeRole is intentionally absent; an operator can configure a trusted deployment profile/provider for a different identity when required.

`DU_S3_SOURCE_RULES` defines explicit tenant/bucket/prefix/region/expectedBucketOwner rules. Absent rules disable S3 source reads. Empty prefix explicitly grants the whole bucket to that tenant; other prefixes end in `/`. Check at admission and again before acquisition/cache reuse prevents the shared workload role from becoming an API-wide read capability. Request credentials are not used. HTTP `file_url_auth` resolution is bypassed for S3; HTTPS source behavior is unchanged.

## Acquisition and integration

1. Admission rejects non-S3 artifact storage (422 UNSUPPORTED_STORAGE_BACKEND), malformed S3 URI (422 INVALID_SCHEMA) or unauthorized tenant source (403 PERMISSION_DENIED).
2. Existing durable PENDING_INGESTION row and ownership-fenced consumer are retained.
3. HeadObject uses ExpectedBucketOwner and optional caller version. GetObject uses the observed/selected VersionId and ETag/IfMatch; an unversioned source requires an ETag. Response identity and measured size are checked. Source versioning is optional; destination private storage must retain its existing immutable-version guarantee.
4. Download streams to a task-isolated file with byte cap, whole timeout, idle timeout and SHA-256 measurement. Failure destroys the body and removes only the partial file created by this attempt. SDK errors are mapped without copying AWS messages/object paths/secrets into failure detail.
5. A trusted SDK `SourceIngestorOptions.acquireFile` adapter reuses existing verified-private-storage upload, deterministic tenant/operation storage key, receipt/artifact materialization and READY gate. Business workers see the same private artifact contract. No worker source-account IAM rights or platform DB access are introduced.
6. Source clients are destroyed on Orchestrator close, alongside the existing internal storage client.

## Changed paths

- New `services/orchestrator/src/modules/operations/s3-source.ts`: rule parser, S3 URI parser, tenant authorization, HEAD/GET streaming adapter.
- `modules/operations/submission.ts`, `ingestion-consumer.ts`, `app/bootstrap/create-app.ts`, `main.ts`, `server.ts`: admission/config/composition and consumer integration.
- `packages/worker-sdk/src/source-ingestion.ts`: trusted acquisition adapter seam, default HTTPS acquisition unchanged.
- `packages/contracts/src/operations.ts`: sourceUrl description; wire envelope unchanged.
- `services/orchestrator/package.json` / canonical pnpm lock: declare the new module's direct zod dependency using the existing resolved version. No new SDK repository or STS package.
- `compose/orchestrator.yml`, `.env.docker.example`: trusted rule environment configuration; no credentials or host-port publication added.
- `docs/s3-role-source-ingestion.md`, `docs/06-public-api.md`: request/deployment/IAM/cross-account guide.
- `tools/openapi/gen_openapi.py` and generated `docs/21-openapi.json`: request documentation/S3 example and admission errors. Generator run, no hand-edit of generated JSON.
- `scripts/export-orchestrator-candidate.cjs`: include generated OpenAPI required by the concurrently updated canonical Dockerfile. Candidate refreshed without worker source or host dependencies.
- Master migration plan records this direct feature packet and remaining verification gate.

## Verification

Commands used isolated portable Node **24.21.0**, pnpm **10.18.3**.

| Check | Result / exit | Receipt in coordination/reports |
|---|---|---|
| S3 policy/HEAD/GET tests + HTTPS ingestion admission/consumer regressions | 4 suites, 66 passed, exit 0 | s3-role-ingestion-tests-2026-10-06.log + .exit.txt |
| SDK source acquisition/ingestion regression | 2 suites, 84 passed, exit 0 | s3-role-sdk-regression-2026-10-06.log + .exit.txt |
| Candidate Backend/Portal production image | exit 0, Node 24.21.0 | s3-role-image-build-2026-10-06.log + .exit.txt |
| Generated OpenAPI + example validation | both exit 0 | canonical generator and validator output; 54 paths retained |
| Candidate isolation | zero outside relative imports / worker sibling imports; no businesses directory | verify-isolation.cjs output |
| Scoped git diff --check | exit 0 | owner command |

S3 tests verify tenant/prefix isolation, malformed URI/forbidden overrides, strict config, selected/observed versions, unversioned ETag reads, owner guard, early/mid-stream byte limits, short read/hash/version mismatch, timeout/idle cancellation, admission before DB writes and a mocked end-to-end consumer transition through immutable artifact to READY without HTTP auth/fetch. Boundary SDK/database/storage are mocked; these are not live AWS receipts.

Final image `du-s3-role-orchestrator:20261006`:
`sha256:3de886a2c801121b3cb8619d6599f858034ca139a5f580eb90878fe5518953c2`.
Trivy image vulnerability scan against the cached 2026-10-06 DB: **0 High / 0 Critical**, exit 0 (`s3-role-image-scan-2026-10-06.json` and exit receipt). This is image/database-scoped evidence, not proof of all application security or resolution of the previous patched-braces/full-audit gate.

## Handoff / deployment prerequisites

Antigravity retains fleet dispatch authority. Bind independent backend/security review and live AWS verification using a dedicated test tenant/prefix. Configure the actual tenant ID, bucket owner account, region and prefix; attach the workload role to Orchestrator and grant source read plus existing private-destination storage permissions. Cross-account access requires both identity and bucket-policy permission; SSE-KMS also needs applicable decrypt permission/key policy. Operator role credentials must be available inside the workload; local Docker without a credential provider cannot read AWS by configuration alone. No source bucket IAM policy was modified in this task.
