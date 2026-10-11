# Document Core local worker

From the `du-rework` root, run `./businesses/document-core/scripts/start-local.ps1` or `bash businesses/document-core/scripts/start-local.sh`. The script reads the root `.env.local` by default; set `DU_ENV_FILE` for another env file. It builds Document Core and workspace dependencies unless `-SkipBuild` or `DU_SKIP_BUILD=1` is used.

Document Core is a worker and **does not expose an HTTP listener**. Its launcher sets `PORT=0` so an inherited port cannot be mistaken for a worker API. It registers and heartbeats through `RUNTIME_URL=http://127.0.0.1:3002/api/runtime/v1`, consumes from Redis at `redis://127.0.0.1:6379`, and invokes Connector at `http://127.0.0.1:8080`.

Start PostgreSQL/Redis, the Orchestrator, and Connector first. Configure `DOCUMENT_CORE_RUNTIME_TOKEN` in `.env.local` and ensure the Orchestrator's worker identity map contains the same business token. The launcher maps that token to the runtime process using the repository's shared local environment helper. If `CONNECTOR_SERVICE_TOKEN` is blank, it creates a short-lived local Connector identity from `SERVICE_IDENTITY_SECRET`; this is for local development only. The matching service identity key must be configured in Connector and Orchestrator.

The common local ports are Orchestrator Public 3000, Admin 3001, Internal 3002, Connector 8080, and Redis 6379. Document Core itself is identified by its Runtime registration and has no separate port to publish.
