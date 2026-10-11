# UBW-05-PRE — Workflow UI builder and publish design analysis

## Scope and evidence boundary

This is a design analysis for `du-rework` only. I read the canonical plan, UBW-00 inventory, UBW-01 UI design, UBW-02 registration analysis, UBW-03 catalog/UI analysis, UBW-04 workflow contract, and UBW-06 profile-binding analysis. I also read the current Workflows route, screen, API client/types, and the BFF workflow read handler to check whether the earlier inventory still matches the working tree. No product code or test code was changed; no tests, build, browser session, or database session was run.

The builder is a post-gate design. D-UBW-4 remains fail-closed until an explicit user order authorizes opening `Δ-DEV-03`; this task does not provide that order. The UI must not infer authorization from a route existing, an API responding, or a feature being implemented. If gate state cannot be established from an approved authoritative source, treat it as closed.

## Decisions and current-tree reconciliation

The design preserves these constraints from the inputs:

| Decision | Builder consequence |
|---|---|
| D-UBW-1 — alias-first process binding | The builder creates a workflow definition and exact published revisions. Process aliases remain the stable invocation names and bind to an exact workflow revision through the separate process-binding contract. The builder does not create a second process/node registry. |
| D-UBW-2 — same-business multi-action V1 | Every V1 node uses the same exact `businessId`, `businessVersion`, and `manifestDigest`; a published workflow has at least two actions and forms one sequential chain. Cross-business, mixed-version, branch, parallel, and join authoring are unavailable. |
| D-UBW-3 — adapter binding for profiles | Workflow graph configuration is limited to declarative workflow defaults and input mappings. Action-profile selection, connector/prompt overrides, credentials, and effective per-node runtime settings belong to the separate UBW-06 adapter UI. |
| D-UBW-4 — gate stays closed | While closed, render only gate guidance, make no workflow list/schema/draft/validation/publish request, and reject direct route calls server-side. A gate-check request may read policy only; it must not read workflow resources. A failed or missing gate check is closed. |

There is a material mismatch between the earlier inventory/design receipts and the current source I inspected. UBW-00 and UBW-01 describe the Workflows screen as disabled and data-free, but the current `WorkflowsScreen` calls `listWorkflows()` from its mount effect (`orchestrator/apps/admin-web/src/features/workflows/workflows-screen.tsx:216-267`), offers preset provisioning and JSON import (`:276-334`), retires catalog entries (`:336-360`), and offers a test action with a local `SIMULATED_SUCCESS` fallback (`:376-414`). The current API client has the older `WorkflowCatalogItem`/catalog shape (`orchestrator/apps/admin-web/src/lib/api/types.ts:540-564`) and `listWorkflows`/`provisionWorkflow` calls (`client.ts:180-183,464-473`). The BFF dispatches `/admin/api/workflows` to a GET-only handler that relays `/api/v1/admin/workflows` (`orchestrator/services/orchestrator/src/app/admin/bff/handle.ts:110-112,387-435`).

That is not the UBW-04 graph draft/publish contract and does not demonstrate that `Δ-DEV-03` is open. The inspected Workflows screen contains no `Δ-DEV-03` gate check. Therefore the current tree cannot be described as fail-closed based on the old receipts alone. This report records the discrepancy as a prerequisite for coordinator review; it does not modify or disable the existing path. Before a builder implementation is dispatched, the gate owner must reconcile the legacy catalog/provision/test path with D-UBW-4 and establish server-side gate enforcement for both legacy and new routes. Do not reuse the local simulated test result as execution evidence.

## Route architecture while the gate is closed

Keep the existing `/workflows` route and navigation entry, but put the gate decision ahead of any workflow resource component:

```text
WorkflowsRoute
└── WorkflowGateController
    ├── GateClosedPanel             // default, closed, or policy unavailable
    └── WorkflowWorkspace           // mounted only after authorized opening
        ├── WorkflowCatalogList
        └── WorkflowBuilderScreen
```

