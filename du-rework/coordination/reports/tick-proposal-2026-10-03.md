# TICK-PROPOSAL — rows with enough evidence to propose [x] (2026-10-03)

**Task:** TICK-PROPOSAL · **Date:** 2026-10-03 · **Status:** proposal only. **Nothing ticked, nothing committed, no file modified**, nocobase-10 not contacted.

## 0. Headline

Across the seven recon receipts, **exactly one row** clears mechanism + test + receipt: **CONV-12** — and even it carries an explicit outstanding clause in its own acceptance line.

That is not a gap in the recon work. Every recon lane applied the same strict bar and said so in its own words:

- recon-e: *co mot row nao duoc ket luan done* (12 APP-ENCRYPTION rows),
- recon-h: *done nghia la du toan bo acceptance cua row, khong chi co module/suite offline* (21 rows),
- recon-c: *No row qualifies for a tick* (17 parity rows),
- recon-a: 2 of 25 rows proposed, both with a named caveat.

**A proposal list this short is the correct output, not a thin one.** Manufacturing more would mean ticking rows whose own acceptance is unmet.

## 1. Group A — propose tick

### A1. `CONV-12` — split `shell-router.ts` (recommended, with a caveat)

| field | value |
|---|---|
| plan row | `tasks/CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md:114-118` |
| mechanism | `shell-router.ts` **1916 → 447 lines**; 5 new modules (`shell-router-shared`, `section-dispatch`, `auth-dispatch`, `mutation-dispatch`, `crypto-config-dispatch`); declarations moved verbatim |
| invariants | cookie/CSRF/session revocation, role gate, GET/POST routing, `deferredSectionExtras`, redirect, `no-store` unchanged; `matchShellRoute` precedence preserved; all 20 original exports still resolve from `shell-router.ts` |
| cycle | DAG verified by grep; `shell-router-shared` imports nothing from the group |
| tests | `tsc --noEmit` **exit 0**; focused session/router/mutation/crypto **9 suites / 290 passed**; full-suite A/B **identical** (pre 8 failed / 28 tests / 4088 passed = post, same failing set) |
| receipt | `coordination/reports/qwen-conv12-shell-router-split-2026-10-03.md` |
| **outstanding** | the plan acceptance line ends *browser acceptance **rieng*** — a separate clause that has **not** been done |

**Proposal:** tick `CONV-12` **only if** the coordinator reads *browser acceptance rieng* as out of scope for the checkbox. If it is in scope the honest marker is `[~]`, not `[x]`. **I recommend `[~]`** — the code half is complete and evidenced, and claiming `[x]` would assert a browser journey nobody ran.

**Approver:** Reviewer + Claude Code `APPROVED` per `AGENTS.md`. No live infra needed.

### A2. `FIX-CR-01` — webhook destination/redirect/IP policy (PARTIAL)

| field | value |
|---|---|
| plan row | `tasks/REVIEW-FIXES-2026-09-23.md:10` |
| mechanism | `packages/contracts/src/ip-policy.ts` (`adjudicateUrlDestination:244`, `isDestinationAddressAllowed:216`); `packages/egress/src/pinned-fetch.ts` — one DNS answer shared by policy and dial (`:189,214,260,278`) |
| test | `packages/contracts/tests/ip-policy.test.ts` |
| receipt | `recon-old-plans-a-2026-10-03.md` section 1 |
| **residual** | `review.md:663` records `allowPrivateNetworks` as a broad explicit bypass, still open |

**Proposal:** `[~]`, not `[x]`. Ticking `[x]` would silently absorb the bypass. **Approver:** Reviewer + SEC owner.

### A3. `FIX-CR-11` — bounded ingress + caught stream errors (offline-evidenced)

