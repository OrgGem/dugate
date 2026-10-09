# Connector local process

From the `du-rework` root, run either `.orchestrator\services\connector\scripts\start-local.ps1` or `bash orchestrator/services/connector/scripts/start-local.sh`. The launcher reads root `.env.local` by default; set `DU_ENV_FILE` to select another file. It builds the Connector dependency chain unless `-SkipBuild` or `DU_SKIP_BUILD=1` is used.

Connector listens at `http://127.0.0.1:8080`, matching the Compose container port. The launcher sets `PORT` and `CONNECTOR_PORT` to 8080 and uses `redis://127.0.0.1:6379`. Connector also requires `DATABASE_URL`, `SERVICE_IDENTITY_SECRET`, `CONNECTOR_ENCRYPTION_KEY`, and `CONNECTOR_INVOCATION_ENCRYPTION_KEYS` from the local environment file. Its schema migrations run during Connector startup; the script points `CONNECTOR_MIGRATION_DIRECTORY` to this package's source migration directory.

The Compose environment maps `CONNECTOR_INVOCATION_GRANT_SECRET` into the Connector's `INVOCATION_GRANT_SECRET`. This launcher applies that mapping: it uses the explicit Base64 Connector value when present, otherwise Base64-encodes the Orchestrator's raw ASCII `INVOCATION_GRANT_SECRET`. These values must represent the same 32-byte grant key. Do not use the raw value as a Connector encryption key.

The Orchestrator should be available on public 3000, Admin 3001, and Internal 3002; workers call Connector through `CONNECTOR_URL=http://127.0.0.1:8080`. `REDIS_URL` is `redis://127.0.0.1:6379`. If Orchestrator's Connector management surface is enabled, its `DU_CONNECTOR_BASE_URLS` must map the configured connector ID to this local base URL. Start PostgreSQL and Redis before Connector, then start workers after Orchestrator and Connector are healthy. The process binds to loopback only.
