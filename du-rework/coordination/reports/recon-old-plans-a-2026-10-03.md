# RECON-A — old plans (2026-09-23) vs current evidence

**Task:** RECON-A · **Date:** 2026-10-03 · **Status:** read-only reconciliation. No test run, no source change, no gate ticked, no commit.

Scope: `tasks/REVIEW-FIXES-2026-09-23.md` (12 rows) and `tasks/PLAN-MISMATCH-FIXES-2026-09-23.md` (13 rows).

## 0. Headline finding — the same-day register adds no evidence

`coordination/reports/plan-open-task-register-2026-10-03.md:367-400` already tabulates both plans. **It is a transcription, not a reconciliation:** every one of its 25 rows copies the plan's own `Status` / `Priority` cell verbatim and marks it `implementation-open`. It cites no source line, no receipt and no commit for any row.

That matters because it looks like current evidence and is not. This receipt therefore re-derives every verdict from the working tree, and treats the register only as a cross-check on the *stated* status.

**Method limits, stated up front.** No tests were run (dispatch constraint). So a verdict of `done` here means *the mechanism is present in current source with a named test file*, never *the acceptance criteria are met* — several rows' acceptance explicitly require real-PostgreSQL or multi-replica evidence that only a Tester window can produce. Where that is the binding gap I say `uncertain` and name the missing evidence rather than guessing.

## 1. REVIEW-FIXES-2026-09-23 — 12 rows

