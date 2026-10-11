# UBW-06-PRE — workflow-bound profile UI and admission analysis

## Scope and evidence boundary

This is a design and contract proposal for du-rework, based on the canonical plan, UBW-00 inventory, UBW-01 UI design, UBW-02 registration analysis, UBW-03 catalog/UI analysis, and UBW-04 workflow contract analysis. I also read the existing profile contracts, profile store, and profile revision-pointer helper to ground the compatibility proposal. No product or test code was changed, and no tests, build, browser, or database session was run. This report does not claim the workflow-profile adapter or workflow admission path exists.

The governing decision is D-UBW-3: preserve the existing endpoint-profile model and add a separate versioned adapter that binds an exact published workflow revision to exact action-profile revisions and node settings. The workflow gate remains governed by D-UBW-4: when Δ-DEV-03 is closed, the UI and server must not read or mutate workflow adapters through a secondary route.

## Current profile model and relevant constraints

- `ProfileKeySchema` identifies `(businessId, businessVersion, profileName)`; `profileName` is a legacy endpoint slug, not guaranteed to equal the action name (`orchestrator/packages/contracts/src/profile-policy.ts:41-55`). The stored binding also has an explicit action and API-key identity; `ProfileUpsertCommandSchema` keeps the write command additive rather than widening the frozen profile wire (`orchestrator/packages/contracts/src/profile-commands.ts:7-18,24-85`). A profile is bound to one API key (`profile-commands.ts:29-56`).
- Profile rows are append-only `(profile_id, revision)` records containing tenant, API key, business/version/action, connector pins, and endpoint policy; `profile_active_revisions` is the live pointer (`orchestrator/services/orchestrator/src/modules/profiles/profiles.ts:33-48,384-471`; `orchestrator/services/orchestrator/src/modules/profiles/publish.ts:31-48`). Create appends a revision and moves the pointer in one transaction. Existing publish uses CAS; existing rollback moves the pointer to an older immutable row, but its expected revision is optional (`publish.ts:75-169`; `profile-commands.ts:88-104`).
- Admission resolves a profile using API-key ID plus business/version/action and the active pointer (`profiles.ts:339-383,476-510`). No rows for a key means legacy mode; if the key has profile rows but no matching action binding, the result is forbidden. A missing active pointer with existing rows fails closed. `resolveEffectiveProfile` rejects a disabled profile and returns the selected profile ID/revision, connector pins, effective parameters, and policy (`profiles.ts:513-570`). The actual operation submission writer was not audited in UBW-00 due the WFA-02 lease; admission integration below therefore requires a separate lease after WFA-02 releases.
- Read and write profile policy deliberately differ. The read shape exposes `fileUrlAuthConfigured`, not credentials (`profile-policy.ts:278-334`). The admission snapshot is a strict shape that excludes `fileUrlAuthConfig` and carries a typed immutable `credentialRef` (`profile-policy.ts:596-677`). Reuse this no-secret pattern for every workflow node; never copy plaintext auth, API-key hashes, or credentials into an adapter or preview.
- Existing profile detail can return the active revision, manifest actions/capabilities, and `apiKeyId`; it does not expose a stored API-key hash (`profile-policy.ts:337-405`). The current action contract pins profile data at submission so a later pointer move does not rewrite an admitted operation (`profiles.ts:42-48`, UBW-00 §3). The workflow snapshot must preserve the same boundary independently for every node.
- The current workflow contract proposal pins `workflowId`, exact revision, and digest, with node-level action pins. It calls out the still-unresolved canonical action-schema digest field set (UBW-04 “Required validator behavior”; UBW-03 “Businesses, versions, and action discovery”). The adapter cannot invent or attest these digests; use the server-derived contract frozen by UBW-04.

These constraints mean a workflow adapter cannot simply be another `ProfileKey`. Doing so would conflate a graph-level revision with the existing action endpoint slug and would lose API-key, action, connector, and immutable-row identity.

## Proposed adapter model

### Identity and compatibility rules

Create a tenant-scoped `WorkflowProfileAdapter` with its own name, immutable revisions, and active-revision pointer. Every adapter revision references one exact published workflow `(workflowId, revision, digest)` and contains exactly one node binding for each node in that workflow revision.

