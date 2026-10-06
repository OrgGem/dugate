# Workload realignment 06 — close composite platform gaps before UI/release

> Superseded where inconsistent by [structure/code review after FIX-07](STRUCTURE-CODE-REVIEW-2026-09-21.md).
> P5-10 and P2-01 are reopened. Prior P5 DONE and 422-test claims below are historical.
> Current verification: 52 suites / 455 tests pass. Prioritize auth, stable grants, artifacts and
> executable startup, then SDK continuation, P5/P7 integration, P6-dependent profile proof and P8.

Date: 2026-09-21. This supersedes the active-work interpretation of
`WORKLOAD-REBALANCE-05.md`; that file remains the historical wave-05 assignment.

## Reconciliation outcome

- Verified now: `pnpm build`, `pnpm lint`, and `pnpm test` pass; workspace test total is
  46 suites / 422 tests.
- P3-01..08 and P5-01..10 are complete with executable evidence.
- P2 and P4 gained artifact, invocation-grant, usage, cancel/deadline and actual consumer slices,
  but their broad task rows remain partial because their remaining acceptance is not implied by a
  single happy path.
- P7 is partial, not TODO and not DONE: `example-review` is a valid local SDK baseline, but its
  deterministic single-task behavior does not implement the planned artifact/fan-out/HITL/version
  extension proof.
- P8 is partial because a scoped cross-service E2E and Connector image exist; release-readiness
  acceptance is still mostly open.

## Adjusted execution order

1. **Finish P2/P4 runtime semantics before P6/P7 UI claims.** Implement and prove fan-out/join,
   wait/resume, lease-safe pending Connector behavior, reconciliation, webhook delivery/audit and
   artifact integrity/TTL/tenant/streaming rules. Split future work packets by acceptance case;
   do not mark a composite row done from one endpoint test.
2. **Complete P7 against public surfaces only.** Bring `example-review` back into alignment with
   its task BRD (1..10 artifacts, optional reasoning, bounded children, HITL), build an immutable
   image, dynamically register/enable it, then prove cancel/restart/duplicate resume and v1/v2
   drain/rollback without changing platform source during the proof.
3. **Start P6 only after the corresponding P2 admin/profile/operation APIs are executable.** UI
   fixtures may be prepared earlier, but no UI row is DONE without browser/accessibility evidence.
4. **Close P8 last.** Run image-based multi-service E2E, full fault/security matrices, load/soak,
   backup/restore and operational runbooks. Publish G6 only after these pass; P9 stays out of the
   initial release.

## Immediate next packets

| Priority | Packet | Exit evidence |
|---|---|---|
| 1 | P2-03 artifact hardening + P4-05 streaming/cleanup | ART-01..03 integration/security tests |
| 2 | P2-06 + P4-04 fan-out/HITL/cancel/restart | RUN-05..07 with concurrency=1 and duplicate resume |
| 3 | P2-07/P4-07 pending/session completion + P2-08 webhook/audit | Cross-service pending/replay and signed delivery tests |
| 4 | P2-09 reconciliation + image-based P2-10 | Restart repair and immutable-image vertical slice |
| 5 | P7-01..07 full extension proof | G5 evidence without platform-source changes |
| 6 | P6, then P8 | Browser gate, followed by G6 release-readiness report |

P3 and P5 move to regression/consumer status; do not assign feature work there unless a failing
cross-service acceptance case identifies an owned defect.
