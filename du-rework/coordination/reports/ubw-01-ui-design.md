# UBW-01 — UI information architecture, wireframes, and user journeys

## Scope and design basis

This is a design artifact for du-rework only. It is based on the full canonical plan `coordination/PLAN-UI-BUSINESS-WORKFLOW-2026-10-08.md` and `coordination/reports/ubw-00-inventory.md`. It does not claim that the proposed screens, routes, workflow engine, or runtime journeys exist or have been browser-tested. No product or test code is changed by this report.

The screen flow is Workers → Businesses → Processes → Workflows → Profiles → Test & Runs. The shell keeps the existing health strip, session controls, error boundary, and toast feedback. Add navigation for the three absent areas (Workers, Processes, Test & Runs) only when their slices are implemented. Keep tenant-scoped pages in an explicit tenant context; do not default a write to All tenants or silently select a tenant. Platform-scoped registry/worker views must be visibly marked as platform scope.

The following decisions are treated as constraints for this design:

| Decision | UI consequence |
|---|---|
| D-UBW-1: process binding is alias-first | A process is a stable named alias with versioned bindings to an exact business version/action or an exact published workflow revision. It is not a new kind of workflow node. Preserve legacy process names and show their target explicitly. |
| D-UBW-2: V1 supports multiple actions from the same business | A V1 workflow may contain at least two sequential actions from one business. Once the first action is selected, the palette is constrained to that business. Cross-business nodes, branches, parallel execution, and joins are not offered in V1. |
| D-UBW-3: profiles use an adapter binding model | Preserve the existing endpoint-profile wire/storage model. A separate versioned workflow-profile adapter binds an exact workflow revision to per-node action-profile revisions and workflow-specific node settings. Existing action profiles remain readable and usable on their existing path. |
| D-UBW-4: Δ-DEV-03 stays closed until explicit user order | The Workflows route remains a gate/status screen with no workflow data reads or mutations while closed. The builder below is a design for after an explicit order; this report does not open the gate or imply authority to do so. |

## Shared shell and interaction rules

```text
┌ DUGate Admin ────────────────────────────────────────────────────────────┐
│ Health: Healthy · sampled 12s ago       Tenant: Northwind ▾  Account ▾  │
├──────────────────┬─────────────────────────────────────────────────────┤
│ Workers          │ Breadcrumbs                                          │
│ Businesses       │ Page title                              Primary CTA  │
│ Processes        │ Scope / status context                                │
│ Workflows  🔒    │ Filters and search                                   │
│ Profiles         │ Main list, editor, or detail                          │
│ Test & Runs      │                                                     │
└──────────────────┴─────────────────────────────────────────────────────┘
```

The tenant selector displays tenant names and keeps identifiers in option values. Tenant-scoped write pages require one selected tenant. A platform-wide view is an explicit, read-only scope where the API permits it. Each detail view shows tenant/platform scope, immutable version or revision, and last refresh time near the title. The current inventory found no global tenant context in the shell, so adding one is a design dependency rather than an existing behavior.

Use skeletons while loading; never show an empty-state message until the request has completed successfully. Preserve unsaved form values on recoverable errors and conflicts. A 403 explains the missing permission and offers a safe navigation path; it must not expose hidden resource details. A 409 keeps the draft, shows the current server revision and a field-level comparison, and requires an explicit reload or reapply. Offline mode shows a persistent Offline / last checked indicator, keeps loaded data visibly stale, and disables all writes and run submission. Do not queue a mutation for later or show Saved/Active based only on local state. Mutations show success only after the server confirms and the screen reloads authoritative state.

All list, detail, and editor states use keyboard-operable controls, visible focus, labelled status text, and responsive layouts. On narrow screens, filters collapse into a drawer, tables become labelled cards, and the main action remains reachable without horizontal page scrolling. Status always distinguishes worker health, business-version enablement/activation, and workflow/profile publication.

