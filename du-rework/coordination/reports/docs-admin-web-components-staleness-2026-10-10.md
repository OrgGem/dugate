# admin-web components & api-index staleness audit

| Field | Value |
|---|---|
| Packet | AWEB-COMPONENTS-INDEX-STALENESS-AUDIT-2026-10-10 |
| Repo scope | `du-rework` only |
| Plan ref | summary-frontend-admin-workspace-delivery-2026-10-10.md |
| Surface audited | `src/components/**` (15 files) and `src/lib/api/index.ts` |
| Widened reads | the api barrel answers a question about `types.ts` and `client.ts` (F1, F3); duplicate-name detection widened to all 80 files of `src` (F2, F7). Both are labelled below |
| Date | 2026-10-10 |
| Method | static import-graph over source, alias `@/` resolved; no browser, no code change |
| Typecheck at audit time | PASS, exit 0 |
| Tests at audit time | PASS, 82/82, 18 suites, exit 0 |
| Bounds honoured | no git add / no commit / no push; no product code touched; zero double quotes in this document |
| Revision | rev 2, after a review pass that re-verified every cited line and added F8 |

This is a read-only audit. Nothing was edited, and no gate is ticked.

---

## 1. Method, and the three mistakes that nearly corrupted it

The audit is an import-graph: every `import { ... } from` and `export { ... } from` in
the tree is resolved to a file, then each exported name is checked against the set of
names actually imported from that file. Three corrections were applied before any
finding was accepted, and all three first produced a wrong answer:

**Alias resolution is mandatory.** A scan that treats `@/components/ui/button` as an
unresolvable specifier reports every component as unused. The audit resolves `@/` to
`src/` and relative specifiers to absolute paths, and accepts a target only when a
real file exists (bare, `.ts`, `.tsx`, `index.ts`, `index.tsx`).

**Multi-line import blocks must be parsed by regex, not by line.** A line-by-line scan
finds `import {` on one line, never sees the names on the next lines, and concludes
the module is unused. This is not hypothetical: an early pass of this audit reported
`parseAuditPage` and `severityVariant` as dead, because `overview-screen.tsx` pulls
them from `./state` across a multi-line block spanning lines 41 to 46. Both are live.
Any liveness count produced line-by-line is wrong.

**A scan will find itself.** The first verification pass matched the candidate names
inside its own scratch `.tmp-*.cjs` files, inside `components/ui/README.md`, and inside
the minified `dist/assets/*.js` bundle, and therefore reported every dead export as
having consumers. During the review pass the same failure recurred: a repo-wide grep for
the F8 names matched the review script itself, and reported names such as
`AdminApiClient` as contested by 54 references that were really 54 occurrences of the
substring `createAdminApiClient`. The final counts come from an import-block regex over
source roots only.

---

## 2. Findings

| # | Finding | Severity |
|---|---|---|
| F1 | `BffHealthResponse` is an **unused, drifted duplicate** of `AdminHealthSnapshot` | medium |
| F2 | `parseAuditPage` and `severityVariant` exist **twice**, both live, and disagree on a severity the backend really emits | medium |
| F3 | `OperationTaskWire` is exported by the barrel source but **not re-exported by the barrel** | low |
| F4 | 2 files import `lib/api` leaf modules directly instead of through the barrel | low |
| F5 | 11 exported component names have **no code consumer at all** | low |
| F6 | 4 exported names are **test-only** (no product consumer) | low |
| F7 | **No duplicate exported type or interface names** anywhere in `src` | none - clean |
| F8 | **24 of the 88 names the barrel re-exports are never imported through the barrel** | low |

---

## 3. F1 - unused, drifted duplicate: `BffHealthResponse`

Two health shapes exist. They carry the same eight fields with the same names:

| Field | `BffHealthResponse` (types.ts:470) | `AdminHealthSnapshot` (client.ts:65) |
|---|---|---|
| `status` | ok / degraded / unknown | identical |
| `db`, `redis` | boolean or null | identical |
| `queueIntegrity.state` | OK / RECONSTRUCTING / SUSPECT | identical |
| `queueIntegrity.orphansLast` | **`number`** | **`number or null`** |
| `queueIntegrity.stalled` | **`number`** | **`number or null`** |
| `activeLeases` | **`number`** | **`number or null`** |
| `outboxBacklog`, `sampledAt` | identical | identical |

