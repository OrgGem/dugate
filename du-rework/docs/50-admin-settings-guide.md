# Admin Settings guide

This guide describes the current typed Settings controls at `/settings`. Settings uses same-origin Admin API requests and the signed-in session. Drafts and changes are revisioned; the page reads the server's saved/effective state after mutations. An acknowledgement that is uncertain must be rechecked with the same idempotency key before another change is submitted.

## Tenant AI defaults and provider tests

Select an organization and use **Tenant AI defaults** to choose a supported provider (`gemini` or `openai-compatible`), model, and exact active Connector revision. Save a draft, review the revision diff, run a provider test, then publish only after the server returns durable provider-response and usage evidence. A test uses the API key and endpoint selected in the scoped configuration editor, its current effective Profile revision, a real active `document-core` version, and up to four files uploaded through the tenant artifact route. Optional action parameters use text, number, or boolean values; the form rejects duplicate, malformed, credential-like, authorization, and URL parameter names. A provider test is an upstream call with ordinary tenant, key, Profile, and budget admission, not a readiness check.

Provider base URLs and write-only credentials belong to Connector recipes and the managed Secret Catalog. Settings selects an immutable Connector reference and never reads credential values. Connector labels and endpoint display are masked to remove URL user information, query strings, and fragments.

The AI picker uses a protected tenant-scoped active Connector catalog with server-side search and cursor continuation. A platform Admin must select the tenant; a tenant operator's session supplies its own tenant and cannot widen the query. The selector displays safe provider/model metadata, exact revision, credential-configured status and update time. It does not expose endpoint configuration, credential references or secret material. Provider changes, tenant changes and search edits clear the previous Connector pin. Only the exact active revision compatible with the chosen provider can be selected; the BFF and Connector service must remain available for the picker to load.

The accepted Tenant Defaults snapshot is resolved at operation admission, sealed against the operation ID, opened by the Orchestrator runtime, and exposed on the Worker SDK task context with revision and digest metadata. The current source tree does not show a downstream worker selecting any of the five individual prompt fields or the AI provider/model values. Treat snapshot pinning as implemented; actual slot-specific runtime use still requires an independent consumer trace and behavioral test.

## Five prompt defaults

The prompt editor exposes five separate slots. Choosing English or Vietnamese copies that exact server preset into the local form; it does not save anything. Review the diff, save a draft, and publish the draft to affect defaults resolved for new requests. Existing operations retain their admission-time snapshot. Profile and code overrides may take precedence.

| Slot | Use | Required placeholder validation |
| --- | --- | --- |
| Image | Describe an image used in a procedure document | None |
| PDF | Convert a PDF document to Markdown | None |
| DOCX | Convert a Word document to Markdown | None |
| Compare | Compare the original and revised documents | `{file1}` and `{file2}` |
| Generate | Create a document from a request and source content | `{user_prompt}` and `{input_content}` |

The preset-copy checks compare both browser locale presets byte-for-byte with the server preset definitions. When there is no published prompt revision, the page displays the effective server defaults, which retain the legacy default values; this can differ from the preset selected for a new draft.

Prompt revisions are not tested by calling a provider in this panel. Provider tests are separate and use the saved AI draft. The runtime snapshot currently carries all five prompts, but the repository has no identified worker consumer of those fields yet.

## Platform retention policy

Platform Admins can edit and revision the effective policy. A draft has a reason and values within the server bounds:

- Cache TTL: 0–87,600 hours.
- Output retention: 0–3,650 days.
- Cleanup interval: 0–31,536,000 seconds.

Save a draft, review its values, publish it, or restore an older revision as a new active revision. Presigned storage URL lifetime is configured separately on the storage generation.

The effective cache and output retention values feed the maintenance preview for cache and retained-output cleanup. The Settings form does not launch cleanup. The current source has no scheduled consumer of `cleanupIntervalSeconds`; do not infer that publishing an interval starts a background schedule.

## Artifact storage generations

Platform Admins can stage PostgreSQL or S3-compatible storage. PostgreSQL connection details are server-owned. Its stage request contains only the backend, expected control revision, idempotency key, and reason. For S3, supply endpoint, bucket, region, path-style choice, and presigned URL TTL.

For an S3 credential, choose **Keep exact current pin** or select an active managed Secret Catalog revision owned by the selected tenant with purpose `storage.credential` and Orchestrator service access. The selector reads metadata only and sends the exact opaque `secretId@revision` plus owner tenant UUID. To replace a value, use the write-only password form to create or rotate a managed value; the field clears after a confirmed response. The page never reads a stored secret value. PostgreSQL staging requires confirming that the new PostgreSQL generation has no S3 credential pin; retired generations keep their original pins for existing objects and rollback.

The storage credential selector searches the Secret Catalog on the server and follows its bounded cursor pages. Each query includes the selected owner tenant, `storage.credential` purpose, `orchestrator` service and `ACTIVE` state. Search or tenant changes clear stale choices; **Load next credential page** continues the same search. The UI accepts only an exact managed `secretId@revision` metadata pin owned by the selected tenant. Server responses contain no secret bytes, and the final storage write still validates the selected revision.

Review the stage diff, stage the immutable generation, and run its real write/read/checksum/crypto/delete test. Activate only after the returned test receipt is `PASSED`; `UNKNOWN` can be rechecked with the same request key and is never activation evidence. The active and retained history views show the exact credential version reference and owner metadata. Rollback is available only for a retained generation with a passing test. Existing object references continue to use their stored generation pins.

## Legacy settings and migration

The catalog below the controls explains how legacy values map to typed revisions or are retired. Secret values remain write-only. In particular, the legacy `api_secret_key` is a retirement decision; the Settings UI does not reveal or import it. The migration readiness panel provides continuity evidence but does not initiate cutover. Production cutover and any required independent browser/runtime verification remain separate gates.
