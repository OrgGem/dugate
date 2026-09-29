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
| `CONNECTOR_URL` | No | `undefined` | Connector internal base URL (e.g. `http://localhost:8080`) |
| `CONNECTOR_SERVICE_TOKEN` | Required with `CONNECTOR_URL` | — | Short-lived signed Bearer token with audience `connector` and scope `connector:invoke`; issue it through the service identity authority and keep its signing secret in Connector only |
| `CONCURRENCY` | No | `1` | Max concurrent task deliveries (positive integer) |
| `HEARTBEAT_INTERVAL_MS` | No | `10000` | Lease heartbeat interval in milliseconds |
| `WORKER_INSTANCE_ID` | No | Auto-generated UUID | Unique identifier for this worker instance |
| `IMAGE_DIGEST` | No | Development placeholder | Docker image digest reported during registration; set a real digest for deployment |
| `SHUTDOWN_GRACE_MS` | No | `15000` | Grace period in milliseconds for draining in-flight jobs on SIGTERM/SIGINT |

## Build & Run

### Prerequisites
- Node.js 20+
- pnpm 9+
- Redis (e.g. at `localhost:6380`)
- Running Orchestrator Runtime service (or local fake runtime for offline testing)

### Local Development
From the `du-rework/` workspace root:

```sh
pnpm install --frozen-lockfile
pnpm build

# Start the worker in another terminal after Orchestrator and Redis are ready.
# Set both Connector values only when handlers invoke Connector.
pnpm --filter @du/document-core start
```

Set `RUNTIME_URL`, `RUNTIME_TOKEN`, and `REDIS_URL` in the worker terminal
before the `start` command. For example, in PowerShell:

```powershell
$env:RUNTIME_URL = 'http://127.0.0.1:3000/api/runtime/v1'
$env:RUNTIME_TOKEN = '<runtime-token-rieng>'
$env:REDIS_URL = 'redis://127.0.0.1:6380'
```

The worker alone does not provision an active business version, profile, or
external API key. See the [root usage guide](../../README.md).

### Docker Execution
The service container uses a workspace-aware Dockerfile. From `du-rework/`:

```sh
docker build -f businesses/document-core/Dockerfile -t du-document-core:latest .
```

Run the image only on a network where the configured Orchestrator, Redis and
optional Connector endpoints are reachable. The root full-stack Compose is
currently blocked by duplicate included services; see the [Docker status](../../README.md#docker).
On direct execution, `dist/main.js` validates environment variables, initiates worker registration, and handles `SIGTERM` / `SIGINT` signals to gracefully drain in-flight jobs within `SHUTDOWN_GRACE_MS`.

## Testing

```sh
# Offline default; excludes *.integration.test.ts.
pnpm --filter @du/document-core test

# Separate live multi-container suite; requires an approved test-DB window.
pnpm --filter @du/document-core test:integration:full
```

## Architectural Boundaries

- **Zero Direct Database Access**: `document-core` does not connect to PostgreSQL directly; all task state, artifact access, and step checkpoints are managed through the Runtime HTTP API via `@du/worker-sdk`.
- **Zero Direct Provider Calls**: LLM inference and external OCR are invoked strictly through the Connector facade (`@du/worker-sdk` connector invoker), never bypassing platform ledgers or quotas.
- **Durable Checkpointing**: Step execution uses `StepCheckpointManager` with stable step keys (e.g. `ingest:prepare-source`, `extract:connector-inference`) and sha256 input hashing to guarantee idempotent recovery and avoid duplicate inference.
- **Evidence Boundary**: The offline package suite excludes live multi-container integration. Passing it does not close the current [release gates](../../tasks/README.md).
