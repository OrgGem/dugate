# P8-08 — Release Readiness Audit

**Audit date:** 2026-09-25  
**Current decision:** **NO-GO — Gate G6 is not passed. No cutover is approved.**  
**Scope:** Reconcile P8 acceptance, reported offline/live receipts, current gate plans,
review findings, release documentation, and consumer compatibility.  
**Evidence rule:** Counts below are cited from published lane/Tester receipts. This
audit did not rerun tests or independently reproduce live results.

## 1. Executive assessment

The workspace contains substantial implementation, offline regression coverage,
some PostgreSQL/Redis live receipts, and the requested S3, Vault/OIDC, and P8-06
operational documents. Those artifacts do **not** satisfy the current G6 rule.
The current P8 task banner makes P8-08 contingent on all P8-01..07 acceptance
and the additional `G-SEC`, `G-DATA`, and `G-ADMIN-OPS` gates. The security,
storage/logging, and Admin-operations plans still have unclosed task rows; the
P8-05 benchmark and P8-06 clean deployment/restore evidence are absent.

There are also correctness and evidence-quality issues that prevent accepting
historical `[x]` marks as current release proof: the queue-reconstruction
implementation still has an eligibility race and an incomplete health failure
signal; the latest Admin/OIDC live matrix failed; R1-D migration 005 has a run
request but no apply receipt; and the compatibility section in the older
readiness report contains claims explicitly withdrawn by the current acceptance
review.

**Release posture:** preserve existing task history, but do not infer readiness
from it. A new release report is not a substitute for the missing runtime,
security, storage, capacity, and operational evidence.

## 2. Evidence inventory

