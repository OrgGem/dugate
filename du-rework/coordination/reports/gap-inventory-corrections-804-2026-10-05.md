# GAP-INVENTORY-CORRECTIONS - receipt (REVIEW-805, 4 evidence rows fixed)

> **RESUME POINT (qwen_5, 2026-10-05)** - task GAP-INVENTORY-CORRECTIONS (task_c100b2a7bb98).
> Source: Claude REVIEW-805 findings against `gap-inventory-803-2026-10-05.md`.
> **DOC-ONLY**: grep + read, plus edits to that one receipt. 0 source edits, 0 tests, 0 commits, no tick.
> The three severity levels and the "ordering belongs to the user" stance are unchanged.

---

## 0. What the corrections actually are - read this first

**Three of the four are STALE EVIDENCE, not typos.** Sibling lanes landed real wires after
`gap-inventory-803` was written, so three of its rows describe a tree that no longer exists:

| # | Correction | Kind |
|---|---|---|
| 1 | `connector-http-store.ts` is in `modules/connector-credentials/`, not `modules/connectors/` | **real path error** (803 left it unqualified) |
| 2 | G3 settings: the wire now EXISTS | **stale evidence** |
| 3 | G5 workflows: the route now EXISTS | **stale evidence** |
| 4 | G6 identity: the BFF routes now EXIST | **stale evidence** |

I am stating that split rather than presenting four tidy "fixes", because a reader who assumes all four
were transcription slips would draw the wrong conclusion about how fast this tree moves.

---

## 1. Correction 1 - the `connector-credentials` path (REAL ERROR)

`dir /s /b` over `services/orchestrator/src` resolves them:

```
modules\connector-credentials\connector-http-store.ts     <- the AbortSignal.timeout(5_000) site
modules\connectors\connector-management-store.ts          <- the OTHER AbortSignal.timeout(5_000) site
modules\connectors\connectors.ts
modules\runtime\metadata-crypto.ts
modules\operations\mappers.ts
http\routes\public.ts
db\migrations.ts
```

`gap-inventory-803` G10 wrote both store files unqualified, which reads as one directory. Fixed: both are
now fully qualified, and G10 carries the explicit note that the first lives in `connector-credentials/`.

**On the numbering:** REVIEW-805 cites this as "G1". In my file, **G1 is the A3 window switch**, whose
evidence (`modules/runtime/metadata-crypto.ts`, `modules/runtime/runtime.ts`, `modules/operations/mappers.ts`,
`http/routes/public.ts`) never mentioned `connectors` at all. The `connector-credentials`-vs-`connectors`
confusion lands on **G10**. I fixed the substance in both places - G1 now has fully qualified paths, G10 has
the corrected module - rather than silently "fixing" a path that was not there.

---

## 2. Correction 2 - G3 settings: read exists, write is a deliberate refusal

**Before (803):** "`packages/contracts/src/*.ts` grep for `Settings` = 0 matches ... there is no DTO, no
writer action". That was true when I ran it. It is false now.

**After (verified):**

**READ** - `packages/contracts/src/settings.ts`:
- `SettingsReadSchema:115` - the `GET /admin/api/settings` view
- `SettingsAiDefaultsSchema:39`, `SETTINGS_PROMPT_SLOTS:53`, `SettingsPromptDefaultsSchema:62`
- `SettingsStorageSchema:77` - carries a `secretPresent` **presence bit, never a value** (`:72`)
- `SettingsCacheRetentionSchema:90`, `SettingsCapabilitiesSchema:107`
- relayed verbatim by `app/admin/bff/settings.ts:4`

**WRITE** - exists as a refusal, on purpose:
- `SettingsUpdateParamsSchema:134` is `.strict()`
- `SETTINGS_WRITER_DISABLED_CODE` / `SETTINGS_WRITER_DISABLED_REASON` at `settings.ts:159-160`
- `app/admin/bff/settings.ts:5` - POST **REFUSED at the capability gate (fail-closed)**
- `app/admin/bff/handle.ts:17` - "settings read; writer is disabled"

**Consequence unchanged: CẢN UI.** Reads now work; every write returns `SETTINGS_WRITER_DISABLED`. The
remaining blocker is the deployment adapter behind the write path (G7 / G12), which is the same root the
803 receipt already identified.

---

## 3. Correction 3 - G5 workflows: route and gate are two different things

**Before (803):** "`router.tsx` route list ... **no `workflows` path**".

**After (verified):**
- **Route - EXISTS:** `apps/admin-web/src/router.tsx:49` `{ path: 'workflows', Component: WorkflowsRoute }`,
  and `routes/workflows.tsx:3-4` renders `WorkflowsScreen`. Landed by P3 (dsh_2) after 803 was written.
- **Gate - STILL CLOSED:** DEV-03 `/admin/workflows` deployment is user-gated (WAVE-801 A6).

**Consequence unchanged: CẢN UI**, but for a different reason - it is gated by a user decision, not by a
missing route. The row now splits the two explicitly, because only the route half was ever code work and no
amount of engineering advances the gate.

---

## 4. Correction 4 - G6 identity: the BFF routes exist; the screen does not

**Before (803):** grep over `http/routes/*.ts` + `app/admin/bff/*.ts` = 0 matches.

**After (verified):**
- **Routes - EXIST:** `app/admin/bff/identity.ts:4-6` - `GET /admin/api/identity`,
  `POST /admin/api/identity/users`, `PATCH /admin/api/identity/users/:id` (CAS); wired at
  `app/admin/bff/handle.ts:18`.
- **Contract - EXISTS:** `packages/contracts/src/identity.ts` - `IDENTITY_ROLE_VALUES:26`
  (ADMIN/USER/VIEWER), `IdentityRoleSchema:27`, `CreateIdentityUserParamsSchema:97`,
  `UpdateIdentityUserParamsSchema:111`, `IDENTITY_VERSION_CONFLICT_CODE:133`.

**Path note:** the file is `app/admin/bff/identity.ts`. My 803 grep did include `app/admin/bff/*.ts`, so the
0-match result was correct **at that time**; the routes landed afterwards. The row now names the exact file
so the next reader does not have to re-derive it.

**Consequence unchanged: CẢN UI** - the remaining work is the CFGADM-08 screen (P2, codex_worker_1), not a
missing route.

---

## 5. What did NOT change

- **The three severity levels** (`CẢN UI` / `CẢN LIVE` / `KHÔNG CẢN`) and the rule that each consequence must
  be tied to something observed. Where the corrected evidence changed the *reason*, the level stayed and the
  reason is restated in the row.
- **Ordering remains the user's.** No priority was assigned in 803 and none is assigned here.
- **G2, G4, G7, G8, G9, G11, G12 were not touched** - REVIEW-805 flagged four rows, and only those four moved.

## 6. Edits made

`coordination/reports/gap-inventory-803-2026-10-05.md`: G1 (paths qualified), G3 (row replaced), G5 (row
replaced), G6 (row replaced), G10 (paths qualified + note), ledger (a CORRECTED pointer to this receipt).
No other file changed.

## 7. Ledger

- GAP-INVENTORY-CORRECTIONS - Muc 1 - fixed the 4 REVIEW-805 evidence rows in gap-inventory-803: one REAL
  path error (`connector-http-store.ts` is in `modules/connector-credentials/`, and the numbering pointed at
  G1 while the confusion lands on G10) and three STALE-EVIDENCE rows (settings wire, identity BFF routes and
  the workflows route all landed after 803 was written - now refreshed with file:line, read/write and
  route/gate split). Severity levels and the user-owns-ordering stance unchanged. DOC-ONLY: no source edit,
  no test, no commit, no tick.
