# RFX-CRYPTO-VERIFY — independent verification of RFX-08 / RFX-16

**Task:** RFX-CRYPTO-VERIFY · **Date:** 2026-10-03 · **Status:** verification only. **No file modified**, no gate ticked, no commit, `nocobase-10` not contacted.

Verifying `services/orchestrator/src/modules/encryption/crypto-storage-facade.ts` **+77/-2 uncommitted in the working tree**, on behalf of a lane that could not write its own receipt.

## 1. Verdict

**PASS on the facade change, with one defect recorded that the coordinator must route.**

- The RFX-08 delta is **in scope, complete and internally coherent**, and every test that touches it is green.
- The RFX-16 delta is **exactly what was specified**: a design-rationale note, and **no change to the unwrap ordering**.
- **However**, the acceptance item *fail-closed 413/503 with a clear code* is only half met: the request does fail closed, but with **503 `STORAGE_FAILURE` and the message "encrypted artifact could not be authenticated"** — for an artifact that is authentic and merely too big. See §4, finding F1.

## 2. Scope verification — RFX-08

`git diff --numstat` on the facade: **77 insertions, 2 deletions**. All five hunks are present in the working tree:

| # | expected | verified at |
|---|---|---|
| 1 | `CRYPTO_STORAGE_MAX_DECRYPT_BYTES = 64 * 1024 * 1024` + rationale | `:24` (rationale `:15-23`) |
| 2 | `CryptoStorageFacadeOptions.maxPlaintextBytes?: number` | `:118` (doc), option field |
| 3 | field + constructor validation `1..cap` + assignment | `:510-516` validation, `:546-570` class/ctor |
| 4 | `decryptStream` eager refusal on `manifest.totalSizeBytes`, bound forwarded to the generator | `:749` eager check, generator call passes `self.maxPlaintextBytes` |
| 5 | `decryptChunkGenerator` backstop **before** `yield`, and `SIZE_LIMIT` not relabelled | backstop precedes `yield plaintext`; `catch` re-throws `SIZE_LIMIT` |

**Threshold consistency — CONFIRMED.** `CRYPTO_STORAGE_MAX_DECRYPT_BYTES` (facade `:24`) is `64 * 1024 * 1024`; `server.ts:158 MAX_DECRYPT_BYTES` is `64 * 1024 * 1024`. One cap for one process, as the docblock claims.

*(Observation, not a defect: `MAX_DECRYPT_BYTES` is declared twice in `server.ts`, `:158` and `:2036`. Both are 64 MiB, so they agree today; the duplication is a drift risk, not a current mismatch.)*

**RFX-16 — ordering UNCHANGED, as required.** `decryptChunkGenerator` still opens with `const dek = await this.unwrapDek(manifest.dek)` before any MAC work; the delta only adds a parameter and a docblock. The rationale note is accurate about why that order is mandatory (the MAC key is HKDF-derived from the DEK, so no MAC is verifiable without recovering the DEK first).

## 3. Scope verification — RFX-16 comment quality

The note is substantive rather than decorative: it states the ordering constraint, contrasts it with the single-shot path (which unwraps *after* its keyless AAD check), enumerates what `validateManifest` already rejects before the unwrap is reached, and keeps wrap-wrong and MAC-wrong indistinguishable so the error path is not an oracle. It also honestly records the residual: one Vault call per request, so rate-limiting belongs on the caller.

## 4. Findings

### F1 — `mapCryptoError` flattens `SIZE_LIMIT` into an authentication failure (material)

`artifact-read-decrypt.ts:113-125` maps **every** `CryptoStorageError` to one verdict:

```
if (error instanceof CryptoStorageError) {
  fail(503, 'STORAGE_FAILURE', 'encrypted artifact could not be authenticated');
}
```

Consequences:

- **Wrong status.** The expected refusal was 413; the wire answers **503**.
- **Wrong message, and it is a false statement about the artifact.** A perfectly authentic object that simply exceeds the cap is reported as *could not be authenticated*.
- **It discards exactly the distinction the facade went to real trouble to preserve.** The facade's own catch block re-throws `SIZE_LIMIT` with the comment *"a size refusal is a policy decision, not an authentication verdict"* — and the very next layer flattens it back into an authentication verdict.

