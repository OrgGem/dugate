# UBW-04 — process binding and workflow contract/runtime analysis

## Scope and basis

This is a design and contract proposal for du-rework. It is based on the canonical plan `coordination/PLAN-UI-BUSINESS-WORKFLOW-2026-10-08.md`, `coordination/reports/ubw-00-inventory.md`, `coordination/reports/ubw-01-ui-design.md`, and `coordination/reports/ubw-02-registration.md`. No product or test code is changed by this report; no migration, test, or database was run. It does not claim that the proposed workflow API or executor exists.

The design carries these decisions forward:

| Decision | Contract consequence |
|---|---|
| D-UBW-1 — alias-first process binding | A process alias is the stable entry name. Its immutable binding revision points to an exact business version/action or a published workflow revision. It is not a node type or a parallel capability registry. |
| D-UBW-2 — same-business multi-action V1 | A V1 workflow executes at least two actions from one business. To make cross-action behavior deterministic, this proposal requires one exact business version and manifest digest for all V1 nodes; mixed versions of the same business are deferred until queue routing and compatibility are proven. Each action remains individually pinned. Cross-business execution is out of V1. |
| D-UBW-3 — profile adapter binding | Existing endpoint-profile keys and DTOs stay intact. A separate immutable workflow-profile adapter binds one exact workflow revision to exact action-profile revisions and node-level settings. |
| D-UBW-4 — Δ-DEV-03 | Workflow definition, draft, publish, and run routes remain unavailable while the gate is closed. Only a new explicit user order can authorize opening it. Process aliases may target existing business actions while closed; they may not be used to reach a workflow indirectly. |

## Evidence and limits in the current inventory

- Business manifests already carry an exact business/version and action catalog; registry registration hashes manifests, replays an identical digest, rejects a different digest for the same coordinates, and leaves new versions `REGISTERED_DISABLED` (`orchestrator/packages/contracts/src/manifest.ts:48-71,89-104`; `orchestrator/services/orchestrator/src/modules/registry/registry.ts:42-99`; summarized in UBW-00 §3 and UBW-02 “Manifest, replay, and conflict”).
- Public submission currently names one business/action (`orchestrator/services/orchestrator/src/http/routes/public.ts:393-428`, UBW-00 §1). A process alias must resolve to this existing action contract for the action target, without changing the legacy route’s meaning.
- Existing profile identity is `(businessId, businessVersion, profileName)` and policy is endpoint-level; profile rows are append-only revisions with connector pins and an active pointer (`orchestrator/packages/contracts/src/profile-policy.ts:41-55,278-306,337-405`; `orchestrator/services/orchestrator/src/modules/profiles/profiles.ts:33-48,141-155,329-382,384-471`; UBW-00 §3). The current operation contract pins action/profile data but does not include a workflow revision (`orchestrator/packages/contracts/src/runtime.ts:91-132`, UBW-00 §3).
- `WAITING_CHILDREN` and `WAITING_INPUT` are operation states in the contract (`orchestrator/packages/contracts/src/operations.ts:73-117`). Runtime exposes child and wait-input primitives (`orchestrator/services/orchestrator/src/http/routes/runtime.ts:447-475`, UBW-00 §5). Those facts do not prove a durable graph executor, atomic wake-up, output persistence, or workflow publish semantics; UBW-00 records those as gaps.
- The earlier path `src/lib/pipelines/` was not found. `src/modules/workflow-schemas/`, `src/compat/`, and `packages/contracts/src/legacy-workflow.ts` were not inspected in UBW-00 because of active WFA leases. The exact legacy workflow route map and those lease boundaries must be checked by the dispatcher before implementation. This proposal does not rely on uninspected contents.
- UBW-02 proposes a persisted worker-instance lease, registration before consumption, and worker read-only V1. It also proposes migration `0039_worker_instances.sql`. Workflow actions should dispatch using the registered immutable business-version queue and must not infer worker health or availability from the current heartbeat stub.

