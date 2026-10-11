# UBW-03 — Workers and Businesses UI/BFF Analysis

## Scope and evidence boundary

This is a source and contract analysis for `du-rework`. Inputs read: `coordination/PLAN-UI-BUSINESS-WORKFLOW-2026-10-08.md`, `coordination/reports/ubw-00-inventory.md`, `coordination/reports/ubw-01-ui-design.md`, `coordination/reports/ubw-02-registration.md`, and `coordination/reports/ubw-04-workflow-contract.md`. The product-source observations below are backed by the file/line references shown. No product or test file was changed; no build, test, or database command was run. No gate is claimed or ticked.

The canonical plan makes UBW-03 dependent on the UBW-01/02 contracts and requires a business registered after platform build to appear without rebuilding, remain non-active until explicit action, and show reloaded server state (`PLAN-UI-BUSINESS-WORKFLOW-2026-10-08.md:41-48,71-75,97-99`). The plan says its file areas are investigation ranges, not blanket implementation leases (`:65-79`). The leases proposed below therefore require dispatcher confirmation against the live roster before implementation.

## Findings in the current tree

### Workers currently means business-level operation metrics, not worker instances

The Admin Web navigation has no Workers entry, and the router has no Workers route (`orchestrator/apps/admin-web/src/app-shell/app-shell.tsx:15-20`; `orchestrator/apps/admin-web/src/router.tsx:1-18,27-56`). The overview nevertheless labels a section “Workers” and says it lists connected worker services listening on BullMQ (`orchestrator/apps/admin-web/src/features/overview/operations-monitor-dashboard.tsx:452-489`). Its backing `computeWorkerTelemetry` emits one row per business, aggregates operation outcomes, assigns a queue name locally, and defaults the version to `1.0.0` when both active and listed versions are absent (`orchestrator/apps/admin-web/src/features/overview/overview-metrics.ts:270-303`). That is not instance or heartbeat telemetry and must not be reused as the Workers inventory. Either replace it with the UBW-02-backed API or relabel it as business operation throughput.

UBW-02 proposes platform-admin read APIs only after instance persistence exists: `GET /api/v1/admin/workers?businessId=&businessVersion=&health=&limit=&cursor=` and `GET /api/v1/admin/workers/{instanceId}`. Its summary fields are `instanceId`, `businessId`, `businessVersion`, `manifestDigest`, `imageDigest`, derived `health`, `capacity`, `firstSeenAt`, `lastHeartbeatAt`, and `leaseExpiresAt`; task count and heartbeat history are excluded until real telemetry exists (`coordination/reports/ubw-02-registration.md:84-91`). The current heartbeat route is still a compatibility stub and does not persist an instance lease (`orchestrator/services/orchestrator/src/http/routes/runtime.ts:348-368`), so an empty or unavailable state is honest until UBW-02 lands; the UI must not fabricate an online worker (`ubw-01-ui-design.md:41-64`).

### Business list and version controls conflate different state dimensions

The upstream business list maps `version` to `active_version ?? latest.version` while taking `status` from the latest version row (`orchestrator/services/orchestrator/src/http/routes/admin.ts:379-403`; query shape in `orchestrator/services/orchestrator/src/modules/admin-read/business-list.ts:23-64`). Thus `version` and `status` can describe different version records. The screen currently avoids that pair only by deriving its list badge from `activeVersion !== null`, which collapses registry status into Active/Inactive (`orchestrator/apps/admin-web/src/features/businesses/businesses-screen.tsx:189-207`).

The version screen receives `status` and `isActive`, but renders only `isActive` as Active/Inactive and always offers Activate for any non-active row (`businesses-screen.tsx:229-279`). Its `toggleActive` path silently enables every row whose status is not `ENABLED` before activating it (`:81-110`). This includes states that must not be treated as drafts: `BusinessStatus` is `REGISTERED_DISABLED`, `ENABLED`, `DRAINING`, or `RETIRED` (`orchestrator/packages/contracts/src/manifest.ts:73-82`). The backend enable route unconditionally updates a version to `ENABLED` (`orchestrator/services/orchestrator/src/http/routes/admin.ts:84-119`). The UI must therefore stop chaining enable into activate and must not expose enable for draining or retired versions.