For V1, require one API key for the adapter and require every referenced action-profile row to belong to that same API key and tenant. The caller’s authenticated API-key ID must equal the adapter’s key ID at admission. This preserves the existing per-key profile authorization model and prevents a workflow from combining credentials or borrowing another key’s action permission. A different workflow-owned service identity would be a separate authorization design, not an implicit adapter feature.

Each node binding references one exact existing action-profile row by `profileId` and `revision`, and carries the human-readable profile name plus explicit action and business/version for review. The server verifies the stored row; it does not trust the descriptive fields in the submitted DTO. `profileName` may differ from `action`, so compatibility compares the stored action exactly to the workflow node action. A legacy profile that has no explicit row for the node is not an adapter-compatible fallback.

An adapter may be published only when each referenced action-profile revision is the active revision for that API-key/business/version/action and is enabled. If a later action-profile publish or rollback moves that profile’s active pointer, the adapter becomes `STALE_ACTION_PROFILE` and cannot admit new runs until a new adapter revision pins the selected active revision. This fail-closed rule prevents an older still-enabled row from bypassing a newer disable or policy change. Runs already admitted keep their frozen snapshot and continue under existing operation semantics.

For V1, action profile connector pins are inherited as the node baseline. Adapter-level connector overrides may replace only declared slots, must identify an exact connector revision in the same tenant, and must be authorized under the adapter’s API key. An override never stores connector credentials. Per-node parameter overrides are constrained to the action’s profile/config schema; prompt references use exact prompt revisions. Limits may tighten server policy but never raise platform maxima. The adapter cannot override `enabled`, API-key identity, tenant, request-redaction policy to a weaker form, credential values, business/action/version pins, or queue.

### DTOs

Add strict, versioned schemas in a new `workflow-profile-adapter.ts`; do not widen `ProfileKeySchema`, `ProfileEndpointPolicySchema`, or the existing frozen command schemas.

```ts
type ActionProfilePinV1 = {
  profileId: string; // allow legacy stored identifiers; never a secret
  profileName: string;
  businessId: string;
  businessVersion: string;
  action: string;
  revision: number; // positive, exact profile_bindings revision
  policyDigest: string; // recomputed server-side from the safe normalized snapshot
};

type WorkflowProfileNodeSettingsV1 = {
  parameterOverrides: Record<string, JsonValue>;
  connectorOverrides: Record<string, { connectorId: string; revision: number }>;
  promptRevision?: { promptId: string; revision: number; digest: string } | null;
  limits?: { timeoutMs?: number; maxOutputBytes?: number };
};

type WorkflowProfileAdapterDraftV1 = {
  schemaVersion: 1;
  name: string;
  workflow: { workflowId: string; revision: number; digest: string };
  apiKeyId: string;
  nodes: Array<{
    nodeId: string;
    actionProfile: ActionProfilePinV1;
    settings: WorkflowProfileNodeSettingsV1;
  }>;
};

type WorkflowProfileAdapterRevisionV1 = {
  adapterId: string;
  tenantId: string;
  revision: number;
  digest: string;
  spec: WorkflowProfileAdapterDraftV1;
  createdAt: string;
  publishedAt: string;
};

type WorkflowProfileAdapterSaveDraftRequest = {
  expectedDraftRevision: number;
  spec: WorkflowProfileAdapterDraftV1;
};

type WorkflowProfileAdapterPublishRequest = {
  expectedActiveRevision: number | null;
  idempotencyKey: string;
};

type WorkflowProfileAdapterRollbackRequest = {
  expectedActiveRevision: number;
  targetRevision: number;
  idempotencyKey: string;
};
```

The write DTO does not accept `tenantId`; derive tenant from the authenticated admin context and verify every referenced object belongs to it. `apiKeyId` is an opaque row ID, not a credential. The action-profile ref includes the existing profile ID because the endpoint slug triple alone cannot uniquely select an immutable row. Require `revision >= 1`; the current read contract may represent an absent revision, but an adapter cannot pin an absent profile.

Add a read-only effective-config preview DTO that reports provenance and compatibility without secrets:

```ts
type WorkflowProfileEffectivePreviewV1 = {
  valid: boolean;
  workflow: { workflowId: string; revision: number; digest: string };
  adapterDigest?: string;
  issues: Array<{
    code: string;
    path: string;
    nodeId?: string;
    message: string;
  }>;
  nodes: Array<{
    nodeId: string;
    action: string;
    actionProfile: {
      profileId: string;
      profileName: string;
      revision: number;
      activeRevision: number | null;
      enabled: boolean;
      compatible: boolean;
    };
    effective: {
      parameters: Record<string, JsonValue>;
      connectorBindings: Record<string, { connectorId: string; revision: number }>;
      promptRevision?: { promptId: string; revision: number; digest: string } | null;
      limits: { timeoutMs: number; maxOutputBytes: number };
      fileUrlAuthConfigured: boolean;
    };
  }>;
};
```

