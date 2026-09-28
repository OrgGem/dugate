# Wave 37 Direct Multi-Lane Allocation (2026-09-22 23:55 +07:00)

**Coordinator**: Antigravity (agent-1, current session — coordinating only this wave)
**Policy**: ChatGPT Codex bypassed (quota). Direct allocation to active agents.
**Agent-6**: New Antigravity terminal added to roster this wave.

> **Note on Agent-6 status**: Agent-6 is a new Antigravity instance. Its report file
> (`coordination/reports/antigravity-6.md`) has not yet been created, so it is assumed
> FRESH / IDLE with no prior wave assignment. Agent-6 should be treated as offline-capable
> only; do NOT assign shared-DB tasks until it confirms RELEASED status.

---

## 1. Agent Roster & Current Status

| Agent | Role | Last Wave | DB Window | Status |
|---|---|---|---|---|
| **Agent-1** Antigravity | Verification / Quality Lane | W36-A (P6-06 ✅) | RELEASED | **IDLE** — coordinating this wave only |
| **Agent-2** Claude Code | Platform Lane | W36-C (P2-08 ✅) | RELEASED | **IDLE** |
| **Agent-3** OpenClaude | Coding Lane | W31-O (P6-04 headless ✅) | RELEASED | **IDLE** |
| **Agent-4** Command Code | Coding Lane | W34-CC (Run Engine Toggle ✅) | RELEASED | **IDLE** |
| **Agent-6** Antigravity (NEW) | Verification / Quality Lane | — (fresh) | RELEASED (assumed) | **IDLE / FRESH** |

---

## 2. Open Task Backlog (Priority Order)

| Priority | Task | Phase | Blocker |
|---|---|---|---|
| 🔴 P1 | P2-06 Children/join continuation, human wait/resume, deadline/cancel composite acceptance | P2 | P2-05 DONE ✅ → unblocked |
| 🔴 P1 | P2-07 Invocation grants, connector proxy, usage ingestion | P2 | P2-05 DONE ✅ → unblocked |
| 🟡 P2 | P6-02 Business registry/version/health UI view models | P6 | P6-01 dep (relaxed: headless-only allowed) |
| 🟡 P2 | P6-05 API key create/copy-once/revoke view models | P6 | P6-03 DONE ✅ → unblocked |
| 🟡 P2 | W36-CC HITL Resume & Pause Card (skipped in W36) | Workflow Builder | DB: none needed |
| 🟢 P3 | P8-02 Transaction boundary fault suite | P8 | P8-01 DONE ✅; requires live DB |
| 🟢 P3 | P8-04 Auth/tenant/SSRF security suite | P8 | P8-01 DONE ✅; requires live DB |

---

## 3. Packet W37-C — Claude Code (Platform Lane)

- **Target**: `term_07f2c54d-17bd-4f8b-ac7d-793f5ef127fd`
- **Objective**: Complete **P2-06** — Children/dependencies/join continuation, human wait/resume, deadline/cancel composite acceptance.
- **Owned Files**:
  - `du-rework/services/orchestrator/src/modules/runtime/runtime.ts` (existing — continuation routes)
  - `du-rework/services/orchestrator/tests/runtime.test.ts` (existing — add composite cases)
  - `du-rework/tasks/P2-orchestrator.md` (reconcile P2-06 `[x]`)
  - `du-rework/coordination/reports/claude.md`
- **Requirements**:
  1. Composite acceptance for **RUN-05** (fan-out children, exactly-once join reconciliation, concurrency=1 no deadlock).
  2. Composite acceptance for **RUN-06** (human wait lifecycle: open → answered/expired/cancelled, stale-CAS 409, duplicate resume 200 replay).
  3. Composite acceptance for **RUN-07** (deadline sweep closes open waits + terminal transition, cancel closes open waits, cancel-then-resume fails closed).
  4. All new cases backed by real-DB tests in `runtime.test.ts`.
  5. Verify `pnpm --filter @du/orchestrator exec tsc --noEmit`: 0 errors.
  6. Maintain strict DB window protocol: hold `:5433` during test run, release when done.
