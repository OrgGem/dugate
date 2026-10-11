# Local development guide: independent services

This guide starts the `du-rework` services as separate host processes, each from its own subproject directory. It adds no product runtime configuration: service launchers delegate to the existing `scripts/dev.cjs` runner, which supplies the token mapping, readiness checks, service-specific environment, and Ctrl+C cleanup. All service launchers expect an isolated local profile and existing build outputs; they do not build or run Orchestrator migrations.

## Per-subproject entrypoints

Each project has a `README-LOCAL.md`, a PowerShell launcher, and a Bash launcher:

| Subproject | Local guide | PowerShell | Bash | Process |
| --- | --- | --- | --- | --- |
| Orchestrator | [`services/orchestrator/README-LOCAL.md`](../../orchestrator/services/orchestrator/README-LOCAL.md) | [`start-local.ps1`](../../orchestrator/services/orchestrator/start-local.ps1) | [`start-local.sh`](../../orchestrator/services/orchestrator/start-local.sh) | public API, Runtime/Admin API, integrated Portal/BFF |
| Connector | [`services/connector/README-LOCAL.md`](../../orchestrator/services/connector/README-LOCAL.md) | [`start-local.ps1`](../../orchestrator/services/connector/start-local.ps1) | [`start-local.sh`](../../orchestrator/services/connector/start-local.sh) | connector API |
| document-core | [`README-LOCAL.md`](../../businesses/document-core/README-LOCAL.md) | [`start-local.ps1`](../../businesses/document-core/start-local.ps1) | [`start-local.sh`](../../businesses/document-core/start-local.sh) | document worker |
| lc-checker | [`README-LOCAL.md`](../../businesses/lc-checker/README-LOCAL.md) | [`start-local.ps1`](../../businesses/lc-checker/start-local.ps1) | [`start-local.sh`](../../businesses/lc-checker/start-local.sh) | letter-of-credit worker |
| example-review | [`README-LOCAL.md`](../../businesses/example-review/README-LOCAL.md) | [`start-local.ps1`](../../businesses/example-review/start-local.ps1) | [`start-local.sh`](../../businesses/example-review/start-local.sh) | example worker |
| Admin Web | [`apps/admin-web/README-LOCAL.md`](../../orchestrator/apps/admin-web/README-LOCAL.md) | [`start-local.ps1`](../../orchestrator/apps/admin-web/start-local.ps1) | [`start-local.sh`](../../orchestrator/apps/admin-web/start-local.sh) | Vite dev server |

Run a subproject's launcher from that subproject directory. PowerShell scripts accept `-EnvFile` (backend/business services), and Bash scripts accept the env-file path as their first argument. Relative env-file paths resolve from the `du-rework/` root. Orchestrator and Connector use the same local profile. The business launchers select their business explicitly. Admin Web's Vite launcher takes `-BindHost` / `-Port` in PowerShell and `VITE_HOST` / `VITE_PORT` in Bash.

Example from `du-rework/` in PowerShell:

```powershell
Push-Location orchestrator/services/orchestrator
./start-local.ps1
Pop-Location

Push-Location orchestrator/services/connector
./start-local.ps1
Pop-Location

Push-Location businesses/document-core
./start-local.ps1
Pop-Location

Push-Location orchestrator/apps/admin-web
./start-local.ps1
Pop-Location
```

In Bash, use `cd` to the corresponding directory and run `bash ./start-local.sh`. Keep one terminal open per long-running service. Ctrl+C stops the service runner and its child processes.

## Ports and URLs

| Component | Default host port | Local URL / purpose |
| --- | ---: | --- |
| Orchestrator public API | 3000 | `http://127.0.0.1:3000` |
| Orchestrator internal Runtime/Admin API | 3002 | `http://127.0.0.1:3002`; workers use `/api/runtime/v1` |
| Integrated Admin Portal and BFF | 3001 | `http://127.0.0.1:3001/admin/` |
| Connector | 8080 | `http://127.0.0.1:8080`; launcher overrides shared runner's legacy 8088 default |
| Admin Web Vite | 5173 | `http://127.0.0.1:5173/admin/` |
| Local PostgreSQL Compose | 15433 | `127.0.0.1:15433/du_orchestrator_dev` |
| Local Redis Compose | 16380 | `redis://127.0.0.1:16380` |

