# ACUI-01 PREP (read-only) — Admin BFF read/mutation foundation

- **Read pinned at 2026-10-02T06:24Z.** Nothing was written except this receipt.
- **CONV-12 landed the split DURING this prep, twice.** Timeline measured, because it changes which file you patch: ~06:10Z the split files existed (untracked); 06:17Z they were gone and `shell-router.ts` was back to 1916 lines; **06:18–06:19Z the split landed for real** and a new `auth-dispatch.ts` appeared. Current verified state (06:24:45Z): `shell-router.ts` 447 lines, `mutation-dispatch.ts` 118, `section-dispatch.ts` 595, `auth-dispatch.ts` 321, `shell-router-shared.ts` 398. **Anchors below are post-split**; the earlier pre-split numbers are kept only where they are explicitly labelled as such.

## 0. Correction to the packet premise (ACUI-M01)

The packet asks to "remove section POST going through the GET handler". **It does not go through the GET handler.** `dispatchShellRequest`'s `default:` branch intercepts `request.method === 'POST'` on a `section:*` route *before* `handleSectionGet` and returns:

```
405 — 'This Admin action has no server handler yet.'   // shell-router.ts:289 (post-split)
```

This changes the shape of the fix: the work is **adding handlers**, not stopping a fallthrough. Worth knowing before the patch is written, because a fallthrough bug and a missing-handler bug have different fixes and different regression tests.

## 1. Form → handler → admin action → params (all measured)

| # | Form source | POST path | Handler today | Admin action | params |
|---|---|---|---|---|---|
| 1 | `api-key-section-renderer.ts:259` | `/admin/api-keys/new` | ✅ `mutation-dispatch.ts:38` | `apikey.issue` | `{tenantId}` (body) |
| 2 | `api-key-section-renderer.ts:184` | `/admin/api-keys/{id}/revoke` | ✅ `mutation-dispatch.ts:39` | `apikey.revoke` | `{apiKeyId}` |
| 3 | `api-key-section-renderer.ts:163` | `/admin/api-keys/{id}/acknowledge` | ❌ **none** | — | — |
| 4 | `connector-section-renderer.ts:163` | `/admin/connectors/{id}/revisions/{rev}/rotate-secret` | ✅ `mutation-dispatch.ts:40` | `connectors.rotate_credential` | `{connectorId, mount, path, key, value}` (+`cas?`) |
| 5 | `connector-section-renderer.ts:209` | `/admin/connectors/{id}/revisions/{rev}/test` | ✅ `mutation-dispatch.ts:40` | `connectors.test_credential` | `{connectorId}` |
| 6 | `crypto-config-renderer.ts:87` | `/admin/crypto-config` | ✅ own handler | *(crypto store, not `admin/actions`)* | — |
| 7 | `business-section-renderer.ts:151` | `/admin/businesses/{id}/versions/{v}/enable` | ❌ **none** | `business.enable` | `{businessId, version}` |
| 8 | `business-section-renderer.ts:151` | `…/drain` | ❌ **none** | `business.drain` | `{businessId, version}` |
| 9 | `business-section-renderer.ts:151` | `…/retire` | ❌ **none** | **NO SUCH ACTION** | — |
| 10 | `operation-section-renderer.ts:293` | `/admin/operations/{id}/cancel` | ❌ **none** | `operations.cancel` | `{operationId}` |
| 11 | `operation-section-renderer.ts:248` | `/admin/operations/{id}/resume` | ❌ **none** | `operations.resume` | `{operationId, body?}` |
| 12 | `profile-section-renderer.ts:330` (`submitAction` = `'/admin/profiles'`, `:328`) | `/admin/profiles` | ❌ **none** | `apikey.bind-profile` (nearest existing) | `{apiKey, businessId, businessVersion, action, connectorBindings?, profileId?}` |

**Six of twelve forms have no server handler.** `matchShellRoute` prefix-matches (`p === item.path || p.startsWith(item.path + '/')`), so all six resolve to a `section:*` id and therefore all six get the **405**, not a 404. An operator sees a working button and a dead end.

**Row 9 is a different class of gap.** The renderer emits `retire`, and `ADMIN_ACTIONS` (`dispatcher.ts:95-121`) contains `business.enable`, `business.activate`, `business.drain` — **no `retire`**. The UI offers a verb the platform does not implement. Fixing row 9 needs a product decision (map it to `drain`? add the action? remove the button?), not a handler.

Unused in the UI today but present in the table: `business.activate`, `operations.sweep-deadlines` (takes **no params**), `connectors.revoke_credential`, `apikey.bind-profile` (only via profile form).

## 2. CSRF / role / tenant

### What is already right

