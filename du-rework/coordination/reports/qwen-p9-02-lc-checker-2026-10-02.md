# P9-02 — LC checker business workflow (implementation receipt)

> **Packet** user instruction 2026-10-02: migrate the legacy `lc-checker` business workflow into
> the du-rework architecture, creating a standalone business package if needed.
> **Write scope** `du-rework/businesses/lc-checker/**` (all new). Nothing outside it was created or
> edited; nothing outside `du-rework/` was touched.
> **Status** business logic, rule base, worker adapter, manifest, registration tool and the legacy
> wire adapter are implemented and green **offline**. NOT mounted on a route, NOT run against a
> queue, database or provider. See §7 and §8.
>
> **Read §10 first.** After this receipt was written, the owner authorised the connector-cap
> decision §9 had handed to them, and the examination was rebuilt from three stages to five
> (demand-driven two-pass visual verification). §1–§9 below are the ORIGINAL receipt and are
> left unedited as evidence; **where they describe the stage list, the test count (104), the
> connector-cap design or the file inventory, §10.4 supersedes them.** Current figures: 118
> tests, 3,553 source lines, 21 source files.

## 1. What was built

A standalone business package `@du/lc-checker` (2,951 lines of source across 21 files,
1,309 lines of tests across 7 files) implementing the three legacy stages as a versioned,
checkpointed workflow whose **rules base is data rather than prompt prose**.

| Area | Files | What changed vs the legacy |
|---|---|---|
| Continuation primitives | `primitives.ts` | `spawn-children` / `terminate` only, no `wait-for-input`: the legacy has no HITL and declaring an unemittable continuation is a promise the types do not keep |
| Rule base | `rules/rule-types.ts`, `rules-house.ts`, `rules-examinations.ts`, `rules-authorities.ts`, `rules-data.ts`, `rule-registry.ts` | The UCP 600 / ISBP 821 rules moved out of one prompt string into ~70 addressable, versioned, individually citable rules with provenance |
| Prompt rendering | `rules/prompt-builders.ts`, `rules/ocr-prompt.ts` | The compliance prompt is **derived from the registry**; a rule change is now a data diff |
| Validation | `validation.ts` | Rule citation, count consistency and verdict consistency are enforced. The legacy stored whatever the model said |
| Machine | `lc-checker.ts` | Multi-turn state machine, bounded fan-out, fail-closed policy, human sign-off in the result |
| Worker adapter | `worker.ts` | The only platform-aware file: TaskContext in, TaskDisposition out |
| Manifest + registration | `manifest.ts`, `registry-tool.ts` | Own businessId, own image, own queue, three-step register/enable/activate |
| Legacy wire | `legacy-facade.ts` | Pure adapter for `POST /api/v1/docs/workflows` (`process=lc-checker`) |

Stage flow: **ocr** (bounded fan-out, 1 child per document) -> **compliance** (sequential,
OCR text as primary data source plus as many originals as the connector cap allows) ->
**report** (sequential, from an already-validated result) -> terminate.

## 2. Acceptance — every item, honestly

| # | Item | Result |
|---|---|---|
| 1 | Business package created under `du-rework/businesses/` | **DONE** — `@du/lc-checker` |
| 2 | Rule base ported verbatim, versioned, marked PROVISIONAL | **DONE** — `ucp600-isbp821-v1`, provenance recorded |
| 3 | Own unit tests green, repeated runs, literal exit codes | **DONE** — 104 tests, 3 consecutive runs, exit 0 each |
| 4 | `tsc --noEmit` for src and tests | **DONE** — both exit 0 |
| 5 | No regression in the rest of the workspace | **DONE** — `document-core` `tsc` exit 0 (see §4) |
| 6 | Platform registration | **PARTIAL** — manifest + registration tool land; nothing registered against a live Orchestrator (§7 F1) |
| 7 | Legacy HTTP facade | **PARTIAL** — the adapter is done and tested; the route is NOT mounted (§7 F2) |
| 8 | Legacy UI `app/lc-checker/**` | **NOT DONE** — see §7 F3. `du-rework` contains zero UI files |
| 9 | This receipt | **DONE** |

## 3. Verification — literal, reproducible

All commands run from `du-rework/businesses/lc-checker`, Node 20, offline. No PostgreSQL,
Redis, S3 or Vault was used. No provider was called; every connector is an injected fake.

