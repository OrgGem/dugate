# Receipt — FOLLOWUP-CODEX-WAVE3-W0 (Finding 4: workflow revision pin)

| Field | Value |
| :--- | :--- |
| Finding | F4 (P2) — *Workflow revision pin in catalog and group state* (PC-03, PC-08) |
| Dispatch | [`FOLLOWUP-CODEX-WAVE3-W0-dispatch.txt`](../dispatch-specs/FOLLOWUP-CODEX-WAVE3-W0-dispatch.txt) |
| Worker | DeepSeek Worker 0 — `deepseek-v4.1-flash` |
| Status | **COMPLETE (source + offline tests).** Catalog exposes the tenant's active workflow revision when a tenant is supplied; the group draft preserves it from stored bindings and emits it on save. |
| Evidence level | **Source and offline test level only.** No PostgreSQL/Redis, no container, no browser run. One caller-wiring gap is reported in §4 and is outside this packet's lease. |
| Date | 2026-10-21 (host clock at run time) |

## 1. Defect

The frozen v2 save contract (`ProfileGroupV2FunctionInputSchema`) requires a positive
`workflowRevision` on a `kind:'workflow'` function and forbids it on an endpoint
selector. Two producers disagreed with that contract:

1. `getBusinessFunctionCatalog` built descriptors from the manifest `ActionManifest`,
   which carries no revision. Tenant workflow revisions live in the tenant-scoped
   `legacy_workflow_schemas(tenant_id, slug, revision, status)` registry, so the
   catalog had no way to name a valid revision at all.
2. `ProfileGroupFunctionDraft` had no `workflowRevision` field. A stored binding's
   revision was dropped on read, unavailable during editing, and never written on
   save — the editor could not build a contract-valid workflow function at all.

## 2. Changes

### 2.1 Catalog producer — `services/orchestrator/src/modules/admin-read/business-functions.ts`

- `manifestActionFunction` accepts `workflowRevision?: number` and emits it **only**
  for `kind:'workflow'`; endpoint selectors never carry the field.
- New `activeWorkflowRevisions(db, tenantId, slugs)` reads
  `legacy_workflow_schemas` filtered by `tenant_id`, `slug = ANY(...)` and
  `status='active'` (the partial unique index guarantees at most one row per slug),
  keeping only positive safe integers.
- `getBusinessFunctionCatalog(..., { tenantId?: string })` resolves revisions once
  for the actions this manifest maps as workflow functions. Document Core variant
  actions stay endpoints and are excluded from the lookup. A missing tenant or a
  slug with no active row simply omits the field — the catalog never fabricates a
  revision the workflow engine could not resolve.

### 2.2 Group draft state — `apps/admin-web/src/features/profiles/profile-group-state.ts`

- `ProfileGroupFunctionDraft` gained `workflowRevision: number | null`
  (`emptyProfileGroupFunctionDraft` → `null`). All draft updates copy the draft, so
  the pin survives unrelated value/lock edits and source partitioning.
- `profileGroupFunctionDraftFromBinding` copies `binding.workflowRevision` for a
  workflow binding and keeps `null` for endpoints.
- `buildProfileGroupSaveBody` resolves
  `config.workflowRevision ?? descriptor.workflowRevision`, accepts only a positive
  safe integer, forces endpoints to `null`, and spreads the field only when resolved.
  An unresolvable pin is **omitted rather than invented** — the frozen contract
  refuses the body exactly as it did before, so legacy manifests keep their previous
  validation behaviour (pinned by the PC-R07 suite).
- No new hard validation error was added: revision availability is a catalog
  capability, and blocking here would have changed the pre-existing contract of
  revision-free v1/v2 manifests.

## 3. Verification (literal)

| Command | Result |
| :--- | :--- |
| `pnpm --filter @du/admin-web exec tsc --noEmit` | `ADMINWEB_TSC=0` |
| `pnpm --filter @du/orchestrator exec tsc --noEmit` | `SERVICE_TSC=0` |
| `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/aweb10-profile-group-v2-state.test.ts` | 27/27 passed, exit 0 |
| Same runner over the affected batch: state, r06-lock-preservation, r07-parameter-source, bff-workbench-v2, bff-profile-groups-v2, pc-r07-backend-parameter-source, woc-profile-groups-backend | 7 suites, 109/109 passed, exit 0 |

New cases (all in `tests/aweb10-profile-group-v2-state.test.ts`):

- draft: stored pin preserved through read and an unrelated value edit; catalog
  fallback when the binding has no pin; explicit draft pin wins over catalog; an
  unresolvable pin is omitted and the contract rejects the body; endpoint never
  carries a revision even from a stale draft; catalog parser preserves the field;
  empty draft starts `null`.
- catalog producer (fake db): workflow action pinned with the tenant active revision
  and query parameters verified; no active row ⇒ field absent; non-positive value ⇒
  field absent; no tenant ⇒ no registry query and no field.

Encoding check on all three touched files: UTF-8, 0 mojibake sequences.

## 4. Known gap (outside lease, follow-up required)

`GET .../profile-groups/v2/function-catalog` (`src/http/routes/admin-profile-groups-v2.ts:207`)
and the other `getBusinessFunctionCatalog` callers do not pass `tenantId` yet.
`admin-profile-groups.ts:95` and `profile-groups.ts:400` are likewise tenant-free.
Until the catalog route passes the tenant, the endpoint returns revision-free
descriptors, and a **newly selected** manifest workflow action still cannot resolve
a pin from discovery. Existing bindings are unaffected: their stored
`workflowRevision` now survives read → edit → save through the draft state.

Wiring the tenant into the platform catalog route is a route-contract decision
(new query parameter / audience) and was not in this packet's lease.

## 5. Files changed

- `du-rework/orchestrator/services/orchestrator/src/modules/admin-read/business-functions.ts`
- `du-rework/orchestrator/apps/admin-web/src/features/profiles/profile-group-state.ts`
- `du-rework/orchestrator/services/orchestrator/tests/aweb10-profile-group-v2-state.test.ts`

No commit was made; the working tree also contains earlier uncommitted packets.
