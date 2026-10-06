# CONTROL-PLANE-IMPL-818 — receipt (qwen_1, 2026-10-05)

Task task_d5817daaa30a. Packet CONTROL-PLANE-IMPL-818.

HEADLINE: the 8 uncontrolled allowPlaintext=true LITERALS ARE GONE.
Every policy-governed control-plane read now routes through ONE MetadataReader
built once at boot from DU_METADATA_PLAINTEXT_READ_MODE (closed enum: window | forbid).

## Verification (item 10, real numbers)

- npx tsc --noEmit -p tsconfig.json  => Exit Code 0, no output.
- npx jest --silent (full orchestrator suite) =>
  Test Suites: 4 failed, 26 skipped, 190 passed, 194 of 220 total
  Tests: 9 failed, 230 skipped, 4745 passed, 4984 total
- npx jest tests/metadata-read-policy.test.ts => 21 passed, Exit Code 0.
- npx jest tests/encryption-boot-options.test.ts => 29 passed, Exit Code 0,
  after moving my boot gate out of that function (Delta 1).

## Item status

1 DONE  src/modules/encryption/metadata-read-policy.ts created: closed enum,
   MetadataReadPolicy, createMetadataReadPolicy, decidePlaintextRead,
   MetadataReader, createMetadataReader, createCompatibilityMetadataReadPolicy,
   compatibilityMetadataReader, isMetadataReader, MetadataReadPolicyError,
   plus the error/decision table in the header comment.
2 DONE  boot-options.ts gained 3 env consts (DU_METADATA_PLAINTEXT_READ_MODE,
   _WINDOW_START, _WINDOW_END) and buildMetadataReadPolicy(env). assembleApp
   (create-app.ts) builds the policy ONCE right after metadataCrypto and builds
   ONE reader. Absent mode on a real boot => fail, not continue.
3 DONE  reader injected into createRuntimeService, threaded through
   http/route-context.ts (RouteContext.metadataReader), plus mappers.ts,
   public.ts, ingestion-consumer.ts. submission.ts has NO read path at all
   (grep for readStored / openMetadata / assertReadableWithoutSeam = 0), so it
   takes no reader field (Delta 2: do not add dead code).
4 DONE  8 of 8 replaced: runtime.ts openMetadata both branches, getChildren,
   reconcileParentJoin; public.ts:542; mappers.ts input_ref and result_ref;
   ingestion-consumer.ts:700. Post-change grep over src/ finds 0 reads
   passing a literal true.
5 DONE  4 strict paths kept strict: runtime.ts prompt reader,
   ingestion-consumer sourceUrl, metadata-auth-counter, metadata-crypto.ts
   internal decode. None of those four was edited.
6 OPEN  countUnsealedWithAuth already accepts expectedTenantIds; the caller
   (CLI, item 7) must pass SELECT id FROM tenants, else coverage.reasons keeps
   the census-missing reason forever and the gate can never PASS.
7 OPEN  backfill-metadata-cli.ts, package.json script, and the 6 jsonb slots
   not done yet. See RESUME POINT.
8 OPEN  metric and authorized auto-close not done yet. See RESUME POINT.
9 DONE  tests/metadata-read-policy.test.ts, 21/21: enum shape, typo rejection,
   window/forbid decision table, no-seam rules, sealed fail-closed,
   seam-forwarding (open vs expired), compat 14-day bound, memoization,
   env parser negatives.
10 DONE counts above, run twice; the first run exposed 11 failures that were
    MINE and are fixed.

## Deviations

Delta 1: the boot gate lives in main.ts, not inside buildEncryptionBootOptions.
First attempt put buildMetadataReadPolicy() inside buildEncryptionBootOptions
and turned 11 tests in tests/encryption-boot-options.test.ts RED, because those
tests assert OTHER refusals (missing token, identical tokens, bad URL, bad
transitMount) on an env with no plaintext-mode var. The packet forbids editing
tests to go green, so the gate moved to the production entrypoint: main.ts now
calls if (encryptionBoot.metadataEncryption) buildMetadataReadPolicy(process.env).
Production still refuses to boot without a mode; that suite is back to 29/29.
main.ts is outside the stated lease (Delta 1 flag).

Delta 2: submission.ts was not given a reader field. It only seals
(write-only); an unread parameter would be dead code. Flagged instead.