## Screen designs

### 1. Workers

**Purpose and layout.** A platform-scope inventory of worker instances, separate from business versions. Filters cover business, exact version, health, and heartbeat age. The list shows instance ID, business/version, image digest, health, last heartbeat, capacity, and task count only when real telemetry provides it. Selecting a row opens a detail panel with those facts, reported capabilities, and registration guidance. The initial V1 is read-only unless an acknowledged control protocol is available. Do not render Drain, Resume, or Revoke controls from a desired-state assumption.

```text
Workers                         Platform scope
[Business ▾] [Version ▾] [Health ▾] [Search instance…]
Instance       Business / version   Health       Last heartbeat   Capacity
worker-…       document-core / 1.2  DEGRADED     18s ago          2 / 8
                                             [Open details]
Details: image digest · reported capacity · heartbeat history
Registration: start the worker with its provisioned identity
```

| State | Presentation |
|---|---|
| Loading | Skeleton rows and disabled filters; indicate that instance health is being fetched. |
| Empty | “No worker instances have reported.” Show setup requirements and a link to the relevant business version; do not create a fake online instance. |
| Error | Keep the page shell, show a retryable load error and request/correlation reference when available. Separate registry/business lookup failure from heartbeat telemetry failure. |
| 403 | Show an access-denied panel for worker inventory. Do not reveal instance IDs, business names, or heartbeat data. |
| 409 | For a future registration command, explain whether the conflict is an existing instance or same-version/different-manifest registration; retain the submitted context and provide a safe refresh path. Do not silently replace a registration. |
| Offline | Show cached rows as stale with last successful refresh. Disable registration and any future control actions; never convert stale HEALTHY to current HEALTHY. |

Inventory note: current source evidence does not show persisted worker health/control state, and the heartbeat endpoint is described as a DEGRADED stub. Until that changes, the screen must show unavailable/unknown telemetry honestly and keep operational controls absent.

### 2. Businesses

**Purpose and layout.** A platform registry catalog. The overview lists stable business identity, description, discovered versions, and latest registry update. Opening a business shows version rows and a version detail with immutable digest, actions/schemas/capabilities, matching workers when available, dependencies, and a manifest diff against another exact version. Version status is explicit: REGISTERED_DISABLED, ENABLED, active target, DRAINING, or RETIRED according to the server contract. Enable/activate/deactivate are separate commands.

```text
Businesses                                      Platform registry
[Search business…] [Status ▾]
document-core   Document processing   2 versions   [View]
└ Versions: 1.2.0  ENABLED · active target     [Details] [Deactivate]
            1.1.0  ENABLED · not active       [Details] [Activate]

Version 1.2.0 · digest …
[Summary] [Actions & schemas] [Workers] [Dependencies] [Version diff]
```

Before a state-changing action, show a confirmation with the exact business/version, current and requested state, affected process/workflow/profile bindings, and the server-provided drain/admission consequences. If dependency impact cannot be fetched, say so and do not imply that no dependencies exist. Do not retire or kill a worker/job through this screen.

| State | Presentation |
|---|---|
| Loading | Business rows and version-detail skeletons; action buttons unavailable until authoritative state arrives. |
| Empty | “No business versions are registered.” Explain that valid worker/manifest registration is required; discovery does not auto-enable or activate. |
| Error | Preserve search/filter state and show retry. Version-detail failure must not erase the successfully loaded business list. |
| 403 | Explain that registry access or the requested state change is not permitted. Keep the catalog hidden if the read itself is forbidden; otherwise keep read-only facts and disable commands. |
| 409 | Show that the version changed since the confirmation was opened, with server state and dependency summary. Require refresh and a new confirmation; do not replay an activation against a different version. |
| Offline | Show last-loaded registry time and stale badge. Disable enable/activate/deactivate/retire; do not infer current active version from cache. |

### 3. Processes

