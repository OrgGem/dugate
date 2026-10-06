# ADMINWEB-MAP — admin-web surface map (2026-10-05)

> **Task:** ADMINWEB-MAP (dsh_3 / `term_273952b5`), packet #12 of WAVE-801.
> **READ-ONLY:** 0 source edits, no build, no commit, no tick, no dispatch. The only file this
> packet writes is this receipt.
> **Scope:** what actually exists in `apps/admin-web` today — which routes are registered, which
> screens render, which client methods/DTOs are real, which surfaces are catalog/disabled-only —
> plus an explicit **BLOCKER row per screen** so wave-803 packets and their priority can be decided.
> **Method:** direct read of the current tree. Earlier receipts are cited where they supply
> acceptance evidence (build/test), and are marked as such rather than re-verified here.

---

## 0. Ground truth: where the code actually is

The wave-801 dispatch sheet names paths as `apps/admin-web/src/router.tsx`. In this checkout the
whole rework workspace lives under `du-rework/`, so every path below is prefixed `du-rework/`.
This is a path-prefix fact, not a second codebase — `apps/admin-web` at the repo root does not
exist in this tree.

Verified by directory listing of `du-rework/apps/admin-web/src`:

- `router.tsx` — the only route table.
- `routes/` — 14 files, one thin wrapper per screen (`not-found`, `overview`, `api-keys`,
  `connectors`, `profiles`, `operations`, `businesses`, `usage`, `security`, `identity`,
  `settings`, `workflows`, `docs`, `bootstrap-home`).
- `features/` — 11 feature folders.
- `lib/api/` — `client.ts` (transport + methods), `types.ts` (DTOs), `index.ts` (barrel).
- `app-shell/app-shell.tsx`, `components/ui/**`, `styles/tokens.css`.

## 1. Route table as registered (`router.tsx:39-51`)

Read from the file, not inferred. Order matters only for the reader; all are children of `AppShell`.

| # | Path | Route module | Screen | Renders? |
|---|---|---|---|---|
| 0 | `/` (index) | inline loader (`router.tsx:33-37`) | `BootstrapHome` | yes — session probe + link card |
| 1 | `overview` | `routes/overview.tsx` | `OverviewScreen` | yes |
| 2 | `api-keys` | `routes/api-keys.tsx` | `ApiKeysScreen` | yes |
| 3 | `connectors` | `routes/connectors.tsx` | `ConnectorsScreen` | yes |
| 4 | `profiles` | `routes/profiles.tsx` | `ProfilesScreen` | yes |
| 5 | `operations` | `routes/operations.tsx` | `OperationsScreen` | yes |
| 6 | `businesses` | `routes/businesses.tsx` | `BusinessesScreen` | yes |
| 7 | `usage` | `routes/usage.tsx` | `UsageScreen` | yes |
| 8 | `security` | `routes/security.tsx` | `SecurityScreen` | yes |
| 9 | `identity` | `routes/identity.tsx` | `IdentityScreen` | yes |
| 10 | `settings` | `routes/settings.tsx` | `SettingsScreen` | yes — catalog only |
| 11 | `workflows` | `routes/workflows.tsx` | `WorkflowsScreen` | yes — **disabled banner** |
| 12 | `docs` | `routes/docs.tsx` | `DocsScreen` | yes — catalog + workbench |
| 13 | `*` | `routes/not-found.tsx` | `NotFound` | yes |

**Route table verdict: every screen in `features/` is mounted.** There is no orphan screen and no
unrouted feature folder. `features/index.ts` re-exports `WorkflowsScreen` and `DocsScreen` only —
that barrel is partial but nothing imports it destructively; both symbols resolve.

### 1a. Navigation gap (real, unowned, cheap)

`app-shell/app-shell.tsx:12-15` — `NAV` has **two** entries: `Overview` and `Bootstrap`. Eleven of
the thirteen routes are reachable **only by typing the URL**; the header still links out to the
legacy shell at `/admin` (`app-shell.tsx:44-49`). No screen is inaccessible, but nothing in the
product UI points at `/settings`, `/identity`, `/workflows` or `/docs`. This is the single
highest-leverage UI hole found in this map and it is currently unassigned.

## 2. Route → DTO → action → owner → test matrix

DTO names are the actual exported types in `lib/api/types.ts` / feature-local `state.ts` parsers.
"Action" = the client method or explicit *none*. "Owner" = the feature lane that holds the screen.

