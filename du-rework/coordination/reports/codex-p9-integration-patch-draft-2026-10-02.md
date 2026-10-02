# P9 integration patch draft (READ-ONLY)

Date: 2026-10-02. Purpose: internal implementation sketch for a later authorized wave. This packet wrote only this report; its diff blocks are proposals and were not applied. No source, test, config, contract, wire, or gate file was changed by this packet. D5 changes from its separate lane remain visible in the shared worktree and are noted below.

## 1. Fixed evidence and scope

The process set used in these sketches is the exact legacy public `process` allow-list: `disbursement`, `lc-checker`, and `doc-compare`. The legacy route requires a trimmed exact key from the registry and does not lowercase or alias it (process evidence memo, sections 1 and 4; `app/api/v1/docs/workflows/route.ts:19-29`; `lib/endpoints/registry.ts:373-403`). Name-level targets evidenced in rework are:

| Legacy process | Internal business/action target proposed for dispatch | Evidence |
|---|---|---|
| `disbursement` | `document-core / disbursement` | `businesses/document-core/src/manifest/document-core.manifest.ts:243-260`; `businesses/document-core/src/worker.ts:1393-1396` |
| `lc-checker` | `lc-checker / lc-checker` | `businesses/lc-checker/src/manifest.ts:17,32-35`; translator entrypoint `businesses/lc-checker/src/legacy-facade.ts:24-25,71-100` |
| `doc-compare` | `document-core / doc-compare` | D5 registration receipt `coordination/reports/qwen-d5-doc-compare-registration-2026-10-02.md`, section 1; current action `businesses/document-core/src/manifest/document-core.manifest.ts:425-467`; worker registration `businesses/document-core/src/worker.ts:1997-2000` |

These are internal routing targets, not a proposed change to request fields, URLs, status codes, headers, or response DTOs. If Product chooses a different Q1 process set, the localized edit is the process union/dispatch table in the compat workflow decoder and adapter, plus the mapping fixture; the HTTP paths and server mount remain the same. The old document-core resolver's `simple-extraction | multi-step-analysis | transform-compare` set is not evidence of aliases for the three legacy keys (`businesses/document-core/src/pipelines/legacy-workflow-mapping.ts:4-5,56-88`; process evidence memo, section 4).

Current mount evidence: there is already one call to `handleLegacyRoute` before canonical routes (`services/orchestrator/src/server.ts:1745-1767`); path parser recognizes the two workflow paths (`services/orchestrator/src/compat/legacy-http-mount.ts:191-200`); the POST branch returns 503 before resolving principal or using the host (`services/orchestrator/src/compat/legacy-http-mount.ts:391-419`). Therefore sketches keep this route owner and replace delegation behind it; they do not add a second route.

## 2. Unified-diff sketches (not applied)

The snippets are schematic unified diffs against the current tree. Names such as `decodeLegacyWorkflowRequest`, `LegacyWorkflowRequest`, and the schema source port are proposed internal seams, not existing exports. Their exact implementation depends on the listed Product/architect decisions. The request continues through the existing multipart stream path; caller-supplied identity is never used.

| Patch surface | Proposed owner |
|---|---|
| `server.ts` composition/mount call | Single server integrator; serialize one writer across the wave. |
| Compat route and host interfaces/adapter | Same integrator for the shared route chain, with business owners supplying their input adapters. |
| Schema registration source/resolver | Product/architect selects Q2 source; registry or deployment-config owner supplies registrations; document-core/workflow owner supplies the resolver port. |
| Connector task/slot bindings | Connector owner; names remain OPEN until verified. |

### 2.1 `server.ts:1745-1767` — one serialized composition point

Keep the existing call site and mount order. The minimal draft makes the sole host instance visible; any injection required by the Q2-selected schema source is composed here and stays behind this one mount. It must not add another public route or decode identity in server.ts.