Workers do not open public HTTP ports. They consume their own Redis-backed queues and call Orchestrator's internal Runtime API. `RUNTIME_URL` should be `http://127.0.0.1:3002/api/runtime/v1`, never the public API listener. Admin Web Vite has no `/admin/api/*` proxy; use the integrated Portal on port 3001 for session-authenticated BFF behavior.

## Configuration

Use a private generated profile at `du-rework/.env.orchestrator.local`. If it does not exist, create it from the workspace root:

```sh
node scripts/init-orchestrator-local.cjs --output=.env.orchestrator.local
```

The generator does not overwrite an existing profile and does not print its generated secret values. Review the generated local-only values before use. Do not use a shared or production database for this workflow.

| Variables | Used by | Notes |
| --- | --- | --- |
| `DATABASE_URL`, `REDIS_URL` | Orchestrator, Connector, runner, workers | Point to the isolated local databases. The local Compose file publishes Postgres on 15433 and Redis on 16380. |
| `ORCHESTRATOR_PORT`, `ORCHESTRATOR_HOST` | Orchestrator | Defaults to `3000`, loopback. |
| `ORCHESTRATOR_INTERNAL_PORT`, `ORCHESTRATOR_INTERNAL_HOST`, `ORCHESTRATOR_INTERNAL_BASE_URL` | Runtime/Admin listener and runner | Defaults to port `3002`; keep the base URL on the internal listener. |
| `ADMIN_SHELL_PORT`, `ADMIN_SHELL_HOST`, `DU_ADMIN_WEB`, `DU_ADMIN_WEB_DIST` | Integrated Portal | Defaults to port `3001`, loopback, enabled, and `apps/admin-web/dist`. |
| `RUNTIME_TOKEN`, `ADMIN_TOKEN`, `ADMIN_SHELL_COOKIE_SECRET`, `ENCRYPTION_KEY` | Orchestrator | Platform/runtime and admin-session secrets; use generated local values. |
| `DOCUMENT_CORE_RUNTIME_TOKEN`, `LC_RUNTIME_TOKEN`, `EXAMPLE_REVIEW_RUNTIME_TOKEN` or `WORKER_IDENTITY_TOKENS_BY_BUSINESS` | Worker runner | Separate identity per business; the runner maps the selected one to worker `RUNTIME_TOKEN`. Worker tokens must be unique and separate from platform tokens. |
| `RUNTIME_URL` | Workers | Defaults to internal Runtime `http://127.0.0.1:3002/api/runtime/v1`. |
| `SERVICE_IDENTITY_SECRET` | Orchestrator, Connector, local identity signing | Base64-encoded 32-byte service identity key. |
| `INVOCATION_GRANT_SECRET` | Orchestrator/Connector | Orchestrator-side raw 32-byte ASCII grant key. The runner derives Connector's Base64 representation. If explicitly supplied, `CONNECTOR_INVOCATION_GRANT_SECRET` must encode the same bytes. |
| `CONNECTOR_ENCRYPTION_KEY`, `CONNECTOR_INVOCATION_ENCRYPTION_KEYS` | Connector and runtime configuration validation | Base64 32-byte encryption key and JSON active key ring. Keep local values distinct from any shared environment. |
| `CONNECTOR_PORT`, `CONNECTOR_URL`, `CONNECTOR_REDIS_PREFIX` | Connector and workers | Launchers default to port/URL 8080; `CONNECTOR_URL` is passed to workers. The generated profile currently uses 8088, so the launcher deliberately overrides it unless you pass a custom port/URL. |
| `CONNECTOR_SERVICE_TOKEN` | Connector-calling workers | The worker launchers use the runner's `--local-identity` option to mint a short-lived local token in memory. Omit that option only when using an issuer-provided local identity via the shared runner directly. |
| `AUTO_MIGRATE` | Orchestrator | Default profile uses `false`; migrations are a separate explicit step. |
| `ARTIFACT_STORAGE_BACKEND`, `DU_DATA_MODE`, `DU_SYNTHETIC_DATA_ACK` | Orchestrator/workers | Generated non-workflow profile is for isolated synthetic local data. Workflow/Vault settings require separate local setup and are outside these start scripts. |

The full environment validation and token transformation live in `scripts/runtime-env.cjs`; the root runner's Connector default is port 8088 for compatibility. These per-service launchers set `CONNECTOR_PORT=8080` and `CONNECTOR_URL=http://127.0.0.1:8080` unless a process environment override or launcher parameter is supplied.

## Dependency start order