```
npx tsc --noEmit -p tsconfig.json        -> exit 0
npx tsc --noEmit -p tsconfig.test.json   -> exit 0

npx jest --runInBand   # run 1 -> exit 0    Test Suites: 6 passed, 6 total    Tests: 104 passed, 104 total
npx jest --runInBand   # run 2 -> exit 0    Test Suites: 6 passed, 6 total    Tests: 104 passed, 104 total
npx jest --runInBand   # run 3 -> exit 0    Test Suites: 6 passed, 6 total    Tests: 104 passed, 104 total
```

Exit codes were captured with delayed expansion (`cmd /v:on`), not inferred from output
markers. Test breakdown:

| Suite | Tests | Covers |
|---|---|---|
| `rules-registry.test.ts` | 18 | registry integrity, provenance, no duplicate ids, every rule id renders into the prompt, override still carries the identity block, incomplete visual verification is stated in the prompt |
| `validation.test.ts` | 17 | uncited / unknown rule, missing rule, count mismatch, COMPLIANT hiding a MAJOR or a MINOR, DISCREPANT with nothing, REJECT without MAJOR, RESERVE burying a MAJOR, duplicate ids, unknown severity, unknown ruleset, fenced JSON, garbage output |
| `lc-checker.test.ts` | 28 | input normalisation and identity rejection, bounded fan-out (ceiling, input order, one failure does not cancel siblings), the machine end to end, join-token mismatch, incomplete join, orphan join, all-children-failed, continue-on-partial, ruleset drift mid-flight, the COMPLIANT-with-unseen-documents refusal |
| `worker-manifest.test.ts` | 20 | manifest/slot/handler agreement, output-schema pinning, fan-out planning, artifact inlining, oversize refusal, joined delivery, redelivery replay, bad join shapes, cancellation |
| `registry-tool.test.ts` | 6 | register -> enable -> activate order and tokens, failure at each hop, dry run with no invented digests |
| `legacy-facade.test.ts` | 15 | 202 + Operation-Location, RFC7807 400/404, `apiKeyId` refusal, variable coercion, polling envelope, error envelope, progress bands |

## 4. Regression check on the rest of the workspace

`du-rework/businesses/document-core`: `npx tsc --noEmit -p tsconfig.json` -> **exit 0**.
The new package imports nothing from `document-core` and `document-core` imports nothing
from it, so the two businesses stay independently deployable.

**Not run:** the `document-core` jest suite. It has known pre-existing failures that predate
this work, and this packet changed nothing under `document-core/`, so I did not spend the
exclusive run window re-measuring another package. If a reviewer wants a same-session
baseline, that is a `VFY-*` packet, not part of P9-02.

## 5. Two real defects my own tests caught

Both were found by tests, not review, and both were in the product.

**Δ-P9-02-A — the state machine was never told where the previous turn ended.**
The worker handler called `advanceLcChecker` on the joined delivery without the state the
planning turn had produced, so the machine re-issued the fan-out and the join was silently
discarded; the handler then reported a meaningless "did not terminate". The workflow was
not multi-turn at all, it was two disconnected half-runs.

Fix: the planning turn is now PURE — it builds child specs and issues the join token and
calls no provider — so the joined turn recomputes it cheaply and advances the machine from
that state, all inside one `ctx.step.run` checkpoint keyed on `contentHash(normalizedInput)`.
The test `persists the machine state, so a redelivery replays the turn instead of
re-examining` asserts a second delivery returns an identical disposition with
`complianceCalls === 1` and `reportCallCount === 1`. The input hash is taken from the
NORMALISED input, never from `ctx.input`, because the joined delivery carries an extra
`joinSummary` and hashing the raw context would make one logical turn look like two and
defeat the replay.

**Δ-P9-02-B — the identity guard could never fire.**
`assertNoIdentityLeak` ran on the NORMALISED input, and normalisation copies only recognised
fields, so by the time the guard ran the offending key was already gone. A submission
carrying `apiKeyId` — the exact field the legacy used to borrow someone else's identity —
was silently accepted.

Fix: the guard now runs on the RAW record, before normalisation.
Test: `rejects client-supplied identity` covers `apiKeyId`, `api_key_id`, `userId`,
`tenantId`, `role` and `adminToken`, and asserts the `IDENTITY_FIELD_REJECTED` code.