- **Identity is session-derived, not token-derived.** `dispatchShellRequestAsync` resolves the opaque `du_session` first (`resolveOpaqueSession`) and passes `outcome.claims` + `outcome.csrfToken` into the mutation path; the legacy path uses `verifyCookie(cookieSecret, du_admin)`. The mutation plane therefore already has a server-side principal. ACUI-M07's worry about the *mutation* path is already solved.
- **The backend gate is a single pure triple** — `assertRoleActionTenant(action)` over (role × action × tenant), with the order: identity → tenant → **CSRF before role** → role → operator-tenant presence → tenant binding (`dispatcher.ts:28-29, 146-152`). The comment states the reason: a token-less cross-site POST must not be able to probe the role table.

### Three divergences worth deciding before the patch

**(a) CSRF is checked AFTER role in the shell, BEFORE role in the backend.** `handleAdminMutationPost` runs `claims.role !== 'admin'` first, then CSRF. For the 4 existing handlers this leaks nothing (all four are admin-only), but it is the opposite ordering from the deliberate backend rule, and it becomes a leak the moment an operator-allowed action is added — which rows 10/11 will do.

**(b) The shell hard-requires `role === 'admin'`, so operator-allowed actions are unreachable from the UI.** `operations.cancel` / `operations.resume` carry `cookieRoles: ['admin','operator']`. The shell's `claims.role !== 'admin'` check rejects an operator before the action table is ever consulted. Rows 10/11 will hit this immediately.

**(c) The audit actor is role-shaped, not person-shaped.** `dispatcher.ts:306` → `auth.kind === 'bearer' ? 'admin' : \`shell:${auth.role}\``. Every cookie/session mutation is attributed to `shell:admin`, never to a human. If ACUI-01's goal includes "who did this", the actor has to come from the session subject, and that is a backend change, not a shell change.

### ACUI-M07 — confirmed, and wider than stated

The **read** plane is the problem, not the mutation plane. `shell-server.ts:529-535` takes a single deployment-wide `config.adminToken` and every `*-section-data.ts` fetch takes `adminToken: string` and sends `Authorization: Bearer ${input.adminToken}`. So:

- **every** admin user, including `viewer` and `operator`, causes the shell to call the platform **as the platform**;
- the platform cannot distinguish which human caused a read;
- a `viewer` reading operations is, on the wire, indistinguishable from the platform itself;
- `deriveRoleFromToken(config.adminToken, token)` (`:532-533`) additionally maps a presented token equal to `adminToken` to `{role:'admin'}` — a second face of the same credential.

Principle-3-compliant shape: resolve the **session principal server-side**, and have the BFF present a *derived, per-principal* credential (or call the platform in-process behind the existing gate). It must never forward a user-supplied token as identity, and it must not use the shared platform bearer to represent a person.

### Role matrix — two tables disagree

| section | `getCanonicalNavItems` (routing) | `ALL_NAV_ITEMS` (view-model) |
|---|---|---|
| businesses / operations / overview | viewer | viewer |
| **profiles** | **admin** | **operator** |
| **connectors** | **admin** | **operator** |
| grants / api-keys | admin | *(absent)* |

`matchShellRoute` uses `getCanonicalNavItems()` (`p6-01-shell-fixtures.ts:222-230`), so the **route** demands admin for profiles/connectors. Which table drives the nav HTML I did **not** trace — `shell-render.ts:401` renders from `view.visibleNav`, and the builder was not followed. So I am **not** claiming operators see dead links; I am flagging that the two tables disagree and that the display side needs one owner. `view-models.ts:69,74` also prefix-matches against `ALL_NAV_ITEMS`, so a path can resolve to a different requiredRole depending on which table answers.

## 3. Diff sketch (against the CURRENT structure)

Target: extend the single mutation entry point rather than scatter handlers. Sketch only — no file was touched. **Applies to `mutation-dispatch.ts` post-split** (the mutation entry point now lives there; `shell-router.ts` only calls it).