The registry deliberately keeps status separate from active-target selection: a newly registered version is `REGISTERED_DISABLED`, and activation requires an enabled version (`orchestrator/services/orchestrator/src/modules/registry/registry.ts:42-99,117-179`). Deactivation clears the active pointer for new submissions but leaves the version status `ENABLED`; it is not a worker drain, retirement, or job cancellation (`registry.ts:156-179`; `admin.ts:151-177`). The confirmation text must describe that exact effect and any server-provided admission/dependency consequences.

The current screen does not mutate the displayed rows optimistically: after the PUT it calls `openVersions()` and `load()`. It does, however, set “activated” or “deactivated” success notice before either authoritative reload has succeeded (`businesses-screen.tsx:81-112`). Success should be shown only after reload confirms the requested `status`/`isActive`; if refresh fails after an acknowledged mutation, preserve the last rows as stale and say that confirmation could not be refreshed.

### Existing BFF scope is safe but has no worker or exact-version detail mapping

The BFF currently maps `GET /admin/api/businesses` to upstream `GET /api/v1/admin/businesses`, `GET /admin/api/businesses/:id/versions` to the version list, and `PUT /admin/api/businesses/:id/versions/:version/{enable|activate|deactivate}` to the corresponding upstream action (`orchestrator/services/orchestrator/src/app/admin/bff/operations.ts:1-16,49-76,229-253`). Business routes require a platform admin session and fail before upstream for a tenant operator; writes require PUT and CSRF (`operations.ts:93-150`; `orchestrator/services/orchestrator/tests/aweb06-bff-operations.test.ts:313-344`). The BFF obtains the platform bearer server-side through `credentialFor`; the browser must never receive it (`operations.ts:146-153`; `orchestrator/services/orchestrator/src/app/admin/bff/upstream.ts:66-127`).

There is no `/admin/api/workers` route or exact business-version detail route in the current matcher. The business-version list returns digest and queue but not the stored manifest/action schemas (`orchestrator/services/orchestrator/src/app/admin/bff/operations.ts:49-76,229-245`; `orchestrator/services/orchestrator/src/http/routes/admin.ts:487-523`). The registry already stores the validated immutable manifest and digest, returns identical-digest replay, rejects a different digest for the same business/version, and creates new versions disabled (`orchestrator/services/orchestrator/src/modules/registry/registry.ts:42-99`). Therefore action discovery should be a read projection over that stored manifest, not a generated frontend enum or build-time catalog.

## Proposed wire and UI contracts

### Workers

Keep UBW-02 as the owner of heartbeat persistence and the upstream worker read endpoints. Once that API and DTO are accepted, add these read-only BFF mappings:

| Browser BFF | Upstream admin API | Behavior |
|---|---|---|
| `GET /admin/api/workers?businessId=&businessVersion=&health=&limit=&cursor=` | `GET /api/v1/admin/workers` | Forward only the named allowlisted filters and page parameters. |
| `GET /admin/api/workers/{instanceId}` | `GET /api/v1/admin/workers/{instanceId}` | Return the same server-derived instance summary; do not synthesize history or utilization. |

Use the UBW-02 summary shape without adding UI-derived state:

```ts
type WorkerHealthV1 = 'HEALTHY' | 'DEGRADED' | 'OFFLINE';

type WorkerInstanceSummaryV1 = {
  instanceId: string;
  businessId: string;
  businessVersion: string;
  manifestDigest: string;
  imageDigest: string;
  health: WorkerHealthV1;
  capacity: number;
  firstSeenAt: string;
  lastHeartbeatAt: string;
  leaseExpiresAt: string;
};

type WorkerInstancePageV1 = {
  items: WorkerInstanceSummaryV1[];
  nextCursor: string | null;
};
```