The requested shorthand “infra → migrate → provision → services” needs one adjustment: the repository's `scripts/provision-local.cjs` registers manifests and provisions tenant/application state by calling the Orchestrator internal API, so that data-provisioning step cannot happen before Orchestrator is running. Split initial credential generation from application provisioning as follows:

1. **Generate local configuration.** From `du-rework/`, run `node scripts/init-orchestrator-local.cjs --output=.env.orchestrator.local` if needed. This creates credentials and connection URLs but does not provision tenant/business state.
2. **Start infrastructure.** From `du-rework/`, run:

   ```sh
   docker compose --env-file .env.orchestrator.local -f infra/docker-compose.orchestrator-local.yml up -d postgres redis
   ```

   Wait for both containers to report healthy. This Compose project binds only local ports 15433 and 16380.
3. **Install and build.** Use Node `>=24.21.0 <25` and pnpm `10.18.3`; from `du-rework/`, run `corepack pnpm install --frozen-lockfile` as needed and `pnpm build` (or `node scripts/build-all.cjs`). The service launchers use `--skip-build` and require the generated `dist` files.
4. **Migrate Orchestrator.** From `du-rework/`, run `node scripts/migrate-local.cjs --env-file=.env.orchestrator.local`. This writes the configured local Orchestrator database. Verify the env file points only to the isolated development database before running it. Connector initializes/checks its own schema on Connector startup; the shared runner's `--skip-migrate` only skips the Orchestrator migration command.
5. **Start Orchestrator.** In its own terminal, run `orchestrator/services/orchestrator/start-local.ps1` from PowerShell after changing into that directory, or `bash start-local.sh` from that directory. It serves public 3000, internal 3002, and Portal/BFF 3001 by default.
6. **Start Connector.** In a second terminal, run the Connector subproject's launcher. It binds 8080 by default and checks Orchestrator internal health before returning. Confirm Connector readiness at `http://127.0.0.1:8080/health/ready` before starting workers.
7. **Provision business and tenant state.** After Orchestrator is healthy, return to `du-rework/` and run `node --env-file=.env.orchestrator.local scripts/provision-local.cjs`. This script writes to the configured database and calls the internal Orchestrator API to register/enable/activate the bundled business manifests and create local tenant/profile/API-key state. Use only the isolated generated local database. Its output can include local development credentials; keep it out of shared logs. It is not called by any service launcher.
8. **Start workers.** In separate terminals, run any of `businesses/document-core/start-local.ps1`, `businesses/lc-checker/start-local.ps1`, and `businesses/example-review/start-local.ps1` from their own directories (or the matching Bash launchers). The shared runner waits for both Orchestrator and Connector before starting workers. Each selected worker needs its own runtime token.
9. **Start Admin Web Vite (optional).** Run `orchestrator/apps/admin-web/start-local.ps1` or `.sh` from its own directory. Vite serves the UI on 5173. For a real authenticated session and BFF requests, use the integrated Orchestrator portal on 3001 instead.

The database-changing steps are steps 4 and 7; they are explicit rather than hidden inside service launchers. No service or database action is performed by this guide itself.

## Stop and troubleshooting

- Press Ctrl+C in each service terminal. Each shared-runner process stops only the children it started; Vite stops its own process.
- `Missing build artifact` means rerun `pnpm build` from the workspace root.
- A readiness error means verify Orchestrator health at `http://127.0.0.1:3002/health`, Connector readiness at `http://127.0.0.1:8080/health/ready`, then check local ports and the terminal output.
- `Missing worker identity` means set the matching business runtime token or `WORKER_IDENTITY_TOKENS_BY_BUSINESS` in the env profile; do not reuse `RUNTIME_TOKEN` or `ADMIN_TOKEN` as a worker token.
- A Connector key/grant validation error means regenerate a local profile or align Connector grant material with `INVOCATION_GRANT_SECRET`; never substitute production secrets.
- If Connector is intentionally assigned another port, keep its launcher and all business `CONNECTOR_URL` values consistent.

## Source of startup behavior

The launchers are thin wrappers around `scripts/dev.cjs` and `scripts/runtime-env.cjs`. Environment and process requirements are implemented in `orchestrator/services/orchestrator/src/main.ts`, `orchestrator/services/connector/src/entrypoint.ts`, `businesses/document-core/src/config.ts`, `businesses/lc-checker/src/config.ts`, and `businesses/example-review/src/config.ts`. The standalone UI command comes from `orchestrator/apps/admin-web/package.json`; `vite.config.ts` sets the `/admin/` base, and the Admin API client uses same-origin `/admin/api/*`.