The closed route may show the gate identifier, a clear statement that no workflow data was loaded, and the authority/process needed to open it once that is supplied by the coordinator. It must not render an empty catalog, mount `WorkflowWorkspace` offscreen, or let an effect in a child fetch workflow data before the gate resolves. If policy has a dedicated read endpoint, the response should contain only gate status and a safe reason; it must not be inferred from workflow-list success. The client gate is a usability boundary only: the backend and BFF must enforce the same gate on list, definition, draft, validation, publish, revision, and indirect process-to-workflow admission routes.

After an explicit user order and accepted route/contract readiness, the workspace uses a tenant-scoped catalog and a dedicated builder. Tenant scope is required for writes and is derived/authorized by the server. A platform-wide list is not a fallback for a missing tenant. Preserve the current shell and route; `router.tsx` already mounts `WorkflowsRoute` (`orchestrator/apps/admin-web/src/router.tsx:1-56`) and the shell already has workflow navigation according to UBW-00. No shell or router rewrite is needed for the builder unless a separate navigation decision changes.

## Builder screen architecture

The post-gate screen is a linear workflow editor, not a general-purpose graph designer. It has three coordinated areas:

```text
Workflow / Northwind / invoice-processing       Draft r3 · Unsaved
[Save draft] [Validate] [Publish]

Action palette                 Sequential workflow
Business: [document-core]      [parse] ──> [extract] ──> [redact]
Version:  [1.2.0]               selected node: extract
Available actions              ┌ Inputs / mappings ───────────────┐
  parse-document                │ document ← parse.output.text   │
  extract-invoice               │ locale    ← trigger.locale      │
  redact-output                 └ Config defaults / schema pins ──┘

Validation: 3 nodes · 2 edges · no cycles · 1 missing required input
```

`WorkflowBuilderScreen` owns the tenant, definition/draft lifecycle, selection, and orchestration. `WorkflowBuilderHeader` shows tenant, slug/name, draft revision, dirty/saving state, last successful load, validation freshness, and the primary actions. `WorkflowCatalogList` separates drafts from published revisions and opens a definition without equating latest with the target of an existing process alias. `WorkflowRevisionHistory` shows immutable revisions, digest, publish time, and a structural diff; it offers “Create draft from revision” rather than in-place revision editing.

`WorkflowFeaturePalette` is populated from the exact business-version manifest detail API proposed by UBW-03. It presents only declared manifest actions and their schemas/capabilities. The first node chooses a business and exact version; subsequent nodes are constrained to that same pair and digest. The client does not use preset samples or static action enums as the catalog. It displays server-derived schema pins and never computes or submits digests as authority. Unsupported JSON Schema constructs remain visible as unsupported metadata and cannot be added or published until the server validator supports them. A catalog fetch failure is an error state, not an empty palette.

`WorkflowChainCanvas` renders an accessible ordered chain with explicit node cards and arrows. It may use a compact canvas-like visual, but every add, remove, select, connect, and reorder operation also has keyboard-accessible controls and a labelled list representation. V1 has one start and one end, `edges.length === nodes.length - 1`, and no fan-in or fan-out. Do not render branch, join, conditional, parallel, or cross-business controls. A node card shows action, exact business/version, digest/pin status, input/output summary, and validation badges. Removing or reordering a node must visibly update affected edges and mappings in the draft; it must never silently discard a mapping.

`WorkflowNodeInspector` separates immutable action identity/schema pins from editable workflow fields. Its “Input mapping” section is `WorkflowInputMappingForm`; “Config defaults” is a schema-limited, declarative editor only. Do not put action-profile selection, credentials, connector secrets, prompt overrides, or effective runtime policy here; those belong to the UBW-06 workflow-profile adapter. A workflow's `configDefaults` are part of the immutable graph revision, while runtime/profile overrides are separate adapter data.

## Node connections and input/output mapping

The UBW-04 contract has two related but distinct concepts: `WorkflowEdgeV1 { fromNodeId, toNodeId }` records execution order/dependency, while a target node's `inputBindings` carries the actual value mapping. The UI must not make an edge imply that every output field flows into every input.