The server computes this preview from the published workflow, exact profile rows, connector catalog, prompt revision store, and current platform limits. The UI shows a per-field source label such as Action profile, Adapter override, or Platform cap. It shows file-auth state as configured/not configured only. Do not include `fileUrlAuthConfig`, credential ciphertext/reference, API-key hash, raw connection credentials, or unredacted operation input/output in the preview.

The workflow execution snapshot should include an immutable per-node profile reference and a validated `ProfilePolicySnapshot`-compatible value, along with connector pins and effective node settings. The existing snapshot’s `credentialRef` points to `(tenantId, profileId, profileRevision)` and keeps the secret out of the wire. Extend the UBW-04 execution contract only after its current shared-contract lease is released; do not alter it concurrently.

### Storage proposal

Add an adapter identity, immutable revision table, and active pointer. Keep workflow node data and exact action-profile references in the revision spec or a normalized child table with equivalent composite keys.

```text
workflow_profile_adapters
  adapter_id uuid primary key
  tenant_id uuid not null references tenants(id)
  api_key_id uuid not null references api_keys(id)
  name text not null
  created_at timestamptz not null
  created_by uuid not null
  unique (tenant_id, api_key_id, name)

workflow_profile_adapter_revisions
  adapter_id uuid not null references workflow_profile_adapters(adapter_id)
  revision integer not null check (revision > 0)
  workflow_id uuid not null
  workflow_revision integer not null
  workflow_digest text not null
  digest text not null
  spec jsonb not null
  created_at timestamptz not null
  created_by uuid not null
  published_at timestamptz not null
  primary key (adapter_id, revision)

workflow_profile_adapter_heads
  adapter_id uuid primary key references workflow_profile_adapters(adapter_id)
  revision integer not null
  moved_at timestamptz not null
  moved_by uuid not null
  foreign key (adapter_id, revision)
    references workflow_profile_adapter_revisions(adapter_id, revision)
```

Add a composite foreign key from `(workflow_id, workflow_revision)` to the immutable workflow revision table when the UBW-04 migration is installed, and verify `workflow_digest` against that row in the same transaction. If node bindings are normalized, add `(adapter_id, adapter_revision, node_id)` as their key and a foreign key to `(profile_id, profile_revision)` using the exact deployed profile column type. Do not guess or change the existing profile ID type to fit the adapter. The adapter digest covers workflow pin, API-key ID, ordered node IDs, profile row IDs/revisions/policy digests, overrides, connector/prompt refs, and limits.

Saving a draft is CAS against `expectedDraftRevision`. Publishing inserts one immutable adapter revision and moves the active pointer in a transaction with `expectedActiveRevision`; repeated idempotency key and identical body returns the original result, while a different body conflicts. Rollback moves only the active adapter pointer to a validated prior immutable revision. Require `expectedActiveRevision` for rollback even though the legacy action-profile rollback command currently permits omission; do not change that old contract in this slice.

## Effective configuration and rollback UX

Add a **Workflow adapters** tab beside the existing **Action profiles** tab. The current action-profile page remains available and keeps its existing API, form, publish, and rollback behavior. The workflow adapter page requires an explicit tenant and an API-key selection; it never displays an API-key secret.

Create/edit steps:

1. Select a published workflow revision by exact ID/revision/digest. `latest` may appear as a search shortcut, but the saved DTO contains the exact resolved revision.
2. Choose one authorized API key for the adapter. The compatible action-profile chooser is filtered to that same key, tenant, business/version, and action. Each workflow node must resolve to one exact profile revision.
3. Review per-node settings: profile parameter overrides, declared connector slot overrides with exact connector revisions, prompt revision, and bounded node limits. Disabled profiles, missing connector pins, and missing prompts remain blocking issues rather than empty defaults.
4. Open Effective configuration. Show each node’s effective parameters, connector IDs/revisions, prompt pin, limits after platform clamping, file-auth configured status, and the source of every value. Separate action-profile policy from workflow input mappings; the mapping result is not a profile default.
5. Validate and publish a new adapter revision. The success message appears only after server acknowledgement and authoritative reload. Existing action profiles and operations are not modified.

