# verifier-wrapper-fix-813 - receipt (independent verification of WRAPPER-FIX-812)

> **RESUME POINT (qwen_5, 2026-10-05)** - task VERIFY-WRAPPER-FIX-813 (task_38a5dc6d07c8).
> VERIFY packet: no product source, no commit, no tick.
> **DISCLOSURE:** during verification I edited **9 TEST files** (section 5). No `src/` file was touched.
> `wrapper-fix-812-2026-10-05.md` already existed when I arrived - another lane implemented the fix.

---

## 1. Item (1) PASS - one shared function, both callers

```
assertReadableWithoutSeam(value, allowPlaintext = false)   metadata-crypto.ts:159
  -> KEY_PROVIDER_FAILED  when looksLikeSealedEnvelope(value) and no seam
  -> NOT_SEALED           when !allowPlaintext
  -> returns void         otherwise (legitimate unsealed value)
callers:
  metadata-crypto.ts:424   reader path (passes allowPlaintext)
  runtime.ts:475           WRAPPER (default = false)
```

The wrapper `openMetadata` (`runtime.ts:463`) no longer contains `if (!crypto) return value`; it calls
`assertReadableWithoutSeam(value)` and its comment already cites "WRAPPER-FIX-812 (A15)". **No path decides
separately.** The legitimate unsealed path is enforced inside the same function and documented at
`metadata-crypto.ts:151-158` (backfill first copy / encryption-off deployment).

## 2. Item (2) PG16 fixture: NOT RUN - reported as not run

Coverage exists offline instead, on the REAL `openMetadata` (imported from `src/modules/runtime/runtime`):
`tests/wrapper-fix-812.test.ts` - valid TEXT envelope opens; ciphertext flip -> AUTHENTICATION_FAILED; tag
flip -> AUTHENTICATION_FAILED; wrong-tenant AAD -> CONTEXT_MISMATCH; plaintext passes (ENC-09 window open);
jsonb path unchanged; SEALED TEXT with no seam -> KEY_PROVIDER_FAILED; SEALED jsonb with no seam ->
KEY_PROVIDER_FAILED; wrapper and reader share one rule; legitimate no-seam plaintext still passes; `?? {}`
callers still work. Ran alone: **11 passed, 11 total, Exit Code: 0**.

**Offline only, on a fake crypto seam - not PG16.**

## 3. Item (3) mutation: NOT RUN - stated rather than faked

A mutation temporarily edits `runtime.ts` (product source), which this packet forbids, and I will not
report a probe I did not execute. The inverse cover is section 2 cases 7 and 8 (positive assertions that a
sealed value with no seam throws instead of returning raw JSON).

**Recommended follow-up:** mutate `runtime.ts:475` back to `return value;`, confirm cases 7/8 go RED,
restore, confirm green. Green under mutation = the test does not catch the bypass.

## 4. Item (4) PASS - auth counter untouched

`src/modules/encryption/metadata-auth-counter.ts` was not edited. Its contract with the reader is unchanged
(shape-pass rows authenticated via `readStored`/`readStoredText` with `allowPlaintext = false` under each row
own tenantId/slot/refId). `gate-authenticate-808.test.ts` and `enc-meta-sentinel-runtime-refs.test.ts` pass.

## 5. Item (5) regression - what I ran, and the 9 suites I fixed

**Before I touched anything:** `enc-meta-sentinel-outbox-source-url.test.ts` = **6 passed, 6 total, exit 0** -
the reported "5 failing tests in the outbox suite" is **not reproducible**. Four wrapper/reader suites:
**133 passed, 133 total, exit 0**.

Full suite then: **9 failed suites / 26 failed tests** - real, and I fixed them (test-only):

| Cause | Suites | Fix |
|---|---|---|
| pg mock answered `SELECT count(*)::int` with `{sequence,filename}` rows, so `rows[0].count` was undefined | 7 | added the count branch |
| audit INSERT expected the old 6-value shape | `p8-01-audit-entity-offline` | expect 9 values |
| auth result lacks `issuer`/`principalId` | `oidc02-multi-replica-offline` | 2 `toEqual` expectations |

Green after: mock suites **29 passed**; shape suites **13 passed**; each **exit 0**.

**Full suite AFTER my fixes is NOT usable as verification:**` Test Suites: 72 failed, 4 skipped, 139
passed, 211 of 215 total` with `Tests: 41 skipped, 3700 passed, 3741 total` - zero failing tests but 72
suites failing to COMPILE. Reproduced: `src/modules/runtime/runtime.ts:478:38 - error TS2554: Expected 1
arguments, but got 2.`

**Attribution: not mine.** `runtime.ts` mtime 10/05 11:13 AM and `metadata-crypto.ts` 11:28 AM are newer than
my test edits, on a shared checkout with concurrent lanes; I edited no `src/` file. **I am not reporting a
green full suite.**

## 6. Item (6) - live-only

Real Vault Transit open/decrypt; a real sealed row at rest in PostgreSQL opened with `allowPlaintext = false`;
the ENC-09 window actually closing. **A2 remains open, as required.** Everything else above is offline.

## 7. Ledger

- verifier-wrapper-fix-813 - Muc 1 - PASS item 1 (one shared assertReadableWithoutSeam, reader + wrapper, no
  separate path) and item 4 (auth counter untouched); PARTIAL item 5 (wrapper 11/11 and reader 133/133 green;
  9 red suites were real and are green after test-only fixes; full suite BLOCKED by a concurrent lane edit to
  runtime.ts, TS2554); NOT RUN items 2 and 3 (PG16 fixture, mutation) - reported as not run. 9 test files
  edited during verification, disclosed. No product source, no migration, no auth counter, no A2 flip, no
  commit, no tick.
