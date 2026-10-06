# ENCMETA-SCHEMA-IMPL — Option C implemented (documented exemption + wire-boundary guards) — 2026-10-05

**Packet:** `coordination/dispatch-specs/2026-10-05-0146-ENCMETA-SCHEMA-IMPL.md` (lane qwen_1).
**Approved:** ENCMETA-SCHEMA-PREP §5, Option C (keep plaintext + explicit exemption).
**Prep receipt:** `coordination/reports/encmeta-schema-prep-2026-10-05.md`.
**Mode:** offline; no commit/push/reset; literal Exit Code from wrapper.
**File changed:** `services/orchestrator/tests/enc-meta-sentinel-runtime-refs.test.ts` — **tests only**. No product code changed.

## 0. TL;DR

- Detector test 3 renamed to **DOCUMENTED ACCEPTANCE**; the two `leaksSentinel(...) === true` assertions are KEPT as *evidence of the exemption*, with the reason and a conditional-acceptance trigger in the comment.
- **5 new tests** pin the wire boundary (toOperationView / ResultEnvelope strict / OperationView strip / HumanWaitView strip / end-to-end) plus **1 slot-boundary regression guard**. Suite 4 → **10 tests**.
- **Mutation probe: 5 mutations in 2 runs, all load-bearing** (4 RED + 2 RED).
- 3× literal `Exit Code: 0`, 10/10. Regression 338/338 exit 0. Typecheck 0 errors.
- Net product diff for this packet: **0 bytes** (proven by `git diff HEAD --numstat`).

## 1. Item-by-item against the packet

| # | Packet item | Where | Status |
|---|---|---|---|
| 1 | Flip detector test 3 → documented acceptance (rename; keep 2 leak=true as evidence) | outer describe, 3rd test | DONE |
| 2 | Wire-boundary guard: public OperationView/ResultEnvelope carry no uiSchema/contextRef; sentinel never on the wire | new describe, 5 tests | DONE |
| 3 | Pin `context_ref` contract-opaque (parses without it; added → stripped as unknown) | new describe, tests 2/4/5 | DONE |
| 4 | Conditional-acceptance trigger comment | test 3 header comment | DONE |
| 5 | Do NOT touch input_schema/response_ref/payload_ref | new regression guard (1 test) | DONE |

## 2. Test 3 — the flip (verbatim intent preserved)

Old name: `FINDING pin: waitInput stores ui_schema and context_ref verbatim (no slot exists)`.
New name: **`DOCUMENTED ACCEPTANCE: ui_schema/context_ref rest as plaintext BY EXEMPTION, not as a gap`**.

The comment now records the three measured reasons (`context_ref` zero readers; `ui_schema` consumed only by view-models fed by a `wait` projection `toOperationView` never emits; neither has a reader or a failing assertion), states that the assertions are *evidence of the exemption rather than a finding to fix*, and carries the **CONDITIONAL-ACCEPTANCE TRIGGER**:

> if any future PR projects `wait` / `uiSchema` / `contextRef` onto a public wire, that PR MUST either seal the column (a new METADATA_SLOTS entry) or re-justify this exemption.

The two `leaksSentinel(...) === true` assertions and the `input_schema` control (`=== false`) are unchanged — only the per-line comments changed to say *why* each is what it is.

## 3. New wire-boundary guards (5 tests)

Three independent mechanisms, so the guard has no single point of failure:

| Test | Mechanism | Assertion |
|---|---|---|
| toOperationView projects neither key | the projector | `Object.keys(view)` has no `uiSchema`/`ui_schema`/`contextRef`/`context_ref`, and the serialized view contains no sentinel — **even when the input row carries both** |
| ResultEnvelopeSchema is STRICT | `.strict()` | a valid envelope parses; adding `uiSchema` or `contextRef` → `success === false` (rejected outright) |
| OperationViewSchema STRIPS uiSchema | non-strict zod (strip) | parse succeeds; `parsed.data.uiSchema` is `undefined` and the serialized result has no sentinel |
| HumanWaitViewSchema drops context_ref | non-strict zod (strip) | parses without `contextRef`; with it added, parse succeeds and `data.contextRef` is `undefined` |
| END-TO-END | real `waitInput` + the public projector | a sentinel written via `waitInput` into `ui_schema`/`context_ref` appears in NEITHER the operation view NOR a consumer-parsed wait view |

## 4. Regression guard (1 test) — the slot boundary does not move

Item 5 asked that `input_schema`/`response_ref`/`payload_ref` stay out of scope. The guard pins the exact boundary of the seal map in both directions:

