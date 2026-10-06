# SESSION-LEG — connector-side sessionRef forward (Δ-4) — receipt — 2026-10-05

**Packet:** `coordination/dispatch-specs/2026-10-05-0034-SESSION-LEG.md` (lane qwen_1).
**Source:** Δ-4 in `coordination/reports/p745-session-consume-impl-2026-10-04.md:35` (lane qwen_2).
**Mode:** offline-only; no commit/push/reset; literal Exit Code from wrapper; SKIP != PASS.
**Lease:** `services/connector/src/**` + tests. Read-only: worker-sdk, document-core, orchestrator.

## 0. TL;DR

**The forward is already implemented — no product code change was needed.** `sessionRef` reaches the provider on both adapters, and it participates in the canonical invocation hash. What was missing is **evidence**: every pre-existing fixture passed `sessionRef: null`, so the forward path had zero coverage for a real session.

| Question from the packet | Answer |
|---|---|
| Is `InvocationRequest.sessionRef` forwarded to the provider request? | **YES** — json body field (default mapping) and multipart form field |
| Correctly, per contract? | SDK→connector hop: yes, contract-typed. Connector→provider hop: **the contract is silent** — the field name is a connector convention (Δ-3) |
| Missing? | Not the code. **The test.** 7/7 existing fixtures used `sessionRef: null` |
| Contract describes how to send? | **No** for the provider leg → Δ + proposal recorded (see §3) |

**Deliverable:** `tests/p745-session-leg.test.ts`, 19 tests, 3× literal exit 0, mutation-probed.

## 1. Δ-4 verbatim (what this leg was asked to close)

> **Δ-4 (wire carrier — van mo):** sessionRef len wire qua `InvocationRequest.sessionRef` (contract da co) nhung **provider co that su doc/gan no hay khong la quyet dinh phia Connector**; offline chi chung minh SDK/dat do, khong chung minh provider ton tai session. Can leg Connector (P745-ACQ/connector lane) xac nhan.

## 2. Audit — the forward path, read end to end

| File | Line | What it does |
|---|---|---|
| `src/types.ts` | 58 | `LocalInvocationRequest.sessionRef?: string \| null` |
| `src/types.ts` | 89 | `NormalizedProviderResult.sessionRef?: string \| null` (response side) |
| `src/hash.ts` | 23 | `canonicalInput` passes `sessionRef: request.sessionRef` into the shared `@du/contracts` hash |
| `src/adapters/http.ts` | 35, 44 | json: `source.sessionRef = request.sessionRef ?? null`; default `requestMapping` includes `sessionRef: 'sessionRef'` |
| `src/adapters/http.ts` | 68 | json: default `responseMapping` includes `sessionRef: 'sessionRef'` |
| `src/adapters/http.ts` | 102 | multipart: `if (request.sessionRef) form.set('sessionRef', request.sessionRef)` |
| `src/contracts.ts` | 64 | `toContractInvocationResponse` copies `result.result.sessionRef` onto the wire response |
| `packages/contracts/src/connector.ts` | — | `InvocationRequestSchema.sessionRef = z.string().nullable().optional()`; `InvocationResultSchema.sessionRef` likewise |

So the chain is complete: **SDK wire field → connector request → provider body → provider response → normalized result → connector wire response**, and the ref is inside the canonical hash on both sides.

### 2.1 Why Δ-4 stayed open despite the code being present

`grep sessionRef` over `services/connector/tests` returns 7 fixture hits, and **all seven are `sessionRef: null`**:

`connector.test.ts:30`, `canonical-hash-parity.test.ts:23`, `r1-d-lifecycle-offline.test.ts:29`, `r1-d-03-mock-provider-reconciliation.functional.test.ts:160`, `p8-03-convergence.test.ts:51`, `p745-options-passthrough.test.ts:29`.

