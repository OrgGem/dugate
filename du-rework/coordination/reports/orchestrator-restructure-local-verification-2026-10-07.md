# Orchestrator restructure — local repair and verification

Date: 2026-10-07. Scope: `du-rework` only. User authorized repairing relocation paths and local build/tests. No commit, push, production deployment or acceptance checkbox changes.

## Outcome

Relocation-related build and tested import failures repaired. All 12 production packages/components build successfully. Overall test status **PARTIAL**, with unresolved SDK and example-review findings below. Owner smoke is not independent acceptance or a full-stack live verification.

Canonical source is `orchestrator/{apps,services,packages}`; business workers remain in `businesses`. This is still a workspace under the DUGate Git repository, not a standalone Orchestrator repository.

## Changes

- Canonical Dockerfile copies security patches/vendor from `orchestrator/`, and advertises internal port 3002. Generated compatibility Dockerfiles regenerated through `node scripts/docker/sync-dockerfiles.cjs`; adding EXPOSE does not publish a host port.
- Root lockfile regenerated using `pnpm install --lockfile-only --ignore-scripts --offline`, aligning importers, workspace links, XLSX vendor override and braces patch paths with the new workspace. Frozen offline installation then succeeds.
- Worker TypeScript paths/typeRoots, shared fixture imports, integration/browser harness references and a build-order negative-test fixture now address the promoted source tree.
- Portal imports generated OpenAPI from the root `docs/21-openapi.json` at the correct additional parent depth. No hand-edit of generated OpenAPI.
- Moved platform tests point to the workspace-owned test harness. Contract tests find Vault policies and the settings specification at the workspace root.
- Claim-result fixtures explicitly supply required `profilePolicy: null` for operations admitted without a profile policy; production validation was not weakened.
- Root README, project/subproject trees, service documentation links and explicit source paths corrected. Local instructions reflect Node 24, internal Runtime port 3002 and actual dev-runner behavior, including no default seeded account and no termination of unrelated occupied-port owners.
- Local private `.env.local` Runtime URL port changed from 3000 to 3002 only. No secret values printed; this private file must remain excluded from Git.
- Isolation checker explicitly permits workspace-owned test harness/isolation imports and the Portal's generated OpenAPI import, reports their count separately, and retains denial of worker sibling imports. Its relative `from` import scan is not proof of a self-contained repository.

## Toolchain and execution

Build/tests/install use **Node v24.21.0**, **pnpm 10.18.3**, Windows PowerShell/Python orchestration. The existing global Windows pnpm shim forces Node 22 despite a Node 24 PATH entry. For installation, invoke `node C:/nvm4w/nodejs/node_modules/corepack/dist/pnpm.js ...` with Node 24 on PATH; build uses a temporary `pnpm.cmd` shim in `%TEMP%/du-restructure-node24-shim` that invokes the same CLI with the absolute Node 24 executable. No global installation changed.

The initial lockfile-only resolution used the global Node 22 shim and emitted engine warnings; the subsequent frozen installation and production build/tests used Node 24. The initial build failed on the Portal OpenAPI import; the final build replaced that log and passed.

Raw evidence: [raw/orchestrator-restructure-local-2026-10-07](raw/orchestrator-restructure-local-2026-10-07/). Each check has `.log` and `.exit.txt`. Cwd and complete test command are recorded in the test logs. PowerShell logs can be UTF-16 and wrap stderr as NativeCommandError; recorded process exits and Jest summaries are authoritative.

