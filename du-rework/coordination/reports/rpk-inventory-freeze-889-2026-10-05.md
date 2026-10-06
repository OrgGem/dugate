# RPK-INVENTORY-FREEZE-889 — receipt (qwen_1, 2026-10-05)

Task task_363053ebe8d0. USER authorized 2026-10-05 to do this now, not
plan-only; RPK-00 local wait SUPERSEDED. No commit, no push, no prod cutover.
Leases respected: NEW this receipt, NEW tools/repo-migration/freeze-inventory.cjs.
ZERO product source edited. docs/40, 02, 03, 09, 12b untouched (PLAT-MIG-00).

## Artefacts produced

- tools/repo-migration/freeze-inventory.cjs — the freeze tooling (NEW).
  Walks the CURRENT working tree, hashes every product file with SHA-256,
  records git_state, classifies, emits the TSV field set that the existing
  verifier tools/repo-migration/verify-inventory.cjs already expects
  (record_type, path, git_state, sha256 + bytes, class).
- coordination/reports/raw/rpk-inventory-freeze-889-2026-10-05.tsv — the
  frozen allowlist, 1019 rows, one row per file.
- coordination/reports/raw/rpk-inventory-freeze-889-summary.json — counts,
  class x state, UNCLASSIFIED list, per-candidate digests, tree digest.

## Muc 1 — FREEZE SOURCE HASH

### (1) Allowlist scope: working tree, NOT HEAD

A20 is correct and the tool honours it: git_state is recorded PER ROW, not
used as the export basis. Concretely, of the frozen product source:

| git_state | files |
|---|---|
| tracked | 776 |
| UNTRACKED (classified and INCLUDED) | 243 |
| unknown | 0 |
| TOTAL | 1019 |

243 product-source files exist only in the working tree. By directory:
services/orchestrator/tests 75, apps/admin-web/src 65, services/orchestrator/src 43,
services/orchestrator/migrations 9, packages/contracts/src 6, packages/worker-sdk/tests 5,
businesses/document-core/tests 4, packages/contracts/tests 4, services/orchestrator/coordination 4,
businesses/document-core/src 3, packages/observability/src 2, services/connector/tests 2.
A HEAD-only export would have dropped every one of them — including 43
orchestrator src files and 6 contract files, i.e. exactly the surface where
the public.ts/mappers.ts bypass was never in HEAD.