```diff
diff --git a/services/orchestrator/src/server.ts b/services/orchestrator/src/server.ts
@@
-    const legacy = await handleLegacyRoute(
+    // Single owner for all legacy compatibility routes. Workflow support is
+    // delegated through this host; do not add a second route branch here.
+    const legacyHost = legacyCompatHost(ctx);
+    const legacy = await handleLegacyRoute(
@@
-      legacyCompatHost(ctx),
+      legacyHost,
*** End Patch
```

The request passed at this site already carries `ctx.bodyStream` and resolves principal via `resolveApiKey(ctx)` (`services/orchestrator/src/server.ts:1751-1764`). That resolution remains the only tenant/API-key authority. A new `RouteContext` property is needed only if the selected schema source is injected here; that would be part of the same serialized server.ts edit (interface starts at `services/orchestrator/src/server.ts:1162`).

### 2.2 `legacy-http-mount.ts:191-200,391-407` — keep paths, delegate exact kinds

`parseLegacyDocsPath` already distinguishes `workflows` and `workflow-schema`. Keep those discriminants and method behavior. Replace the unconditional 503 with one authenticated internal delegation branch; leave the six-action decoder and response path intact.

```diff
diff --git a/services/orchestrator/src/compat/legacy-http-mount.ts b/services/orchestrator/src/compat/legacy-http-mount.ts
@@
 export interface LegacyCompatHost {
+  submitWorkflow?(
+    principal: LegacyPrincipal,
+    request: WorkflowSubmissionRequest,
+  ): Promise<LegacySubmitOutcome | undefined>;
+  resolveWorkflowSchema?(
+    principal: LegacyPrincipal,
+    request: WorkflowSchemaRequest,
+  ): Promise<WorkflowSchemaResolution | undefined>;
   submitLegacy?(principal: LegacyPrincipal, action: string, decoded: LegacyDecodedRequest): ...
@@
-    if (docs.kind !== 'action') {
-      return legacyError(503, 'Service Not Available',
-        'The legacy workflow facade is not available on this deployment.', correlationId);
-    }
-
     let principal: LegacyPrincipal;
     try { principal = await request.resolvePrincipal(); }
     catch { return internalError(correlationId); }
+
+    if (docs.kind !== 'action') {
+      // Consume the bounded multipart decoder only after server-side auth.
+      const workflow = await decodeLegacyWorkflowRequest(docs.kind, request);
+      if (workflow.kind === 'process') {
+        const outcome = await host.submitWorkflow?.(principal, workflow);
+        if (outcome === undefined) return internalError(correlationId);
+        const row = await host.loadOperation(outcome.operationId, principal.tenantId);
+        if (row === null) return internalError(correlationId);
+        return legacySubmitResponse({ decoded: workflow, row, replayed: outcome.replayed });
+      }
+      const resolution = await host.resolveWorkflowSchema?.(
+        principal, workflow,
+      );
+      if (resolution === undefined) return internalError(correlationId);
+      // Submit/response projection follows the pinned COMP-00 fixture; this
+      // sketch does not choose a new schema response shape.
+      return submitResolvedWorkflowSchema(host, principal, workflow, resolution, correlationId);
+    }
 
     let decoded;
*** End Patch
```

Internal request type sketch: `LegacyWorkflowRequest` holds the exact legacy `process` discriminator for the code-driven route, parsed non-identity form fields, uploaded file parts/artifact roles, correlation/idempotency/sync values, or the already accepted `schemaSlug` for the schema path. A decoder should reuse the current bounded multipart machinery (`legacy-http-mount.ts:108-130,306-329`) and route errors through the existing legacy error projection. The schema request cannot be forced into the process union because `/workflows/schema` uses a separate `schemaSlug` namespace (process evidence memo `2`). The quoted helper names are seams only.

Minimal internal request type shape (not a contracts change):