- **Boundaries**:
  - Zero edits to `src/app/**`, `src/modules/profiles/**`, `src/modules/webhooks/**`.
  - Do NOT touch Workflow Builder (`app/workflow-builder/**`).
  - No edits to `du-rework/businesses/**`.

---

## 4. Packet W37-O — OpenClaude (Coding Lane)

- **Target**: `term_851ead96-21db-4077-89bd-7cbdebeca435`
- **Objective**: Complete **P6-05** — API Key create/copy-once/revoke & assignment pure view models.
- **Owned Files**:
  - `du-rework/services/orchestrator/src/app/admin/api-key-view-models.ts` (NEW)
  - `du-rework/services/orchestrator/tests/admin-api-key-view-model.test.ts` (NEW)
  - `du-rework/services/orchestrator/src/app/admin/index.ts` (add re-export)
  - `du-rework/tasks/P6-admin.md` (reconcile P6-05 `[x]`)
  - `du-rework/coordination/reports/openclaude.md`
- **Requirements**:
  1. Implement pure functions:
     - `buildApiKeyCreateView(key)`: renders the one-time raw key view (copy-once window); raw key must be accepted as input but never stored in the returned model — only a masked hint (`key.slice(0,4) + '…'`).
     - `buildApiKeyListView(rows)`: list projection — no raw key in any row, only masked hint + metadata.
     - `canRevokeApiKey(key)`: true when key is active and not currently revoking.
     - `buildApiKeyRevokeConfirm(key)`: builds a confirmation model with key ID + masked hint only.
     - `buildApiKeyAssignmentView(key, grants)`: maps the grant list associated with a key into a display model.
  2. All types defined in `types.ts` or inline in the new file (no `any`).
  3. Unit tests: table-driven, copy-once semantics verified (raw key never in list row), revoke guard all states.
  4. `pnpm --filter @du/orchestrator exec tsc --noEmit`: 0 errors.
  5. Full orchestrator test suite still green.
- **Boundaries**:
  - Zero edits to `server.ts`, runtime modules, Workflow Builder.
  - Zero shared DB / Redis (pure offline view models).
  - Zero edits to Agent-1/Agent-6 owned files.

---

## 5. Packet W37-CC — Command Code (Coding Lane)

- **Target**: `term_2f2b02e1-edfe-40c4-9461-bc08dece869e`
- **Objective**: Implement **W36-CC (deferred)** — Workflow Builder Human-in-the-Loop (HITL) Resume & Pause Card integration.
- **Owned Files**:
  - `app/workflow-builder/du-operation-adapter.ts` (add `resumeDuOperation`)
  - `app/workflow-builder/page.tsx` (add HITL card in run modal)
  - `tests/workflow-builder/ui-integration.test.ts` (add resume dispatch cases)
  - `du-rework/coordination/reports/command-code.md`
- **Requirements**:
  1. In `du-operation-adapter.ts`, add typed `resumeDuOperation(operationId, payload, fetcher?)`:
     - Calls `POST /api/v1/operations/${id}/resume` with JSON body.
     - Returns typed `DuResumeOutcome = { ok: true; state: string } | { ok: false; conflict: boolean; message: string }`.
  2. In `page.tsx`:
     - When an operation is polled and reaches `WAITING_INPUT`, show a dedicated HITL card inside the run modal.
     - Provide a textarea/JSON field for the user to review/update extracted data.
     - Provide button "Xác nhận & Tiếp tục (Resume)" calling `resumeDuOperation`, then resume polling to terminal.
     - On 409 Conflict: display inline CAS conflict error without crashing.
  3. New test cases in `ui-integration.test.ts`:
     - Resume dispatch to correct URL with payload.
     - CAS conflict (409) shows error, does not close modal.
     - Error toast on network failure.
  4. All `tests/workflow-builder` suites PASS; scoped typecheck 0 errors.
