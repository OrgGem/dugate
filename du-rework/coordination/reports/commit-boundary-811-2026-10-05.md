# COMMIT-BOUNDARY-811 - receipt (building a real commit boundary, DOC-ONLY)

> **RESUME POINT (qwen_5, 2026-10-05)** - task COMMIT-BOUNDARY-811 (task_087dc410337f),
> dispatch ctx_03df011d06a7. **DOC-ONLY**: no source edit, no file deleted, no commit, no tick.
> Commands used: `git status`, `git check-ignore`, `type .gitignore`, `node` stat/parse, `read_file`.

---

## 0. Correction to WAVE-COMMIT-PLAN-809 first

809 reported **1311 untracked**. That number is **wrong** and I am correcting it here: it came from
`git status --porcelain | find /c "??"`, and `find /c` matches the substring anywhere in a line, not the
line prefix. Parsing the same dump by **line prefix** gives:

```
UNTRACKED_TOTAL      = 2062   (not 1311)
TRACKED_MODIFIED     =  155   (809 had this right)
```

The classification and the product list in 809 are unaffected (they were built from a prefix-aware
parse), but every count in 809 that said "untracked" is understated by 751.

---

## 1. Classification of the 2062 untracked entries

| Area | Count | What it is | Commit? |
|---|---:|---|---|
| `du-rework/coordination/**` | 1716 | lane receipts, evidence PNGs/traces, dispatch specs, state json, raw dumps | **NO** - see section 3 |
| `du-rework/services/**` | 115 | product source + tests + migrations | **YES** (except the 4 raw dumps) |
| `scratch/**` | 80 | coordinator `coord-update-*.js` scratch scripts | **NO** |
| `du-rework/apps/**` | 71 | admin-web source, config, styles | **YES** |
| `du-rework/tests/**` | 30 | browser specs, fixtures, live-prep | **PARTIAL** - fixtures yes, `test-results-*` no |
| `du-rework/packages/**` | 13 | contracts + worker-sdk | **YES** |
| `du-rework/tasks/**` | 10 | task docs | **SEPARATE** |
| `components/**` (repo root) | 8 | legacy root UI components | **DECISION** - not du-rework, see section 6 |
| `du-rework/businesses/**` | 7 | document-core | **YES** |
| `coordination/**` (repo root) | 3 | root-level receipts, outside du-rework | **NO** |
| `du-rework/infra/**` | 3 | `docker-compose.live.yml` + scripts | **NO** - live config |
| `du-rework/scripts/**` | 2 | `dev-live.ps1`, `dev-live.sh` | **DECISION** |
| `du-rework/.env.live` | 1 | **live environment file** | **NO - and see section 2** |
| `lib/utils.ts`, `DUGATE_ADMIN_UI_FUNCTIONS.md`, `du-rework/docs/**` | 3 | legacy root + docs | **DECISION / SEPARATE** |

---

## 2. gitignore coverage - and the one finding that matters most

**Every path in the untracked list is already NOT ignored.** `git status` does not list ignored files, so
the 2062 are all stageable today. The question is which *should* be ignored.

Verified with `git check-ignore -v`:

```
du-rework/apps/admin-web/dist/index.html   -> IGNORED (du-rework/apps/admin-web/.gitignore:2 dist/)
du-rework/coordination/evidence/**.json    -> NOT ignored
scratch/coord-update-*.js                  -> NOT ignored
du-rework/services/orchestrator/coordination/reports/raw/*.txt -> NOT ignored
```

### HIGHEST-RISK FINDING: `du-rework/.env.live` is untracked AND not ignored

The root `.gitignore` covers `.env`, `.env.local`, `.env.production` - **but not `.env.live`**.
`du-rework/.gitignore` contains a bare `.env`, which does not match `.env.live` either. So a live
environment file sits one `git add` away from being committed.

**Recommendation (judgment, no file deleted):** add `.env.live` (and `.env.*.live`) to the root
`.gitignore` **before any staging happens**. I did not make the edit - this packet is doc-only - and I did
not read the file.

### Other uncovered paths worth ignoring

