# COMP01-Q15 — consumer inventory scan (read-only)

**Task:** `task_187b64ed236e` · **Date:** 2026-10-02 · **Status:** read-only scan. No gate ticked, no commit, no source/test/config/task/plan modified.

## 0. The headline, stated before anything else

**This task has already been executed and independently reviewed.** `qwen-platform.md` **Mục 53**, task `task_comp00_consumer_inventory`, covers the same question with the same scope wording, and two reviews verified it (`reviews/2026-10-01-1000-review.md:37`, `reviews/2026-10-01-1000-coordinator.md:43`). **Mục 54** then covered the adjacent mount inventory.

I re-ran the scan independently rather than assuming the prior result, and **my scan reproduces the central finding exactly**. This receipt is therefore: (a) independent confirmation, (b) four things the prior receipt did not state, and (c) a re-run notice, which matters because a coordinator reading the lane ledger should not read "Q15" as new information.

## 1. Method and scan coverage

| Tree | Queried | Result |
|---|---|---|
| `app/` | `api/v1/services`, `billing/balance`, `billing/usage`, `webhook_url`, `webhookUrl` | 4 hits, **none is a caller** — two routes' own doc comments, the operations list *returning* `webhookUrl` (`operations/route.ts:85`), and swagger telling clients to call `/services` (`swagger/route.ts:103`) |
| `components/` | same | **0 hits** |
| `lib/` | same + `fetch(` | 22 hits, all webhook **producers** (see §4) |
| `tests/` | same | 3 hits, all a `webhookUrl: string \| null` **type field** in a fixture (`tests/workflow-builder/hitl-persistence.test.ts:66,87,145`) |
| `mock-service/` | `services\|billing\|webhook\|callback` | 1 hit, the word "services" inside mock LLM prose (`responses/ext-translator.js:45`) |
| `docs/` | same | 7 hits, all contract documentation |
| `scripts/` | `services\|billing\|webhook` | **0 hits** |
| `du-rework/` | `api/v1/services`, `billing/balance`, `billing/usage` | 116 hits, **all in docs and tasks** — zero code |

**Transport check the prior receipt did not run.** A consumer could bypass `fetch` entirely, so I also searched the whole repo for `axios`, `XMLHttpRequest`, `navigator.sendBeacon`, and `new WebSocket`: **8 hits, all of them lockfile entries** (`pnpm-lock.yaml:2015,6374,6796`; `package-lock.json:5448,6605,6607`; `docs-site/package-lock.json:777,793`). **There is no axios, beacon or WebSocket client anywhere in source**, so `fetch` is the only transport and the scan above is complete for in-repo callers.

## 2. The three GET routes — no in-repo consumer

`fetch(` matched with `services|billing`, repo-wide, returns **exactly one source hit**:

```
components/ServiceTestClient.tsx:214   fetch(`/api/v1/docs/${serviceSlug}?sync=true`, { method: POST, ... })
```

It targets **`/api/v1/docs/…`**, not `/services`. The file has only two URL literals in total — `:182` (a curl string shown to the user) and `:214` (the actual call) — and **zero** occurrences of `webhook`. It is consumed by six pages, `app/docs/{ingest,extract,analyze,transform,generate,compare}/page.tsx:1`, all of which therefore also target the `docs/*` submit routes, not the three GET routes.

| Endpoint | In-repo caller | Class | Verdict |
|---|---|---|---|
| `GET /api/v1/services` | **0** | docs-example only: `CLAUDE.md:158`; `app/api/swagger/route.ts:103`; rework `docs/06-public-api.md:29`, `docs/39-legacy-parity-contract.md:28` | **no real external consumer observable** |
| `GET /api/v1/billing/balance` | **0** | docs-example only: `CLAUDE.md:159`; `06b-api-spec-overview.md:65`; `06-public-api.md:29`; `39-legacy-parity-contract.md:29` | **no real external consumer observable** |
| `GET /api/v1/billing/usage` | **0** | docs-example only: `CLAUDE.md:160`; `06b:66`; `06-public-api.md:29`; `39:30` (rework has `/api/v1/usage*`, a **different shape**) | **no real external consumer observable** |
| rework equivalents | n/a | **dead reference**: two independent rework docs state the routes **do not exist** — `06-public-api.md:29` "Chưa implement" and `39:28-30` "không có route" | rework has **no** counterpart to call |

