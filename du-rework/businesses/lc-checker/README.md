# @du/lc-checker

Letter of Credit document-set checker (P9-02). Takes a submitted LC document set,
OCRs it under a bounded fan-out, examines it against a versioned UCP 600 / ISBP 821
rules base, and returns a report in which **every discrepancy cites a rule that exists**
in that rules base.

This is a standalone business package with its own manifest, image and queue. It does not
live inside `document-core`: the rules base is trade-finance domain content, not document
understanding, and folding it into the 6-action core manifest would have put a
trade-finance rule set behind a document-variant registry.

## What it is not

It produces an **examination**, not a legal determination. Every result carries
`humanSignOffRequired: true` and the ruleset it was examined against, and the ruleset
status is `PROVISIONAL` until a domain owner signs the criteria. This is deliberate:
P9-02 was opened precisely because the legacy workflow treated a prompt as if it were a
guarantee.

## Layout

| Path | Role |
|---|---|
| `src/primitives.ts` | Typed continuations (`spawn-children` / `terminate`). No interpreter, no eval. |
| `src/types.ts` | Versioned input / state / evidence / port schemas. |
| `src/rules/rule-types.ts` | Rule and rule-set types. |
| `src/rules/rules-house.ts` | Meta-rules, core logic, exclusions, sequential procedure. |
| `src/rules/rules-examinations.ts` | Per-document checklists, enforcement mechanism, severity bands, triggers. |
| `src/rules/rules-authorities.ts` | UCP 600 articles and ISBP 821 paragraphs. |
| `src/rules/rules-data.ts` | Composes the registry and its provenance. |
| `src/rules/rule-registry.ts` | Lookup by version and by rule id. |
| `src/rules/prompt-builders.ts` | Renders the compliance prompt **from** the registry. |
| `src/rules/ocr-prompt.ts` | Step 1 OCR instruction. Not a rule, so it has no authority. |
| `src/fanout.ts` | Bounded fan-out with a hard ceiling. |
| `src/validation.ts` | Rule citation, count and verdict consistency checks. |
| `src/lc-checker.ts` | The state machine. Knows nothing about HTTP, queues or providers. |
| `src/legacy-facade.ts` | Pure adapter for the legacy `POST /api/v1/docs/workflows` wire. |
| `src/worker.ts` | TaskContext in, TaskDisposition out. The only platform-aware file. |
| `src/manifest.ts` | Business manifest. |
| `src/registry-tool.ts` | Three-step register / enable / activate. |

## The five stages

1. `ocr` — bounded fan-out, one child per document, ceiling `MAX_FANOUT_CONCURRENCY = 8`.
2. `screen` — sequential, **text only**: works from the recovered OCR and states which rules
   the text cannot settle, naming the document, the question and the rule ids it serves.
3. `visual` — bounded fan-out, one child per requested check, only rules that check cites in
   its prompt. Skipped entirely when screening asked for nothing.
4. `adjudicate` — sequential: the rules base over the text, every digest, the screening notes
   and the explicit list of questions nobody answered. The only stage that may produce a verdict.
5. `report` — sequential, rendered from an already-validated compliance result.

The workflow has **no** human-in-the-loop pause, because the legacy had none. Adding a
`wait-for-input` continuation that nothing emits would be a promise the type system does
not keep, so the sign-off requirement lives in the result instead.

## Why the examination is split in two

`@du/contracts` caps one connector invocation at **4 artifacts and 10 MiB total**, with the
content carried inline, while a documentary credit set is routinely 6-12 documents and often
larger than 10 MiB. The rules base also genuinely depends on *seeing* originals — PROC-3.2
(signature is a distinct act), PROC-3.8 (endorsement on the reverse), CHK-TRANSPORT (on-board
notation), UCP 600 Art. 17/20/22/23.

Attaching originals until the cap and giving up on the rest would make a `COMPLIANT` verdict
structurally unreachable. Splitting the examination does not: the text pass says what it cannot
see, the second pass opens exactly those documents, and the cost is proportional to what actually
needs eyes rather than to the size of the set.

Three properties make the split safe, and all three are enforced rather than documented:

- a visual check must cite a rule that exists, and is capped at `MAX_VISUAL_REQUESTS = 24`,
  so the second pass cannot become an open-ended bill;
- completeness is computed **in the machine** from the digests it holds, never reported by the
  host, so an adapter cannot certify checks nobody performed;
- a `COMPLIANT` verdict is **refused** while any requested check is unanswered, and the
  unanswered ones are listed in `outstandingVisualChecks` rather than absorbed.

Visual inspection is bound to its own `vision` connector slot, separate from the `ocr` one:
reading a signature off a scan is a different capability from transcribing text.

## Ruleset

One version ships: `ucp600-isbp821-v1`, id `lc-rules-base`, status `PROVISIONAL`.

Provenance is verbatim — every rule is transcribed from the production legacy prompt at
`lib/pipelines/workflows/prompts/lc-checker-prompts.ts`. No rule was added, merged,
reworded or improved. New criteria are a **new version**, never an edit to this one.

The prompt is generated from the registry, so a rule change shows up as a diff in data
rather than as an invisible edit inside a string, and the output contract tells the
examiner to cite bracketed rule ids that the validator can resolve.

## Development

```bash
pnpm --filter @du/lc-checker test          # offline unit suite
pnpm --filter @du/lc-checker test:typecheck
pnpm --filter @du/lc-checker build
```

## Verification status

Offline only. Nothing in this package has been run against a live queue, a database or a
real provider. The join contract (`ctx.input.joinSummary`) is read the same way
`example-review` reads it, and carries the same caveat: the authoritative typed
continuation contract is still owned by the platform lane.

See `du-rework/coordination/reports/qwen-p9-02-lc-checker-2026-10-02.md` for the full
receipt, the deliberate differences from the legacy workflow, and the open items that need
a domain owner or a platform lane.