**Purpose and layout.** A tenant-scoped registry of stable process aliases. A process alias is the invocation name operators and compatible APIs use; its binding revision points to either one exact business version/action or one exact published workflow revision. A list row shows alias, tenant, target kind and exact target, binding revision, state, and dependency count. Existing legacy aliases appear with a legacy badge and remain unchanged until explicitly rebound.

The create/edit wizard has four steps: (1) choose tenant and alias, (2) select target kind and exact target, (3) validate name uniqueness, permissions, target availability, and dependency impact, (4) review and publish. Selecting “latest” may help find a target while drafting but the saved binding resolves to an exact version/revision. Rebinding creates a new immutable binding revision and uses compare-and-swap; it never rewrites the target of an in-flight run.

```text
Processes / Northwind                         [New process alias]
Alias                 Target                                  Revision
invoice-intake        document-core@1.2.0 / extract-invoice   r3
legacy-disbursement   legacy target / compatibility           r1  LEGACY

New alias
1 Alias and scope → 2 Target → 3 Validate → 4 Review and publish
Name: invoice-intake
Target: [Business action ▾] [document-core ▾] [1.2.0 ▾] [extract-invoice ▾]
Resolved target: document-core@1.2.0 / extract-invoice
```

| State | Presentation |
|---|---|
| Loading | Skeleton aliases with tenant context fixed in the page header. Do not treat an unselected tenant as an empty tenant. |
| Empty | “No process aliases in this tenant.” Offer New process alias only when permitted and online. |
| Error | Keep any unsaved wizard values; show whether list, target catalog, or validation failed and retry only that read/validation. |
| 403 | Explain that the user cannot read or mutate process aliases in the selected tenant. Never fall back to platform-wide results. |
| 409 | For alias uniqueness or stale binding revision, retain the draft, identify the conflicting alias/revision, and offer reload/compare. Never overwrite the winning binding automatically. |
| Offline | Permit inspection of cached alias details with a stale label; disable create, rebind, validate-against-server, and publish. |

### 4. Workflows

**Current screen while Δ-DEV-03 is closed.** Render only the deployment-policy gate panel. Do not request workflow lists, schemas, or drafts and do not mount an editor behind a hidden button. Show that authoring is disabled, the route is gated, and that enabling it requires an explicit user order. Do not imply that an empty workflow catalog was fetched.

```text
Workflows  🔒
Workflow authoring is disabled by deployment policy Δ-DEV-03.
No workflow data has been loaded. No changes can be made from this screen.
The gate remains closed until an explicit user order.
```

**Future builder layout after an explicit order and required API/contract readiness.** The design is a linear same-business V1 editor. Header shows workflow name, tenant, draft revision, validation state, and Publish. A manifest-derived action palette is filtered to one business selected for the workflow. After the first node, actions from other businesses are unavailable with an explanation. Each node pins an exact business version, action, input/output schema digest, and node configuration. Edges map a declared output to a compatible declared input. V1 exposes sequential edges only; there are no branch, parallel, or join widgets.

```text
Workflows / Northwind / invoice-processing       Draft r2   [Validate] [Publish]
Business: [document-core ▾] [Version 1.2.0 ▾]
Actions: [parse-document] [extract-invoice] [redact-output]

[1 parse-document] ── output.text → input.markdown ──> [2 extract-invoice]
  exact version + schema                         exact version + schema
Node settings: required inputs · output mapping · connector slot
Validation: 2 nodes · 1 mapping · no cycles · same business
```

