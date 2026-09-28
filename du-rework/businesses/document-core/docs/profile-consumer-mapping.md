# Business-Owned Consumer Mapping: Profile-Bound Authorization (P2-02 / R08-02 / W13-C)

- **Date**: 2026-09-22 (Wave 21 / W21-A)
- **Lane**: `businesses/document-core`
- **Scope**: Manifest-backed consumer mapping, profile-bound authorization fixture, explicit integration typecheck, and integration harness wiring against Orchestrator Admin and public submission endpoints.

---

## 1. Architectural Overview

Under P2-02 / R08-02 and W13-C, the platform enforces profile-bound authorization:
1. **Immutable Revisions**: Each profile revision is an immutable row in `profile_bindings` mapping an active API key to a specific `(business_id, business_version, action)` tuple and slot-to-connector pins (`{ [slot]: { connectorId, revision } }`).
2. **Submission-Time Pinning**: At `POST /api/v1/operations`, Orchestrator resolves the API key's latest profile revision for the requested action and pins `(profile_id, profile_revision)` onto the operation record in PostgreSQL.
3. **Mid-Operation Immutability (PRF-02)**: Subsequent revisions appended to the profile do not alter in-flight operations; grant issuance reads the pinned snapshot from the operation, not live config.
4. **Fail-Closed Authorization (PRF-01)**: If an API key possesses at least one binding row in `profile_bindings`, it is confined to explicit bindings. Submitting an action without a valid binding row fails immediately with `403 Forbidden` (`PERMISSION_DENIED` ProblemDetails envelope: `api key is not authorized for action <action> on <businessId>@<businessVersion>`), and no task is enqueued.
5. **Fail-Closed Grants**: Invocation grant requests verify that the requested slot exists in the pinned binding; unbound slots reject with `403 BINDING_DENIED`.

---

## 2. Exact Orchestrator Source Review & Route Contracts

