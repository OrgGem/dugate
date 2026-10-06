# PLAT-MIG-00 — topology freeze and export inventory

Date: 2026-10-05 (snapshot checked 11:22 UTC / 18:22 ICT)  
Scope: read-only topology/inventory packet plus the documentation alignment described below. No source implementation, repository creation, migration tick, or commit was performed.

## Decision frozen

The target is two repo types by default, with an optional third type:

1. **Orchestrator repo** owns the Portal, Platform API and Orchestration Runtime source, and Connector source. API and Runtime remain in one process. Connector stays a separate service and image with its own configuration, scale and internal HTTP boundary. It is not folded into the API process.
2. **Worker repo/template** is instantiated for each business. Each business image/build/deployment/scale is independent; instances for the same business and exact version consume that version's queue.
3. **Connector repo** is an optional third repo type for a later decision, not part of the default topology.

Do not rename Orchestrator to `platform-api` or App Portal, split Runtime into another service, or co-locate Connector in the API process. These constraints agree with [docs/40-du-platform-architecture.md](../../docs/40-du-platform-architecture.md:3), [DU-PLATFORM-MIGRATION](../../tasks/DU-PLATFORM-MIGRATION-2026-10-05.md:5), and the RPK topology addendum in [SHARED-PACKAGES-REDISTRIBUTION](../../tasks/SHARED-PACKAGES-REDISTRIBUTION-2026-10-05.md:3).

## Topology map: target and current materialization

| Target repo/type | Source currently in workspace | Runtime service/image or template | Boundary and status |
|---|---|---|---|
| Orchestrator | `du-rework/apps/admin-web/`, `du-rework/services/orchestrator/`, `du-rework/services/connector/`, shared packages and deployment assets | Orchestrator image contains the built Admin Web bundle; API + Runtime use the same Orchestrator process. Connector has its own Connector service/image. | One repo in the target. Portal is UI/BFF; Platform API and Runtime stay together. Connector management goes through the backend, while Connector's service boundary remains separate. |
| Worker template | `du-rework/businesses/document-core/`, `example-review/`, `lc-checker/` | `document-core`, `example-review`, `lc-checker` are separate image targets made from one Worker-template pattern. | One business per Worker repo instance in the target; independently built, deployed and scaled. Runtime handoff uses exact-version queue and HTTP contract boundaries. |
| Optional Connector repo | No selected independent Connector repo in this workspace | Would contain the same separately deployed Connector service/image | Optional third repo type, not selected or required by the frozen default. |

Evidence in current build configuration: [Dockerfile](../../Dockerfile:22) has distinct build stages for Orchestrator, Connector and each of the three Worker targets; [Dockerfile](../../Dockerfile:39) starts Connector as its own runtime target, while [Dockerfile](../../Dockerfile:57) produces Orchestrator and copies the Admin Web distribution into it. `compose/connector.yml` uses image `du-connector` and target `connector`; each worker compose fragment uses its own image and Docker target. The top-level Compose file includes infrastructure, Orchestrator, Connector and all three business fragments ([docker-compose.yml](../../docker-compose.yml:3)).

This is **not yet an independent-repository build proof**: the service and Worker fragments use `context: ..` and the shared `du-rework/Dockerfile` (for example [compose/connector.yml](../../compose/connector.yml:3), [compose/document-core.yml](../../compose/document-core.yml:3)). The Dockerfile copies the root workspace, packages, services, businesses, apps and tests into shared build stages ([Dockerfile](../../Dockerfile:9)). The current Git root is `D:/Git/dugate`; `du-rework/` is a workspace directory inside it, not a nested Git repository.

The exact queue contract is `du-business-{businessId}-{exactVersion}` in [packages/contracts/src/queue.ts](../../packages/contracts/src/queue.ts:4). Queue names are platform-generated, and the Worker instance for the specified business/version consumes that queue. This inventory records queue-reference occurrences; use the contracts definition as the canonical name format, not prose/test mentions as additional queue contracts.

## Current export inventory snapshot

The path-and-hash sidecar is [plat-mig-00-export-inventory-2026-10-05.tsv](plat-mig-00-export-inventory-2026-10-05.tsv). It records the SHA-256 for every listed file row and source path/line/item for import, queue-reference, env-name, package-dependency and contract-consumer rows.