- **sealed slots stay sealed** — `crypto.seal(..., slot: 'human_waits.response_ref')` and `'tasks.payload_ref'` resolve;
- **structural + exempted columns stay OUT** — `human_waits.input_schema`, `human_waits.ui_schema`, `human_waits.context_ref` are all rejected by `assertContext`.

This is the assertion that makes the exemption **enforceable rather than aspirational**: the day someone adds `human_waits.ui_schema` to `METADATA_SLOTS`, this test goes RED and forces the conscious re-decision the trigger demands.

## 5. Literal results

| Run | Tests | Exit Code |
|---|---|---|
| detector ×1 | 10 passed | **0** |
| detector ×2 | 10 passed | **0** |
| detector ×3 | 10 passed | **0** |
| regression set (5 suites) | 338 passed | **0** |
| `npx tsc --noEmit` (orchestrator) | 0 errors | **0** |

Regression set = the detector + `admin-operation-view-model`, `enc-meta-sentinel-outbox-source-url`, `submission-metadata-crypto-e2e`, `crx01-creatapp-metadata-seam`.

`packages/contracts` was rebuilt (`npx tsc -p tsconfig.json`, exit 0) because the orchestrator consumes the package's `dist/`, not `src/`. `dist/` is gitignored — no tracked artifact.

## 6. Mutation probe — 5 mutations, all load-bearing

| # | Mutation | RED | Proves |
|---|---|---|---|
| 1 | remove `.strict()` from `ResultEnvelopeSchema` | 1 | the strict-reject guard is load-bearing |
| 2 | add `uiSchema` to `OperationViewSchema` | 1 | the strip guard is load-bearing |
| 3 | add `contextRef` to `HumanWaitViewSchema` | 2 | the contract-opaque pin + the end-to-end strip assertion |
| 4 | add `human_waits.ui_schema` to `METADATA_SLOTS` | 1 | **the exemption is enforced by the slot boundary** |
| 5 | make `toOperationView` project `context_ref` | 1 | the projector guard is load-bearing |

Run 1 (M1-M3): **4 RED** — each with the right received value (`uiSchema` echoed `{title: "approve ENC-META-…"}`, `contextRef` echoed `"ctx-ENC-META-…"`, strict parse returned `true`).
Run 2 (M4-M5): **2 RED** — `toOperationView` keys list contained `contextRef`; `seal(slot:'human_waits.ui_schema')` **resolved instead of rejecting**.

All reverted; `grep MUTATION` over the three mutated source files returns no matches. Final state re-verified 10/10 ×3.

## 7. Read-only discipline — proven, not asserted

This packet deliberately mutated three product files only to probe, then reverted. `git diff HEAD --numstat` after revert:

| File | numstat | Verdict |
|---|---|---|
| `packages/contracts/src/operations.ts` | **absent (0/0)** | byte-identical to HEAD — all 3 mutations reverted |
| `services/orchestrator/src/modules/operations/facade.ts` | **absent (0/0)** | byte-identical to HEAD |
| `services/orchestrator/src/modules/runtime/metadata-crypto.ts` | **48 / 0** | entirely the RESULTREF-IMPL lane's `result_ref` slots — **not reverted, still intact** |

`git status` may still print ` M` for the two byte-identical files; that is the racy-stat-cache artifact of rewriting mtime, and `git diff HEAD --numstat` is the authoritative check (0/0, file absent from the output).

The `metadata-crypto.ts` +48 was deliberately NOT reverted — RESULTREF-IMPL landed `tasks.result_ref` / `operations.result_ref` there, and the green detector (which seals `result_ref` under both slots) confirms that work survived untouched.

## 8. Deliverable

`services/orchestrator/tests/enc-meta-sentinel-runtime-refs.test.ts` — sha256 `0F07594177992BDBDF04E302F0638BC604DACA0C3D94347365B8448B5472BC0C`.

## 9. Limitations

- Offline: the scripted-`pg` harness, not a live PostgreSQL. The wire-boundary guards call the real `toOperationView` and the real contract schemas, so the boundary claim is about code, not about a live route being exercised end-to-end over HTTP.
- `toOperationView` is asserted directly rather than through `GET /operations/:id`. The route calls that same function, but a future route could bypass it — the guards would not catch a bypass that stops using `toOperationView`.
- The exemption remains a decision, not a proof that the data is harmless; the guards bound the *blast radius* (never on a wire), not the *content* (a sentinel still rests in the row, as the acceptance test states).
- No live infra window was used or needed.

READ-ONLY compliance: only the detector test file was modified; the three product files touched during the mutation probe are byte-identical to their pre-probe state; no commit/push/tick.