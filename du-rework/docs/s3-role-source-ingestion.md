# S3 object sources using a workload IAM role

The generic public submission API accepts a non-presigned S3 URI:

```http
POST /api/v1/businesses/document-core/actions/ingest
X-API-Key: <tenant API key>
Idempotency-Key: <unique key>
Content-Type: application/json
```

```json
{
  "input": { "mode": "parse" },
  "sourceUrl": "s3://customer-documents/invoices/document.pdf"
}
```

An optional `?versionId=<percent-encoded-version-id>` selects a particular
source version. Percent-encode literal `?`, `#`, `%` or other reserved key
characters. Keys retain their S3 identity, including literal `..` segments;
they are never converted into filesystem paths. The existing 2048-character
sourceUrl budget remains. No bucket listing, folder expansion, credentials,
endpoint or role ARN is accepted from the request.

## Deployment configuration

The **Orchestrator ingestion consumer** reads the source; Connector and business
workers do not need permission to read the customer's source bucket. Enable
S3 artifact storage as before (`ARTIFACT_STORAGE_BACKEND=s3` and its artifact
bucket/region configuration). The internal destination artifact bucket must
support immutable versions. The source bucket may be unversioned.

Set an explicit per-tenant allowlist in trusted deployment configuration:

```json
[
  {
    "tenantId": "60000000-0000-4000-8000-000000000001",
    "bucket": "customer-documents",
    "prefix": "invoices/",
    "region": "ap-southeast-1",
    "expectedBucketOwner": "123456789012"
  }
]
```

Assign this JSON to `DU_S3_SOURCE_RULES`. Missing/empty rules disable S3 sources.
Each prefix is either empty (explicit access to the entire bucket for that
tenant) or ends in `/`. A bucket-level IAM grant alone does not authorize
another tenant's API request. Rules are checked at admission and again at
acquisition. Restart the service after configuration changes; queued work is
checked against the active rules and is denied if permission was withdrawn.

Source S3 clients use AWS SDK v3's **default Node credential provider chain**;
no access key is required in code or the submission. Attach an EC2 instance
role, ECS task role, or EKS workload identity to the Orchestrator deployment.
Role credentials are temporary and resolved by the SDK. If deployment
environment/shared credentials supply static credentials, those may take
precedence; leave them unset when intending to use the workload role. ECS/EKS
identity environment/token mounts must actually be available inside the
container; Compose does not provision an AWS role or create bucket policies.
[AWS credential chain documentation](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html).

## Same-account and cross-account permissions

Grant the Orchestrator workload role read permission on the allowed source
objects, for example:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObject", "s3:GetObjectVersion"],
    "Resource": "arn:aws:s3:::customer-documents/invoices/*"
  }]
}
```

HEAD/GET are used, not ListBucket. For cross-account access, the source bucket
policy must also allow that workload role principal and its identity policy
must allow the read. If objects use SSE-KMS, authorize `kms:Decrypt` on the key
and its applicable key policy/grant as well. Preserve the separate existing
permissions needed to write/version/read the internal artifact bucket.
[AWS cross-account policy guidance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/example-walkthroughs-managing-access-example2.html).

This implementation directly uses the resolved workload identity. It does not
accept per-request AssumeRole parameters or automatically assume arbitrary
customer roles. Where AssumeRole is required instead of a bucket-policy grant,
configure a trusted deployment credential profile/provider before startup.

## Integrity, state and errors

The consumer HEADs the source with `ExpectedBucketOwner`; it GETs the selected
or observed VersionId and guards with ETag/IfMatch. Unversioned sources require
an ETag. A changed identity fails rather than substituting different bytes.
Streaming applies the byte cap (default 64 MiB), whole-request timeout
(default 60 seconds), idle timeout (default 10 seconds), size verification and
SHA-256 measurement. Failed partial downloads are removed. The verified bytes
are then copied into tenant/operation-scoped private versioned storage. The
existing materialization and ownership fences open READY only after its pinned
destination receipt is committed. Workers consume that private artifact.

- Invalid S3 URI: admission **422 INVALID_SCHEMA**.
- No tenant/bucket/prefix rule: admission **403 PERMISSION_DENIED**.
- Non-S3 artifact backend: admission **422 UNSUPPORTED_STORAGE_BACKEND**.
- AWS read denied, missing object, changed identity, byte/time limits: async
  operation failure/retry according to the existing ingestion policy; HTTP 202
  admission does not promise AWS access will succeed.

HTTPS URL/presigned-URL behavior remains unchanged, including pinned egress and
HTTP source authentication. S3 reads bypass HTTP file_url_auth resolution and
use the workload IAM identity. Source bucket account, region and prefix are
deployment policy; the public API cannot change the S3 client's endpoint.

Owner verification uses mocked SDK/database/storage boundaries; live AWS role,
cross-account bucket policy and SSE-KMS verification require the deployment's
actual account and permissions. No real AWS request is implied by these tests.
