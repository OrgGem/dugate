# Supplemental plan-conformance tasks — 2026-09-23

> **Progress-only update 2026-09-23 evening:** [Latest reconciliation](../coordination/PROGRESS-RECONCILIATION-2026-09-23-EVENING.md) supersedes stale lane availability: SDK was restored by the coordinator but its terminal now reports a usage limit. MM-11 has documentation/validator progress; MM-13 is PARTIAL pending residual verification. These remain review notes, not new assignments.

> **User direction: record only (2026-09-23).** Mismatches and proposed closure criteria are review notes only. Do not implement fixes, dispatch agents, or change the active execution plan based on this review without a subsequent user instruction. Suggested priorities/lanes below are proposals, not assignments. Existing independently authorized work may continue.

Acceptance addendum to [full-flow review](../coordination/PLAN-CODE-CONFORMANCE-2026-09-23.md), snapshot 12:04 +07. These tasks record work; they do not dispatch agents or change active ownership. Existing [CR fixes](REVIEW-FIXES-2026-09-23.md) remain separate dependencies. SDK/connector-client work stays BLOCKED while that lane is out of rotation; coordinator must explicitly allocate an authorized owner before dispatch.

| ID | Priority / state | Parent / suggested lane | Concrete closure evidence |
|---|---|---|---|
| MM-01 | High / BLOCKED SDK portion | P3/P4/P5; platform + SDK + document-core | Shipped worker authenticates to production Connector verifier; missing/wrong identity denied; no verifier-disabled happy-path substitute |
| MM-02 | High / TODO | P2/P5; platform + document-core | API-key-only upload → top-level artifact roles/output normalization → process → result/download; CR-12/13 closed |
| MM-03 | High / TODO | P2 profiles/P6; platform | Profile v1 survives v2 activation; defaults/locks/prompts/limits resolved and immutable, actual schema digest; invalid overrides denied |
| MM-04 | High / TODO | P2 public/runtime; platform | Public-only HITL discovery/resume, durable progress, state filtering and complete stable pagination |
| MM-05 | High / TODO | P2-09/P8-02; platform + integration | Redis loss before claim reconstructs READY job; deadline/wait expiry scheduled; persisted worker health; no duplicate effects |
| MM-06 | High / TODO; SDK subtask held | P3-05/P4-07/P5/P8-03; connector + document-core | Provider 202 → polling → final result across restart; no repeated inference; pending does not exhaust attempt budget (CR-07) |
| MM-07 | High / TODO | P3/P8-03; connector + integration | Concurrent and CANCELLED same-ID replay never redispatch; durable ledger test includes quota lease expiry |
| MM-08 | High / TODO | P3-05/P8-03; connector + integration | Shared-account cap across tenants/revisions; reservations; long-call lease renewal; remaining deadline bounds timeout |
| MM-09 | High / TODO | P7-03/07; deployment + integration | Inspect actual running digests before/after extension registration; provision real identities; deny access to another worker's queue; no platform rebuild |
| MM-10 | High / TODO | P7-04/P8-02/03; Admin + integration | Rendered profile edit/publish user flow; production fault injection, same-epoch cancellation, Redis/storage recovery; retain slice results as scoped evidence |
| MM-11 | Medium / TODO | P1 contracts/OpenAPI; contracts + docs | Producer/schema tenantId decision; real responses validate; actual spec examples validated; fresh-checkout portable command |
| MM-12 | High / TODO | P8-06; platform + deployment | Standard start/container starts listener; clean environment deployment; health/shutdown/migrations/restore verified |
| MM-13 | Medium / PARTIAL (closure disputed) | P1-05/P8; test infrastructure | Agent delivered automatic DB selection/guards and concurrent PASS logs. Random Redis DB collisions and unused consumer prefixes remain; see evening progress reconciliation. Recorded only, no fix dispatched. |

## Acceptance corrections and ordering

1. Treat P7-03/04/07 and P8-02/03 as **PARTIAL at full-task acceptance**, retaining all recorded slice PASS results. Existing checkmarks in agent-owned phase files must not override the unresolved criteria above. Coordinator should reconcile those rows after reviewing this addendum; this review does not overwrite their concurrent edits.
2. Prioritize MM-01/02/03/07 with existing high-priority CR fixes to make the main document execution path usable and safe. Prepare SDK-dependent acceptance now, keep held implementation work undispatched.
3. Close reconciliation and provider convergence MM-05/06/08, then validate public HITL and Admin flow MM-04/10.
4. Complete contract/isolation work MM-11/13 before expanding parallel regression claims; finish actual packaging MM-12 before immutable deployment evidence MM-09.
5. Re-run affected acceptance after source fixes. Tests in the review probe intentionally characterize defects and must not be counted as fix completion. G5/G6 and release readiness remain unaccepted until required evidence exists.
