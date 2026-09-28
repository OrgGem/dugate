
## Cycle 25 (2026-09-28) — W-ENC-04-GRANT-SCHEMA, task_34d34cbfbe44 / ctx_9b165ca0357b — DELIVERED

- **Muc 25 receipt** at `qwen-platform.md:2458`; ledger row 25 at line 122.
- **PACKET NAMED THE WRONG FILE (again).** `ArtifactAccessGrantSchema` is in `runtime.ts:226`, NOT
  `operations.ts` (grep there = 0 matches). `operations.ts` holds the RECIPIENT-DELIVERY envelope
  (public key, EncryptedArtifactDownloadSchema) — a different thing from the storage envelope.
  Conflating them = confusing ENC-03 (at rest) with ENC-05/07 (delivery). Edited runtime.ts only.
- **KEY DESIGN FACT worth remembering:** TWO DEK shapes coexist and they differ in FIELD NAMES.
  - contracts `WrappedDekEnvelopeSchema` (encryption.ts:67) = keyId / wrappedKey / nonce / tag (ADR-18
    delivery/wrap, recipient-facing).
  - runtime `vault-transit-provider.ts:42` `WrappedDek` = keyRef / keyVersion / ciphertext (storage
    path; worker-sdk mirrors it as a LOCAL type, so worker-sdk has no import of contracts here).
  I added `StorageWrappedDekSchema` matching the RUNTIME, not the ADR-18 schema. Reusing the ADR-18
  one would yield a contract the facade can never satisfy, and every real object would fail for the
  wrong reason. Logged as **delta 60** (technical debt: two contracts for one concept; someone must
  unify the names or add a mapping table to docs/15-decisions.md — I did NOT unify, it would break
  the wire with the running facade).
- **Also measured (not assumed):** `aad` in the stored envelope IS base64 (`crypto-storage-facade.ts:528`
  = `aad.toString('base64')`; the JSON is *inside* the base64). So `EnvelopeCiphertextSchema`'s base64
  regex is correct — reusing it was safe.
- `StorageEnvelopeRefSchema` deliberately has NO `ciphertext` field (bytes travel via `downloadUrl`)
  and NO manifest field (runtime manifest uses `manifestMac`, contract has no MAC field yet = delta 44).
  `keyVersion` is REQUIRED, not optional: guessing "latest" would unwrap under a rotated key and fail
  auth for the wrong reason.
- **EOL TRAP (cost me a wasted attempt):** `packages/contracts/src/runtime.ts` is **CRLF** (467 CRLF /
  0 LF); `encryption.ts` and the test files I created are **LF**. My first patch used `\n` anchors and
  silently missed — the file was NOT damaged, but I had to redo it CRLF-aware. Always measure per file.
- **My test was wrong, not the schema:** first run was 12/13. I asserted `WrappedDekEnvelopeSchema`
  accepts the delivery shape, but my fixture omitted `version: 1`. Fixed the FIXTURE. Same lesson as
  cycle 20/24 — when a new test goes red, ask who is wrong before editing the source.
- **Mutation discipline:** M1 (`encryption` made required) = 1 red; M2 (drop byte-length refines,
  `.strict()` kept) = 3 red. I had to rebuild M2 twice: attempt 1 removed 6 lines instead of 8 leaving
  a syntax error (`Tests: 0 total` — NOT evidence), attempt 2 removed `.strict()` too (2 variables at
  once, 4 reds). Only the third run was a clean single-variable probe. `Tests: 0 total` must never be
  reported as a mutation result.
- **Verify**: new suite 13/13 Exit 0; FULL @du/contracts **23/23 suites, 462/462 tests** Exit 0;
  `tsc --noEmit` Exit 0 on contracts AND orchestrator AND worker-sdk (I typecheck downstream whenever I
  touch a shared contract). Restore byte-exact: runtime `71c0458e`/20832 B, encryption `395e0880`/13973 B.
- **Foreign failures that self-resolved:** baseline was 12 suites FAILING to run (TS errors in
  Cost-lane files: usage-reconciliation.ts `Cannot find name 'NonNegativeIntSchema'`, mtime 01:22 that
  day). By the end of my task they were green — Cost fixed their own files. 20 + 1 (mine) + 2 (other
  lanes' new suites) = 23. Do not claim other lanes' cleanup.
- **Δ59 CLOSED by coordinator decision: do NOT bind lease epoch into the checkpoint AAD.** Rationale I
  agree with and recorded so no future cycle re-raises it: a retry is a NEW epoch, so binding epoch
  into AAD would make the previous checkpoint unopenable, destroying the idempotent replay that
  checkpoints exist to provide. Did not touch `step-checkpoint.ts`.
- **Δ57 is 1/3 done.** Items 2-3 (worker-sdk read-path decrypt + orchestrator emitting the envelope in
  the grant) are outside this task's scope. ENC-04 is NOT closed; the contract is now ready for 2-3.
- `send_message` to coordinator FAILED again ("No active team and no task_id, cross-session messaging
  is off"). Note: `send_message` is NOT callable via `tools.send_message` inside exec — it must be a
  direct call. Receipt file is the only working submission channel.
