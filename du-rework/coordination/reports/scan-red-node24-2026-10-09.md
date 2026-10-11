# Node 24 full unit regression scan

Read-only scan of the current `du-rework` tree. Working directory for the test and config/status commands: `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`.

## Full unit run

Node executable: `$env:TEMP/du-node24-security-c025dd92/node-v24.21.0-win-x64/node.exe`  
Resolved path: `C:\Users\Gem\AppData\Local\Temp\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe`  
`node -v`: `v24.21.0` (exit 0)

Command:

```text
& $node24 node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs
```

`REAL_EXIT=1` (captured immediately from `$LASTEXITCODE`). Literal Jest summary:

```text
Test Suites: 1 failed, 14 skipped, 234 passed, 235 of 249 total
Tests:       5 failed, 118 skipped, 5133 passed, 5256 total
```

The complete raw output is [10-full-unit.log](raw/scan-red-node24-2026-10-09/10-full-unit.log); command and runtime metadata are in [00-run-metadata.txt](raw/scan-red-node24-2026-10-09/00-run-metadata.txt).

There was one RED suite: `tests/artifact-read-authorization.test.ts` — five failing tests. Jest did not print a per-suite `Tests:` summary, so the literal total above is the run-level line; all five failures are shown below from the raw failure details.

| Failing test | Expected | Received |
|---|---|---|
| `R1-A artifact read authorization and storage-facade boundary › does not grant reads for STAGING artifacts, even in the same operation` (`:375`) | `{ code: "STATE_CONFLICT" }` | `{ code: "PERMISSION_DENIED" }` |
| `R1-A artifact read authorization and storage-facade boundary › rejects expired and fenced requesters before minting a read grant` (`:386`) | `{ status: 403, code: "PERMISSION_DENIED" }` | `{ status: 409, code: "LEASE_LOST" }` |
| `CR28-03 artifact read authorization: negatives and boundaries › declared references array › reports a state conflict, not a permission denial, for a declared cross-operation STAGING artifact` (`:597`) | `{ code: "STATE_CONFLICT" }` | `{ code: "PERMISSION_DENIED" }` |
| `CR28-03 worker lease boundaries › prefers expiry over task state when both are wrong` (`:732`) | `{ status: 403, code: "PERMISSION_DENIED" }` | `{ status: 409, code: "LEASE_LOST" }` |
| `CR28-03 worker lease boundaries › FINDING: the lease_active boolean collapses a missing expiry and a past one` (`:742`) | `{ status: 403, code: "PERMISSION_DENIED" }` | `{ status: 409, code: "LEASE_LOST" }` |

The run reports 234 GREEN suites, 1 RED suite, and 14 skipped suites. There are too many GREEN suites to enumerate usefully here; the full-run count is recorded above, as allowed by the scan instructions. The run also reports 118 skipped tests. No RED test was ignored or retried.

## Offline live-gates

`jest.unit.config.cjs:2-4` says the offline unit config excludes suites that boot the real app against PostgreSQL/Redis. The `liveSuites` patterns at lines 8-23 exclude these suites from this run; they are not GREEN and are not included as passed:

- `admin-action-rbac-live.test.ts`
- `admin-audit.test.ts`
- `admin-base-routes.test.ts`
- `admin-error-boundary.test.ts`
- `admin-shell-live-pane.test.ts`
- `artifact-grant-fencing.test.ts`
- `artifacts-fencing-pg.test.ts`
- `blob-wire-binary.test.ts`
- `ingress-bounded.test.ts`
- `migrations.test.ts`
- `operation-tenant-fence.test.ts`
- `runtime.test.ts`
- `usage-summary.test.ts`
- `webhook-reclaim-fence.live.test.ts`
- `workspace-reference.test.ts`

The exact requested `jest.unit.config.cjs` lines 1-25 are captured in [20-unit-config-lines-1-25.txt](raw/scan-red-node24-2026-10-09/20-unit-config-lines-1-25.txt). No PostgreSQL or Redis was started and no DB window is claimed.

