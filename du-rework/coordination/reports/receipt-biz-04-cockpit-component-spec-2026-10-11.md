# Receipt - BIZ-04 Business Detail Cockpit: analysis + component spec

- Date: 2026-10-11
- Lane: P0-P5 API keys -> Profile move, extended to the Businesses surface
- Deliverable: ANALYSIS + COMPONENT SPEC (no product component written, no wiring)
- Git: no git add, no commit, no push (COORDINATOR-CONTRACT)
- Evidence: admin-web `npx tsc --noEmit` exit 0 after this work (nothing in the app changed)

## 1. What the cockpit can render TODAY, verified against the tree

| Block | Read that already exists | Evidence |
|---|---|---|
| Version enablement | `client.getBusinessVersions(businessId)` -> `BusinessVersions`, already used by `features/businesses/businesses-screen.tsx:64-80` | source read |
| Worker instances | `GET /api/v1/admin/worker-instances` -> `admin.ts:416-420`; client `listWorkerInstances` at `client.ts:184` and `:506`; row type `WorkerInstance` at `types.ts` | source read |
| Profile bindings | `GET /api/v1/admin/profiles` -> `admin.ts:562`; client `listProfiles` at `client.ts:121` and `:404` -> `ProfileListPage` | source read |
| Workflow schema bindings | **NO admin read exists** | see section 3 |

Worker row facts (`WorkerInstance`): `businessId`, `instanceId`, `businessVersion`, `state` (ONLINE/DRAINING/OFFLINE), `health` (HEALTHY/DEGRADED/OFFLINE), `capacity`, `activeLeases`, `lastSeenAt`, `observedAt`. The list carries its own `sampledAt` and a `truncated` flag. Backed by migration `0042_worker_instances.sql` (PK `(business_id, instance_id)`).

Workflow schema bindings: `0040_workflow_business_profile_bindings.sql` added nullable `business_id` / `business_version` to `legacy_workflow_schemas` and created `profile_workflow_bindings(profile_id, workflow_slug, workflow_revision, enabled, config, created_at)`. Neither table has a read route - grep over `src/http/routes/admin.ts` for `workflow` returns 0.

## 2. Truthful format (format trung thuc) - the rules the component must obey

These are the reason the component is a spec and not a draft. Each rule names the lie it prevents.

1. **No number without its sample time.** Worker counts, capacity and active leases render beside `observedAt` (per row) and `sampledAt` (per page). A count with no sample time reads as a current fact when it is a past observation.
2. **Absence is not zero.** An empty `items` array renders `no heartbeat rows in this business` and NOT `0 workers`. The first is a fact about the table; the second is an inference about the fleet, and the two are not the same claim.
3. **Never recompute health in the browser.** The server derives `health` from `state` + freshness (`WORKER_HEARTBEAT_FRESH_FOR_MS`). A browser-side rule over `lastSeenAt` would use the client clock and produce a second, competing answer. Render the server field, and render `truncated` as a visible warning instead of silently dropping rows.
4. **`revision: 0` means not stored.** The profile list returns the blank-editor shape for a name that has no stored revision (`ProfileDetailReadSchema` R-12 blind first save). Such a row must be rendered `unsaved` and must NOT be counted in a `bound profiles` metric - counting it would report a profile that owns no keys and no policy.
5. **A missing read is not an empty table.** The workflow schema bindings block has no endpoint. It renders an explicit `unavailable - no read endpoint` state with the reason. An empty table there would read as `this business has no workflow bindings`, which nobody has established.
6. **Version enablement shows the registry column, not a derived badge.** `business_versions` carries `status` and `is_active` as separate facts. The block prints the column value; it does not collapse them into one green/red chip, because they can disagree and the disagreement is the interesting state.
7. **Four blocks, four independent states.** One block failing (403, 502, unreadable payload) leaves the other three rendering. A single page-level error state would let one endpoint's outage hide three healthy answers.

## 3. The workflow schema gap, stated plainly

The task asks for workflow schema bindings, and the honest answer is that the data exists but cannot be read. `legacy_workflow_schemas` is business-addressable since 0040 and `profile_workflow_bindings` is profile-addressable, but no `GET /api/v1/admin/...` exposes either, and `admin-web` has no client method for them.

Options for the implementer, in order of preference:

- (a) add `GET /api/v1/admin/profiles/:b/:v/:n/workflows` reading `profile_workflow_bindings` joined to `legacy_workflow_schemas` (owner-addressable, tenant-fenced like the 0039 key-list route), and render the block from it;
- (b) ship the cockpit with block 4 in the explicit unavailable state (rule 5) and open a follow-up packet;
- (c) invent the data from a workflow list - rejected here: it would render bindings nobody has written.

The coordinator decides. Nothing in this receipt implements (a).

## 4. Component spec (draft, not written to disk)

```tsx
interface Props { businessId: string; }

export function BusinessDetailCockpit({ businessId }: Props) {
  // four independent Loadable states, four independent fetches
  // versions  <- getBusinessVersions(businessId)
  // workers   <- listWorkerInstances({ businessId })
  // profiles  <- listProfiles({ businessId })
  // workflows <- unavailable until a read exists (rule 5)
}
```

Layout: one section, four cards. Each card header carries the block title and, when the payload has one, its sample time (`sampledAt`, or the newest `observedAt` for the worker block). Each card body is one of: table, `empty-because-no-rows` (rule 2), `error` (problem title + status + code + retry), or `unavailable` (rule 5).

Worker table columns: instance, version, state, health, `activeLeases / capacity`, `lastSeenAt`, `observedAt`. Profile table columns: name, businessVersion, action, revision (`unsaved` when 0, per rule 4). Versions table columns: version, status, is_active, contract_version, queue - printed as columns, not badges (rule 6).

State shape: `type Loadable = { kind: 'loading' } | { kind: 'ready'; data: T } | { kind: 'failed'; problem: AdminApiProblem } | { kind: 'unavailable'; reason: string }` - the last variant is what keeps rule 5 honest; `empty` is derived from `ready && items.length === 0`, never stored, so a block cannot claim empty while loading.

## 5. Verification

```
cd /d D:\Git\dugate\du-rework\orchestrator\apps\admin-web && npx tsc --noEmit -p tsconfig.json
-> exit 0 (no product file changed in this task, so the build is untouched)

cd /d D:\Git\dugate\du-rework\tests\browser && npx tsc --noEmit -p tsconfig.json
-> 7 errors, all pre-existing and unchanged: 3x '@/lib/api' path resolution,
   connectors/state.ts Set assignment, harness.ts outFile, p745-ui-keys x2.
   0 new errors from this lane.
```

## 6. Not done

- No `BusinessDetailCockpit.tsx` written; no route, no nav entry, no client method added.
- No read endpoint for workflow schema bindings (decision is the coordinator's, section 3).
- No browser evidence for any of this - the component does not exist yet.
