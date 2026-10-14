# @du/document-core — Document Core Worker Service

Document Core is the primary business worker service in the DUGate platform. It implements the six core asynchronous document processing actions (`ingest`, `extract`, `analyze`, `transform`, `generate`, `compare`) with 31 declared variants, plus the internal multi-turn `disbursement` workflow, executing tasks via the `@du/worker-sdk` runner on top of BullMQ and Redis.

## Actions & Variants

Variant lists below are the **manifest enums** (`src/manifest/document-core.manifest.ts`), which are the wire contract.

| Action | Handler Kind | Variants / Modes | Description |
|---|---|---|---|
| **ingest** | `ingest` | `parse`, `ocr`, `digitize`, `split` | Document ingestion, text/markdown conversion, OCR extraction, format digitization, bounded PDF splitting |
| **extract** | `extract` | `invoice`, `contract`, `id-card`, `receipt`, `table`, `custom` | Structured data and schema-driven entity extraction via connector inference |
| **analyze** | `analyze` | `classify`, `sentiment`, `compliance`, `fact-check`, `quality`, `risk`, `summarize-eval` | Taxonomy classification, sentiment scoring, compliance/fact checks, quality and summary evaluation, risk assessment |
| **transform** | `transform` | `convert`, `translate`, `rewrite`, `redact`, `template` | Bounded format conversion, multi-lingual translation, stylistic rewriting, PII redaction/masking, template rendering |
| **generate** | `generate` | `summary`, `outline`, `report`, `email`, `minutes`, `qa` | Summaries, outlines, reports, email drafts, meeting minutes, document Q&A |
| **compare** | `compare` | `diff`, `semantic`, `version` | Textual diffing, semantic similarity evaluation, document revision tracking |
| **disbursement** | `disbursement` | input `inputVersion: disbursement-input-v1` | Internal multi-turn workflow: classify + extract fan-out, explicit human approval wait, reference cross-check, report |

In addition, a top-level `root` dispatcher handler routes tasks to the appropriate action based on the delivery's `action` parameter.

### Note on `disbursement`

`disbursement` is a real handler kind, not a placeholder: `src/worker.ts` implements
typed fan-out, checkpointed workflow state, an approval wait/resume, and connector
invocation through four required slots (`classify`, `extract`, `crosscheck`, `report`).
The manifest comment notes the `root` handler kind remains the dispatch fallback until
host wiring lands in a separate lane. It requires the workflow continuation runtime and
fails closed with `DISBURSEMENT_RUNTIME_UNAVAILABLE` when that runtime is absent.

## Configuration

Worker configuration is parsed and validated using Zod at startup with fail-closed semantics (`src/config.ts`). Sensitive credentials (such as `RUNTIME_TOKEN` and `CONNECTOR_SERVICE_TOKEN`) are never logged or exposed in error messages. Connector requests use a separate short-lived Bearer service identity token; `RUNTIME_TOKEN` is not accepted as Connector authentication.

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `RUNTIME_URL` | **Yes** | — | Internal Runtime API base URL (e.g. `http://127.0.0.1:3002/api/runtime/v1`) |
| `RUNTIME_TOKEN` | **Yes** | — | Bearer service identity token scoped to this business |
| `REDIS_URL` | **Yes** | — | Redis connection URL for BullMQ queue consumption (e.g. `redis://127.0.0.1:16380`) |
| `CONNECTOR_URL` | No | `undefined` | Connector local base URL (e.g. `http://127.0.0.1:8088`) |
| `CONNECTOR_SERVICE_TOKEN` | Required with `CONNECTOR_URL` | — | Short-lived signed Bearer token with audience `connector` and scope `connector:invoke`; issue it through the service identity authority and keep its signing secret in Connector only |
| `CONCURRENCY` | No | `1` | Max concurrent task deliveries (positive integer) |
| `HEARTBEAT_INTERVAL_MS` | No | `10000` | Lease heartbeat interval in milliseconds |
| `WORKER_INSTANCE_ID` | No | Auto-generated UUID | Unique identifier for this worker instance |
| `IMAGE_DIGEST` | No | Development placeholder | Docker image digest reported during registration; set a real digest for deployment |
| `SHUTDOWN_GRACE_MS` | No | `15000` | Grace period in milliseconds for draining in-flight jobs on SIGTERM/SIGINT |

## Build & Run

### Prerequisites
- Node.js `24.21.0` and pnpm `10.18.3`
- Installed dependencies from this directory's nested workspace
- Running local Orchestrator, Connector, PostgreSQL, and Redis

### Local Development
From this directory, install the standalone workspace and start the local worker:

```sh
pnpm install --frozen-lockfile
pnpm run dev:check
pnpm run dev
```

Set the worker's local `.env.local` from `.env.example`. Use the existing Document Core worker token and an issued Connector invoke token. For development, the existing service identity key can replace the short-lived Connector token in `.env.local`; the runner derives a fresh Connector token at startup and removes the key before starting the worker. It builds the vendored package sources and this worker in dependency order, then watches `src/` and `vendor/`. See the [local worker guide](README-LOCAL.md) for setup details. Vendored source origins and SHA-256 hashes are recorded in [vendor/PROVENANCE.json](vendor/PROVENANCE.json).

The worker alone does not provision an active business version, profile, or
external API key. See the [root usage guide](../../README.md).

### Docker Execution
The package's Compose entrypoint starts only Document Core and connects it to the externally managed `du-worker-net`. The platform services must already be attached to that network under the DNS names `orchestrator`, `valkey`, and `connector`; Runtime traffic uses the internal port `3002`.

```sh
cp .env.example .env.docker.local
docker compose --env-file .env.docker.local config
docker compose --env-file .env.docker.local up -d --build
```

Set `DOCUMENT_CORE_RUNTIME_TOKEN` to the existing Document Core business identity and `CONNECTOR_SERVICE_TOKEN` to an issued `connector:invoke` token in `.env.docker.local`. The Docker-specific `DOCUMENT_CORE_DOCKER_*` URLs in that file use the shared service DNS names; the ordinary `RUNTIME_URL`, `REDIS_URL`, and `CONNECTOR_URL` entries remain for direct local execution. Compose publishes no worker port and does not start or recreate the platform services. The image packages the production dependency closure and vendored worker sources from this directory's build context. The Node process handles `SIGTERM` and `SIGINT` by draining in-flight jobs for `SHUTDOWN_GRACE_MS` (15 seconds by default); Compose allows 30 seconds before force-stopping it.

## Testing

```sh
# Standalone package tests.
pnpm run test

# Explicit monorepo integration; requires built Orchestrator/Connector services
# and their test infrastructure.
pnpm run test:integration:full
```

## Architectural Boundaries

- **Zero Direct Database Access**: `document-core` does not connect to PostgreSQL directly; all task state, artifact access, and step checkpoints are managed through the Runtime HTTP API via `@du/worker-sdk`.
- **Zero Direct Provider Calls**: LLM inference and external OCR are invoked strictly through the Connector facade (`@du/worker-sdk` connector invoker), never bypassing platform ledgers or quotas.
- **Durable Checkpointing**: Step execution uses `StepCheckpointManager` with stable step keys (e.g. `ingest:prepare-source`, `extract:connector-inference`) and sha256 input hashing to guarantee idempotent recovery and avoid duplicate inference.
- **Evidence Boundary**: The offline package suite excludes live multi-container integration. Passing it does not close the current [release gates](../../tasks/README.md).