`capacity` is the reported capacity value, not current in-flight work. Do not add task count, queue utilization, heartbeat history, or worker control mutations without a real producer and separate contract. Require a platform-admin session for both reads and perform the same platform credential selection server-side as business registry reads. Tenant scope in query parameters must not broaden or narrow platform inventory. Return 403 without leaking instance or business identifiers to a non-platform principal.

### Businesses, versions, and action discovery

Retain the existing list and version-list routes, but make the fields unambiguous and typed. The business overview row should be:

```ts
type BusinessCatalogItemV1 = {
  businessId: string;
  displayName: string;
  description: string;
  latestVersion: string;
  activeVersion: string | null;
  versionCount: number;
  latestUpdatedAt: string;
};
```

Do not put a single business-level `status` beside `activeVersion`: status belongs to a specific immutable version. Preserve the current paged envelope (`items`, `total`, `limit`, `nextCursor`, `prevCursor`). The version-list row should have `businessId`, `version`, `status: BusinessStatus`, `isActive`, `manifestDigest`, `queue`, `registeredAt`, and `updatedAt`. `isActive` must describe that exact row and agree with `activeVersion === version`; status must not be copied from another row. The current duplicate `items`/`rows` version-list shape should have one canonical field in the typed client (prefer `items`); retain `rows` as a compatibility alias only during a coordinated migration.

Add an exact immutable detail read:

| Browser BFF | Upstream admin API | Response |
|---|---|---|
| `GET /admin/api/businesses/{businessId}/versions/{version}` | `GET /api/v1/admin/businesses/{businessId}/versions/{version}` | `BusinessVersionDetailV1` for the exact version, never `latest`. |

Proposed detail DTO:

```ts
type BusinessVersionDetailV1 = {
  businessId: string;
  version: string;
  status: BusinessStatus;
  isActive: boolean;
  manifestDigest: string;
  queue: string;
  registeredAt: string;
  updatedAt: string;
  manifest: {
    contractVersion: '1';
    displayName: string;
    description: string;
    imageDigest: string;
    capabilities: { cancel: boolean; resume: boolean; parallel: boolean };
    actions: Array<ActionManifest & {
      actionSchemaDigest: string;
      inputSchemaDigest: string;
      outputSchemaDigest: string;
    }>;
  };
};
```

The detail route should authorize platform admin, read the stored manifest for the exact `(businessId, version)`, and return 404 for an unknown pair. It should not load or execute business code. The action list is the manifest’s `ActionManifest[]` (`orchestrator/packages/contracts/src/manifest.ts:30-46,48-71`), including JSON schemas, declared connector slots, artifact policy, capabilities, and optional declarative `uiSchema`. Render only a supported JSON Schema/uiSchema subset; treat unsupported schema constructs as unsupported metadata with a clear explanation. Never interpret manifest values as JavaScript, HTML, or component imports.

UBW-04 requires `actionSchemaDigest`, `inputSchemaDigest`, and `outputSchemaDigest` pins in each workflow node (`coordination/reports/ubw-04-workflow-contract.md:151-176,269-275`). The source currently has a canonical JSON/hash helper but no action-schema digest helper or agreed action digest field-set (`orchestrator/packages/contracts/src/manifest-validator.ts:14-34`; `orchestrator/packages/contracts/src/hashing.ts:45-51`; no source match for `actionSchemaDigest`). These digest values must be computed server-side from an exact, shared contract and reused by the future workflow validator; the browser must not invent or attest them. Freeze the canonical field-set with UBW-04/contracts owner before implementation. The version’s `manifestDigest` remains the immutable whole-manifest identity.

### State-changing actions and authoritative reload

Show the version’s `status` and `isActive` as separate labels. Offer only these transitions:

