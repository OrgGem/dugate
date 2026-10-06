# DU Platform migration completion review — 2026-10-06

Verdict: **NOT COMPLETE / acceptance OPEN**. Read-only review of current source/configuration and existing receipts; no new build/tests/deployment executed. No checkbox or acceptance promoted.

| Packet / requirement | Current evidence | Missing completion evidence |
|---|---|---|
| MIG-00 | Topology/export inventory and PM-M02 docs receipts exist | Full current docs/API/deployment reconciliation, updated naming and final inventory/candidate hashes |
| MIG-01 | Current main.ts wires per-request signed management provider. `orch-management-token-jwt-2026-10-05.md` reports 79 tests passing, typecheck/build | Independent verification/review on integrated final candidate; old static-header receipt is superseded for identity implementation |
| MIG-02 | Probe authorization implemented; independent ingress receipt now passes IF-01/02/03/06, including startup rollback fix | IF-04/05 remain PARTIAL, IF-08/deployed stack absent; combined worker/BFF/management/tenant flow and final review |
| MIG-03 | Root-path docs/spec and independent contract verification exist | Independent receipt F1 error taxonomy inconsistency and F2 missing credentials operation; expanded all-router coverage, current origins and Swagger UI acceptance |
| MIG-04 | Candidate exported, canonical shared packages present | Candidate receipt records typecheck exit2/146 errors; Portal apps missing from current candidate directory/workspace. No later complete isolated build/image/Portal receipt established in reviewed evidence |
| MIG-05 | Worker dependency map completed | Latest worker-template receipt explicitly says vendoring NOT materialised, no template or isolated build. Three worker instances/template migration not complete |
| VFY-06 / REVIEW-07 | Slice test receipts exist | No consolidated exact-candidate integration + independent backend/UI approval for all current requirements |
| MIG-08 | Naming/folder migration specified | Current folder still apps/admin-web, package @du/admin-web. No completed rename/inventory/build/browser acceptance |
| Swagger/docs | Generated docs/21 exists | No Swagger/api-docs implementation found in Portal source search; top-level spec server remains localhost:2023. Operation-specific overrides do not by themselves establish correct origins for every API family |
| Node24/security | Baseline specified; security scan receipt exists | Current Dockerfile pins node22-alpine; engines still >=20. High braces/xlsx and existing-image npm findings remain OPEN; no current Node24 clean scan/remediation receipt. Security-event test failed in scan |

Evidence links: [signed identity](orch-management-token-jwt-2026-10-05.md), [ingress independent verification](verify-pm-m02-ingress-2026-10-06.md), [Connector contract review](verify-plat-mig-03-905-2026-10-05.md), [canonical candidate](orch-canonical-libs-891-2026-10-05.md), [worker pilot](worker-template-pilot-890-2026-10-05.md), [security scan](orchestrator-ui-security-scan-2026-10-06.md).

## Plan bookkeeping findings

1. Header “SPECIFIED, chưa IMPLEMENTED” is stale for the entire umbrella: individual slices are implemented/tested, while overall acceptance is still open. Update to mixed/partial progress with this dated snapshot; retain unchecked parent rows.
2. PM-M01..04 table describes original mismatches; do not read those rows as proof every bug is still present. Signed management identity and ingress changes are now in source. Independent receipts, limitations and current hashes determine current state.
3. Local extraction wait for blanket RPK-00..21 closure is superseded by `tasks/USER-AUTHORIZED-LIBS-MIGRATION-2026-10-05.md`. Permit ready local isolated implementation after relevant inventory/lease freeze; keep RPK tracking and acceptance gates. No need to request local-migration approval again.
4. Later Node24, Swagger and rename additions need named owner/task intake and exact-file leases in the current coordinator Run. A plan table naming a lane is not proof of a live dispatch. This review did not inspect live Orca terminals/tasks and cannot certify dispatch status from ledger snapshots.

## Recommended closeout order

Build integrator and dependency owners remediate security/Node24 and get the Orchestrator candidate including Portal building in isolation. Worker owners materialise the pilot/template and finish all worker migrations with pinned provenance. Portal/contracts/docs owners integrate rename, Swagger and complete API coverage/origins. Tester closes remaining ingress/BFF/management scope cases and final integration on the same refreshed candidate hashes; reviewers then decide acceptance. Ready disjoint implementation slices can proceed concurrently under the existing coordinator. Keep release/acceptance open until High/Critical findings and required verification gaps are resolved.