- **Boundaries**:
  - Zero edits to `du-rework/**`.
  - Zero edits to `worker.ts` or `lib/pipelines/**`.
  - Zero shared DB / Redis activity.

---

## 6. Packet W37-A6 — Agent-6 Antigravity (Verification / Quality Lane — FRESH)

- **Target**: New Antigravity terminal (agent-6)
- **Objective**: Implement **P6-02** — Business Registry/Version/Health UI pure view models.
- **Owned Files**:
  - `du-rework/services/orchestrator/src/app/admin/business-view-models.ts` (NEW)
  - `du-rework/services/orchestrator/tests/admin-business-view-model.test.ts` (NEW)
  - `du-rework/services/orchestrator/src/app/admin/index.ts` (add re-export)
  - `du-rework/tasks/P6-admin.md` (reconcile P6-02 `[x]`)
  - `du-rework/coordination/reports/antigravity-6.md` (NEW — create this file)
- **Requirements**:
  1. Implement pure functions in `business-view-models.ts`:
     - `buildBusinessVersionListView(versions)`: maps version rows to display rows with state badge (`REGISTERED_DISABLED`, `ENABLED`, `DRAINING`, `RETIRED`), health indicator (`healthy`, `no-active`, `draining`, `retired`), and worker heartbeat status.
     - `buildBusinessVersionStatusBadge(state)`: returns `{ state, label, badge: 'success'|'warning'|'error'|'neutral'|'info' }`.
     - `canEnableVersion(state)`: true for `REGISTERED_DISABLED`.
     - `canDrainVersion(state)`: true for `ENABLED`.
     - `canRetireVersion(state)`: true for `DRAINING`.
     - `buildVersionTransitionConfirm(version, action)`: builds confirmation model for enable/drain/retire.
     - `buildBusinessHealthView(versions, activeVersion)`: summarizes overall business health from version list.
  2. All types strict TypeScript (no `any`), defined inline or added to `types.ts`.
  3. Unit tests: table-driven, all 4 `BusinessStatus` states covered, all guard functions, health view aggregation.
  4. `pnpm --filter @du/orchestrator exec tsc --noEmit`: 0 errors.
  5. Full orchestrator suite still green.
  6. Create `du-rework/coordination/reports/antigravity-6.md` with wave report on completion.
- **Boundaries**:
  - Zero DB / Redis (pure offline view models).
  - Zero edits to `server.ts`, runtime modules, Workflow Builder.
  - Zero edits to Agent-1's files (`profile-view-models.ts`, `operation-view-models.ts`).
  - Do NOT edit `businesses/**` or `services/connector/**`.
  - Report results in `coordination/reports/antigravity-6.md` (NOT `antigravity.md` — that is Agent-1's file).

---

## 7. DB Window Protocol

| Agent | DB Access Needed | Policy |
|---|---|---|
| Agent-1 (Antigravity) | ❌ None | Window stays RELEASED |
| Agent-2 (Claude Code) | ✅ Yes — `:5433`/`:6380` | Acquire before test, release immediately after |
| Agent-3 (OpenClaude) | ❌ None | Window stays RELEASED |
| Agent-4 (Command Code) | ❌ None | Window stays RELEASED |
| Agent-6 (Antigravity new) | ❌ None | Window stays RELEASED |

**Serial DB policy**: Only one agent holds the DB window at a time. Agent-2 (Claude Code) has exclusive access during W37-C test runs. All others proceed offline.

---

## 8. Success Criteria for Wave 37 Closeout

- [ ] W37-C: P2-06 `[x]` in `tasks/P2-orchestrator.md`, real-DB runtime suite PASS, DB RELEASED
- [ ] W37-O: P6-05 `[x]` in `tasks/P6-admin.md`, orchestrator suite PASS, 0 tsc errors
- [ ] W37-CC: `tests/workflow-builder` all suites PASS, scoped typecheck 0 errors
- [ ] W37-A6: P6-02 `[x]` in `tasks/P6-admin.md`, orchestrator suite PASS, 0 tsc errors, `antigravity-6.md` created