```diff
--- a/src/app/admin/mutation-dispatch.ts   (post-CONV-12 location)
+++ b/src/app/admin/mutation-dispatch.ts
@@ handleAdminMutationPost @@
   if (request.method !== 'POST') return null;
   const issue = request.pathname === '/admin/api-keys/new';
   const revokeMatch = /^\/admin\/api-keys\/([^/]+)\/revoke$/.exec(request.pathname);
   const connectorMatch = /^\/admin\/connectors\/([^/]+)\/revisions\/(\d+)\/(test|rotate-secret)$/.exec(request.pathname);
+  const ackMatch        = /^\/admin\/api-keys\/([^/]+)\/acknowledge$/.exec(request.pathname);
+  const businessMatch   = /^\/admin\/businesses\/([^/]+)\/versions\/([^/]+)\/(enable|drain|retire)$/.exec(request.pathname);
+  const operationMatch = /^\/admin\/operations\/([^/]+)\/(cancel|resume)$/.exec(request.pathname);
+  const profileMatch    = request.pathname === '/admin/profiles';
-  if (!issue && !revokeMatch && !connectorMatch) return null;
+  if (!issue && !revokeMatch && !connectorMatch && !ackMatch &&
+      !businessMatch && !operationMatch && !profileMatch) return null;
 
@@ gate order: CSRF BEFORE role (aligns with assertRoleActionTenant) @@
-  if (claims.role !== 'admin') return fail(403, 'Access denied', 'Administrator role is required.');
   const csrfOk = oidcCsrfToken !== undefined
     ? verifySessionCsrf({ csrfToken: oidcCsrfToken } as SessionRecord, request.body['csrf'])
     : validateCsrfToken({ secret: config.cookieSecret, sessionCookie: request.cookies['du_admin'], provided: request.body['csrf'] });
   if (!csrfOk) return fail(403, 'Request rejected', 'Missing or invalid CSRF proof. Reload the page and try again.');
+  // Per-action role, from the SAME table the backend uses — not a blanket
+  // 'admin' check, or operations.* become unreachable for operators.
+  const wanted = resolveActionFor(request.pathname);
+  if (!wanted) return fail(400, 'Invalid request', 'Unsupported Admin action.');
+  if (claims.role !== 'admin' && !operatorAllowed(wanted)) {
+    return fail(403, 'Access denied', 'Administrator role is required.');
+  }

@@ action + params: reuse the dispatcher's own names, do not invent wire @@
-      issue ? 'apikey.issue' : revokeMatch ? 'apikey.revoke' : rotate ? 'connectors.rotate_credential' : 'connectors.test_credential',
+      issue ? 'apikey.issue'
+        : revokeMatch ? 'apikey.revoke'
+        : rotate   ? 'connectors.rotate_credential'
+        : businessMatch ? businessAction(businessMatch[3])
+        : operationMatch ? (operationMatch[2] === 'cancel' ? 'operations.cancel' : 'operations.resume')
+        : profileMatch ? 'apikey.bind-profile'
+        : 'connectors.test_credential',
 ```

**Notes that matter more than the sketch:**
- `businessAction('retire')` has **no target** — row 9 needs a decision before it can be coded (§1).
- `profile.form → apikey.bind-profile` is a **guess**: the profile form has no `apiKey` field visible in the renderer's action, and the action requires `apiKey`, `businessId`, `businessVersion`, `action`. Mapping the profile form onto this action may be semantically wrong; it needs a product answer, not just code.
- `acknowledge` has **no backend action at all** (copy-once acknowledgement is local UI state). It probably wants a local handler + redirect, not a platform call.
- The 303/201/200 response shapes already exist for rows 1-5; rows 7-12 should reuse them rather than invent a new envelope.

### Rebased map — CONV-12 has landed, so this is the shape you patch

Verified at 06:24:45Z, **after** the split landed:

| Concern | Post-split location |
|---|---|
| `handleAdminMutationPost` (all 4 existing handlers) | `mutation-dispatch.ts:31` |
| path matchers (`/admin/api-keys/new`, `/revoke`, connector `test`/`rotate-secret`) | `mutation-dispatch.ts:38-40` |
| the 405 "no server handler yet" branch | `shell-router.ts:289` |
| the three call sites that try the mutation path before GET dispatch | `shell-router.ts:365, 376, 415` |
| section GET + audit ledger handlers | `section-dispatch.ts` |
| crypto-config GET/POST | `crypto-config-dispatch.ts` |
| **new file, absent when this prep started** | `auth-dispatch.ts` (321 lines) |

**So every hunk in the sketch above goes into `mutation-dispatch.ts`, and nothing goes into `shell-router.ts`** — the 405 branch stays where it is and is simply reached far less often once handlers exist. The mapping table, role matrix and action/params names carry over verbatim, because the split moved code without changing it. Match by symbol (`handleAdminMutationPost`, `assertRoleActionTenant`, `ADMIN_ACTIONS`), not by line number: the file was rewritten twice while this prep ran.

`auth-dispatch.ts` is new since my first read and is **not covered by this prep**. Before applying anything, read it — it may already own the session/CSRF resolution that §2 assumes lives in the router.

## 4. Acceptance fixtures (outline)

Per the packet: prove a real side effect, prove tenant isolation, prove the failure codes change nothing.