| Check | Cwd relative to `du-rework` | Command | Result | Exit | Log stem |
| --- | --- | --- | --- | --- | --- |
| Frozen install | `.` | `node C:/nvm4w/nodejs/node_modules/corepack/dist/pnpm.js install --frozen-lockfile --ignore-scripts --offline` | All 16 workspace projects installed | 0 | `install` |
| Production build | `.` | `node scripts/build-all.cjs` | 12/12 built; Connector migration assets copied | 0 | `build` |
| Contracts | `orchestrator/packages/contracts` | `node node_modules/jest/bin/jest.js --runInBand` | 30 suites; 568 pass | 0 | `contracts-final` |
| Observability | `orchestrator/packages/observability` | same Jest command | 3 suites; 44 pass | 0 | `orchestrator-packages-observability` |
| Egress | `orchestrator/packages/egress` | same Jest command | 3 suites; 34 pass | 0 | `orchestrator-packages-egress` |
| Document kit | `orchestrator/packages/document-kit` | same Jest command | 10 suites; 130 pass | 0 | `orchestrator-packages-document-kit` |
| Connector client | `orchestrator/packages/connector-client` | same Jest command | 5 suites pass, 1 suite skipped; 39 pass, 1 skip | 0 | `orchestrator-packages-connector-client` |
| Connector | `orchestrator/services/connector` | `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --forceExit` | 34 suites; 439 pass, 1 skip | 0 | `orchestrator-services-connector` |
| Orchestrator focused | `orchestrator/services/orchestrator` | Jest with the 10 explicit test paths in `orchestrator-final.log` | 10 suites; 91 pass, 6 skip | 0 | `orchestrator-final` |
| Document core | `businesses/document-core` | `node node_modules/jest/bin/jest.js --runInBand`, `REDIS_SMOKE=0` | 63 suites; 985 pass, 1 skip | 0 | `document-core-final` |
| LC checker | `businesses/lc-checker` | `node node_modules/jest/bin/jest.js --runInBand` | 6 suites; 118 pass | 0 | `businesses-lc-checker` |
| Example review offline | `businesses/example-review` | `node node_modules/jest/bin/jest.js --runInBand --testPathIgnorePatterns=integration` | 11 suites pass, 2 fail; 121 pass, 2 fail | 1 | `example-review-final` |
| Worker SDK full exploration | `orchestrator/packages/worker-sdk` | `node node_modules/jest/bin/jest.js --runInBand` | 30 suites pass, 2 fail; 710 pass, 2 fail, 1 todo | 1 | `orchestrator-packages-worker-sdk` |
| Worker SDK final focused | same | Jest selecting worker, network-boundaries, crypto-seam, enc-read-roundtrip-proof | 3 suites pass, 1 fail; 45 pass, 1 fail | 1 | `worker-sdk-final-focused` |
| Isolation | `.` | `node orchestrator/scripts/verify-isolation.cjs` | 739 TS files, 0 forbidden relative imports, 52 explicitly allowed workspace references, 0 worker sibling refs | 0 | `isolation-final` |
| Dev preflight | `.` | `node scripts/dev.cjs --check` | Correct public/internal/Portal/Connector topology | 0 | `dev-check-final` |
| Compose configuration | `.` | `docker compose --env-file .env.docker config --quiet` | Valid, no configuration secrets printed | 0 | `compose-final` |

Repeated/focused runs are not additional unique tests. Skipped/todo tests are not passes. Orchestrator row is a focused sample, not its full test suite. Production build includes Portal TypeScript validation and Vite bundling.

## Remaining findings — do not claim all tests green

1. **Worker SDK crypto seam**: `orchestrator/packages/worker-sdk/tests/crypto-seam.test.ts:109` asserts exact source-body equality with the Orchestrator crypto facade. Current implementations differ in AAD/schema handling. Failure persists in final focused run; round-trip suite passes, but that does not resolve the fidelity finding. Requires encryption owner review; no cipher behavior or assertion relaxed here.
2. **Worker SDK memory gate**: `artifact-direct-band.test.ts` measured approximately 64,356,322 bytes against a 50,331,648-byte delta cap for the 64 MiB direct band. Full-suite failure retained; no threshold increased or test skipped to obtain green. Needs an isolated memory reproduction and artifact-stream owner analysis.
3. **Example-review logging static assertion**: `tests/example-review.test.ts:219` requires a nonempty set of `console` lines in `src/main.ts`, while the implementation uses `createLogger(...).error(...)`. Test must be updated to observe the real logger boundary without weakening secret-leak checks.
4. **Example-review parser logging assertion**: `tests/r1-e-office-safe-parser.test.ts:214` spies on `console.error` and expects `[REDACTED]`; structured logging emits the safe `DOCUMENT_PARSE_FAILED` code through its actual sink, so the spy sees no calls. Parser fail-closed assertions pass; log sink and sanitization expectations require alignment.

The initial broad example-review command included integration suites. Its local DB preflight found missing `0034_operation_execution_times.sql`, `0035_webhook_result_delivery.sql`, `0036_profile_callback_policy.sql`; other live route expectations failed. Those raw failures are preserved. No migration was applied to that DB, and the final example-review run explicitly excludes integration. No full-stack `pnpm dev`, production DB change, paid provider workload or Docker image rebuild performed.

## Handoff

Relocation repair and local production build are implemented and owner-tested. Keep SDK/example-review findings and live/browser gates open. Independently review changes and repeat required live checks on an isolated migrated database before acceptance/cutover. No commit or push.