## Process alias and binding model

### Identity and invariants

`ProcessAlias` is tenant-scoped and has a normalized lowercase slug unique within that tenant. Its identity and display name survive target changes. Existing names such as `disbursement`, `lc-checker`, `doc-compare`, and legacy `schemaSlug` mappings remain readable as compatibility aliases until an explicit, audited binding change is made. There is no global fallback when a tenant-scoped lookup fails.

Binding targets are a strict discriminated union:

```ts
type ProcessTarget =
  | {
      kind: 'business_action';
      businessId: string;
      businessVersion: string;
      manifestDigest: string;
      action: string;
      actionSchemaDigest: string;
    }
  | {
      kind: 'workflow_revision';
      workflowId: string;
      workflowRevision: number;
      workflowDigest: string;
    };

type CreateProcessAliasRequest = {
  alias: string;
  displayName: string;
  description?: string;
};

type PublishProcessBindingRequest = {
  expectedRevision: number | null;
  target: ProcessTarget;
  idempotencyKey: string;
};

type ProcessAliasView = {
  processId: string;
  tenantId: string;
  alias: string;
  displayName: string;
  activeBinding: {
    revision: number;
    target: ProcessTarget;
    digest: string;
    publishedAt: string;
  } | null;
  updatedAt: string;
};

type ProcessAliasListResponse = {
  items: ProcessAliasView[];
  nextCursor: string | null;
};

type ProcessBindingRevision = {
  processId: string;
  revision: number;
  target: ProcessTarget;
  digest: string;
  publishedAt: string;
};

type ProcessRunRequestV1 = {
  input: JsonValue;
  profileAdapter: { adapterId: string; revision: number; digest: string };
  idempotencyKey: string;
};
```

The authenticated admin context supplies tenant scope on writes; `tenantId` is not accepted from an untrusted body. A platform admin may query an explicit tenant if authorized. A public run resolves tenant from the authenticated API-key principal, never from caller-supplied JSON. The workflow target variant is rejected while Δ-DEV-03 is closed, including when reached through a process alias.

### Storage proposal

Create three tables, with immutable binding rows and a compare-and-swap head:

```text
process_aliases
  process_id uuid primary key
  tenant_id uuid not null references tenants(id)
  alias text not null
  display_name text not null
  description text null
  created_at timestamptz not null
  created_by uuid not null
  unique (tenant_id, alias)

process_binding_revisions
  process_id uuid not null references process_aliases(process_id)
  revision integer not null check (revision > 0)
  target_kind text not null check (target_kind in ('business_action','workflow_revision'))
  target jsonb not null
  binding_digest text not null
  created_at timestamptz not null
  created_by uuid not null
  primary key (process_id, revision)

process_binding_heads
  process_id uuid primary key references process_aliases(process_id)
  revision integer not null
  updated_at timestamptz not null
  updated_by uuid not null
  foreign key (process_id, revision)
    references process_binding_revisions(process_id, revision)
```

The service validates the strict target union before writing and verifies that the JSON `target_kind` matches the target object. The database enforces the alias uniqueness, revision identity, and head foreign key. Publish inserts the immutable revision and updates the head in one transaction with `expectedRevision`; a mismatch returns 409 and writes nothing. If implementation policy prefers normalized target columns over `target jsonb`, retain the same union and exclusivity invariant with a database CHECK constraint. Do not create a second mutable “process registry” for business actions.

### DTO and route proposal

Admin routes, protected by existing admin session, role, CSRF, and tenant checks:

| Method and path | DTO / behavior |
|---|---|
| `GET /api/v1/admin/processes?tenantId=&cursor=&limit=` | `ProcessAliasListResponse { items: ProcessAliasView[]; nextCursor: string | null }`. Tenant scope is mandatory unless the caller explicitly requests a permitted platform read. |
| `POST /api/v1/admin/processes` | `CreateProcessAliasRequest` → `201 ProcessAliasView`. Normalizes the alias and returns `409 PROCESS_ALIAS_TAKEN` for an existing alias in that tenant. |
| `GET /api/v1/admin/processes/{processId}` | Returns alias plus active and historical binding summaries after tenant authorization. |
| `POST /api/v1/admin/processes/{processId}/bindings` | `PublishProcessBindingRequest` → `201 ProcessBindingRevision`. Uses CAS, immutable target pins, and an idempotency key. A repeated key with a different payload is rejected. |
| `GET /api/v1/admin/processes/{processId}/bindings/{revision}` | Reads one immutable target revision and its digest. |
| `POST /api/v1/processes/{alias}/runs` | Public admission resolves the alias in the API key’s tenant, then submits through the existing operation admission path. Request is `ProcessRunRequestV1`; the supplied adapter revision must be authorized for that API key and point to the exact workflow target in the alias. It cannot override target version, tenant, workflow revision, or queue. For an action target, the profile reference must match the action target. |

Use the existing problem response envelope. Proposed typed codes are `PROCESS_ALIAS_TAKEN`, `PROCESS_BINDING_REVISION_CONFLICT`, `PROCESS_TARGET_NOT_FOUND`, `PROCESS_TARGET_UNAVAILABLE`, and `WORKFLOW_GATE_CLOSED`. Return 404 without foreign-tenant existence details. Return 422 for malformed alias or target shape; return 409 for alias collision, stale head, immutable target conflict, or a target that is no longer admissible. The exact status for disabled/retired targets must match existing registry admission semantics before endpoint implementation.

## Workflow revision and graph contract

### Exact V1 schema

Use strict, versioned JSON schemas (`additionalProperties: false`) and Zod/TypeScript DTOs exported from contracts. Drafts may be incomplete; publish runs full validation. A published revision is immutable and content-addressed. Draft updates require `If-Match`/`expectedDraftRevision` and never mutate a published revision.

```ts
type WorkflowDraftV1 = {
  schemaVersion: 1;
  workflowId?: string;
  slug: string;
  displayName: string;
  nodes: WorkflowNodeV1[];
  edges: WorkflowEdgeV1[];
};

type WorkflowNodeV1 = {
  nodeId: string;
  businessId: string;
  businessVersion: string;
  manifestDigest: string;
  action: string;
  actionSchemaDigest: string;
  inputSchemaDigest: string;
  outputSchemaDigest: string;
  configDefaults: Record<string, JsonValue>;
  inputBindings: NodeInputBindingV1[];
};

type WorkflowEdgeV1 = {
  fromNodeId: string;
  toNodeId: string;
};

type NodeInputBindingV1 = {
  targetPointer: string; // RFC 6901 JSON Pointer into this action's input
  source:
    | { kind: 'trigger_input'; pointer: string }
    | { kind: 'node_output'; nodeId: string; pointer: string }
    | { kind: 'literal'; value: JsonValue };
};

type WorkflowRevisionV1 = {
  workflowId: string;
  tenantId: string;
  revision: number;
  digest: string;
  spec: WorkflowDraftV1;
  createdAt: string;
  publishedAt: string;
};
```

For V1, every node must have the same `businessId`, `businessVersion`, and `manifestDigest`, and every action must exist in that exact manifest. At publish there must be at least two nodes. The graph is a single ordered chain with exactly one start and end, `edges.length === nodes.length - 1`, and no node has more than one predecessor or successor. The schema remains explicit about nodes and edges so later versions can add graph semantics without changing V1 meaning; branch, parallel, conditional, and join behavior are not encoded in V1.

### Workflow storage proposal