**Untested.** Every `SIZE_LIMIT` / `maxPlaintextBytes` assertion in the orchestrator suite is at the facade level (`crypto-storage-plaintext-bound.test.ts`, `crypto-storage-facade.test.ts`). Nothing exercises the status or code through `artifact-read-decrypt` or a route, so this boundary has no coverage in either direction.

*I did not fix it — read-only lease, and the file belongs to the crypto lane.*

### F2 — `collectStream` itself is uncapped (residual, currently safe)

The collector is `artifact-read-decrypt.ts:263-271`, not the facade as the original finding described. It accumulates every chunk into an array and tracks `total`, but uses `total` only for `Buffer.concat(chunks, total)` — **there is no cap in the collector**.

This is currently safe because the **producer** refuses: the eager check reads the declared total before any chunk exists, `validateManifest` pins chunk sizes to that total, and the generator backstops mid-stream. So the OOM the finding described is closed *at the source*. But the guarantee is entirely inherited: any future caller that collects a `decryptStream` without the facade's bound has no second line of defence. A cap in the collector would be cheap defence-in-depth.

### F3 — scope note on a co-modified file

`artifact-read-decrypt.ts` is **also** modified in the working tree, but that diff is **manifest `VersionId` pinning** (`readManifest(key, versionId?)`, `SealedArtifactRef.manifestVersionId`). That is **RFX-05** territory, not RFX-08/16. **I verified only the facade**, and this receipt makes no claim about the RFX-05 work.

## 5. Tests run (literal)

```
# orchestrator crypto facade suites
cd du-rework/services/orchestrator
npx jest --runInBand --runTestsByPath tests/crypto-storage-facade.test.ts \
      tests/crypto-storage-plaintext-bound.test.ts tests/artifact-read-decrypt-offline.test.ts
-> exit 0   Test Suites: 3 passed, 3 total / Tests: 137 passed, 137 total

# guard byte-identity (worker-sdk side; green after RFX08-PARITY, as expected)
cd du-rework/packages/worker-sdk
npx jest tests/crypto-seam.test.ts -t "byte-identical"
-> exit 0   Tests: 13 skipped, 1 passed, 14 total

# orchestrator typecheck
cd du-rework/services/orchestrator
npx tsc --noEmit -p tsconfig.json
-> exit 0, no output
```

**On the CRX-02 caveat the dispatch raised:** no temporary `server.ts` TypeScript error materialised at the time of this run — `tsc --noEmit` was clean, so nothing needed excluding. I am recording that as an observation at this timestamp rather than as a permanent fact; a shared checkout can change under a later run.

## 6. What this verification does NOT prove

1. **No live evidence.** No PostgreSQL, S3 or Vault call was made. Every test uses an in-memory key provider standing in for the transit provider, so *"one Vault call per request"* — the cost RFX-16's note accepts — is reasoned, not measured here.
2. **No memory-pressure measurement.** The retention test counts bytes a collector holds; it does not observe process RSS under a real heap ceiling. It is byte-accounting evidence, not an OOM reproduction.
3. **The single-shot decrypt path is out of this delta's scope** and unchanged. It is bounded by the pre-existing 5 MiB single-shot limit, so this finding does not apply to it — but I did not re-verify that bound here.
4. **Concurrency.** The bound was verified single-threaded; no interleaving of two decrypts against one facade was exercised.

## 7. Recommended follow-ups (not performed)

1. **Route F1 to the crypto lane.** Either map `SIZE_LIMIT` to 413 in `mapCryptoError` with a message that says *too large*, or state deliberately that size is deliberately flattened (and then drop the facade's careful preservation, which is currently misleading). Right now the two layers disagree.
2. **Add the missing boundary test** — an over-limit artifact driven through `artifact-read-decrypt` or a route, asserting the status and code actually seen on the wire.
3. **Optionally cap `collectStream`** so the guarantee is not solely inherited from the producer.

**No gate is ticked by this receipt.**