| State | Presentation |
|---|---|
| Loading | While gated, show the gate-policy check only and remain closed if it is unavailable. After authorized enablement, use list/builder skeletons; never show an empty list before fetch succeeds. |
| Empty | While gated, do not show an empty-catalog state. After enablement and successful fetch, show “No workflows yet” with Create draft only when authorized. |
| Error | While gated, a policy-read error leaves authoring closed. After enablement, show whether catalog, schema, or validation failed; retain the local draft and do not report validation success. |
| 403 | Show that workflow authoring or the selected tenant is not authorized. Do not fetch or disclose drafts through a secondary route. |
| 409 | For a future stale draft/publish conflict, preserve local edits, show the current server revision and a node/mapping diff, and require explicit reload or rebase. No last-write-wins publish. |
| Offline | Keep the gate closed if policy cannot be checked. If previously authorized, show cached drafts as stale/read-only and disable validation that requires server schemas, save, publish, and run. |

### 5. Profiles

**Purpose and layout.** Keep existing action profiles on their current screen and contract. Add a distinct workflow-profile adapter view, rather than adding `workflowRevision` to the existing endpoint-profile key. The adapter identifies its tenant/name/revision, references one exact published workflow revision, and records a per-node mapping to compatible exact action-profile revisions plus workflow-specific node settings. The UI labels existing action-profile values separately from adapter overrides. Secret values remain write-only; show configured/not configured, never plaintext.

Create steps: select workflow and exact published revision; review nodes; select/resolve the action-profile revision for each node; enter permitted node-level settings; inspect effective configuration and permission summary; save/publish a new adapter revision. A new adapter revision does not mutate an existing action profile or a submitted run. Rollback means selecting a prior adapter revision for future submissions, subject to the server contract.

```text
Profiles / Northwind                         [New workflow profile]
Action profiles | Workflow adapters

Adapter: invoice-default · r3 · Published
Workflow: invoice-processing@r2
Node                 Action profile revision     Node settings
parse-document       document-core / parse / r4  [Review]
extract-invoice      document-core / extract / r7 [Review]
[Effective config preview] [Permissions] [Revision history]
```

| State | Presentation |
|---|---|
| Loading | Separate skeletons for workflow catalog, compatible action profiles, and adapter detail. Do not treat a partial catalog failure as an empty set. |
| Empty | Distinguish no published workflow revisions from no compatible action profiles and no adapters. Explain the prerequisite and link to the relevant screen; do not auto-create a profile. |
| Error | Preserve form values. Identify the failed dependency (workflow, action profile, secret catalog, or adapter save); retry reads without discarding the draft. |
| 403 | Show whether read or write permission is missing for the selected tenant. Hide unavailable profiles and secrets rather than returning partial identifiers. |
| 409 | For concurrent adapter revision changes, retain edits and show active/server adapter revision plus per-node differences. Require explicit rebase or discard; never publish over another revision. |
| Offline | Show cached adapter and exact pins as stale/read-only. Disable save, publish, rollback, effective-config claims that require current data, and secret changes. |

### 6. Test & Runs

**Purpose and layout.** Separate the act of submitting a bounded test run from viewing executions. New run starts from a selected tenant-scoped workflow-profile adapter revision and displays the exact workflow and node pins before submission. The confirmation states input limits, expected cost/side effects if known, and the environment. Do not offer an unbounded production run as a test. After submission, show an operation timeline with queued/running/waiting/succeeded/failed/cancelled states, per-node start/end, worker identity/version when reported, safe output summaries, and error details. Secret material and raw sensitive payloads are redacted.

```text
Test & Runs / Northwind                         [Start bounded test]
Recent runs: ID · profile adapter r3 · workflow r2 · state · started

Run detail: operation …  RUNNING
1 parse-document    worker …    SUCCEEDED    output: 2 pages
2 extract-invoice   worker …    RUNNING      waiting for result
Pinned: workflow r2 · adapter r3 · action profiles r4 and r7
```

