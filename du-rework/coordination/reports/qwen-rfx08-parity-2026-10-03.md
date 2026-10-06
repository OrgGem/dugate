# RFX08-PARITY — plaintext bound ported to worker-sdk, guard green

**Task:** RFX08-PARITY · **Date:** 2026-10-03 · **Status:** implemented and verified. No gate ticked; no commit; `nocobase-10` not contacted.

**Lease honoured:** `packages/worker-sdk/src/crypto-storage.ts` + one new focused test. The orchestrator facade was **not touched**.

## 1. Which guard was red, confirmed on this machine

```
cwd: du-rework/packages/worker-sdk
$ npx jest tests/crypto-seam.test.ts -t "byte-identical"
```

**Before** — `Test Suites: 1 failed, 1 total` / `Tests: 1 failed, 13 skipped, 14 total`; failure at `crypto-seam.test.ts:109` `expect(mine).toBe(theirs)`, diff `- Expected - 77 / + Received + 2`.

**After the port** — `Test Suites: 1 passed, 1 total` / `Tests: 13 skipped, 1 passed, 14 total`.

That is the guard named in `cc-conv04-decision-pack-2026-10-03.md` §1.8: the W-ENC-04 port-fidelity check comparing the two implementations as source.

## 2. What was ported

The source of truth was the facade's **uncommitted working-tree state**, not HEAD. `git diff` on `services/orchestrator/src/modules/encryption/crypto-storage-facade.ts` gives +77/−2, and the port is **+77/−2 as well** — the same shape, which is the strongest cheap signal that nothing was dropped or invented.

| # | RFX-08 change | where it landed in worker-sdk |
|---|---|---|
| 1 | `CRYPTO_STORAGE_MAX_DECRYPT_BYTES = 64 * 1024 * 1024` + rationale | `src/crypto-storage.ts:64-72` |
| 2 | `CryptoStorageFacadeOptions.maxPlaintextBytes?: number` | `:162-172` |
| 3 | `maxPlaintextBytes` field, constructor validation (1..cap), assignment | `:546-570` |
| 4 | `decryptStream`: eager `manifest.totalSizeBytes > maxPlaintextBytes` -> `SIZE_LIMIT`, and pass the bound to the generator | `:744-758` |
| 5 | `decryptChunkGenerator`: RFX-16 rationale docblock, new parameter, pre-yield backstop, and `SIZE_LIMIT` not relabelled as `AUTHENTICATION_FAILED` | `:878-964` |

Hunk 5 carries two behaviours that are easy to lose and are explicitly preserved: the bound is checked **before** `yield` (the caller keeps every chunk it is handed), and the `catch` re-throws a `SIZE_LIMIT` rather than converting it into an authentication verdict.

The worker declares its own two-method `CryptoKeyProvider` port instead of importing the orchestrator's three-method `KeyProvider`; the guard normalises that alias, which is why the byte-identity holds without touching the type.

## 3. Focused tests added

New file `packages/worker-sdk/tests/crypto-storage-plaintext-bound.test.ts` (7 tests, mirrors the orchestrator's RFX-08 suite in intent):

| test | proves |
|---|---|
| defaults the bound to the delivery cap and rejects nonsensical overrides | `CRYPTO_STORAGE_MAX_DECRYPT_BYTES === 64 MiB`; 0/-1/1.5/NaN/cap+1 rejected, 1 and cap accepted |
| round-trips a chunked artifact under the bound | under-limit decrypt returns exact plaintext |
| keeps an artifact at exactly the bound readable | the bound is inclusive |
| refuses an over-limit artifact before touching the body or the key provider | eager refusal; `unwrapCalls` unchanged, so no Vault call is spent |
| reports a size refusal as `SIZE_LIMIT` | not `AUTHENTICATION_FAILED` |
| stops emitting plaintext when the running total crosses the bound | backstop fires before the yield; caller never holds the crossing chunk |
| bounds what a collecting reader retains | a collector cannot accumulate without limit |

**Why a behaviour suite when a byte-identity guard exists:** the guard proves the two *sources* agree. It would not catch a behaviour regression that both copies shared, and it says nothing about whether the bound actually fires. Both kinds of evidence are wanted; the orchestrator has the same pair.

### Two of my own test cases were wrong first — recorded because the failures were informative

1. I sized the "exactly at the bound" fixture at 4 MiB. `encryptStream` refuses anything at or below the 5 MiB single-shot limit, so the fixture was rejected as too small to chunk at all. Raised to 6 MiB with the bound set equal to it.
2. My "collecting reader" case wrapped only the iteration in `rejects`, but `decryptStream` throws **synchronously** at the eager check, so the error escaped before the assertion. It now drives the generator seam, which is also the only place the incremental backstop is observable — `decryptStream` refuses on the declared total before any chunk exists. Both points are now comments in the test.

## 4. Verification (literal)

```
cd du-rework/packages/worker-sdk

npx jest tests/crypto-seam.test.ts -t "byte-identical"                        -> exit 0
   Test Suites: 1 passed, 1 total / Tests: 13 skipped, 1 passed, 14 total

npx jest tests/crypto-storage-plaintext-bound.test.ts                          -> exit 0
   Test Suites: 1 passed, 1 total / Tests: 7 passed, 7 total

npx jest tests/crypto-seam.test.ts tests/crypto-storage-plaintext-bound.test.ts \
        tests/rv01-03-fail-closed.test.ts tests/enc-read-roundtrip-proof.test.ts -> exit 0
   Test Suites: 4 passed, 4 total / Tests: 39 passed, 39 total

npx tsc --noEmit                                                            -> exit 0, no output

npx jest --runInBand   (whole package)                                       -> exit 0
   Test Suites: 26 passed, 26 total / Tests: 676 passed, 676 total
```

**Guard status, named explicitly as asked:** `crypto-seam.test.ts` **byte-identical** was RED, is now GREEN. No other guard was consulted, and no other guard was found to be red.

## 5. Residual and honest limits

1. **No change was needed on the facade, so none was made.** The packet anticipated a possible residual; there is none. RFX-08's facade side stands as its lane left it, uncommitted.
2. **This lane does not decide CONV-04 A/B.** Untouched, as instructed. What this port removes is the *asymmetry* the decision pack flagged — worker-sdk no longer lacks the bound — so whichever way A/B goes, the two copies start from parity rather than from one hardened and one not.
3. **The guard proves source identity, not behaviour.** It will stay green if both copies are changed together into something wrong. The new suite is what pins the behaviour; treat the pair as one unit.
4. **No production consumer of this path exists in-repo yet.** Per the decision pack §1.7, worker-sdk's *stream* decrypt has an API but no in-repo production consumer (document-core uses the single-shot seal path). So this is defence-in-depth for a path not yet consumed here, not a closed live hole. **I am not claiming user-visible impact.**
5. **Two tests are slow** (~16 s each, 36 s for the suite) on the 6 MiB chunked fixtures. Same shape and cost profile as the orchestrator's RFX-08 suite; left as-is rather than shrinking coverage, but worth knowing before this lands in a tight CI budget.
6. **Both copies are still uncommitted** (facade by RFX-CRYPTO, worker-sdk by this lane). The guard compares the working tree, so it stays meaningful now and will need a re-run after any rebase of either file.

**No gate is ticked by this receipt.**