| Route | DTO (real) | Action (client method) | Owner | Test (file in `tests/browser/admin-web/`) |
|---|---|---|---|---|
| `/` | `AdminWebSession` | `getSession()` | app-shell | `admin-web.spec.ts`, `live-admin-web.spec.ts` |
| `/overview` | `AuditListPage` via `parseAuditPage` | `listAudit()` | overview | `overview.spec.ts` |
| `/api-keys` | `ApiKeyPage` via `parseApiKeyPage` | `listApiKeys()`, `getApiKey()` | api-keys | `api-keys-connectors.spec.ts` |
| `/api-keys` (write) | `PostActionResult` | `postAction()` — issue/revoke | api-keys | `api-keys-connectors.spec.ts`, `p745-ui-keys.spec.ts` |
| `/connectors` | `ConnectorListPage`, `ConnectorCapabilities` via `parseConnectorList`/`parseConnectorCapabilities` | `listConnectors()`, `getConnectorCapabilities()` | connectors | `connectors-wire.spec.ts` |
| `/connectors` (revision) | `ConnectorRevisionRead` via `parseConnectorRevisionRead` | `getConnectorRevision()` | connectors | `connectors-wire.spec.ts` |
| `/connectors` (write) | `ConnectorUpsertParams`, `ConnectorActivateParams` | `upsertConnector()`, `activateConnector()`, `disableConnector()`, `retireConnector()`, `testConnector()` | connectors | `connectors-wire.spec.ts` — **capability-gated, see §4.7** |
| `/profiles` | `ProfileDetail` via `parseProfileDetail` | `getProfile()` | profiles | `profiles.spec.ts` |
| `/profiles` (write) | `PolicyUpsertBody`, `ProfilePublishBody`, `ProfileRollbackBody` (builders in `command-bodies.ts`) | `upsertProfile()`, `publishProfile()`, `rollbackProfile()` | profiles | `p745-ui-keys.spec.ts`, `p745-ui-keys-journey.spec.ts`, `p745-ui-mask.spec.ts` |
| `/profiles` + `/docs` (test) | `testProfileEndpoint(payload)` body | `testProfileEndpoint()` | profiles + docs | `profiles.spec.ts`; workbench untested — see §4.12 |
| `/operations` | `OperationsPage` via `parseOperationsPage` | `listOperations()` | operations | `operations-business.spec.ts` |
| `/operations` (detail) | `OperationDetail` via `parseOperationDetail` | `getOperation()` | operations | `operations-business.spec.ts` |
| `/businesses` | `BusinessPage` via `parseBusinessPage` | `listBusinesses()` | businesses | `operations-business.spec.ts` |
| `/businesses` (versions) | `BusinessVersions` via `parseBusinessVersions` | `getBusinessVersions()`, `businessVersionAction()` | businesses | `operations-business.spec.ts` |
| `/usage` | `UsageSummary` (`Record<string, unknown>`) | `getUsage()` | usage | **no dedicated spec** — see §4.8 |
| `/security` | `CryptoConfigView` | `getCryptoConfig()`, `updateCryptoConfig()` | security | `identity-security-settings.spec.ts` |
| `/identity` | `IdentitySnapshot`, `IdentityUser`, `IdentityOidcMetadata` (`features/identity/identity-api.ts`) | `readIdentitySnapshot()`, `createIdentityUser()`, `updateIdentityUser()` — own fetch adapter, not `lib/api/client.ts` | identity | `cfgadm-08-identity-crud.spec.ts` (3 passed, exit 0 per P2 receipt) |
| `/settings` | **none** — `SettingsCatalogRow` is a local literal (`features/settings/catalog.ts`), not a wire DTO | **none** — no write exists | settings | `cfgadm-settings-port-p1.spec.ts` (6 cases) |
| `/workflows` | **none** | **none** | workflows | none — see §4.9 |
| `/docs` | endpoint catalog is a **hardcoded literal array** in `docs-screen.tsx`; result type = `PostActionResult` | `testProfileEndpoint()` | docs | none — see §4.12 |

### 2a. Two wire adapters, one of them off the shared client

