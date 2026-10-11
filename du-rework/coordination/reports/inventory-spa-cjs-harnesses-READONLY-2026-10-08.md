# Independent inventory: orchestrator SPA offline `.cjs` harnesses

Date: 2026-10-08  
Scope: `du-rework` only. Read-only inventory and direct Node runs; no PostgreSQL/Redis started and no DB window claimed.

## Inventory method and Jest collection

From `D:/Git/dugate/du-rework/orchestrator`:

```text
Command: rg --files -g '*.cjs' -g '!node_modules/**' | Sort-Object
Exit code: 0
```

From `D:/Git/dugate/du-rework/orchestrator/services/orchestrator`:

```text
Command: rg --files tests -g '*.cjs' | Sort-Object
Exit code: 0
```

Exhaustive cross-checks included hidden and ignored files; they returned the same seven target tests and 21 orchestrator-monorepo `.cjs` files:

```text
Command: rg --files --hidden --no-ignore tests -g '*.cjs' -g '!**/node_modules/**'
cwd: D:/Git/dugate/du-rework/orchestrator/services/orchestrator
Exit code: 0

Command: rg --files --hidden --no-ignore -g '*.cjs' -g '!**/node_modules/**'
cwd: D:/Git/dugate/du-rework/orchestrator
Exit code: 0
```

The target directory contains exactly these seven `.cjs` files. Jest was not used for them: as supplied in the task context, the orchestrator Jest `testMatch` is `**/*.test.ts`, and the unit config inherits that match. Every harness below was run directly with Node.

## Every target test harness: purpose, shim, command, result

“Shared SPA shim” means a common imported helper/module. None of these seven imports such a shared shim. Five transpile TSX with TypeScript and execute it in a VM using a local, hand-rolled React hook/element shim; two are static source checks and need no React shim.

| File | Purpose (one sentence) | Transpile / shim | Exact command, cwd `D:/Git/dugate/du-rework/orchestrator/services/orchestrator` | Exit | Literal result line |
|---|---|---|---:|---:|---|
| `tests/admin-toast-error-boundary-offline.cjs` | Checks toast exports, error-boundary fallback/wiring, and preservation of the shell health strip and routed outlet. | No; static source assertions, no shared shim. | `node tests/admin-toast-error-boundary-offline.cjs` | 0 | `PASS admin toast/error boundary offline harness (14 assertions)` |
| `tests/api-docs-build-label-offline.cjs` | Checks the API Reference screen’s spec build label, fingerprint/status states, and empty-filter copy against the OpenAPI artifact. | No; static TSX/JSON source checks, no shared shim. | `node tests/api-docs-build-label-offline.cjs` | 0 | `RESULT: PASS (24 passed, 0 failed, 24 total)` |
| `tests/f7-overview-usage-tile-offline.cjs` | Exercises the real Overview usage tile for tenant scoping, totals, and honest denied, unreadable, empty, or unavailable states. | Yes; TypeScript transpile plus a local VM React hook/tree shim, not a shared imported shim. | `node tests/f7-overview-usage-tile-offline.cjs` | 0 | `PASS: real OverviewScreen usage tile — 8 scenarios (real totals, tenant from session, platform/unscoped/failed fail-closed, unreadable payload, empty window, Operations tile intact)` |
| `tests/operations-download-live-offline.cjs` | Exercises the Operations screen’s elapsed-time updates and artifact download/unavailable links. | Yes; TypeScript transpile plus a local VM React shim, not shared. “live” is part of the filename; this run used the offline harness. | `node tests/operations-download-live-offline.cjs` | 0 | `PASS operations-download-live-offline.cjs - 6 assertions (OPU-OPS-1 x2, OPU-OPS-2 x4)` |
| `tests/portal-auto-refresh-offline.cjs` | Exercises Overview and Usage opt-in polling, data-age state, stale retention, and timer cleanup. | Yes; TypeScript transpile plus local VM React hook shims, not a shared imported shim. | `node tests/portal-auto-refresh-offline.cjs` | 0 | `PASS: OPU-G2 auto refresh + data age — 9 scenarios (opt-in only, age from last success, stale-on-failure retention, cleanup on toggle-off/unmount)` |
| `tests/tenant-select-offline.cjs` | Exercises the real TenantSelect component’s roster labels, unknown-value fence, and loading/failed/empty/paged states. | Yes; TypeScript transpile plus a local VM React hook/element shim, not shared. | `node tests/tenant-select-offline.cjs` | 0 | `PASS: real TenantSelect element tree — 8 scenarios (names-not-ids, state suffix, unknown value, loading/failed/empty/cycle/multi-page)` |
| `tests/usage-screen-offline.cjs` | Exercises Usage screen platform/tenant gating, selected-tenant forwarding, and tenant-session prefill/lock. | Yes; TypeScript transpile plus a local VM hook/API shim, not shared. | `node tests/usage-screen-offline.cjs` | 0 | `PASS: platform gating, TenantSelect selection, All tenants guard, forwarding, tenant session prefill and lock` |

