# Receipt - BIZ-09 Business Detail Cockpit (implementation)

- **Date:** 2026-10-11
- **Lane:** P0-P5 API keys -> Profile move, Businesses surface
- **Spec:** BIZ-04 (receipt-biz-04-cockpit-component-spec-2026-10-11.md)
- **Dependency:** BIZ-07 profile workflow read: GET /api/v1/admin/profiles/:b/:v/:n/workflows, plus the AWEB-14 client method
- **Git:** no git add, no commit, no push (COORDINATOR-CONTRACT)

## 1. What landed

| File | What |
|---|---|
| `apps/admin-web/src/features/businesses/business-detail-cockpit.tsx` | the component: 4 cards, 4 independent reads |
| `apps/admin-web/src/features/businesses/cockpit-sample-time.ts` | the sample-time helper, in its own .ts |
| `apps/admin-web/tests/business-cockpit-sample-time.test.mjs` | 6 unit tests for that helper |
| `apps/admin-web/src/features/businesses/businesses-screen.tsx` | mounts the cockpit once a business was opened |

Reads used, each verified in the tree before use:

| Card | Client method | Endpoint |
|---|---|---|
| Versions | `getBusinessVersions(businessId)` | business versions read |
| Workers | `listWorkerInstances({ businessId })` | GET /api/v1/admin/worker-instances at admin.ts:416 |
| Profiles | `listProfiles({ businessId })` | GET /api/v1/admin/profiles at admin.ts:562 |
| Workflows | `listProfileWorkflows(b, v, name, tenantId)` | GET /api/v1/admin/profiles/:b/:v/:n/workflows at admin.ts:773 (BIZ-07) |

BIZ-07 dependency confirmed by reading the source, not by trusting the receipt: the route exists at admin.ts:773 through `modules/admin-read/profile-workflows.ts`, and the client method at client.ts:417. An earlier grep of mine used a pattern that missed both, and on that grep alone I would have reported the route missing.

## 2. BIZ-04 rules and how each is enforced in code

| Rule | Enforcement |
|---|---|
| 1. no number without its sample time | every card header renders SampleTime, printing `sampled <at>`, or `no sample time reported by this read` when the payload carries none |
| 2. absence is not zero | an empty list renders `No heartbeat rows for this business.` and never `0 workers`; same shape for profiles and versions |
| 3. never recompute health in the browser | renders the server health column; lastSeenAt and observedAt are shown as data, never fed into a client-side freshness rule |
| 4. revision 0 means unsaved | the profile row renders the string `unsaved` in place of the revision |
| 5. a missing read is not an empty table | Block has a first-class `unavailable` variant, used by the workflows card when there is no profile to resolve against |
| 6. print the registry column | versions prints status and is_active as two separate columns, never fused into one badge |
| 7. blocks are independent | four Block states and four loaders; one 403 or 502 leaves the other three rendering |

The worker page's `truncated` flag renders a visible warning rather than silently capping rows.

## 3. Deviation from the BIZ-04 spec, recorded rather than hidden

BIZ-04 described the Workflows card as business-level. The BIZ-07 read is PROFILE addressed: `profile_workflow_bindings.profile_id` resolves the bindings, and business_id / business_version only filter the catalog. A business-level rollup would need either an aggregation the platform does not have, or showing one profile's bindings as if they were the business's, which is exactly the fabrication rule 5 forbids.

So the card is profile-scoped: a selector defaults to the first profile from the Profiles card, and the card refetches per selection. With no profile at all it renders the explicit unavailable reason.

## 4. Component contract

```tsx
export function BusinessDetailCockpit({ businessId }: Props): React.JSX.Element
// type Block<T> = loading | ready(data) | failed(problem) | unavailable(reason)
```

Mounted in businesses-screen.tsx behind `versions.kind === 'ready'`, so the cockpit never fetches for a business the operator has not opened.

## 5. Verification

```
cd /d D:\Git\dugate\du-rework\orchestrator\apps\admin-web

node --test tests/business-cockpit-sample-time.test.mjs
-> pass 6 / fail 0 / exit 0
   (no rows -> null; rows with no timestamp -> null; newest across columns;
    observedAt beats updatedAt on one row; explicit null is skipped; order-independent)

npx tsc --noEmit -p tsconfig.json   -> TSC_EXIT_0
npm run build                        -> vite 2701 modules, exit 0
```

## 6. Not done / risk

- **No browser evidence.** Nothing has been driven through a browser: no screenshots, no end to end run. The component typechecks and its helper is unit tested; the fetch, error and render loop is not.
- The browser harness has **no stub** for worker-instances, the admin profiles list, or the workflows read, so the three new cards cannot be exercised in the harness as it stands.
- `newest()` compares ISO strings lexically. Correct for the UTC shape every read here emits, but a read emitting a different shape would mis-order silently. Not asserted by a test.
- The workflows card refetches on every profile switch, and the profiles card reads page 1 with limit 100, so a business with more profiles selects from the first page only.
- The sample-time helper lives in its own .ts because Node type stripping does not handle JSX, so a .tsx module cannot be imported by `node --test`.