# Cross-service integration tests

The executable integration suite lives in `integration/`. It exercises a real
Orchestrator operation/task and Connector `HttpUsageSink` against the isolated
PostgreSQL and Redis services on ports 5433 and 6380.

```bash
docker compose -f infra/docker-compose.yml up -d
pnpm test:integration
```

The suite uses synthetic data and an ephemeral HTTP port. It registers a unique
test business through the runtime HTTP API, uses the exported test-only version
enable hook because no admin enable endpoint exists yet, submits and completes a
real task over HTTP, reads its dispatch from the documented BullMQ queue, and
verifies usage deduplication/projection before and after an Orchestrator restart.
It does not claim document-core or full-system E2E coverage: artifact APIs and
invocation-grant issuance are not implemented in the current runtime slice.