`features/identity/identity-api.ts` implements its **own** `fetch` wrapper (CSRF header,
`idempotency-key`, `credentials: 'same-origin'`) against `/admin/api/identity` rather than using
`lib/api/client.ts`. That is why P2 could ship user CRUD without touching the shared client under
the A5 single-router-owner rule. It is defensible, but it is a second transport path: any
CSRF/tenant-fence fix made in `client.ts` will **not** reach identity. Flag for the integrator.

## 3. CFGADM-01..11 — current class per row

| ID | Legacy function | Current state in tree | Class now |
|---|---|---|---|
| CFGADM-01 | AI defaults (provider/model/base URL) | 6 rows in `SETTINGS_CATALOG`, group `ai`; every button `disabled` + `data-write-reason` | **catalog-only** |
| CFGADM-02 | Prompt defaults, 5 slots | 5 rows, group `prompt`; disabled | **catalog-only** |
| CFGADM-03/04 | S3 endpoint/bucket/secret/region/TTL + cache/retention | 6 rows, group `storage`; disabled; secret rows badged, never valued | **catalog-only** |
| CFGADM-05a | API keys + profiles binding | list/issue/revoke/paginate, live DTOs | **ported** |
| CFGADM-05b | Endpoint catalog / locks / priority / steps | full editor + CAS + rollback | **ported** |
| CFGADM-06 | AI wizard + Test Endpoint | **Test Endpoint: real** (profiles + docs workbench). **Wizard: absent** | **split** |
| CFGADM-07 | Connection CRUD + cURL import + auth modes | full editor: upsert/activate/disable/retire/test present, capability-gated | **ported (gated)** |
| CFGADM-08 | Users CRUD / roles / OIDC metadata | CRUD + roles + OIDC allowlist + writer-capability fail-closed | **ported** |
| CFGADM-09 | Workflows list/import/mappings/schemaSlug | screen renders a `Δ-DEV-03` disabled banner; **zero** BFF calls | **policy-gated stub** |
| CFGADM-10 | Dashboard + history/operations | overview + operations + usage all wired to real DTOs | **ported** |
| CFGADM-11 | API docs + test workbench | 13-entry hardcoded catalog + working workbench POST | **ported, defective** |

**Correction to the wave-801 briefing, stated plainly:** the "7 UI-missing rows
CFGADM-01/02/03/04/06/08/09/11" list is **stale as a description of the current tree**. CFGADM-08
and CFGADM-11 screens exist and render. CFGADM-06's Test Endpoint and CFGADM-09's route exist. What
actually remains unbuilt is narrower — see §4.

## 4. BLOCKER row per screen (the decision input)

Each row states which of three blocker classes applies. This is what wave-803 ordering should key on.

| Screen / route | What a user cannot do | Blocker class | Owner of the unblock | Shippable now? |
|---|---|---|---|---|
| **§4.1 `/settings`** (CFGADM-01/02/03/04) | No editor: no input, no Save, no test-probe, no retention/cleanup control for 16 port rows + 1 retire row | **UI missing on top of a missing wire** — `grep -n Settings packages/contracts/src/*.ts` = zero; no DTO, no writer action, no deployment adapter | backend must freeze the settings DTO + writer action first; then UI lane | **no** — coding the form before the wire is DTO would build against an assumption. Correctly blocked. |
| **§4.2 AI wizard** (CFGADM-06 half) | No guided provider/model/prompt wizard anywhere | **backend missing** — no wizard route on the BFF to call | orchestrator route owner | **no** |
| **§4.3 Test Endpoint** (CFGADM-06 other half) | nothing — it works in profiles | none | — | done |
| **§4.4 `/workflows`** (CFGADM-09) | No list, import, mappings, schemaSlug, run/HITL | **user-gated `Δ-DEV-03`** (A6 keeps it closed) | user decision, not an agent | **no — and must stay closed**; do not let a packet "unblock" it |
| **§4.5 connector Rotate** (CFGADM-07 slice) | Credential rotate has no value path; button says so inline | **UI missing, scoped packet** — the capability flag exists, the write-only value input does not | connectors lane (Δ5 named in `connectors-screen.tsx:693`) | **yes** — small, self-contained, capability already wired |
| **§4.6 connector writes** | Upsert/activate/disable/retire/test are enabled **only** when the platform advertises `management`/`test` | **gated by real capability, correctly** (`connectorActionGating`, `state.ts:228-244`; fail-closed when advertisement unreadable) | — | done; needs Antigravity re-verdict on the new digest |
| **§4.7 `/docs` CSRF** | Workbench POST omits `X-CSRF-Token` — the write fails where the platform enforces CSRF | **UI defect, one-line class** — `docs-screen.tsx` calls `client.testProfileEndpoint` without a CSRF token while identity shows the correct pattern (`identity-api.ts:88-89`) | docs lane (needs a client token source — see A5 risk) | **yes**, but touches the shared-client question → route to the sole client owner first |
| **§4.8 `/usage`** | Nothing functionally; it is fully wired | **coverage gap only** — no dedicated browser spec among the 15 in `tests/browser/admin-web/` | test lane | **yes** — spec-only, zero product risk |
| **§4.9 nav** | 11 of 13 routes unreachable from the UI | **UI missing** — `NAV` in `app-shell.tsx:12-15` has 2 entries | shell lane; nav was touched by an earlier lane, so confirm lease before edit | **yes** — highest visible return |
| **§4.10 `/identity` transport** | Nothing user-visible today | **latent risk** — second fetch adapter outside `lib/api/client.ts` (§2a) | integrator decision | **yes** — decision + note, not necessarily a refactor |
| **§4.11 `/overview`,`/operations`,`/businesses`,`/security`,`/api-keys` (CFGADM-05/10)** | Nothing outstanding found | none | — | done; prior verdicts stand |
| **§4.12 `/workflows` + `/docs` test coverage** | Neither route has a browser spec | **coverage gap** — no `cfgadm-*-p3` spec exists although P3 landed both routes | test lane | **yes** — spec-only |