**What "no in-repo consumer" does and does not mean.** It is an observed fact about this workspace, stated as such. It is **not** evidence that no external consumer exists: an SDK, an ops script, a partner integration or a production access log lives outside the tree. I did not run the app, measure traffic, or read operational logs, so the **usage column is NOT OBSERVED**, not "unused". That distinction is the decision-relevant part for Q15, and I am not collapsing it.

## 3. Test-only and docs-example counts

| Class | `/services` | `/billing/balance` | `/billing/usage` | `webhook_url` / callback |
|---|---|---|---|---|
| test-only callers | 0 | 0 | 0 | 0 |
| docs-example references | 3 | 4 | 4 | 6 |
| dead references (route named where none exists) | 2 | 2 | 2 | 0 |
| in-repo UI consumers | 0 | 0 | 0 | 0 |

The three GET routes have **zero callers of any class**; every mention is either documentation or a reference to a route that does not exist on the rework side.

## 4. Webhook / callback — the axis that inverts

The other three endpoints are *inbound*: an external client calls the platform. Webhook is the opposite — **the platform is the producer and the consumer is external by definition**, so a repo scan can never find a webhook consumer. The in-repo surface is the *outbound chain* plus whatever sets the field.

| Stage | Fixture | Class |
|---|---|---|
| reads the form field | `lib/endpoints/runner.ts:227` | producer entry |
| carries it to submit | `runner.ts:242`; `lib/pipelines/submit.ts:45,81` | producer |
| persists it | `submit.ts:309`; column `lib/db/schema.ts:35` | producer |
| fires on terminal state | `lib/pipelines/engine.ts:428,430,467,469` (SUCCEEDED and FAILED) | **real outbound `fetch`** at `engine.ts:75` |
| workflow terminal path | `lib/pipelines/workflow-engine.ts:297,307,315` — `fetch(ctx.webhookUrl)` | **real outbound** |
| per-node callback action | `lib/workflow-builder/real-exec.ts:145` — `fetch(url, init)` | **real outbound** |
| in-repo client that **sets** `webhook_url` | **0** — `ServiceTestClient.tsx` appends only `k`/`source_file`/`target_file`/`files[]` (`:189,197,201,206`) and has 0 webhook occurrences | none |
| docs-example | `docs/API_PROFILES_SPEC.md:35,546`; `docs/DU_INTEGRATION_GUIDE.md:21`; `docs/workflow-schema-guide.md:224,541`; `lib/pipelines/workflows/README.md:347`; `docs/API_DESIGN_PROPOSAL.md:662` | 6 |

**Two observations that change how this should be read.**

1. **`lib/pipelines/workflows/README.md:347` documents a field the handler never reads** — it shows `-F "webhookUrl=…"` against `POST /api/v1/docs/workflows`, and that route copies only registry-declared variables (`workflows/route.ts:36-41`). Legacy reads the **snake_case** `webhook_url` (`runner.ts:227`). A client following that README gets no webhook and no error. This is already registered as `CM-E1` in my consolidate register; it is re-stated here because it is the single most likely way a real external consumer is silently broken.
2. **The demo client cannot exercise webhooks at all** — the only in-repo submit client sends four form fields, none of them `webhook_url` (`ServiceTestClient.tsx:189,197,201,206`). So webhook behaviour has **no in-repo exerciser**, which is why it is the one contract with a live producer and zero in-repo verification.

## 5. Rework side — decoder present, wire absent

**SUPERSEDED 2026-10-02 — see §9.1: the compat layer is now MOUNTED and the webhook decode IS on the request path. The analysis below reflects the earlier, unmounted state and is kept for the record.**

The webhook decoders **exist and are tested** in rework (`compat/legacy-wire-decoders.ts` — alias read at `:191`, `decodeCallback` at `:427-432`), which is why the prior receipt could reasonably call the decoder work done. But the compat layer is **not reachable from any request path**, and I verified the whole chain rather than the first hop:

| Hop | Finding |
|---|---|
| `server.ts` → any `compat` reference | **0** (my own grep) |
| `src/` → importer of `legacy-wire-decoders` | **1**: `compat/legacy-action-router.ts:59` |
| `src/` → importer of `legacy-action-router` | **0** — the only importer anywhere is its own test, `services/orchestrator/tests/legacy-action-router.test.ts:14` |