The effective-config merge is deterministic: exact action-profile revision supplies the baseline; adapter overrides apply only to allowed node settings; platform limits clamp the result. Workflow runtime input is then produced separately from the workflow’s pinned input-output mappings. Never let adapter parameters change tenant/API-key identity, action, business version, schema digest, `enabled`, or credential values. Redaction policy may only stay as-is or become more restrictive; a workflow adapter cannot weaken it.

Adapter rollback shows the selected historical adapter revision, exact workflow pin, and all per-node action-profile/connector/prompt pins before confirmation. It CAS-moves the adapter head; it does not mutate a revision or move any action-profile head. Before moving, validate the target adapter against current admission conditions. If one of its action profiles is no longer the active revision or is disabled, block rollback with `ADAPTER_REVISION_STALE` and offer to create a new adapter revision. This prevents rollback from silently re-enabling a profile that an operator replaced or disabled.

When the action-profile active pointer changes, show the adapter as **Stale — action profile changed** with a node-level diff and a “Create new adapter revision” path. Do not auto-follow `profile_active_revisions`. When a new workflow revision is published, the adapter remains bound to the old workflow revision and is shown as **Pinned to workflow rN**; moving it requires a new adapter revision and a fresh compatibility preview.

While Δ-DEV-03 is closed, retain the existing workflow gate panel and show the workflow-adapter tab disabled with the same gate explanation. Do not issue workflow or adapter data requests, render a false empty state, or accept a direct BFF/API call that bypasses the screen.

## Action-profile compatibility and admission checks

### Publish-time compatibility

For each node in the exact published workflow:

1. Require exactly one adapter node entry and no extras or duplicates. Node ID, action, business ID, business version, manifest digest, and action-schema digest must match the workflow node exactly.
2. Resolve the `profileId` and exact positive revision. Confirm the stored row is for the adapter tenant, selected API key, same business/version, and exact action. Never infer action equality from `profileName` alone; an explicit stored action can differ from the endpoint slug.
3. Require that profile revision to equal the profile’s current active pointer and that its stored `enabled` field is true. Missing rows, orphaned pointers, or a stale revision fail closed. Reuse the current active-pointer invariant; never choose `MAX(revision)` as a fallback.
4. Recompute the profile-policy digest from the strict safe snapshot and verify profile connector pins. Validate parameter overrides against the action’s supported profile/config schema. Require every required connector slot to be resolved exactly once; overrides may only name declared slots and same-tenant, key-authorized connector revisions.
5. Validate prompt revision, policy restrictions, and limit values. Limits may reduce the platform/action cap only. Do not copy secret values to the adapter or preview.
6. Confirm the workflow revision is published, its digest matches, Δ-DEV-03 is open, and all action nodes meet the V1 same-business/version constraints. A workflow revision or action-schema digest mismatch requires a new adapter revision.

### Run-admission checks

The public admission path must perform the following using one consistent read/transaction before creating the root operation or any child:

1. Authenticate the API key and derive `tenantId` and `apiKeyId` from the principal. Resolve the process alias only inside that tenant and verify its immutable binding target is the expected exact workflow revision.
2. Check Δ-DEV-03 on the server. If closed or unreadable, fail closed before reading profile data or creating an operation. A process alias is not a gate bypass.
3. Load the requested adapter ID/revision in that tenant. Require the API-key ID to match, adapter workflow ID/revision/digest to equal the process binding target, and revision state to be published.
4. Recheck every exact action-profile pin: same API key and tenant, exact action/business/version, active pointer still equal to the pinned revision, and policy enabled. Recheck required connector/prompt references and current API-key status. Any node failure rejects the whole admission; do not dispatch a partial graph.
5. Validate external trigger input against the workflow trigger schema, each mapped node input against its pinned action schema, and adapter settings against the effective profile schema. Resolve only the already-pinned actions and server queue; never accept a client queue, business version, node action, or secret.
6. In the same transaction as root operation admission, persist the process binding, workflow, adapter, action-profile, connector, prompt, schema, and snapshot digests/references. Apply request idempotency before any child execution. Later workflow/profile/adapter pointer changes affect future admissions only.