| row | plan status | verdict | current evidence |
|---|---|---|---|
| **FIX-CR-13** binary artifact wire | IN PROGRESS | **open** | Binary path exists: `server.ts:814-821` sends `result.raw` byte-for-byte (piped when `Readable`, otherwise `content-length` + `res.end(raw)`), and `src/http/ingress.ts` returns blob bodies raw under `binary`. No closure receipt; `antigravity-6.md:2720-2738` has a `FIX-CR-13: binary artifact wire (real HTTP)` describe block but that is a report, not a run record. |
| **FIX-CR-01** webhook destination/redirect/IP policy | TODO | **done (mechanism), residual open** | `packages/contracts/src/ip-policy.ts` (`adjudicateUrlDestination:244`, `isDestinationAddressAllowed:216`) and `packages/egress/src/pinned-fetch.ts` (one DNS answer shared by policy and dial at `:189,214,260,278`). Test: `packages/contracts/tests/ip-policy.test.ts`. `review.md:663` records the residual: `allowPrivateNetworks` remains a broad explicit bypass. |
| **FIX-CR-02** bounded webhook dispatch, durable claim, shutdown tracking | TODO | **open** | 3-phase claim is present in `modules/webhooks/webhooks.ts:358-383` (claim token = `next_at::text`, guarded release at `:509-534`), backoff at `:136`. But the live proof is red: `review.md:543` records `webhook-reclaim-fence.live.test.ts` **0/2, exit 1**, and that suite is `DU_LIVE_INFRA`-gated (`:53`), so it does not run offline. |
| **FIX-CR-03** atomic first-use idempotency contention | TODO | **open** | `modules/idempotency/idempotency.ts:113` `executeIdempotent`, used at `dispatcher.ts:331-732`; `submission.ts:271,330,686` reads/inserts `submission_keys`. No named concurrent-replay regression receipt found. |
| **FIX-CR-04** atomic idempotency TTL replacement | TODO | **open** | Same machinery; `submission_keys.expires_at` exists (`submission.ts:330`). No before/after-expiry test receipt found. |
| **FIX-CR-05** resolve replay before mutable admission | TODO | **open** | `submission.ts:271` reads an existing key before admission. Ordering across drain/schema/profile change is not evidenced by any receipt I found. |
| **FIX-CR-06** active lease fencing across runtime mutations | TODO | **open** | Fencing is materially present: `modules/runtime/runtime.ts` guards heartbeat/save/complete/fail with `state='RUNNING' AND lease_expires_at > clock_timestamp()` (`:397,474,548,621,662`) and epoch checks at `:335,360-361`. Test exists: `tests/runtime-lease-fencing-offline.test.ts`. **`review.md:565` records no published execution receipt** — the fake transaction does not exercise real PG locks. |
| **FIX-CR-07** provider PENDING continuation vs failure attempts | BLOCKED | **open (blocked)** | Plan blocks on SDK lane ownership. No evidence the SDK lane is restored; `review.md` and `qwen-platform.md` show SDK work resumed (worker-sdk 171/171 per lane memory), so the BLOCKED reason may be stale — needs an owner ruling. |
| **FIX-CR-08** timeout/abort through response consumption | BLOCKED | **open (blocked), same caveat** | `tests/network-boundaries.boundary.test.ts` includes a `FIX-CR-08 caller-signal-aborts-body` case that passed (`tester.md:9467`), and `tester3.md:48` records it failing under parallel load then passing standalone. So a real boundary test exists; the plan's BLOCKED status likely predates it. |
| **FIX-CR-09** bounded, classified Connector readiness probe | TODO | **uncertain** | `server.ts:1354-1363` exposes `GET /api/v1/connectors/:id/test`. Whether the probe is bounded and classifies a required-body failure cannot be determined by reading the route line alone — needs the probe implementation, which I did not open. **Missing: the probe body / its test.** |
| **FIX-CR-10** exact usage aggregation, wire-range enforcement | TODO | **uncertain** | Usage suites exist and are recent: `tests/usage-aggregation.test.ts`, `usage-summary.test.ts`, `usage-drilldown.test.ts`, `usage-contracts-integration-offline.test.ts`. Whether they cover **overflowing row/grand totals** (the row's actual acceptance) I did not read. **Missing: the overflow assertions.** |
| **FIX-CR-11** bounded ingress + caught stream errors | DONE | **done, with a caveat the plan does not carry** | `src/http/ingress.ts` implements exactly this (bounded JSON/blob caps, stream error and abort -> `HttpError(400)`, oversize -> 413, `binary` never utf8-decoded). `tests/ingress-bounded.test.ts` exists. **Caveat: `:95` skips unless `DU_LIVE_INFRA=1`**, so the plan's "8/8 PASS" is not reproducible offline today. |
| **FIX-CR-12** complete artifact grant/integrity work | TODO | **uncertain** | Grant + fencing machinery exists (`modules/artifacts/`, `invocation_grants` migration `0003`), and several focused suites are on disk. Whether expiry/mode/ownership/fencing/hash/immutability **negatives** all exist and pass is not determinable without running them. **Missing: a run receipt for the named negative matrix.** |

## 2. PLAN-MISMATCH-FIXES-2026-09-23 — 13 rows

**All 13 are `uncertain` or `open`, and the reason is uniform: every one's acceptance criteria are behavioural or live, and this packet may not run tests.** I am not going to convert that into a confident `open` for rows whose code may in fact be finished.

| row | plan status | verdict | what is actually established | what is missing |
|---|---|---|---|---|
| **MM-01** shipped worker auths to production Connector verifier | BLOCKED SDK portion | **uncertain** | Connector-side verifier exists (`services/connector/src/identity.ts` via `HmacServiceIdentityVerifier`). | Whether the **shipped** document-core worker uses it, and that missing/wrong identity is denied, is a cross-service run. |
| **MM-02** API-key-only upload -> roles -> process -> result | TODO | **uncertain** | Upload + artifact role paths exist (`operations/submission.ts`, artifacts module). | End-to-end run with CR-12/13 closed; depends on two rows I cannot verify. |
| **MM-03** profile v1 survives v2 activation, immutable snapshot | TODO | **uncertain** | `profile_bindings` is revision-keyed (`0004_profile_bindings.sql:14-27`, PK `(profile_id, revision)`) and operations pin `profile_revision` (`:30-32`). | Whether an **existing operation keeps its v1 snapshot** after v2 activation — a behavioural test. |
| **MM-04** public-only HITL discovery/resume + stable pagination | TODO | **open** | Partially contradicted by my own RV01 work: `documentCoreHandlers` exposes `resume` and the compat facade wires it, but the legacy facade's `billing`/`services` remain 500 and workflows 503 (`qwen-rfx`/`qwen-worker-split` receipts). Pagination is a **known open item**: legacy `next_page_token` vs the canonical 4-slot cursor (`docs/28` review rows). | — |
| **MM-05** Redis loss before claim reconstructs READY job | TODO | **open** | `review.md:643` states this explicitly: "MM-05/P8-02 remains open because the current gated suite is 4/5 and source still has an unguarded state transition". | The unguarded transition; a full-suite green. |
| **MM-06** provider 202 -> polling -> result across restart | TODO; SDK held | **uncertain** | Blocked on the same SDK question as CR-07. | Owner ruling on the SDK lane, then a run. |
| **MM-07** concurrent + CANCELLED same-ID replay never redispatch | TODO | **uncertain** | `tests/r24-01-poll-fence-offline.functional.test.ts` exists. | Whether the quota-lease-expiry case is in it. |
| **MM-08** shared-account cap, reservations, lease renewal | TODO | **open** | `migrations/0022_budget_reservations.sql` exists (reservations). | Cap/renewal enforcement across tenants+revisions is behavioural; no receipt found. |
| **MM-09** inspect running digests around extension registration | TODO | **uncertain** | — | This is a **deployment/live** criterion by construction ("inspect actual running digests", "provision real identities"). Cannot be settled from the repo. |
| **MM-10** rendered profile edit/publish user flow + fault injection | TODO | **open** | Directly intersects work this session observed as unfinished: ACUI-M01/M02 (profile form POST unwired, `revision: 0` returned) per `ADMIN-CONTROL-PLANE-UI-2026-10-02.md`. | The Admin flow itself; the fault injection. |
| **MM-11** producer/schema tenantId decision, spec examples validated | TODO | **uncertain** | — | Requires validating real responses against `docs/21-openapi.json` plus a fresh-checkout portable command. |
| **MM-12** container starts listener, clean deploy verified | TODO | **uncertain** | Packaging work exists (`Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh`). `review.md` records a **P8-06 clean-deployment defect** (compose parse failure on `REDIS_KEY_PREFIX`). | A clean-environment deployment run. |
| **MM-13** DB selection/guards, Redis DB collisions | PARTIAL (disputed) | **open (disputed)** | Evening reconciliation records delivery with residual Redis-collision and unused-prefix caveats. | The dispute itself is unresolved; `PROGRESS-RECONCILIATION-2026-09-23-EVENING.md` is the record. |

## 3. A) `done` -> suggested evidence for a tick decision (I do not tick)

| row | why it qualifies | what a coordinator should still require |
|---|---|---|
| **FIX-CR-11** | The mechanism is unambiguous in `src/http/ingress.ts` and a named test file exists. | Note the **live gate**: `ingress-bounded.test.ts:95` skips without `DU_LIVE_INFRA`. Either accept the offline source proof, or get one live run so "8/8" is reproducible. |
| **FIX-CR-01** | The IP/destination policy and DNS-pinned fetch are implemented with a contracts test suite. | The `allowPrivateNetworks` bypass named in `review.md:663` is a separate decision; ticking CR-01 should not silently absorb it. |

These are the **only two** rows I would put forward as tick candidates. Everything else needs a run receipt, a live window, or an owner ruling.

## 4. B) `open` -> one line each + file-lease estimate

Grouped by shared lease, since several rows touch the same file and the plan's own collision rules forbid two active owners.

| group | rows | one-line work | lease (estimate) |
|---|---|---|---|
| webhook | FIX-CR-02 | Isolate the 2 live fence failures (claimant B stuck PENDING; shutdown `attempts=1` not 0), then rerun under Tester. | `services/orchestrator/src/modules/webhooks/`, `migrations/0007*`, `tests/webhook-reclaim-fence.live.test.ts` |
| runtime fencing | FIX-CR-06 | Publish an execution receipt for `runtime-lease-fencing-offline.test.ts`, then real-PG cancellation/expiry races. | `src/modules/runtime/`, that test |
| idempotency | FIX-CR-03/04/05 | One coherent packet: concurrent first-use, TTL expiry boundaries, replay-before-mutable-admission. | `src/modules/idempotency/`, `src/modules/operations/submission.ts`, migration `0001 submission_keys` |
| MM-05 / MM-07 / MM-08 | quota + reservation + poll fence | Close the unguarded state transition; prove same-ID replay never redispatches; enforce shared-account cap and lease renewal. | connector + orchestrator reservation/ledger modules |
| MM-12 / MM-09 | deployment | Fix the compose `REDIS_KEY_PREFIX` parse defect, then a clean-environment start + health/shutdown/migrations/restore run. | `infra/docker-compose.yml`, `Dockerfile`, entrypoint |
| MM-04 / MM-10 | public HITL + Admin profile flow | Finish resume/wait discovery on the public surface; wire the profile edit/publish flow (ACUI-M01/M02). | `src/app/admin/*`, `server.ts` profile routes — **overlaps active ACUI writers** |

**Overlaps to serialise before dispatch:** MM-10 collides with the ACUI/P6 Admin-shell owners; MM-09/MM-12 touch deployment files other lanes may hold. FIX-CR-13's binary path sits in `server.ts`, which the RFX lease table assigns to RFX-10/11/12.

## 5. C) `uncertain` -> the questions that would settle them

1. **FIX-CR-09 / FIX-CR-10 / FIX-CR-12** — three rows I could not adjudicate because I did not read the probe body or the assertions. One focused read of each test file settles all three; no new work is implied.
2. **Is the SDK lane restored?** FIX-CR-07, FIX-CR-08 and MM-06 are all marked BLOCKED on an SDK lane that lane memory says resumed. **Who rules on that?** Until then three rows cannot be scheduled.
3. **Do the live-gated suites count as acceptance?** `ingress-bounded`, `webhook-reclaim-fence.live` and several others skip without `DU_LIVE_INFRA`. If a skip is not evidence, then FIX-CR-11's tick rests on source reading alone and MM-05/MM-12 cannot be assessed at all without a window.
4. **MM-13's disputed closure** — the dispute is between an agent's delivery claim and the evening reconciliation's residual concerns. Needs the adjudicator named in the plan, not a re-derivation.
5. **MM-09 and MM-12 are live-deployment criteria by construction.** If the coordinator wants them tracked, they need a deployment window in scope; from the repository alone they can never be `done`.

## 6. One caution about these plans

Both files are dated **2026-09-23**, ten days before this reconciliation, and the recent history shows their line-level pointers drifting (RFX's plan cited a tree around `f2be0de`; the current HEAD is `b088eec`, and the CONV plan's line counts were frozen at `adec19e` and re-dispatched work that had already shipped). **Every verdict above was re-derived from the working tree, and the plans' own Status column was treated as a claim to check, not as a fact.** Where they and the tree disagree, the tree wins.

**No gate is ticked by this receipt.**