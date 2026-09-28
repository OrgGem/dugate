# Wave 32: Direct Multi-Lane Allocation (2026-09-22)

**Coordinator**: Antigravity Orchestrator Session (direct dispatch per user directive; ChatGPT Codex paused).

---

## Lane Assignments & Scope Boundaries

### W32-C — Claude Code (Platform Lane)
- **Target**: P2-08 Webhook Delivery Outbox & Callback Dispatch Slice (`services/orchestrator`).
- **Owned Files**:
  - `services/orchestrator/src/modules/lifecycle/**` or `services/orchestrator/src/modules/webhooks/**`
  - `services/orchestrator/src/db/migrations.ts` (if migration needed for `webhook_deliveries`)
  - `services/orchestrator/src/server.ts`
  - `services/orchestrator/tests/runtime.test.ts`
  - `du-rework/coordination/reports/claude.md`
- **Boundaries**: Do NOT edit `src/app/**` (OpenClaude lane), root workflow builder (Command Code lane), or `example-review` (Antigravity lane).
- **Requirements**:
  1. Review `docs/04-data-state.md` (`WebhookDelivery`, `Outbox`), `docs/06-public-api.md`, `docs/07-internal-api.md`.
  2. Implement terminal operation webhook scheduling: when an operation reaches terminal state (`SUCCEEDED`, `FAILED`, `CANCELLED`, `TIMED_OUT`), if submission included `callback.url` (or profile specifies callback policy), write a `webhook.dispatch` outbox row / `webhook_deliveries` row transactionally with the terminal transition.
  3. Implement webhook payload generation and HMAC-SHA256 signature header (`X-DU-Signature: sha256=<hex>` using tenant/system webhook secret).
  4. Implement webhook dispatcher helper with retry tracking (`attempts`, `next_at`, `status`).
  5. Add regression tests in `tests/runtime.test.ts`. Maintain serial DB window discipline and clean typecheck (0 errors).
- **Deliverables**: Report in `coordination/reports/claude.md`, tests passing, DB window RELEASED.

---

### W32-A — Antigravity (Verification Lane)
- **Target**: P7-07 Extension Developer Guide & Multi-Worker Onboarding Specification.
- **Owned Files**:
  - `du-rework/docs/16-extension-developer-guide.md`
  - `du-rework/tasks/P7-extension-proof.md`
  - `du-rework/coordination/reports/antigravity.md`
- **Boundaries**: Completely offline documentation and specification lane. Do NOT hold or modify shared DB/Redis. Do NOT edit Orchestrator platform code or Workflow Builder.
- **Requirements**:
  1. Author `du-rework/docs/16-extension-developer-guide.md` synthesizing all proven patterns from `businesses/example-review`, `@du/worker-sdk`, and the 10/10 PASS live P7-06 integration tests:
     - BusinessManifest v1 specification & JSON Schema validation.
     - Worker initialization via `defineBusiness` and task handler registration.
     - Dynamic registration protocol (`PUT /api/runtime/v1/businesses/:id/versions/:version`).
     - Orchestrator Profile binding and connector slot mapping.
     - Durable step checkpoints, child task spawning (`createChildTask`), and all-success joins.
     - Human-in-the-loop pause (`waitInput`) and resume mechanics.
     - Coexistence, version pinning, and fail-closed drain/rollback validation.
  2. Reconcile `tasks/P7-extension-proof.md`: mark `[x] P7-07` COMPLETE upon publication.
  3. Record exact documentation delivery in `coordination/reports/antigravity.md`.

---

### W32-CC — Command Code (Coding Lane)
- **Target**: Workflow Builder DU Gateway Integration Adapter & Wire Contract.
- **Owned Files**:
  - `app/workflow-builder/du-operation-adapter.ts`
  - `tests/workflow-builder/du-operation-adapter.test.ts`
  - `du-rework/coordination/reports/command-code.md`
- **Boundaries**: Own only Workflow Builder client-side adapter and its focused tests. Do NOT edit `du-rework/**`, root lockfiles, route handlers, or DB/Redis.
- **Requirements**:
  1. Create typed adapter `app/workflow-builder/du-operation-adapter.ts` mapping Workflow Builder run schemas to standard DU Rework Operation submissions (`POST /api/v1/operations` with `businessId`, `action`, `input`, `idempotencyKey`).
  2. Implement client polling helper for `OperationView` (`/api/v1/operations/:id`), decoding terminal states (`SUCCEEDED`, `FAILED`, `CANCELLED`, `TIMED_OUT`) and progress percentages.
  3. Add table-driven unit tests in `tests/workflow-builder/du-operation-adapter.test.ts` covering mapping, payload hashing, error propagation, and mock polling transitions.
  4. Verify full Workflow Builder suite green (`pnpm test tests/workflow-builder`) and 0 type errors in owned scope.
  5. Update `coordination/reports/command-code.md`.

---

### OpenClaude Lane (W31-O in progress)
- OpenClaude is currently finalizing W31-O (P6-04 pure Connector configuration view-models). Will be assigned next task upon completion.
