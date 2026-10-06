# GAP-INVENTORY-803 - receipt (code-level gaps, for the user to order)

> **RESUME POINT (qwen_5, 2026-10-05)** - task GAP-INVENTORY-803 (task_ee9b34c590a0),
> dispatch ctx_d2c49b6bac9a. **DOC-ONLY**: grep + read only. 0 tests, 0 builds, 0 source edits,
> 0 commits. Every file:line below was re-read in this session or verified by grep just now.

---

## 0. How severity is derived (no invented levels)

Each gap carries one of three consequences, and each consequence is tied to something I observed:

- **CẢN UI** - the operator cannot reach a control at all, so an admin journey stops.
- **CẢN LIVE** - the UI can be reached and looks fine, but a live leg cannot complete.
- **KHÔNG CẢN** - nothing is blocked; the gap is documentation/coverage only.

I did not invent a priority order. The ordering decision belongs to the user - the point of this
inventory is that the gaps are now comparable.

---

## 1. Verified inventory

| # | Gap | Evidence (file:line) | Why it is a gap | Depends on | Consequence |
|---|---|---|---|---|---|
| G1 | **A3 window switch does not exist** | `modules/runtime/metadata-crypto.ts:350-354` - `readStoredText(crypto, value, context, allowPlaintext: boolean)` takes the flag as a required argument, and **all four** call sites hardcode `true`: `modules/runtime/runtime.ts:1202`, `modules/runtime/runtime.ts:1814`, `modules/operations/mappers.ts:103`, `http/routes/public.ts:538` | A parameter that must always be literal `true` is not a switch. Enabling metadata encryption therefore never fails closed on legacy plaintext - the window is permanently open | A2 (runtime.ts lease) for the change; ENCMETA backfill for the end state | **CẢN LIVE** - a sealed deployment still reads plaintext, so "encrypted at rest" cannot be asserted |
| G2 | **ENCMETA reader closure incomplete** | fan-out join opens child refs at `runtime.ts:1809-1816` (comment: "blobs inside the parent envelope and the parent could never read them") - the open-before-merge rule IS implemented; but every read still uses `allowPlaintext: true` (see G1), and `human_waits.ui_schema` / `context_ref` are **not projected** by `mappers.ts` or `runtime.ts` (grep: 0 hits) - the recorded plaintext-by-exemption stands | Sealing writers exist, readers still tolerate plaintext, so a partially backfilled deployment reads both ways without error | G1; the backfill window itself | **CẢN LIVE** for the at-rest claim; **KHÔNG CẢN** for the UI |
| G3 | **Settings: READ wire exists, WRITE deliberately disabled** | **Read:** `packages/contracts/src/settings.ts:115` `SettingsReadSchema` (`GET /admin/api/settings`) + `SettingsAiDefaultsSchema:39`, `SETTINGS_PROMPT_SLOTS:53`, `SettingsPromptDefaultsSchema:62`, `SettingsStorageSchema:77` (a `secretPresent` PRESENCE bit, never a value), `SettingsCacheRetentionSchema:90`, `SettingsCapabilitiesSchema:107`; relayed verbatim by `app/admin/bff/settings.ts:4`. **Write:** `settings.ts:134` `SettingsUpdateParamsSchema` (`.strict()`) + `SETTINGS_WRITER_DISABLED_CODE/REASON` (`:159-160`), and `app/admin/bff/settings.ts:5` POST **REFUSED at the capability gate (fail-closed)**, restated `app/admin/bff/handle.ts:17` | The read path is honest and live; the write path exists only as a refusal, and there is still no deployment adapter behind it to apply Policy, Vault secret-ref or Artifact storage generation | Deployment adapter (G7 / G12) | **CẢN UI** - reads work, every write returns `SETTINGS_WRITER_DISABLED` |
| G4 | **No AI wizard BFF route or contract (CFGADM-06)** | grep `wizard` / `prompt-wizard` over `http/routes/*.ts` + `app/admin/bff/*.ts` = **0 matches** | No route to reach, no contract to type against | BFF route + contract (dsh_2 owns router/client this wave) | **CẢN UI** - wizard and Test Endpoint cannot be driven |
| G5 | **`/admin/workflows` route EXISTS; the DEV-03 user gate remains** | **Route:** `apps/admin-web/src/router.tsx:49` `{ path: 'workflows', Component: WorkflowsRoute }` + `routes/workflows.tsx:3-4` rendering `WorkflowsScreen` - landed by P3 after 803 was written (803 recorded its absence). **Gate:** DEV-03 deployment is user-gated (WAVE-801 A6) | The route half closed; the remaining half is a user decision, not code. Split on purpose: only the first half was ever code work | A6 user go/no-go - no amount of work advances it | **CẢN UI** - still, by design, until the user unblocks - NOT because a route is missing |
| G6 | **Identity BFF routes exist; the CFGADM-08 SCREEN does not** | **Routes:** `app/admin/bff/identity.ts:4-6` - `GET /admin/api/identity`, `POST /admin/api/identity/users`, `PATCH /admin/api/identity/users/:id` (CAS), wired at `app/admin/bff/handle.ts:18`. **Contract:** `packages/contracts/src/identity.ts` - `IDENTITY_ROLE_VALUES:26` (ADMIN/USER/VIEWER), `IdentityRoleSchema:27`, `CreateIdentityUserParamsSchema:97`, `UpdateIdentityUserParamsSchema:111`, `IDENTITY_VERSION_CONFLICT_CODE:133`. The 803 evidence grepped `http/routes/*.ts` + `app/admin/bff/*.ts` and reported 0 matches - correct for those paths at the time, but wrong place to look: it lives in `app/admin/bff/identity.ts` | The BFF surface landed after 803 was written; the remaining work is the admin screen | CFGADM-08 screen (P2, codex_worker_1) | **CẢN UI** - CFGADM-08 has no user-facing screen yet |
| G7 | **ACUI-M06: `connectorBaseUrls` has no deployment source** | `server.ts:87` - the field is declared on the config type as `connectorBaseUrls?: Record<string, string>` only; nothing reads a deployment/env source into it | An unset map is why the Connector pane is a fake projection (ACUI-00: pane over an empty map) | Deployment adapter | **CẢN LIVE** for connector management; UI degrades to an honest disabled state |
| G8 | **Migration 0032 rollback is hand-authored** | `services/orchestrator/migrations/0032_checkpoint_session_ref.sql:3` - `ALTER TABLE step_checkpoints ADD COLUMN IF NOT EXISTS session_ref jsonb;` (one nullable statement, no data rewrite) | There is no down-migration API, so rollback is manual SQL and the `schema_migrations` ledger row must be deleted in the same step | The live window (user-gated) | **KHÔNG CẢN** offline; **CẢN LIVE** if a window is opened without the SQL written first |
| G9 | **Storage/retention stats and cleanup have no wire** | grep `cleanup`/`stats`/`retention` over `features/settings/*` and `features/usage/*` = only my own CFGADM-03/04 catalog rows (`catalog.ts:50,56,80`) - no stats, no cleanup control | The legacy S3-test + cache-stats + cleanup preview/confirm journey has no rework counterpart | Artifact service (stats/cleanup) + storage generation adapter | **CẢN UI** - CFGADM-03/04 statistics and cleanup are unreachable |