```text
workflows
  workflow_id uuid primary key
  tenant_id uuid not null references tenants(id)
  slug text not null
  display_name text not null
  created_at timestamptz not null
  created_by uuid not null
  unique (tenant_id, slug)

workflow_drafts
  workflow_id uuid primary key references workflows(workflow_id)
  draft_revision integer not null check (draft_revision > 0)
  base_published_revision integer null
  spec jsonb not null
  etag text not null
  updated_at timestamptz not null
  updated_by uuid not null

workflow_revisions
  workflow_id uuid not null references workflows(workflow_id)
  revision integer not null check (revision > 0)
  digest text not null
  spec jsonb not null
  created_at timestamptz not null
  created_by uuid not null
  published_at timestamptz not null
  primary key (workflow_id, revision)
  unique (workflow_id, digest)
```

The canonical digest covers `schemaVersion`, slug, node order, all node pins/config defaults/input bindings, and edges using the contracts package canonical JSON hashing. Draft `etag` changes on every accepted edit. Publish validates against the exact immutable registry manifests, inserts one revision, and leaves the draft available for a subsequent edit. Rollback creates a new process binding to a prior exact published revision; it never edits a published graph. Any future workflow retirement state belongs to the workflow definition/admission policy, not to an immutable revision.

### Required validator behavior

Validation runs server-side on save and again at publish/admission. Client validation is only a convenience. The report uses stable `code`, `path`, `nodeId`, and optional `edge` identifiers, with no secret values:

```ts
type WorkflowValidationIssue = {
  code: string;
  path: string; // JSON Pointer into WorkflowDraftV1
  message: string;
  nodeId?: string;
  relatedNodeIds?: string[];
};

type WorkflowValidationResponse = {
  valid: boolean;
  issues: WorkflowValidationIssue[];
  resolvedPins: Array<{
    nodeId: string;
    businessId: string;
    businessVersion: string;
    manifestDigest: string;
    action: string;
    actionSchemaDigest: string;
  }>;
  graphDigest?: string;
};
```

The validator must:

1. Parse a bounded JSON payload with strict keys, unique valid `nodeId`s, unique edges, and configured maximum node/edge/payload limits. Keep the limits server-owned; do not accept a client-provided execution budget.
2. Resolve each exact business version and manifest digest. Reject missing/retired/unavailable versions and actions, schema digest mismatches, cross-business nodes, and any workflow target while Δ-DEV-03 is closed.
3. Verify every edge endpoint exists, reject self-edges and duplicate edges, run a topological-sort cycle check, and produce a stable cycle path when possible. Then enforce V1 chain constraints: one start, one end, `n-1` edges, no fan-out/fan-in, and at least two nodes for publish.
4. Validate each target JSON Pointer against the node input schema. Validate trigger pointers against the workflow trigger schema, and node-output pointers against the source action output schema. A node-output source must have an edge/path to the consumer and must precede it in topological order; future-node references are invalid.
5. Check type compatibility using a deliberately bounded JSON Schema subset. Required input fields must be supplied by exactly one binding or a validated default; reject unknown/duplicate target paths, incompatible nullable/union types, and literals that fail the target schema. Do not evaluate JavaScript, arbitrary expressions, templates, or manifest-supplied code.
6. Validate `configDefaults` against the exact action profile/config schema and connector slot declarations. Reject undeclared slots and ensure effective profile overrides remain within the same schema.
7. Recompute all manifest/action/schema digests server-side. Never trust digest fields supplied by the browser as proof that a target is current.

Cycles are rejected even though V1 requires a chain. This keeps the graph contract safe for drafts and future topology versions, while the V1 runtime remains strictly sequential. A limit such as maximum node count must be set from the operation/runtime budget before implementation; this report does not invent a numerical limit.

## Profile adapter and immutable execution pins

### Adapter DTO proposal

Keep `ProfilePolicy` and its current action key unchanged. Add a separate contract, implemented under UBW-06 after UBW-04 freezes the workflow reference shape:

```ts
type WorkflowProfileAdapterDraftV1 = {
  schemaVersion: 1;
  adapterId?: string;
  name: string;
  workflow: { workflowId: string; revision: number; digest: string };
  nodes: Array<{
    nodeId: string;
    actionProfile: {
      businessId: string;
      businessVersion: string;
      profileName: string;
      action: string;
      revision: number;
      policyDigest: string;
    };
    overrides: Record<string, JsonValue>;
    connectorBindings: Record<string, { connectorId: string; revision: number }>;
    promptRevision?: { promptId: string; revision: number; digest: string };
  }>;
};
```

An adapter must cover every workflow node exactly once, and each referenced action profile must match that node's business/version/action and be enabled for the tenant. `overrides` validate against the pinned node profile schema; connector and prompt references resolve to immutable revisions. Secret values never appear in this DTO or in run responses. The adapter has immutable revisions plus an active revision pointer; editing or rollback changes only future submissions. A run request names an exact adapter revision; API-key authorization must grant that adapter, and its workflow pin must equal the process alias target. If the existing API-key contract provides a single profile implicitly, the server may derive the adapter reference from that authenticated grant instead of accepting it in the body, but it must resolve and snapshot one exact revision before admission.

### Operation snapshot

Extend the operation execution contract with a versioned workflow snapshot reference. At submission, persist an immutable `WorkflowExecutionSnapshotV1` (or a content-addressed row referenced from the operation):

```ts
type WorkflowExecutionSnapshotV1 = {
  snapshotVersion: 1;
  tenantId: string;
  process: { processId: string; alias: string; bindingRevision: number; bindingDigest: string };
  workflow: { workflowId: string; revision: number; digest: string };
  profileAdapter: { adapterId: string; revision: number; digest: string };
  nodes: Array<{
    nodeId: string;
    businessId: string;
    businessVersion: string;
    manifestDigest: string;
    action: string;
    actionSchemaDigest: string;
    inputBindings: NodeInputBindingV1[];
    effectiveConfig: Record<string, JsonValue>;
    actionProfile: { profileName: string; revision: number; policyDigest: string };
    connectorBindings: Record<string, { connectorId: string; revision: number }>;
    promptRevision?: { promptId: string; revision: number; digest: string };
  }>;
  snapshotDigest: string;
};
```

The snapshot is created transactionally with root operation admission and stores no raw credentials or API key secret. Every child action is derived only from this snapshot, never from current aliases, `latest`, mutable profile heads, or later manifest changes. Persist the snapshot digest and schema version; reject execution if the stored digest fails validation. The root operation response includes the process alias/binding revision, workflow revision, adapter revision, and snapshot digest so operators can identify exactly what ran.

## Runtime execution and operation states

The existing names `WAITING_CHILDREN` and `WAITING_INPUT` are reusable vocabulary, not proof that current runtime transactions provide workflow execution. Before coding, inspect the leased operation implementation after WFA-02 is released and verify the transition/locking semantics. The proposal is:

```text
root operation QUEUED
  → RUNNING: claim immutable snapshot and validate admission pins
  → WAITING_CHILDREN: one action child is submitted from the next chain node
  → RUNNING: child succeeded, its output reference is persisted, next node becomes eligible
  → ... repeat sequentially ...
  → SUCCEEDED: final node output is persisted and root result is projected

Child retryable failure: child follows existing retry policy; root remains WAITING_CHILDREN.
Child terminal failure: root becomes FAILED with failedNodeId and safe error code.
WAITING_INPUT: only an explicit supported external/manual wait; it is not used for normal
               node-to-node mapping. Resume must validate operation, tenant, node, snapshot,
               and one-time wait/idempotency token before making the parent runnable.
```

Each node execution has a stable key `(rootOperationId, workflowRevision, nodeId)` and a monotonic attempt. Creating the child, recording the node/child relation, and moving the parent to `WAITING_CHILDREN` must be atomic or safely idempotent; a crash/retry must not execute a completed provider stage twice. Child success persists an output artifact/reference before the parent can schedule the next node. Pass only mapped values, with schema validation and configured size/time/resource limits. Node events expose state and redacted references, not raw secrets or unbounded payloads.