So the chain terminates in a test. Decoded webhook handling is **written, tested, and dead on the wire** — an in-repo usage count of **0**, identical to the three GET routes, but for a completely different reason: those three have no caller, this one has no mount.

Independently corroborated by three rework docs: `tasks/CODE-REVIEW-FIXES-2026-10-01.md:45` ("không được import/mount trong `server.ts`"), `tasks/API-COMPAT-DUGATE-2026-09-28.md:104` (`grep "compat/" server.ts` → 0 hit), and `reports/tester.md:12191`.

## 6. Verdict per endpoint

| Endpoint | Real external consumer | Basis | Rework route |
|---|---|---|---|
| `GET /api/v1/services` | **NOT OBSERVED** — 0 in-repo callers, and external usage is unobservable from here | §1–§3 | **none** |
| `GET /api/v1/billing/balance` | **NOT OBSERVED** — same | §1–§3 | **none**, and it also needs a `spending_limit` column (`39-legacy-parity-contract.md:321` "CẦN MIGRATION") |
| `GET /api/v1/billing/usage` | **NOT OBSERVED** — same | §1–§3 | **none**; `/api/v1/usage*` is a different shape (`39:30`) |
| `webhook_url` (submit field) | **cannot be observed** — producer-side contract; consumer is external by definition | §4 | decoder exists, **unmounted** |
| callback node | **cannot be observed** — same | §4 | same layer, unmounted |

~~I deliberately do **not** recommend `defer` or `retire`.~~ **Superseded — see §9.** I originally declined to adjudicate unilaterally because the disposition is COMP-00's to make. On explicit instruction I now issue the recommendation in **§9**, keeping it separate from the observation in §1–§6 so a reader can accept the evidence while rejecting the call, or the reverse.

## 7. What this receipt adds to Mục 53, and what it does not

**Adds (four items not in the prior receipt):**

1. **The alternate-transport sweep** (§1) — axios / `XMLHttpRequest` / `sendBeacon` / `WebSocket` appear only in lockfiles, so the `fetch`-based scan is provably complete for in-repo callers. Without this, "1 hit for `fetch(`" would not rule out a consumer on another transport.
2. **`ServiceTestClient` has 0 webhook occurrences** and appends exactly four fields, so the demo cannot set a webhook — meaning webhook has no in-repo exerciser at all (§4.2).
3. **The unmount chain verified to its end** (§5): prior work established `server.ts` → 0 `compat` references and one importer; I followed the next hop and found `legacy-action-router` is imported **only by its own test**, so the chain provably terminates there.
4. **A consumer-side corroboration of the two-envelope finding.** `ServiceTestClient.tsx:225` reads `data.detail ?? data.error ?? data.title` — a real in-repo client already defensive across both error conventions, which is independent support for `CM-D4` from the consuming side rather than the producing side.

**Does not add:** any new consumer and any usage measurement. **It now also adds a disposition (§9)**, added on instruction after §1–§8 were written and verified; the evidence underneath it is unchanged from the re-run.

## 8. Limits

- **Read-only.** No file modified; the only file written is this receipt. No gate ticked, no commit, no message to `nocobase-10`.
- **No infra.** No suite run, no DB window claimed, no `npm install`, no traffic measured, no operational log read.
- **Externally unobservable by construction.** SDKs, ops scripts, partner integrations and production access logs are outside this tree. Every "no consumer" statement is scoped to the workspace and is marked NOT OBSERVED in §6 rather than asserted as unused.
- **No security reproduction.** The `!`-flagged items from the parent slices (`x-api-key-id` self-declared, ADMIN fallback, list-no-resolve, plaintext fallback, fake `CANCELLED`) are relevant to *who may call* these routes but are not re-analysed here.
- **Scans are point-in-time** and the legacy tree is not committed cleanly across lanes, so a hit set computed today is the best available and not a durable fact.

## 9. Disposition recommendation

> **Provenance.** Added after §1–§8 were written and verified, on explicit instruction. I had declined to adjudicate unilaterally because the disposition is COMP-00's. The evidence in §1–§6 is unchanged by this section; only the call is new. **This is a recommendation, not a decision** — no COMP row, gate or plan entry is touched here.