## 5. Evidence, per screen, that it actually renders

Not inferred from file presence alone:

- `/settings` — `settings-screen.tsx` renders `SETTINGS_GROUPS.map(...)` group cards plus the
  preserved deployment `CATALOG` table; each row renders a `Button ... disabled title={reason}`
  with `data-write-reason={row.legacyKey}` (asserted by P1's 6 browser cases).
- `/workflows` — renders `AlertBanner variant="warning" title="Workflows route is disabled"` naming
  `Δ-DEV-03` and stating no workflows data is read or mutated. Zero client calls in the file — that
  is verifiable by absence, which is the point.
- `/docs` — renders a 13-entry endpoint list and a `Modal` workbench; the POST path is real code,
  not a stub, which is exactly why the missing CSRF header (§4.7) matters.
- `/identity` — `useEffect` load, `readIdentitySnapshot()`, capability gate
  `snapshot?.capabilities.userWriter === true` (`identity-screen.tsx:78`), then create/update and a
  **readback** call (`identity-screen.tsx:131`) before reporting success. The readback is why this
  row can be called ported rather than scaffold.
- `/connectors` — `connectorActionGating` drives 6 separate controls, each `disabled` with a
  distinct honest `title` (`connectors-screen.tsx:628-694`, `825-828`).
- `/usage` — `paneStateFrom` + `LoadingState`/`DeniedState`/`ErrorState`/`EmptyState`
  (`usage-screen.tsx:78-90`). **Correction:** the earlier backlog note that usage shows
  "requires backend" does not hold in the current file; it is a normal wired pane.

## 6. Prior acceptance cited (not re-run by this packet)

- CFGADM-08: `cfgadm-08-identity-crud.spec.ts` — 3 passed, exit 0 (`cfgadm-port-p2-2026-10-05.md:23`).
- CFGADM-01..04 catalog: `cfgadm-settings-port-p1.spec.ts` — 6 browser cases
  (`cfgadm-port-p1-2026-10-05.md:24`).
- CFGADM-09/11: `cfgadm-port-p3-2026-10-05.md:30-35` — typecheck exit 0, build ×3, route-level
  browser evidence. That receipt also self-reports the AI wizard as a GAP (§3 of that receipt).
- CFGADM-07 / CW-B UI: `UI-REVIEW-CW-B-R2` verdict, re-review requested by A1 because the digest moved.

These are cited as claims from those receipts. This packet ran no tests and no build.

## 7. Proposed wave-803 split (6 packets) — for the coordinator to order, not dispatched here

Ordered by (unblocks users) ÷ (blast radius). Nothing here has been dispatched; per instruction
this packet records the proposal only.

| # | Packet | Closes | Blocker class cleared | Lease needed | Risk |
|---|---|---|---|---|---|
| **803-01** | `NAV-ROUTES` — register all 13 routes in `NAV`, keep the legacy-shell link | §4.9 | UI missing | `app-shell/app-shell.tsx` only | lowest; check nav lease first |
| **803-02** | `DOCS-CSRF` — add CSRF token to the workbench POST | §4.7 | UI defect | `features/docs/**` **+ a token source**; if that means `lib/api/client.ts`, A5 says dsh_2 only | small, but may need a route/request back to dsh_2 |
| **803-03** | `CONNECTOR-ROTATE` — write-only credential value path | §4.5 | UI missing | `features/connectors/**` + new spec | contained; capability flag already exists |
| **803-04** | `WORKFLOWS-DOCS-SPECS` — browser coverage for the two P3 routes | §4.12 | coverage gap | `tests/browser/admin-web/**` new filenames only | none (test-only) |
| **803-05** | `USAGE-SPEC` — browser coverage for `/usage` | §4.8 | coverage gap | `tests/browser/admin-web/**` new filename only | none (test-only) |
| **803-06** | `IDENTITY-TRANSPORT-DECISION` — decide whether identity's private fetch adapter is kept, folded into `client.ts`, or documented as intentional | §4.10 | architectural | decision doc, possibly `lib/api/**` → A5 gate | read-mostly; a refactor here is a trap, prefer the documented-status outcome |

### Explicitly NOT proposed

- **Settings editor (CFGADM-01/02/03/04).** Cannot be packeted honestly yet: there is no settings
  DTO in `packages/contracts` and no writer action. Building the form first would either invent a
  contract or ship more disabled controls. It needs a backend freeze packet **before** a UI packet.
- **AI wizard (CFGADM-06).** Same shape — no BFF route to bind.
- **`/workflows` builder (CFGADM-09).** Held by `Δ-DEV-03` / A6. Any packet touching this route's
  behaviour beyond the honest disabled banner should be refused.

## 8. Ownership after wave 801 — who holds what

| Surface | Lease holder (per WAVE-801) | Still free? |
|---|---|---|
| `router.tsx`, `lib/api/client.ts`, `lib/api/types.ts` | dsh_2, **sole** (A5) | no |
| `features/settings/**` | qwen_5 (P1) | no, until P1's rows leave catalog-only |
| `features/identity/**` | codex_worker_1 (P2) | no |
| `features/workflows/**`, `features/docs/**` | dsh_2 (P3) | no |
| `features/connectors/**` | dsh_2 (CW-B / STUB-EXT) | no |
| `features/profiles/**`, `api-keys`, `overview`, `operations`, `businesses`, `usage`, `security` | earlier lanes, receipts closed | **free** — no wave-801 packet claims them |
| `app-shell/app-shell.tsx` | earlier shell lanes | **probably free — verify before 803-01** |
| `tests/browser/admin-web/**` | per-lane distinct filenames | free, new filenames only |

## 9. Honest limits of this packet

- No test, no build, no typecheck was run. Every "renders" claim is a source-read plus an existing
  receipt, not fresh evidence.
- `docs-screen.tsx` reads as mojibake in this checkout (`â€”`, `Â·`) in several screens — cosmetic
  encoding damage in emitted strings/comments, not a functional defect, but worth flagging to the
  lane that next edits those files.
- `features/index.ts` exports only 2 of 11 screens. Dead-ish barrel today; harmless, but it is the
  kind of thing that breaks silently later.
- Lease state was read from the WAVE-801 dispatch sheet and receipts, **not** from a live ledger, so
  §8's "free" cells need a coordinator confirmation before any packet is cut.

## 10. Ledger

- Task: ADMINWEB-MAP, dsh_3 (`term_273952b5`), packet 12, WAVE-801, run `run_069ecd6957cd`.
- Mode: READ-ONLY. Source edits: 0. Commits: 0. Ticks: 0. Dispatches: 0. Builds/tests: 0.
- Files written: `coordination/reports/adminweb-map-2026-10-05.md` (this file) only.
- Sources read: `dispatch-specs/2026-10-05-0305-WAVE-801.md`, `apps/admin-web/src/**`,
  `tests/browser/admin-web/**`, `coordination/reports/cfgadm-ui-inventory-2026-10-05.md`,
  `cfgadm-port-p1/p2/p3-2026-10-05.md`, `ui-backlog-803-2026-10-05.md`.