Three counters are non-nullable in one and nullable in the other.

Consumers, counted over all 80 files in `src`:

```text
BffHealthResponse   consumers=1  src/lib/api/index.ts:12   <- the barrel line that names it
AdminHealthSnapshot consumers=9  app-shell.tsx:8,40 · operations-monitor-dashboard.tsx:27,47 ·
                                  overview-screen.tsx:33,236 · client.ts:82,349 · index.ts:2
```

So the drifted copy has **zero product consumers**. Its only reference is the barrel line
that re-exports it.

Which of the two is the safe shape is not a matter of taste, and the reason is that
`AdminHealthSnapshot` is the one the client actually returns from
`getHealth()`. The client declares those three counters nullable, so the product type
already accepts a payload in which a counter was not read. The non-nullable copy cannot
describe such a payload, so a maintainer adopting it would be asserting a guarantee the
declared product type declines to make. Whether the live endpoint ever answers null for
these counters was **not measured**; the argument rests on the type declarations, not on
observed traffic.

Recommendation: delete `BffHealthResponse` from `types.ts` and remove its barrel line.
This is a source change and therefore **outside this read-only packet**.

---

## 4. F2 - two live copies of the same helper, and a regression against the legacy shell

`src` exports both names from two modules. Neither copy is dead.

| Consumer | Imports from |
|---|---|
| `overview-screen.tsx` lines 41-46 | `./state` = `features/overview/state` |
| `audit-screen.tsx:23` | `./state` = `features/audit/state` |
| `trace-screen.tsx:12` | `@/features/audit/state` |

### severityVariant - the two disagree on a severity the backend really emits

The shared contract declares `AUDIT_SEVERITY_VALUES = ['info', 'success', 'warning',
'error']` (`packages/contracts/src/public-api.ts:559`). That `success` is not a
theoretical member of the enum:

```text
production sites writing severity success, across orchestrator
  modules/admin-actions/dispatcher.ts        12 sites (512, 805, 950, 1065, 1108, 1146,
                                               1237, 1334, 1375, 1415, and more)
  http/routes/admin.ts                       120
  modules/auth/admin-local/repository.ts     237, 270
  app/admin/crypto-config-api.ts             314
```

| input | audit copy (audit/state.ts:135) | overview copy (overview/state.ts:174) |
|---|---|---|
| `success` | **`success`** | **falls through to `neutral`** |
| `warning` | `warning` | `warning` |
| `error`, `critical` | `danger` | `danger` |
| `info` | `info` | `info` |
| `debug` | `neutral` | `neutral` |

The overview copy has no `success` arm, so a success event renders with the neutral badge
on the Overview audit card, while the same event renders as `success` on the Audit screen
and inside Trace.

This is also a **regression against the shell it replaces**. The legacy view model at
`app/admin/overview-view-models.ts:271` maps `operation.complete` to
`severity: 'success'`, and `admin-overview-view-model.test.ts:540` asserts
`auditSeverityBadge('success')` returns `success`. The legacy Overview therefore
rendered these events as successes; the Portal Overview does not.

### parseAuditPage - different defaults, different fields

| behaviour | audit copy (audit/state.ts:45) | overview copy (overview/state.ts:71) |
|---|---|---|
| severity missing | defaults to `unknown` | defaults to `info` |
| `message` field | **not carried at all** | carried, defaults to `kind` |

A wire event with no `severity` is therefore `unknown` on one screen and `info` on
another, and only one of the two can render the human message.

Recommendation: keep one implementation and import it in both places. That is a source
change, so it is reported, not done. The `success` arm is the correct behaviour and the
overview copy is the defective one, but collapsing the copies also changes what the
Overview card renders, so the direction belongs to the plan owner rather than to this
audit.

---

## 5. F3 and F4 - the api barrel

`src/lib/api/index.ts` re-exports 88 names from `types.ts` and `client.ts`.

| Check | Result |
|---|---|
| Re-exported names that do not exist in the source | **0** |
| Source names the barrel omits | **1** |
| `types.ts` exported declarations | 83 |
| `client.ts` exported declarations | 6 |

**F3.** The one omission is `OperationTaskWire` (`types.ts:411`). It is consumed by
`features/trace/state.ts`, which cannot get it from the barrel and imports
`@/lib/api/types` directly instead.

