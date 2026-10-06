# RPK-BASELINE-BIND-885 — receipt (qwen_1, 2026-10-05)

Task task_718fc1abca6f. VERIFY/INVENTORY ONLY: no source edit, no commit, no
tick, no shared-package split.

## (1) Documents read

- tasks/SHARED-PACKAGES-REDISTRIBUTION-2026-10-05.md (full, 142 lines)
- tasks/DU-PLATFORM-MIGRATION-2026-10-05.md (PLAT-MIG-00..07 rows)
- tasks/README.md (RPK notice at line 9), tasks/PLAN-COMPLETION-2026-10-04.md
  (lines 3, 576, 787, 794)
- docs/40-du-platform-architecture.md:90,102
- coordination/agent-watch-state.json + coordinator-state.json (RPK findings)

## (2) Where RPK-00..21 actually exist

ONLY IN PROSE. Evidence:
- tasks/*RPK* = 0 files. There is no RPK task file.
- coordination/*.json contains 8 RPK hits and they are all STATUS PROSE, not
  task IDs: agent-watch-state.json:10254 RPK_GATE_ALARM ("RUN CO 0 TASK RPK"),
  :10300 rpk_bound (this packet), coordinator-state.json:2204
  rpk_gate_finding ("RUN run_069ecd6957cd CO 0 TASK RPK"), :2289 rpk_directive.
- The only RPK task table is SHARED-PACKAGES-REDISTRIBUTION section 6, and every
  row is [ ] (RPK-00 through RPK-21 = 22 rows, all unchecked). Section 7 adds
  VFY-RPK-01..05, also not tasks.
- The document itself says so: "Trang thai: SPECIFIED / DEFERRED, chua
  IMPLEMENTED/VERIFIED/ACCEPTED ... Khong dispatch tu tai lieu nay".
- A separate audit was already dispatched for this: RPK-GATE-AUDIT-879
  (agent-watch-state.json:10254).

Conclusion: RPK-00..21 are a DOCUMENTED BACKLOG, not scheduled work. RPK-00 was
never instantiated as a task, so no RPK gate ever fired and none was skipped
in the sense of a missed task - the gate simply does not exist in the run.

## (3) RPK -> real task mapping (only the pairings the docs state)

| RPK | Real task with the same output | State |
|---|---|---|
| RPK-00 baseline closure | NONE - a coordinator receipt gate (section 1) | ABSENT |
| RPK-01 inventory/ADR | PLAT-MIG-00 (DU-PLATFORM-MIGRATION:53 "MIG-00 / RPK-01") | task row exists, [ ] |
| RPK-03/04/08/15 | PLAT-MIG-04 (line 54) | [ ], gated on RPK-00 |
| RPK-05/07/14/16/17 | PLAT-MIG-05 (line 55) | [ ], gated on RPK-00 |
| VFY-RPK-01/02/03/05 | VFY-PLAT-MIG-06 (line 56) | [ ], after MIG |
| RPK-02, 06, 09, 10, 11, 12, 13, 18, 19, 20, 21 | no equivalent task anywhere | NOT BOUND |

So: nothing is "eaten" (da an). Phase A tasks (PLAT-MIG-00/01/02/03) run
independently and are NOT RPK substitutes except MIG-00 which shares the
RPK-01 inventory output.

## (4) Duplication of the shared deliverables - measured, not assumed

Six packages exist under packages/. No copy of any of them exists in
services/ or businesses/.

| Package | files (.ts/.tsx, excl node_modules/dist) | package.json sha256 (12) | import sites |
|---|---|---|---|
| contracts | 56 | 41FEA4B22E41 | 272 |
| worker-sdk | 45 | 10572E954F47 | 66 |
| connector-client | 13 | 03DA03E1F1A2 | 5 |
| document-kit | 28 | BE56128C40F1 | 28 |
| observability | 11 | 329C89025901 | 39 |
| egress | 5 | 28620E6ECBA4 | 21 |

Total 431 import sites. Signature-file probe for a vendored copy:
- connector-invoker.ts -> exactly 1 (packages/worker-sdk/src)
- metadata-crypto.ts -> exactly 1 (services/orchestrator/src/modules/runtime)
  - orchestrator-owned, not a contract copy
- redactor.ts / canonical-json.ts / egress.ts / fetch-bounded.ts -> 0 anywhere

And the RPK TARGET directories do not exist yet:
- services/orchestrator/src/contracts/ -> absent
- businesses/*/src/contracts/ -> absent; businesses/*/src/platform/ -> absent
- businesses/document-core/src contains actions, config.ts, index.ts, main.ts,
  manifest, pipelines, recipes, types, validation, worker.ts - no contracts/,
  no platform/, no document/. Same for example-review and lc-checker.
- development/ (contract-bundles, worker-reference, skills) -> absent

VERDICT on contract authority: it has NOT forked. There is exactly one
contracts source (packages/contracts, 272 consumers). That is a consequence of
RPK never running, NOT a property that was defended - nothing in the tree
prevents a future writer from creating the duplicate layout.

## (5) Collisions RPK would hit

- Creation collisions: NONE today. Every path RPK-01 layout would create
  (services/orchestrator/src/contracts/, businesses/<w>/src/{platform,
  contracts,document}, development/**) is currently absent, so no existing file
  is overwritten and no name is taken.
- Deletion collision (RPK-18, the dangerous one): retiring the 6 packages
  invalidates 431 import sites - contracts 272, worker-sdk 66, observability 39,
  document-kit 28, egress 21, connector-client 5. Section 6 requires scanning
  every consumer before removal; the count above is that blast radius, measured
  on the working tree of 2026-10-05.
- Name collision risk to watch: businesses/scratch/ already holds a
  du-document-core-audit scratch dir; RPK-16 scratch repos must not reuse that
  name. pnpm-workspace.yaml + root lockfile are the single-writer surface for
  RPK-18 (section 6 note).

## (6) Status table and what must be restored before Phase B

| RPK | Status |
|---|---|
| RPK-00 | ABSENT - no task, no receipt; this is the binding gap the user ordered closed |
| RPK-01 | NOT STARTED (shares output with PLAT-MIG-00, itself [ ]) |
| RPK-02..21 | NOT STARTED - no task, no owner, no lease |
| VFY-RPK-01..05 | NOT STARTED |
| any RPK RUNNING | NONE. Run run_069ecd6957cd has 0 RPK tasks (confirmed in
  coordinator-state.json:2204 and independently by this inventory) |

Conditions that must exist before Phase B (MIG-04/05) can safely open:
1. RPK-00 instantiated as a REAL task with a named coordinator/reviewer owner
   and a closure receipt (baseline commit/build digest, contract version,
   image/config/migration revisions, receipt index, rollback artifact).
2. RPK-01 inventory frozen after RPK-00 (section 3 explicitly requires a
   re-count because the tree keeps moving) - the counts in (4) are the
   pre-freeze baseline and must be re-measured at closure.
3. Named owners + file leases for RPK-03/04/08/15 and RPK-05/07/14/16/17, and
   an independent tester for VFY-RPK-01/02/03/05.
4. Only then may MIG-04/05 open extraction writers. Until 1-3 exist, MIG-04/05
   stay closed - which is what the docs already say (MIG-04 row: "Sau RPK-00
   va frozen inventory").

## Ledger

RPK-BASELINE-BIND-885 - Muc 1 - proved RPK-00..21 exist only as prose (0 task
files, 8 prose hits in coordination JSON, all rows [ ]); mapped the four RPK
groups the docs bind to PLAT-MIG-00/04/05 and VFY-PLAT-MIG-06 and listed the 11
RPK IDs bound to nothing; measured the six shared packages (files, package.json
sha256, 431 import sites) and confirmed ZERO duplication and ZERO target
directories, so contract authority has not forked; listed RPK-18 deletion blast
radius; stated the four conditions Phase B needs. VERIFY/INVENTORY ONLY: no
source edit, no commit, no tick, no package split.
