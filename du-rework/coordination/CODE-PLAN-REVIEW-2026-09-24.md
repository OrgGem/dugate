# DU rework code/plan review — 2026-09-24

Scope: current working tree in `du-rework/`, compared with docs 04/06/08/09/12 and P2–P8 acceptance. This is a source review of a shared, uncommitted checkout. No product code was changed and no live PostgreSQL/Redis suite was run. Historical test results below are cited as existing evidence, not a new run. Recheck each finding against the source when its fix starts.

**Assessment: not plan-conformant and not release-ready.** The 2026-09-23 [plan mismatches](PLAN-CODE-CONFORMANCE-2026-09-23.md) and [code findings](CODE-REVIEW-2026-09-23.md) remain the parent backlog. This note records two additional findings in [follow-up tasks](../tasks/REVIEW-FIXES-2026-09-24.md) and refreshes the most consequential still-visible gaps without creating duplicate implementation ownership.

## New findings

### R24-01 — High: cross-tenant long-poll checks ownership after waiting

`services/orchestrator/src/server.ts:666-677` calls `waitForTerminal()` before comparing `op.tenant_id` with the caller's tenant. `modules/runtime/runtime.ts:846-850` fetches the operation by ID alone; `modules/operations/facade.ts:72-91` then polls it for up to 30 seconds. A caller with a known foreign operation ID receives an immediate 404 for a terminal operation but a delayed 404 for a running one, exposing state through timing and consuming a request/DB polling capacity for an inaccessible resource. The existing cross-tenant lookup test in `tests/integration/p8-04-security-isolation.integration.test.ts:236` exercises the route without `?wait=` and cannot detect this.

Fix task: scope the initial read by tenant before entering long-poll, and keep each subsequent read tenant-scoped. Add real HTTP tests for foreign active/terminal IDs with `?wait=30`, confirming prompt 404 and no repeated reads; preserve authorized long-poll behavior. Parent: P2-08/P8-04, public API rule in docs 06 (inaccessible objects return 404 without leaking existence).

### R24-02 — Medium: main multi-container E2E still rewrites artifact responses

The server now emits raw blob bytes (`services/orchestrator/src/server.ts:245-252,505-506`), and the focused artifact-stream integration reports a raw-byte pass in `docs/35-acceptance-baseline.md`. However, `businesses/document-core/tests/multi-container-e2e.integration.test.ts:281-306` still replaces global `fetch` and base64-decodes successful blob GET responses. For JSON blobs it can issue a second GET; for non-JSON binary blobs it can transform already-raw bytes. The same test accepts base64 fallback at lines 683-690 and 851-859. Its opening comment calls the run “unshimmed,” so the test currently overstates production-path evidence. The latest acceptance table also records 3 failing cases in this suite; this review does not assign those failures to the shim without a rerun.

Fix task: remove the blob rewrite and base64 fallback, assert exact wire bytes/hash and native result parsing, then rerun the complete multi-container suite against rebuilt packages. Keep the separate provider mock only. Parent: FIX-CR-13, P4-08/P5-10/G4.

## Existing findings still visible in current source

| Priority | Existing ID / parent | Current source evidence | Required fix evidence |
|---|---|---|---|
| High | MM-01; P3/P4/P5 | `packages/worker-sdk/src/connector-invoker.ts:55-62` sends no service identity, while production Connector verifies identity. | Shipped document-core worker authenticates to the production verifier; wrong/missing identity is denied. |
| High | MM-02 + CR-12; P2/P5 | `modules/operations/submission.ts:99-104,153-180` hashes top-level `artifacts`/`output` but persists only `input`; `server.ts:689-701` returns a `resultRef` with no public artifact download. | Public-key-only upload → submit → process → result/download, including artifact ownership and hash checks. |
| High | MM-03 + CR-05; P2/P6 | `submission.ts:73-81` resolves global active version before profile binding and before idempotency replay; `runtime.ts:1006,1014` still uses a slice digest and empty prompt revisions. | A pinned v1 request/replay survives v2 activation; resolved locks, limits, prompts and schema digest are immutable. |
| High | MM-05; P2-09/P8-02 | `modules/queue/dispatcher.ts:32` selects only undispatched outbox rows; `runtime.ts:757-839` recovers only expired RUNNING leases. | Redis loss after dispatch but before claim reconstructs READY jobs without duplicate effects. |
| High | MM-06/07/08; P3-05/P8-03 | `services/connector/src/invoke.ts:42-59` has no due-PENDING poll and lets IN_FLIGHT/CANCELLED replay fall through; `services.ts:79` partitions quota by tenant/revision; `invoke.ts:69,80` uses a fixed lease/full timeout. | Live async provider convergence after restart, no redispatch on replay, and shared-account quota/deadline tests across tenants. |
| High | CR-01/02; P2-08/P8-04 | `modules/webhooks/webhooks.ts:156-182` sends tenant callback URLs with no destination/redirect policy or network deadline while holding a DB transaction. | Block private/redirect targets and prove stalled receivers cannot pin pool or shutdown. |
| High | CR-06/12; P2-03/P2-05 | `runtime.ts:137-143,153-174` fences by epoch without checking live RUNNING lease/state; `modules/artifacts/artifacts.ts:95-100,131-136` trusts finalize metadata and allows blob overwrite. | Same-epoch cancel/expiry fencing plus grant expiry/mode, stored-byte hash and finalized immutability tests. |
| High | MM-12; P8-06 | `services/orchestrator/package.json` starts `dist/server.js`, but `src/server.ts` only exports `createApp` and does not bootstrap a listener. | Clean packaged start, readiness, migration, shutdown and restore drill. |
| Medium | MM-04/11/13; P1/P2 | `server.ts:659` always returns `nextCursor:null`; `facade.ts:36-53` drops wait/tenant details; isolation and OpenAPI parity remain disputed in prior review. | Public HITL/progress/pagination, real producer/schema examples, and two naturally isolated default runs. |

## Acceptance and sequencing

1. Treat the table as references to the existing [MM fix tasks](../tasks/PLAN-MISMATCH-FIXES-2026-09-23.md) and [CR fix tasks](../tasks/REVIEW-FIXES-2026-09-23.md). R24-01 and R24-02 are the only newly numbered fixes here; no phase checkbox is changed by this review.
2. Fix the public document path and production Connector authentication before interpreting six-action or provider slice passes as full E2E. Then close durable recovery, security/fencing, profile and UI flows, and finally deployment/load gates.
3. `docs/35-acceptance-baseline.md` records 104 suites, with the multi-container suite at 10 pass / 3 fail and the P4-08 consumer suite at 1 fail. These are explicit open acceptance gates; successful offline suites cannot replace them. Some adjacent evidence documents contain older counts, so use per-suite exit codes from a fresh run when closing tasks.