**A. GET → edit → save → reload (side effect is real, not a redirect)**
1. `GET /admin/api-keys` as admin → 200, list contains no key with prefix `zz`.
2. `POST /admin/api-keys/new` with a valid CSRF and `tenantId=T1` → **201**, body carries `rawKey` exactly once.
3. `GET /admin/api-keys` again → the new key is present, `status: active`.
4. `POST /admin/api-keys/{id}/revoke` → **303**. `GET /admin/api-keys?keyId={id}` → the key is revoked, and its secret is **not** retrievable.
   - Repeat for rows 10/11 once implemented: cancel an operation, reload, assert the state actually moved (not just that a 303 came back).
   - A 405 is a **failure** of this fixture, not a pass.

**B. Operator tenant A cannot read B**
1. Operator cookie **with** `tenantId=T1` → `GET /admin/operations?tenantFilter=T2` → 200 with **zero** rows from T2.
2. `POST /admin/operations/{opInT2}/cancel` → the tenant fence must yield the **indistinguishable 404**, not a 403 that confirms the operation exists (`dispatcher.ts:407-410` states this is the intent).
3. Same operator, `POST /admin/operations/{opInT1}/cancel` → 303. This is the leg that proves `cookieRoles: ['admin','operator']` actually works end to end — and the leg that fails today because the shell hard-requires admin.
4. Operator **without** `tenantId` → 403 (`operator-without-tenant` guard, `dispatcher.ts:209-217`).

**C. Failure codes change no state**
For each of 401 (no session), 403 (viewer / CSRF missing / CSRF wrong), 404 (unknown id, and foreign-tenant id), 409 (already-revoked / idempotency conflict), 422 (missing or malformed params):

- assert the status **and** that a follow-up `GET` shows the resource **byte-identical** to before the attempt;
- assert the CSRF matrix specifically: absent token → 403, wrong token → 403, **token minted from a different valid session → 403**, correct token → proceeds. That third leg is the one that proves the binding, not just the presence;
- assert no write reaches the audit log for a rejected attempt, and that a *rejected* attempt never reports `tenantId` back to the caller.

**D. ACUI-M07 regression (the point of the exercise)**
1. As a **viewer**, read `/admin/operations` over a real socket. Assert the platform-side call is attributable to the session principal.
2. Assert the bearer presented upstream is **not** `config.adminToken` for any non-platform principal — this is the assertion that fails today, and it is the one that makes the change worth doing.

## 5. Checklist to apply (when the patch runs)

1. Re-verify CONV-12's end state; match by symbol, not line number.
2. Extend `handleAdminMutationPost` — do not add a second entry point.
3. Move CSRF ahead of the role check; replace the blanket `admin` check with the dispatcher's own `cookieRoles`.
4. Reuse action ids and param names from `ADMIN_ACTIONS` / `dispatchAdminAction`; do not invent wire.
5. Resolve `retire` (row 9) and the profile→`apikey.bind-profile` mapping (§1) as product decisions **before** coding.
6. Give `requiredRole` a single owner; reconcile `getCanonicalNavItems` vs `ALL_NAV_ITEMS`.
7. ACUI-M07 separately: the read plane must stop presenting the shared platform bearer as a user. That is its own packet — it touches `shell-server.ts` config plumbing and every fetcher signature.

## 6. Open questions

1. **`retire`** — map to `drain`, add `business.retire`, or drop the button?
2. **Profile form** — which action actually expresses "save this profile binding"? `apikey.bind-profile` requires an `apiKey`, which the form does not obviously carry.
3. **`acknowledge`** — platform action or purely local UI state?
4. **Operator scope** — should operators get rows 10/11 in the UI now (the table allows it), or is the shell's admin-only rule deliberate?
5. **Actor attribution** — is `shell:admin` acceptable for audit, or must ACUI-01 carry the session subject into the actor? Backend change, not shell.
6. **`getCanonicalNavItems` vs `ALL_NAV_ITEMS`** — which is authoritative for display?
7. **CONV-12 end state** — does the split land, and does `shell-router.ts` keep re-exporting the moved symbols?

## RESUME POINT

- **ACUI-01 PREP closed 2026-10-02 (read-only).** No source, test, task or docs file was modified; only this receipt exists.
- Findings that change the work: the 405 branch already exists (premise corrected), **6 of 12 forms have no handler**, `retire` has no backend action, and the read plane presents the shared platform bearer for every role.
- **The tree moved twice during this prep.** CONV-12's split landed at 06:18-06:19Z and introduced `auth-dispatch.ts`. All anchors here are post-split, verified 06:24:45Z. **Read `auth-dispatch.ts` before patching** — this prep does not cover it.
- **Reproduce:** match by symbol, not line number: `handleAdminMutationPost` in `mutation-dispatch.ts`, `assertRoleActionTenant` and `ADMIN_ACTIONS` in `modules/admin-actions/dispatcher.ts`, form targets in the `*-section-renderer.ts` files.
