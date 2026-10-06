# Codex Arch — Phase B review and remediation

Date: 2026-10-06. Owner: codex_arch. Dispatch: ARCH-REVIEW-AND-REMEDIATION-PHASE-B.

## Verdict

The two reproduced causes of HANDLER_ERROR are fixed in canonical source. MIG-04's independent Node 24 build milestone is demonstrated for Backend, Portal and a separate Connector image. MIG-05 expansion is **NO-GO until the pilot starts independently**, despite its successful TypeScript build. Migration acceptance remains OPEN; the approximate 82% supplied in the dispatch was not independently measured. No task rows were ticked, no commit/push/remote/cutover, no paid provider calls.

## 1. Worker diagnostics: conclusions corrected and causes reproduced

`worker-handler-stack-diagnostics-2026-10-06.md` correctly left the root cause unresolved, but two deductions were too strong:

- A thrown value without a string `.code` need not be a plain Error. In the reproduced runs it was **ZodError**. Equal fallback codes across actions do not prove a single common failing statement.
- Zero persisted checkpoints does not mean execution stopped before checkpoint processing. The step body may run and artifact allocation may occur before the SDK validates the response or saves a success checkpoint.

The added raw `message`, `stack`, `detail` and `detailCause` were ineffective at the production log sink: `packages/observability/src/logger.ts` removes reserved `message` fields, while `log-metadata.ts` excludes arbitrary stack/detail fields. The patch now retains error class and a restricted compiled source location as allowed metadata (`packages/worker-sdk/src/worker.ts:413`). It does not weaken redaction or log exception text, response bodies, credentials or document content. This location is diagnostic metadata, not a complete stack trace.

### Cause A: production PostgreSQL artifact grants lacked a trusted internal origin

Baseline local production images accepted ingest, then failed with HANDLER_ERROR and zero saved checkpoints. The test-only instrumentation in `phase-b-runtime-diagnostic-2026-10-06.cjs` observed:

```json
{"diagnosticMethod":"requestUploadGrant","errorName":"ZodError","issues":[{"code":"invalid_string","path":["uploadUrl"]}]}
```

This is a transcribed observation from the diagnostic run, not a fabricated raw log file. The instrumentation reports schema issue metadata only. The PostgreSQL storage facade returned a relative proxy URL; production Host hardening deliberately kept it relative without configured origin. `ArtifactUploadGrantSchema` requires an absolute URL. The production entrypoint did not provide the configured base and Compose did not wire it, so the SDK failed before `saveStep`.

Implemented:

- `services/orchestrator/src/server.ts:179`: distinct `runtimeBaseUrl` configuration.
- `services/orchestrator/src/main.ts:128` and `:273`: parse/wire `ORCHESTRATOR_INTERNAL_BASE_URL`; HTTP(S) origin only, no credentials/path/query/fragment. Missing origin refuses production PostgreSQL boot with an actionable configuration error. S3-only boot is exempt when no origin is supplied.
- `services/orchestrator/src/http/routes/runtime.ts:164`: trusted Runtime origin takes precedence over the legacy public origin for upload/access/multipart grants. Existing absolute S3 URLs remain unchanged. No production Host-derived fallback was enabled.
- `compose/orchestrator.yml:29` and `.env.docker.example`: default `http://orchestrator:3002`. The public 3000 fence still rejects Runtime; internal 3002 is not published by this change.

Outside Compose, operators must configure the actual worker-reachable internal origin. Pointing this variable at the public listener would still be incorrect. In-process callers retain the legacy public-origin fallback for compatibility.

### Cause B: adapter metadata leaked into strict Connector provider options

After Cause A was fixed, extract saved its build-prompt checkpoint but failed with ZodError. Synthetic diagnostic interception observed:

```json
{"diagnosticMethod":"connector.invoke","errorName":"ZodError","issues":[{"code":"unrecognized_keys","path":["options"]}]}
```

`promptStepId` is used locally to select the pinned prompt. The adapter forwarded it in provider options, which `InvocationOptionsSchema` rejects. `sessionRef` also has its own top-level SDK invocation field.

`businesses/document-core/src/worker.ts:454` now removes these two adapter fields from the copied provider options after consuming them. Provider options are preserved, unknown unrelated options still reach strict validation, and the caller's options object is not mutated. Session continuation still goes through SDK `invokeOpts`. New regression coverage checks both the strict options schema and session forwarding.

### Live verification and limits

Namespace: **arch-phase-b-20261006**, host ports **3360/3361**, separate Postgres/Valkey volumes; synthetic tenant/input, existing local secret configuration, no secret values captured. Production `NODE_ENV` and `AUTO_MIGRATE=false` were retained. Final images in `phase-b-live-image-ids-2026-10-06.txt` match the scanned image IDs.