**F4.** Exactly 2 of 80 files import a leaf module rather than the barrel:

```text
src/app-shell/app-shell.tsx      line  8  import type { AdminHealthSnapshot } from '@/lib/api/client';
src/features/trace/state.ts      line  8  } from '@/lib/api/types';
```

In `app-shell.tsx` the file already imports `@/lib/api` on line 7 for
`createAdminApiClient` and `AdminWebSession`, and `AdminHealthSnapshot` **is** already
re-exported by the barrel - so that one import is a duplicate path with no cause at all.
`trace/state.ts` is genuinely blocked, but only by 1 of its 5 names: the other 4
(`OperationArtifactWire`, `OperationDetail`, `OperationWire`, `OperationsPage`) are all
in the barrel and are being fetched from the leaf for convenience.

Recommendation: add `OperationTaskWire` to the barrel and fold both leaf imports back
into the single `@/lib/api` specifier each file already uses. Source change, reported
not done.

---

## 6. F8 - a quarter of the barrel public surface is never reached for

This is the question the barrel exists to answer, and the review pass found it had been
skipped. Of the 88 names `lib/api/index.ts` re-exports, **24 are never imported through
the barrel by any file in admin-web src**:

```text
ActionOptions · AdminApiClient · AdminApiClientOptions · ApiKeyGrant · ApiKeyPage
BffHealthResponse · CallbackAuth · CallbackConfiguredHeadersAuth · CallbackNoneAuth
ConnectorActivateParams · ConnectorRevisionCloneParams · ConnectorRevisionTarget
ConnectorUpsertParams · CryptoConfigView · ManagedValueProvider
ProfileKeyActionResult · ProfileMutationResult
SecretCatalogCreateBody · SecretCatalogDisableBody · SecretCatalogRotateBody
TenantPage · VaultReferenceProvider · WorkflowCatalogPage · WorkflowDetailResponse
```

Each was verified individually. The spot-check matters: several of these are live
symbols used *inside* `client.ts` as part of its own return types, so a naive
text search finds them and would wrongly call them dead. For example `ApiKeyPage`
appears at `client.ts:85`, `:86`, `:358` and `:361` as a return type - but no screen
imports it, so the **barrel line** is still unreachable. The same holds for
`TenantPage` (client.ts:83, 352), `ProfileMutationResult` (client.ts:158, 165, 172 and
five more), and `BffHealthResponse` (F1).

**How to read this.** It is not a defect and it is not 24 dead types. Most of these are
part of the client return-type graph, and a deliberately complete type barrel is a
legitimate design: it is the documented surface of `/admin/api/*`. But 24 of 88 means
the barrel advertises a quarter more surface than any caller uses, and that is the cost
of the choice. The honest summary is **not a staleness defect, a surface-size
observation**.

Two qualifiers on the count:

- The measurement covers admin-web `src` only. Type-only names cannot be imported by
  the `.test.mjs` suites (they are plain JavaScript and erase types) nor by the Playwright
  specs, so no consumer class was missed.
- Same-named symbols in other packages are **not** consumers. `ConnectorActivateParams`
  and `ConnectorRevisionTarget` also exist in `packages/contracts`, and
  `CryptoConfigView` is close to a symbol in `crypto-config-api.ts`. None of those
  reaches this barrel.

Recommendation: none required. If the coordinator wants a smaller surface, the decision
belongs to the plan owner, not to this audit.

---

## 7. F5 - exported names with no code consumer

Verified by scanning `src`, `admin-web/tests` and `services/orchestrator/tests`,
excluding `node_modules` and build output. 401 source files.

| Name | Declared in | Product | Test | Verdict |
|---|---|---:|---:|---|
| `TabsRoot`, `TabsList`, `TabsTab`, `TabsPanel` | `ui/tabs.tsx` | 0 | 0 | **whole file dead** |
| `AppShellNav`, `AppShellNavItem`, `AppShellNavItemProps`, `AppShellFooter` | `ui/app-shell-primitives.tsx` | 0 | 0 | **dead** |
| `CardFooter` | `ui/card.tsx` | 0 | 0 | **dead** |
| `TableFooter`, `TableEmptyProps` | `ui/table.tsx` | 0 | 0 | **dead** |
| `Skeleton` | `ui/state-panel.tsx` | 0 | 0 | **dead** |