| Server state | Available action |
|---|---|
| `REGISTERED_DISABLED`, not active | Enable; after a fresh read reports `ENABLED`, offer Activate as a separate confirmed action. |
| `ENABLED`, not active | Activate. |
| `ENABLED`, active | Deactivate, described as removing this version from the active target for new submissions. |
| `DRAINING` or `RETIRED` | No enable/activate/deactivate control in this slice; show the state and server explanation. |

Before each write, confirm exact business and version, current status/active target, requested change, and any dependency/admission impact supplied by the server. The current API does not provide a dependency-impact summary, so the UI must state that impact is unavailable instead of implying there are no dependencies (`ubw-01-ui-design.md:68-90`). After a successful PUT, refetch the exact version detail and catalog/version list. Only show “Enabled”, “Activated”, or “Deactivated” after the returned authoritative read confirms the expected status and active pointer. If the PUT succeeds but a read fails, keep prior data marked stale and show “change acknowledged; current state could not be refreshed”; do not locally set `isActive` or claim success. A 409 requires a fresh read and a new confirmation, not an automatic retry.

### Components and page behavior

**Workers page:** Add a Platform-scope Workers nav entry and `/workers` route. `WorkersScreen` owns filters (`businessId`, exact version, health, heartbeat age/search), request state, and selected instance. `WorkerInstanceTable` shows instance ID, business/version, health, last heartbeat/lease age, image/manifest digest, and reported capacity. `WorkerInstanceDetailPanel` shows only API-backed summary facts and registration guidance. Add loading skeleton, successful empty state, retryable error with correlation reference, 403 without hidden identifiers, and offline/stale indicator. Keep drain/resume/revoke absent; use no placeholder rows. This follows `ubw-01-ui-design.md:41-64` and `ubw-02-registration.md:84-91`.

**Businesses page:** Make the list identify business name/description, latest version, active version, count of discovered versions, and latest registry update. Version rows show exact status and active-target marker independently. A `BusinessVersionDetail` view contains immutable digest, action catalog, each action’s input/output/config schema, capabilities and declared connector slots. Add explicit confirmation for Enable, Activate, and Deactivate, with separate steps for enable then activate. Preserve successful list state if one detail request fails; mark cached rows stale on offline errors and disable writes. New version metadata appears after fetch/revalidation without rebuilding Admin Web, but registration itself never enables or activates it.

The current BFF already rejects non-platform access and forwards writes with CSRF. Extend that policy to worker reads and version detail. Workers are read-only in V1. Never place platform tokens in browser DTOs or responses. Use the shared problem envelope for 401/403/404/409/upstream failures and preserve request/correlation references when available.

## Proposed exact implementation leases

These are recommendations for a future dispatch, not leases granted by this report. UBW-02 must land and its read DTO be accepted before the Workers UI can show real instances. Coordinator must check current owners and overlapping leases before dispatching shared route, shell, and API-client files.