| Path | Why |
|---|---|
| `scratch/**` | coordinator scratch scripts; the root `.gitignore` already has a "agent scratch / debris" block, `scratch/` simply is not in it |
| `du-rework/coordination/evidence/**` | ~300 PNGs/traces; the `.gitignore` comment block already contemplates excluding coordination history |
| `du-rework/services/orchestrator/coordination/reports/raw/**` | raw PG16 dumps sitting inside a package |
| `du-rework/tests/browser/test-results-*/**` | test output (`.last-run.json`) |
| `du-rework/infra/docker-compose.live.yml`, `du-rework/scripts/dev-live.*` | live-deployment surface, not product |

Note the root `.gitignore` already contains a **commented-out** block:
`# Optional (uncomment if the coordinator chooses NOT to stage these as history): du-rework/coordination/reviews/`,
`reports/`, `dispatch-specs/`. That is a decision the coordinator already framed and left open - see
section 6.

---

## 3. The 155 tracked-modified files: 60 wave-side, 95 pre-existing

**Evidence available: write time only.** There is no commit boundary, so mtime is the sole signal. For
*tracked* files mtime is weaker than for untracked ones: a file can be touched (EOL normalisation, a
formatter, a build) without its content belonging to this wave.

**Wave-side (mtime >= 2026-10-05 00:00 +07:00): 60 files.**

| Area | Count | Product? |
|---|---:|---|
| `services/orchestrator` (13 src + 15 tests) | 28 | YES |
| `businesses/document-core` (9 src + 1 test) | 10 | YES |
| `packages/contracts` | 4 | YES |
| `packages/worker-sdk` | 2 | YES |
| `docs/**` | 7 | SEPARATE |
| `coordination/**` (agent-watch-state, coordinator-state, claude.md, tester.md) | 4 | NO |
| `tasks/**` | 3 | SEPARATE |
| `.commandcode/taste/taste.md` | 1 | NO |
| `du-rework/.env.example` | 1 | NO pending audit |

Product subset of the wave-side tracked modifications: **44 files** (28 + 10 + 4 + 2).

**Pre-existing: 95 files** - tracked-modified but with mtime before the cut. These belong to waves 780-808
and must not ride this commit.

---

## 4. The rules - one is certain, one is still an assumption

### RULE A - product vs coordination/docs/reports: **CERTAIN**

```
COMMIT product code and tests under:
  du-rework/apps/**            du-rework/packages/**
  du-rework/services/**        du-rework/businesses/**
  du-rework/tests/**           du-rework/migrations-equivalent (services/*/migrations/**)

DO NOT COMMIT, ever, in a product commit:
  du-rework/coordination/**    coordination/**
  scratch/**                   .commandcode/**
  du-rework/docs/**            du-rework/tasks/**
  any .env* other than a reviewed .env.example
  any dist/ node_modules/ coverage/ *.tsbuildinfo
```

Why this one is certain: it is a **path-prefix** rule. It needs no timestamp and no receipt. A path is
either inside a product tree or it is not. This is the rule 809 was reaching for.

### RULE B - pre-existing vs this wave: **STILL AN ASSUMPTION**

```
wave-side  := mtime >= 2026-10-05 00:00 +07:00
pre-existing := everything else
```

Why it stays an assumption:

1. **mtime is not authorship.** On this machine 29+ node processes and ~13 lanes share one checkout; a
   build or a formatter rewrites mtimes without changing who wrote the content.
2. **A tracked file can be touched without being changed in this wave** - the 26,027/14,599 diff spans
   waves 780-809 and cannot be split by timestamp alone.
3. **The strongest available evidence is not mtime, it is the lane receipts** - each receipt names the
   files its lane wrote. Cross-reading ~150 receipts against 155 files would produce a defensible
   attribution. **I did not do that in this packet**; it is a separate, larger job.

**What would make Rule B certain:** a per-file `git log`-style record, which does not exist here because
nothing was ever committed. Short of that, the receipts are the only upgrade path.

---

## 5. Final commit list

**Product files to commit = 44 tracked-modified (wave-side) + the untracked product set from 809 section 4
minus the raw dumps.** Grouped and ordered dependency-first:

| # | Group | Content | Message |
|---|---|---|---|
| 1 | contracts | 8 untracked + 4 modified (4.3 of 809, plus `connector-management.ts`, `identity.ts`, `settings.ts`, `profile-policy.ts`) | `feat(contracts): add settings/identity/connector-management wires and tighten runtime+operations` |
| 2 | ENCMETA | `metadata-crypto.ts`, `runtime.ts`, `legacy-payload-migration.ts`, `metadata-auth-counter.ts`, `db/migrations.ts`, `mappers.ts`, `submission.ts`, `acquisition-ref-resolver.ts` | `feat(encmeta): seal result_ref, fix the TEXT reader bypass, add the auth gate counter` |
| 3 | connector credentials | `compose.ts`, `vault-kv2-writer.ts`, `connector-management-store.ts` | `feat(connector-credentials): compose the Vault KV2 credential workflow` |
| 4 | orchestrator shell + BFF | `bff/{handle,identity,settings}.ts`, `route-context.ts`, `routes/{admin,public,runtime}.ts`, `view-models.ts`, `p6-01-shell-fixtures.ts`, `shell-server.ts`, `main.ts`, `server.ts`, `legacy-http-mount.ts`, `admin-local/repository.ts`, `dispatcher.ts` | `feat(orchestrator): add settings/identity BFF routes and admin shell wiring` |
| 5 | admin-web | 16 src + app config (`package.json`, `tsconfig.json`, `components.json`, `styles/tokens.css`) + 9 browser specs | `feat(admin-web): settings surface, identity and workflows screens` |
| 6 | document-core + worker-sdk | 9 src + `prompt-application.ts`, `types/{context,results}.ts`, `worker.ts`, `fan-out.ts` | `feat(document-core): prompt application and execution pin` |
| 7 | migrations | `0025`-`0032` (8 untracked SQL) | `chore(migrations): add profile policy, prompt pin and checkpoint session_ref` |
| 8 | tests | the wave-side test files (15 orchestrator modified + untracked suites) | `test: cover the above` |

### High-risk files to EXCLUDE

| Path | Why |
|---|---|
| `du-rework/.env.live` | live env file, **not gitignored** - gitignore it first |
| `du-rework/infra/docker-compose.live.yml`, `infra/scripts/**` | live deployment surface |
| `du-rework/scripts/dev-live.ps1`, `dev-live.sh` | live boot scripts; the runbook already warns about them |
| `du-rework/services/orchestrator/coordination/reports/raw/*.txt` (4) | raw PG16 evidence dumps inside a package |
| `du-rework/tests/browser/test-results-*/**` | test output |
| `du-rework/tests/live-prep/**` (8) | live-prep fixtures, not product |
| `du-rework/.env.example` | dirty; audit for real values first |
| `du-rework/coordination/**`, `coordination/**`, `scratch/**` | Rule A |

---

## 6. What still needs a HUMAN decision

1. **`.env.live` gitignore** - I recommend adding it, but the edit is a repo policy change and this packet
   is doc-only. Someone must make it before any staging.
2. **The commented-out `.gitignore` block** - whether `du-rework/coordination/{reviews,reports,dispatch-specs}``
   become history or stay untracked. The coordinator already framed this as a choice; it is not mine.
3. **`components/**`, `lib/utils.ts`, `DUGATE_ADMIN_UI_FUNCTIONS.md` at the repo root** - these are the
   **legacy Next.js app**, not du-rework. Whether they belong in any commit of this programme is a scope
   decision.
4. **`du-rework/scripts/dev-live.*`** - product or live-deployment surface? The runbook treats them as
   live, which argues exclude.
5. **Rule B (wave vs pre-existing)** - either accept the mtime assumption, or commission the
   receipt-cross-read that would replace it with real attribution.
6. **EOL policy** - the tree is full of `LF will be replaced by CRLF` warnings. Decide `.gitattributes`
   **before** staging or the real diff will be buried.

---

## 7. Ledger

- COMMIT-BOUNDARY-811 - Muc 1 - built the commit boundary with evidence: corrected 809 untracked count
  1311 -> **2062** (find /c substring vs line-prefix); classified 2062 untracked by area; proved every
  untracked path is currently NOT ignored and found **`du-rework/.env.live` untracked and unignored**
  (highest risk); split the 155 tracked-modified into **60 wave-side / 95 pre-existing** by mtime; stated
  **Rule A (product vs coordination/docs) as CERTAIN** because it is a path-prefix rule, and **Rule B
  (wave vs pre-existing) as STILL AN ASSUMPTION** because mtime is not authorship and the receipts are the
  only upgrade path; produced the ordered 8-group commit list plus a high-risk exclusion list; listed 6
  items needing a human decision. DOC-ONLY: no source edit, no file deleted, no commit, no tick.
