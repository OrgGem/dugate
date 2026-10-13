# `@du/observability`

Shared structured JSON logging, correlation context, redaction, and bounded metrics.

## Log record

The logger writes one JSON object per stdout line. Every record includes
`timestamp` (ISO-8601 UTC), `level`, `service`, `environment`, `correlationId`,
`taskId`, `invocationId`, and `message`. `taskId` and `invocationId` are `null`
when not applicable. `service` is preferred in configuration; `component` is
kept as a compatibility alias.

`environment` accepts `dev`, `test`, `staging`, or `prod`; otherwise it is
resolved from `DU_ENVIRONMENT`, `APP_ENV`, or `NODE_ENV` (`development` and
`production` map to `dev` and `prod`).

## Redaction and errors

Every log value passes through redaction before JSON serialization. The boundary
masks bearer/provider credentials, JWTs, private keys, database credential
URLs, signed/query-token URLs, webhook/body payloads, artifact/file names and
paths, and byte buffers. Error objects use the ADM-BASE-03 class-only taxonomy:
`{ kind: "UNEXPECTED_ERROR", message: "Unexpected error; details redacted." }`.
Exception messages and stacks are never serialized.

`createLogger({ service, environment, sink })` supports injected sinks and clocks
for deterministic offline tests. `component` remains accepted for existing
callers while they migrate to the service field.

## Elasticsearch collector

`createElasticsearchLogCollector` consumes newline-delimited JSON records from
container or host stdout. It validates the LOG-01 fields, applies the shared
redactor again at the collector boundary, and writes data to
`du-logs-{dev|test|staging|prod}` data streams over verified HTTPS using an
Elasticsearch API key. The key should have create/write permissions for these
streams only; do not grant read, manage, or cluster privileges. Native Node
TLS verification stays enabled, and redirects, endpoint credentials, and URL
query data are rejected.

Records are appended to a private (`0700` directory, `0600` files), bounded
JSONL spool before delivery. Defaults cap the spool at 256 MiB, segments at
256 KiB, pending segment files at 4096, input records at 64 KiB, and the
collector's working set at 8 MiB. Collector options are rejected if the
declared memory budget cannot cover the bounded spool batch and response.
When the spool reaches its quota, new records are dropped and `onDrop` reports
the reason/count; `stats()` exposes dropped records, buffered bytes/records,
retry count, and ingest lag for alerting. Elasticsearch is called only by the
background collector loop with a timeout and bounded retries, never by the
application logger. Input stream reads pause while local spooling applies
backpressure.

Delivery is at least once: a collector restart replays retained spool segments,
so a response lost after Elasticsearch accepted a bulk request can result in
duplicate documents. Configure an ILM policy and data-stream template outside
the application, alert on `buffer_drop`, `elasticsearch_retry`, and ingest lag,
and keep the spool on a quota-controlled private local volume. See the
Orchestrator `logs:collect` command for a stdin-based host/container runner.
For example, after building Orchestrator, a host log forwarder can pipe a
container stream to `pnpm --filter @du/orchestrator logs:collect`; set
`ELASTICSEARCH_URL`, `ELASTICSEARCH_API_KEY`, and a private
`LOG_COLLECTOR_SPOOL_DIR` in the collector process environment. The service's
normal stdout path stays unchanged when Elasticsearch is unavailable.