A third defect was caught in the legacy adapter: legacy form variables arrive as strings, so
`maxConcurrency: "6"` was rejected by the strict normalizer. Coercion belongs in the wire
adapter, not the machine, and now lives there.

## 6. Deliberate differences from the legacy workflow

| Δ | Legacy | Here | Why |
|---|---|---|---|
| **Δ-P9-02-1** | `Promise.all` over every file — 200 files meant 200 concurrent OCR calls | bounded fan-out, ceiling `MAX_FANOUT_CONCURRENCY = 8`, clamped regardless of the request | P9-02 deliverable |
| **Δ-P9-02-2** | Rules base was one interpolated string; a discrepancy could cite "UCP 600 Art. 28" and nothing could check the article existed or still said what the run assumed | registry of ~70 citable rules; `ruleId` is REQUIRED and resolved; an unknown or missing rule fails the run | the P9-02 point: evidence, not prose |
| **Δ-P9-02-3** | The verdict was whatever the model returned | verdict and recommendation must follow the rules the examiner was given (VERDICT-*, RECO-*). COMPLIANT over a MAJOR is a FAILED run | a clean verdict must be derivable from the findings |
| **Δ-P9-02-4** | Nothing forced human review | `humanSignOffRequired: true` in the result **and** `const: true` in the output schema | the backlog refuses to let a prompt be a legal guarantee, and a type is harder to drop than a field |
| **Δ-P9-02-5** | `apiKeyId` from a form field, falling back to the oldest `role = ADMIN` key | identity is not in the input type; the guard refuses the field outright, and the legacy facade returns 400 | standing rule: do not copy legacy vulns |
| **Δ-P9-02-6** | `cancel` wrote `done=true, state=CANCELLED` while the worker kept running | terminal set is `SUCCEEDED` / `FAILED` only; the module never declares a cancellation | standing rule: no fake terminal state |
| **Δ-P9-02-7** | OCR errors were isolated and the run continued silently | `continue-on-partial` reproduces that but RECORDS every failed child in `failedChildren` and in `evidence.filesWithoutOcrText`; `fail-closed` refuses only when nothing at all can be read | a run that examined fewer documents than it was given must say so |
| **Δ-P9-02-8** (constraint found) | Compliance got every PDF attached | `@du/contracts` caps one invocation at 4 artifacts / 10 MiB; an LC set is 6-12 documents. The shortfall is recorded in `evidence.visualVerification` and **a COMPLIANT verdict is refused** when it is incomplete | see §9 |
| **Δ-P9-02-9** | No HITL | still no HITL. `wait-for-input` is NOT declared | the legacy has none, and an unemittable continuation is a lie the types do not catch |

## 7. Not done, not claimed

Each item is a hard blocker for running this for real, and each sits outside the write scope
I was given.

| # | Item | Why not mine |
|---|---|---|
| **F1** | Register the manifest against a live Orchestrator and activate it | needs a running platform; `registry-tool.ts` is written and unit-tested with a fake fetch, but no registration has been performed |
| **F2** | Mount `POST /api/v1/docs/workflows` (`process=lc-checker`) in the Orchestrator | `services/orchestrator/src/server.ts` has **no** such route today (its 12 `/api/v1/*` routes are health, usage x3, uploads, operations, admin x5). Adding it is a one-route change but `server.ts` is a separate lease, and the P9-01 receipt already lists host dispatch wiring as out of lease there. `legacy-facade.ts` is the tested, framework-free half of that work |
| **F3** | Migrate the legacy UI `app/lc-checker/**` | **Not possible as stated.** `du-rework` contains **zero** `.tsx`, `.jsx`, `.vue` or `.html` files — it is a services + packages + businesses monorepo with no UI surface. Adding a Next.js page inside it would contradict that architecture, and the UI is listed as a product decision in `docs/01-product-scope.md`. The legacy page stays where it is until a UI surface is decided. |
| **F4** | Domain-owner sign-off on the criteria and the rules base version | P9-02 acceptance requires it. Every rule is a verbatim port, so nothing was invented — but "ported" is not "confirmed", and the status ships as `PROVISIONAL` until an owner signs it. **This is the single most important open item.** |
| **F5** | Live E2E: real queue, database, artifact store, connector | impossible until F1-F2 land. Nothing here has been seen working against any of them |
| **F6** | Confirm the join contract | the handler reads `ctx.input.joinSummary` exactly as `example-review` does (`review.ts:837`), which carries the same caveat: the authoritative typed continuation contract is still owned by the platform lane. This adapter accepts an inline `data:` reference and refuses a bare `artifactId` rather than guessing |
| **F7** | Golden synthetic corpus for the rules base | needs domain-owned sample document sets. The registry and its prompt rendering are tested for completeness; the examination QUALITY is untested and unmeasurable until there is a corpus with expected findings |