Tool correction found by running it: the first pass reported 1028 files with
9 "unknown" — all of them services/orchestrator/.cache/** (jest haste-map and
.bak files from other lanes). .cache is now skipped; final run is 1019 files,
0 unknown. Not cleaned from disk (other lanes may own them); just excluded.

### (2) Classification

| class | files | rule |
|---|---|---|
| (a) a-canonical-contract-shared-lib | 702 | packages/** and services/** (canonical contract/shared lib + Orchestrator + Connector server source; both live in the Orchestrator repo per the frozen topology) |
| (b) b-worker-template | 16 | businesses/*/src/{main,worker,index,config,manifest,registry-tool}.ts — template scaffolding, versioned per worker |
| (c) c-business-customization | 184 | everything else under businesses/** — stays at the worker |
| (d) d-infra-ci-docker-compose | 41 | Dockerfile/docker-compose/.dockerignore/.github/**/infra/**/compose/** + package.json, pnpm-lock.yaml, pnpm-workspace.yaml, tsconfig.base.json, .npmrc |
| UNCLASSIFIED | 76 | see (3) |

### (3) UNCLASSIFIED — 76 files, each listed in the TSV annex, NOT self-assigned

Two groups, needing a USER owner decision:
- apps/admin-web/** — 72 rows: README.md, .gitignore, components.json,
  index.html, postcss.config.mjs, tsconfig.json, vite.config.ts, src/main.tsx,
  src/router.tsx, src/lib/utils.ts, src/lib/api/{client,index,types}.ts,
  src/styles/{app,tokens}.css, src/app-shell/app-shell.tsx,
  src/components/ui/** (README, app-shell-primitives, badge, button, card,
  demo, dialog, field, fixtures, index, input, select, state-panel, table, tabs),
  src/features/** (api-keys, businesses, connectors, docs, identity, index,
  operations, profiles, security, settings, usage, workflows screens+state),
  src/routes/** (14 route modules).
- tests/{integration,isolation,login,unit}/jest.config.cjs — 4 rows.

Why not self-assigned: admin-web is Portal UI (separate build + owner) and the
four top-level jest configs are shared test-runner config, neither of which any
of the four classes (a/b/c/d) can claim without a USER decision. Naming an owner
here would be exactly the silent re-classification the packet forbids.

## Muc 2 — DEPENDENCY MAP

### (4) Direct import graph per shared package (files importing it)

contracts (12 consumer groups, 272 import sites): services/orchestrator 109 files,
  businesses/document-core 31, packages/worker-sdk 19, services/connector 18,
  businesses/example-review 10, tests/integration 9, packages/connector-client 5,
  businesses/lc-checker 3, packages/egress 2, apps/admin-web 2, packages/contracts 1 (self),
  tests/harness 1, tests/browser 1.
worker-sdk: businesses/document-core 29, businesses/example-review 13,
  services/orchestrator 6, businesses/lc-checker 5, packages/contracts 1.
connector-client: packages/worker-sdk 2, businesses/document-core 1.
document-kit: businesses/document-core 16, businesses/example-review 3.
observability: services/orchestrator 20, packages/worker-sdk 5, packages/contracts 2,
  tests/harness 1, businesses/document-core 1, services/connector 1.
egress: services/orchestrator 3, packages/worker-sdk 3, services/connector 2,
  businesses/document-core 1.

Production vs tests vs tooling: production = services/** + businesses/** +
apps/admin-web; tests = packages/*/tests, services/*/tests, businesses/*/tests,
tests/{integration,isolation,login,unit,browser,harness}; tooling =
tools/**, infra/**, scripts/** (they do not import the packages directly today).

Transitive closure rule (from the direct edges above):
- worker-sdk -> contracts + observability + egress, so every worker importing
  worker-sdk transitively pulls contracts/observability/egress.
- connector-client is only reachable via worker-sdk (2) and one document-core
  file (1) — matches section 3 of the design doc (merge with
  worker-sdk/connector-invoker before retiring the package).
- document-kit reaches lc-checker 0 times: lc-checker keeps no document subset,
  which is exactly what RPK-07/RPK-13 must decide.

TWO RISKS the freeze surfaces for RPK-01 (both real, both mine to flag, not to fix):
- server -> worker-sdk: services/orchestrator imports worker-sdk in 6 files.
- contracts -> worker-sdk: packages/contracts imports worker-sdk in 1 file,
  while worker-sdk -> contracts in 19. That is a CYCLE across the proposed
  split boundary (contracts authority in Orchestrator, worker-sdk local to
  workers). It must be cut before RPK-03/RPK-05, or every worker copy carries
  the contract package anyway.

### (5) Duplication check — contract authority NOT forked

- Six packages, one copy each. Signature probe: connector-invoker.ts exactly 1
  (packages/worker-sdk/src); redactor.ts / canonical-json.ts / egress.ts /
  fetch-bounded.ts = 0 anywhere; metadata-crypto.ts exactly 1 and it is
  orchestrator-owned domain code, not a contract copy.
- Target layout absent: services/orchestrator/src/contracts/,
  businesses/*/src/{platform,contracts,document}, development/ — none exist.
- Contract authority remains a single source: packages/contracts, 272 consumers.
  Caveat restated: that is true because RPK never ran, not because anything
  enforces it.

### (6) Consumers + owners (one owner at a time)

| package | consumers | owner (single writer) |
|---|---|---|
| contracts | orchestrator, connector, 3 workers, admin-web, tests | Orchestrator (contract authority); Connector owner co-signs connector wire only |
| worker-sdk | 3 workers + orchestrator(6) | Worker owner per worker copy; Orchestrator owns the canonical reference |
| connector-client | worker-sdk(2), document-core(1) | Connector/caller owner; co-owner with Worker owner until the merge |
| document-kit | document-core(16), example-review(3) | Document Core owner |
| observability | orchestrator(20), worker-sdk(5), connector(1), document-core(1), harness | Platform owner + security review for redaction |
| egress | orchestrator(3), worker-sdk(3), connector(2), document-core(1) | Platform/security owner |

Shared-file owners, exactly one at a time:
- pnpm-lock.yaml + pnpm-workspace.yaml + root package.json -> Integration owner
  (RPK-18 single writer; nobody else touches them in the same window).
