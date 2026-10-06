# RFX-DELIVERY — RFX-01 (AAD) + RFX-02 (policy.suite) delivered

**Task:** RFX-01 + RFX-02 from `tasks/ORCH-REVIEW-FIXES-2026-10-02.md` · **Date:** 2026-10-02 · **Status:** implemented and verified offline. No gate ticked; no commit.

**Source re-read before editing.** The plan's `file:line` pointers were from a tree around `f2be0de`; the working tree has since moved, so every change below was located from the current file. The plan's cited lines were accurate in substance (`createCipheriv` with no `setAAD`; `resolveSuite` not reading `policy.suite`) but the line numbers had shifted.

## 1. Files touched (lease)

| file | +/- | why |
|---|---|---|
| `src/modules/public-api/delivery-encryption.ts` | **+90 / -8** | RFX-01 AAD, RFX-02 suite resolution |
| `tests/delivery-encryption.test.ts` | +181 / -3 | focused suite + new coverage |
| `tests/enc08-wire-enc07.test.ts` | +22 / -1 | **forced** by the wire change (§5) |
| `tests/webhook-delivery-encryption.test.ts` | +26 / -1 | **forced** by the wire change (§5) |

No other file was modified. `src/modules/public-api/index.ts` (the barrel) was deliberately left alone — see §6.

## 2. RFX-01 — header bound as GCM AAD

**Before:** `createCipheriv('aes-256-gcm', dek, nonce)` then `update/final`. The envelope header (`version`, `suite`, `recipientKeyId`, `recipientKeyVersion`, `nonce`, `tag`, `enc`) was unauthenticated: editing it left the tag verifying, and a whole `(nonce, tag, enc, ciphertext)` group could be substituted between responses.

**After:** the DEK is wrapped FIRST (wrapping does not consume it), then the canonical header bytes are bound with `setAAD` before `final()`. `dek.fill(0)` is unchanged on both the success and the catch path.

### 2.1 AAD field set — and one deliberate deviation from the brief

The brief listed `version / suite / recipientKeyId / recipientKeyVersion / nonce / tag / enc`. **I bound six of those seven, excluding `tag`.**

`tag` is the **output of `final()`**. Passing it to `setAAD` before `final()` is cryptographically impossible — it would be circular, and there is no value to bind. `ciphertext` is likewise excluded for the same reason (it comes out of `update()`). Integrity of the tag is precisely what GCM's own `setAuthTag` verifies on the way back in, so nothing is lost by leaving it out.

Binding `enc` **did** require a behavioural reordering: the wrapped DEK had to exist before the cipher was created. That is the only ordering change in the function.

### 2.2 The consumer contract

`canonicalDeliveryAad(fields)` is exported and builds deterministic UTF-8 JSON with a fixed key order. A consumer must call it (or reproduce the bytes exactly) and pass the result to `setAAD`.

## 3. RFX-02 — `policy.suite` honoured or refused

**Chosen option: (a) honour the pin when compatible, fail closed with a specific code when not.**

Reasoning, recorded as the brief asked:

- The old comment claimed "Policy suite preference is honored only if compatible with the key" while `resolveSuite(key)` never read the field at all. Option (b) would have made the doc honest by **deleting a field from an exported interface** — a breaking type change for any consumer that sets it — when the field is a legitimate operator control.
- (a) preserves operator intent and turns a silent override into a visible, attributable error, which is the point of the finding.
- The error is a **policy** failure, not a crypto failure, so it gets its own code `DELIVERY_SUITE_INCOMPATIBLE` rather than hiding inside `DELIVERY_CRYPTO_FAILURE`. An operator reading "crypto broke" for what is actually "your policy and your key disagree" is the exact confusion RFX-02 reported.

Resolution order: no pin -> the key algorithm decides (unchanged); pin matches key suite -> honoured; pin disagrees -> `DELIVERY_SUITE_INCOMPATIBLE`. This runs BEFORE the HPKE-not-implemented throw, so a mismatched pin is no longer masked by the generic crypto error.

## 4. Verification (literal)

**cwd:** `D:\Git\dugate\du-rework\services\orchestrator`