For a connection, the operator selects a source node and declared output pointer, then a target node and input pointer. In V1, the source node must be earlier in the ordered chain and connected to the target by the chain path. The mapping form also offers declared trigger-input pointers and a literal JSON value where allowed by the target schema. Store mappings using JSON Pointer fields exactly as the contract specifies:

```ts
type NodeInputBindingV1 = {
  targetPointer: string;
  source:
    | { kind: 'trigger_input'; pointer: string }
    | { kind: 'node_output'; nodeId: string; pointer: string }
    | { kind: 'literal'; value: JsonValue };
};
```

Show user-facing property labels from the schema, but retain the JSON Pointer as the saved identity. Required inputs must have exactly one mapping or a validated default; reject duplicate/unknown target paths and future-node references. Type compatibility and literal validation use the same bounded schema subset as the server. Do not add expression templates, JavaScript, implicit coercion, or arbitrary manifest code. Explain a schema mismatch at the target node/input and identify the source node/output when possible.

## Client-side graph validation

Client validation is immediate feedback and never the publication authority. Keep a pure validator over the current `WorkflowDraftV1` and run it after node/edge/mapping edits and before enabling the explicit Validate action:

1. Check unique, syntactically valid node IDs; unique edges; existing edge endpoints; no self-edges; and node/edge counts against server-provided or contract-owned bounds.
2. Detect cycles with a topological sort (Kahn's algorithm) and, for a rejected edge, optionally test whether a path already exists from the proposed target back to its source. Report a stable cycle path and map it to the affected edge/node cards.
3. Check the V1 chain shape: at least two nodes for publish, exactly one start/end, `n - 1` edges, and at most one predecessor/successor per node. Because the editor is sequential, prevent a cycle/fork as the user connects nodes and keep the invalid state visible if it arrives from a server draft.
4. Check mapping structure locally: pointers parse, target pointers are unique, sources are prior/connected, and known primitive types are compatible. Use schema-derived checks only for the supported subset; mark unresolved checks as “server validation required.”
5. Associate validation results with a canonical local draft fingerprint. Any edit makes the last server validation stale; never reuse “valid” from a previous graph.

Client checks can be bypassed, use incomplete cached schemas, or differ across versions. The server must recompute digests, resolve exact manifests, validate cycle/chain/mappings and limits during save/validate and again at publish. Only server issues are authoritative for publish; the UI never treats a client-side green badge as a publish guarantee.

## Draft, publish, reload, and revision lifecycle

The typed UI API should follow UBW-04's proposed endpoints after their server/BFF contracts are accepted: list definitions; create a definition and initial draft; read a definition; update the draft with `If-Match`/`expectedDraftRevision`; validate; publish; and read an exact immutable revision. Model the draft editor as two copies: the last server-confirmed draft plus a local working copy. Keep the server revision/ETag used as the CAS base, local dirty state, selected node, and validation fingerprint separately.

1. On entry, resolve tenant and gate first. After the gate is open, load the catalog and selected draft/revision. Do not show “No workflows” until a successful catalog response returns no items.
2. Editing changes only the local copy. Save sends the entire strict `WorkflowDraftV1` or an explicitly specified patch with the expected draft revision. The service validates shape and pins and advances the draft with CAS; it does not mutate published revisions.
3. Validate sends the saved/current draft to the server. Show `WorkflowValidationResponse` issues by `path`, `nodeId`, and related nodes, and show server-resolved pins. Tie the result to the submitted draft fingerprint; edits immediately mark it stale.
4. Publish is enabled only for an online, authorized, current draft with a successful server validation and no pending save. The server revalidates all exact manifest/schema/action pins and tenant/gate constraints, then atomically creates the next immutable revision with a server-computed digest. Use expected revision/CAS and idempotency as specified by the accepted API.
5. After publish acknowledgement, fetch the exact returned `(workflowId, revision)` and the definition summary. Only then show “Published rN” and update history from authoritative reads. If the mutation was acknowledged but reload fails, say that publication was accepted but current state could not be refreshed; do not optimistically mark a revision current. After an ambiguous network result, resolve the same idempotency key/result before offering a second publish.
6. On 409, preserve all local edits, show server and local revisions plus a node/mapping diff, and require explicit compare/reload/reapply. Do not last-write-wins or retry against the new head automatically. On 422, keep the draft and map issues to fields. On 403, do not disclose foreign workflow details.

Published graph revisions are immutable. “Rollback” in this screen means creating a new draft from a prior published revision and publishing it as a new revision; it does not rewrite history. A process alias that should point back to a prior workflow revision gets a new process-binding revision under D-UBW-1. A workflow-profile adapter remains pinned to its exact old workflow revision; moving it is a separate UBW-06 adapter revision and preview. The builder must not silently repoint aliases or adapters when a workflow is published.

## Loading, empty, error, permission, conflict, and offline states

| State | Required behavior |
|---|---|
| Gate closed | Show only policy status and the explicit-order requirement. No catalog, schema, draft, validate, publish, or adapter request. |
| Gate unavailable | Remain closed and show that policy could not be verified; provide a safe retry for the gate check only. |
| Loading | Separate catalog, workflow definition, exact business manifest, and selected draft loading states. Do not convert a partial dependency error into an empty list. |
| Empty | Distinguish no workflows in the successfully loaded tenant, no published revisions, no compatible actions for the selected business/version, and no eligible input/output fields. Create is shown only when authorized and online. |
| Error | Retain the draft and selection. Identify whether catalog, manifest, draft, server validation, save, publish, or reload failed. Never display a simulated execution success. |
| 403 | Show permission denial without leaking resource names, schemas, or revisions that were not authorized. Preserve tenant scope; no platform fallback. |
| 409 | Retain local edits, display the current server revision/ETag and a structural diff, and require an explicit reload or reapply. |
| Offline | Gate stays closed if gate state has not been confirmed. With an already-open gate and cached data, allow read-only inspection marked stale; disable manifest-dependent validation, save, publish, and any test/run action. Do not queue writes. |

The builder is authoring only. Test & Runs submission/operation monitoring remains its separate screen and must use a published workflow-profile adapter as described by UBW-01/UBW-06. The builder must not present a synthetic operation ID, simulated result, or raw unsafe payload as execution evidence.

## Proposed exact file leases and sequence

These are recommendations only, not edit authorization. The canonical plan requires the dispatcher to refresh active leases before assignment. Shared files must be sequenced, especially because UBW-04D owns workflow route seams and UBW-06E later needs the same API client/types files.

| Packet | Exact proposed paths | Boundary and dependency |
|---|---|---|
| Gate reconciliation prerequisite | `orchestrator/apps/admin-web/src/routes/workflows.tsx`; `orchestrator/apps/admin-web/src/features/workflows/workflows-screen.tsx`; `orchestrator/services/orchestrator/src/app/admin/bff/handle.ts`; `orchestrator/services/orchestrator/src/app/admin/bff/operations.ts`; `orchestrator/services/orchestrator/src/http/routes/admin.ts`; new `orchestrator/services/orchestrator/src/http/routes/workflows.ts` from UBW-04D; `orchestrator/services/orchestrator/src/http/route-context.ts`; `orchestrator/services/orchestrator/src/app/bootstrap/create-app.ts`; `orchestrator/services/orchestrator/src/server.ts`; new `orchestrator/services/orchestrator/tests/workflow-gate-closed.test.ts` | Coordinator assigns one backend/UI integration owner after checking current leases. Reconcile the legacy catalog/provision/test routes and new UBW-04 routes so the closed gate blocks both. Several backend paths overlap UBW-04D; do not run this packet concurrently with 04D. This prerequisite does not authorize opening the gate. |
| UBW-05A — builder and API client | Existing `orchestrator/apps/admin-web/src/features/workflows/workflows-screen.tsx`; new `orchestrator/apps/admin-web/src/features/workflows/workflow-builder-screen.tsx`; new `orchestrator/apps/admin-web/src/features/workflows/workflow-builder-state.ts`; new `orchestrator/apps/admin-web/src/features/workflows/workflow-catalog-list.tsx`; new `orchestrator/apps/admin-web/src/features/workflows/workflow-builder-header.tsx`; new `orchestrator/apps/admin-web/src/features/workflows/workflow-feature-palette.tsx`; new `orchestrator/apps/admin-web/src/features/workflows/workflow-chain-canvas.tsx`; new `orchestrator/apps/admin-web/src/features/workflows/workflow-node-card.tsx`; new `orchestrator/apps/admin-web/src/features/workflows/workflow-node-inspector.tsx`; new `orchestrator/apps/admin-web/src/features/workflows/workflow-input-mapping-form.tsx`; new `orchestrator/apps/admin-web/src/features/workflows/workflow-validation-panel.tsx`; new `orchestrator/apps/admin-web/src/features/workflows/workflow-revision-history.tsx`; `orchestrator/apps/admin-web/src/lib/api/types.ts`; `orchestrator/apps/admin-web/src/lib/api/client.ts` | Start only after UBW-04A DTOs and UBW-04D API/BFF behavior are accepted and released, and after explicit gate authorization. Keep `routes/workflows.tsx`, router, and shell unchanged unless the approved navigation contract requires a separate lease. UI API methods/types are additive and must be released before UBW-06E edits the same client/types files. |
| UBW-05B — focused UI verification | A new test harness and `orchestrator/apps/admin-web/src/features/workflows/workflow-builder.test.tsx`; if an offline route/API test is needed, a new `orchestrator/services/orchestrator/tests/workflow-builder-bff-offline.test.ts` | Current `apps/admin-web` file inventory has no test/spec files and its package scripts expose typecheck/build but no test command. Verify available harness and acquire a separate exact config/package lease before introducing one. This task does not claim a UI test already exists. UBW-07 remains the independent browser/runtime verification packet. |

The UI lease does not include `packages/contracts`, backend workflow storage/validation, BFF route implementation, profile UI/admission, process aliases, or `Δ-DEV-03` policy changes. Shared contract/API/server route changes remain with UBW-04A/04D owners. UBW-06E owns the later workflow-adapter panel and must not be merged into the graph editor lease.

## Readiness and evidence gaps

Before implementation, the coordinator should resolve the current-tree gate discrepancy, confirm the explicit authority/order required by D-UBW-4, accept UBW-04's strict `WorkflowDraftV1`/validation contract and exact schema-digest derivation, and ensure UBW-03's exact-version manifest API is available. Confirm the actual migration/API head and current route owners; reports describe proposals, not proof those endpoints now exist. Agree how an unsaved graph handles unsupported schema fields and how server limits are exposed. Keep process alias publication, action-profile adapter settings, and run submission as separate lifecycle steps.

Evidence read for this analysis: `coordination/PLAN-UI-BUSINESS-WORKFLOW-2026-10-08.md`; `coordination/reports/ubw-00-inventory.md`; `ubw-01-ui-design.md`; `ubw-02-registration.md`; `ubw-03-catalog-ui.md`; `ubw-04-workflow-contract.md`; `ubw-06-profile-binding.md`; current `orchestrator/apps/admin-web/src/features/workflows/workflows-screen.tsx:216-414`; `orchestrator/apps/admin-web/src/routes/workflows.tsx:1-5`; `orchestrator/apps/admin-web/src/router.tsx:1-56`; `orchestrator/apps/admin-web/src/lib/api/client.ts:180-183,464-473`; `orchestrator/apps/admin-web/src/lib/api/types.ts:540-564`; `orchestrator/services/orchestrator/src/app/admin/bff/handle.ts:110-112,387-435`.

This report does not claim implementation, test, typecheck, browser, database, or gate verification. No gate status was changed.