Use stable problem codes: `WORKFLOW_GATE_CLOSED`, `PROFILE_ADAPTER_NOT_FOUND`, `PROFILE_ADAPTER_API_KEY_MISMATCH`, `PROFILE_ADAPTER_WORKFLOW_MISMATCH`, `PROFILE_ADAPTER_STALE_ACTION_PROFILE`, `PROFILE_DISABLED`, `PROFILE_ADAPTER_INCOMPATIBLE`, `CONNECTOR_REVISION_UNAVAILABLE`, `PROMPT_REVISION_UNAVAILABLE`, and `PROFILE_ADAPTER_REVISION_CONFLICT`. Return 403/404 without leaking foreign tenant objects; 409 for stale pointers or CAS conflicts; 422 with node/path issues for malformed settings; and 503 for unavailable dependencies where retry is safe. Do not create an operation or child row on any failed check.

There is one admission policy choice to lock before implementation: requiring the referenced action-profile revision to remain the active pointer makes action-profile changes invalidate adapters, which is the recommendation here. If product owners instead want adapters to continue using any historical enabled profile revision, introduce an explicit revocation policy; otherwise old adapter pins can bypass a newer disable. Do not silently choose the permissive behavior.

## UI states

| State | Workflow adapter screen behavior |
|---|---|
| Loading | Separate workflow, API-key, action-profile, connector, prompt, and adapter skeletons. A failed dependency is not rendered as an empty choice list. |
| Empty | Distinguish no published workflows, no compatible profiles for the selected API key, no adapters, and no connector/prompt options. Explain the exact missing prerequisite. |
| Error | Retain the draft. Name the failing dependency and provide targeted retry; never report validation/publish success from local state. |
| 403 | Show tenant/API-key permission denial without exposing hidden profile or connector IDs. Keep the existing action-profile tab separate. |
| 409 | Preserve edits; show current adapter/profile revision, the stale node, and a field-level diff. Require reload/rebase/re-pin; do not overwrite the active pointer. |
| Offline | Show cached revisions as stale and read-only. Disable preview, validate, save, publish, rollback, and run submission; do not queue mutations. |
| Δ-DEV-03 closed | Keep adapters unavailable and perform no adapter/workflow read. Show gate status instead of an empty list. |

## Proposed exact file leases and order

These are proposals for future dispatch, not granted leases. Refresh the live roster and lease table first. Keep each packet non-overlapping and sequential. Do not take files from WFA-02/WFA-03 or UBW-04 while those owners hold them.

### UBW-06A — shared DTOs

After UBW-04A releases `packages/contracts/src/index.ts` and `workflow-execution.ts`, lease:

- `orchestrator/packages/contracts/src/workflow-profile-adapter.ts` — adapter draft/revision, action-profile pin, node settings, preview, publish/rollback, and admission error schemas.
- `orchestrator/packages/contracts/src/workflow-execution.ts` — sequential follow-on change to reference the per-node profile-policy snapshot/connector pins; do not overlap UBW-04A.
- `orchestrator/packages/contracts/src/index.ts` — sequential export of the new DTOs after UBW-04A releases it.
- `orchestrator/services/orchestrator/tests/workflow-profile-adapter-contract.test.ts` — strict DTO, no-secret, exact-revision, and mismatch tests.

Do not modify `profile-policy.ts`, `profile-commands.ts`, `legacy-workflow.ts`, or unrelated runtime DTOs. If the frozen action-profile contract cannot represent a required pin, stop and request an additive contract decision rather than widening it.

### UBW-06B — adapter persistence and profile resolution

After UBW-04B creates workflow revision storage and migration head is verified, lease:

- `orchestrator/services/orchestrator/migrations/0044_workflow_profile_adapters.sql` — adapter identity, immutable revisions, and pointer. Renumber against the actual migration head before implementation; do not edit an applied migration.
- `orchestrator/services/orchestrator/src/modules/profiles/workflow-adapter-store.ts` — adapter CRUD, draft CAS, immutable publish/rollback pointer, tenant/API-key scoping.
- `orchestrator/services/orchestrator/src/modules/profiles/workflow-adapter.ts` — publish validator, action-profile/connector/prompt compatibility, policy merge, digest computation, effective preview.
- `orchestrator/services/orchestrator/src/modules/profiles/profiles.ts` — additive exact-revision resolver only, if needed; sole lease holder for this file during the change. It must reuse existing policy decoding and no-secret snapshot logic rather than duplicate it.
- `orchestrator/services/orchestrator/tests/workflow-profile-adapter-store.test.ts`.
- `orchestrator/services/orchestrator/tests/workflow-profile-adapter-validation.test.ts`.