11 names. One whole module is unreachable: `components/ui/tabs.tsx` (57 lines, all 4
exports dead) is re-exported by the `@/components/ui` barrel at `index.ts:10` with
`export * from`, so it still ships inside the production bundle while nothing renders it.

The shell draws its own navigation inline in `app-shell.tsx` - an `<aside>` element with
`NavLink` children - which is why the `AppShellNav` family went unused: the primitives
were built for a navigation layout the shell replaced.

`Skeleton` is a loading placeholder no screen ever reached for. It was already flagged
in an earlier survey in this repo; it is still exported and still unused.

Names this audit **first** mislabelled and then corrected, recorded so the correction is
visible rather than silent:

- `StatePanel` was reported dead. It is used by `features/secrets/secrets-screen.tsx` at
  lines 15, 332 and 443, imported through the `@/components/ui` barrel.
- `useToast` and `ToastViewport` were reported dead. They are not product-used, but see
  F6.

---

## 8. F6 - exported names with a test consumer but no product consumer

| Name | Where it is referenced | Product |
|---|---|---:|
| `TenantSelect`, `TenantSelectProps` | `services/orchestrator/tests/f4-component-tenant-select.test.ts` (23 refs) and `tenant-select-offline.cjs` | 0 |
| `useToast`, `ToastViewport` | `services/orchestrator/tests/admin-toast-error-boundary-offline.cjs` lines 18-19, by regex on the source text | 0 |

These are different situations and should not be treated alike.

`TenantSelect` is a fully built component with a dedicated render suite
(`f4-component-tenant-select.test.ts` mounts the real source through
`react-dom/server` and an element-tree harness). No screen imports it. The shell uses
`GlobalTenantSelector` from `global-tenant-selector.tsx` instead, which reads the tenant
from `lib/tenant-context` rather than fetching its own roster. The component still works;
nothing mounts it. Three further offline harnesses mock
`@/components/ui/tenant-select` for other suites, which keeps the mock in their path
looking meaningful while the import it stands in for is no longer present in the screen.

`useToast` and `ToastViewport` are referenced only by a test that asserts the strings
`export function useToast` and `export function ToastViewport` appear in `toast.tsx`.
That is a presence assertion, not a behaviour test. `ToastProvider` and
`GlobalErrorBoundary` from the same file *are* used, by `app-shell.tsx` lines 6 and 27.
So the toast file is live; two of its exports are held alive only by a test that checks
they exist.

Recommendation: decide per case. Either mount `TenantSelect` or retire it and its
suite; either exercise `useToast` in a screen or drop the presence assertions. Both are
source changes and are reported, not done.

---

## 9. F7 - duplicate types

Across all 80 files of `src`, the only duplicated exported **names** are the two
functions in F2. There are **zero** duplicated exported `type` or `interface` names.

Two pairs of types are parallel in concept but not duplicate in name, so the duplicate
detector correctly does not flag them. They are worth a human decision, not a rename:

- `features/audit/state.ts` exports `AuditEvent` and `AuditPage`; the overview module
  exports `AuditEventWire` and `AuditListPage` for the same wire payload. This is the
  same fork as F2, one layer up: the wire types were duplicated along with the parsers.
- `lib/api/types.ts` exports `BffHealthResponse` beside the client module
  `AdminHealthSnapshot`, which is F1.

---

## 10. What this audit did not do

- **No browser, no runtime.** Every verdict is derived from source structure. That
  `TabsRoot` is unused is a statement about imports, not about a rendered page.
- **No tree-shaking analysis.** `tabs.tsx` is asserted to ship in the bundle because the
  barrel re-exports it with a star export; whether a minifier could drop it was not
  measured.
- **No live endpoint was observed.** F2 was confirmed by reading the production sites that
  *write* the `success` severity, not by reading a live audit ledger. F1 rests on type
  declarations, not on observed traffic.
- **Nothing is urgent.** None of F1 to F8 is a runtime defect. F2 is the only one with a
  user-visible consequence, and it is a badge colour that is less informative than the
  shell it replaced.
- **Nothing was edited.** F1 through F6 each name a concrete follow-up; all are source
  changes and therefore outside this read-only packet. F8 deliberately names none.
