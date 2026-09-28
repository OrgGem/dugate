# P0-06 capacity targets for P8-05 (code-derived, explicit limits)

Status: P0-06 stays `[ ]` pending reviewer acceptance. Every number below
comes from a code constant, contract schema, or an explicitly-marked TARGET
in `businesses/document-core/docs/workload-assumptions.md`. Nothing here is
a production SLA. P8-05 must read this file plus the workload file, not
invent targets.

## 1. Document size and page counts

| Target | Value | Label | Source |
|---|---|---|---|
| Text length per submission | 100,000 chars max | IMPLEMENTED (enforced) | input-normalizer.ts MAX_TEXT_LENGTH = 100_000 |
| Ingest artifacts | 20 max | IMPLEMENTED (enforced) | input-normalizer.ts MAX_ARTIFACTS_INGEST = 20 |
| Other-action artifacts | 10 max | IMPLEMENTED (enforced) | input-normalizer.ts MAX_ARTIFACTS_DEFAULT = 10 |
| Page selection | 500 max | IMPLEMENTED (enforced) | input-normalizer.ts MAX_PAGES_LIMIT = 500 |
| QA questions | 20 max, non-empty | IMPLEMENTED (enforced) | input-normalizer.ts MAX_QA_QUESTIONS = 20 |
| maxWords | 1..10,000 | IMPLEMENTED (enforced) | input-normalizer.ts MAX_WORDS_LIMIT = 10_000 |
| Custom schema depth | 5, no network $ref | IMPLEMENTED (enforced) | schema-validator.ts MAX_DEPTH = 5 |
| ZIP archive | 50 MB default cap | IMPLEMENTED (default) | zip-extractor.ts DEFAULT_MAX_SIZE = 50MB |
| Upload document / pages / rows / artifact bytes | 10MB, 100 pages, 50k rows, 20MB | TARGET / UNENFORCED | workload-assumptions.md section 2 (no enforcing call site; parseBuffer without options) |

## 2. Submission and fan-out rates

| Target | Value | Label | Source |
|---|---|---|---|
| Operations list page | limit 1..100, default 20 | IMPLEMENTED (enforced) | contracts public-api.ts OPERATIONS_LIST_LIMIT_DEFAULT / OPERATIONS_LIST_LIMIT_MAX (imported by the route; PageQuerySchema is the generic base, not this schema) |
| Connector management body | 16,384 bytes | IMPLEMENTED (enforced) | connector http/server.ts readJson default |
| Invocation body | 1,048,576 bytes | IMPLEMENTED (enforced) | connector http/server.ts invocation default |
| Cancel reason | 500 chars max | IMPLEMENTED (enforced) | connector http/server.ts cancel validation |
| Fan-out join policy | all-success only | IMPLEMENTED (v1 scope) | contracts runtime.ts SpawnChildrenRequestSchema literal |
| Child spec | min 1 child, taskKey/kind/payloadRef/payloadHash required | IMPLEMENTED (enforced) | contracts runtime.ts ChildTaskSpecSchema |
| Submission/fan-out RPS | no committed rate | NO TARGET STATED | no code constant found; P8-05 must propose and measure, not assume |

## 3. Artifact retention windows

| Target | Value | Label | Source |
|---|---|---|---|
| Upload/access grant TTL | 15 minutes | IMPLEMENTED | artifacts.ts GRANT_TTL_MS = 15*60*1000 |
| Invocation grant TTL | 15 minutes | IMPLEMENTED | grants.ts GRANT_TTL_SECONDS = 15*60 |
| Intermediate artifacts | 7 days | TARGET / UNENFORCED | workload-assumptions.md section 5 (no sweep exists) |
| Terminal result artifacts | 30 days | TARGET / UNENFORCED | workload-assumptions.md section 5 (no sweep exists) |
| Usage events | indefinite, unpartitioned | IMPLEMENTED STORAGE / NO PARTITIONING | workload-assumptions.md section 5 |

## 4. Latency percentiles

| Target | Value | Label | Source |
|---|---|---|---|
| Poll cadence | 500 ms | IMPLEMENTED | facade.ts waitForTerminal delay 500ms |
| Poll cap | 30 s | IMPLEMENTED | facade.ts MAX_WAIT_SECONDS = 30 |
| Shutdown drain | 30,000 ms, poll 500 ms | IMPLEMENTED (default) | server.ts shutdownTimeoutMs 30000 |
| Lease sweep interval | 5,000 ms | IMPLEMENTED (default) | server.ts sweep interval 5000ms |
| Connector probe timeout | 5,000 ms | IMPLEMENTED | connectors.ts PROBE_TIMEOUT_MS = 5_000 |
| Quota lease | 30,000 ms, retry-after 1,000 ms | IMPLEMENTED (default) | connector invoke.ts quotaLeaseMs 30_000 |
| p50/p95/p99 latency | no committed values | NO TARGET STATED | workload file gives mock 20-50ms benchmark only; P8-05 must measure |

## 5. Concurrency per business profile

| Target | Value | Label | Source |
|---|---|---|---|
| Parent yield | concurrency=1 safe via WAITING_CHILDREN/WAITING_INPUT | IMPLEMENTED (design) | runtime children/wait routes + P7-T5/T6 tests |
| Worker heartbeat capacity | 1 | IMPLEMENTED (ack shape) | server.ts heartbeat ack capacity: 1 |
| Action mix sizing | extract 40 / analyze 25 / ingest 15 / generate 10 / transform 5 / compare 5 | TARGET / UNENFORCED | workload-assumptions.md section 3 (sizing assumption, no enforcement) |
| Tenant concurrency / replica counts | no committed values | NO TARGET STATED | P8-05 1-2-4 replica benchmark must set them |

Cross-links: workloadassumptions `businesses/document-core/docs/workload-assumptions.md`;
audit `docs/19-traceability-audit-matrix.md` section 2 (BR-04/BR-05 rows);
P8-05 row `tasks/P8-release-readiness.md`. NO DB USED.