```ts
type LegacyWorkflowProcess = 'disbursement' | 'lc-checker' | 'doc-compare';
type LegacyWorkflowFile = {
  field: string;
  name: string;
  mimeType: string;
  bytes: Buffer;
};
type WorkflowSchemaRegistration = {
  schemaSlug: string;
  businessId: string;
  businessVersion: string;
  action: string;
  profile: string;
  status: 'active' | 'retired';
  recipeSelectors: readonly { action: string; variant: string }[];
};
type WorkflowSchemaResolution = {
  schemaSlug: string;
  businessId: string;
  businessVersion: string;
  action: string;
  profile: string;
  recipeSelectors: readonly { action: string; variant: string }[];
};
type WorkflowSchemaResolver = {
  resolve(schemaSlug: string, registrations: readonly WorkflowSchemaRegistration[]): WorkflowSchemaResolution;
};
type WorkflowSubmissionRequest = {
  kind: 'process';
  process: LegacyWorkflowProcess;
  fields: Readonly<Record<string, string>>;
  files: readonly LegacyWorkflowFile[];
  idempotencyKey?: string;
  executeSync: boolean;
  correlationId?: string;
};
type WorkflowSchemaRequest = {
  kind: 'schema';
  schemaSlug: string;
  fields: Readonly<Record<string, string>>;
  files: readonly LegacyWorkflowFile[];
  idempotencyKey?: string;
  executeSync: boolean;
  correlationId?: string;
};
type LegacyWorkflowRequest = WorkflowSubmissionRequest | WorkflowSchemaRequest;
```

The host lookup uses the authenticated principal to load the scoped registration list, then calls the business-owned pure resolver with the decoded slug and registrations; its result follows the existing internal registration shape (`businesses/document-core/src/pipelines/legacy-workflow-mapping.ts:22-34`). It does not accept an identity field or executable selector from the request.

The call to `request.resolvePrincipal()` is deliberately before body decoding. The principal is then passed unchanged to the host. No `apiKeyId`, tenant, user, or role form value is used to choose identity.

### 2.3 Host boundary `legacy-http-mount.ts:49-66,439-454` — expose internal capabilities

The current optional `submitLegacy` handles only the six core actions. The host gets platform-owned services and already submits with the principal's tenant/key (`legacy-host-adapter.ts:42-80`). Add workflow-specific capabilities rather than overloading that core-action method.

```diff
diff --git a/services/orchestrator/src/compat/legacy-http-mount.ts b/services/orchestrator/src/compat/legacy-http-mount.ts
@@
 export interface LegacyCompatHost {
+  submitWorkflow?(
+    principal: LegacyPrincipal,
+    request: WorkflowSubmissionRequest,
+  ): Promise<LegacySubmitOutcome | undefined>;
+  resolveWorkflowSchema?(
+    principal: LegacyPrincipal,
+    request: WorkflowSchemaRequest,
+  ): Promise<WorkflowSchemaResolution | undefined>;
   submitLegacy?(...): Promise<{ operationId: string; replayed: boolean } | undefined>;
 }
@@
-    const outcome = await host.submitLegacy?.(principal, docs.action, decoded.decoded);
+    // Existing core action path is unchanged.
+    const outcome = await host.submitLegacy?.(principal, docs.action, decoded.decoded);
*** End Patch
```

`WorkflowSchemaResolution` is an internal value: a server-owned registered business/action plus pinned version/revision and executable recipe selectors. It is not arbitrary recipe text from the client. Whether this value comes from a current runtime registry or a configuration catalog is Q2 below; its externally visible response stays subject to Q3/Q6 and COMP-00.

### 2.4 `legacy-host-adapter.ts:21-26,42-80` — mapping and submit under principal

Keep the six-core-action constant/method unchanged. Add a separate switch for the three evidenced workflow processes and route all submits through `ctx.artifacts` and `ctx.submission`. The LC path consumes its package-owned legacy translator; document-core actions consume their package-owned workflow adapters. The adapter must keep identity from `principal`.

