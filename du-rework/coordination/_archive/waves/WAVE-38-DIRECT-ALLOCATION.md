# Wave 38 Direct Multi-Lane Allocation (2026-09-23 01:40 +07:00)

**Coordinator**: Antigravity (agent-1)
**Policy**: Direct dispatch via Orca CLI. Codex joined as the fifth active lane at `term_95378d30-e4fc-40f1-bc0c-e6256a71be91` for offline P0 work.

## Wave 37 Closeout Summary

| Lane | Agent | Result |
|---|---|---|
| W37-C | Claude Code | ✅ P2-06 COMPLETE — RUN-05/06/07 composite real-DB (runtime 86/86→new count, tsc 0 errors, DB RELEASED) |
| W37-O | OpenClaude | ❌ INCOMPLETE — terminal disconnected, P6-05 not delivered |
| W37-CC | Command Code | ✅ W37-CC COMPLETE — HITL Resume/Pause Card, 13/13 PASS (141 tests), 0 tsc errors |
| W37-A6 | Agent-6 | ✅ P6-02 COMPLETE — Business Registry view models, 54/54 PASS, 256 admin regression PASS, DB RELEASED |

---

## Open Task Backlog (post-W37)

| Priority | Task | Phase | Unblocked By |
|---|---|---|---|
| 🔴 P1 | **P6-05** API Key view models (retry — OpenClaude missed) | P6 | P6-03 ✅ |
| 🔴 P1 | **P2-07** Invocation grants, connector proxy, usage ingestion | P2 | P2-05/06 ✅ |
| 🔴 P1 | **P2-02** Auth/key/profile/registry services & handlers | P2 | P2-01 ✅ |
| 🟡 P2 | **P4-04** Fan-out/HITL/streaming hash/temp cleanup SDK | P4 | P4-01..03 ✅ |
| 🟡 P2 | **P6-07** Usage/audit/operational overview view models | P6 | P6-02..06 (P6-04/05 still open) |
| 🟡 P2 | **P8-02** Transaction boundary fault suite | P8 | P8-01 ✅; needs live DB |
| 🟡 P2 | **P8-04** Auth/tenant/SSRF/file/schema/secret security suite | P8 | P8-01 ✅; needs live DB |
| 🟢 P3 | **P0** spec accuracy corrections (P0-01/03/05/06) | P0 | Offline docs |
| 🟢 P3 | **P2-09** full OPS-07 acceptance (health endpoint + graceful shutdown) | P2 | P2-09 slice done |

---

## 1. Packet W38-C — Claude Code (Platform Lane)

- **Target**: `term_07f2c54d-17bd-4f8b-ac7d-793f5ef127fd`
- **Objective**: Complete **P2-07** — Invocation grants, connector management proxy, usage ingestion/projection.
- **Owned Files**:
  - `du-rework/services/orchestrator/src/modules/grants/` (existing or new)
  - `du-rework/services/orchestrator/src/modules/usage/` (existing or new)
  - `du-rework/services/orchestrator/tests/runtime.test.ts` or new `tests/grants.test.ts`
  - `du-rework/tasks/P2-orchestrator.md` (tick P2-07 `[x]`)
  - `du-rework/coordination/reports/claude.md`
- **Requirements**:
  1. **Grant binding** (USE-01): invocation grant scoped to `(tenantId, businessId, connectorSlot)` — verifies business has active profile with that slot declared; fails closed with 403 PERMISSION_DENIED if not.
  2. **Connector proxy** (CON-03): `GET /api/v1/connectors/:id/test` proxies to connector health check; strips internal headers; surfaces sanitized error.
  3. **Usage ingestion** (USE-01/02): `ingestUsage(operationId, usage)` persists usage row; dedup by `(operationId, provider)` with `ON CONFLICT DO NOTHING`; no double-counting.
  4. **Usage projection**: `getUsageSummary(tenantId, from, to)` aggregates by provider/model.
  5. All new cases backed by real-DB tests.
  6. `pnpm --filter @du/orchestrator exec tsc --noEmit`: 0 errors.
  7. Hold `:5433`/`:6380` during test run, release immediately after. Report DB RELEASED.
- **Boundaries**: Zero edits to `src/app/**`, `app/workflow-builder/**`, `businesses/**`. No commit/push/reset.

---

