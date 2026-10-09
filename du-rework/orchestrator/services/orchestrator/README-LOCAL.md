# Orchestrator local process

This project owns the three Orchestrator listeners. From the `du-rework` root, run either:

```powershell
.orchestrator\services\orchestrator\scripts\start-local.ps1
```

```bash
bash orchestrator/services/orchestrator/scripts/start-local.sh
```

The script reads the root `.env.local` by default. Set `DU_ENV_FILE` to another file; relative paths are resolved from the workspace root. Create `.env.local` from `.env.local.sample` and fill in the database URL and required local secrets first. PostgreSQL must be reachable at `DATABASE_URL`; Redis is set to `redis://127.0.0.1:6379`.

By default the launcher builds Orchestrator and Admin Web, applies pending Orchestrator migrations, and then starts the process. Use `-SkipBuild -SkipMigrate` in PowerShell or `DU_SKIP_BUILD=1 DU_SKIP_MIGRATE=1` in Bash after the workspace is already built and migrated. `DU_CONNECTOR_BASE_URLS`, when configured, must remain a JSON map from real connector IDs to base URLs; the script does not guess connector IDs.

| Listener | Local address | Used by |
| --- | --- | --- |
| Public API | `http://127.0.0.1:3000` | API clients and business-facing requests |
| Admin Shell and BFF | `http://127.0.0.1:3001/admin/` | Admin Web, login, and same-origin `/admin/api/*` calls |
| Internal Runtime API | `http://127.0.0.1:3002` | Worker registration, heartbeat, and task runtime |

Workers use `RUNTIME_URL=http://127.0.0.1:3002/api/runtime/v1`, Redis uses port 6379, and Connector is expected at `http://127.0.0.1:8080`. The browser must use the Admin Shell/BFF; do not send platform bearer credentials from Admin Web to the public or internal listener. The companion Admin Web Vite launcher runs on 5173 and proxies only its BFF/auth paths to port 3001.

Start PostgreSQL and Redis before this process. Start the Connector before workers that invoke it. This launcher binds to loopback for local development.
