# ACUI-DEC-PREP — admin-surface decision pack

Read-only code characterization prepared 2026-10-02 from the current `du-rework` working tree. This is decision support, not a gate verdict: no source/tests or COMP rows were changed, no gates were ticked, and no live requests were made. “Settle from code” means the present behavior is directly identifiable; it does not decide whether that behavior is the desired policy.

## 1. CSRF ↔ role ordering

**Evidence.** `services/orchestrator/src/app/admin/mutation-dispatch.ts:37-41` only claims POSTs for API-key issue/revoke and connector test/rotate-secret; unmatched paths return `null`. For a matched route, shell checks session presence and `role === 'admin'` at `:50-51`, then CSRF at `:52-59`. The backend action gate first checks auth and action-table membership (`services/orchestrator/src/modules/admin-actions/dispatcher.ts:169-180`), then for a known cookie action checks CSRF before `cookieRoles` (`:181-202`). Thus “CSRF before role” is true for known cookie actions, not before action lookup: unknown actions return 404 before CSRF. Shell routing sends unmatched section POSTs to 405 (`services/orchestrator/src/app/admin/shell-router.ts:278-294`).

**Options / blast radius.**

1. Keep the two gates as-is and document their distinct scope. Lowest immediate change; preserves admin-only shell forms, but future widening of the shell helper can drift from backend ordering and produce different denial detail.
2. Make shell dispatch use the same action-aware policy: resolve authenticated session, reject CSRF for a known cookie mutation, then apply that action’s role/tenant policy. More consistent denials; affects mutation routing and operator-accessible forms, and requires preserving the backend’s stored-tenant fence.
3. Keep shell admin-only but add an explicit second backend authorization check before any side effect. Defense-in-depth, but duplicated policy remains and does not by itself align response ordering.

**Recommendation.** Prefer one shared/action-aware policy if shell mutation coverage is expanded; until then, explicitly treat the shell helper as a separate admin-only route policy. **Code status settleable now:** ordering and route coverage are clear. Whether to expose operator mutations from shell is a policy choice.

## 2. Shell hard-role vs `operations.cancel/resume` cookie roles

**Evidence.** The backend table permits cookie roles `admin` and `operator` for both actions (`services/orchestrator/src/modules/admin-actions/dispatcher.ts:112-113`); known-cookie action order is CSRF, role, then operator must have a server-side tenant (`:181-217`). Admin maps to platform and a tenant-bearing operator maps to tenant-operator (`:293-302`); cancel/resume resolve the operation’s stored tenant and re-check the fence before calling lifecycle/runtime (`:417-428`, `:457-465`). The shell mutation helper does *not* match operation paths (`services/orchestrator/src/app/admin/mutation-dispatch.ts:37-41`); operation forms are rendered at `operation-section-renderer.ts:248-258,293-295`. `/admin/operations/...` is matched as a section route by prefix (`shell-router.ts:200-205`), and a section POST currently receives 405 (`:278-294`). Operations is a viewer-level section (`p6-01-shell-fixtures.ts:222-229`), so the form can be displayed to a viewer even though its POST has no shell handler. The backend `/api/v1/admin/actions` route independently resolves cookie/bearer auth and dispatches (`server.ts:2392-2417`).

**Options / blast radius.**

1. Keep current state: backend action capability exists, shell form remains unavailable (405). No role expansion; the rendered cancel/resume controls are misleading/nonfunctional until routed.
2. Wire the forms through the action dispatcher using its `admin`/tenant-bound `operator` policy. Enables operator actions for their server-side tenant and admin platform actions; requires CSRF proof and retained stored-tenant enforcement.
3. Restrict shell operations forms/actions to admin only, even though backend allows operators. Smaller exposed role set, but creates an intentional shell/backend policy difference and may hide the operator workflow.

**Recommendation.** Do not infer that the shell’s hard-admin helper currently blocks these actions: it does not own their paths. Decide explicitly whether to wire operator forms; if wired, use backend’s action+tenant policy. **Code status settleable now:** backend allowlist, form routes, and current 405 are explicit; desired shell role set is a policy choice.

## 3. Audit actor identity

**Evidence.** Audit actor is `admin` for bearer auth and `shell:${role}` for cookie auth (`services/orchestrator/src/modules/admin-actions/dispatcher.ts:305-307`), then passed to audit dispatch (`:316-321`). `AdminCookieClaims` only has role/issuer/iat/exp, no subject (`services/orchestrator/src/app/admin/shell-types.ts:27-35`). OIDC session creation stores `sub` server-side (`oidc-flow.ts:224-228`), but `resolveOpaqueSession` returns role/issuer/timestamps and drops subject (`auth-dispatch.ts:282-299`). Further, shell’s mutation proxy sends the shared admin bearer to the action endpoint (`shell-server.ts:365-379`), so downstream audit sees bearer actor `admin`, not the shell role/person.