For an explicit wait, use the existing wait-input primitive only after proving its durable-resume and idempotency behavior. V1 does not add a “wait” node to the builder unless that contract is verified. Cancellation, lease recovery, retries, and resume must follow the existing operation policy; do not invent cascade cancellation or claim a worker stopped without acknowledgement. Parent and child status transitions need a single server-side state machine with compare-and-swap and audit events.

Recommended node status projection (not a replacement for operation status): `PENDING`, `READY`, `RUNNING`, `WAITING_INPUT`, `SUCCEEDED`, `FAILED`, `CANCELLED`. Root operation status remains the public operation state. Do not add new root statuses until the existing status contract is reviewed and consumers are inventoried.

## Admin/public DTO surface and error behavior

Potential admin workflow routes, unavailable until Δ-DEV-03 is explicitly opened:

| Method and path | Purpose |
|---|---|
| `GET /api/v1/admin/workflows?tenantId=&cursor=&limit=` | List definitions with latest published revision and draft status. |
| `POST /api/v1/admin/workflows` | Create definition and initial draft. |
| `GET /api/v1/admin/workflows/{workflowId}` | Read definition, draft metadata, and published revision list. |
| `PUT /api/v1/admin/workflows/{workflowId}/draft` | Update draft with `If-Match`/expected draft revision. |
| `POST /api/v1/admin/workflows/{workflowId}/validate` | Return `WorkflowValidationResponse`; no writes or publish. |
| `POST /api/v1/admin/workflows/{workflowId}/publish` | Revalidate and atomically create immutable published revision using CAS. |
| `GET /api/v1/admin/workflows/{workflowId}/revisions/{revision}` | Read immutable graph and pins. |

Problem codes should be stable and non-sensitive: `INVALID_WORKFLOW_GRAPH` (422 with JSON Pointer issues), `WORKFLOW_REVISION_CONFLICT` (409 with current authorized revision), `WORKFLOW_NOT_PUBLISHED`, `WORKFLOW_GATE_CLOSED`, `PROCESS_BINDING_REVISION_CONFLICT`, `PROCESS_TARGET_UNAVAILABLE`, `ACTION_SCHEMA_CHANGED`, and `PROFILE_ADAPTER_MISMATCH`. Do not return cross-tenant existence or schema data on 403/404. On public run submission, an idempotency key returns the original root operation when the request digest matches; key reuse with different body is a conflict.

## Exact proposed file leases and sequencing

The following are future, non-overlapping leases, not authorization to edit now. The dispatcher must refresh the live roster and lease status before dispatch. WFA-02/WFA-03 files and current owners remain untouched until explicitly released. UBW-02A/02B registration work is a prerequisite for the runtime portions; its proposed `0039_worker_instances.sql` means workflow migration numbering below is conditional on that migration becoming the actual head.

### UBW-04A — freeze schemas/DTOs

Sole shared-contract owner; wait until WFA-03 releases contract files. Lease exactly:

- `orchestrator/packages/contracts/src/process-binding.ts` — new process alias/target/request/response schemas.
- `orchestrator/packages/contracts/src/workflow.ts` — new draft, node, edge, mapping, revision, and validation DTOs.
- `orchestrator/packages/contracts/src/workflow-execution.ts` — new adapter reference, operation snapshot, and node-run projection DTOs.
- `orchestrator/packages/contracts/src/index.ts` — exports only these new contracts.
- `orchestrator/services/orchestrator/tests/process-workflow-contracts.test.ts` — strict parsing, discriminated target, JSON Pointer, and round-trip contract tests.

This packet does not edit `legacy-workflow.ts`, `runtime.ts`, `operations.ts`, or any WFA-owned contract. If integration proves an existing contract file must change, stop and issue a new exact lease rather than expanding this one.

### UBW-04B — storage and deterministic validation