| Slice | Proposed exact files | Responsibility |
|---|---|---|
| Business catalog contract/read API | New `orchestrator/packages/contracts/src/business-catalog.ts`; `orchestrator/packages/contracts/src/index.ts`; new `orchestrator/services/orchestrator/src/modules/admin-read/business-catalog.ts` (or explicitly lease `business-list.ts` if extending it); `orchestrator/services/orchestrator/src/http/routes/admin.ts`; new `orchestrator/services/orchestrator/tests/admin-business-catalog.test.ts` | Typed version summary/detail and manifest projection; ensure business list latest and active pointers cannot mix status. Worker registry/persistence files remain with UBW-02. |
| Admin BFF | `orchestrator/services/orchestrator/src/app/admin/bff/operations.ts`; `orchestrator/services/orchestrator/src/app/admin/bff/handle.ts`; new `orchestrator/services/orchestrator/src/app/admin/bff/workers.ts`; new `orchestrator/services/orchestrator/tests/ubw03-catalog-bff.test.ts` | Business exact-version detail mapping; worker list/detail GET routes; allowlists, platform RBAC, server-only credentials, method fencing, and upstream error relay. |
| Admin Web shared routing/client | `orchestrator/apps/admin-web/src/router.tsx`; `orchestrator/apps/admin-web/src/app-shell/app-shell.tsx`; `orchestrator/apps/admin-web/src/lib/api/types.ts`; `orchestrator/apps/admin-web/src/lib/api/client.ts`; `orchestrator/apps/admin-web/src/lib/api/index.ts` | Workers navigation/route, typed BFF calls/DTO parsing, business detail API and state-action response types. |
| Admin Web Workers feature | New `orchestrator/apps/admin-web/src/routes/workers.tsx`; new `orchestrator/apps/admin-web/src/features/workers/workers-screen.tsx`; new `orchestrator/apps/admin-web/src/features/workers/state.ts`; new `orchestrator/apps/admin-web/src/features/workers/workers-screen.test.tsx` | Platform-scope, API-backed instance list/detail and loading/empty/error/403/offline behavior. No fake telemetry or controls. |
| Admin Web Businesses feature | `orchestrator/apps/admin-web/src/features/businesses/businesses-screen.tsx`; `orchestrator/apps/admin-web/src/features/businesses/state.ts`; new `orchestrator/apps/admin-web/src/features/businesses/business-version-detail.tsx`; new `orchestrator/apps/admin-web/src/features/businesses/state.test.ts` | Separate status from activation, dynamic exact-version action catalog, explicit state actions, and confirmation only after authoritative reload. |
| Correct existing overview label | `orchestrator/apps/admin-web/src/features/overview/overview-metrics.ts`; `orchestrator/apps/admin-web/src/features/overview/operations-monitor-dashboard.tsx` | Remove the fabricated worker-service/queue presentation or rename it to business-level operation throughput until real worker DTOs feed it. |

The plan orders UBW-03 after UBW-02 and UBW-04; the Workers API depends directly on UBW-02, and schema pins/action digest derivation must be reconciled with UBW-04. Dynamic business action display can be implemented after the exact-version manifest endpoint is accepted. Do not include workflow editor/runtime files in this slice.

## Acceptance checks for the future implementation

1. A newly registered business/version and its action catalog appear from stored manifest data after fetch/revalidation with no platform rebuild; replay does not duplicate a version, and a different digest remains a server conflict.
2. Newly registered versions display `REGISTERED_DISABLED` and inactive. Enable and activation are separate confirmed actions; DRAINING/RETIRED cannot be turned back on through the generic Activate button.
3. Business list `activeVersion` never borrows status from another version. Version status and active-target state are independently visible.
4. After each write, UI state comes from authoritative GET responses. Refresh failure never yields a local “Active” or “Saved” claim; 409 requires refresh and reconfirmation.
5. Worker list/detail use persisted UBW-02 data, server-derived freshness, and platform-only authorization. Expired leases display OFFLINE; absent telemetry produces an honest empty/unavailable view. No worker count, queue, or control action is fabricated.
6. Action discovery returns exact-version manifest and server-computed pins; a newly registered action becomes available to catalog consumers without static enum changes or platform rebuild. Unsupported schemas are shown as unsupported rather than evaluated.
7. BFF tests prove platform RBAC before upstream, query allowlists, no bearer leakage, GET-only worker methods, business action CSRF, and safe 404/409 relays.

## Open items for coordinator/contract owners

- Confirm UBW-02 worker API/DTO acceptance and route availability before granting the UI/BFF lease; the current heartbeat path is not persisted telemetry.
- Freeze the canonical `actionSchemaDigest` field-set/derivation in the shared contracts or UBW-04 owner. Current workflow DTO names the pins but source has no matching digest helper.
- Decide whether to preserve the current duplicate `items` and `rows` version-list aliases during client migration; the proposed typed client uses one canonical list.
- Define a backend dependency/admission impact response before presenting a “no affected dependencies” claim in mutation confirmation. Current business action endpoints do not supply that summary.
- Refresh the live lease roster before dispatch: `operations.ts`, `handle.ts`, Admin Web router/shell/client, and overview files are shared integration points and may overlap with other active slices.