**No gate ticked. No contract frozen. No commit, no push.** The working tree carries other
lanes' uncommitted work and I touched none of it.

## 8. Honest four-level status

| Level | P9-02 |
|---|---|
| `SPECIFIED` | **Yes** for the workflow shape and the acceptance; **no** for the criteria themselves, which await a domain owner |
| `IMPLEMENTED` | **Yes** — code complete, `tsc` clean src + tests, 104 offline unit tests green 3x |
| `VERIFIED` | **No** — no independent Tester has run this; only my own suite |
| `ACCEPTED` | **No** — no Claude Code review verdict |

## 9. The one finding worth escalating

`@du/contracts` caps a connector invocation at `CONNECTOR_ARTIFACT_MAX_COUNT = 4` and
`CONNECTOR_ARTIFACT_MAX_BYTES = 10 MiB` (`packages/contracts/src/connector.ts:8-9`), and
content is carried INLINE, not by reference. A documentary credit set is routinely 6-12
documents and routinely larger than 10 MiB in total. The compliance examination cannot
therefore see every original in one call, and the rules base depends on visual verification
of signatures, stamps and endorsements (PROC-3.2, CHK-TRANSPORT, UCP 600 Art. 17/20/22/23).

The design answer taken here was: OCR text is the primary data source (the legacy rules base
already says so), originals are attached up to the cap, the shortfall is recorded in
`evidence.visualVerification`, and a `COMPLIANT` verdict is refused when the verification was
incomplete. ~~That is sound but it is a product-level decision about a document set that is
larger than the platform can examine in one step, and a batching or multi-pass examination
design may be the better answer. It is F-NEW, not mine to decide.~~
**Superseded — see §10.** The owner authorised the call on 2026-10-02 and it was taken: the
examination is now split, not capped-and-abandoned. §1–§9 are unchanged above; §10 records the
ruling and what was rebuilt.

## 10. Ruling on the connector cap — demand-driven two-pass examination

> **Provenance.** Added on the owner's explicit instruction, 2026-10-02 ("hãy tự làm theo
> suggestion"), after §9 handed this call to them. Sections 1–9 above are the original
> receipt and are unchanged; this section supersedes only the §9 deferral. A reader may accept
> the evidence in §1–§9 and reject this ruling independently.

### 10.1 The call

**Adopt demand-driven visual verification, not blanket batching.** The examination becomes
five stages:

1. `ocr` — bounded fan-out, one child per document (unchanged).
2. `screen` — sequential, **text only**. States which rules the OCR text cannot settle, each
   as `{document_index, purpose, rule_ids}`. No original is attached, because a pass whose job
   is to report what is missing must not be able to peek.
3. `visual` — bounded fan-out, one child per requested check, under the same ceiling. The
   child renders **only the rules that check cites**, which is what keeps it affordable.
   Skipped entirely when screening asks for nothing, so a clean set still costs one
   examination rather than two.
4. `adjudicate` — sequential. Rules base over the text, every digest, the screening notes, and
   the explicit list of questions nobody answered. The only stage that may produce a verdict.
5. `report` — sequential, from an already-validated result (unchanged).

### 10.2 Why not the alternatives