Do not change existing action-profile write/read semantics, active-pointer rules, or current public action admission in this packet.

### UBW-06C — workflow run admission/snapshot integration

Only after UBW-04C is accepted and WFA-02 releases its operation files, lease:

- `orchestrator/services/orchestrator/src/modules/profiles/workflow-adapter-admission.ts` — transaction-scoped validation/resolution into immutable per-node snapshots.
- `orchestrator/services/orchestrator/src/modules/operations/submission.ts` — integrate adapter resolution with process/workflow operation admission; keep the legacy action path unchanged.
- `orchestrator/services/orchestrator/src/modules/workflows/workflow-executor.ts` — consume the new per-node profile snapshot and settings without resolving mutable profile heads during execution.
- `orchestrator/services/orchestrator/tests/workflow-profile-admission.test.ts`.
- `orchestrator/services/orchestrator/tests/workflow-profile-pinning.test.ts`.

If route-context or public route integration is required, request a separate exact lease after UBW-04D and WFA-02 release; do not extend this packet implicitly.

### UBW-06D — admin API and BFF

After UBW-04D releases shared route seams, lease:

- `orchestrator/services/orchestrator/src/http/routes/workflow-profiles.ts` — tenant-scoped list/detail/draft/preview/publish/rollback endpoints; server gate enforcement.
- `orchestrator/services/orchestrator/src/http/route-context.ts`, `orchestrator/services/orchestrator/src/app/bootstrap/create-app.ts`, and `orchestrator/services/orchestrator/src/server.ts` — sequential service wiring and route mounting after the UBW-04D owner releases them.
- `orchestrator/services/orchestrator/src/app/admin/bff/workflow-profiles.ts` — allowlisted BFF relay, CSRF, session/tenant authorization, server-only upstream credentials.
- `orchestrator/services/orchestrator/src/app/admin/bff/handle.ts` — sequential route dispatch after UBW-04D releases it.
- `orchestrator/services/orchestrator/tests/workflow-profile-adapter-routes.test.ts`.
- `orchestrator/services/orchestrator/tests/workflow-profile-adapter-bff-offline.test.ts`.

The BFF must not accept tenant, API-key hash, business/version/action, revision, connector, prompt, or queue values as authorization proof. The backend resolves and validates those against authenticated context and stored revisions.

### UBW-06E — Admin Web profile adapter UI

After the DTO/API behavior is frozen, lease:

- `orchestrator/apps/admin-web/src/features/profiles/profiles-screen.tsx` — add an adjacent Workflow adapters view without changing the action-profile flow.
- `orchestrator/apps/admin-web/src/features/profiles/workflow-profile-adapter-panel.tsx` — new adapter list/editor/effective-preview/revision-history panel.
- `orchestrator/apps/admin-web/src/lib/api/types.ts` and `orchestrator/apps/admin-web/src/lib/api/client.ts` — typed adapter methods and DTOs.
- `orchestrator/apps/admin-web/src/features/profiles/workflow-profile-adapter-panel.test.tsx` — loading/empty/error/403/409/offline/gate and revision-pinning behavior.

Do not lease Workflows screen or open Δ-DEV-03 from this UI packet. When the gate is closed, the adapter tab is inert and the server remains the enforcement point.

## Acceptance and remaining questions

Acceptance should demonstrate: exact workflow and action-profile revision pins; profileName/action mismatch rejection; same tenant and API-key enforcement across every node; disabled or stale action profile rejection; complete node coverage; connector/prompt revision and limit validation; safe effective preview with no credential; adapter publish/rollback CAS; no change to legacy action-profile behavior; operation snapshots stable across later edits; no partial workflow dispatch on an admission failure; and gate enforcement on direct API/BFF calls while Δ-DEV-03 is closed.

Before dispatch, confirm the recommended same-API-key-per-adapter rule; confirm whether an action-profile active-pointer change invalidates an adapter (recommended fail-closed behavior); freeze action-schema digest derivation with UBW-04/UBW-03; and verify prompt-revision storage and operation transaction semantics with their owners. The actual operation writer is WFA-02 leased and was not opened in this analysis. No implementation, UI runtime, browser verification, or gate change is claimed.
