# Claude findings → plan intake check — 2026-10-06

Verdict: **all 10 CR06 findings recorded; implementation/acceptance remains OPEN**. Reviewed `tasks/CODE-REVIEW-FOLLOWUP-2026-10-06.md`, its task-index link, main migration plan and latest live-E2E receipt. This check did not execute tests, inspect live dispatches or independently reproduce all ten findings.

| IDs | Recorded issue | Plan completeness |
|---|---|---|
| CR06-01 / High | Workflow Connector calls missing promptStepId | Parent, owner lane, source references and observed-provider/pinning/negative test acceptance present |
| CR06-02 / High | Production Vault resolver/renewal not wired | Parent/security gate, composition references and required live-chain acceptance present |
| CR06-03 / Medium | Session capture/inject helpers lack production consumers | Explicit wire-or-defer decision and consumer verification required |
| CR06-04 / Medium | Async202/sessionRef persistence gap | Contract decision and pending→resume integration test required |
| CR06-05 / Medium | Optional identityVerifier opens override path | Fail-closed or explicitly scoped test-only exception and negative auth matrix required |
| CR06-06 / Medium | Unconstrained parameters copied into admission snapshot | Schema/security decision and negative tests required |
| CR06-07 / Medium | profilePolicy undefined/null collapsed | End-to-end tri-state decision and consumer tests required |
| CR06-08..10 / Low | Profile-ID schema rationale, duplicate carrier caps, upload availability/error/docs | Contract decisions and focused tests required; no blind breaking schema/error change |

Each row contains parent/owner suggestion, expected/actual, file:line and acceptance. Severity counts: 2 High / 5 Medium / 3 Low. Follow-up says 0/10 ACCEPTED and does not claim dispatch or code fixes. Suggested owner lanes are not named active leases/tasks; coordinator must bind them in the existing Run.

Source spot checks support missing disbursement invoke options, absent production Vault resolver argument, unguarded override composition, optional HTTP identity guard, untyped parameter schema and task-context coalescing. Doc-compare runChunk merges caller invocationOptions; reviewer/owner must trace its production caller before deciding whether a default missing promptStepId actually applies to every call. This intake audit does not promote any static finding to verified exploit evidence.

## Gaps reconciled in main plan

1. Main migration plan previously had no CR06 reference, although README linked the follow-up. Added intake/dependency mapping to MIG-01..05 and VFY-06/REVIEW-07 without copying ten rows or creating duplicate packets.
2. ADMINWEB-FILEREF-01 remains a pending evidence packet: detailed source locations, reproduction and reviewer verdict are absent from the follow-up. Main plan now explicitly retains UI acceptance hold. These claims are outside the ten CR06 rows, not ten verified fixes or new confirmed CVEs.
3. Latest live stack receipt proves startup but reports ingest/extract HANDLER_ERROR before checkpoint; this independent functional hold was absent from main migration plan. Added required root-cause triage and successful flow rerun, without attributing it to prompt/Vault findings without evidence. Port8080 probe failure from unrelated nginx-ui must be scoped to the tested project; host occupancy alone does not prove Connector host publication.

## Implementation decisions that remain open

- Schema typing or parameter-key/sentinel checks alone do not guarantee arbitrary secret detection; define secret-slot ownership, supported parameter types and trust boundary before claiming CR06-06 closed.
- Session semantics and ID type changes require consumer/compatibility decisions; a different schema shape alone is not a proven defect. Document a justified disposition if behavior is intentionally deferred/retained.
- CR06 severity is reviewer-assigned issue severity, not dependency-scanner CVSS. Existing Node24/dependency High findings and security-event test failure remain separate security holds.
- Preserve user authorization for routine local isolated verification; explicit production/billed-provider/window constraints still apply. Do not infer another permission request from generic historical live-window wording.

Changes: only main plan linkage/holds and this receipt; no source, dependency, checkbox, commit, push or deployment change. No conclusion that Claude issues have already been fixed.
