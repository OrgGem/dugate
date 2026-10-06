# CR06-06 — Parameters Secret Redaction & Validation — receipt (qwen_1, 2026-10-06)

Task CR06-06 (MEDIUM, tasks/CODE-REVIEW-FOLLOWUP-2026-10-06.md).
Lease: packages/contracts/src/profile-policy.ts,
services/orchestrator/src/modules/operations/submission.ts,
services/orchestrator/tests/**. No commit, no push.

## The reported risk, confirmed on disk

- profile-policy.ts:78-83 — ProfileParameterValueSchema.value is z.unknown(),
  by design (the real shape lives in the business manifest action slots).
- submission.ts:570-576 — buildProfilePolicySnapshot copied
  `profile.policy.parameters` verbatim into the admission snapshot.
So a credential placed in `parameters` reached a snapshot column as plaintext.

## What was implemented

1. packages/contracts/src/profile-policy.ts
   - SECRET_PARAMETER_KEY_PATTERNS, isSecretParameterKey, findSecretParameterKeys.
     Suffix-anchored on purpose: `maxTokens`, `tokenizer`, `passwordPolicy` and
     `authorizationMode` are NOT credentials and stay usable. The `fileUrlAuth`
     family is prefix-matched because that whole family is the credential shape.
     Families covered: fileUrlAuth*, *token, *password, *passwd, *secret,
     *apiKey / *api_key / *-api-key, *authorization, *credential.
   - ProfileSnapshotParametersSchema — the same record plus a superRefine that
     refuses credential keys. Used ONLY by ProfilePolicySnapshotSchema.
2. services/orchestrator/src/modules/operations/submission.ts
   - buildProfilePolicySnapshot scans `profile.policy.parameters` BEFORE the
     snapshot parse and throws HttpError 422 SECRET_IN_PARAMETERS, naming the
     offending KEY only. Values never leave that point.
   - Exported so the sentinel is testable without a database.

## Boundary decision worth reviewing (not a silent split)

The first attempt put the superRefine on ProfileParametersSchema itself. That
turned tests/p730-medium1-write-validation.test.ts RED on its
"ADMIN-TRUSTED PIN: a sentinel secret is stored verbatim, unredacted" case — a
prior, explicit decision that the ADMIN-AUTHORED profile write path stores
parameters as authored.

Since the reported vulnerable boundary is the SNAPSHOT COPY, not the write path,
the guard was scoped to the snapshot schema instead: the write schema is
unchanged, and the admission snapshot (the thing that leaves the process) refuses
credential keys twice — once as a 422 sentinel with a clear code, once as a
schema refinement that makes the record unreadable rather than merely flagged.

## Verification — real numbers

| check | result |
|---|---|
| npx tsc --noEmit -p tsconfig.json | no output, exit 0 |
| tests/cr06-06-parameters-secret.test.ts (NEW, 12 tests) | PASS |
| tests/p730-medium1-write-validation.test.ts | PASS |
| tests/p730-prof03-invariant1.test.ts | PASS |
| tests/aweb04-bff-profiles.test.ts | PASS |
| tests/submission-metadata-crypto-e2e.test.ts | PASS |
| combined | **5 suites passed, 88 tests passed, 0 failed, exit 0** |

Negative coverage (packet item 3):
- scanner flags 17 credential-shaped keys, misses 7 ordinary ones;
- snapshot schema refuses fileUrlAuth / accessToken / password;
- buildProfilePolicySnapshot throws 422 SECRET_IN_PARAMETERS for a credential in
  parameters,
- the 422 problem body contains the KEY and never the value (asserted with a
  sk-live-SECRET-XYZ sentinel);
- an ordinary record does not trip the sentinel.

## Gotcha worth recording

jest resolves @du/contracts from the built dist, not the source. After editing
packages/contracts/src I had to rebuild it (`npx tsc -p tsconfig.json` inside
packages/contracts) or the tests silently ran against the STALE scanner.

## Not done / open

- `parameters` is still a passthrough at the WRITE boundary by that earlier
  ADMIN-TRUSTED PIN decision. If the user wants the write path to refuse too,
  that is a behaviour change to another lane’s contract and needs its own ticket.
- The sentinel only inspects top-level keys, by design (the reported issue is
  key-shaped). Value-level sniffing would false-positive on tenant data.

No commit, no push, no tick.