| State | Presentation |
|---|---|
| Loading | Skeleton run history and detail timeline. Keep the selected tenant visible; poll only while online and while a run is active. |
| Empty | “No runs yet.” Offer Start bounded test only when a published workflow adapter and permission are available. Explain missing prerequisites otherwise. |
| Error | Distinguish history-load, operation-detail, and result-fetch errors. Keep the last known timeline marked stale and allow a targeted retry. |
| 403 | Deny run history or submission for the selected tenant without exposing operation IDs or payload-derived details. |
| 409 | If the selected adapter/workflow revision changed before submission, stop and show both the requested and current exact revisions. If an idempotency key already submitted a run, link to that run rather than creating a duplicate. |
| Offline | Show last fetched timeline with stale timestamp. Disable submission and do not infer completion from a missed poll. Display “Status unknown while offline” for an active operation until refreshed. |

## User journeys

### A. Start a worker, discover a business, and prepare a process

1. An operator opens Workers and sees the platform-scope instance list. If none are reported, the empty state links to registration requirements and does not fabricate an instance.
2. The operator starts a worker using its provisioned identity. Once registration/heartbeat contracts report authoritative state, the instance appears with its exact business version and digest. A manifest version conflict is shown as a conflict and does not appear healthy.
3. In Businesses, the operator reviews the discovered manifest and action schemas. The new version remains REGISTERED_DISABLED until a separately authorized enable/activate action is confirmed.
4. In the selected tenant, the operator creates a process alias, selects an exact business version/action, reviews dependencies, and publishes the alias binding revision. Legacy aliases remain visible and unchanged.
5. The operator can proceed to workflow authoring only after an explicit user order opens Δ-DEV-03 and the workflow API/contract is ready. Until then the journey stops at the gate screen; there is no alternate route around it.

### B. Compose and publish a same-business workflow, then bind a profile

1. After gate authorization, the operator creates a workflow draft and selects one business/version. The palette shows that business's declared actions and schemas.
2. The operator adds at least two sequential actions from the same business and maps a declared output into a compatible next-node input. Unsupported action schemas, missing required fields, cycles, unavailable versions, or cross-business selections block validation with node-level errors.
3. The operator reviews the immutable draft diff and publishes a new workflow revision. The UI confirms only after server acknowledgement and reloads the published revision.
4. In Profiles, the operator creates a workflow-profile adapter pointing to that exact workflow revision, maps each node to an exact compatible action-profile revision, reviews effective configuration and permissions, then publishes the adapter revision.
5. In Test & Runs, the operator selects the exact adapter revision, reviews pins and run bounds, submits once, and follows each node's state and output summary. A future profile/workflow edit creates new revisions and does not retarget this operation.

### C. Recover safely from a concurrent edit or a network outage

1. An operator edits a process binding, workflow draft, or profile adapter while another operator publishes a newer revision. The save returns 409.
2. The screen keeps the unsaved draft, displays the server revision and a field/node diff, and offers Reload, Compare, or Reapply changes. It does not overwrite the server revision or show a success toast.
3. If the connection drops, the page changes to Offline, marks cached data stale, and disables all writes and run submission. A run already in progress is shown as status unknown rather than failed or complete.
4. On reconnect, the screen fetches authoritative state. It resolves a 409 explicitly before enabling save; it does not replay a possibly submitted run or mutation blindly.

## Design boundaries and readiness notes

- The inventory found no Workers, Processes, or Test & Runs navigation today; these are proposed screens, not existing capabilities.
- Worker registration/health persistence and worker controls need authoritative backend contracts before UI controls can imply success.
- The workflow builder is post-gate design only. The current Δ-DEV-03 page must not fetch or mutate workflow data until an explicit user order.
- The inventory did not confirm graph CRUD, draft/publish persistence, or cross-business execution. V1 deliberately stays with same-business sequential actions and leaves cross-business execution out.
- The profile adapter is a separate versioned binding model. Its DTO, storage, compatibility, and operation-snapshot contract need to be specified before implementation; the design must preserve existing action-profile behavior.
- Tenant scope and permission enforcement must be server-backed. The browser must not use a platform token or infer access from navigation visibility.
- These wireframes are interaction specifications. No code, tests, browser run, typecheck, database session, or gate change was part of this task.
