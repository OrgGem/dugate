# FUNCTEST-A — offline functional test receipt

**Date:** 2026-10-02  
**Scope:** `packages/contracts`, `packages/worker-sdk`, `packages/connector-client`, `packages/document-kit`, and `packages/observability`, following `du-rework/coordination/dispatch-specs/2026-10-02-0210-FUNCTEST-A-contracts-sdk.md`. No source or test files were modified. No database, Redis, Elasticsearch, MinIO, Docker, or other service infrastructure was started or contacted.

Counts by file were taken from Jest's machine-readable summary on a repeated run; package summary lines below are the literal Jest output from the package runs. A second run with `--json` was used only to read per-file counts.

## Results

### `packages/contracts`

Working directory: `du-rework/packages/contracts`  
Commands: `npx jest --runInBand` and `npx jest --runInBand --json`  
Exit code: `0` for both runs.

Literal Jest summary:

```text
Test Suites: 23 passed, 23 total
Tests:       464 passed, 464 total
Snapshots:   0 total
```

| Suite | Passed | Failed | Skipped |
|---|---:|---:|---:|
| `usage-budget.test.ts` | 30 | 0 | 0 |
| `vault-policies.test.ts` | 62 | 0 | 0 |
| `usage-reconciliation.test.ts` | 29 | 0 | 0 |
| `pricing.test.ts` | 28 | 0 | 0 |
| `usage-metrics.test.ts` | 24 | 0 | 0 |
| `multipart-contract.test.ts` | 31 | 0 | 0 |
| `vault-ref.test.ts` | 59 | 0 | 0 |
| `invocation-hash.test.ts` | 6 | 0 | 0 |
| `oidc-claim-shapes.test.ts` | 14 | 0 | 0 |
| `state-machine.test.ts` | 12 | 0 | 0 |
| `hashing-errors.test.ts` | 11 | 0 | 0 |
| `operations-list-contract.test.ts` | 16 | 0 | 0 |
| `grant-encryption-envelope.test.ts` | 13 | 0 | 0 |
| `dto.test.ts` | 21 | 0 | 0 |
| `queue.test.ts` | 7 | 0 | 0 |
| `result-wire.test.ts` | 4 | 0 | 0 |
| `ingestion-receipt.test.ts` | 20 | 0 | 0 |
| `manifest.test.ts` | 20 | 0 | 0 |
| `usage-event-export.test.ts` | 5 | 0 | 0 |
| `usage-budget-reservation.test.ts` | 7 | 0 | 0 |
| `encryption.test.ts` | 38 | 0 | 0 |
| `ip-policy.test.ts` | 4 | 0 | 0 |
| `admin-resource-list-contract.test.ts` | 3 | 0 | 0 |

### `packages/worker-sdk`

Working directory: `du-rework/packages/worker-sdk`  
Commands: `npx jest --runInBand '--testPathIgnorePatterns=network-boundaries\.boundary\.test\.ts|workspace-reference-wiring\.test\.ts'` and the same command with `--json` appended. The regex excluded the two suites explicitly named by the spec.  
Exit code: `0` for both runs.

Literal Jest summary:

```text
Test Suites: 21 passed, 21 total
Tests:       621 passed, 621 total
Snapshots:   0 total
```

| Suite | Passed | Failed | Skipped |
|---|---:|---:|---:|
| `artifact-multipart-rss.test.ts` | 13 | 0 | 0 |
| `artifact-multipart.test.ts` | 30 | 0 | 0 |
| `artifact-direct-band.test.ts` | 28 | 0 | 0 |
| `worker-service-auth.test.ts` | 26 | 0 | 0 |
| `temp-sweep.test.ts` | 19 | 0 | 0 |
| `source-acquisition.test.ts` | 40 | 0 | 0 |
| `temp-workspace.test.ts` | 19 | 0 | 0 |
| `rv01-03-fail-closed.test.ts` | 17 | 0 | 0 |
| `artifact-stream-bounds.test.ts` | 39 | 0 | 0 |
| `worker.test.ts` | 25 | 0 | 0 |
| `artifact-streams.test.ts` | 57 | 0 | 0 |
| `crypto-seam.test.ts` | 14 | 0 | 0 |
| `artifact-read-metadata.test.ts` | 37 | 0 | 0 |
| `fan-out.test.ts` | 20 | 0 | 0 |
| `source-ingestion.test.ts` | 44 | 0 | 0 |
| `artifact-sweep-guard.test.ts` | 17 | 0 | 0 |
| `connector-invoker.test.ts` | 36 | 0 | 0 |
| `connector-session.test.ts` | 53 | 0 | 0 |
| `connector-input-contract.test.ts` | 60 | 0 | 0 |
| `enc-read-roundtrip-proof.test.ts` | 1 | 0 | 0 |
| `artifact-stat.test.ts` | 26 | 0 | 0 |