After 04A contracts are frozen and migration head is rechecked, lease exactly:

- `orchestrator/services/orchestrator/migrations/0040_process_aliases.sql` — alias, immutable binding revisions, and CAS head.
- `orchestrator/services/orchestrator/migrations/0041_workflow_definitions.sql` — definition, mutable draft, immutable published revisions.
- `orchestrator/services/orchestrator/src/modules/processes/process-bindings.ts` — alias normalization, target resolution, idempotency, CAS.
- `orchestrator/services/orchestrator/src/modules/workflows/workflow-store.ts` — draft/revision persistence and digest verification.
- `orchestrator/services/orchestrator/src/modules/workflows/graph-validator.ts` — V1 graph, cycle, schema/mapping, and pin validation.
- `orchestrator/services/orchestrator/tests/process-bindings.test.ts`.
- `orchestrator/services/orchestrator/tests/workflow-graph-validator.test.ts`.

No admission/runtime changes in this packet. Migration numbers must be rebased if UBW-02 or another approved migration advances the head; never reuse an occupied number or edit an applied migration.

### UBW-04C — operation snapshot and node execution persistence

Only after WFA-02 releases operation files and the operation state-machine review passes; lease exactly:

- `orchestrator/services/orchestrator/migrations/0042_workflow_execution_snapshots.sql` — immutable snapshot keyed by root operation, tenant, and snapshot digest.
- `orchestrator/services/orchestrator/migrations/0043_workflow_node_executions.sql` — node attempt/child operation relation and durable node status/output reference.
- `orchestrator/services/orchestrator/src/modules/workflows/workflow-executor.ts` — sequential orchestration from frozen pins.
- `orchestrator/services/orchestrator/src/modules/operations/submission.ts` — transactional root admission and snapshot creation.
- `orchestrator/services/orchestrator/src/modules/operations/facade.ts` — integrate workflow admission without changing legacy action submission semantics.
- `orchestrator/services/orchestrator/src/http/routes/runtime.ts` — only if a required child/wait runtime call needs a route contract change; exact hunk scope must be written in dispatch proof.
- `orchestrator/services/orchestrator/tests/workflow-executor.test.ts`.
- `orchestrator/services/orchestrator/tests/workflow-operation-pinning.test.ts`.

This lease explicitly waits for WFA-02 release of `src/modules/operations/**` and does not include `src/http/routes/public.ts` or `packages/contracts/src/runtime.ts`; any need to modify either requires a separate follow-on lease. The executor must first prove child-create/state-transition atomicity, retries, lease loss, output persistence, and wait/resume idempotency in offline tests. If those guarantees cannot be implemented through the listed paths, stop and re-scope before adding routes.

### UBW-04D — route/admission integration

After 04A–04C contracts and server semantics are accepted, and after checking current route/BFF leases, lease exactly:

- `orchestrator/services/orchestrator/src/http/routes/processes.ts` — admin alias CRUD/binding routes.
- `orchestrator/services/orchestrator/src/http/routes/workflows.ts` — admin draft/validate/publish routes, guarded by Δ-DEV-03.
- `orchestrator/services/orchestrator/src/http/routes/public-processes.ts` — public alias run admission; must derive tenant from principal.
- `orchestrator/services/orchestrator/src/http/route-context.ts` — inject process/workflow services and gate policy.
- `orchestrator/services/orchestrator/src/app/bootstrap/create-app.ts` — compose the services.
- `orchestrator/services/orchestrator/src/server.ts` — mount the three route modules only behind required auth and gate policy.
- `orchestrator/services/orchestrator/src/app/admin/bff/processes.ts` — new BFF relay/validation for process UI.
- `orchestrator/services/orchestrator/src/app/admin/bff/workflows.ts` — new BFF relay/validation for future gated workflow UI.
- `orchestrator/services/orchestrator/src/app/admin/bff/handle.ts` — dispatch to the two new BFF modules.
- `orchestrator/services/orchestrator/tests/process-workflow-routes-offline.test.ts`.
- `orchestrator/services/orchestrator/tests/workflow-gate-closed.test.ts`.

