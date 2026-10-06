# MISMATCH report — settings prompt-slot namespace (dsh_2, 2026-10-05)

**Raised by:** dsh_2 (`term_bac0ad06`) during a self-audit after `BFF-SETTINGS-IDENTITY`.
**Severity:** **MEDIUM (contract naming)** — downgraded from my first assessment of HIGH after I measured the actual failure mode. It does NOT break a running path today because the upstream platform handler does not exist yet (§4). When the platform route lands, a mismatch produces a **loud 502**, not silent corruption (§4b, PROBE-A/D). Still must be fixed before the wire is frozen — the read would simply be dead on arrival — but it is a scheduled fix, not an emergency.
**Action taken:** none — reported, not fixed. See §5 for why.

## 1. The conflict, precisely

Two namespaces for the same five prompt-default slots, authored independently:

| Source | Slot names |
|---|---|
| **Spec (authoritative)** `tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md:65-69` + the UI catalog derived from it | `image`, `pdf`, `docx`, `compare`, `generate` |
| **My contract** `packages/contracts/src/settings.ts:53-68` | `extract`, `analyze`, `transform`, `generate`, `compare` |

**expected** (spec §3): `promptDefaults.{image,pdf,docx,compare,generate}`
**actual** (my code): `promptDefaults.{extract,analyze,transform,generate,compare}`

Two of five slots (`compare`, `generate`) coincide by accident. The other three are a genuine mismatch: **there is no `image`, no `pdf`, no `docx` slot in my schema, and no `extract`/`analyze`/`transform` slot in the spec.** A caller reading `promptDefaults.pdf` gets `undefined`; a caller that trusts the spec and writes `promptDefaults.docx` is rejected by `.strict()`.

## 2. Which one is right, and why mine is wrong

**The spec is right. My contract is wrong.** Two independent reasons:

1. **The spec is the stated source of truth for behaviour**, and it is explicit and per-slot reasoned (`§3`, lines 65-69: *"Publish→DOCX consumer; rollback"*, *"không dùng nhầm image slot"* — do not confuse the image slot). That is an acceptance-level decision about consumers, not an incidental naming.
2. **The legacy contract it preserves is file-type-scoped.** The legacy keys are `ai_image_prompt`, `ai_pdf_prompt`, `ai_docx_prompt`, `ai_compare_prompt`, `ai_generate_prompt` (parity task `:65-69`, and identically `apps/admin-web/src/features/settings/catalog.ts:44-48`). DUGate's public API exposes six *endpoints* (`ingest/extract/analyze/transform/generate/compare`) but its prompt defaults were keyed by *input file type*, which is a different axis. My contract collapsed the endpoint axis onto the prompt axis — I assumed "one prompt per prompt-bearing service" and never checked the legacy keys, which the spec had already enumerated.

I introduced this error in `BFF-SETTINGS-IDENTITY`. The packet told me to model "5 prompt-default slots" but did not name them; I inferred the names from the endpoint list instead of reading the spec first. That was my process failure, and the fix belongs to whoever owns the final wire freeze.

## 3. Exact seams for the owner

| File:line | Current | Should become (per spec) |
|---|---|---|
| `packages/contracts/src/settings.ts:53-59` | `SETTINGS_PROMPT_SLOTS = ['extract','analyze','transform','generate','compare']` | `['image','pdf','docx','compare','generate']` |
| `packages/contracts/src/settings.ts:62-68` | `SettingsPromptDefaultsSchema { extract, analyze, transform, generate, compare }` | `{ image, pdf, docx, compare, generate }` |
| `packages/orchestrator/…/bff/settings.ts` (narrowing `SettingsReadSchema`) | no change needed — it parses through the schema | no change |
| `apps/admin-web/src/features/settings/catalog.ts:44-48` | already file-type-named ✅ | already correct — no change |
| `apps/admin-web/src/features/settings/catalog.ts:9-12` | comment: *"packages/contracts has no Settings schema at all"* | **now stale** — a Settings schema exists (mine). Must be reworded once names are frozen. |

Test impact: the settings DTO fixtures in `services/orchestrator/tests/bff-settings-identity.test.ts` build prompt-default objects keyed by `extract/analyze/transform`; they must be re-keyed alongside the schema, otherwise the narrowing tests will fail closed (which is the correct behaviour, but it is a test break, not a silent pass).

## 4. Blast radius — MEASURED, not assumed