No harness run failed. In particular, no `.cjs` file was passed to Jest, so there was no misleading `No tests found` result.

## Shim inventory

The TypeScript/VM harnesses are self-contained rather than importing one common transpile-shim module. `usage-screen-offline.cjs`, `tenant-select-offline.cjs`, `f7-overview-usage-tile-offline.cjs`, `operations-download-live-offline.cjs`, and `portal-auto-refresh-offline.cjs` each call `typescript.transpileModule()` and create their own VM sandbox/shim. `admin-toast-error-boundary-offline.cjs` and `api-docs-build-label-offline.cjs` read source text and assert contracts directly.

## Other `.cjs` files in the orchestrator monorepo

The following are outside `orchestrator/services/orchestrator/tests/`; they are not members of the seven-harness SPA inventory and were not run as part of this task:

| File(s) | Classification |
|---|---|
| `orchestrator/packages/connector-client/jest.config.cjs`; `orchestrator/packages/contracts/jest.config.cjs`; `orchestrator/packages/document-kit/jest.config.cjs`; `orchestrator/packages/egress/jest.config.cjs`; `orchestrator/packages/observability/jest.config.cjs`; `orchestrator/packages/worker-sdk/jest.config.cjs` | Jest configuration, not SPA harnesses. |
| `orchestrator/services/connector/jest.config.cjs`; `orchestrator/services/connector/jest.unit.config.cjs`; `orchestrator/services/orchestrator/jest.config.cjs`; `orchestrator/services/orchestrator/jest.unit.config.cjs` | Jest configuration, not SPA harnesses. |
| `orchestrator/packages/observability/tests/setup-node-env.cjs` | Jest setup hook in another package’s tests directory, not an SPA harness. |
| `orchestrator/scripts/verify-isolation.cjs` | Repository isolation utility, not an SPA screen harness. |
| `orchestrator/services/orchestrator/opt-perf-01b-ingress-concat-bench.cjs`; `orchestrator/services/orchestrator/opt-perf-02-crypto-chunk-bench.cjs` | Performance benchmark scripts, not SPA screen harnesses. |

Thus the orchestrator monorepo inventory contains 21 `.cjs` files: seven target SPA/offline test harnesses and fourteen outside that target directory.

## Repo-wide caller search

Searches were run from `D:/Git/dugate/du-rework`, excluding `node_modules` and `coordination/reports`:

```text
Command: rg --hidden -n -i "admin-toast-error-boundary-offline\.cjs|api-docs-build-label-offline\.cjs|f7-overview-usage-tile-offline\.cjs|operations-download-live-offline\.cjs|portal-auto-refresh-offline\.cjs|tenant-select-offline\.cjs|usage-screen-offline\.cjs" -g '!**/node_modules/**' -g '!**/coordination/reports/**' -g '!coordination/reports/**' .
Exit code: 0
```

The matches were cross-references in harness comments, one existing `.test.ts` comment, and the dispatch spec; no runnable metadata callsite was found. A narrower search over `package.json`, config, and wrapper-script files for those seven basenames returned no matches (ripgrep exit `1`, meaning no matches):