---

## 2. Additional gaps found while inventorying (evidence-backed)

| # | Gap | Evidence | Consequence |
|---|---|---|---|
| G10 | **`AbortSignal.timeout` paths have no test** | `modules/connector-credentials/connector-http-store.ts:77` and `modules/connectors/connector-management-store.ts:101` both pass `AbortSignal.timeout(options.timeoutMs ?? 5_000)`; the vault-writer timeout path is now covered (CRED-LIMITS-801), these two are not. **Path correction:** the first file is in `modules/connector-credentials/`, NOT `modules/connectors/` - 803 left both unqualified, which reads as one directory | **KHÔNG CẢN** - coverage gap only |
| G11 | **The scripted-pg boot mock had drifted from the Cycle-85 ledger guard** | `verifyMigrations` reads `rows[0].count` from `SELECT count(*)::int` (`migrations.ts:151-153`) while the in-file mock returned `{sequence, filename}` rows for every `FROM schema_migrations` query - every boot test in `credworkflow-e2e-offline.functional.test.ts` was red; fixed in-lease today (receipt cred-limits-801 section 4) | **KHÔNG CẢN** now that it is fixed; reported because it silently hid a whole test group |
| G12 | **75 orchestrator env keys, 0 managed, 14 secret-ref** | ACUI-00 section 9 exact counts (28+12+5+13+10+7 = 75; 14 secret-ref; **0 managed**); the 8 store rows have 3 managed | The deployment adapter is the pacing item for G3, G7 and G9 together - without it every one of those stays deployment-only | A single deployment adapter would unblock G3/G7/G9 in one move | **CẢN UI** collectively |

---

## 3. Suggested reading for ordering (NOT a verdict)

I am not assigning priority. What the evidence suggests is **coupling**, not rank:
- **G12 is the root**: G3, G7 and G9 all name the same missing thing (a deployment adapter). Ordering them
  separately would build three workarounds for one absence.
- **G1 and G2 are one item** and are the only ones whose fix lives in a frozen lease (A2).
- **G4, G5, G6 are three UI rows behind two owners** (dsh_2 owns router/client this wave; G5 additionally
  waits on a user go/no-go that no amount of work can advance).

## 4. Ledger

- GAP-INVENTORY-803 - Muc 1 - 12 code-level gaps inventoried with file:line (G1-G12): A3 window switch
  proven absent by 4 hardcoded `true` call sites, ENCMETA reader closure, settings writer actions,
  CFGADM-06 wizard route, DEV-03 workflows route, identity BFF routes, ACUI-M06 connectorBaseUrls,
  migration 0032 rollback, storage/retention wire, plus 3 newly found (timeout coverage, pg-mock drift,
  75 env keys unmanaged). DOC-ONLY: no test, no build, no source edit, no commit.

> **CORRECTED 2026-10-05 (REVIEW-805):** four evidence rows were wrong and are fixed in place - G1 paths
> fully qualified, G3 refreshed and split into read/write, G5 split into route/gate, G6 path corrected, and G10's
> `connector-http-store.ts` moved to `modules/connector-credentials/`. Three of the four were **stale evidence**
> (sibling lanes landed the settings wire, the identity BFF and the workflows route after this inventory was
> written), not typos. Detail: `coordination/reports/gap-inventory-corrections-804-2026-10-05.md`.