| field | value |
|---|---|
| plan row | `tasks/REVIEW-FIXES-2026-09-23.md:20` |
| mechanism | `services/orchestrator/src/http/ingress.ts` — bounded JSON/blob caps, stream error/abort to `HttpError(400)`, oversize to 413, `binary` never utf8-decoded |
| test | `tests/ingress-bounded.test.ts` exists |
| receipt | `recon-old-plans-a-2026-10-03.md` section 1 |
| **caveat the plan does not carry** | `ingress-bounded.test.ts:95` **skips unless `DU_LIVE_INFRA=1`**, so the plan's *8/8 PASS* is **not reproducible offline today** |

**Proposal:** `[x]` is arguable on source grounds; `[~]` is defensible if the coordinator requires the test to actually execute. **Recommend `[~]` plus one live run** to restore reproducibility. **Approver:** Reviewer.

## 2. Group B — confirmed STALE markers to correct

These are not ticks. Each row text asserts something false about todays tree, so each needs a **marker/prose correction**, not a status change.

| # | stale claim | evidence it is stale | proposed correction |
|---|---|---|---|
| **S1** | `LOCAL-01` `[ ]` | `services/orchestrator/migrations/0023_admin_local_users.sql`, `src/modules/auth/admin-local/`, `src/migrations-local-users-cli.ts` all exist — `recon-f:45` | re-anchor: implementation present, **acceptance not evidenced** (no `VFY-LOCAL` receipt checked) |
| **S2** | `LOCAL-02` `[ ]` | `src/modules/auth/local-primitives/` exists — `recon-f:46` | same: marker stale, `uncertain` verdict stands |
| **S3** | manifest comment *host dispatch pending* for `disbursement` | handler + registration committed in `b088eec`, files clean vs HEAD — `recon-h:32` | delete/correct the comment |
| **S4** | tester receipt `p9-03`: *not mounted or registered* | manifest `document-core.manifest.ts:110,431`, worker handler `worker.ts:2000`, recipe `:448-450` in HEAD — `recon-h:34` | correct the receipts anchor (I independently re-verified the same three anchors this session) |
| **S5** | `PAR-01` / `PAR-M01` / `PAR00-M01` assert `dispatcher.ts:95` has no create/revoke | `dispatcher.ts:105-106` registers `apikey.issue`/`apikey.revoke`; `:540`/`:619` implement them with tenant fences — `recon-c` | rewrite the three rows, else the next dispatcher re-dispatches finished work (the CONV-08 failure mode) |
| **S6** | CONV plan line counts frozen at `adec19e` | `CONV-08` shipped in `b088eec` and was re-dispatched as if undone | re-baseline the plan table; it self-warns at `:3` to re-count |
| **S7** | guard `PLAN_BASELINE_COUNTS` for `services/orchestrator/src/server.ts` = 4299 | file measured **4448** and is actively ` M` — `qwen-conv01-prep-2026-10-03.md` section 0 | re-baseline after the CONV-01 wave, not before |

**S5, S1 and S2 are the ones that cost real money** — each is a row that will otherwise be dispatched twice.

## 3. Group C — cannot propose, and why

### C1. Blocked on a live window (`DU_LIVE_INFRA` unset)

| row | what is green | what is missing |
|---|---|---|
| `VFY-REG` | doc-core **924 pass / 1 skip / 925, exit 0** on 2 runs; Worker SDK 669 pass exit 0; de-flaked with a test-only warm-up, 5 s timeout and assertions untouched | the row acceptance requires the DB-touching projection case to run in an **isolated namespace**, not skip — `recon-g:53`, `tester-vfy-reg-flake-{check,fix}-2026-10-02.md` |
| `FIX-CR-02` | 3-phase webhook claim present (`webhooks.ts:358-383,509-534`) | `webhook-reclaim-fence.live.test.ts` is **0/2, exit 1** and is live-gated — `review.md:543` |
| `ADM-BASE-03` | response + console sentinel covered offline | **live sink scan** (stdout/ES/trace) and browser trace — `recon-h:14` |

**VFY-REG is the closest to tickable in the whole set** — the offline portion is complete and reproducible. One DB-window run of the skipped projection case would close it.

### C2. Blocked on a decision, not on capacity

