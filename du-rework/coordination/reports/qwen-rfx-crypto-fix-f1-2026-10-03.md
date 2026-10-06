# RFX-CRYPTO-FIX-F1 — F1 cannot be fixed inside this lease (proposal attached)

**Task:** RFX-CRYPTO-FIX-F1 · **Date:** 2026-10-03 · **Status:** **STOPPED, nothing modified.** No file edited, no gate ticked, no commit, `nocobase-10` not contacted.

## 1. Why this stopped

**Finding F1 is not in the leased file.** The lease is `crypto-storage-facade.ts` + its focused tests, with *khong sua file khac*. But the facade is already correct:

- `crypto-storage-facade.ts` throws `CryptoStorageError('SIZE_LIMIT', ...)` in **six** places, including both decrypt refusals — `:701` (eager, in `decryptStream`) and `:902` (mid-stream backstop, in `decryptChunkGenerator`);
- auth failures throw `CryptoStorageError('AUTHENTICATION_FAILED', ...)`;
- the facade's own catch block deliberately **re-throws `SIZE_LIMIT`** instead of relabelling it (`"A size refusal is a policy decision, not an authentication verdict"`).

The classification the packet asks me to introduce **already exists**. The taxonomy is intact at the producer.

**The defect is one layer downstream, in a file this lease does not cover:** `modules/encryption/artifact-read-decrypt.ts:113-125`, `mapCryptoError()`, maps *every* `CryptoStorageError` — `SIZE_LIMIT` included — to a single verdict. I will not edit that file under this lease.

**A facade-side change is also blocked, twice over.** (a) It could not fix the wire behaviour at all, because the consumer's mapping is what flattens it. (b) Any edit to the facade breaks the `crypto-seam.test.ts` byte-identity guard, and `packages/worker-sdk/src/crypto-storage.ts` is **also** outside this lease — so the two copies could not be kept in step. Both readings of the lease are foreclosed; the fix has to land in the consumer.

## 2. Baseline recorded (nothing changed, so this is the starting state)

```
cd du-rework/services/orchestrator
npx jest --runInBand --runTestsByPath tests/crypto-storage-facade.test.ts \
      tests/crypto-storage-plaintext-bound.test.ts tests/artifact-read-decrypt-offline.test.ts
-> exit 0   Test Suites: 3 passed, 3 total / Tests: 137 passed, 137 total

npx tsc --noEmit -p tsconfig.json
-> exit 0, no output
```

The worker-sdk byte-identity guard was green as of the verify pass (`exit 0`, `1 passed, 13 skipped`) and is untouched by this packet, since I changed nothing.

## 3. Taxonomy decision for the proposed patch

The packet says to choose from the existing `CryptoStorageError` taxonomy and to record the choice. Two candidates were considered:

| candidate | verdict |
|---|---|
| map to the facade's `CryptoStorageError.code` (`SIZE_LIMIT`) onto the wire | rejected — `SIZE_LIMIT` is an internal storage code, not a published public error code |
| **`413` + `TOO_LARGE`** | **chosen** — `TOO_LARGE: 413` is in `STATUS_CODES` (`packages/contracts/src/errors.ts:15`) and `'TOO_LARGE'` is in `PublicErrorCodes` (`:34`). Published, already mapped to 413, no new vocabulary. |

**Incidental finding while checking:** the existing auth-failure path emits `STORAGE_FAILURE`, which **appears nowhere in `packages/contracts`**. It is an unpublished code on a public surface. The packet forbids changing auth-failure behaviour, so I have not proposed changing it — but it should be reconciled separately, or the two paths should both be drawn from `PublicErrorCodes`.

## 4. Proposed patch — `artifact-read-decrypt.ts` (NOT applied, needs a lease extension)

```diff
 function mapCryptoError(error: unknown): never {
   if (error instanceof HttpError) throw error;
   if (error instanceof CryptoStorageError) {
+    // RFX-08 / verify F1: a size refusal is a policy decision, not an
+    // authentication verdict. The facade throws SIZE_LIMIT for both the eager
+    // decryptStream check and the mid-stream backstop, and deliberately
+    // re-throws it instead of relabelling - flattening it here told the caller
+    // a perfectly authentic artifact was unauthentic. TOO_LARGE is the
+    // published public code for 413 (PublicErrorCodes, errors.ts:34).
+    if (error.code === 'SIZE_LIMIT') {
+      fail(413, 'TOO_LARGE', 'encrypted artifact exceeds the maximum decryptable size');
+    }
     // AUTHENTICATION_FAILED covers a wrong key, a tampered body, and a context
     // (tenant/artifact/version) that does not match. They are deliberately
     // indistinguishable to the caller: telling them apart turns the endpoint
     // into an oracle for probing which part of the binding was wrong.
     fail(503, 'STORAGE_FAILURE', 'encrypted artifact could not be authenticated');
   }
   fail(503, 'STORAGE_FAILURE', 'encrypted artifact could not be read');
 }
```

**Why this placement catches both refusals:** the eager check throws synchronously while evaluating `collectStream(deps.facade.decryptStream(...), ...)` at `:245-247`, and the backstop throws from inside the generator during `collectStream`'s `for await`. Both are inside the `try` at `:241`, so both reach `mapCryptoError` at `:253`.

**Threshold and auth behaviour untouched.** The patch adds one branch before an existing `fail(...)` that already returns `never`; no threshold, no ciphertext handling and no auth path is modified.

**`instanceof` is safe here:** `artifact-read-decrypt.ts:27` imports `CryptoStorageError` from `./crypto-storage-facade` — the same module that throws it — so there is no cross-graph identity split to guard against.

## 5. Proposed test — `tests/artifact-read-decrypt-offline.test.ts` (NOT applied)

The packet asks for three cases; the first two exist at facade level only, and **nothing currently drives a size refusal through the consumer**, which is why F1 survived the RFX-08 suite. The missing test is:

| case | assertion |
|---|---|
| authentic artifact over the bound, through `decryptStoredArtifact` | rejects with status **413**, code **`TOO_LARGE`**, message saying *size* — not *authenticated* |
| tampered ciphertext, same size | still **503** with the unchanged auth message (**regression guard for the auth path**) |
| authentic artifact under the bound | round-trips to the exact plaintext |

## 6. What I need from the coordinator

**Extend the lease to `services/orchestrator/src/modules/encryption/artifact-read-decrypt.ts` + `tests/artifact-read-decrypt-offline.test.ts`**, and the patch in §4 plus the test in §5 apply as written.

Alternatives, if the lease cannot move:

1. **Route F1 back to the crypto lane** that owns `artifact-read-decrypt.ts` (it is already modifying that file for RFX-05).
2. **Accept F1 as documented-and-closed** on the basis that the producer is correct and the consumer's 503 is a deliberate anti-oracle choice — if so, the facade's SIZE_LIMIT preservation becomes misleading and should be dropped rather than left looking like a distinction that survives to the wire.

I do not recommend (2) as-is: the current pairing asserts the distinction in one layer and denies it in the next.

## 7. Limits of this packet

- **No code was changed**, so nothing here should be read as a fix or as acceptance of RFX-08's wire behaviour.
- Only the facade was re-read for this packet. The consumer analysis rests on `mapCryptoError` at `:113-125` and the two throw sites at `:245` and `:263`, all read in this session.
- The worker-sdk guard was not re-run in this packet (nothing changed); its green state is from the verify pass minutes earlier.
- Still not proven by anything in this receipt: live Vault/S3 behaviour, and the wire status for the mid-stream backstop as opposed to the eager refusal.

**No gate is ticked by this receipt.**