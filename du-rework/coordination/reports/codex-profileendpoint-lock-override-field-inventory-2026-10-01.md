# J03 ProfileEndpoint lock and override field inventory

**Scope:** read-only source characterization of legacy ProfileEndpoint storage and runtime semantics against the rework profile-binding surface. This is an inventory, not a port plan, design, parity decision, or release-gate result. No tests were run and no source files were changed.

The settled J01–J03 characterization remains the governing summary: rework profile binding is narrow connector-pin authorization, not legacy endpoint policy or prompt-override parity (coordination/reports/codex-j01-j03-auth-apikey-characterization.md:9,46-53,77).

## 1. Legacy row and fields

The complete legacy ProfileEndpoint table definition is lib/db/schema.ts:122-137. It has one row per (apiKeyId, endpointSlug) (:134-136). The admin profile endpoint route writes the configurable fields (app/api/internal/profile-endpoints/route.ts:110-167). A non-admin profile user may change only parameters and connectionsOverride for an existing enabled row; admin may set the remaining policy fields (route.ts:135-165).

| Column / stored value | Meaning when set and runtime application | Source |
|---|---|---|
| id | Generated row identifier; does not select the profile at runtime. | lib/db/schema.ts:123 |
| apiKeyId | API-key row to which this endpoint policy belongs. Resolver queries this key together with the endpoint slug. | lib/db/schema.ts:124,134-136; lib/endpoints/profile-resolver.ts:24-42 |
| endpointSlug | Endpoint scope, normally a compound slug such as extract:invoice; a bare service slug such as extract is also allowed as a fallback profile. | lib/db/schema.ts:125,134-136; app/api/internal/profile-endpoints/route.ts:125-133; lib/endpoints/profile-resolver.ts:31-42 |
| enabled | Admin-controlled boolean, default true. The ordinary runner rejects a resolved disabled row with 403. The workflow route has a separate path and does not load or check this field. | lib/db/schema.ts:126; app/api/internal/profile-endpoints/route.ts:149-165; lib/endpoints/runner.ts:177-185; app/api/v1/workflows/route.ts:15-48,88-95 |
| parameters | Nullable JSON text. Runtime expects a map of parameter name to { value, isLocked? }. It seeds variables with each stored value, then considers both registry parameter names and names present in this row. | lib/db/schema.ts:127; app/api/internal/profile-endpoints/route.ts:141-145,151-154; lib/endpoints/runner.ts:187-198; lib/endpoints/profile-resolver.ts:53-93 |
| connectionsOverride | Nullable JSON text replacing the registry connection chain. Accepted legacy form is a string array of connection slugs; newer form is an array of steps with slug, optional stepId, captureSession, and injectSession. | lib/db/schema.ts:128; lib/endpoints/profile-resolver.ts:12-17,121-141; lib/endpoints/runner.ts:209-223 |
| jobPriority | LOW, MEDIUM, or HIGH; mapped to BullMQ priorities 20, 10, or 1 respectively. Submission and resume look up only the exact compound endpoint slug, without the resolver's service-slug fallback. | lib/db/schema.ts:129; app/api/internal/profile-endpoints/route.ts:149-165; lib/pipelines/submit.ts:26-33,175-184,369-373; app/api/v1/operations/[id]/resume/route.ts:12-15,66-73 |
| fileUrlAuthConfig | Nullable JSON stored encrypted by the admin route; runtime decrypts then parses it, with a plaintext-JSON fallback for older rows. Config type supports none, bearer, header, or query, with associated token/header/query fields. It is supplied to remote-file URL download. | lib/db/schema.ts:130; app/api/internal/profile-endpoints/route.ts:47-56,155; lib/endpoints/profile-resolver.ts:96-114; lib/file-url-downloader.ts:25-32; lib/endpoints/runner.ts:231-240; lib/pipelines/submit.ts:273-279,344-350 |
| allowedFileExtensions | Nullable comma-separated extension allow-list. Upload and downloaded-file validation lowercases and checks the configured values; absent config uses the global defaults. | lib/db/schema.ts:131; app/api/internal/profile-endpoints/route.ts:155-156; lib/endpoints/runner.ts:231-240; lib/upload.ts:26-48,78-92; lib/file-url-downloader.ts:194-199,248-253 |
| createdAt | Row creation timestamp. | lib/db/schema.ts:132 |
| updatedAt | Row update timestamp; admin upsert changes the same (apiKeyId, endpointSlug) row. | lib/db/schema.ts:133-136; app/api/internal/profile-endpoints/route.ts:160-165 |

There is **no prompt-override column on ProfileEndpoint**. Two separate prompt stores are involved:

- ExternalApiOverride has connectionId, apiKeyId, endpointSlug, stepId (default _default), and promptOverride; its unique target includes all four scope keys (lib/db/schema.ts:103-116). Its upsert uses that complete scope (app/api/internal/ext-overrides/route.ts:112-123).
- Workflow prompt overrides are stored inside ProfileEndpoint.parameters at _workflowPrompts.value, not as a table column. The workflow worker reads that value by exact key and workflow endpoint slug (lib/pipelines/workflow-engine.ts:356-369), and workflow execution can turn a selected profile prompt into variables._prompt (lib/workflow-builder/real-exec.ts:60-68). It does not inspect _workflowPrompts.isLocked before taking the value (workflow-engine.ts:363-368).

## 2. Legacy selection and merge order

### Profile row selection

1. loadProfileEndpoint queries (apiKeyId, endpointSlug) first and returns that whole row if found.
2. Only when the compound row is absent does it query (apiKeyId, serviceSlug) and return that whole fallback row.
3. It does not field-merge an exact row with the service-level row.

Evidence: lib/endpoints/profile-resolver.ts:24-45.

**MUST-NOT-REPLICATE — disabled service row can be shadowed.** If an exact row is enabled and a bare service-level row is disabled, the exact row wins and runner.ts checks only the returned row (lib/endpoints/profile-resolver.ts:31-42; lib/endpoints/runner.ts:177-185). The disabled service-wide setting therefore does not deny that exact endpoint. This is a runtime consequence of the selection order, not a second lock or merged policy.

jobPriority is resolved independently and queries only the exact endpointSlug; it does not use the service fallback (lib/pipelines/submit.ts:175-184). Thus priority lookup is not consistent with the shared resolver's fallback behavior.

### Parameters and locks

For a normal endpoint handled by lib/endpoints/runner.ts, effective parameter precedence is:

1. The resolved ProfileEndpoint row is parsed and each stored value is copied into the variables map (runner.ts:187-198; profile-resolver.ts:60-63).
2. The accepted key set is the union of registry parameter names and keys in the ProfileEndpoint JSON (profile-resolver.ts:65-68).
3. If the request contains a key, lock state is dbParams[key]?.isLocked ?? schema?.defaultLocked ?? false. A locked key returns HTTP 400 with type https://dugate.vn/errors/forbidden-field; an unlocked key replaces the stored value (profile-resolver.ts:70-90).
4. If neither profile nor request supplies a value, mergeParameters does not apply ParamSchema.default. The registry schema declares metadata such as default: 'json' (lib/endpoints/registry.ts:7-15,39-45), but this merge function never reads it. The ordinary runner separately defaults its top-level outputFormat from the request to json (lib/endpoints/runner.ts:225-226). Extract presets are applied after the merge and fill fields/schema only when those values are falsey (runner.ts:200-206).

Surprising cases:

- A ProfileEndpoint parameter key that is absent from the registry is still added to the allowed request-key set. If it is not locked, the client can submit it (profile-resolver.ts:65-90).
- An explicit nested isLocked: false takes precedence over a registry defaultLocked: true because the resolver uses nullish coalescing (profile-resolver.ts:70-72). The registry file declares the defaultLocked property, but has no active defaultLocked: setting in its current service definitions (lib/endpoints/registry.ts:7-15,67-403).
- Ordinary locked form fields are rejected even if the submitted value equals the stored value: the branch tests presence and lock state, not equality (profile-resolver.ts:74-87).
**MUST-NOT-REPLICATE — workflow prompt lock marker is ignored.** _workflowPrompts.isLocked is not passed through mergeParameters; the workflow worker reads _workflowPrompts.value directly without checking the lock marker (lib/pipelines/workflow-engine.ts:363-368).
- A profile can include _prompt in its parameters even though it is not a registry parameter. If that key is left unlocked (or has no isLocked marker), the normal runner accepts a client form value for it; prompt-resolver then gives variables._prompt precedence over a matched ExternalApiOverride.promptOverride. This is conditional on the profile defining that key, not a general request field (profile-resolver.ts:65-90; prompt-resolver.ts:30-35).
- The merged profile value for output_format does not set the operation's top-level outputFormat: the runner reads the raw form field or uses json after merging parameters (lib/endpoints/runner.ts:195-198,225-226). The value may therefore differ between connector variables and the operation field.

### Connection chains and prompt precedence