```diff
diff --git a/services/orchestrator/src/compat/legacy-host-adapter.ts b/services/orchestrator/src/compat/legacy-host-adapter.ts
@@
 export const LEGACY_BUSINESS_ID = 'document-core';
+const WORKFLOW_TARGETS = {
+  disbursement: { businessId: 'document-core', action: 'disbursement' },
+  'lc-checker': { businessId: 'lc-checker', action: 'lc-checker' },
+  'doc-compare': { businessId: 'document-core', action: 'doc-compare' },
+} as const;
@@
   return {
     ...base,
+    submitWorkflow: async (principal, decoded) => {
+      const target = WORKFLOW_TARGETS[decoded.process];
+      const files = await storeWorkflowFiles(ctx.artifacts, principal.tenantId, decoded.files);
+      const submission = await adaptWorkflowInput(decoded, files);
+      const result = await ctx.submission.submit({
+        tenantId: principal.tenantId,
+        apiKeyId: principal.apiKeyId,
+        businessId: target.businessId,
+        action: target.action,
+        submission,
+      });
+      return { operationId: result.operation.id, replayed: result.replayed };
+    },
+    resolveWorkflowSchema: async (principal, request) =>
+      resolveFromSelectedSchemaSource(ctx, principal.tenantId, request.schemaSlug),
     submitLegacy: async (principal, action, decoded) => { /* existing core path */ },
*** End Patch
```

`storeWorkflowFiles`, `adaptWorkflowInput`, and `resolveFromSelectedSchemaSource` are intentionally named seams, not claimed existing helpers. Before implementation, each workflow adapter must be assigned to its business owner; the orchestrator should not duplicate business validation or run a schema interpreter. The target table is supported by the manifests cited in section 1; dispatch success still depends on D5 handoff/live registration and connector bindings.

## 3. Schema registration-list seam — Q2/Q3 options

The current pure helper `resolveLegacySchemaSlug(schemaSlug, registrations)` validates an active unique mapping and executable recipe selectors, but the caller must supply the registration list (`businesses/document-core/src/pipelines/legacy-workflow-mapping.ts:167-239`). No production loader or server call site was found. The Orchestrator port named `ctx.legacyWorkflowResolver` below is a proposed business-owned adapter seam; it does not exist today and keeps the schema resolver/interpreter out of the Orchestrator. The existing RegistryService exposes manifest registration/activation operations, not schema-workflow registrations (`services/orchestrator/src/modules/registry/registry.ts:21-40`). The following are alternatives, not decisions:

### Option A — live platform registry source (Q2)

If Product/architect says active workflow registrations live in the platform registry, add a schema-specific read capability to the existing registry service and inject a business-owned workflow resolver through the single server RouteContext/host. Do not assume the existing `ctx.registry` already supports this; current `RouteContext` has a registry service but no schema-registration method (`services/orchestrator/src/server.ts:1162-1188`).

```diff
diff --git a/services/orchestrator/src/server.ts b/services/orchestrator/src/server.ts
@@
 export interface ServerConfig {
+  legacyWorkflowResolver: WorkflowSchemaResolver;
 }
@@
 export interface RouteContext {
+  legacyWorkflowResolver: WorkflowSchemaResolver;
 }
@@
       config,
+      legacyWorkflowResolver: config.legacyWorkflowResolver,
diff --git a/services/orchestrator/src/modules/registry/registry.ts b/services/orchestrator/src/modules/registry/registry.ts
@@
+  async listActiveWorkflowSchemas(tenantId: string): Promise<readonly WorkflowSchemaRegistration[]> {
+    // read authoritative active registry rows; return pinned business/action,
+    // version/revision, and recipe selectors (no executable client text).
+  }
diff --git a/services/orchestrator/src/compat/legacy-host-adapter.ts b/services/orchestrator/src/compat/legacy-host-adapter.ts
@@
-    resolveWorkflowSchema: async (_principal, request) => ...
+    resolveWorkflowSchema: async (principal, request) => {
+      const registrations = await ctx.registry.listActiveWorkflowSchemas(principal.tenantId);
+      return ctx.legacyWorkflowResolver.resolve(request.schemaSlug, registrations);
+    }
```