| Area | Evidence already recorded | Evidence class and limit | G6 effect |
|---|---|---|---|
| **MM-05 queue reconstruction / durable health** | Tester W48-A6fb10 records three PostgreSQL/Redis runs of `p8-02c-mm05-rearm`, **5/5 each**. W48-A6fb11 records three runs of `p8-02b`, **6/6 each**, including dispatch, Redis job loss, sweep reconstruction, and `queueIntegrity` health. The latest reviewer recognizes these two live scenario legs. | **Live scenario receipts**, not rerun for this audit. Reviewer still identifies a source-level race: re-arm CAS does not recheck task/operation eligibility after Redis lookup. Redis lookup errors can increment `unconfirmed` while health ignores that count; timer failure can leave stale health. | Named cases are green; close the state-fenced update and failure/staleness signal cases before treating the full recovery invariant as release-accepted. |
| **MM-10b / same-epoch terminal fence** | Tester W48-A6fb4 records the PostgreSQL/Redis integration suite **6/6, three sequential runs, exit 0**. The current P8-02 row cites MM-10b and guard-order evidence. | **Live receipt** from its named DB window. It is a focused race/fence suite, not proof of the rest of the release topology. | Useful P8-02 evidence; it does not close P8-01, P8-05..08, or G6. |
| **BR-12 business isolation** | Offline queue-routing, key-to-business binding, and cross-business claim cases were added. The later Cycle 95 implementation authenticates the worker business from a per-business token and denies a forged body business before claim; its offline receipt is **4/4**, with Worker SDK claim-context **30/30** and contracts **80/80**. | **Offline receipts only.** The prior direct-claim characterization explicitly exposed the bug; the later source appears to address it. The latest independent review predates or does not credit that patch and notes the traceability matrix is stale. No current-build live/multi-service authorization receipt was found. | Re-review the current route and add a current-build authenticated HTTP negative proving no snapshot or mutation for a forged business. Refresh the traceability row; retain the live integration gap. |
| **DATA-01 / DATA-02 artifact storage and submit guards** | Cycle 88/93 receipts report S3/PostgreSQL facade integration, pinned backend/version metadata, migration `0013_artifact_storage_version.sql`, and submit preflight. Storage/fencing tests are **38/38**; submit/BR-12 guard tests are **8/8**. | **Offline tests** using fake S3, local signing, and in-memory database seams. Migration 0013 has no apply receipt here; no versioned production bucket, real signed upload, cross-service publication, or failure recovery is evidenced. | `G-DATA` remains open. Verify actual deployed storage mode, migration/upgrade path, signed upload wire, exact version/checksum, and publication/recovery across services. |
| **DATA-04 worker artifact streaming** | Worker SDK bounded streaming, size/hash checks, whole-body deadline, mandatory lease-epoch finalize, and committed-output gating are covered by **69/69** focused offline tests. Cycle 96 adds metadata round-trip coverage (**47/47** focused; **141/141** selected SDK regression set). | **Offline/injected transport and in-memory queue receipts.** These do not prove network backpressure under outage, real S3 or PostgreSQL finalize, or cross-service output publication. Migration `0014_artifact_declared_filename.sql` is authored but unapplied. | Complete the `DATA-INT-01` actual container/S3/worker path and current-build reference/fencing checks. |
| **VAULT-01 / VAULT-02 / VAULT-05** | Typed Vault KV v2 reference/resolver work, policy files for separate writer/reader identities, and Cycle 96's operational runbook/environment template exist. Relevant lane reports contain source and offline fixture work. | **Implementation/documentation preparation.** The SEC task plan still marks these rows `[ ]`; no accepted real Vault policy positive/negative matrix, renewal/expiry, two-replica secret read, real revision-pinned provider call, or outage/revocation rehearsal was found. | `G-SEC` remains open. Do not present the runbook or generated policy files as a deployed Vault receipt. |
| **OIDC-01** | Fake-IdP RSA flow suite **23/23**; the lane report also records an Orchestrator offline batch **30 suites / 885 tests**. | **Offline fake-IdP/unit evidence.** No real IdP browser login/callback, current-build session lifecycle, or HTTP replay proof. | OIDC-01 and `G-SEC` remain open. |
| **OIDC-02** | Cycle 93–95 session store has **17/17** offline tests for expiry, rotation, revoke, CSRF, and shared repository behavior. | **Offline repository/fake shared-store evidence.** No real Redis-backed two-replica session, restart/revocation, cookie-origin, or browser logout receipt. | OIDC-02 and `G-SEC` remain open. |
| **OIDC-03 / Admin authorization** | Tester W48-QW1-LIVE-005 records **11/12 pass, 1 fail, exit 1**. D1–D4, M1–M6, and X1 passed; X2 failed because the 404 response title included the foreign operation UUID. The run's requested Orchestrator build also failed before its live-test typecheck (`Readable` duplicate declaration). | **Partial live receipt with failed current acceptance.** A successful subset is not a green matrix; there is no later passing Tester receipt in the reviewed reports. | `G-SEC` and Admin operation isolation remain open. Remove resource identifiers from the 404 body, repair the build, then rerun the exact matrix under Tester-owned window control. |
| **Egress / DNS rebinding / bounded body** | Cycle 95 shared `@du/egress` implementation now pins supported string/byte/stream/text-FormData requests to the adjudicated address and rejects unsupported multipart Blob/File shapes; it has no global-fetch fallback. Cycle 97 reports the offline verification aggregator **91/91**, including egress boundaries, plus relevant lint/build receipts. | **Offline boundary evidence.** This supersedes the older reviewer finding about the former complex-body global-fetch fallback. It does not establish deployed production policy, real service-to-service egress, or live webhook claim-fence behavior. `allowPrivateNetworks` remains a test-mesh escape hatch and must stay disabled in production configuration. | Record the old finding as source-addressed by the later patch, but keep security integration and webhook/egress deployment proof in `G-SEC`/P8-07. |
| **R1-D / MM-06/07/08, WR24-08** | Offline lifecycle suite **9/9**, Connector **82/82** (with 3 skipped), Connector Client **24/24** (with 1 skipped), plus later quota lifecycle **11/11**, usage-focused **7/7** (2 filtered), and R1-D focused **12/12** are reported across cycles. Multi-replica renewal simulation uses shared in-memory fakes. | **Offline receipts.** Migration `005_connector_polling_state.sql` has a Tester run request but no verified apply/rollback/schema receipt; no durable multi-replica PostgreSQL/Redis restart/quota receipt. The full Connector package has a reported red/skip history and is not a clean package-wide acceptance receipt. | Keep MM-06/07/08 and P8-03 live acceptance open until migration 005 is applied/verified by Tester and the two-replica recovery/renewal suite passes on the approved target. |
| **S3 artifact runbook** | Cycle 95 updated `docs/runbooks/artifact-storage.md` for per-artifact backend selection, pinned S3 versions, PostgreSQL fallback limits, outage/recovery, and backup/restore checks. | **Documentation receipt.** It explicitly says backend switch is not automatic failover; PostgreSQL-only mode cannot read existing S3-backed artifacts. No production bucket/IAM/KMS, migration, object-version restore, or recovery drill receipt. | Documentation is useful preparation; `G-DATA` remains open. |
| **Vault/OIDC runbook** | Cycle 96 added policy bootstrap, outage/unseal/renewal/revocation, zero-secret OIDC environment guidance, and audit-sink rules. Workspace lint was reported passing then. | **Documentation receipt.** The runbook says SEC-00, real Vault/IdP fixture, full service wiring, and SEC-INT-01/02 rehearsal are still prerequisites. | Does not close `G-SEC`. |
| **P8-06 OPS checklist** | Cycle 97 added `docs/ops/p8-06-ops-checklist.md` with service health contracts, deployment/migration/backup/shutdown gates, four isolated drills, and an evaluation template. Cycle 97 `pnpm lint` passed for all 13 projects with lint scripts. | **Documentation and typecheck receipt only.** No tests, Compose/container, DB/Redis, backup/restore, S3, or live drill was run. Production Orchestrator packaging/liveness, Connector migration serialization, identity integration, and drill receipts remain open. | P8-06 remains open. |
| **Migration history / schema verification** | Duplicate migration sequence 0011 was renamed to 0012 and the runner gained duplicate-prefix/filename checks with offline guard tests. | **Source/offline evidence.** The prior migration collision existed; no clean-install plus old-ledger upgrade receipt covers both histories. Migration 0013/0014 and Connector migration 005 apply receipts are also absent from this audit set. | Require read-only inventory and Tester-controlled clean/upgrade migration proof before release. |