**Options / blast radius.**

1. Keep role/platform labels: minimal plumbing and low personal-data exposure, but cannot answer which person performed a mutation.
2. Carry a stable internal user ID or opaque OIDC subject from the verified server-side session into trusted action/audit context. Best attribution with less display PII; changes session/action interfaces, audit schema or actor contract, and retention/access expectations.
3. Record email: human-readable, but personal data, mutable, and expands audit-data exposure. A token prefix is a poor substitute: it identifies a credential rather than a person, can correlate a secret-bearing credential, and rotation/sharing makes attribution ambiguous.

**Recommendation.** If ACUI-01 requires individual accountability, use a stable opaque subject/internal ID, not raw token material; otherwise retain role labels and state their limitation. **Code status settleable now:** actor is role/platform-shaped and subject is dropped; whether person-level audit is required is a policy choice.

## 4. ACUI-M07 — shared platform token on Admin READ surfaces

**Evidence.** `shell-server.ts:355-364` puts one configured `adminToken` into shell runtime and wires default section fetchers. Operations forwards that token plus query-derived tenant/state/id filters (`section-dispatch.ts:405-428`); its data fetch sends `Authorization: Bearer ${input.adminToken}` (`operation-section-data.ts:1136-1147`). Overview takes `tenantId` from the request (`section-dispatch.ts:450-480`), builds usage/audit/operations URLs using that value (`overview-section-data.ts:626-641`), and sends the same bearer (`:654-664`). Audit passes the same token and user-supplied filter fields (`section-dispatch.ts:561-585`); the fetcher sends it verbatim (`audit-section-data.ts:470-478,529-543`). These are role-gated panes: operations/overview are viewer-level (`p6-01-shell-fixtures.ts:222-229`), audit requires operator (`shell-router.ts:189-190`; guard `section-dispatch.ts:518-544`). On the API side, a platform principal is allowed to select the requested tenant (`modules/admin-actions/rbac.ts:71-82`); operations list chooses that admin-principal branch before API-key handling (`server.ts:1817-1830`), and usage similarly scopes a platform bearer from `tenantId` (`:1351-1359`).

**Current blast radius (code-path inference, not a live probe).** When a JSON API base URL is configured, a signed-in viewer can reach Operations/Overview and the server makes their reads as the deployment’s platform principal; request query controls the tenant scope the platform API receives. Audit is reachable by operator/admin, likewise under the shared platform bearer. The token is used server-side, not emitted by these fetchers to the browser; the issue characterized here is overbroad delegated scope and loss of per-user identity at the API boundary. Other panes also carry the token in their fetch inputs but are admin-role-gated. No cross-tenant read was executed.

**Options / blast radius.**

1. Per-user/scoped read credentials: narrows authority and improves attribution; requires credential issuance/lifecycle and API authorization changes.
2. Keep the platform token server-side behind a session-aware BFF/proxy that enforces role and tenant scope before each read. Preserves upstream platform credential; changes fetcher plumbing and policy tests, and must not trust a query-selected tenant for a tenant-scoped user.
3. Keep current shared token but gate global-scope panes (at least Operations/Overview and audit) to platform admins until a scoped proxy exists. Smallest immediate code surface; reduces viewer/operator capability and requires a product decision about those roles.

**Recommendation.** Near-term, do not let viewer/operator-selected scope flow to a platform credential without an explicit scope policy; gate those panes or enforce a server-derived tenant-aware proxy. Long-term, prefer the BFF policy while keeping the bearer secret server-side. **Code status settleable now:** token reuse, pane roles and query forwarding are explicit; desired cross-tenant Admin UX is a policy choice.

**Prior-receipt reconciliation.** `qwen-acui01-prep-2026-10-02.md:54-63` correctly identifies the shared token on reads. Its `:43` statement that mutation identity is session-derived is true at the shell authorization boundary (`shell-router.ts:358-367`), but incomplete for downstream attribution: `shell-server.ts:365-379` calls the action API with the deployment bearer, and `actorOf` consequently reports `admin` (`dispatcher.ts:305-307`). The old `:48` future-risk warning about role ordering applies if the shell helper is widened; current operation cancel/resume paths are not in that helper and currently get section-POST 405 as described in item 2.

## 5. `business.retire` has no action counterpart