This option depends on the registry actually owning these records and tenant scoping being specified; it may require a registry DB migration/module not present in the characterized code. The example module path is illustrative and must be changed to the real registry owner if selected.

### Option B — immutable server-config registration source (Q2)

If registrations are deployment-owned rather than tenant-authored, load a validated versioned catalog at startup and pass it to the business-owned workflow resolver through one injected port. The request does not supply the list, and the route does not interpret schemas.

```diff
diff --git a/services/orchestrator/src/server.ts b/services/orchestrator/src/server.ts
@@
 export interface ServerConfig {
+  legacyWorkflowResolver: WorkflowSchemaResolver;
+  legacyWorkflowSchemaRegistrations: readonly WorkflowSchemaRegistration[];
 }
@@
 export interface RouteContext {
+  legacyWorkflowResolver: WorkflowSchemaResolver; // business-owned resolver port
+  legacyWorkflowSchemaRegistrations: readonly WorkflowSchemaRegistration[];
@@
       config,
+      legacyWorkflowResolver: config.legacyWorkflowResolver,
+      legacyWorkflowSchemaRegistrations: config.legacyWorkflowSchemaRegistrations,
diff --git a/services/orchestrator/src/compat/legacy-host-adapter.ts b/services/orchestrator/src/compat/legacy-host-adapter.ts
@@
-    resolveWorkflowSchema: async (_principal, request) => ...
+    resolveWorkflowSchema: async (_principal, request) =>
+      ctx.legacyWorkflowResolver.resolve(request.schemaSlug, ctx.legacyWorkflowSchemaRegistrations),
```

This option needs a named config owner, validation/version lifecycle, and an agreed tenant visibility policy. It has no source in current `ServerConfig`/RouteContext today; the field and exact loading point are part of the later serialized server integration, not an existing capability.

**Q3 boundary:** both options return an internal resolution to the workflow host. The external behavior for `POST /api/v1/docs/workflows/schema`—including whether it is a run submission or schema lookup response and its existing body/status projection—must be pinned from legacy/COMP-00 before implementing `submitResolvedWorkflowSchema`. Neither option changes the route, wire fields, method, headers, or contracts.

## 4. Offline fixture outline

Proposed new suite: `services/orchestrator/tests/legacy-workflow-route.test.ts` (or extend `legacy-http-mount.test.ts` only after its owner approves). No test file was changed or run for this draft.

| Fixture group | Main cases |
|---|---|
| Dispatch table | Exact process strings map to the business/action targets in section 1; all three supported, unknown/missing process rejected using pinned legacy error fixture; core six-action routes still take the old branch. |
| Schema | Active unique registration resolves; missing, retired, duplicate, malformed, wrong-version and non-executable recipe registrations fail closed; Option A or B source is injected; `schemaSlug` cannot override registered target or recipe selectors. |
| Identity | Principal resolver provides tenant/key; multipart `apiKeyId`, tenant/user/role fields cannot select or override it; submission observes only principal identity; auth happens before consuming upload body. |
| Parity | Golden legacy fixture asserts existing path, status, headers, envelope, sync/replay and poll projection; includes the Q6-approved behavior only, with no new DTO or URL. |
| Multi-turn | Fake artifact, connector and continuation ports; verify child fan-out/join, waiting/resume, redelivery/idempotency and terminal projection through canonical runtime; no DB/Redis/S3/provider. |

## 5. Apply checklist, order, risks, and prerequisites

### Checklist

