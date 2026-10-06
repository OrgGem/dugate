# CFGADM-UI-INVENTORY - receipt (read-only)

> **RESUME POINT (qwen_5, 2026-10-05 02:4x)** - packet CFGADM-UI-INVENTORY, run run_069ecd6957cd.
> READ-ONLY: 0 source edits, no commit. Sources: tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md (CFGADM rows),
> coordination/reports/qwen-acui-00-config-catalog-2026-10-02.md (ACUI rows), apps/admin-web/src/router.tsx,
> apps/admin-web/src/features/*/, and this session receipts (P730/P745).
>
---

## 1. Method + honest scope

Classification is per CFGADM row against the CURRENT admin-web tree (router + feature folders), not against
the legacy root. "legacy-working" = a rework screen exists AND has browser evidence in this session or a
prior receipt. "scaffold" = screen exists but the write path is disabled/missing. "backend-missing" = the
wire/DB route is absent. "UI-missing" = no rework screen/route at all.

I did NOT re-read every screen line-by-line; where a classification rests on a prior receipt or the router
inventory it says so. Re-reading a screen to upgrade a row is a follow-up, not part of this packet.

## 2. CFGADM-00..11 inventory

| ID | Legacy function | Rework state | Class |
|---|---|---|---|
| CFGADM-01 | Settings AI defaults (provider/model/base URL) | settings-screen.tsx is a deployment catalog only - no AI editor, no Save | **UI-missing** |
| CFGADM-02 | Prompt defaults (5 slots) | no prompt-defaults editor anywhere in admin-web | **UI-missing** |
| CFGADM-03/04 | S3 endpoint/bucket/secret/region/TTL + cache/retention | settings screen lists them as env-only; no S3 test/apply control | **UI-missing** |
| CFGADM-05a | API keys + Profiles binding | api-keys-screen.tsx + profiles-screen.tsx; AWEB-05 + AWEB-04 evidence | **legacy-working** |
| CFGADM-05b | Endpoint catalog / locks / priority / auth / extensions / steps | profiles-screen.tsx full editor; AWEB-04 9/9 | **legacy-working** |
| CFGADM-06 | AI Wizard + Test Endpoint | no wizard route; Test Endpoint exists in profiles but gated on an unshipped writer | **UI-missing** (wizard) / scaffold (test) |
| CFGADM-07 | Connection CRUD + Import cURL + auth modes + multipart | connectors-screen.tsx: revision lookup + Import preview mounted; save/test/activate disabled (PAR-03/14) | **scaffold** |
| CFGADM-08 | Users CRUD / roles / local-OIDC metadata | identity-screen.tsx is the legacy/admin shell; no user CRUD | **UI-missing** |
| CFGADM-09 | Workflows list/import/mappings/schemaSlug | NO workflows route in router.tsx | **UI-missing** |
| CFGADM-10 | Dashboard + History/Operations | overview-screen.tsx + operations-screen.tsx; AWEB-03b/06 evidence | **legacy-working** |
| CFGADM-11 | API Docs / test workbench | no docs route; no workbench | **UI-missing** |

**Tally: 3 legacy-working, 1 scaffold, 7 UI-missing.** The rework admin surface is real for the three
verticals that had a frozen wire (api-keys, profiles, overview/operations); everything else is either a
deployment catalog or absent.

## 3. ACUI rows (config catalog)

ACUI-00..10 = the orchestrator config catalog (qwen-acui-00-config-catalog-2026-10-02.md). 28 CFG-ORCH rows,
all scope `global`, mechanism **deployment**, and **none is manageable through any Admin UI today** - there is
no deployment adapter in the tree. The catalog already records the ACUI-M06 consequence: `connectorBaseUrls`
unset is why the Connector pane is a fake projection, and `deliveryEncryption`/`cryptoConfig` unset means the
ENC-08 durable store is not wired at boot.

Net: the ACUI catalog and the CFGADM inventory describe the SAME gap from two sides - CFGADM says "the
operator cannot do X in Admin", ACUI says "X is a boot-time env key with no Admin mutation route".

## 4. Matrix: route -> DTO -> action -> owner -> test (rework rows only)

| Route | DTO | Action | Owner | Test |
|---|---|---|---|---|
| GET /admin/api/profiles/:b/:v/:name | ProfileDetail (frozen wire) | - | profiles | AWEB-04 9/9 |
| POST .../profiles/.../upsert | PolicyUpsertBody {expectedRevision, policy, apiKey?} | profile.upsert | profiles | P745-UI-KEYS 8/8 + journey |
| POST .../profiles/.../publish | ProfilePublishBody {expectedRevision, apiKey?} | profile.publish | profiles | P745-UI-KEYS + journey |
| POST .../profiles/.../rollback | ProfileRollbackBody {targetRevision, expectedRevision, apiKey?} | profile.rollback | profiles | P745-UI-KEYS + journey |
| GET /admin/api/connectors/:id/revisions/:rev | ConnectorRevision | - | connectors | AWEB-05 8/8 |
| (none) save/test/activate | - | - | connectors | disabled, PAR-03/14 |
| GET /admin/api/api-keys | ApiKeyRow[] | - | api-keys | AWEB-05 |
| POST /admin/api/actions (issue/revoke) | {action, params} | apikey.issue/revoke | api-keys | AWEB-05 |
| GET /admin/api/operations | OperationView | - | operations | AWEB-06 |
| GET /admin/api/audit | AuditRow[] | - | overview | AWEB-03b |
| GET /admin/api/usage | UsageView | - | usage | AWEB-06 |
| GET /admin/api/crypto-config | CryptoConfig | - | security | AWEB-07 |
| (none) workflows / users / docs | - | - | - | UI-missing |

## 5. Proposals

### 5.1 Visual-token mapping - ONE source of truth

Today the design tokens live in `apps/admin-web/src/styles/tokens.css` (CSS custom properties) and are
referenced as `var(--*)` in every component. The legacy root has its own palette. Proposal: keep the
`var(--*)` set as the single source and generate the legacy mapping from it, never the reverse.

| Token group | Single source | Consumers |
|---|---|---|
| color | `--bg-card`, `--text-main`, `--text-sub`, `--border-*`, `--badge-*` | all screens |
| radius | `--radius-sm/md/lg` | cards, buttons, inputs |
| shadow | `--shadow-card/pop` | cards, dialogs |
| focus | `--focus-ring` | a11y focus ring |
| action | `--cf-blue`, `--cf-blue-hover`, `--on-action` | primary buttons |

Rule: a component may only reference `var(--x)`; it may not hardcode a hex/rgb. The legacy palette becomes
a derived artifact (a mapping table), so a token change propagates to both surfaces by construction.

### 5.2 Port path for legacy components

For the 7 UI-missing rows the port order should be: (1) confirm the frozen wire exists (profiles did),
(2) build the screen against the typed client, (3) add the write action only when the backend route lands.
The profiles vertical is the template: read wire -> editor -> gated writes -> honest disabled state. Do not
port a legacy component wholesale; port the DATA SHAPE and re-render with the token set.

## 6. Ledger

- CFGADM-UI-INVENTORY - Muc 1 - read-only inventory: 12 CFGADM rows classified (3 legacy-working, 1 scaffold,
  7 UI-missing), ACUI catalog summarised (28 deployment rows, no Admin adapter), route->DTO->action->owner
  ->test matrix for the rework rows, token single-source proposal + legacy port order proposed. 0 source edits.
