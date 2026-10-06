# IMPL REVIEW A — P745 sealed prompt-content carrier core (cc_1) — 2026-10-04

**Task:** `task_5bc5a732f055` · lane cc_1 · packet P745-CARRIER-IMPL-A (dispatch 23:36, snapshot 23:37–23:45 +07, HEAD `b088eec`, offline).
**Producer receipt:** `p745-carrier-impl-a-2026-10-04.md` (§0–§7) — this review verifies its claims against design + adjudications 1a–1g.
**Design basis:** `design-review-carrier-2026-10-04.md` (APPROVED-WITH-CONDITIONS).
**Role:** READ-ONLY — no source/test edits, no tick/commit. DB window: FREE.

## Verdict: APPROVED-WITH-CONDITIONS (core land OK; end-to-end NOT yet complete)

## 1. Adjudication compliance 1a–1g — ALL PASS

| # | Chốt | Evidence | Result |
|---|---|---|---|
| 1a | Form A: column `prompt_overrides_ref` + NEW slot, seal/open semantics untouched | 0031 migration; `METADATA_SLOTS` +`'operations.prompt_overrides_ref'`; seal/open/readStored not modified | PASS |
| 1b | Cross-check markers↔carrier at claim: multiset + recompute, fail-closed | `openPromptCarrier`: count-equality, duplicate-key deny, `markers[key]===row.revision`, recompute `sha256(connId\|stepId\|content)`; mismatch → INVALID_SCHEMA | PASS |
| 1c | No-seam → carrier NULL + markers kept; never plaintext | `submission.ts`: seal only when `metadataCrypto && rows>0`; T1 no-seam + T2 `carrier:null` verify | PASS |
| 1d | Caps 64/16 KiB/256 KiB + 422 `PROMPT_CARRIER_TOO_LARGE` | `PROMPT_CARRIER_LIMITS` + `assertPromptCarrierCaps` BEFORE seal/tx; 3 zero-write cap cases | PASS |
| 1e | Decrypt orchestrator-side at claim; substitution business-side | `pinned.promptOverrides = await openPromptCarrier(...)` in `buildClaimResult`; substitution deferred | PASS (Packet-B gap noted) |
| 1f | Contracts additive `pinned.promptOverrides` + dist rebuild | `PinnedPromptOverrideSchema` + field; dist rebuilt via `tsc -p tsconfig.json` exit 0; SDK/contracts regressions | PASS |
| 1g | Field name `pinned.promptOverrides` | as specified | PASS |

## 2. Sentinel / 0-write evidence

- Producer (7 tests): markers + carrier same bucket; envelope opens on correct slot/tenant/refId; rows match markers, deterministic sort; sentinel absent from every param bound incl. base64; legacy → both pins NULL without bucket read; no-seam → markers kept, carrier NULL; key-provider fail → 0 INSERT; 3 cap shapes → 422 + 0 INSERT; bucket edit affects only new submits.
- Claim (7 tests): open → `pinned.promptOverrides` correct + `promptRevisions` intact; NULL → null (not []); tampered tag → AUTHENTICATION_FAILED + 0 writes; marker drift → INVALID_SCHEMA + 0 writes; wrong slot → CONTEXT_MISMATCH + 0 writes; carrier without crypto → INVALID_SCHEMA + 0 writes; sentinel only in `promptOverrides`.
- Suites: T1 7/7 + T2 7/7; focused 11 suites / 115 tests × 3 runs EXIT=0; `tsc --noEmit` final 0 (one real narrowing error `submission.ts(649,3)` fixed transparently, then TICA2=0).

## 3. Fail-closed classes

- AUTHENTICATION_FAILED (tag tamper), INVALID_SCHEMA (drift / missing-crypto / shape), CONTEXT_MISMATCH (wrong slot/tenant/ref) — distinct codes, all inside claim tx with 0 committed writes (lease/state writes precede build, throw rolls back).
- Δ-note verified: `openMetadata` keeps `allowPlaintext=true` for input_ref/payload (legacy window); carrier uses `allowPlaintext=false` separately (new column, no legacy rows) — correct adversarial design, no seam change.

## 4. Pre-existing reds (not regressions)

- `contracts/tests/vault-policies.test.ts` 2 fail (`toThrowError is not a function` — test's own matcher API misuse): A/B hash-verified pre-edit byte-exact reproduces same failure. Owner khác.
- `br12-isolation-offline` known pre-existing, outside focused set.

## 5. Lease compliance

- Write-set: contracts src+dist, 0031, metadata-crypto.ts, submission.ts (announced W1-hot), runtime.ts, 2 new tests + receipt. No touch of SDK worker.ts / publish.ts / document-core (ambient change by another lane noted, not this lane). Offline; no tick/commit/push.

## 6. Remaining conditions (Packet-B / live window — not blocking core commit)

1. Packet-B: SDK forward + 6-site wiring + T5 pass-through; null → connector default (apply:false), never stale/empty.
2. Keep single-bucket invariant for markers + carrier.
3. No envelope/plaintext debug logging in prod; queue/outbox/checkpoint never copy carrier content.
4. Live window open: real PG + real Vault, claim live, worker-kill immutability, observed provider request.

## 7. Commit-plan impact

- Carrier core is ONE bisect-clean commit: 0031 + `packages/contracts/src/runtime.ts` + `packages/contracts/dist/runtime.{d.ts,js}` (rebuilt, same commit) + metadata-crypto.ts + submission.ts + runtime.ts + `tests/p745-prompt-carrier-{producer,claim}.test.ts`.
- Do NOT fold: SDK forward, document-core worker.ts, publish.ts, profile-commands, other contracts files (other lanes).
- Order: after producer-impl, before Packet-B. 0031 must ride with producer+claim (column + writer + reader together).