```text
Command: rg --hidden -n -i "admin-toast-error-boundary-offline\.cjs|api-docs-build-label-offline\.cjs|f7-overview-usage-tile-offline\.cjs|operations-download-live-offline\.cjs|portal-auto-refresh-offline\.cjs|tenant-select-offline\.cjs|usage-screen-offline\.cjs" -g 'package.json' -g '*.config.*' -g '*.ps1' -g '*.sh' -g '*.bat' -g '*.cmd' -g 'Makefile' -g '!**/node_modules/**' -g '!**/coordination/reports/**' -g '!coordination/reports/**' .
Exit code: 1 (no matches)
```

Other `.cjs` references found in package/config/wrapper metadata are unrelated runners, configs, or operational scripts:

```text
Command: rg --hidden -n -i "\.cjs" -g 'package.json' -g '*.config.*' -g '*.yml' -g '*.yaml' -g '*.ps1' -g '*.sh' -g '*.cmd' -g '*.bat' -g 'Makefile' -g '!**/node_modules/**' -g '!**/coordination/reports/**' -g '!coordination/reports/**' .
Exit code: 0
```

- Root `package.json`: `dev` → `scripts/dev.cjs`; `stop` → `scripts/stop-all.cjs`; `build:all` → `scripts/build-all.cjs`; `migrate:local` → `scripts/migrate-local.cjs`.
- `businesses/document-core/package.json`: `build:deps` and `test:integration:full` invoke `scripts/build-dependencies.cjs`.
- `orchestrator/services/orchestrator/package.json`, `orchestrator/services/connector/package.json`, and `tests/integration/package.json`: test scripts invoke Jest with `.cjs` configuration files, not the target harnesses.
- `orchestrator/services/orchestrator/jest.unit.config.cjs` and `orchestrator/services/connector/jest.unit.config.cjs` require their base `jest.config.cjs`; `orchestrator/packages/observability/jest.config.cjs` registers `tests/setup-node-env.cjs` as a Jest setup file.
- `tools/live-gates/run-live-gates.ps1` invokes `check-migrations.cjs`, `webhook-live-idp.cjs`, and `scan-plaintext-sentinels.cjs`.
- Script wrappers invoke `scripts/dev.cjs`, `scripts/stop-all.cjs`, `scripts/build-all.cjs`, or `scripts/docker/benchmark.cjs`; these are service/build/benchmark runners, not SPA tests.
- `coordination/scripts/*.ps1` refer to Jest config commands; `infra/docker-compose.orchestrator-local.yml` mentions `scripts/init-orchestrator-local.cjs` in its setup error text.

No `.github/workflows` directory exists in `du-rework` (checked with `Test-Path .github/workflows`; exit `0`, output `NO .github/workflows directory`). No script, package entry point, or workflow automatically invokes any of the seven SPA `.cjs` harnesses found here. They currently require direct `node tests/<file>.cjs` execution.

Two exploratory grep attempts needed PowerShell-compatible quoting/globs. These were search-command errors, not harness results; corrected searches completed above:

- `rg -n -i "shim|transpil|transform|require\.extensions|tsx|esbuild|typescript|spawnSync|execSync|pg|redis|dotenv|\.env\.live|https?://" tests/*.cjs` from the orchestrator service directory exited `1` with `rg: tests/*.cjs: IO error for operation on tests/*.cjs: The filename, directory name, or volume label syntax is incorrect. (os error 123)`. The corrected form used `tests -g '*.cjs'` and exited `0`.
- The first shim-location query had a nested-quote PowerShell parser error and exited `1` (`The string is missing the terminator: "`). The corrected `rg -n "transpileModule|vm\.runInNewContext|React hook shim|hook shim" tests -g '*.cjs'` query exited `0`.

## FAILs

No harness failures. All seven direct Node runs exited `0`; the metadata search for callers exited `1` because it found no direct caller references, not because a harness failed. The two corrected exploratory grep errors above did not affect the inventory. No source, test, package, config, workflow, or OpenAPI file was modified. No commit, staging, push, or gate change was performed.
