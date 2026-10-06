# CONTROL-PLANE-POLICY-FIX-822 — receipt (qwen_1, 2026-10-05)

Task task_f9ba883d53e9. Lease: metadata-read-policy.ts + its test only.

## The bypass (confirmed on disk, as reported)

metadata-read-policy.ts readStored had:

  if (!crypto) { assertReadableWithoutSeam(value); return value; }

The no-seam branch returned raw plaintext WITHOUT ever calling
policy.allowPlaintext(). readStoredText delegated to the crypto helper, whose
own no-seam branch does the same. So in mode forbid, and after the window
expired, a never-sealed value was still handed back raw — the one control
point was skipping the policy it exists to enforce, and it was invisible
because the policy looked installed.

## The fix (metadata-read-policy.ts only)

Both read paths now apply the SAME rule, in this order:

  1. assertReadableWithoutSeam(value)  — kept, NOT replaced by the policy.
     A sealed value with no seam still fails closed KEY_PROVIDER_FAILED.
  2. if (!policy.allowPlaintext()) throw MetadataCryptoError(NOT_SEALED, ...)
     — a never-sealed value is returned raw ONLY while the policy allows it.

readStoredText no longer delegates the no-seam case to the crypto helper
(that helper would return the raw value verbatim — the exact bypass), so the
gate is applied in the reader itself, with the same null/undefined and
non-string guards the helper uses. The crypto-present path is unchanged:
crypto.readStored / readStoredText already receive policy.allowPlaintext().

New helper plaintextReadRefused() emits MetadataCryptoError code NOT_SEALED
(the same code the crypto module uses for a plaintext read outside the
window), so callers cannot tell the two apart by error shape.

## Tests (item 4 + 5)

The old test asserted the WRONG behaviour ("with no seam, a never-sealed value
passes through verbatim" under a forbid policy) — it was the proof that the
bypass existed. Replaced by the four required cases, each asserted on BOTH
readStored and readStoredText:

  1. forbid + no seam + unsealed  -> rejects NOT_SEALED
  2. forbid + no seam + sealed    -> rejects KEY_PROVIDER_FAILED
  3. expired window + no seam + unsealed -> rejects NOT_SEALED
  4. open window + no seam + unsealed     -> passes verbatim (plus null -> undefined)
  5. open window + no seam + sealed       -> rejects KEY_PROVIDER_FAILED

## Verification (real numbers)

- npx tsc --noEmit -p tsconfig.json => Exit Code 0, no output.
- npx jest tests/metadata-read-policy.test.ts tests/crx01-metadata-wiring.test.ts
  tests/encmeta-resultref-offline.functional.test.ts --silent =>
  Test Suites: 3 passed, 3 total; Tests: 32 passed, 32 total; Exit Code 0.
  (metadata-read-policy alone: 24 passed, 24 total, Exit Code 0.)
- Full orchestrator suite NOT re-run this packet (packet asked for focused
  suites + tsc). Last full measurement, before this fix: 190 passed / 4
  failed suites, 4745 passed / 9 failed tests, tsc exit 0.

## Item 7 — the four strict-false paths, re-verified on disk

  runtime.ts:366                      false   (prompt carrier reader)
  ingestion-consumer.ts:348            }, false)  (dispatch sourceUrl envelope)
  metadata-auth-counter.ts:291,297    }, false)  (A11 counter)
  metadata-crypto.ts:427               crypto.readStored(parsed, context, false)

None of the four was edited; none was widened.

## Behaviour change to flag to the operator

A deployment with NO metadata seam and mode=forbid (or an expired window) now
reads legacy plaintext rows as NOT_SEALED instead of returning them raw. That
is the intended semantics of forbid — plaintext is refused until the rows are
sealed — but it is a real behaviour change on the no-seam path, and it is why
the backfill CLI (item 7 of 818) must run before the window closes.

No commit, no tick, no migration edit, no A2 flip, no DB/Redis/S3/Vault.