Delta 3: server.ts was NOT edited. The policy is re-derived from the same
process.env inside assembleApp (pure, deterministic), so ServerConfig needed
no new field. main.ts validates at boot; create-app builds the instance.

Delta 4: files touched outside the stated lease = main.ts (Delta 1 only).
legacy-payload-migration.ts is the store module named in the lease and was
NOT modified yet (item 7 still open).

## The single decision point (create-app.ts)

  mode var absent  => warn (only when a seam exists) + bounded compat policy
  mode var present => buildMetadataReadPolicy(process.env), which throws on
                      a typo, an inverted window, a window over 14 days,
                      or forbid combined with window vars
  then metadataReader = createMetadataReader(metadataCrypto, policy),
  injected as the 4th arg of createRuntimeService, as RouteContext
  metadataReader, and as ingestion-consumer options.metadataReader.
  Any caller with no reader uses compatibilityMetadataReader(crypto):
  memoized per seam, bounded to 14 days. The literal true now exists in
  exactly ONE bounded place instead of eight call sites.

## Facts learned during the install (carry forward)

1. assertReadableWithoutSeam is 1-arg (a concurrent lane refactored it);
   runtime no longer calls it directly because openMetadata now delegates to
   the reader facade.
2. openMetadata now accepts MetadataCrypto OR MetadataReader (type-guarded),
   so in-process callers passing a bare seam keep working, and the 6 internal
   call sites pass the injected reader.
3. The reader evaluates the policy against the WALL CLOCK at call time. My
   first test anchored a window at 1700000000000 (year 2023) and the read came
   back false in 2026, which is correct behaviour and a bad test assertion.
   Fixed by anchoring that case on Date.now(). The other 20 cases take
   explicit timestamps, so they stay stable.
4. MAX_DUAL_READ_WINDOW_MS is NOT exported from legacy-payload-migration.ts
   (module is leased) so the compat default restates 14 days locally.
5. Offline-only kept throughout: no DB, no Redis, no S3, no Vault, no commit,
   no push, no tick, no migration file, no auth-counter edit.

## RED suites: 4, none attributable to this packet

migration-verify-trap-fix: references none of my changed modules; hangs
offline waiting on a live PG.
migration-0032-rollback: imports only METADATA_SLOTS, untouched.
artifact-read-authorization: references none of my changed modules.
admin-shell-session-lifecycle: pre-existing, recorded in project memory.

request-redaction-http failed ONCE inside the pre-fix full run and passed on
re-run and in isolation: a parallel-run flake, not reproducible.

## RESUME POINT (items 6, 7, 8) — exact next steps

1. Read src/modules/encryption/legacy-payload-migration.ts lines 631-956.
   RESULT_REF_PAYLOAD_KINDS holds only the 2 TEXT result_ref families and the
   whole ResultRefPgMigrationStore is parameterized by them.
2. Generalize that kind table to all 8 METADATA_SLOTS: for each slot carry
   table, alias, tenant expression (tasks has NO tenant_id, join operations),
   and the EXACT refId the writer binds, otherwise the store seals envelopes
   no reader can open:
     operations.input_ref            -> operation id
     tasks.payload_ref               -> task id
     human_waits.response_ref        -> wait id
     step_checkpoints.output_ref     -> taskId + ":" + stepKey
     step_checkpoints.session_ref    -> taskId + ":" + stepKey + ":" + gen
     operations.prompt_overrides_ref -> operation id
   jsonb columns take the envelope OBJECT (the store currently JSON.stringify
   for TEXT result_ref only).
3. Create src/modules/encryption/backfill-metadata-cli.ts: parse env, build
   the seam, build the store, query an independent tenant census (SELECT id
   FROM tenants) and pass it as expectedTenantIds (this is item 6; without it
   the gate can never PASS), print gate + blockers + counts, then optionally
   run backfillLegacyPayloads(store, codec).
4. Add the package.json script; match the existing CLI script style in that
   file first (copy an existing entry, do not invent a runner).
5. Item 8: a counter for plaintext reads per mode plus an authorized action
   that switches the mode to forbid ONLY after the gate reports PASS. Do NOT
   flip A2 and do NOT flip any mode yourself.
6. Re-run npx tsc --noEmit and npx jest --silent and append real numbers to
   this receipt. Do not edit any test to make it green.