| Measure | Snapshot/result |
|---|---:|
| Inventory snapshot time | `2026-10-05T11:20:11.128Z`; listed hashes rechecked at `2026-10-05T11:22:10Z` |
| Git HEAD observed | `b088eececcb5f3df0b4edbe073a29401dafda624` |
| File rows / file-row SHA-256 | 1,580 / `f803bc57e0290d8b5f2db241618b441f39f30f19eb23d6c213f0267ccc54f4ba` |
| TSV data rows (excluding header) | 8,725 (8,726 physical lines including header) |
| Import occurrences | 4,948 |
| Queue-reference occurrences | 1,170 |
| Env-name references / unique names | 753 / 231 |
| Declared internal package-dependency edges | 26 |
| Contract-consumer rows | 248 |
| File categories | 31 build/deployment; 82 Connector; 114 cross-service tests; 200 legacy product; 446 Orchestrator API/Runtime; 73 Portal; 38 scripts/CI/tooling; 170 shared docs/contracts/plans; 182 shared package/reference; 28 tests/fixtures; 204 Worker business/template; 12 workspace files |
| Listed files whose current hash mismatched the snapshot at recheck | 0 |
| Untracked source/build/test/docs candidates under scoped roots represented in the file rows | 305 / 305 |

`file` rows include tracked and untracked relevant workspace inputs. At verification, the overall Git worktree had 2,573 tracked paths, 2,386 non-ignored untracked paths, 192 tracked modified paths, and zero staged paths. The 2,386 count is repository-wide and is not the export's file count. Generated build outputs and unrelated coordination receipts/raw verification artifacts are outside the export scope; safe environment templates contribute key names only. Local `.env` values and secret values were neither read nor copied.

The inventory is a **listed-file hash snapshot**, not proof that every file in the filesystem or every external consumer has been discovered. The row coverage is bounded to the selected source, test, fixture, docs/plans, manifests, CI, scripts and build/deployment roots. Re-run it after RPK-00 and before extraction, and expand the scope if new roots or external consumers are found. Contract-consumer rows show local source/manifest consumers, not an external user census.

### Import, dependency, environment and contract consumer findings

- The workspace currently has six shared package directories: `contracts`, `worker-sdk`, `connector-client`, `document-kit`, `observability`, and `egress`. The TSV records 26 declared internal dependency edges. Notable edges that RPK-01 must explicitly classify include `@du/orchestrator -> @du/worker-sdk`, `@du/connector-client -> @du/connector`, and `@du/worker-sdk -> @du/connector`; these are present in the manifests and are not architectural recommendations.
- Direct declared consumers of `@du/contracts` are `@du/orchestrator`, `@du/connector`, `@du/worker-sdk`, `@du/connector-client`, `@du/egress`, `@du/document-core`, `@du/example-review`, `@du/lc-checker`, and `@du/integration-tests`. The inventory includes source imports and package manifests; external consumers remain unknown until COMP-01's consumer census.
- The env-name index includes, among others, `DATABASE_URL`, `CONNECTOR_DATABASE_URL`, `REDIS_URL`, `CONNECTOR_REDIS_URL`, `ARTIFACT_S3_ENDPOINT`, `ARTIFACT_S3_BUCKET`, `ARTIFACT_S3_REGION`, Vault address/token/mount names, worker identity/token names, queue controls and Connector configuration names. Only names are recorded, never values.
- `DU_CONNECTOR_BASE_URLS`, `DU_CONNECTOR_MANAGEMENT_HEADERS`, and `DU_CONNECTOR_IDENTITY_EXPIRES_AT` are parsed in [services/orchestrator/src/main.ts](../../services/orchestrator/src/main.ts:127), `:162`, and `:207`; partial management configuration is rejected, and values are passed into `createApp()` during boot (`:311`). But `compose/orchestrator.yml` and `.env.docker.example` do not forward these names, and the root Compose wiring does not set them. Therefore ACUI-M06 boot composition exists in source, but Compose cannot currently enable that connector-management deployment path using the checked-in example/config path.

## Contract consumers and serial ownership

The documents and RPK plan define owner roles, not currently bound individuals. The coordinator must bind one named owner per shared file at a time and serialize handoff; do not infer named ownership from this receipt.