- [x] **D5 implementation/verification receipt exists:** `coordination/reports/qwen-d5-doc-compare-registration-2026-10-02.md` records focused suites and both package typechecks passing; D5b follow-up `coordination/reports/qwen-d5b-doc-compare-followup-2026-10-02.md` records the final follow-up checks.
- [ ] **D5 handoff/serialize before overlapping core edits:** the D5 source files remain modified in the shared worktree (`businesses/document-core/src/manifest/document-core.manifest.ts`, `businesses/document-core/src/worker.ts`, `businesses/document-core/src/pipelines/workflows/doc-compare/index.ts`). The receipt says the lease was released, but the current diff must be reviewed/settled by its owner before another lane edits the same files.
- [ ] **Q1 Product decision:** this draft uses the three evidence-backed legacy process names above. Confirm or replace the list; if changed, edit only the route process union/dispatch map and its fixtures.
- [ ] **Q2/Q3 Product/architect decision:** choose the authoritative schema registration source and pin what the schema endpoint does/returns. Neither source option is implemented today.
- [ ] **Q4 deployment/readiness decision:** verify each selected business is registered/active at the deployed Orchestrator and tied to the expected image/manifest. D5 package tests are offline evidence, not live activation.
- [ ] **Connector owner:** confirm deployed task names/slot bindings for each selected workflow. D5 leaves doc-compare defaults open; the P9 integration spec lists disbursement and LC slots as unresolved.
- [ ] **Q6/COMP-00:** select the approved submit/replay/sync/poll/waiting compatibility fixture. Contracts and public wire remain unchanged in this patch.
- [ ] **Single writer assigned:** one integrator owns the full server.ts route context/mount change and the compat mount/host-adapter series. No parallel server.ts edits.

### Suggested apply order

1. Close D5 handoff and reconcile its already modified package files; do not duplicate the D5 registration map.
2. Close Q1/Q2/Q3/Q4/Q6 and connector binding/readiness checks; record decisions before source edits.
3. One server integrator adds the host boundary/delegation and any single RouteContext composition needed. Preserve the current pre-canonical mount at `server.ts:1745-1767`; do not create another route table or wire surface.
4. Business owners provide/test each process adapter; connector owner confirms bindings; schema owner implements the selected source behind the internal resolver.
5. Add the offline fixtures in `4 and run focused suites/typechecks; only a separate approved task performs live integration verification.

### Risks

- **Partial mount mistaken for readiness:** the route is present but current POST workflow requests stop at the unconditional 503 (`legacy-http-mount.ts:397-407`).
- **D5 shared-file collision:** D5 has a completion receipt but its registration files remain modified/uncommitted; file ownership/merge state must be settled before touch.
- **No current schema source:** the pure resolver cannot answer the route without an authoritative registration loader.
- **Business adapter gaps:** LC has a pure legacy translator; document-core action registrations do not by themselves establish a common legacy input adapter. Owner/adapter contracts are still needed.
- **Connector mismatch:** a handler can be registered but fail when runtime task/slot names are unresolved.
- **Compatibility drift:** changing process names or submit/schema projections can change existing clients; COMP-00/Q1/Q3/Q6 remain authority.
- **Identity regression:** this route currently returns before resolving the principal. The later path must authenticate server-side and carry that principal through file storage and submission; never select tenant/key from form fields.

## 6. Open questions / draft readiness

1. Q1: confirm the three legacy process values as the accepted rework set, or identify the exact alternative and owner.
2. Q2: are active schema-workflow registrations owned by the runtime registry or by deployment configuration? Who writes/version-retires them, and are they tenant-scoped?
3. Q3: what operation does the schema endpoint perform and which legacy response fixture is authoritative?
4. Q4: what state constitutes registered/active and deployable for each business?
5. Q6: which existing submit/replay/sync/poll projection is approved by COMP-00?
6. Connector: who confirms each slot/task binding and deployment registration?

**Conclusion:** the server-side patch draft is sufficiently detailed to apply once these prerequisites are answered; it is not an authorization to apply now. The code-level route/mount/host changes and internal seams are scoped, while schema-source ownership, response projection, business activation, and connector bindings remain decision/verification dependencies. No contracts or wire change is proposed.