## 3. P8 acceptance reconciliation

The P8 task file contains historical detail and parent-row marks, but its current
acceptance banner states that those marks do not by themselves prove G6. Use this
table for release decision-making; do not rewrite task history based on this
audit.

| P8 task | Current acceptance reading | Release assessment |
|---|---|---|
| **P8-01 — isolated E2E and traceability** | Summary row is unchecked. Offline trace/entity harness slices exist, but no accepted fresh, isolated cross-service E2E covering current build, real S3 path, worker/Connector identity, and the required source/BR matrix. Some traceability entries are stale after BR-12 changes. | **Open.** |
| **P8-02 — fault recovery** | Summary row is marked complete and MM-05 named live scenarios now have green Tester receipts. | **Scenario evidence present; correctness follow-up remains.** State-fenced re-arm and truthful health on Redis uncertainty/failure need proof before full recovery acceptance. |
| **P8-03 — provider/usage convergence** | Summary row is marked complete, while its detailed historical section says MM-06/07/08 remain pending. R1-D offline work and renewal hardening exist; migration 005 has not been live-applied. | **Reconcile as partial for release purposes.** No durable multi-replica migration/quota/poll recovery receipt. |
| **P8-04 — security suite** | Earlier 26/26 baseline is historical. Current G-SEC includes OIDC/Vault and current acceptance review reopens secret/error/authentication claims. The latest Admin/OIDC live matrix is 11/12 and failed. | **Baseline evidence only; current security gate open.** |
| **P8-05 — capacity benchmark** | No current 1→2→4 replica load/burst/soak/fairness report tied to approved P0-06 assumptions was found. | **Open.** Capacity claims and thresholds are not measured. |
| **P8-06 — packaging and OPS-08** | Connector test Compose profile and runbook/checklist exist; production Compose/host topology is not built or rehearsed. Orchestrator lacks packaged process/signal entrypoint; Connector migrations run at process startup; backup/restore has no rehearsal receipt. | **Open.** |
| **P8-07 — dashboards, alerts, runbooks, drills** | Operational runbooks exist and were typechecked. Dashboard/alert design is not evidence of provisioned alert delivery; UNKNOWN reconciliation tooling, cross-bucket remap, supported credential paths, and live recovery drills remain gaps. | **Open.** |
| **P8-08 — release report and compatibility** | This audit provides a current evidence/hold summary. The older `docs/18-release-readiness-report.md` is explicitly superseded and its conditional-ready conclusion is withdrawn. Its legacy facade and long-poll compatibility claims were flagged as inaccurate. | **Report delivered; gate not passed.** Consumer compatibility requires a corrected source-backed matrix. |

## 4. Final technical gaps before G6

### Blockers that affect correctness or isolation

1. **MM-05 re-arm race and health truth:** recheck current task/operation eligibility
   inside the durable re-arm update; surface `unconfirmed`, sweep errors, and stale
   health rather than reporting `OK` from only `rearmed + stalled`. Add claimed/
   completed/cancelled race and Redis-error cases, then obtain the required Tester
   live receipt.
2. **BR-12 current-build proof:** current source binds claim authorization to a
   per-business worker token and has an offline forged-business rejection. Obtain
   independent review and an HTTP-level current-build positive/negative receipt;
   the request body alone must never establish worker identity. Update the
   traceability matrix to cite the current test and preserve the live gap.
3. **Admin/OIDC non-disclosure and authorization:** the latest live X2 negative
   failed because the foreign operation ID was echoed in the `title`. Fix the
   response contract, repair the build error, and rerun the direct HTTP allow/deny,
   zero-side-effect, CSRF, and idempotency matrix. Do not accept the 11 passing
   cells as a passing matrix.
