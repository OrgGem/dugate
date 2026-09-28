
## Cycle 24 (2026-09-28) — W-ENC-04-DOC-CORE, task_94c2532781b3 — BLOCKED

- **Muc 24 receipt** at `qwen-platform.md:2353`; ledger row 24 at line 121.
- **0 product files changed.** 1 test added: `packages/worker-sdk/tests/enc-read-roundtrip-proof.test.ts`.
- Packet asked for 3 things in `businesses/document-core/src/actions/`. **Two are impossible at that
  layer**; I did not fake either.
- **(a) encrypted input streams — NOT ACHIEVABLE in document-core.** The seam is ASYMMETRIC in
  worker-sdk: write path (`task-context.ts:601-610`) seals and uploads ONLY
  `sealed.encrypted.ciphertext`; read path (`:637-660`) calls `openArtifactStream` and returns raw
  bytes with NO decrypt anywhere. The envelope metadata needed to open is DISCARDED — counts in
  `task-context.ts`: `nonce` 0, `tag` 0, `aad` 0, `dek` 0, `EncryptedStorageObject` 0. Proof test
  against the REAL facade passes: stored != plaintext, no sentinel leak, and **read() returns
  ciphertext**. This is a SILENT data-loss bug, not a missing feature — enabling the seam makes
  every written artifact unreadable, with no throw.
  A proper fix spans worker-sdk + contracts + orchestrator (Δ57) = outside my write scope.
- **(b) checkpoint lease validation — NOT ACHIEVABLE.** `leaseEpoch`/`leaseExpiresAt` never cross
  the adapter (grep in `src/worker.ts` = 0 matches); `TaskContext` has neither. `assertActive` only
  sees `signal.aborted`, which is a downstream symptom of a prior 409, not proof the lease is live.
  Adding the field would be a predicate with no source of truth — the "looks checked but isn't"
  pattern I already criticised in Muc 20.
- **(c) checkpoints sealed — ALREADY DONE in cycle 20** (`toStoredForm`/`fromStoredForm`,
  `assertEncryptionAvailable` fail-closed). I verified, did not re-claim it.
- **Verify**: doc-core 46/46 suite 542/542 test Exit 0; worker-sdk 19/19 suite 312/312 test Exit 0
  (18 baseline + my 1); `tsc --noEmit` Exit 0 on BOTH with empty logs.
- **Δ57** BLOCKER needing new scope. **Δ58** do NOT enable the seam until Δ57 lands — which makes
  Δ45 ("no deployment has the seam on") turn out to be the CORRECT state, not a lag. **Δ59** open
  design question for the coordinator: binding leaseEpoch into the checkpoint AAD would break
  idempotent replay, because a retry is a new epoch and the old checkpoint would no longer open.
  I did not decide that myself.
- **Rule reinforced**: when the packet's premise is wrong, prove it with a real test and report the
  blocker. A green suite was never the goal; a correct one was.
