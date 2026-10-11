# LC Checker local worker

From the `du-rework` root, run `./businesses/lc-checker/scripts/start-local.ps1` or `bash businesses/lc-checker/scripts/start-local.sh`. The script reads the root `.env.local` by default; set `DU_ENV_FILE` for another env file. It builds LC Checker and workspace dependencies unless `-SkipBuild` or `DU_SKIP_BUILD=1` is used.

LC Checker is a worker and **does not expose an HTTP listener**. Its launcher sets `PORT=0` to avoid inheriting a misleading server port. It registers and heartbeats through `RUNTIME_URL=http://127.0.0.1:3002/api/runtime/v1`, uses Redis at `redis://127.0.0.1:6379`, and invokes Connector at `http://127.0.0.1:8080`.

Start PostgreSQL/Redis, Orchestrator, and Connector first. Configure `LC_RUNTIME_TOKEN` in `.env.local` and ensure the Orchestrator worker identity map contains the same `lc-checker` token. The launcher maps the token to `RUNTIME_TOKEN` using the repository's shared local environment helper. When `CONNECTOR_SERVICE_TOKEN` is blank, it creates a short-lived local Connector identity from `SERVICE_IDENTITY_SECRET`; this is only for local development and must match the service identity key configured by Connector and Orchestrator.

The common local ports are Orchestrator Public 3000, Admin 3001, Internal 3002, Connector 8080, and Redis 6379. LC Checker has no separate port to publish; its health is represented by Runtime registration and heartbeat state.