- Final ingest operation `64edc168-c736-4e9f-aebb-71b5aed722cd`: **SUCCEEDED**, one successful task, **2 checkpoints**, result/download verified against input, idempotent replay HTTP 200 with the same operation ID. Harness exit **0**.
- Final extract operation `4f060607-5ed8-4324-a326-837646e74493`: one checkpoint then **BINDING_DENIED**, not HANDLER_ERROR. Extract success is **not accepted**: this stack has no configured Connector revision/profile binding/provider. Extract harness exit **1**, retained honestly.
- Baseline and intermediate operation rows are captured in `phase-b-operation-evidence-2026-10-06.txt`; the initial zero-checkpoint failures and later one-checkpoint option failures are distinct.
- `docker compose down` for this namespace completed with exit **0**. Its volumes were retained; shared live infrastructure was not shut down. No production DB/backfill was touched.

## 2. MIG-04 candidate remediation

Before this task, the candidate omitted Portal, declared Node >=20 and used the parent repository's TypeScript installation in `scripts/build.cjs`. Its Docker context also referenced absent worker directories. Those properties could not establish independent readiness.

`scripts/export-orchestrator-candidate.cjs` now refreshes an explicit source boundary:

```text
migration-candidates/orchestrator/
  apps/admin-web/             Orchestrator Portal, current folder name
  services/orchestrator/      public API, internal Runtime/admin, BFF
  services/connector/         independently built Connector process/image
  packages/                  six canonical platform packages
  vendor/ + patches/         pinned XLSX artifact and braces mitigation
  scripts/docker/            local build/deploy tooling
  Dockerfile + manifests + lockfile + Node version files
```

No businesses directory, credentials, host dependencies or compiled output are exported. Docker ignores existing local node_modules. The workspace declares packages/services/apps only; Node baseline is `>=24.21.0 <25`, pnpm **10.18.3**, Docker base **24.21.0**, with the canonical pinned digest.

The candidate builder executes its own workspace build tools, without parent TypeScript resolution. Its runtime helper handles the intentionally absent businesses directory. Its Dockerfile has only Orchestrator and Connector service targets. The ingress test's worker-sibling helper was explicitly copied into candidate `services/orchestrator/tests/helpers/` and the import rewritten locally. Portal UI `features/businesses` aliases are not worker repository dependencies; the isolation checker now distinguishes them.

Proof:

- Build candidate Docker build-base, then `docker run --rm --network none du-phase-b-candidate-builder:20261006 pnpm -r run build`: **exit 0**, all **9 workspace projects** (six packages, two services, one Portal) build in a fresh Linux container with no parent repository mount.
- Candidate `docker build --target orchestrator ... .`: **exit 0**, Backend plus Portal bundle deployed into the runtime image.
- Candidate `docker build --target connector ... .`: **exit 0**, separate Connector image and copied migrations.
- Isolation checker: **691 TS files, zero relative imports escaping the repo, zero worker sibling imports, no businesses directory**, exit **0**.
- Source inventory: **815 source files**, final recheck **zero canonical source drift**. SHA256 receipt: `phase-b-source-hashes-2026-10-06.json`. Helper provenance uses its original worker test source explicitly; generated/rewritten candidate files have separate receipt hashes.

Canonical lockfile importers for historical workers/tests remain in the copied lockfile; frozen candidate installs/builds succeed and do not make those directories workspace members. The exporter overlays its allowlisted files; future removed-source cleanup requires explicit reconciliation rather than assuming an overlay deletes obsolete files. Existing ignored host node_modules were not used for the Docker proof.

**MIG-04 build milestone is implemented, not final acceptance.** Portal folder rename is still MIG-08. The complete reference/docs/skills export, deployment and contract conformance inventory, Swagger distribution and independent tester sign-off must be reconciled against the master plan before closing the whole row. The existing Orchestrator -> worker-sdk dependency still requires the planned responsibility/export audit; successful compilation does not settle that architecture question.

## 3. MIG-05 pilot expansion assessment

The old pilot receipt saying “not materialized” is historical: `businesses/document-core/template` now has copied source and five vendored platform areas. Actual verification supersedes that receipt:

| Check | Result | Exit |
|---|---|---:|
| Existing workspace-assisted noEmit check | Pass; not isolation proof | 0 |
| Fresh Node 24 container, template-only mount, install + tsc | Pass | 0 |
| Same isolated install/build, `node dist/src/main.js` | MODULE_NOT_FOUND: @du/worker-sdk | 1 |