| Shared artifact/boundary | Current consumers | One-owner-at-a-time ownership/handoff |
|---|---|---|
| `packages/contracts/` and wire schemas | Orchestrator, Connector, worker/client/shared packages, three businesses and integration tests; external callers still need COMP-01 census | Canonical source owner is Orchestrator under RPK-02/03; COMP-02 owns compatibility/schema adjudication. Worker copies are pinned consumers with provenance, not a second authority. |
| `docs/21-openapi.json` and API contract docs | Portal/API clients and external integrations | COMP-02 owns schema compatibility decision; generator is the only writer of generated OpenAPI. COMP-11 documentation/release owner syncs after COMP-10 golden verification; no hand-editing generated JSON. |
| `du-rework/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` | All workspace packages, services, apps, businesses and integration tests | One integration/build owner holds the root manifest/workspace/lockfile lease; plan assigns this to the RPK-18 integration owner after RPK-00 and its predecessors. Component owners submit dependency changes through that owner. |
| `du-rework/Dockerfile` | Orchestrator, Connector, all three Worker targets | One build/repo integrator owns the shared Dockerfile (PLAT-MIG-04/RPK-15); service owners request target changes, with no concurrent edits. |
| `du-rework/docker-compose.yml`, `compose/infra.yml`, service fragments | Local Compose stack and deployment operators | One deployment/security owner holds central Compose and ingress/network wiring for PLAT-MIG-02. After boundary freeze, serialize handoff to the PLAT-MIG-04 build integrator for independent build contexts. Fragment requests go through the central owner; do not let parallel writers change the stack topology. |
| `docs/40`, `docs/02`, `docs/03`, `docs/09`, `docs/12b` | Architecture implementers, build/deployment and service owners | This packet's documentation integrator held the PLAT-MIG-00 docs lease. Release it after this receipt; the coordinator must bind the next docs writer and avoid overlap with COMP-11 docs/OpenAPI work. |

## Dependency order and gates

RPK table state remains unchecked/deferred in [SHARED-PACKAGES-REDISTRIBUTION](../../tasks/SHARED-PACKAGES-REDISTRIBUTION-2026-10-05.md:94). **RPK-00 is the hard gate for source redistribution, extraction, new worker references/bundles/skills and package retirement.** Its read-only inventory work may proceed before the gate; PLAT-MIG Phase A boot/ingress work uses its own leases and does not satisfy or bypass RPK-00.

| Item | Depends on | What it gates / sequencing |
|---|---|---|
| RPK-00 baseline closure | Required scope accepted; P8-08/G6 and applicable gates; closure receipt, digests, rollback and leases | Hard gate before RPK implementation/source redistribution. |
| RPK-01 inventory + layout ADR | RPK-00 | Complete local runtime/test/tool/Docker import graph and export→owner→consumer→test matrix; layout decision. This packet is an input, not RPK-01 acceptance. |
| RPK-02 contract authority/compat | RPK-01 | Wire/version/hash/state/auth/bounds ownership and compatibility matrix. |
| RPK-03 move contracts/domain to owners | RPK-02 | Canonical Orchestrator contract source and correct service-domain ownership; transitional callers remain buildable. |
| RPK-04 bundle/conformance harness | RPK-03 | Immutable bundle/version/digest, schemas/vectors/examples/mock/provider checks and drift detection. |
| RPK-05 Worker runtime reference | RPK-04 | Worker loop, clients, lease/checkpoint/fan-out/HITL/artifact/crypto/shutdown become self-contained with provenance. |
| RPK-06 source ingestion ownership | RPK-04, RPK-05 | Preserve URL→bytes→immutable-storage→READY/error, SSRF/hash and receipt semantics. |
| RPK-07 document reference/guide | RPK-04 | Parser/converter/ZIP/PDF, fixtures and resource/fallback behavior inventory. |
| RPK-08 local egress/observability | RPK-04 | Local module/vector copies with patch tracking, collector compatibility, bounded labels and redaction. |
| RPK-09 Document Core pilot | RPK-05, RPK-07, RPK-08 | First Worker pilot with six actions, exactVersion/replica routing and subset manifest. |
| RPK-10 isolated pilot build | RPK-09 | Self-contained manifest/lockfile/Docker/entrypoint with no sibling imports or COPY. |
| RPK-11 independent pilot verify | RPK-06, RPK-10 | VFY-RPK-01/02/03 PASS and Claude APPROVED; gates moving the other workers. |
| RPK-12 Example Review | RPK-11 | Move its runtime/contracts/document subset and preserve custom logic; isolated build. |
| RPK-13 LC Checker | RPK-11 | Move its runtime/contracts/document subset; preserve fan-out/workflow/custom patches; isolated build. |
| RPK-14 Connector callers/clients | RPK-11 | Local invoker/client consistency, auth/grant/UNKNOWN/cancel/replay parity. |
| RPK-15 independent services/collector builds | RPK-06, RPK-08, RPK-14 | Orchestrator, Connector and collector build/config/migrations/health/logging without sibling source. |
| RPK-16 guides + four skills | RPK-11 | Pinned scaffold/upgrade workflow and scratch build/conformance; preserve custom patches. |
| RPK-17 patch/version workflow | RPK-12, RPK-13, RPK-15, RPK-16 | Compatibility, upgrade/advisory routing and patch propagation rehearsal. |
| RPK-18 tooling/tests/CI/workspace/lockfile/docs + retire six packages | RPK-12, RPK-13, RPK-15, RPK-16, RPK-17 | Only after complete consumer scan; one root integration/lockfile writer. |
| RPK-19 final candidate verification | RPK-18 | VFY-RPK-01..05 on exact candidates, mixed-version/business/tenant/replica evidence. |
| RPK-20 canary/rollback rehearsal | RPK-19 + backend APPROVED | Isolated namespace, drain/mixed-image rollback; no production switch from this plan alone. |
| RPK-21 acceptance and rollout | RPK-20 | Candidate approval, reviewers, runbook and separately authorized deployment. |

