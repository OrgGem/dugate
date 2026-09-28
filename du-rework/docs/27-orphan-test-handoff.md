# Orphan-test handoff (W40-CX8, for whichever lane returns: sdk + platform)

## File 1: du-rework/tests/integration/p4-05-artifact-streams.integration.test.ts

Asserts (7 tests): real staged flow grant -> PUT blob -> finalize READY;
streamed READY download via read grant; withDownloadedArtifact lifetime;
maxBytes oversized rejection with no file left; stale leaseEpoch fenced by
access grant; hash catches corruption; task completes with artifact resultRef.
Needs live PG :5433 + Redis :6380 (defaults in file header; TEST_ISOLATION
schema scoping supported). Passes today: UNKNOWN to this lane (zero DB rule;
never executed). Citable for P4-05 when: owning lane runs it against real P2
artifact endpoints, records command + exit code + result in its report, and
the staging-orphan sweeper side stays with artifacts-grants/p8-02 suites.

## File 2: du-rework/tests/integration/p4-08-sdk-consumer.integration.test.ts

Asserts (1 test): full cross-service submit -> dispatch -> SDK worker ->
pending yield -> retry -> stable invocation -> SUCCEEDED against REAL P2 +
REAL P3 (mock provider only), plus worker-has-no-DB-credential invariant.
Needs live PG + Redis/BullMQ + connector service. Passes today: UNKNOWN
(same zero-DB rule). Citable for P4-08 when: owning lane runs it live and
records the same evidence block. Until then both files are unclaimed and
must not close P4-05/P4-08. NO DB USED by this note.