`tsconfig.paths` resolves types during compilation but does not rewrite emitted CommonJS require paths. The manifest points to `dist/index.js` although this rootDir layout emits `dist/src/index.js`; it lacks a start script. The manifest retains Node >=20 / @types/node 20 and lacks a committed standalone lockfile. Dynamic parser dependencies **mammoth** and **xlsx** are absent from its manifest, even though their parser code was copied. It does not carry the current pinned XLSX security artifact/configuration or the fixes above. A clean compile therefore does not establish a usable or security-aligned worker template.

Recommended serialized rollout under Antigravity's existing leases:

1. **Repair Document Core pilot first.** Choose one real runtime resolution mechanism: local versioned vendor workspace packages, explicit relative imports, or a tested bundler/alias rewrite. Package parser worker-thread assets as well as JS. Correct entrypoints/start/Docker, Node 24 engines/types, full direct/transitive dependencies, standalone frozen lockfile and security artifacts. Keep canonical contracts in Orchestrator; local packages do not create a separate SDK repository.
2. **Freeze upgrade/provenance boundary.** Record exact contract/reference revisions, bundle/source hashes and a regeneration policy preserving worker custom patches. Propagate the two fixes above. API clients remain thin and local; lease/fence/checkpoint/crypto/document runtime code cannot be replaced by prose instructions alone. A skill may scaffold and update those files, not substitute for executable code.
3. **Pilot gate.** Install/build/start in a fresh context without parent/sibling mounts; parser fixtures including XLSX/Word; signed identity and tenant grants; claim/heartbeat/fencing; checkpoint replay; invoke/get/cancel; wait/children; secret redaction; Node 24 production-image and full dependency audit. Use mock providers for successful extract and retain negative binding tests. Require independent tester receipt.
4. **Example Review next**, as the smaller validation consumer. Migrate its own manifest/config/main/tests and local dependency closure; never copy Document Core action code wholesale. Prove standalone start plus continuation/replay before proceeding.
5. **LC Checker last**, reusing the proven template and contract vectors, with its document-set parsing, bounded fan-out, child/join/wait and result-evidence tests. Verify its parser closure, not only the three declared @du dependencies.

Do not materialize two more copies of this non-starting pilot. Separate worker-source leases from the canonical bundle/lockfile generator lease. Coordinator should bind those existing lanes and re-run producer-consumer verification when a canonical fix changes vendored workers. No new coordinator or acceptance gate is introduced by this report.

## 4. Verification receipt and remaining gates

All paths below are in `coordination/reports/` and dated `2026-10-06`; corresponding `.exit.txt` files preserve actual native exit codes despite PowerShell stderr decoration in some logs.

| Verification | Receipt stem | Result |
|---|---|---|
| Runtime origin + host hardening | phase-b-runtime-contract-tests | 2 suites, **18/18**, exit 0 |
| Session metadata + checkpoint/replay | phase-b-worker-tests | 3 suites, **30/30**, exit 0 |
| SDK lifecycle/failure classification | phase-b-sdk-tests | 1 suite, **25/25**, exit 0 |
| Candidate complete workspace build | phase-b-candidate-all-build | exit 0 |
| Candidate Orchestrator/Portal image | phase-b-candidate-build | exit 0 |
| Candidate Connector image | phase-b-candidate-connector-build | exit 0 |
| Document Core remediation image | phase-b-worker-build | exit 0 |
| Final live ingest | phase-b-live-fixed-e2e + phase-b-live-summary.json | PASS, exit 0 |
| Final live extract | phase-b-extract-fixed-e2e + phase-b-extract-summary.json | BINDING_DENIED after checkpoint; exit 1 |
| Isolated pilot start | phase-b-template-isolated-start | MODULE_NOT_FOUND, exit 1 |

Focused tests total: **73 passed, 6 suites, 0 failed**. These are owner checks, not independent migration acceptance. Scoped git diff --check passed. No test was weakened or converted to an expected failure.

Trivy scans of the **three final changed images** (candidate Orchestrator, candidate Connector, Document Core) used the previously freshly downloaded 2026-10-06 DB in `du-security-trivy-cache`. All show **0 High / 0 Critical**, exit **0**, scanned image IDs equal current image IDs; see `phase-b-image-summary-2026-10-06.json` and the three raw scan JSONs. This scan is bounded to those images/database findings. It does not erase the earlier full dependency audit's patched-braces High advisory or sprintf-js Moderate, does not certify the copied worker pilot, and is not a complete application security audit.

Antigravity handoff: review the changed source/hash receipt; bind independent verification for Runtime origin/config deployment and both adapter fixes; repair the MIG-05 pilot runtime/packaging before expansion; configure an isolated mock Connector binding for successful extract; complete the remaining MIG-04 reference/tooling/Swagger/rename acceptance inventory. The global migration and security gates remain OPEN.
