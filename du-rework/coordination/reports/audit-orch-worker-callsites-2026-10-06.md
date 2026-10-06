# AUDIT-ORCH-WORKER-CALLSITES - receipt (read-only coupling audit)

> **RESUME POINT (qwen_5, 2026-10-06)** - task AUDIT-ORCH-WORKER-CALLSITES (task_eecffd5d4c4d),
> dispatch ctx_91b20452d2d8. **READ-ONLY: 0 source edits, 0 commits, no ticks.**
> Method: `findstr /s /n` over `services/orchestrator/src` + `type` vs value import classification.
>
---

## 1. Headline: the real leak is RUNTIME, not types

**3 files import from `@du/worker-sdk`. Only one is type-only.**

| File | Line | Import | Kind |
|---|---|---|---|
| `modules/operations/acquisition-ref-resolver.ts` | 1 | `import type { SdkFetcher }` | **type-only** |
| `modules/operations/ingestion-storage-s3.ts` | 4 | `SourceIngestionError` + `PinnedSourceStorage`, `PinnedSourceWrite`, `SourceIngestionReceipt` | **VALUE** (runtime error class) |
| `modules/operations/ingestion-consumer.ts` | 12 | `createIngestionTaskHandler`, `createSourceAcquisitionIngestor`, `SourceAcquisitionError`, `SourceIngestionError` + 3 types | **VALUE** (worker loop entry points) |

**This is the MIG-00 / RPK-01 signal.** The orchestrator is importing the **worker loop** module
(`createIngestionTaskHandler`, `createSourceAcquisitionIngestor`) as a runtime dependency. That is server
code depending on the worker loop - exactly the coupling the redistribution is meant to remove.

## 2. Full inventory

| Package | Declared | Import sites | Value imports |
|---|---|---:|---:|
| `@du/contracts` | `workspace:*` | **75** | yes (schemas, enums, error codes) |
| `@du/observability` | `workspace:*` | **12** | yes (`createLogger`, `normalizeCorrelationId`, `InMemoryMetricsRegistry`, `safeErrorForLog`) |
| `@du/egress` | `workspace:*` | **2** | yes (`createPinnedFetch`) |
| `@du/worker-sdk` | `workspace:*` | **3** | **2 of 3** |
| `@du/document-kit` | not declared | **0** | - |
| `@du/connector-client` | not declared | **0** | - |

**`@du/document-kit` and `@du/connector-client` are NOT imported by the orchestrator at all** - they are
worker-side only, which is the correct direction.

## 3. Coupling leak points, ranked

| # | Leak | Evidence | Why it matters |
|---|---|---|---|
| L1 | **Orchestrator imports worker loop entry points** | `ingestion-consumer.ts:12` imports `createIngestionTaskHandler` + `createSourceAcquisitionIngestor` | Server depends on worker loop. RPK-05 must make the worker runtime self-contained; this import is the thing to break |
| L2 | **Orchestrator imports worker runtime error classes** | `ingestion-storage-s3.ts:4` imports `SourceIngestionError` | Server catches worker-defined errors. Acceptable short-term, but the error type should live in contracts |
| L3 | **Orchestrator imports `@du/egress` at runtime** | `ingestion-consumer.ts:3`, `webhooks/webhooks.ts:3` both call `createPinnedFetch` | Egress is a worker-side concern (pinned fetch, DNS adjudication). Server should not need it |
| L4 | **75 contracts references** | across `http/`, `modules/`, `compat/` | **Sanctioned, not a leak** - RPK-02/RPK-03 move contract authority TO the orchestrator. Recorded so nobody "fixes" it |

## 4. What is NOT a leak

- **`@du/contracts` (75 refs)** - the plan explicitly moves contract authority to the orchestrator
  (`SHARED-PACKAGES-REDISTRIBUTION` §3, RPK-02/RPK-03). This is the intended direction.
- **`@du/observability` (12 refs)** - logger/metrics are cross-cutting and already shared by design.
- **`@du/document-kit`, `@du/connector-client` (0 refs)** - correctly worker-side only.
- **`acquisition-ref-resolver.ts:1`** - `import type` only, erased at compile time. No runtime coupling.

## 5. MISMATCH report (file:line, expected, actual)

| # | file:line | Expected | Actual |
|---|---|---|---|
| M1 | `ingestion-consumer.ts:12` | orchestrator should not import worker loop | imports `createIngestionTaskHandler`, `createSourceAcquisitionIngestor` as values |
| M2 | `ingestion-storage-s3.ts:4` | error types should live in contracts | imports `SourceIngestionError` from worker-sdk |
| M3 | `ingestion-consumer.ts:3`, `webhooks.ts:3` | egress is worker-side | both call `createPinnedFetch` at runtime |

## 6. Recommendation for RPK-01 (not acted on)

1. **Break L1 first.** The worker loop entry points should not be importable from the server. Either
   move the ingestion orchestration into the orchestrator (it is server-side coordination) or define a
   contracts-level port the worker implements.
2. **Move worker error classes to contracts** (L2) so the server catches a contract type, not a worker type.
3. **Reconsider `@du/egress` in the server** (L3) - pinned fetch is a worker concern; the server should
   not need DNS adjudication.
4. **Do not touch the 75 contracts references** - that is the sanctioned direction.

## 7. Ledger

- AUDIT-ORCH-WORKER-CALLSITES - Muc 1 - read-only coupling audit: 3 worker-sdk import sites (1 type-only,
  2 value), 75 contracts refs (sanctioned), 12 observability, 2 egress, 0 document-kit / connector-client;
  ranked L1-L4 with the worker-loop import as the primary MIG-00/RPK-01 signal; 3 mismatches in the
  file:line/expected/actual format. No source edit, no commit, no tick.
