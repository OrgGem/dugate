# Dispatch Spec: LDBA-09B Replay Unblock (normalizeComparable and rowMatches)

- Date: 2026-10-09
- Role: Single Dispatcher (Antigravity Coordinator)
- Assignee: Codex-4 (term_d93ff3b1)
- Lease Area:
  - du-rework/orchestrator/services/orchestrator/scripts/ldba-03-production-adapter.cjs
  - du-rework/orchestrator/services/orchestrator/tests/ldba-03-production-adapter.test.cjs (or existing offline tests if adding normalization tests)
  - du-rework/coordination/reports/ldba-09B-replay-unblock.md
- Branch: codex/fix-workflow-builder
- Status: DISPATCHED

---

## 1. Context and Problem Statement

In LDBA-09A, rounds 1 (Preflight) and 2 (First Execute) passed cleanly on disposable PG16:
- 20 destination rows written with zero row failures.
- Round 3 (Replay Idempotency) stopped with `BLOCKED_TARGET_CONFLICT` (exit 1) reporting 6 `TARGET_IMMUTABLE_CONFLICT` rows across `Operation` (2), `ProfileEndpoint` (2), and `FileCache` (2).

### Root Cause Analysis: Type & Serialization Representation Drift

When querying PostgreSQL in `inspectImmutable(item)` / `validatePlan(writes)` / `applyImmutableBatch(writes)`:
1. `artifacts`: `size_bytes` is a PostgreSQL `bigint` column. Node `pg` parses `bigint` as a string (`'18'`), while runner `item.value.size_bytes` is a number (`18`). In `sameValue`, `18 !== '18'`.
2. `operations`:
   - `extracted_data`, `pipeline_json`, `steps_result_json`, `usage_breakdown` are `jsonb` columns. Node `pg` automatically deserializes `jsonb` into JavaScript objects/arrays, whereas in the runner they may be JSON text strings (or vice-versa).
   - `total_cost_usd` is `numeric(20,6)`.
   - `created_at`, `updated_at`, `deleted_at`: Node `pg` deserializes `timestamptz` as `Date` objects, while runner values are ISO UTC text strings or ISO Date strings.
3. `profile_bindings`:
   - `parameters`, `connections_override` are `jsonb` columns. In `item.value`, they might be JSON strings or plain JS objects, and `pg` returns parsed objects.
4. `artifact_blobs`:
   - In `validatePlan` and `applyImmutableBatch`, `withArtifactTenant` attaches `tenant_id` to `item.value`. In `inspectImmutable`, `item.value` does not have `tenant_id` unless synthesized, but `artifact_blobs` in target has `tenant_id`. Notice line 432 in `validatePlan` and line 463 in `applyImmutableBatch` compares `rowMatches(existing.rows[0], item.value)`. In `item`, `item.value` may or may not have `tenant_id`! If `item` has `tenant_id` injected via `withArtifactTenant`, `item.value` has it, but in `inspectImmutable` `expected` was prepared separately.

---

## 2. Work Objectives for Codex-4

1. **Enhance `normalizeComparable` & `sameValue` in `ldba-03-production-adapter.cjs`**:
   - Provide JSON string vs parsed object equivalence: if one side is a JSON string and the other is an object/array, parse the JSON string (or normalize both).
   - Provide Number vs BigInt/Numeric string equivalence: `sameValue(18, '18') === true`, `sameValue('0.000001', '0.0000010') === true`.
   - Provide Timestamp string equivalence: if both are dates/ISO timestamps, compare timestamp milliseconds or ISO format.
   - Buffer / Uint8Array / hex byte representation: preserve existing `{ bytes: hex }` logic.
   - In `validatePlan` and `applyImmutableBatch`, make sure `rowMatches` receives the proper `expected` (taking `withArtifactTenant` into account for `artifact_blobs`).

2. **Verify Offline Tests**:
   - Run `node --test tests/ldba-03-runner-skip.test.cjs tests/ldba-03-backfill-offline.test.cjs`.
   - Run existing unit tests for production adapter.
   - All tests must exit 0.

3. **Run Disposable PG16 Rehearsal**:
   - Run `node scripts/ldba-09-harness.cjs`.
   - Rehearsal must complete all 5 rounds successfully:
     - Round 1: Preflight `PREFLIGHT_READY` exit 0.
     - Round 2: Execute `APPLIED` exit 0 (20 rows written).
     - Round 3: Replay Idempotent `APPLIED` exit 0 (`FIXTURE_APPLIED_REPLAY_ALL_IDENTICAL`).
     - Round 4: Fail-policy `BLOCKED_SKIPPED_ROWS` exit 1.
     - Round 5: LDBA-08 regression `BLOCKED_TRANSFORM` exit 1 with expected context failures.
     - Container cleanup literal `CONTAINER_REMOVED ...`.
     - Overall harness exit 0 (`HARNESS_PASS disposable_pg16=1 ...`).

4. **Deliver Receipt**:
   - Write `du-rework/coordination/reports/ldba-09B-replay-unblock.md`.

---

## 3. Strict Invariant Rules
- Do NOT use git commit, git push, git add, git checkout.
- Do NOT touch live database or read .env.live.
- Do NOT modify product core routes or other files outside the designated lease.
