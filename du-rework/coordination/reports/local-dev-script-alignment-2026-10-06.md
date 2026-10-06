# LOCAL-DEV-ALIGN-20261006 ? owner implementation receipt

Date: 2026-10-06. Workspace: D:/Git/dugate/du-rework. No commit, push, remote deployment or cutover. Existing private env files unchanged.

## Findings and changes

- Old runner directed Runtime traffic to Public 3000, omitted Internal 3002 and the Portal build, and only launched document-core. Updated sample and defaults: Public 3000, authenticated Internal 3002, Portal/BFF 3001, local Connector 8088 (container remains 8080); default binds are loopback.
- `build-all.cjs` builds 12 canonical package directories in dependency order, including Portal, lc-checker and example-review. Exact-directory builds exclude migration-candidate duplicate packages.
- Runner uses Node >=24.21.0 <25 and loads env with native parsing and shell-over-file precedence. Custom paths support spaces and equals. Existing legacy Runtime URLs pointing to Public ingress are rejected with a corrective diagnostic. No secrets printed on invalid URL errors.
- `--workers=all|none|comma-separated`, `--check`, `--skip-build`, `--skip-migrate`, existing compiled-output `--watch`. Normal starts rebuild to avoid stale dist. Watch does not compile TS or provide HMR.
- Migration failures abort; readiness requires HTTP 200 on Internal /health and Connector /health/ready before any worker starts. Connector retains its existing boot migration behavior. Required artifacts are checked even when build skipped.
- Occupied ports abort without killing their owner. Shutdown targets only runner children; Windows uses process-tree termination and POSIX process groups with bounded graceful drain. Unexpected service exit stops the session with nonzero status.
- `pnpm stop` selects absolute entrypoints in this workspace instead of port owners; includes all three workers. Legacy manually launched relative entrypoints require their original terminal. start-all PowerShell/Bash/CMD now delegate to one runner; PowerShell wrappers propagate exit status. Individual service scripts retain manual mode, corrected startup guidance and build-failure exit handling.
- Migration helper uses process.execPath and preserves equals in env-file paths. README documents host versus Compose ingress and actual user bootstrap requirement instead of an assumed default password.

## Verification

Node v24.21.0. Commands executed from D:/Git/dugate unless stated:

1. `node du-rework/scripts/build-all.cjs`: **12/12 package builds passed, exit 0**, 48.5s. Raw `local-dev-build-2026-10-06.log`, exit file `local-dev-build-2026-10-06.exit.txt`.
2. `node du-rework/coordination/reports/local-dev-runner-check-2026-10-06.cjs`: **10 checks passed, exit 0**. Temp env file with space and equals; execution from unrelated cwd; default/subset/no-worker selection; unknown args; legacy Runtime rejection; duplicate ports; secret-safe invalid URL; occupied port retains its live owner. Raw `local-dev-runner-check-2026-10-06.log`. No database or actual DU service started.
3. Node syntax checks for dev/build/migrate/stop runners, PowerShell wrapper parsing, scoped git diff whitespace checks: exit 0 (see final validation log).

Status: IMPLEMENTED with owner validation. Independent full-stack verification and reviewer acceptance remain OPEN. No live database migrations were applied. Existing `.env.local` may require changing RUNTIME_URL to http://127.0.0.1:3002/api/runtime/v1 and CONNECTOR_URL to http://127.0.0.1:8088, or equivalent custom-port addresses. `pnpm dev --check` verifies this without database writes.