### 9.1 The three GET routes → **DEFER** (do not build now, do not retire)

| Step | Basis |
|---|---|
| They are live public contract, owned by `COMP-00..11` | `tasks/ORCHESTRATOR-FEATURE-PARITY-BOUNDARIES-2026-10-01.md:7` names `/api/v1/services` and `/api/v1/billing/*` as external-contract surface |
| In-repo caller count is **0** across every class and every transport | §1, §2, §3 |
| So **not building them carries zero in-repo regression risk** | nothing in this workspace can break |
| But their consumers are, by construction, outside this tree | §8 — SDKs, ops scripts, partner integrations, access logs |
| Therefore retiring is an irreversible act on a contract whose usage I cannot observe | §6 marks usage **NOT OBSERVED**, not "unused" |
| Cost is asymmetric | **defer** costs nothing — no code, decision stays open, COMP-08 keeps ownership. **wrongly retiring** silently breaks a live external integration |

**Why not the alternatives:** not *retire* — that needs the evidence I just said I do not have. Not *build now* — with zero observed consumers there is no demonstrated internal payoff, and `/billing/balance` additionally needs a `spending_limit` column that does not exist (`39:321` "CẦN MIGRATION"), so "build" is not one unit of work.

**Defer must not become "never decide".** It carries a decision-forcing condition — close it on the **first** of: (a) gateway/access-log hits on the three paths, which makes it a COMP-08 build; (b) a named consumer or partner integration list, which scopes it to those callers; (c) a dated owner confirmation that no external client uses them, which makes retire safe. Absent one of those, the status stays *deferred*, not *closed*.

### 9.2 Webhook and callback → **PARITY, bundled into the compat mount, not standalone**

| Step | Basis |
|---|---|
| Webhook is **running capability today**, not a speculative contract | real outbound `fetch` on terminal state: `engine.ts:428,467` (SUCCEEDED/FAILED) and `workflow-engine.ts:307`; callback node `real-exec.ts:145` |
| Removing it removes capability a customer may already depend on | unlike the three GET routes, there is no evidence of disuse — there is evidence of **use** |
| Marginal build cost is low | decoder exists, is aliased, and is tested (10 tests per Mục 54) |
| But the decoder is **unmounted**, so standalone parity is meaningless | §5 — the chain ends in a test |

**The unit of work is the compat mount, not a webhook milestone.** Mục 54 already scoped the mount. Webhook parity should ride inside that workstream rather than becoming its own line with its own acceptance — because the exact failure mode already on record is a green decoder/router suite being read as wire coverage (`tasks/CODE-REVIEW-FIXES-2026-10-01.md:45`: unit tests passing does not demonstrate ingress, auth, upload encryption, admission, dispatch or response). **A webhook acceptance that is satisfied by decoder unit tests is not parity and should be rejected as such.**

### 9.3 One cheap item, for the owning lane rather than me

`lib/pipelines/workflows/README.md:347` documents `-F "webhookUrl=…"` against a route that reads only snake_case `webhook_url` (`runner.ts:227`). A client following that README gets **no webhook and no error**. This is `CM-E1`. It is a documentation-only fix with near-zero cost and it is the single most likely way a real external consumer is already broken. I am flagging it rather than editing it — `lib/` is outside my lease.

### 9.4 What would falsify each recommendation

| If this turns out to be true | Then |
|---|---|
| Out-of-repo evidence shows active external consumers of the three GET routes | **defer → build** under COMP-08, and `/billing/balance` needs the column migration first |
| A dated owner statement that no external client uses them | **defer → retire**, and the routes can be dropped from the parity contract |
| Product confirms customers poll only and never set a webhook | **webhook parity → optional convenience**, and it can be descoped from the mount |
| The compat layer is deliberately not being mounted this release | webhook stays **unimplemented**; say so explicitly rather than leaving it "ready" |

### 9.5 Confidence and what this section is not

- **High confidence** in the in-repo facts (§1–§6): caller counts are 0 across all classes and transports, and the unmount chain is verified to its end.
- **No confidence claim about external usage**, in either direction. That is the whole reason the three routes are deferred rather than retired.
- This section **does not** tick a gate, change a COMP row, edit `tasks/*.md`, freeze a contract, or authorise implementation. COMP-02..09 remain blocked pending COMP-00, and the compatibility contract remains unsigned.
- If the owner holds out-of-repo evidence, it overrides everything above. My input is the workspace, and only the workspace.