## 2. Packet W38-O — OpenClaude (Retry P6-05)

- **Target**: `term_9c7399c9-5382-45cd-8687-7d3467983f23`
- **Objective**: Retry **P6-05** — API Key create/copy-once/revoke & assignment pure view models (missed in W37-O due to disconnect).
- **Owned Files**:
  - `du-rework/services/orchestrator/src/app/admin/api-key-view-models.ts` (NEW)
  - `du-rework/services/orchestrator/tests/admin-api-key-view-model.test.ts` (NEW)
  - `du-rework/services/orchestrator/src/app/admin/index.ts` (add re-export)
  - `du-rework/tasks/P6-admin.md` (tick P6-05 `[x]`)
  - `du-rework/coordination/reports/openclaude.md`
- **Requirements**:
  1. `buildApiKeyCreateView(key)`: one-time raw key view — raw key accepted as input but NEVER stored in returned model; show only masked hint (`key.slice(0,4) + '…'`).
  2. `buildApiKeyListView(rows)`: list projection — no raw key in any row, masked hint + metadata only.
  3. `canRevokeApiKey(key)`: true when key is active and not currently revoking.
  4. `buildApiKeyRevokeConfirm(key)`: confirmation model with key ID + masked hint only.
  5. `buildApiKeyAssignmentView(key, grants)`: maps grant list to display model.
  6. All types strict TypeScript (no `any`). Table-driven unit tests. Full orchestrator suite green.
  7. `pnpm --filter @du/orchestrator exec tsc --noEmit`: 0 errors.
- **Boundaries**: Zero DB/Redis (pure offline). Zero edits to server.ts/runtime/Workflow Builder. DB window stays RELEASED. No commit/push/reset.

---

## 3. Packet W38-CC — Command Code (Coding Lane)

- **Target**: `term_1efb716a-eb20-40f8-8954-8ba31c53677e`
- **Note**: Rate limit resets in ~2 minutes from 01:36. Wait for reset before starting.
- **Objective**: Implement **P4-04** — Fan-out/HITL/streaming, hash/temp cleanup SDK extensions in `@du/worker-sdk`.
- **Owned Files**:
  - `du-rework/packages/worker-sdk/src/` (existing SDK)
  - `du-rework/packages/worker-sdk/tests/` (new test cases)
  - `du-rework/tasks/P4-worker-sdk.md` (tick P4-04 `[x]`)
  - `du-rework/coordination/reports/command-code.md`
- **Requirements**:
  1. `spawnChild(ctx, input)`: typed helper that calls `POST /api/runtime/v1/tasks/:id/children`; returns `ChildHandle` with `childTaskId`.
  2. `waitForChildren(ctx, handles)`: polls children until all terminal; respects `concurrency=1`.
  3. `uploadArtifact(ctx, buffer, options)`: staged upload with SHA-256 hash verification; temp file cleanup on failure.
  4. `streamResult(ctx, stream)`: streaming-compatible result write that flushes in chunks without buffering the entire result in memory.
  5. Unit tests using mock boundaries (no real DB/HTTP needed — mock the fetcher).
  6. `pnpm --filter @du/worker-sdk exec tsc --noEmit`: 0 errors.
  7. `pnpm --filter @du/worker-sdk test`: all PASS.
- **Boundaries**: Zero edits to `services/orchestrator/**`, `app/workflow-builder/**`, `du-rework/businesses/**`. Zero DB/Redis. No commit/push/reset.

---

## 4. Packet W38-A6 — Agent-6 Antigravity (Verification / Quality Lane)

- **Target**: `term_47a1d44b-6e1c-4e59-af80-d4553b927d85`
- **Objective**: Complete **P2-09 full OPS-07 acceptance** — Health endpoint integration + graceful shutdown during active lease recovery.
- **Note**: This is the *full* OPS-07 closeout. The slice (sweepExpiredLeases + heartbeat + background timer) was done in W30-C. What remains:
  - Health endpoint: `GET /api/v1/health` returning `{ status: 'ok'|'degraded', db: bool, redis: bool, activeLeases: number }`.
  - Graceful shutdown: when `close()` is called while leases are active, wait for in-flight workers to complete or timeout (default 30s) before exiting.
