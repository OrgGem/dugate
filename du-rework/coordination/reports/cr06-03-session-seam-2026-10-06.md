# CR06-03 — P745 SESSION-CONSUME action wiring (2026-10-06)

- Task: CR06-03 / MEDIUM (`CODE-REVIEW-FOLLOWUP-2026-10-06.md`), parent P745-SESSION-CONSUME
- Owner: OpenCode (oc_2), document-core (+ template mirror); worker-sdk unchanged (not needed)
- Scope decision: **(a) WIRE** capture/inject into the 6 actions' invoke path and settle the Δ-2 mapping rule — not a documented defer.
- Constraints honored: no commit, no tick, no push; no live provider/DB; template mirror updated in step with `src/`.
- Status: **IMPLEMENTED + offline-verified by focused/full suites; independent VFY + Claude review still required. No acceptance claim.**

## 1. Call-site survey (before)

All document-core connector invokes run inside `StepCheckpointManager.executeWithCheckpoint(...)` and now pass through the session seam. 11 call-sites in 6 actions:

| Action | Step (STEP_KEYS) | Slot | File |
|---|---|---|---|
| ingest | `ingest:execute-ocr` | `ocr` | `src/actions/ingest/index.ts` (OCR branch) |
| ingest | `ingest:execute-digitize` | `vision` | `src/actions/ingest/index.ts` (digitize branch) |
| extract | `extract:connector-inference` | `reasoning` | `src/actions/extract/index.ts:93` |
| analyze | `analyze:fact-check-extract-claims` | `reasoning` | `src/actions/analyze/index.ts:135` |
| analyze | `analyze:fact-check-verify-claims` | `reasoning` | `src/actions/analyze/index.ts:157` |
| analyze | `analyze:connector-inference` / `analyze:summarize-eval-inference` (runtime-selected) | `reasoning` | `src/actions/analyze/index.ts:179` |
| transform | `transform:execute-translate` | `reasoning` | `src/actions/transform/index.ts` (chunk loop) |
| transform | `transform:execute-rewrite` | `reasoning` | `src/actions/transform/index.ts` (chunk loop) |
| generate | `generate:connector-inference` | `reasoning` | `src/actions/generate/index.ts:102` |
| compare | `compare:execute-semantic` | `reasoning` | `src/actions/compare/index.ts:97` |
| compare | `compare:execute-version` | `reasoning` | `src/actions/compare/index.ts:137` |

Before this packet the four helpers in `src/actions/session-seam.ts` had **zero production call-sites**: every site called `ctx.connector.invoke(...)` directly and never read `ctx.profilePolicy` session config or persisted an offered session.

## 2. Δ-2 mapping rule — SETTLED (official)

**`connectionsOverride[].stepId` MUST be the document-core step key from `src/recipes/step-keys.ts` (e.g. `ingest:execute-ocr`, `extract:connector-inference`). Matching is EXACT. Legacy/abbreviated ids (`ocr`, `extract`, …) have NO alias table and are NOT guessed: the step declares no session config and the seam skips it (fail-loud, pre-P745 behaviour).** Session values are addressed by SLOT NAME, so the capture step and inject step do not need to know each other's ids. Adding an alias table later requires a separate decision with an authoritative producer of the legacy mapping; until then no binding is invented.

This rule is written in the `session-seam.ts` module header and pinned by tests (legacy `ocr`/`extract` policy steps neither capture nor inject, even with a pre-seeded slot).

## 3. Implementation

`src/actions/session-seam.ts` (kept the 4 original helpers; `findStepSessionConfig`/`resolveInjectSessionRef`/`captureSessionRef` semantics unchanged, `awaitCheckpointSessionRef` reads the checkpoint `sessionRef` column first with the payload fallback):

- `sessionSlotStepKey(slot)` — deterministic checkpoint key `p745:session:<slot>`.
- `resolveStepSessionRef(ctx, stepId)` — reads the `injectSession` slot checkpoint; falls back to the step's own checkpoint for same-step resume; `null` when nothing to continue.
- `persistStepSessionCapture(ctx, stepId, offered)` — first-write-wins capture into the slot checkpoint via `ctx.step(slotKey, 'session-slot:<slot>', () => ({sessionRef}), {sessionRef})`; no config/no value/existing slot => no write.
- `invokeWithStepSession(ctx, stepId, invoke)` — resolve inject → invoke (caller passes `sessionRef` only when non-null) → persist capture. Without a matching policy step it is a pass-through (no options key, no checkpoint).

Supporting changes:
- `src/types/context.ts`: `StepCheckpointRecord.sessionRef?`; `TaskContext.step(..., options?: { sessionRef?: string | null })` (additive).
- `src/worker.ts` `toInternalContext`: forwards step `options` to `SdkTaskContext.step.run` (SDK persists `sessionRef` on the checkpoint row) and surfaces `peeked.sessionRef` through `getCheckpoint`.
- 6 actions: all 11 invoke sites wrapped with `invokeWithStepSession`; `promptStepId` preserved; `sessionRef` spread only when a value exists.

Durability model: capture writes a **separate slot checkpoint**; a resumed delivery gets it from the claim's checkpoint refs (SDK `peek().sessionRef` / internal `getCheckpoint().sessionRef`) and injects it before the next invoke. Capture is first-write-wins; re-capturing a different session requires a new slot name.

## 4. Changed paths and hashes (SHA-256)

