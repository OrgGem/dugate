# Workload, SLO, Retention & Security Assumptions (P0-06)

## 1. Important Notice on Production SLAs vs. Test Benchmarks

> [!IMPORTANT]
> **Production SLAs are currently unknown and are NOT committed in this document.**
> All numeric values, throughput metrics, and latency numbers listed below are **design assumptions and benchmark baselines** established for testing and mock validation. They must not be quoted as binding customer SLA guarantees until empirical production load testing (Phase P8) is executed against real cloud infrastructure.

---

## 2. Document & Payload Size Assumptions

| Parameter | Baseline Value | Status | Implementation Source & Enforcement Mechanism | Owner |
|---|---|---|---|---|
| **Max Upload Document Size** | 10 MB per individual document | **`[TARGET / UNENFORCED]`** | `@du/document-kit` supports deterministic `maxBufferSizeBytes` option, but currently HTTP gateway API routes and business action callers do not pass configured byte budgets. Memory is bounded only by physical Node.js heap. | Platform (Gateway) & Antigravity (Kit/Core) |
| **Max Batch / Archive Size** | 50 MB per ZIP archive | **`[IMPLEMENTED]`** | Enforced deterministically in `SafeArchiveExtractor.extractBuffer` via `maxTotalSize: 50 * 1024 * 1024`. Rejects oversized archives and zip bombs with `Archive security violation`. | Antigravity (`@du/document-kit`) |
| **Max Page Count** | 100 pages per document | **`[TARGET / UNENFORCED]`** | Design assumption for multi-page PDF processing. Current `PdfParser` and `PdfSplitter` parse without a page count rejection ceiling. | Antigravity (`@du/document-kit` / `@du/document-core`) |
| **Max Spreadsheet Rows** | 50,000 rows | **`[TARGET / UNENFORCED]`** | Design assumption. Current `ExcelParser` does not stream or truncate rows beyond 50,000; processes full worksheet into memory. | Antigravity (`@du/document-kit`) |
| **Max Artifact Storage** | 20 MB per output artifact | **`[TARGET / UNENFORCED]`** | Design assumption. Neither Orchestrator artifact storage route nor worker `TaskContext` enforces an output artifact ceiling. | Platform (Orchestrator) |
| **Max JSON Schema Depth** | 5 levels | **`[IMPLEMENTED]`** | Enforced deterministically in `SchemaValidator.validateCustomSchema` (`MAX_DEPTH = 5`). Validated in `InputNormalizer.normalizeExtract` and `extract` action. Rejects deeper schemas with `SCHEMA_DEPTH_EXCEEDED` and forbidden network `$ref` with `FORBIDDEN_SCHEMA_REF`. Verified in `tests/bounded-input.test.ts`. | Antigravity (`@du/document-core`) |

### Business Parser Call Site Configuration Gap
Currently, `@du/document-core` action handlers (`ingest`, `extract`, `analyze`, `transform`, `generate`, `compare`) call `defaultParserFactory.parseBuffer(buf, name)` without options. Task inputs and profile configuration schemas in `@du/contracts` currently lack parser budget fields (such as `maxBufferSizeBytes` or `timeoutMs`). We report this configuration gap explicitly rather than inventing arbitrary hardcoded defaults in business code.

---

## 3. Workload Action Mix & Concurrency Assumptions

Design assumptions for sizing local queue workers and database connection pools:

| Action | Estimated Workload Share | Processing Nature | Primary Resource Bottleneck |
|---|---|---|---|
| **Extract** | 40% | Mixed (native parse + LLM reasoning) | Connector upstream latency, LLM rate limits |
| **Analyze** | 25% | Mixed (native parse + LLM reasoning) | Upstream inference token budget |
| **Ingest** | 15% | CPU-bound (native parsing / OCR) | Worker CPU, local file buffer I/O |
| **Generate** | 10% | Network-bound (LLM generation) | Upstream output token streaming |
| **Transform** | 5% | Mixed (local regex / PII / LLM) | Regex compute, translation API latency |
| **Compare** | 5% | Memory & CPU-bound (diff engine) | Diff matrix memory allocation |

---

## 4. Latency, Timeout & Fencing Assumptions