- **Owned Files**:
  - `du-rework/services/orchestrator/src/server.ts` (add health route + shutdown grace period)
  - `du-rework/services/orchestrator/src/modules/runtime/runtime.ts` (add graceful drain)
  - `du-rework/services/orchestrator/tests/runtime.test.ts` (add health + shutdown tests)
  - `du-rework/tasks/P2-orchestrator.md` (change P2-09 from `[~]` to `[x]`)
  - `du-rework/coordination/reports/antigravity-6.md` (append W38-A6 entry)
- **Requirements**:
  1. `GET /health` returns JSON shape above; `db` checks DB connectivity with a quick ping; `redis` checks Redis ping; `activeLeases` = count of RUNNING tasks.
  2. `close()` calls drain: stops accepting new claims, waits up to 30s for RUNNING leases to complete (polls every 500ms), then force-closes.
  3. Real-DB tests: health endpoint up/degraded, shutdown with active lease waits for completion, shutdown timeout force-closes.
  4. `pnpm --filter @du/orchestrator exec tsc --noEmit`: 0 errors.
  5. Full orchestrator suite PASS.
  6. Hold `:5433`/`:6380` during test run, release immediately. Report DB RELEASED in `antigravity-6.md`.
- **Boundaries**: Zero edits to `src/app/**`, `app/workflow-builder/**`, `businesses/**`, `profile-view-models.ts`, `operation-view-models.ts`, `business-view-models.ts`. No commit/push/reset.

---

## 5. Packet W38-CX — Codex (Requirements / Traceability Lane)

- **Target**: `term_95378d30-e4fc-40f1-bc0c-e6256a71be91`
- **Objective**: Complete **P0-01** — requirements traceability BR-01..12 → use cases → executable test IDs, including the actor/authorization matrix.
- **Owned Files**:
  - `du-rework/businesses/document-core/docs/traceability-matrix.md`
  - `du-rework/docs/01-product-scope.md` (only authorization/actor corrections required by P0-01)
  - `du-rework/tasks/P0-business-specs.md` (tick P0-01 only when every acceptance item is evidenced)
  - `du-rework/coordination/reports/codex.md` (new lane report)
- **Requirements**:
  1. Audit BR-01..12 against the six action BRDs, current manifests, and actual test names; do not invent missing evidence.
  2. Map every BR to at least one use case and concrete test ID/path, or mark the exact gap and leave P0-01 unchecked.
  3. Add an actor/authorization matrix covering tenant caller, admin/operator, runtime worker, and connector boundaries with fail-closed expectations.
  4. Correct stale UC/BR references found during the audit, but do not change runtime behavior or broaden scope into P0-03/05/06.
  5. Verify all referenced test paths and test names exist with `rg`; run only focused existing document-core traceability/manifest tests if the package supports them.
  6. Report files changed, commands/results, unresolved gaps, and whether P0-01 can honestly become `[x]`.
- **Boundaries**: Documentation/task/report lane only. Zero edits to implementation source, test source, lockfiles, root app, or other agents' reports. Zero DB/Redis. No commit/push/reset.

---

## 6. DB Window Protocol (Wave 38)

| Agent | DB Needed | Policy |
|---|---|---|
| Claude Code (W38-C) | ✅ Yes | Acquire FIRST; release before Agent-6 starts |
| OpenClaude (W38-O) | ❌ No | RELEASED throughout |
| Command Code (W38-CC) | ❌ No | RELEASED throughout |
| Agent-6 (W38-A6) | ✅ Yes | Acquire AFTER Claude Code releases |
| Codex (W38-CX) | ❌ No | Offline documentation audit; RELEASED throughout |

**Serial order**: Claude Code → Agent-6. Both must report `DB RELEASED` in their reports.

---

## 7. Wave 38 Success Criteria

- [ ] W38-C: P2-07 `[x]`, real-DB grants/usage tests PASS, DB RELEASED
- [ ] W38-O: P6-05 `[x]`, orchestrator suite PASS, 0 tsc errors, DB RELEASED
- [ ] W38-CC: P4-04 `[x]`, worker-sdk suite PASS, 0 tsc errors
- [ ] W38-A6: P2-09 `[x]` (from `[~]`), health+shutdown tests PASS, DB RELEASED
- [ ] W38-CX: P0-01 traceability/authorization audit complete, focused evidence verified, honest checkbox decision recorded