For connection routing, a truthy connectionsOverride is parsed and returned instead of the registry chain; absent value uses subCase.connections. Invalid JSON logs and falls back to registry connections. A JSON string array is converted to { slug } steps, while other valid JSON is cast to ConnectionStep[] without shape validation (lib/endpoints/profile-resolver.ts:121-141; lib/endpoints/runner.ts:209-223). The registry chain is an ordered list (lib/endpoints/registry.ts:17-25).

For a connector prompt, the effective precedence is separate from parameter defaults:

1. variables._prompt, if it is a string;
2. matched ExternalApiOverride.promptOverride, if non-empty;
3. ExternalApiConnection.defaultPrompt.

The winning text is then interpolated (lib/pipelines/processors/prompt-resolver.ts:21-37; called by external-api.ts:21-33). The engine preloads overrides filtered by the operation's apiKeyId and exact endpointSlug, then indexes by connector ID plus resolved step ID (lib/pipelines/engine.ts:271-279,316-359). The step ID defaults to _default (:316-318). The DB unique index also includes connection, key, endpoint, and step (lib/db/schema.ts:103-116). The engine lookup itself does not show a cross-key override leak.

**MUST-NOT-REPLICATE — client prompt can outrank a scoped stored prompt.** Under the conditional profile setup described above, a client-supplied _prompt is the highest-precedence value and replaces the matched ExternalApiOverride prompt. This is a trust/scope mismatch if the scoped stored prompt is meant to control that endpoint/step; it must not be represented as though ExternalApiOverride were the top layer.

Scope asymmetry: a bare service-level ProfileEndpoint may be used for a compound endpoint, but an ExternalApiOverride is selected by the operation's exact endpoint slug. For example, an extract ProfileEndpoint can be the fallback for extract:invoice, while an override row with endpointSlug extract will not match an operation whose endpointSlug is extract:invoice (profile-resolver.ts:31-42; runner.ts:171-177; engine.ts:271-279).

**MUST-NOT-REPLICATE — client-selectable workflow profile context.** The workflow route reads apiKeyId from multipart form data, accepts a database ID or hashes the supplied string, and passes the resulting ID to job submission; if omitted, it selects the earliest ADMIN key (app/api/v1/workflows/route.ts:49-95). The worker then reads _workflowPrompts for that operation key (lib/pipelines/workflow-engine.ts:356-369). The prompt-profile selector is therefore supplied by the request path rather than being derived there from a verified API-key principal. This is distinct from the engine's correctly scoped lookup once operation.apiKeyId has been chosen.

**MUST-NOT-REPLICATE — workflow enabled check is absent.** The workflow route validates the process, files, and selected key, then submits the job without loading the matching ProfileEndpoint or checking enabled (app/api/v1/workflows/route.ts:15-48,88-95). A disabled workflow ProfileEndpoint is not enforced on this route.

**MUST-NOT-REPLICATE — URL policy bypass when forwarding.** submitPipelineJob forwards remote URLs when the first connector has fileUrlFieldName, storing remote references and skipping the downloader (lib/pipelines/submit.ts:251-270). fileUrlAuthConfig and allowedFileExtensions are applied on the download path (:273-279,344-350), so they do not authenticate or extension-check URLs forwarded directly to the connector.

**MUST-NOT-REPLICATE — broad override deletion.** The scoped upsert includes endpoint and step, but DELETE accepts only connection ID and API-key ID and deletes every matching override across endpoints and steps (app/api/internal/ext-overrides/route.ts:134-150).

## 3. Rework profile surface as implemented

The actual module is du-rework/services/orchestrator/src/modules/profiles/profiles.ts. A profile_bindings revision stores the tenant, API key, business, business version, action, and JSON connector-slot pins (du-rework/services/orchestrator/migrations/0004_profile_bindings.sql:14-28). Each connector pin is { connectorId, revision }; the module validates that shape and positive revision numbers (profiles.ts:21-50).

createRevision resolves an ACTIVE API-key row from a server-hashed key, then appends an immutable revision (profiles.ts:80-129). Submission resolves the latest exact (api_key_id, business_id, business_version, action) binding before input validation; a key with a binding elsewhere but no match is rejected, while a key with no binding rows uses the legacy mode (profiles.ts:132-160; modules/operations/submission.ts:177-200). The selected profile/revision and rendered connector pins are copied to the operation row at submit (submission.ts:284-309; migration 0004_profile_bindings.sql:30-33).

Current profile-related HTTP surfaces:

- POST /api/v1/admin/profile-bindings appends a binding revision from the API key and connector pin map; it resolves the admin principal, rejects tenant-operator role for this route, and hashes the raw key before passing it into the profile service (server.ts:2200-2255).
- GET /api/v1/admin/profiles/:businessId/:businessVersion/:profileName is admin-gated with assertAdminAuth; it projects the business manifest and returns currentValues: {} and revision 0. It does not load a stored per-key legacy ProfileEndpoint (server.ts:2466-2508).
- The six document-core actions declare profileSchema: { type: 'object', properties: {} }; the manifest exposes connector slots and action artifact policies, not configurable parameter or lock fields (businesses/document-core/src/manifest/document-core.manifest.ts:53-67,91-100,124-133,160-169,195-204,228-238).

Accordingly, a rework binding can select action authorization and pin connector IDs/revisions by slot. It does not store an ordered per-request connection chain, parameter values, field locks, priority, URL authentication, extension policy, or prompt text.

## 4. Legacy field-by-field rework verdict

Verdicts use only **present**, **absent**, and **differently-modelled**. “Present” for API key and creation timestamp names the corresponding rework column; it does not imply full legacy semantic parity.

| Legacy field / semantic | Rework verdict | Evidence and field-depth distinction |
|---|---|---|
| id | differently-modelled | Rework identifies a profile revision by (profile_id, revision), not a mutable ProfileEndpoint row ID (migrations/0004_profile_bindings.sql:14-25; profiles.ts:106-125). |
| apiKeyId | present | Rework stores api_key_id; profile creation resolves it from the server-side key hash and ACTIVE row (migrations/0004_profile_bindings.sql:18; profiles.ts:100-105). |
| endpointSlug | differently-modelled | Scope is (business_id, business_version, action); no legacy compound/service slug or service-level fallback is represented (migrations/0004_profile_bindings.sql:19-23; profiles.ts:139-160). |
| enabled | absent | There is no enabled column. Binding resolution grants the exact action/revision or rejects a key in profile mode without a match; that is not a per-endpoint enabled flag (profiles.ts:132-160). |
| parameters and nested value | absent | The rework binding row contains connector pins only. The manifest profile schemas currently have empty properties (migrations/0004_profile_bindings.sql:19-23; document-core manifest lines cited above). |
| Nested isLocked / registry defaultLocked | absent | Neither the binding schema nor profile service carries a parameter lock map (migrations/0004_profile_bindings.sql:14-28; profiles.ts:65-72). |
| connectionsOverride | differently-modelled | Rework has slot-to-connector-ID/revision pins. It does not carry legacy ordered connection steps or their stepId, captureSession, or injectSession settings (profiles.ts:21-30,32-50; profile-resolver.ts:12-17,121-141). |
| jobPriority | absent | No profile-binding column or submission lookup for a per-key queue priority (migrations/0004_profile_bindings.sql:14-28; modules/operations/submission.ts:177-200). |
| fileUrlAuthConfig | absent | No matching field in the profile binding or submission context (migrations/0004_profile_bindings.sql:14-28; modules/operations/submission.ts:40-50,177-200). |
| allowedFileExtensions | absent | Action artifact policy in the manifest expresses file counts, not a per-key extension list (document-core.manifest.ts:66,99,132,168,203,236). |
| ExternalApiOverride.promptOverride | absent | Rework connector_bindings has no connection/key/endpoint/step prompt text field (migrations/0004_profile_bindings.sql:14-28; profiles.ts:65-72). |
| parameters._workflowPrompts | absent | Rework profile binding and action manifest do not contain this legacy workflow prompt map (profiles.ts:65-72; document-core.manifest.ts:53-238). |
| createdAt | present | created_at exists per immutable profile revision; it records append-only revision creation, rather than in-place ProfileEndpoint updates (migrations/0004_profile_bindings.sql:24-25; profiles.ts:106-125). |
| updatedAt | absent | Revisions are append-only and the table has no update timestamp column (migrations/0004_profile_bindings.sql:14-25; profiles.ts:106-129). |

## 5. Cutover-required delta inventory

The following legacy semantics have no rework counterpart in the inspected profile row/runtime and are marked **cutover-required** for accounting only:

- Per-key/per-endpoint enabled state and its ordinary-runner check.
- Profile parameter values, unlocked client override behavior, isLocked, and defaultLocked.
- Service-slug fallback and exact-row-versus-service-row behavior.
- Legacy connectionsOverride ordered chain and step/session directives; connector pins are differently modelled and do not represent that whole chain.
- Per-key queue job priority.
- Per-key remote-file authentication configuration.
- Per-key allowed file extensions.
- Connection/key/endpoint/step prompt override text, including workflow _workflowPrompts.

“Cutover-required” here records missing behavioral counterparts only. It is not a proposal to add or port these fields and does not resolve the J03 parity question. No contract freeze, COMP row, or release gate was changed.