| Mechanism | Configuration Baseline | Status | Purpose & Behavioral Contract | Owner |
|---|---|---|---|---|
| **Mock Provider Latency** | $\approx 20\text{--}50\text{ ms}$ | **`[BENCHMARK]`** | Benchmark execution speed in unit and E2E integration test suites. | All |
| **Provider HTTP Timeout** | 30 seconds (configurable up to 120s) | **`[IMPLEMENTED]`** | Prevents worker from hanging indefinitely on stalled upstream provider; triggers `PROVIDER_TIMEOUT`. | Platform (Connector) |
| **Worker Task Heartbeat** | Every 2,000 ms (test) / 5,000 ms (prod) | **`[IMPLEMENTED]`** | Worker sends lease extension; detects lease revocation or operation cancel. | SDK & Orchestrator |
| **Worker Lease TTL** | 15 seconds (test) / 30 seconds (prod) | **`[IMPLEMENTED]`** | Stale worker lease expires if heartbeat missed; enables task reassignment. | Platform (Orchestrator) |
| **Total Task Deadline** | 300 seconds (5 minutes) | **`[TARGET / UNENFORCED]`** | Design assumption. BullMQ job timeout is configurable, but global hard task termination deadline is not yet enforced. | Platform (Orchestrator) |
| **Parser Wait Timeout** | Per-call budget (via `ParserOptions.timeoutMs`) | **`[IMPLEMENTED (WAIT REJECTION ONLY)]`** | Rejects caller wait Promise via `Promise.race`. Does NOT preemptively interrupt synchronous CPU work. Preemptive cancellation requires worker process isolation. | Antigravity (`@du/document-kit`) |

---

## 5. Artifact Retention & Storage Assumptions

1. **Intermediate Artifacts**:
   - Baseline assumption: **7 days** retention for intermediate files (split pages, preprocessed text).
   - **Current Status: `[PROPOSED TARGET / UNENFORCED]`**. There is currently NO automated retention cleanup sweep, TTL worker, or cron job running in Orchestrator. Unreferenced files persist in storage indefinitely until manual intervention.
   - Owner: Platform (Orchestrator).
2. **Terminal Result Artifacts**:
   - Baseline assumption: **30 days** retention for final `ResultEnvelope` artifacts referenced by `operations.result_ref`.
   - **Current Status: `[PROPOSED TARGET / UNENFORCED]`**. No automated cleanup sweep exists. Output artifacts remain in storage indefinitely.
   - Owner: Platform (Orchestrator).
3. **Usage Events**:
   - Metered usage records (`usage_events` in PostgreSQL) are retained **indefinitely** for audit and billing reconciliation.
   - **Current Status: `[IMPLEMENTED STORAGE / NO PARTITIONING]`**. Records are permanently stored in DB; table partitioning and long-term cold archival are deferred.
   - Owner: Platform (Orchestrator).

---

## 6. Authentication & Tenant Fencing Assumptions

1. **Tenant Isolation**:
   - Schema baseline: All database records (`operations`, `tasks`, `artifacts`, `usage_events`, `api_keys`) contain `tenant_id`.
   - **Current Status: `[PARTIAL / ONGOING ENFORCEMENT]`**. Active runtime queries filter by `tenant_id`, and package boundary tests verify workers cannot access DB directly. However, row-level security (RLS) policies and comprehensive tenant penetration tests are ongoing platform work (Claude lane).
   - Owner: Platform (Claude lane).
2. **Key-to-Profile Binding**:
   - API keys map to a tenant. `profile_bindings` stores immutable revisions for each key, business/version/action and connector slot pin map; a key can have multiple bindings across actions.
   - **Current Status: `[IMPLEMENTED SOURCE / LIVE VERIFICATION SEPARATE]`**. Orchestrator resolves the matching binding before submission, stores `profile_id`, revision and connector pins on the operation, and rejects an unbound action when the key is in profile mode. See [`profiles.ts`](../../../services/orchestrator/src/modules/profiles/profiles.ts) and [`submission.ts`](../../../services/orchestrator/src/modules/operations/submission.ts). Source implementation alone does not establish live multi-service acceptance.
   - Owner: Platform.
3. **Credential Separation**:
   - Runtime workers operate with zero database credentials and zero storage secret keys.
   - Connector credentials (provider API keys) are stored encrypted via AES-256-GCM in `secret_versions` and are never returned to clients or workers.
   - **Current Status: `[IMPLEMENTED]`**. Enforced by worker boundary tests (`tests/package-boundary.test.ts`).
   - Owner: Platform & Antigravity.