4. **Connector invocation and migration:** keep `INVOCATION_UNKNOWN` durable and
   never blind-redispatch; obtain Tester-controlled migration 005 apply/status/
   verify and rollback-safety receipts plus the multi-replica Redis/PG restart,
   quota-lease renewal, and bounded poll tests. The run request is not an apply.
5. **Webhook durability:** offline pinning/drain improvements exist, but latest
   lane notes still request live ownership-fence proof (stalled claimant A,
   reclaimed claimant B, stale A release) and wiring the shutdown signal/drain
   before closing Orchestrator pools.

### Release gates and system evidence

6. **G-SEC:** SEC plan rows remain unaccepted. Resolve SEC-00 trust/IdP/tenant
   decisions; prove OIDC login/session/RBAC/CSRF through real browser and HTTP;
   prove Vault writer/read-only policy, renewal/expiry, pinned secret read,
   rotation/revocation, multi-replica behavior, and sentinel absence in responses,
   HTML, logs, metrics, traces, jobs, and audit. Complete SEC-INT-01/02 on a clean
   build before including OIDC/Vault in the release scope.
7. **G-DATA:** complete a current image/container path through upload/finalize,
   task/worker stream, output/checkpoint, and authorized read against a private,
   versioned S3 bucket. Apply and verify migrations, test S3 and Elasticsearch
   outage/bounded buffering, restore matching DB metadata plus exact object
   generations, and measure recovery. PostgreSQL mode is a bounded write-backend
   choice, not automatic read failover for S3-backed rows.
8. **G-ADMIN-OPS:** Admin UI is the declared operator console for the current G6
   scope. Complete ADM-UX-00..07 and COST-01..04, including current-build desktop/
   mobile/accessibility, real seeded list/detail/action flows, pagination/search,
   audit provenance, role/tenant/CSRF negatives, and operational cost visibility.
   The plan is explicitly not implemented evidence; the current Tester matrix is
   red.
9. **P8-01 / P8-05 / P8-06 / P8-07:** produce the accepted traceability/E2E matrix,
   measured 1→2→4 replica workload results, production package/topology with
   serialized migration ownership and process health/drain contracts, and
   provisioned alert plus reviewed drill/restore receipts.
10. **Consumer compatibility and evidence provenance:** replace inaccurate legacy
    facade/long-poll claims with a source-backed endpoint/consumer matrix. Each
    closure receipt must identify current source/image digest, command/cwd, exact
    suite/counts/exit code, fixture isolation, live-window owner when applicable,
    and linked artifact. Keep historical receipts labeled as historical when
    the source has changed.

## 5. G6 decision checklist

- [ ] Current acceptance for P8-01..07 is complete on the same release candidate.
- [ ] `G-SEC`, `G-DATA`, and `G-ADMIN-OPS` have signed, reviewable evidence.
- [ ] Critical source/reviewer findings above are fixed or explicitly dispositioned
  by the accountable security/platform owners with regression proof.
- [ ] Migration clean install and supported upgrade history both verify; no
  ambiguous ledger repair or unapplied release migration remains.
- [ ] Backup/restore covers both database domains and artifact generations; RPO/
  RTO are measured on the selected deployment topology.
- [ ] Capacity, health, shutdown, recovery, alert routing, and rollback evidence
  matches the exact immutable image/configuration proposed for release.
- [ ] Consumer compatibility matrix is accurate for the current rework API and
  the old DUGate integration; no unimplemented legacy route is claimed.
- [ ] Operations and release owners record explicit **GO** for the named
  deployment target. Production cutover remains a separate approval.

**Decision for this audit: NO-GO.** Several focused live scenarios and extensive
offline slices are valuable evidence, but the release gates above remain open.

## 6. Sources reviewed

- [P8 release-readiness task](../tasks/P8-release-readiness.md)
- [Superseded release-readiness report and current banner](./18-release-readiness-report.md)
- [Latest independent review and receipts index](../coordination/reports/review.md)
- [Tester receipts](../coordination/reports/tester.md)
- [SEC OIDC/Vault plan](../tasks/SEC-OIDC-VAULT-2026-09-24.md)
- [Storage/logging plan](../tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md)
- [Admin operations plan](../tasks/ADMIN-OPS-UX-2026-09-24.md)
- [Deployment architecture / OPS-08](../infra/deployment-architecture.md)
- [S3 artifact runbook](./runbooks/artifact-storage.md)
- [Vault/OIDC operations runbook](./runbooks/vault-oidc-operations.md)
- [P8-06 operations checklist](./ops/p8-06-ops-checklist.md)
- [P8-07 dashboards and alerts](./ops/p8-07-dashboards-alerts.md)