Other gates:

- **ACUI-M06 / PLAT-MIG-01:** the source boot adapter and URL/management-identity env parsing are implemented in `main.ts` and the current receipt `coordination/reports/plat-mig-01-boot-composition-2026-10-05.md` records offline tests/typecheck. Independent acceptance is not claimed here. Compose env forwarding is still absent as described above. Before enabling a deployed management path, require deployment-owner wiring and its fail-closed configuration test.
- **PLAT-MIG-02:** controls internal Connector ingress and public/admin/runtime audience boundaries. The migration plan lists this as a Phase A deployment/security gate. Local topology/build evidence does not prove production ingress configuration.
- **COMP-02:** freeze external schema/compatibility before public wire changes or cutover; it depends on COMP-00/01. **COMP-10:** offline/live golden verdict, including live dependencies where required. **COMP-11:** sync generated OpenAPI/docs and reviewer acceptance after COMP-10. These gate external API compatibility/cutover claims, not this read-only topology inventory.
- **PLAT-MIG-03** must preserve Connector root-path/auth/audience contracts and use COMP owners for any public API/OpenAPI change. **PLAT-MIG-04/05** extraction/build work remains Phase B and waits for RPK-00 and its dependency chain.

## SPECIFIED vs DEPLOYED

| State | What evidence supports |
|---|---|
| **SPECIFIED** | The target and boundaries are fixed in docs/40 and the migration plan. The target is two repo types by default, optional third Connector type. |
| **Materialized in current source/workspace** | Portal, Orchestrator API/Runtime, Connector service, three Worker image targets, packages, tests and Compose/Docker artifacts exist. Builds are separate targets/images in a shared workspace. |
| **Not established by this repository evidence** | Independent Orchestrator/Worker Git repositories or isolated scratch builds; production deployment topology, active ingress/configuration, production cutover, or third Connector repo. This report makes no claim that production does not exist; it records that the repository does not prove those facts. |

`du-rework/docs/03-project-structure.md`, `docs/09-queue-sdk.md`, and `docs/12b-deployment-guide.md` were aligned with the frozen target and current Compose/ACUI-M06 state under the PLAT-MIG-00 documentation lease. `docs/02-architecture.md` and docs/40 already agreed with the decision and were left unchanged. Plan/checklist task statuses were not changed or ticked.

## Completion boundary

This receipt and TSV are inputs for coordinator review and later RPK-01. They do not accept RPK-00, declare any RPK or PLAT-MIG task complete, create candidate repos, or authorize deployment/cutover. The next migration action requires coordinator-bound named owners, serial file leases and the applicable approval gates above.