| # | command | exit | result |
|---|---|---|---|
| 1 | `npx tsc --noEmit -p tsconfig.json` | **0** | no output |
| 2 | `npx jest --runInBand --runTestsByPath tests/delivery-encryption.test.ts` | **0** | `1 passed`, `66 passed, 66 total` |
| 3 | `npx jest --runInBand --runTestsByPath tests/delivery-encryption.test.ts tests/enc08-wire-enc07.test.ts tests/webhook-delivery-encryption.test.ts tests/artifact-read-decrypt-offline.test.ts` | **0** | `4 passed, 4 total`, `108 passed, 108 total` |

Required matrix, all passing:

| case | expected | result |
|---|---|---|
| RSA key + pin `rsa-oaep-sha256` | encrypts, decrypts | PASS |
| X25519 + pin `rsa-oaep-sha256` | fail closed, `DELIVERY_SUITE_INCOMPATIBLE` | PASS |
| tamper `version` / `suite` / `recipientKeyId` / `recipientKeyVersion` / `nonce` / `enc` / `tag` (7 cases) | tag check fails | PASS |
| crypto group lifted from a DIFFERENT key version, re-headed | rejected | PASS |
| valid envelope round-trip | exact plaintext | PASS |
| consumer that omits `setAAD` | fails, never plaintext | PASS |

### 4.1 A test of mine was wrong, and the corrected version is more useful

My first splice test took an older envelope's crypto group under a newer header and expected rejection. **It failed — and it was my test that was wrong, not the code.** Both envelopes share every bound header field (same key id, version, suite), so the spliced AAD is byte-identical to the original's and the splice legitimately decrypts.

That is a real limit of AAD worth recording rather than hiding, so the suite now pins **both** behaviours: a group lifted from a *different* key version is rejected (the substitution AAD actually stops), and re-heading *within the same* key version is explicitly not an attack. AAD binds the header; it does not confer freshness.

## 5. Two files outside the strict lease, flagged for the coordinator

The wire change breaks any consumer that decrypts an ENC-01 envelope. Two more exist besides the one focused suite:

- `tests/enc08-wire-enc07.test.ts` — decrypts the delivery envelope;
- `tests/webhook-delivery-encryption.test.ts` — decrypts the delivery envelope on the webhook surface.

Both are focused tests of this module's wire contract, so I read them as inside "focused tests của nó" and updated each to set the same canonical AAD. **If the coordinator reads the lease more strictly, these two files are the ones to review** — I did not touch any production file outside the lease, and the alternative was leaving the suite red.

## 6. Gaps — stated, not overclaimed

1. **No real external consumer exists in this repository, so there is no live consumer-side evidence.** The tamper tests act as a consumer (the pre-existing `externalDecrypt` helper, which already stood in for the external recipient) and prove the producer binds the header and that a mismatched consumer fails closed. That is **not** the same as verifying a shipped SDK was updated. **Gap: consumer-side evidence chưa có.**
2. **No envelope version bump.** A consumer that has not been updated will fail the tag check rather than mis-decrypt — fail-closed, which is the safe direction, but it is still a breaking wire change. The version field stays `1`; the docblock says so explicitly.
3. **`canonicalDeliveryAad` is not re-exported from `src/modules/public-api/index.ts`.** The barrel is outside this lease, so consumers import from the module path. One line, but it is a follow-up.
4. **`docs/06` still documents the pre-fix consumer contract.** I did not edit it (doc lease is another lane's). The consumer contract needs the AAD step added.

## 7. Whole-suite context — read this before attributing failures

Full `npx jest --runInBand` reports **11 failed suites / 41 failed tests**, against **7 / 27** measured earlier in this session.

**None of that delta is mine.** Evidence:

- all three delivery/crypto suites **PASS** inside the full run (`webhook-delivery-encryption`, `delivery-encryption`, `enc08-wire-enc07`);
- grepping the full-run output for `AAD`, `setAAD`, `canonicalDeliveryAad`, `DELIVERY_SUITE_INCOMPATIBLE` or `delivery-encryption` returns **only PASS lines** — no failure message references this change;
- the newly failing suites are `multipart-service-offline` (whose failing cases are literally titled **RFX-03** — a different packet in the same plan, leased to a different owner), plus `mock-oidc-idp`, `oidc-boot`, `mock-vault-harness-offline.functional`;
- `git status` shows concurrent lanes editing `multipart-service.ts`, `upload-encryption-gateway.ts`, `integrity-scanner.ts` and `storage-migration.ts` — all outside my lease.

So the tree is moving under a shared checkout and the absolute failure count is not a clean signal. The attributable facts are the four focused suites in §4 and the clean typecheck.

**No gate is ticked by this receipt.**