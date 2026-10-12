# Workflow private HTTPS runbook

## Configure an operator-approved private origin

`WORKFLOW_PRIVATE_HTTPS_ORIGINS` is a deployment setting for the document-core Worker. Leaving it unset or empty keeps private destinations denied. When an internal HTTPS service must be called by an admitted workflow, configure a comma-separated list of exact canonical origins, for example:

```sh
WORKFLOW_PRIVATE_HTTPS_ORIGINS=https://capture.internal.example,https://10.24.8.16:9443
```

Each entry is one HTTPS origin with an optional explicit port. Do not include a trailing slash, path, query, fragment, user information, wildcard, CIDR, or whitespace. The Worker rejects malformed, duplicate, noncanonical, or oversized lists during startup. The list is limited to 64 origins, 8,192 bytes total, and 2,048 bytes per origin. Worker startup logs include a SHA-256 policy digest; they do not include the configured hostnames.

Private access requires both approvals for the same origin:

1. The immutable tenant workflow schema pin must list the origin in its approved egress origins.
2. The Worker deployment must list that exact origin in `WORKFLOW_PRIVATE_HTTPS_ORIGINS`.

Neither approval grants the other. A workflow author cannot opt in through task data or a workflow edit. An origin omitted from the tenant schema is rejected before a request starts. If the schema approves an origin but deployment policy omits it, the request uses the normal public-only egress policy.

## Runtime behavior

Schema-workflow callbacks and file URL downloads use the same worker-owned policy on the root task, parallel branches, retries, and resumed human-input continuations. Query authentication changes query parameters only; it cannot change the origin selected by the immutable schema pin. Redirects remain disabled.

The Worker delegates every request to `@du/egress`. Its DNS adjudication, pinned socket address, original-host TLS validation and SNI, trusted CA checks, reserved and metadata address denials, redirect refusal, request timeout, body limits, and cancellation checks remain in force. Private-origin approval does not allow metadata, link-local, carrier-grade NAT, multicast, unspecified, or other reserved destinations. Keep the service certificate valid for the configured hostname and trust its CA through the deployment's normal Node trust configuration. Never disable certificate verification or replace the pinned fetch transport.

When tightening deployment policy, remove an origin from the Worker list and roll out the new configuration. Existing immutable workflow pins are not rewritten; requests to origins no longer deployed as private-approved fail under the normal egress policy. Record the policy digest with deployment evidence when investigating such a denial.

## Tenant defaults in document actions

The worker consumes only the immutable tenant-default snapshot delivered with the admitted operation. It validates the snapshot schema and content digest before forwarding it into the local task context. It does not read current settings during execution, retries, or continuations. Existing operations without a snapshot keep the old assembled callsite prompt.

Prompt precedence is Code override, pinned Profile exact row, pinned Profile `_default` row, the admitted tenant prompt for the trusted action category, and the assembled connector callsite text. Image, PDF, and DOCX categories require a registered action/step and a homogeneous content-detected format from authorized claim artifacts. Compare and Generate categories require their corresponding registered action/step. Browser or task-supplied category metadata is ignored. Tenant template variables are interpolated from the action's assembled content, including `{file1}` and `{file2}` for Compare and `{user_prompt}` and `{input_content}` for Generate.

Connector and provider identity remain admission-pinned. Local prompt-category metadata is consumed by the Worker and removed before provider options are sent. The SDK applies the pinned model default before computing the invocation hash and grant.

## Verification boundary

Worker unit tests cover configuration parsing, empty defaults, per-worker policy isolation, prompt category selection, precedence, digest rejection, and prompt text observed at the SDK connector adapter. Production release verification also requires a real local TLS service reached through the full admitted workflow, with both approvals enabled, plus negative cases for missing approvals, invalid certificates, redirects, forbidden address classes, and cancellation. Standalone transport tests do not prove the full workflow path.