No changes to existing `admin.ts`, `public.ts`, `operations.ts`, or UI files are included. A route must fail closed when the gate service cannot be read. Contract APIs may be implemented behind the gate, but route registration and all indirect process-to-workflow resolution must enforce the gate server-side.

### Explicitly separate UBW-06 profile adapter lease

Profile persistence and the current screen are separate from UBW-04. Keep adapter implementation in UBW-06 with a separate owner and a sequential lease after 04A/04D release and the migration head is rechecked. Proposed exact paths are:

- `orchestrator/packages/contracts/src/workflow-profile-adapter.ts` — new adapter draft/revision schemas; export from `src/index.ts` under a later exclusive lease.
- `orchestrator/services/orchestrator/migrations/0044_workflow_profile_adapters.sql` — adapter identity, immutable revisions, and active-revision head; renumber if the accepted migration head has moved.
- `orchestrator/services/orchestrator/src/modules/profiles/workflow-adapter.ts` — adapter validation and immutable persistence, without changing legacy profile semantics.
- `orchestrator/services/orchestrator/src/http/routes/workflow-profiles.ts` — tenant-scoped adapter endpoints.
- `orchestrator/services/orchestrator/src/app/admin/bff/workflow-profiles.ts` — BFF relay and validation.
- `orchestrator/services/orchestrator/src/http/route-context.ts`, `src/app/bootstrap/create-app.ts`, `src/server.ts`, and `src/app/admin/bff/handle.ts` — integration seams, leased only after the earlier route packet releases them.
- `orchestrator/apps/admin-web/src/features/profiles/profiles-screen.tsx` — adapter UI; keep existing action-profile path intact.
- `orchestrator/services/orchestrator/tests/workflow-profile-adapter.test.ts` and `orchestrator/services/orchestrator/tests/workflow-profile-adapter-offline.test.ts`.

Do not modify `profile-policy.ts`, `profiles.ts`, or `profiles-screen.tsx` under UBW-04. This report recommends that each adapter node reference an existing action-profile/API-key binding, and that the UI show one effective-permission preview. Confirm this permission model before dispatch; a workflow-owned API-key permission is a different contract.

## Acceptance criteria and unresolved contract questions

Before a packet is considered ready for implementation, acceptance should require:

- Alias uniqueness and tenant isolation, immutable binding history, exact action/workflow target pins, CAS conflicts, and unchanged legacy aliases.
- A same-business, same-version workflow with at least two actions executes in order; data from one node reaches the next only through a schema-validated mapping. Cross-business, mixed-version, branch, parallel, and join attempts fail closed in V1.
- Cycle detection, invalid/missing node/action/schema, unsupported JSON Schema forms, missing required mapping, incompatible types, and stale manifest digests produce stable issue paths and never publish.
- A published workflow and profile adapter revision cannot be edited in place. A root operation remains tied to its process binding, workflow, action profiles, connector/prompt revisions, config, and snapshot digest after later changes.
- Parent/child state transitions survive duplicate submit, worker lease loss, restart, retry, and explicit wait resume without repeating a completed provider stage or inventing a terminal result.
- Δ-DEV-03 is enforced by server admission and indirect process target resolution, not only by a hidden UI control.

Open items to resolve before implementation: reconcile exact legacy `schemaSlug`/process alias mapping after WFA-02 release; confirm whether V1 truly requires all nodes to use the same exact version (recommended here) or permits multiple exact versions of one business; confirm a server-owned max graph size and supported JSON Schema subset; verify whether existing `WAITING_CHILDREN`/`WAITING_INPUT` primitives provide the required durability/atomicity; settle the future authority and acceptance condition for explicitly opening Δ-DEV-03. None of these are resolved by this analysis or by an implementation claim.