## Dirty-file observation

Command run from the service directory: `git status --porcelain | Select-String 'orchestrator'`. The complete output is [30-status-orchestrator.txt](raw/scan-red-node24-2026-10-09/30-status-orchestrator.txt). It shows these modified or untracked paths:

```text
M  du-rework/orchestrator/apps/admin-web/src/app-shell/app-shell.tsx
M  du-rework/orchestrator/apps/admin-web/src/features/api-docs/api-docs-screen.tsx
M  du-rework/orchestrator/apps/admin-web/src/features/operations/operations-screen.tsx
M  du-rework/orchestrator/apps/admin-web/src/features/overview/overview-screen.tsx
M  du-rework/orchestrator/apps/admin-web/src/features/usage/usage-screen.tsx
M  du-rework/orchestrator/apps/admin-web/src/lib/api/client.ts
M  du-rework/orchestrator/packages/observability/jest.config.cjs
M  du-rework/orchestrator/packages/observability/src/log-metadata.ts
M  du-rework/orchestrator/services/orchestrator/jest.config.cjs
M  du-rework/orchestrator/services/orchestrator/src/app/admin/bff/handle.ts
M  du-rework/orchestrator/services/orchestrator/src/compat/legacy-host-adapter.ts
M  du-rework/orchestrator/services/orchestrator/src/db/migrations.ts
M  du-rework/orchestrator/services/orchestrator/src/modules/runtime/runtime.ts
M  du-rework/orchestrator/services/orchestrator/tests/artifact-read-authorization.test.ts
M  du-rework/orchestrator/services/orchestrator/tests/enc-meta-sentinel-runtime-refs.test.ts
M  du-rework/orchestrator/services/orchestrator/tests/public-upload-encryption-gateway.test.ts
M  du-rework/orchestrator/services/orchestrator/tests/rv01-loopback-http-offline.test.ts
?? du-rework/orchestrator/apps/admin-web/src/components/ui/toast.tsx
?? du-rework/orchestrator/packages/observability/tests/setup-node-env.cjs
?? du-rework/orchestrator/services/orchestrator/src/app/admin/bff/health.ts
?? du-rework/orchestrator/services/orchestrator/tests/admin-bff-health-offline.test.ts
?? du-rework/orchestrator/services/orchestrator/tests/admin-toast-error-boundary-offline.cjs
?? du-rework/orchestrator/services/orchestrator/tests/api-docs-build-label-offline.cjs
?? du-rework/orchestrator/services/orchestrator/tests/f3-tenant-list-live-db.test.ts
?? du-rework/orchestrator/services/orchestrator/tests/f4-component-tenant-select.test.ts
?? du-rework/orchestrator/services/orchestrator/tests/fix-section8-legacy-cursor-offline.test.ts
?? du-rework/orchestrator/services/orchestrator/tests/med1-migration-ledger-object-drift.test.ts
?? du-rework/orchestrator/services/orchestrator/tests/med1-verify-migrations-object-drift.test.ts
?? du-rework/orchestrator/services/orchestrator/tests/operations-download-live-offline.cjs
?? du-rework/orchestrator/services/orchestrator/tests/operations-timeline-filters-offline.cjs
?? du-rework/orchestrator/services/orchestrator/tests/portal-auto-refresh-offline.cjs
?? du-rework/orchestrator/services/orchestrator/tests/setup-node-env.cjs
```

All 32 `orchestrator` status entries matched the prior status snapshot at the start of the preceding task: 32 before, 32 after, zero path differences. That comparison is in [31-status-vs-prior-snapshot.txt](raw/scan-red-node24-2026-10-09/31-status-vs-prior-snapshot.txt). This scan introduced no source/test/config changes and revealed no newly changed path without a receipt. The status list itself cannot establish authorship; related existing receipts remain with their respective lanes.

No files were changed to make tests green. No gate was ticked. No `git add`, commit, or push was performed.