I initially wrote a failure-mode analysis here from reading the schema. **I was wrong, and I checked it rather than shipping the guess.** Corrected findings, from a probe run against the real `SettingsReadSchema` (`packages/contracts/tests/probe-mismatch.test.ts`, literals in §4b):

- **Runtime impact today: none.** No platform handler exists (`http/routes/admin.ts` — the only `settings` hit is a comment at `:673`), so there is no producer to disagree with. Confirmed by the previous receipt.
- **A namespace mismatch fails CLOSED.** Both the full-spec case (`{image,pdf,docx,compare,generate}`) and the partial-overlap case (`{compare,generate}` only) are **rejected** (`success: false`) → the BFF's narrowing turns them into a `502 UPSTREAM_ERROR`. That is the safe outcome, and it means wiring the platform route against the current schema will produce a loud, obvious 502 rather than silent corruption. Good news: **this is a loud defect, not a silent one**, and it cannot corrupt prompts in a live deployment.

### 4b. Probe evidence (literal)

```
PROBE-A success: false   // full spec-shaped slots {image,pdf,docx,compare,generate}
PROBE-D success: false   // partial overlap {compare,generate} — the 2 coinciding slots
PROBE-C success: true    // my slots present but EMPTY strings
PROBE-C promptDefaults: {"extract":"","analyze":"","transform":"","generate":"","compare":""}
```

### 4c. The one real fail-open: empty strings

My original note claimed a mismatch would degrade to empty strings. That is **true only when the upstream sends my five slot names with empty values** (PROBE-C) — which is not what a spec-following platform will send, so it is not the scenario I originally described. The empty-string case IS a genuine fail-open: `z.string()` accepts `''`, so an upstream that populates the slots with blanks would reach the browser as "configured defaults" that are empty.

**Correction to my own claim:** the namespace mismatch fails closed (A, D). The fail-open is narrower and separate: bare `z.string()` on the five slots. Both findings are fixed by the same one-line change in §7 item 2, so the decision below is unaffected in substance.

## 5. Why I did not just fix it

The rule from the packet and from standing coordination policy is: **do not edit a file held by another lane; report the seam with `file:line` and let the coordinator route it.**

- `packages/contracts/src/settings.ts` is **mine** under lease A7, so I *could* edit it.
- But the correct slot names are a **contract-freeze decision** affecting a spec (`ADMIN-LEGACY-CONFIG-PARITY`), the UI catalog, and the future platform route across at least two lanes (policy/document-core own prompt consumers; a platform lane will implement the route). Renaming a contract on my own authority, in the same turn I discovered my own error, without the coordinator acknowledging the finding, is exactly the kind of unilateral contract change the coordination model exists to prevent — and if the coordinator later decides the file-type axis should instead be modelled as *both* axes (a real possibility: `image`/`pdf`/`docx` are file types, `extract`/`analyze`/`transform` are endpoints, and a deployment may want either granularity), a fast unilateral rename would create a second churn cycle.

So: **finding raised, seams reported, decision left to the coordinator.** This is a deliberate hand-back, not an oversight.

## 6. Related observation (not a mismatch, no action)

`SettingsStorageSchema.ttlSeconds` (presigned-URL TTL, seconds) and `SettingsCacheRetentionSchema.retentionDays` are two different durations. The parity catalog expresses the storage row as `retentionPolicy.cacheTtlHours` (`catalog.ts:56`). The **unit** differs (seconds vs hours) but these are plausibly genuinely different concepts (presigned URL lifetime vs cache retention), so I am *not* claiming a mismatch here — I am flagging the unit gap so the contract-freeze decision covers both slots at once rather than fixing one and discovering the other later.

## 7. What the coordinator needs to decide

1. **Slot namespace:** adopt the spec's `{image,pdf,docx,compare,generate}`, or model a dual axis. → whoever owns the settings contract freeze. **Non-urgent:** §4b proves a wrong choice produces a loud 502 at integration time, not silent corruption.
2. **Prompt-slot validation (worth doing regardless of #1):** change the five slots in `SettingsPromptDefaultsSchema` from `z.string()` to `z.string().min(1)` so the empty-string case (PROBE-C) fails closed instead of publishing blank defaults. This one is independent of the naming answer and closes the only real fail-open in this DTO.
3. **Stale comment** at `apps/admin-web/src/features/settings/catalog.ts:9-12` once the schema is final.

The probe file `packages/contracts/tests/probe-mismatch.test.ts` was created to produce §4b and is **scratch** — delete it or fold PROBE-A/D into the real suite; it asserts nothing. No product source was modified to produce this report.
