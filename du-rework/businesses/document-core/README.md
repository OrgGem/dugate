# @du/document-core — Document Core Worker Service

Document Core is the primary business worker service in the DUGate platform. It implements all six core asynchronous document processing actions (`ingest`, `extract`, `analyze`, `transform`, `generate`, `compare`) and their 28 variants, executing tasks via the `@du/worker-sdk` runner on top of BullMQ and Redis.

## Actions & Variants

| Action | Handler Kind | Variants / Modes | Description |
|---|---|---|---|
| **ingest** | `ingest` | `parse`, `ocr`, `digitize`, `split` | Document ingestion, text/markdown conversion, OCR extraction, format digitization, bounded PDF splitting |
| **extract** | `extract` | `invoice`, `contract`, `receipt`, `table`, `custom` | Structured data and schema-driven entity extraction via connector inference |
| **analyze** | `analyze` | `classify`, `sentiment`, `quality`, `pii`, `summary` | Document classification, sentiment scoring, text quality assessment, PII audit, extractive/abstractive summarization |
| **transform** | `transform` | `format`, `translate`, `rewrite`, `redact`, `template` | Bounded format conversion, multi-lingual translation, stylistic rewriting, PII redaction/masking, template rendering |
| **generate** | `generate` | `faq`, `brief`, `metadata`, `schema`, `qa` | Contextual synthesis, executive briefing generation, metadata extraction, JSON schema inference, multi-turn Q&A |
| **compare** | `compare` | `diff`, `semantic`, `version` | Textual diffing, semantic similarity evaluation, document revision tracking |

In addition, a top-level `root` dispatcher handler routes tasks to the appropriate action based on the delivery's `action` parameter.

## Configuration

Worker configuration is parsed and validated using Zod at startup with fail-closed semantics (`src/config.ts`). Sensitive credentials (such as `RUNTIME_TOKEN` and `CONNECTOR_SERVICE_TOKEN`) are never logged or exposed in error messages. Connector requests use a separate short-lived Bearer service identity token; `RUNTIME_TOKEN` is not accepted as Connector authentication.

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `RUNTIME_URL` | **Yes** | — | Runtime API base URL (e.g. `http://localhost:3000/api/runtime/v1`) |
| `RUNTIME_TOKEN` | **Yes** | — | Bearer service identity token scoped to this business |
| `REDIS_URL` | **Yes** | — | Redis connection URL for BullMQ queue consumption (e.g. `redis://localhost:6380`) |
| `CONNECTOR_URL` | No | `undefined` | Connector internal base URL (e.g. `http://localhost:3100/internal/v1`) |
| `CONNECTOR_SERVICE_TOKEN` | Required with `CONNECTOR_URL` | — | Short-lived signed Bearer token with audience `connector` and scope `connector:invoke`; issue it through the service identity authority and keep its signing secret in Connector only |
| `CONCURRENCY` | No | `1` | Max concurrent task deliveries (positive integer) |
| `HEARTBEAT_INTERVAL_MS` | No | `10000` | Lease heartbeat interval in milliseconds |
| `WORKER_INSTANCE_ID` | No | Auto-generated UUID | Unique identifier for this worker instance |
| `IMAGE_DIGEST` | No | Manifest digest | Docker image digest reported during registration |
| `SHUTDOWN_GRACE_MS` | No | `15000` | Grace period in milliseconds for draining in-flight jobs on SIGTERM/SIGINT |

## Build & Run

### Prerequisites
- Node.js 20+
- pnpm 9+
- Redis (e.g. at `localhost:6380`)
- Running Orchestrator Runtime service (or local fake runtime for offline testing)

### Local Development
```bash
# Build TypeScript to dist/
npm run build

# Start the worker process (requires valid environment variables)
export RUNTIME_URL="http://localhost:3000/api/runtime/v1"
export RUNTIME_TOKEN="your-service-token"
export REDIS_URL="redis://localhost:6380"
# Set both Connector values when worker handlers invoke Connector.
export CONNECTOR_URL="http://localhost:3100/internal/v1"
export CONNECTOR_SERVICE_TOKEN="short-lived-connector-service-token"
npm run start
```

### Docker Execution
The service container is built using the workspace-aware Dockerfile:
```dockerfile
# Build image
docker build -f businesses/document-core/Dockerfile -t du-document-core:latest .

# Run worker container
docker run --rm \
  -e RUNTIME_URL="http://orchestrator:3000/api/runtime/v1" \
  -e RUNTIME_TOKEN="secret-token" \
  -e CONNECTOR_URL="http://connector:3100/internal/v1" \
  -e CONNECTOR_SERVICE_TOKEN="short-lived-connector-service-token" \
  -e REDIS_URL="redis://redis:6379" \
  du-document-core:latest
```
On direct execution, `dist/main.js` validates environment variables, initiates worker registration, and handles `SIGTERM` / `SIGINT` signals to gracefully drain in-flight jobs within `SHUTDOWN_GRACE_MS`.

## Testing

```bash
# Run all unit and integration tests (98 tests across 12 suites)
npm test

# Run configuration & process lifecycle tests
npx jest tests/config.test.ts

# Run SDK consumer tests with injected QueueConsumer
npx jest tests/sdk-consumer.test.ts

# Run opt-in BullMQ & Redis smoke test against live Redis on port 6380
REDIS_SMOKE=1 npx jest tests/bullmq-smoke.test.ts
```

## Architectural Boundaries

- **Zero Direct Database Access**: `document-core` does not connect to PostgreSQL directly; all task state, artifact access, and step checkpoints are managed through the Runtime HTTP API via `@du/worker-sdk`.
- **Zero Direct Provider Calls**: LLM inference and external OCR are invoked strictly through the Connector facade (`@du/worker-sdk` connector invoker), never bypassing platform ledgers or quotas.
- **Durable Checkpointing**: Step execution uses `StepCheckpointManager` with stable step keys (e.g. `ingest:prepare-source`, `extract:connector-inference`) and sha256 input hashing to guarantee idempotent recovery and avoid duplicate inference.
- **Evidence Boundary**: All 98 package tests pass locally without external cloud dependencies. Full cross-service integration with live Orchestrator depends on `coordination/gates/runtime-ready.md`.
