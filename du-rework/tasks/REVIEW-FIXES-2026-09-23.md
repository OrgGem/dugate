# Supplemental fixes from code review — 2026-09-23

Source of findings and exact reproduction/acceptance: [code review](../coordination/CODE-REVIEW-2026-09-23.md). Evidence: [offline characterization](../coordination/review-evidence/code-review-2026-09-23.json).

**This is an added fix backlog, not a new dispatch wave.** Preserve current lane ownership and in-flight work. No source or existing agent report is changed by this packet. Status TODO means not yet assigned/implemented; BLOCKED identifies the explicit current owner constraint. Recheck the source hashes/current code before work, because the checkout is shared.

| Fix ID | Severity | Status | Finding / deliverable | Owning scope | Parent acceptance / required regression |
|---|---|---|---|---|---|
| FIX-CR-13 | High | IN PROGRESS (platform report; no closure receipt) | Binary artifact wire contract; remove decoding shim from integration | Platform server; coordinate SDK and document-core test owners | P2-07, P4-05/08, P5-10: real HTTP binary equality/hash + native parsing + checkpoint replay without fetch rewriting |
| FIX-CR-01 | High | TODO | Webhook destination/redirect/IP policy | Platform webhooks/submission; shared policy contract if needed | P2-08, P8-04: blocked internal targets/redirect bypass; allowed callback works |
| FIX-CR-02 | High | TODO | Bounded webhook dispatch, durable claim and shutdown tracking | Platform webhooks/server | P2-08/09, P8-02/06: stalled receiver cannot pin pool/shutdown; multi-replica/crash recovery remains at-least-once |
| FIX-CR-03 | Medium | TODO | Atomic first-use idempotency contention | Platform submission | P2-04, P8-02: concurrent same-key replay or conflict, one operation/root/outbox, no 500 |
| FIX-CR-04 | Medium | TODO | Atomic idempotency TTL replacement | Platform submission; coordinate with CR-03 | P2-04: before/after expiry and concurrent same/different-body reuse |
| FIX-CR-05 | High | TODO | Resolve existing replay before mutable admission | Platform submission | P2-04, P7-06: replay survives drain/schema/profile changes with ownership/hash checks intact |
| FIX-CR-06 | High | TODO | Active lease fencing across runtime mutations and claim replay | Platform runtime; extends R08-02 remainder | P2-05/06/09, P8-02: expired/cancelled/foreign-owner replay and heartbeat/save/complete races |
| FIX-CR-07 | High | BLOCKED | Provider PENDING continuation separate from failure attempts | Joint platform + SDK; SDK lane held by user | P4-07/08, P8-03: >3 pending deliveries then success, one invocation; deadline/cancel still enforced |
| FIX-CR-08 | High | BLOCKED | Timeout/abort through complete response consumption | SDK artifact streams + connector-client transport; held lane | P4-05/07/08: stalled body, caller abort after headers, cleanup and slot release |
| FIX-CR-09 | Medium | TODO | Bounded, correctly classified Connector readiness probe | Platform connector proxy | P2-07: no false success on required-body failure; close unused/oversized body |
| FIX-CR-10 | Medium | TODO | Exact usage aggregation and wire-range enforcement | Platform usage | P2-07, P8-03: safe inputs with overflowing row/grand totals must not silently round |
| FIX-CR-11 | High | DONE (agent evidence, 2026-09-23 evening) | Bounded ingress and caught request-stream errors | Platform server; extends R08-03 ingress slice | ingress-bounded.test.ts: 8/8 PASS and typecheck exit 0 reported by Claude; source/test present. See progress reconciliation; no independent DB rerun by reviewer. |
| FIX-CR-12 | High | TODO | Complete existing artifact grant/integrity work | Existing platform C07-01/02 / R08-03 owner; contract coordination | P2-03/07, P4-05, P8-04: expiry/mode/ownership/fencing/hash/immutability negative tests |

## Execution order and collision rules

1. Coordinator folds CR-13/11/12 into the existing platform artifact/server ownership, and CR-06 into runtime fencing. CR-01/02 are the webhook packet. These High findings block acceptance of their affected behaviors; historical green slice results do not waive them.
2. Bundle CR-03/04/05 in one submission packet: the transaction/key ordering overlaps. Implement and verify it as one coherent idempotency policy, preserving distinct regression cases for each finding.
3. CR-09/10 are independent platform-module fixes, but dispatch still goes through the existing platform owner. Do not allocate the same file to a second active agent.
4. CR-07/08 wait for the user to restore the SDK lane or explicitly reassign ownership. Platform can design the CR-07 continuation contract while waiting, without editing held SDK paths. Do not re-prompt Command Code: the latest standing allocation explicitly takes it out of rotation.
5. After local fixes, run real isolated P2/P3/SDK/business consumers in the coordinator-granted DB window. Remove only the test shims that compensate for the repaired production contract. Then revisit parent task/gate acceptance, P8 fault/security cases and the release report.

## Definition of done

- Each fix links its finding, final diff, desired-behavior regression cases, exact command/result and revision/source hashes.
- Public/runtime API changes require real HTTP integration coverage; database races require real PostgreSQL tests, not only the scripted seams used for review.
- Preserve existing successful cases and idempotent/fenced retries. Shared DTO/migration/lockfile changes require coordination with the owner, not unilateral consumer patches.
- Report DB window acquisition/release and remaining limitations. Do not call a fix DONE solely because the characterization script now fails; add and pass the intended regression assertion.
- CR-11/12 extend known R08-03/C07 work; CR-06 extends remaining runtime fencing. Track these aliases as one implementation assignment each, avoiding duplicate ownership.

Parent rows actively edited by agents are not toggled here. **Their final acceptance must additionally close the mapped fixes above.** This prevents a new checkbox from silently overriding a confirmed correctness gap while preserving concurrent work.