- **`LOCAL-00`** is an explicit decision packet (mode env, machine-bearer policy, ADR + threat model) with **no owner and no deadline in the row** — `recon-f:44`. Therefore **`LOCAL-03/04/05/06` cannot start**: dispatching them means guessing the security contract. **`LOCAL-03` is a verified gap, not a stale marker** — `DU_ADMIN_AUTH_MODE` has **0 matches** in `main.ts`.
- **`P9-01`** (disbursement) is decision-gated by **CRX-04** (action #7 inside document-core vs a separate subproject/image/queue) — `recon-h:32`.
- **`P1-06`** has no spike receipt proving `concurrency=1` parent yield and server loop start/stop on a pinned version — `recon-g:35`.
- **`P0-03`** matrix exists but self-declares missing negative evidence for provider-invalid / `_prompt` / `file_urls` / artifact error — `recon-g:29`.

### C3. Blocked on a journey that was never run

- **All 17 ORCH-PAR rows + 6 PAR00-J rows**: recon-c found **no row with both a mechanism and a verified journey**. PAR-02/03/04 confirmed still open at code level (`server.ts:2600-2601` still returns `revision: 0`; `main.ts` still unwires `connectorBaseUrls`/`credentialWorkflow`).
- **All 12 APP-ENCRYPTION rows**: recon-e concluded zero `done`.
- **All 16 SEC-OIDC-VAULT rows**: recon-h found none at full acceptance.

### C4. Blocked on the writer, not on evidence

- **`CONV-01/02/03`** (`server.ts`): prep only. The file is ` M` right now with an active writer (`crx01-*`/`crx02-*` tests are theirs), so no lease can be claimed yet.
- **`CONV-08`**: shipped, but `admin-shell-render` still exits 1 on **2 pre-existing P6-01 reds** that A/B proved are a product-nav change, not a test defect. The split is done; the suite is not green.

## 4. Not proposed as ticks, deliberately

**RFX-08/16 and the RFX-01/02 delivery work** are real, evidenced and green — but `tasks/ORCH-REVIEW-FIXES-2026-10-02.md` states *khong tick parent tu tai lieu nay* and defines no per-row checkbox to tick. Proposing a tick there would invent a mechanism the plan deliberately does not have. Recorded as **evidence**; `G-ENC` stays NO-GO.

**RFX-02 also carries a known open defect** from my own verification: `mapCryptoError` in `artifact-read-decrypt.ts:113` flattens a size refusal into `503 STORAGE_FAILURE` with a message claiming the artifact could not be authenticated — which is exactly what the facade deliberately preserves as `SIZE_LIMIT`. The patch is written up, **not applied**, because it is outside the lease that was granted.

## 5. Method limits — stated plainly

1. **I synthesized the recon receipts; I did not re-derive all seven.** Row-level verdicts are grep-extracted from `recon-old-plans-{a,b,c,e,f,g,h}-2026-10-03.md` and cross-read against the receipts they cite. **There is no `recon-old-plans-d`** — the sequence a..i has a gap; I did not investigate which lane owns it or whether rows are missing from this synthesis.
2. **`plan-open-task-register-2026-10-03.md` was used only as a cross-check on stated status**, never as evidence — RECON-A established it transcribes the plans own Status column with no source, receipt or commit attached.
3. **No test was run for this packet.** Every *green* above is quoted from the receipt that ran it, at the date that receipt ran it.
4. **The `AGENTS.md` bar was applied as the recon lanes wrote it**: `done` = the rows *full* acceptance, not the presence of a module or an offline suite. I did not relax it, and where a row is close I proposed `[~]` rather than `[x]`.

## 6. What I would do next, in order

1. **Claim a DB window and run the one skipped VFY-REG projection case.** Highest value per unit of effort in the entire set.
2. **Correct markers S1, S2, S5** — these are actively costing re-dispatch of finished work.
3. **Get an owner and a deadline onto `LOCAL-00`.** It gates four rows and currently has neither.
4. **Decide `CONV-12`**: `[~]` now (recommended), or `[x]` after browser acceptance if the coordinator wants that clause enforced.

**No gate is ticked by this receipt.**