## 9. CORRECTION 2026-10-02 (later the same day) — the compat mount is now LIVE; §5 and §9.2 were overtaken by concurrent work

> **This supersedes §5 and changes the standing of §9.2.** I found it while verifying a different follow-up, not while re-checking this receipt — which is exactly how a point-in-time scan goes stale. §1–§4 and §6–§8 are unchanged; the two statements below are corrected in place and the reason is recorded.

### 9.1 What §5 said, and why it is no longer true

§5 reported, from my own greps, that the compat layer was **not reachable from any request path**: `server.ts` → 0 `compat` references, one importer, and `legacy-action-router` imported only by its own test — "the chain provably terminates in a test".

**That was accurate when measured and is false now.** Re-checked 2026-10-02:

| Claim in §5 (measured 2026-10-02 morning) | State now | Citation |
|---|---|---|
| `server.ts` has **0** `compat` references | `server.ts:69` imports `handleLegacyRoute`; `:70` imports `legacyCompatHost` | `server.ts:69-70` |
| compat is imported but never called | **called** at `server.ts:1751`; `legacyCompatHost(ctx)` supplied as the host at `:1764` | `server.ts:1751,1764` |
| webhook decode is off the mounted path | **it is on it** — `legacy-http-mount.ts:32` imports `decodeLegacyWire`, and `legacy-wire-decoders.ts:191-193` reads `webhook_url`/`webhookUrl` and calls `decodeCallback` | `legacy-http-mount.ts:32`; `legacy-wire-decoders.ts:191-193` |

A new compat layer landed in the workspace while this receipt was being written: `legacy-http-mount.ts`, `legacy-form-bridge.ts`, `legacy-multipart.ts`, `legacy-envelope.ts`, `legacy-host-adapter.ts`, `legacy-public-artifact.ts`, with tests, plus `migrations/0024_legacy_parity_columns.sql`.

### 9.2 What this does and does not fix

**Fixed:** the "decode is dead on the wire" claim. The mount is live, multipart is parsed by the mount, and the legacy 31-variant allow-list in `legacy-wire-decoders` is now actually consulted on a request path — which was the whole point of that allow-list and the reason I refused to treat decoder unit tests as wire coverage in §9 of my consolidate receipt.

**Still unverified, and I will not claim it:** whether a decoded `callback.url` is then **persisted and delivered**. The decode leg is reachable; the send leg is a further hop I have not traced. Legacy's producer chain (`engine.ts:428,467`, `workflow-engine.ts:307`) is real and wired; whether the mounted rework path writes that URL anywhere durable is unconfirmed.

**Consequence for my own §9.2 recommendation.** It said bundle webhook parity into the compat mount, because a standalone parity line is meaningless while unmounted. The mount has now happened, so that reason is spent, and the recommendation becomes narrower and more specific:

> **Webhook parity — restated 2026-10-02.** The decode leg is mounted. Before anyone declares webhook parity, the question is no longer "is the decoder mounted" (it is) but **"does a decoded `callback.url` reach a delivery path on the mounted route"** — one hop, from `legacy-wire-decoders.ts:193` forward. That hop is the whole remaining question, and it should be answered by reading the mounted path, not by the decoder tests.

**The three GET routes are unaffected.** No `legacy-public-services` or billing route appears in the mount, and `du-rework/docs/06-public-api.md:29` still marks all three not implemented. The §9.1 DEFER recommendation stands unchanged.

### 9.3 The lesson, since I am the one who was wrong

§8 already said "scans are point-in-time and not a durable fact", and §6 marked usage **NOT OBSERVED** rather than *unused*. Both hedges were right, and I still wrote a §5 conclusion in the present tense that a reader could reasonably act on within the hour. A characterization of whether code is **reachable** ages fastest of anything in this report set — faster than consumer counts, because mounting is exactly the kind of work several lanes are doing concurrently.

**I am not rewriting §5.** The struck-through state and this correction are both left in place, because a reader who saw the original claim and the correction learns something a silently-edited document would hide: the claim was true when made, and the workspace moved.