- services/orchestrator/Dockerfile -> Build owner.
- services/connector/Dockerfile -> Connector service owner.
- compose/** + infra/** -> Build/Deployment owner.
- docs/40, docs/02, docs/03, docs/09, docs/12b -> PLAT-MIG-00, NOT this packet.

## Muc 3 — RPK-00 baseline tracking (NOT ACCEPTED)

Exact working-tree snapshot digests per candidate (SHA-256 over the sorted
path+sha256 stream of that subtree):

| candidate | digest |
|---|---|
| du-rework (whole tree) | 0bcb5382c561b1549049a5ddc86503efb5931b3f8b0fcebeff773724622ace18 |
| services/orchestrator | a0f3c3c3500020bdd95a95db68dc88f57a9b22fd34dc0b5a736bf84da38aa050 |
| services/orchestrator/src | 92c0196b928b1ef64ab7d8dd039e12a9f459b04b452414a73720e9e1ea2251ec |
| services/orchestrator/migrations | b87e6b25458264cd6d95be0193db35347db56109e06f24acc332f970a33f942d |
| services/orchestrator/tests | 37be32e79e5637a6ea7289ea257c34986568be605f0cd29fa141a50c2ce0d2ac |
| services/connector | 233b0a661be1ce91374b5ffb697c870e2df3b4b5a737e403c99a20c433cadb39 |
| packages/contracts | 4481a38614b502386aa9628d7830b87f1517222592cd8016b985964e7caf49ea |
| packages/worker-sdk | f1acd7eb955fd50b918830fbdb92c92df1ab617e74abb2365187da9e1fb39503 |
| packages/connector-client | 3a3a4188e7338f278a89853d42b4420b7ba14de13f7eaa08df7725f9d9b277a7 |
| packages/document-kit | 082522c3b6539b64a2b116cf8edbe473a2eed69d7879d9eba5079f8c900beb47 |
| packages/observability | f3d9522a6efe015b0bd47f441f2695170d41359f2cdbc9cd0dbcbd8f9729059f |
| packages/egress | 317be8e6dc56f37d09326ba3f3bbf08ed7893e04c798ee79005935f260385443 |
| businesses/document-core | 9ca8a4ee7a304db7278280304ed2d946e12eb0eadde822f43c431dcf71ad6e8c |
| businesses/example-review | 2a407c718bd6999c338f783692625339ca91cd4354c1a7e916b8fbb191ecb29b |
| businesses/lc-checker | 375aa7191d102dc6afdff33ee687950a19d45ffc9aa59e317cc0e980d5bd2a41 |
| apps/admin-web | a800ad456be5ecb3acafbaadbdfc3643bf88a18910daf36869a72dd4968bf8fb |
| compose | afcfbac45ce24ad991cd372770fc5a0d338e7174502f616a12ddefe55367f962 |
| infra | 6b103fd9a2ddeb661bf0d3a66a7f85b1f1ce15c3f4086e43752a981fd1dcef93 |
| tests/browser | f4fab70c86629a4e708bde055ad291683b1ff8f065921e520c1573aed3e31f10 |
| tests/integration | 72e67f1264e0b9b68d3fc99b06109396aa8a7f54892d7d83372ecad3a7dccfb0 |
| tests/isolation | ddcd007adaab9179269ee31a5fe5aa8b3f955c80722c9d8d0aba6cb3ce6196e4 |
| tests/login | 09694afaf0ce4ef6d63e2de71faa16e585b96a4ef73f72987c1d0e28e6e81e42 |
| tests/unit | 51ea8e650492162c0b62d193f886492fd123396541ca29cc8bc1a1a387b668b9 |

Gates still missing before RPK-00 can be ACCEPTED (none of them is closed here):
1. 243 untracked product-source files are IN the digest but are not committed,
   so the digest is reproducible only against THIS working tree, not a commit.
   A commit of that content is required for a real baseline commit id.
2. UNCLASSIFIED 76 files have no owner decision.
3. contracts -> worker-sdk -> contracts cycle (6 + 19 files) unresolved.
4. No named lease/owner per shared file assigned by a coordinator.
5. No baseline image/config/migration revision set and no rollback artefact.
6. P8-08/G6 independent evidence not re-checked by this packet.

RPK-00 is NOT marked ACCEPTED by this receipt. This receipt freezes the
baseline INPUT and records the missing gates only.
