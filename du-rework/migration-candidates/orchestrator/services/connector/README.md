# Connector Service

The Connector is a durable provider gateway. It resolves connector revisions
from PostgreSQL, stores invocation state and usage events durably, enforces
shared Redis quotas, validates signed grants and service identity, and calls
generic JSON or multipart providers through bounded `fetch` transport.

## Run

The production entrypoint requires:

- `DATABASE_URL`
- `REDIS_URL` (defaults to `redis://127.0.0.1:6379`)
- `SERVICE_IDENTITY_SECRET`
- `INVOCATION_GRANT_SECRET`
- `CONNECTOR_ENCRYPTION_KEY`

The three secrets must be base64-encoded 32-byte values. Optional settings are
`CONNECTOR_PORT` (checked before `PORT`), `HOST`, `REDIS_KEY_PREFIX`,
`CONNECTOR_MIGRATION_DIRECTORY`, `DRAIN_TIMEOUT_MS`, `USAGE_SINK_URL`,
`USAGE_SINK_TOKEN`, `PROVIDER_ALLOW_HOSTS`, and
`ALLOW_PRIVATE_PROVIDER_NETWORKS`. `SIGTERM` and
`SIGINT` stop intake, drain HTTP work and usage delivery, and close
PostgreSQL/Redis clients. Provider private-network access is denied by default;
allowing it is intended only for controlled development/test environments.

The listen port defaults to **8080** when neither `CONNECTOR_PORT` nor `PORT` is set.
The repo dev runner overrides it to **8088** via `.env.local.sample`, while
`.env.example` keeps 8080 — so the port you see locally depends on which env file
was loaded.

From `du-rework/`, install/build workspace dependencies, then run the
standalone entrypoint with the environment above:

```sh
pnpm install --frozen-lockfile
pnpm build
node services/connector/dist/entrypoint.js
```

For a local container fixture, use
`docker compose -f infra/docker-compose.yml --profile connector up -d --build connector`.
This targets only the isolated test database, not a production topology; see
the [root README](../../README.md) for the full-stack Compose blocker.

Connector revisions and encrypted credential versions are managed through the
durable repository. Provider credentials are write-only through rotation and
are never returned by management responses. Provider redirects, oversized
responses, invalid JSON, and transport failures fail closed; provider timeout
or lost-response outcomes remain `UNKNOWN` and are not blindly retried.

When `USAGE_SINK_URL` and `USAGE_SINK_TOKEN` are configured, a lifecycle-managed
durable outbox dispatcher validates and posts contract usage events with
idempotency keys, capped exponential retry, and persisted retry scheduling.

Shutdown stops accepting new invocations and drains accepted HTTP handlers and
usage delivery under one `DRAIN_TIMEOUT_MS` deadline (30 seconds by default).
At the deadline, active HTTP connections are force-closed before durable
dependencies are closed. `shutdown({ timeoutMs: 0 })` is an explicit teardown
opt-out for tests; it does not change the production default or prove graceful
drain behavior.

## Evidence

Local Connector tests cover adapters, grant and identity failures, lifecycle,
durable repository boundaries, quota, and replay behavior. Start the isolated
PostgreSQL/Redis test infra and claim the DB window before opt-in live suites:

```text
CONNECTOR_INTEGRATION=1 pnpm --filter @du/connector test -- --runInBand
```

This runs PostgreSQL migration/version checks, Redis shared quota checks, and
the black-box HTTP invocation/restart replay suite when PostgreSQL `5433` and
Redis `6380` are available. Cross-service Orchestrator usage/grant integration
remains a platform-owned runtime gate.
