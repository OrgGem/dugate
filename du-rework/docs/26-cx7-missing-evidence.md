# W40-CX7 actionable missing-evidence items (docs-lane closeable set)

Docs lane closes nothing by itself here; each item names owner lane, file,
function, and the assertion that does not exist yet. Nothing ticked.

## A. Orphan integration tests (unanchored evidence, must not close parents)

1. `du-rework/tests/integration/p4-05-artifact-streams.integration.test.ts`
   (`P4-05 - SDK artifact streams against the real runtime`, 7 tests incl.
   `uploadArtifact completes the real staged flow: grant -> PUT blob ->
   finalize READY`, `maxBytes rejects an oversized real download`).
   Owner: sdk (+ platform for the real endpoints). Fix: run it against real
   P2 artifact endpoints, record command + exit code + result in
   reports/command-code.md, and only then cite it for P4-05 ART-01..03.
   Until then it is an unclaimed file, not evidence.
2. `du-rework/tests/integration/p4-08-sdk-consumer.integration.test.ts`
   (`P4-08 - SDK consumer against real P2 + real P3`, 1 test:
   `full cross-service run: submit -> dispatch -> SDK worker -> pending
   yield -> retry -> stable invocation -> SUCCEEDED`). Owner: sdk (+
   platform/connector for live P2/P3). Fix: same treatment; no report claims
   it today (rg over reports/ + P4 task file finds no citation), so it
   cannot close P4-08. Record the run or mark it draft.

## B. MM-10 review claim without a file

3. MM-10 row cites `p7-04-profile-assignment.integration.test.ts`; that path
   does not exist anywhere under du-rework (rg filename search empty) and no
   `services/orchestrator/tests/integration/` directory exists. Owner:
   admin-ui (+ platform). Fix: either commit the test the review describes
   (rendered profile edit/validate/publish via public creds) or correct the
   review citation to the real file + literal test name; until then MM-10
   stays needs-code/partial-slice and P7-04 cannot close on that claim.

## C. Docs-closeable remainder from the crosscheck

4. MM-11 (docs): spec-extracted examples + real HTTP response validation.
   Owner: docs. Missing assertion: validator reads examples OUT OF
   docs/21-openapi.json (today probe_cases.js carries independent fixtures)
   and checks one live response shape per surface from a fresh checkout.
5. MM-13 (test-infra): default-run isolation. Owner: test-infra (out of
   rotation). Missing: two default invocations isolate PG/Redis/artifacts
   incl. cleanup + unsafe shared config rejected; see docs/24-mm-13-gap.md.

## D. Explicitly NOT docs-closeable (code lanes only)

MM-01/02/03/04/05/06/07/08/09/12 need production source or live stacks
(auth wiring, upload flow, profile semantics, wait/progress/pagination,
READY reconciliation, poll convergence, replay ownership, quota scope,
image digests/ACLs, deployment entrypoint). Named here so nobody mistakes
documentation for closure. NO DB USED.