| Option | Why rejected |
|---|---|
| **A. Attach up to the cap, refuse `COMPLIANT` otherwise** (§9's design) | Makes a clean verdict **structurally unreachable** for any set over 4 documents. A checker that can only ever say RESERVE is not a checker. It is safe and useless. |
| **B. Batch the whole set, N calls, merge** | UCP 600 examination is inherently global (CL-2 runs a two-phase analysis over the whole document set; GĐ3 cross-checks container numbers, weights and consignee across documents). Batching fragments that context, and multiplies provider cost N-fold on every run, including runs that needed one look. |
| **C. Demand-driven two-pass (chosen)** | Cost is proportional to what actually needs eyes, not to set size. Global context is preserved because both passes see the whole text. A clean set costs one examination. |
| **D. Ask the platform to lift the cap** | Not a whim: 10 MiB inline is a transport and memory bound. It is an ADR for the platform lane, and it cannot be a prerequisite for shipping this business. |

### 10.3 The three properties that make C sound — enforced, not documented

| # | Property | Enforcement | Test |
|---|---|---|---|
| 1 | A visual check must cite a rule that exists, and the round is bounded | `validateScreenResult` resolves every `rule_ids` entry against the registry and refuses above `MAX_VISUAL_REQUESTS = 24` | `refuses a screening pass that asks for a check with no rule behind it` |
| 2 | The host cannot declare its own work complete | `visualVerification` is computed **in the machine** from the digests it holds; the `adjudicate` port returns the payload only and has no field to report completeness through | `refuses a COMPLIANT verdict when a screening question is still unanswered` |
| 3 | A gap is visible, not absorbed | Unanswered checks land in `result.outstandingVisualChecks` and the adjudication prompt is told "You may NOT return COMPLIANT" | `names the unanswered questions in the result instead of hiding them` |

Visual inspection is bound to its own `vision` connector slot, separate from `ocr`. Reading a
signature off a scan is a different capability from transcribing text, and binding both to one
provider would quietly downgrade the visual pass to whatever the text engine happens to do.

### 10.4 What the rebuild cost, honestly

- Workflow now spans up to **three deliveries**. The machine's state is persisted by the worker
  as an INTERMEDIATE artifact named `lc-checker-state-<operationId>.json` — a handler cannot read
  a step checkpoint's payload back, and a deterministic name means any delivery of the same
  operation finds its own state without a lookup. Persisted **before** the children run, because
  the pending join token is what tells the next delivery which round is coming back.
- A join is now matched by **stage**, not just by token: `pendingStage()` resolves which fan-out
  is outstanding, and a join arriving for the wrong round is refused rather than re-planned.
- A task key the platform did not return becomes an explicit FAILED outcome, so a short round is
  a recorded gap instead of a silently smaller examination.
- Suite grew from 104 to **118 tests**; source 2,951 -> 3,553 lines, tests 1,309 -> 1,645.

Re-verified after the rebuild, same method as §3:

```
npx tsc --noEmit -p tsconfig.json        -> exit 0
npx tsc --noEmit -p tsconfig.test.json   -> exit 0
npx jest --runInBand   # run 1 -> exit 0    Test Suites: 6 passed, 6 total    Tests: 118 passed, 118 total
npx jest --runInBand   # run 2 -> exit 0    Test Suites: 6 passed, 6 total    Tests: 118 passed, 118 total
npx jest --runInBand   # run 3 -> exit 0    Test Suites: 6 passed, 6 total    Tests: 118 passed, 118 total
```

Per-suite after the rebuild: `lc-checker` 35, `worker-manifest` 24, `rules-registry` 21,
`validation` 17, `legacy-facade` 15, `registry-tool` 6 = **118**.

### 10.5 What would flip this call

| Falsifier | Consequence |
|---|---|
| Screening over-requests (say > 8 checks on a 6-document set) on a real corpus | The cap is doing its job, but the *prompt* is not. Tighten the screening instruction, or go back to batching. |
| The adjudication degrades because it no longer sees the documents itself | Property 2 was the wrong trade. The fix is a third pass, not a weaker refusal. |
| Provider cost per run roughly doubles versus the §9 design on small sets | The extra examination only pays off if checks are actually requested. If real sets rarely need any, delete stage 2 and keep a single capped pass. |
| A domain owner rules that every document must be visually inspected in full | Then this is wrong by construction and §9's refusal was the honest answer. **This is the one falsifier that can only be settled by F4.** |

### 10.6 Decision-forcing condition

Re-open this ruling when **F7** (a golden LC corpus with expected findings) exists. Until there is
a corpus, the quality of the examination is unmeasured and this ruling is sound-but-unproven in
the only way that matters: structurally correct, empirically untested. F4 (domain-owner sign-off)
does NOT block it — the rules base is unchanged, only the order the examination reads them in.