### `packages/connector-client`

Working directory: `du-rework/packages/connector-client`  
Commands: `npx jest --runInBand --runTestsByPath tests/client.test.ts tests/sdk-invoker.test.ts tests/transport.test.ts` and the same command with `--json` appended.  
Exit code: `0` for both runs.

Literal Jest summary:

```text
Test Suites: 3 passed, 3 total
Tests:       24 passed, 24 total
Snapshots:   0 total
```

| Suite | Passed | Failed | Skipped |
|---|---:|---:|---:|
| `sdk-invoker.test.ts` | 2 | 0 | 0 |
| `transport.test.ts` | 19 | 0 | 0 |
| `client.test.ts` | 3 | 0 | 0 |

### `packages/document-kit`

Working directory: `du-rework/packages/document-kit`  
Commands: `npx jest --runInBand` and `npx jest --runInBand --json`  
Exit code: `0` for both runs.

Literal Jest summary:

```text
Test Suites: 10 passed, 10 total
Tests:       130 passed, 130 total
Snapshots:   0 total
```

| Suite | Passed | Failed | Skipped |
|---|---:|---:|---:|
| `parsers.test.ts` | 10 | 0 | 0 |
| `limits-boundary.test.ts` | 37 | 0 | 0 |
| `r1-e-archive-guard.test.ts` | 20 | 0 | 0 |
| `r1-e-declared-metadata-parse.test.ts` | 3 | 0 | 0 |
| `r1-e-zip64-descriptor-cpu.test.ts` | 10 | 0 | 0 |
| `r1-e-format-identity.test.ts` | 14 | 0 | 0 |
| `pdf-splitter.test.ts` | 10 | 0 | 0 |
| `zip-extractor.test.ts` | 8 | 0 | 0 |
| `detector.test.ts` | 5 | 0 | 0 |
| `converters.test.ts` | 13 | 0 | 0 |

### `packages/observability`

Working directory: `du-rework/packages/observability`  
Commands: `npx jest --runInBand --runTestsByPath tests/observability.test.ts` and `npx jest --runInBand --runTestsByPath tests/elasticsearch-collector.test.ts`. The collector suite was inspected before running: it injects a mock `fetch` and uses a local temporary spool directory; it does not connect to Elasticsearch.  
Exit code: `0` for both commands.

Literal Jest summaries:

```text
Test Suites: 1 passed, 1 total
Tests:       23 passed, 23 total
```

```text
Test Suites: 1 passed, 1 total
Tests:       13 passed, 13 total
```

| Suite | Passed | Failed | Skipped |
|---|---:|---:|---:|
| `observability.test.ts` | 23 | 0 | 0 |
| `elasticsearch-collector.test.ts` | 13 | 0 | 0 |

## Excluded suites

These were not run because the spec explicitly excludes them; no connection was attempted:

- `packages/worker-sdk/tests/network-boundaries.boundary.test.ts` — explicit spec exclusion.
- `packages/worker-sdk/tests/workspace-reference-wiring.test.ts` — explicit spec exclusion.
- `packages/connector-client/tests/real-service.test.ts` — explicit spec exclusion for live service coverage.
- `packages/connector-client/tests/network-boundaries.boundary.test.ts` — explicit spec exclusion.

No additional suite was skipped after detecting an infrastructure dependency. The optional Elasticsearch collector suite ran offline with mock fetch and passed.

## Aggregate

| Result | Count |
|---|---:|
| Suites passed | 59 / 59 |
| Tests passed | 1,275 / 1,275 |
| Suites failed | 0 |
| Tests failed | 0 |
| Tests skipped inside executed suites | 0 |
| Infra services used | 0 |

No failing test output was produced.