| File | SHA-256 |
|---|---|
| `src/actions/session-seam.ts` | `2798440B72832BA15DAE93EE497FF2F472CB7752C37528447823DA8371E85039` |
| `src/types/context.ts` | `F599B44A1C7EB02E5F87C0BFAD01ADD9330D6BC3A45384429F3373DE17DE48D0` |
| `src/worker.ts` | `F9357973CAA8B0810C2652F9A865BDE76750CB952981B25A49949A3ED30A0382` |
| `src/actions/ingest/index.ts` | `DCB1D488029BBF16C363776E20E349DEFA2A44126925F1B998C3567B9A943B33` |
| `src/actions/extract/index.ts` | `D48397A6E62E46A3B774A7BC6F6A181648CB1F2F79559F9AB07BFF2C3EB9B9AB` |
| `src/actions/analyze/index.ts` | `ADB5242FA8EEA5A712BE5D722366614B19246E666A44FB99FA325977CDB60740` |
| `src/actions/transform/index.ts` | `4B8A95690803CD5E502AA697FFD4EBD51C5935F46A3E470416A47AB520DF422D` |
| `src/actions/generate/index.ts` | `789A96F8C2441A9A3B23DBFFAE8576AAD83558A6F21C6D92F2C2B12AB648A820` |
| `src/actions/compare/index.ts` | `D4377C0DDDD62E80F971F2BD9914DFDDACAE79888800D6F3647E8F08425D5AC3` |
| `tests/fixtures/mock-context.ts` | `32EDD844E7405028D9D80989999ABAC865221632411DD36D22ED39D8D7E915FF` |
| `tests/p745-session-action-wiring.test.ts` (new) | `519D38026DB737CDE71E461C9F889D6D22E5A6760F206AA61A6447D8764AFFBF` |
| `template/src/actions/session-seam.ts` | `2798440B…5039` (identical to src) |
| `template/src/types/context.ts` | `F599B44A…48D0` (identical to src) |
| `template/src/worker.ts` | `01CE29B5012D7819D9A18CE7B865DE0D80FDBF072757CD4DC4AE3C3909729E38` (mirror of the step/getCheckpoint changes; pre-existing drift in the connector.invoke options block remains — see §6) |
| `template/src/actions/{ingest,extract,analyze,transform,generate,compare}/index.ts` | identical hashes to `src/` counterparts |

No worker-sdk file changed: the SDK already supports `StepRunOptions.sessionRef` and `ConnectorInvokeOptions.sessionRef`; only the document-core facade needed to forward them.

## 5. Verification (offline; literal exits)

| Command (cwd `du-rework/businesses/document-core`) | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | exit **0** |
| `npx tsc --noEmit -p tsconfig.json` (cwd `.../template`) | exit **0** |
| `npx jest tests/p745-session-capture-inject.test.ts tests/p745-session-action-wiring.test.ts tests/extract.test.ts tests/analyze.test.ts tests/compare.test.ts tests/ingest.test.ts` | **6 suites / 99 tests passed**, exit **0** |
| `npx jest tests/p745-carrier-impl-b2.test.ts tests/execution-pin.functional.test.ts tests/ingest-scan-fixtures.test.ts tests/six-action-fail-closed-matrix.functional.test.ts tests/cross-service-boundary.test.ts` | **5 suites / 85 tests passed**, exit **0** |
| `npx jest tests/p745-session-capture-inject.test.ts tests/p745-session-action-wiring.test.ts tests/p745-carrier-impl-b2.test.ts` | **3 suites / 37 tests passed**, exit **0** |
| `npx jest --silent` (full package) | **60 suites passed / 3 failed / 63 total; 959 passed, 1 skipped, 0 failed tests**, exit 1 |

The 3 red suites (`sdk-consumer`, `bullmq-smoke`, `provider-backed-variant`) fail at ts-jest compile with the **pre-existing** `Property 'profilePolicy' is missing` diagnostic (W1b pin type strictness in those test files; identical to the pre-existing failures recorded in `p745-session-consume-impl-2026-10-04.md` §3). No test-level failure in the package; the new + modified suites are green.

New `tests/p745-session-action-wiring.test.ts` covers: ingest OCR capture → slot checkpoint; extract inject before invoke (promptStepId preserved); **new-delivery resume carrying checkpoint refs still injects** (multi-turn checkpoint resume); first-write-wins; no-policy pass-through (no sessionRef, no slot checkpoint); Δ-2 legacy skip in both directions; SDK facade forwards step options and surfaces the row sessionRef.

## 6. Honest limits / open items

- **CR06-04 remains open**: provider session survival across async-202 pending-yield is the Connector side (`services/connector/src/invoke.ts` drops `sessionRef` from 202 bodies). This packet persists/injects the session on checkpoints; it does not carry it through a 202 poll.
- **Δ-4 (live provider semantics)** still needs the Connector/live leg: it is proven offline that `sessionRef` reaches the wire/hash; a real provider honoring the session is not proven here.
- **Workflow invoke sites are out of scope**: disbursement `invokeJson`/report and doc-compare `runner.ts` call the connector directly; they keep their current single-shot behaviour until separately leased (they are also CR06-01 territory for `promptStepId`).
- **Template worker pre-existing drift (observed, not fixed)**: `template/src/worker.ts` lacks the `providerOptions` sanitization that strips `promptStepId`/`sessionRef` before the SDK provider options (`src/worker.ts:452-458`). This predates CR06-03; flagging for the template owner rather than expanding this packet.
- Multi-invocation steps (transform chunk loops) share one inject session across chunk calls and capture the first offered session once — documented in the module header.
- Checkpoint GC: if the runtime drops the slot checkpoint, the next inject starts a fresh provider session (documented; not fabricated).
- No tick, no commit; `docs/19/28/35` test-inventory/traceability sync is deferred to the docs owner (current `docs/**` lease context).

## 7. Handoff

Independent verification should target the hashes in §4 plus: run the two P745 suites + focused action regression; check the new-delivery resume test and the legacy-skip negatives; re-run `tsc` for `src` and `template`. Claude Code review decides acceptance per gate; coordinator settles CR06-03 disposition.