**Evidence.** The dispatcher action table contains `business.enable`, `business.activate`, `business.drain`, but no `business.retire` (`services/orchestrator/src/modules/admin-actions/dispatcher.ts:95-106`; `rg business.retire services/orchestrator/src` found no source occurrence). `business.drain` calls `deactivateVersion` and records `business.drain` (`dispatcher.ts:360-379`). The API route is PUT `.../deactivate` and audits as `business.drain` (`server.ts:2213-2237`). The registry only accepts `ENABLED` and flips `is_active=false`; it does not set a `RETIRED` state (`modules/registry/registry.ts:156-179`). Nevertheless the renderer emits enable/drain/retire chips (`business-section-renderer.ts:138-155,188-192`), and its view model marks retire allowed for DRAINING (`business-view-models.ts:166-171,377-379`). Generic section POST currently answers 405 (`shell-router.ts:278-294`); direct unknown action is 404 (`dispatcher.ts:177-179`).

**Options / blast radius.**

1. Map `retire` to `drain`: reuses existing route/action but changes the apparent terminal meaning into “stop routing new submissions”; no retired transition is persisted.
2. Add a distinct `business.retire` action and corresponding lifecycle operation/route/audit semantics. Introduces a new terminal state/authorization/transition contract and impacts registry, UI, API, tests, and consumers.
3. Remove or disable the retire chip until a matching capability exists. Prevents advertising an unsupported action; reduces UI capability without changing backend lifecycle.

**Recommendation.** Do not alias a permanent-retire control to the current reversible `is_active` drain operation. If `RETIRED` is a real required lifecycle state, choose a distinct action; otherwise disable/remove the chip. **Code status settleable now:** absence and current drain semantics are clear; whether a retired state belongs in the product is a policy choice.

## 6. Canonical x-api-key 403 shadowed by compatibility facade

**Evidence.** The server invokes the compat facade before canonical routes and returns any non-null response immediately (`services/orchestrator/src/server.ts:1745-1768`). For operations, the facade declines requests carrying any `Authorization: Bearer ` prefix (`compat/legacy-http-mount.ts:118-120,457-464`); otherwise its GET list resolves the API-key principal and reads legacy `filter`, page size/token, and the principal-derived tenant/key (`:502-532`). The host SQL predicate includes `tenant_id = $1` (`compat/legacy-host-adapter.ts:116-138`). The canonical list’s API-key path checks a supplied foreign `tenant` and returns 403 (`server.ts:1832-1844`), but a pure x-api-key request without an Authorization bearer is answered by the earlier compat branch. Its legacy filter parser only honors state/processor (`legacy-http-mount.ts:305-334`), so a canonical `?tenant=foreign` is not a compat scope selector and does not widen the SQL tenant fence. The compat response uses the legacy envelope (`:528-532`), not the canonical list body.

**Options / blast radius.**

1. Keep compat ownership: retains existing legacy list envelope/filter/page-token behavior and the key-derived tenant fence; canonical foreign-tenant 403 is not the observed response for a pure key-only list request because that route is shadowed.
2. Remove/decline compat ownership for this route: all requests reach canonical behavior and foreign `tenant` yields 403; breaks clients relying on the legacy envelope, filter grammar or page token.
3. Keep the route split and document it explicitly: legacy x-api-key requests retain compat semantics; platform-bearer Admin shell requests bypass compat and use canonical semantics. Preserves both wire contracts, but requires clear contract/version documentation and tests against accidental shadow changes.

**Recommendation.** Keep and document the split if legacy list compatibility remains required; do not describe the canonical 403 as applying to pure x-api-key requests while the facade owns them. If the 403 contract is intended for every key-authenticated list request, the ownership decision must instead be changed deliberately. **Code status settleable now:** precedence and current fence are clear; desired public wire contract is a policy choice. This finding is a response-contract shadow, not evidence from this inspection of cross-tenant data access.

## Decision summary

| Item | Facts settleable from current code | Still needs a product/security choice |
|---|---|---|
| CSRF / role order | Shell helper is role-first for its matched admin-only paths; backend checks CSRF before role for known cookie actions, after action lookup. | Whether shell should expose operator actions and whether to unify policy/order. |
| Cancel/resume roles | Backend allows admin/operator with server-side tenant fence; current shell section POST is 405. | Whether to wire operator-facing forms or keep shell admin-only/unavailable. |
| Audit actor | Actor is `admin` or `shell:<role>`; verified OIDC subject is dropped before dispatcher. | Whether human-level attribution is required and which identifier contract/privacy posture to use. |
| ACUI-M07 | Configured fetchers send one server-side platform bearer; viewer/operator-accessible panes forward scope filters. | Whether to scope via BFF credentials or gate global reads by role. |
| `business.retire` | No action; drain only flips `is_active`, while UI exposes retire. | Whether `RETIRED` is a lifecycle state, or the unsupported control should be absent. |
| Compat vs canonical list | Compat runs first for key-only requests and fences SQL by key-derived tenant; canonical 403 is shadowed. | Preserve/document legacy contract or move route ownership to canonical contract. |