A `null` ref exercises none of the forwarding branches (`writeMapped` writes the mapped value either way; multipart's `if (request.sessionRef)` short-circuits). The path was therefore present-but-unproven, which is exactly the state Δ-4 describes.

## 3. Gaps found (Δ + proposal) — all connector-side, none fixed unilaterally

### Δ-1 — a custom `requestMapping` silently drops `sessionRef` on json only

`writeMapped` writes only the keys the mapping names. The json adapter's default mapping carries `sessionRef`, but an operator-supplied `requestMapping` that omits it drops the ref with **no error and no warning**. The adapter already refuses to let a mapping drop `artifacts` — `if (artifacts.length > 0) body.artifacts = artifacts` is a deliberate floor, because authorized document bytes must reach the provider. **`sessionRef` has no such floor.**

Worse, the multipart adapter never consults `requestMapping` for `sessionRef`, so the same config behaves differently on the two adapters: json drops it, multipart keeps it. Pinned by two tests.

**Proposal (needs coordinator/design sign-off — it changes config semantics):** give `sessionRef` the same floor as `artifacts` — force-include it on json regardless of `requestMapping`, so a session-carrying connector cannot silently lose its handle. Alternatively, reject a `requestMapping` that omits `sessionRef` when `request.sessionRef` is present. Not applied here: it changes documented mapping behavior and the packet scoped this branch to Δ+proposal.

### Δ-2 — the two adapters disagree on the absent-ref shape

- json: `sessionRef: request.sessionRef ?? null` → the field is **always present**, `null` when there is no session.
- multipart: `if (request.sessionRef)` → the field is **absent entirely** when there is no session.

A provider written against the json shape sees an explicit `null`; one written against multipart sees a missing key. Neither is wrong alone, but a provider cannot treat the two shapes identically, and the contract does not say which is intended. Pinned by two tests.

**Proposal:** pick one and state it in the connector docs — either always-send (`null` when absent) or always-omit. Recommend always-send for json/multipart parity with the typed `nullable` contract.

### Δ-3 — the contract does not describe the connector→provider carrier

`InvocationRequestSchema.sessionRef` types the SDK→connector hop. Nothing in the contract or `docs/08-connector-api.md` states **how the connector must hand the ref to the provider** — the `sessionRef` body/form field name is a connector-side convention living only in the default mappings. A provider integration is written against that convention with no contract behind it.

**Proposal:** document the carrier in `docs/08-connector-api.md` ("the connector forwards `sessionRef` as the `sessionRef` field of the provider request"), or add a provider-facing field to the connector config schema so the name is explicit. This is the branch the packet flagged as "contract chưa mô tả cách gửi → ghi Δ + đề xuất".

## 4. What this leg does NOT prove (scope honesty)

**Provider session semantics remain open.** The mock provider (`tests/mock-provider/provider.ts`) has **zero** `sessionRef` handling (grep: 0 matches). So nothing in this suite proves that a real provider *persists* a session, *reuses* it across invocations, or *re-emits the same handle*. The round-trip test simulates the provider echoing the handle it was handed — that proves the connector's plumbing carries the ref both directions, **not** that the provider maintains session state.

That half of Δ-4 needs a provider that actually implements sessions — i.e. a live or mock-provider change outside this lease. Recorded here so Δ-4 is not read as fully closed.

## 5. Tests

`services/connector/tests/p745-session-leg.test.ts` — sha256 `EF0EF0D595832550635DB402C8E8EBE19DA293EE627936902F522D8D8B303316`, 19 tests.

| Group | Tests | Proves |
|---|---|---|
| reaches the provider request (Δ-4) | 4 | json body + multipart form carry a **real** ref; rename via mapping still carries it; input is flattened alongside, not replaced |
| absent-ref shape | 3 | json sends `null`; multipart omits; the asymmetry pinned |
| invocation identity | 3 | different ref → different hash; ref vs none differ; parity with the `@du/contracts` canonical hash |
| ref comes back | 4 | provider-returned ref → normalized result → wire response; round-trip; absent stays absent (no stale ref) |
| inbound contract hop | 2 | non-null ref survives the strict parse; `null` and absent both accepted |
| gap pins | 3 | json custom-mapping drop; multipart asymmetry; responseMapping drop |

**Literal exit codes (wrapper `Exit Code:` line):**

| Run | Tests | Exit Code |
|---|---|---|
| SESSION-LEG ×1 | 19 passed | **0** |
| SESSION-LEG ×2 | 19 passed | **0** |
| SESSION-LEG ×3 | 19 passed | **0** |
| connector regression set (6 suites) | 83 passed, 1 skipped | **0** |
| full connector suite | 26 suites, 322 passed, 8 skipped, 0 failed | **0** |

Regression set = session-leg + `p745-options-passthrough` + `canonical-hash-parity` + `connector` + `r1-d-lifecycle-offline` + `p8-03-convergence`.

Typecheck: `npx tsc --noEmit -p tsconfig.json` → **Exit Code: 0, 0 errors**.

## 6. Mutation probe (load-bearing proof)

| # | Mutation | RED | Verdict |
|---|---|---|---|
| 1+2 | remove the json default `sessionRef` mapping AND the multipart `form.set` | 7/19 | load-bearing; exactly the forward-related tests (json: `undefined`; multipart: `null`) |
| 3 | drop `sessionRef` from `canonicalInput` | 3/19 | load-bearing; exactly the 3 hash tests |

Note: under mutation 1+2 the test `a custom mapping that RENAMES the field still carries it` stayed GREEN — correct, because it supplies its own mapping that names `sessionRef` and so does not depend on the default. That is the isolation working as intended.

All mutations reverted; `grep 'MUTATION [123]'` over `src/` returns no matches (the 5 `MUTATION` hits are the pre-existing `assertMutationLease` in `ledger.ts`).

## 7. Limitations

- Adapter-level only: `buildRequest`/`normalizeResponse` are called directly. No HTTP server, no real provider socket.
- The round-trip uses a simulated echo; the mock provider does not implement sessions (§4).
- Δ-1/Δ-2/Δ-3 are recorded, not fixed — each changes documented behavior and needs a design decision.
- `sessionRef` value shape is unconstrained beyond `z.string()`: length/format are not validated. Not in scope; noted.

READ-ONLY compliance: worker-sdk, document-core and orchestrator were not touched; no connector source file was modified (only the new test file was added).