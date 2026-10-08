# Local development ? Orchestrator, Portal, Connector and workers

Run from `du-rework` with Node **>=24.21.0 <25** and pnpm **10.18.3**. Install dependencies with `pnpm install --frozen-lockfile`. PostgreSQL and Redis must already be running; configure their actual URLs, tokens and identity secrets in a private `.env.local` copied from `.env.local.sample`. The runner does not seed users or create infrastructure. Use the existing local-user bootstrap procedure; no default admin password is promised.

```powershell
pnpm dev --help
pnpm dev --check
pnpm dev
pnpm dev --workers=document-core
pnpm dev --workers=none
pnpm dev --env-file=.env.local --skip-build --skip-migrate
```

`--check` validates Node, configuration and topology without builds, database writes or starting services. Fix an old `RUNTIME_URL` pointing to port 3000 before launch. Existing shell environment overrides the env file, matching Node env-file behavior. Custom env paths resolve relative to `du-rework`, including paths containing spaces or `=`.

| Component | Host-process local address | Purpose |
| --- | --- | --- |
| Orchestrator Public | `http://127.0.0.1:3000` | Public business API |
| Orchestrator Internal | `http://127.0.0.1:3002` | Authenticated admin/runtime API |
| Orchestrator Portal + BFF | `http://127.0.0.1:3001/admin/web/` | React Portal; login at `/admin/login` |
| Connector | `http://127.0.0.1:8088` | Signed internal service; root-path contract |
| Workers | No public HTTP listener | document-core, lc-checker, example-review via Runtime and Redis |

The runner defaults to all three workers; `--workers=` selects a comma-separated subset. Ports remain configurable. Local defaults bind loopback; explicitly configured bind hosts remain operator-controlled. Connector local port 8088 differs from its container port 8080. Docker retains the Compose boundary: internal 3002 and Connector 8080 are not published by default; use `compose/local-debug.yml` for optional loopback debugging.

Each normal launch builds all canonical packages in dependency order, including Portal and three workers, from their exact directories (excluding migration-candidate duplicates). It applies Orchestrator migrations to the configured database, aborting on failure; Connector initializes its own schema during startup. Both backend and Connector readiness must pass before workers start. `--skip-migrate` is for a database already migrated; backend schema verification still applies. `--skip-build` uses existing outputs and checks required artifacts.

Ctrl+C stops this runner's children. Occupied ports cause a clear startup failure, without killing other listeners. `pnpm stop` targets absolute Node entrypoints in this workspace, including all three workers; older manually launched relative entrypoints must be stopped from their original terminal.

PowerShell/CMD/Bash `start-all` wrappers use this same runner. `dev-live.ps1` and `dev-live.sh` select `.env.live`: a normal launch migrates that configured database too; use `--check` to inspect without writes. No live environment is started by this documentation update.

`--watch` watches compiled JavaScript; it does not compile TypeScript or provide Vite HMR. Rebuild source changes before using them. The Portal is built and served through the real BFF, preserving its session/CSRF behavior.

## Workflow runtime configuration

Generate a new private workflow profile with distinct platform/worker tokens, matching
grant keys, invocation encryption keys and the full encryption flags:

```powershell
node scripts/init-orchestrator-local.cjs --output=.env.workflow.local --workflow --vault-env=.env.live
node scripts/dev.cjs --env-file=.env.workflow.local --workers=all --workflow --local-identity --check
node scripts/dev.cjs --env-file=.env.workflow.local --workers=all --workflow --local-identity
```

`--vault-env` imports only Vault configuration/identities and the management URL map;
the destination uses its own local database/password. Start the dedicated local
PostgreSQL/Redis stack with that destination env file before running dev. On an existing
DB volume, retain its original password and URL. Omitting `--vault-env` creates blank
Vault fields to fill from provisioned Transit keys and two distinct enc/dec identities.
The generator never overwrites a profile. The default profile without `--workflow`
is explicitly synthetic and suitable for startup; workflow admission still requires encryption.

`--workflow --check` validates the encryption configuration as well as token/key contracts;
it does not contact Vault/providers, migrate or seed a database. `--local-identity` signs
a fresh 24-hour local Connector identity in memory using the configured service key.
Use issuer-provisioned `CONNECTOR_SERVICE_TOKEN` and omit that flag outside local development.

The runner passes each worker its own mapped token and concurrency. Connector receives
Base64 of the Orchestrator's raw ASCII 32-byte grant key; a conflicting explicit
`CONNECTOR_INVOCATION_GRANT_SECRET` is rejected. Legacy Base64-only grant profiles need
a coordinated key replacement for both services. Workers do not receive Vault identities.

Single-service PowerShell wrappers also use the runner: `start-orchestrator.ps1`,
`start-connector.ps1`, `start-worker.ps1`. Equivalent options are
`--services=orchestrator`, `--services=connector` or `--services=workers --workers=document-core`.

Docker workflow profile:

```powershell
node scripts/docker/init-env.cjs .env.workflow.docker --workflow
# Fill Vault Transit options/tokens and optional Connector management configuration.
node scripts/docker/check-env.cjs .env.workflow.docker --workflow
docker compose --env-file .env.workflow.docker config --quiet
docker compose --env-file .env.workflow.docker up -d --build
```

Vault is external to the product Compose stack. Its address must be reachable from
containers (a host-loopback address is not a container-reachable Vault address).
For LOCAL generated profiles, refresh an expired identity without rotating stored keys:
`node scripts/docker/init-env.cjs .env.workflow.docker --refresh-identity`, then recreate
the workers. For production, use the deployment's identity issuer.

After services start, register manifests using the platform Runtime token, enable/activate
the new versions, provision tenant/API key/profile/connector bindings and import/publish
tenant schemas. Neither runner performs those administrative mutations. Migrations include
the workflow schema catalog. Workflow API availability does not enable the disabled
Workflow administration screen.