### A. Admin Route: Append Profile Revision
- **Endpoint**: `POST /api/v1/admin/profile-bindings`
- **Source Reference**: [`services/orchestrator/src/server.ts:489-508`](file:///D:/Git/dugate/du-rework/services/orchestrator/src/server.ts#L489-L508)
- **Authentication**: `assertAdminAuth(ctx)` — requires `Authorization: Bearer <adminToken>` matching `ctx.config.adminToken`. Fails closed (`401 UNAUTHENTICATED`) if `adminToken` is missing or mismatched.
- **Request Payload**:
  ```json
  {
    "profileId": "optional-uuid-string",
    "apiKey": "raw-api-key-string",
    "businessId": "document-core",
    "businessVersion": "1.0.0",
    "action": "extract",
    "connectorBindings": {
      "reasoning": {
        "connectorId": "doc-core-conn-123",
        "revision": 1
      }
    }
  }
  ```
- **Input Validation & Error Responses**:
  - `apiKey` must be a non-empty string; if missing or empty → `422 INVALID_SCHEMA` (`apiKey is required`).
  - `apiKey` is hashed server-side via `hashKey(body.apiKey)` (SHA-256) and verified against `api_keys` table with `status = 'ACTIVE'`; if not found → `404 NOT_FOUND` (`api key not found or not ACTIVE`).
  - `businessId`, `businessVersion`, and `action` must be non-empty strings; if missing → `422 INVALID_SCHEMA`.
  - `connectorBindings` must be an object where each slot maps to `{ connectorId: string, revision: positive integer }`; otherwise → `422 INVALID_SCHEMA`.
- **Response**:
  - Status: `201 Created`
  - Body:
    ```json
    {
      "profileId": "uuid-string",
      "revision": 1
    }
    ```

### B. Submission-Time Resolution
- **Source Reference**: [`services/orchestrator/src/modules/operations/submission.ts:65-72`](file:///D:/Git/dugate/du-rework/services/orchestrator/src/modules/operations/submission.ts#L65-L72) and [`services/orchestrator/src/modules/profiles/profiles.ts:112-140`](file:///D:/Git/dugate/du-rework/services/orchestrator/src/modules/profiles/profiles.ts#L112-L140)
- **Mechanism**:
  - Queries `profile_bindings` where `api_key_id = $1 AND business_id = $2 AND business_version = $3 AND action = $4 ORDER BY revision DESC LIMIT 1`.
  - If row found: returns `{ mode: 'pinned', profileId: row.profile_id, revision: row.revision, bindings: row.connector_bindings }`.
  - If row not found: checks if key has ANY row in `profile_bindings`. If yes → throws `HttpError(403, 'PERMISSION_DENIED', 'api key is not authorized for action <action> on <businessId>@<businessVersion>')`. If no → returns `{ mode: 'legacy' }`.
  - When pinned, operation is inserted with `profile_id` and `profile_revision`.

### C. Grant Issuance & Claim Snapshot
- **Source Reference**: [`services/orchestrator/src/modules/grants/grants.ts`](file:///D:/Git/dugate/du-rework/services/orchestrator/src/modules/grants/grants.ts) and [`services/orchestrator/src/modules/profiles/profiles.ts:56-62`](file:///D:/Git/dugate/du-rework/services/orchestrator/src/modules/profiles/profiles.ts#L56-L62)
- **Mechanism**:
  - `renderPinnedBindings` formats slot map to `{ [slot]: "${connectorId}@${revision}" }`.
  - Task context `ctx.connectorBindings` receives the pinned slot mapping.
  - Grants are signed containing the pinned connector ID and revision.

---

## 3. Implementation Readiness & Status Matrix

| Component | Target Artifact / Route | Status | Notes |
|---|---|---|---|
| **Admin Route** | `POST /api/v1/admin/profile-bindings` | **IMPLEMENTED** | Verified in `services/orchestrator/src/server.ts:489`. |
| **Profile Service** | `createProfileService` (`createRevision`, `resolveBinding`) | **IMPLEMENTED** | Verified in `services/orchestrator/src/modules/profiles/profiles.ts`. |
| **DB Schema Migration** | `0004_profile_bindings.sql` | **IMPLEMENTED** | Verified in `services/orchestrator/migrations/0004_profile_bindings.sql`. |
| **Submission Resolution** | `createSubmissionService` pinning | **IMPLEMENTED** | Verified in `services/orchestrator/src/modules/operations/submission.ts:65`. |
| **Fail-Closed 403 (PRF-01)** | Unauthorized action rejection (`PERMISSION_DENIED`) | **IMPLEMENTED** | Returns RFC 9457 `ProblemDetails` with `status: 403`, `code: 'PERMISSION_DENIED'`. |
| **Business Client Fixture** | `ProfileBindingFixtureClient` in `document-core` | **VERIFIED (W20)** | Manifest-backed per-action bindings (`reasoning` vs `ocr`/`vision`); pre-HTTP validation rejecting undeclared actions/slots (e.g. `llm`) and empty actions/bindings; profileId guaranteed non-undefined. |
| **Offline Fixture Tests** | `tests/profile-binding-fixture.test.ts` | **VERIFIED (W20)** | 12 tests PASS offline: manifest derivation, rejection of undeclared slots before HTTP, rejection of empty actions, exact 6-action payloads, 201 parsing, and 401/404/422/403 error mapping. Zero `any` casts. |
| **Integration Typecheck** | `tsconfig.test.json` + `pnpm --filter @du/document-core test:typecheck` | **VERIFIED (W21)** | Explicit `noEmit` typecheck including `src/**` and `tests/**` (E2E suite + helpers) against published declarations. Zero errors, zero `any` or `ts-ignore`. |
| **Failure Cleanup Regressions**| `tests/barrier-cleanup-lifecycle.test.ts` | **VERIFIED (W21)** | 4 tests PASS offline proving bounded barrier wait, `finally` worker unblocking on assertion error, aggregated teardown error collection, and dynamic key/profile tracking. |
| **E2E Integration Wiring** | `tests/multi-container-e2e.integration.test.ts` | **WIRED & AUTHORED (W21)** | Wired in `beforeAll`/`afterAll` with suite-owned bindings, explicit v2 profile binding in Test 10, Test 12 (`PRF-02` revision pinning with bounded barrier, `finally` reset, observable routing via `/rev2` route + response markers), Test 13 (`PRF-01` unbound action 403 `PERMISSION_DENIED` ProblemDetails validation, tracked keys/profiles cleanup). |
| **Live Dependency Rebuild** | `pnpm --filter @du/document-core build:deps` | **GATED / BLOCKED** | Awaiting stable platform window announcement in `coordination/reports/claude.md`. |
| **Live Shared-DB E2E** | `pnpm --filter @du/document-core test:integration:full` | **UNEXECUTED / BLOCKED** | Gated on stable platform window to prevent shared-DB/Redis collisions on port 5433/6380 while Claude develops platform. |

---

## 4. Manifest-Backed Action Slot Mapping

Under `documentCoreManifest.actions` (`businesses/document-core/src/manifest.ts`), the declared connector slots per action are:

| Action | Declared Slots in Manifest | Helper Binding Derivation |
|---|---|---|
| `extract` | `reasoning` | `{ reasoning: { connectorId, revision } }` |
| `analyze` | `reasoning` | `{ reasoning: { connectorId, revision } }` |
| `transform` | `reasoning` | `{ reasoning: { connectorId, revision } }` |
| `generate` | `reasoning` | `{ reasoning: { connectorId, revision } }` |
| `compare` | `reasoning` | `{ reasoning: { connectorId, revision } }` |
| `ingest` | `ocr`, `vision` | `{ ocr: { connectorId, revision }, vision: { connectorId, revision } }` |
| *(Undeclared, e.g. `llm`)* | *None* | **REJECTED BEFORE HTTP** (`slot 'llm' is not declared in manifest for action ...`) |

---

## 5. Integration Harness Wiring & Authored Test Cases

In [`businesses/document-core/tests/multi-container-e2e.integration.test.ts`](file:///D:/Git/dugate/du-rework/businesses/document-core/tests/multi-container-e2e.integration.test.ts):
1. **Suite-Owned Profile Provisioning (`beforeAll`)**:
   - Creates a dedicated `suiteProfileId = randomUUID()` and tracks it in `trackedProfileIds`.
   - Calls `profileClient.bindDocumentCoreActions(...)` using manifest-derived bindings across all 6 actions (`extract`, `analyze`, `transform`, `generate`, `compare`, `ingest`).
   - Records `initialExtractProfileRevision = bindResult.revisionsByAction['extract']` dynamically rather than assuming literal 1.
2. **Suite-Owned Scoped SQL Cleanup (`afterAll`)**:
   - Iterates through all tracked profile IDs (`trackedProfileIds`) and executes `DELETE FROM profile_bindings WHERE profile_id = $1`.
   - Iterates through all tracked API keys (`trackedApiKeys`, including restricted keys from subtests) and executes `UPDATE api_keys SET status = 'REVOKED' WHERE hash = $1; DELETE FROM api_keys WHERE hash = $1`.
   - Deletes suite-owned connector revisions and secret versions.
   - Aggregates all cleanup errors without halting intermediate steps.
3. **Multi-Version Authorization (Test 10)**:
   - Explicitly calls `profileClient.createRevision({ profileId: suiteProfileId, action: 'extract', businessVersion: '1.1.0', ... })` before submitting Op2.
   - Conforms strictly to fail-closed authorization (`PRF-01`).
4. **Deterministic Connector Revision Pinning (`PRF-02`, Test 12)**:
   - Provisions connector revision 2 in PostgreSQL with `config: { path: '/rev2', ... }` using `repo.createRevision(input: Omit<ConnectorRevision, 'revision'>)`. Reads and asserts assigned revision (`rev2ConfigRevision`).
   - Sets an in-flight step barrier on OpA with a bounded 15,000ms timeout (`waitForBarrier`).
   - Wrapped in `try { ... } finally { ... }`: the `finally` block ALWAYS releases `connectorPinningBarrierRelease()` and resets all barrier promises/flags, preventing stranded workers or test hanging on timeout/assertion failure.
   - Updates profile binding for `extract` to connector revision 2 while OpA is paused in `RUNNING`.
   - Submits OpB; verifies OpB pins revision 2 while OpA remains pinned to `initialExtractProfileRevision`.
   - Releases the barrier; polls both operations to `SUCCEEDED`.
   - Verifies minted invocation grants in PostgreSQL: OpA used `initialExtractProfileRevision`, OpB used `rev2ConfigRevision`.
   - **Observable Revision Routing**:
     - `providerRev1Calls` incremented by exactly 1 for OpA; `providerRev2Calls` incremented by exactly 1 for OpB (zero extra calls).
     - Semantic result artifact for OpA contains `revisionMarker: 'connector-rev-1'` and `invoiceNumber: 'INV-2026-REV1'`.
     - Semantic result artifact for OpB contains `revisionMarker: 'connector-rev-2'` and `invoiceNumber: 'INV-2026-REV2'`.
5. **Unbound Action 403 Fail-Closed Rejection (`PRF-01`, Test 13)**:
   - Provisions a restricted API key and tracks `restrictedKeyHash` in `trackedApiKeys`.
   - Binds ONLY `extract` action for this key and tracks `restrictedBinding.profileId` in `trackedProfileIds`.
   - Submits an operation for `analyze`; asserts immediate `403 Forbidden` response.
   - Matches RFC 9457 `ProblemDetails` schema: `status: 403`, `code: 'PERMISSION_DENIED'`, and `title` matches `/not authorized for action analyze/`.
   - Asserts zero operations or tasks enqueued in PostgreSQL and zero provider side-effects.
