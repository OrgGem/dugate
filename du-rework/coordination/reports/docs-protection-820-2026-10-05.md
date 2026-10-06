# DOCS-PROTECTION-820 - receipt (docs-only correction of at-rest-protection claims)

> **RESUME POINT (qwen_5, 2026-10-05)** - task DOCS-PROTECTION-820 (task_897209cc35b0),
> dispatch ctx_e2adbd6daeb3. **DOC-ONLY**: 3 edits in `docs/04-data-state.md`. No source edit,
> no commit, no tick. Source of the corrections: REVIEW-809 + FULL-REGRESSION-815.

---

## 1. The two lines fixed in `docs/04-data-state.md`

**Line 1 - slot count was wrong (7 -> 8).** The doc said "7 slot"; the code has 8. The missing one is
`step_checkpoints.session_ref`, added by migration 0032. Verified against `METADATA_SLOTS` in
`services/orchestrator/src/modules/runtime/metadata-crypto.ts`: `operations.input_ref`, `tasks.payload_ref`,
`human_waits.response_ref`, `step_checkpoints.output_ref`, `step_checkpoints.session_ref`,
`operations.prompt_overrides_ref`, `tasks.result_ref`, `operations.result_ref`.

**Line 2 - the TEXT-column bullet implied a shape pass was protection.** It said the reader "mở được sealed
envelope khi có seam phù hợp và đọc legacy plaintext verbatim". That is accurate about *what the code does*
but reads as if being readable were a protected state. Rewritten to state the three-way distinction.

## 2. The four protections now stated in that section

1. **A shaped envelope is NOT proof of protection.** Shape only says the value *looks* like an envelope;
   it neither encrypts nor opens.
2. **Shaped but not AEAD-opened is still a plaintext-readable row.** It sits in the backfill window, not in
   a protected state.
3. **Sealed-but-broken is DATA LOSS for processing** and must carry an explicit warning - not a neutral gap.
4. **Never use the shape counter `GATE PASSES` as flip evidence.** The shape gate only reads shape; it does
   not decrypt. The flip needs both gates at zero (see `live-window-runbook-803` A10/A12).

## 3. Seed B warning added (REVIEW-809)

Added to the DATA-01/DATA-02 section: in `ingress-bounded.test.ts:244-261` the oversize case does **not**
prove blob auth - it fails from **test-order contamination** (`before.rowCount = 0` because two earlier PUTs
were blocked, and the body-limit path runs before blob auth). That case needs an **independent blob seed**
(Seed B) before its number means anything. Source: `docs/36-evidence-table-reconciliation.md:109`.

## 4. Full scan of `docs/` and `README.md` - result

Grepped for `encrypted at rest`, `at-rest encrypted`, `da duoc bao ve`, `protected at rest`, `encrypt`,
`ENC-`, `metadata` across `docs/*.md` and `README.md`.

**No remaining over-claim found.** The only hits were inside `coordination/reports/claude.md` (a receipt, not
a doc) and they are the coordinator own canonical A8 wording, which is correct:

> "encryption best-effort trong backfill window, legacy rows plaintext-readable" - khong ghi "at-rest encrypted"
> A8: "TUYET DOI khong ghi at-rest encrypted cho den khi PRE-SWITCH muc 3 hoan tat"

**Out-of-scope exception, deliberately not touched:** `docs/12-operations.md:26` says "Secret encrypted at
rest". Per `claude.md:1611` that refers to **AppSetting secrets / `fileUrlAuthConfig` cipher** - a different
seam (Vault/profile-key), not result_ref/metadata. A8 governs result_ref/metadata claims only, so that line
was left alone and is recorded here so nobody "fixes" it later.

## 5. Cross-check against real code

Every claim in the corrected section was checked against the reader that exists, not against a memory:

| Doc claim | Code |
|---|---|
| 8 slots | `METADATA_SLOTS` in `metadata-crypto.ts` |
| TEXT columns hold a JSON *string* envelope | `readStoredText` at `metadata-crypto.ts:350` |
| 4 `readStoredText` call sites pass `allowPlaintext=true` | `runtime.ts:1202`, `runtime.ts:1814`, `mappers.ts:103`, `public.ts:538` |
| no seam + envelope-shaped => `KEY_PROVIDER_FAILED` | `assertReadableWithoutSeam` at `metadata-crypto.ts:159` |
| no seam + plaintext => passes | same function, `allowPlaintext` default false |
| wrapper and reader share one rule | `runtime.ts:475` and `metadata-crypto.ts:424` both call it |

## 6. Honest limits

1. **The scan was pattern-based, not a line-by-line read of every doc.** A claim phrased without any of my
   search terms would not have been caught. The patterns covered the four phrasings the reviews named.
2. **I did not re-run any test.** This packet is doc-only; the code facts above come from reading source.
3. **`docs/12-operations.md:26` was not audited in depth** - it is recorded as an out-of-scope exception on
   the strength of `claude.md:1611`, not on my own reading of that page.

## 7. Ledger

- DOCS-PROTECTION-820 - Muc 1 - fixed 2 lines in docs/04-data-state.md (slot count 7 -> 8, missing
  step_checkpoints.session_ref; TEXT-column bullet rewritten to the three-way distinction) and added the
  Seed B warning; added the four protections (shape != protection, shaped-but-unopened is plaintext-readable,
  sealed-but-broken is data loss, never use shape GATE PASSES as flip evidence); full docs+README scan found
  no other over-claim; docs/12-operations.md:26 recorded as an out-of-scope A8 exception. DOC-ONLY: no source
  edit, no commit, no tick.
