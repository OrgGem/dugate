# ENCMETA-BACKFILL-PREP — backfill design for `result_ref` (ENC-09 window) — 2026-10-05

**Packet:** `coordination/dispatch-specs/2026-10-05-0234-ENCMETA-BACKFILL-PREP.md` (lane qwen_1).
**Mode:** READ-ONLY design packet — 0 source edits, no tick/commit.
**Depends on:** `encmeta-resultref-impl-2026-10-05.md` (cc_1, the seal wiring).
**Aligns with:** `tasks/LIVE-TEST-PLAN-...md` LIV-EM-01 (already written) + `modules/encryption/legacy-payload-migration.ts` (the ENC-09 framework).

## 0. TL;DR

- The seal context per row is fixed and **must be reproduced exactly** or the envelope will not open: `operations.result_ref` = `(row.tenant_id, 'operations.result_ref', row.id)`; `tasks.result_ref` = `(tenant via operations JOIN, 'tasks.result_ref', tasks.id)`.
- **The framework already exists**: `legacy-payload-migration.ts` provides inventory → lock/CAS → seal → verify-readback → commit, plus a restore path and a 14-day window cap. There is **no PG-backed store** — only a test `MemoryPayloadStore`.
- **BLOCKER (must be built, not just configured):** there is **no window switch today**. `openMetadata` (runtime.ts:445) hardcodes `readStored(..., true)` and the `readStoredText` call sites pass `true`. So the backfill window is **permanently open** and enabling metadata encryption does **not** fail-closed legacy plaintext. The "flip to fail-closed" step is a code/flag change, not a config flip.
- **Coverage gap:** `result_ref` is not an `ENC09_PAYLOAD_KINDS` member, so the ENC-09 inventory does not enumerate these two columns today (it would report them as uncovered scope).

## 1. What exists today (verified, not assumed)

| Fact | Evidence |
|---|---|
| `result_ref` is `text` on both tables | `0001_platform_v1.sql:48` (operations), `:85` (tasks) |
| `operations` has `tenant_id`; **`tasks` does NOT** | `0001_platform_v1.sql:38` (operations) vs `:66-89` (tasks: `operation_id`, no tenant column) |
| Envelope stored as **JSON text** (not jsonb) | `readStoredText` doc (metadata-crypto.ts:341-349) + cc_1 writer |
| Envelope discriminator | `isSealed`: `version===1 && algorithm==='aes-256-gcm' && typeof ciphertext==='string' && isRecord(dek) && typeof nonce==='string' && typeof tag==='string'` (metadata-crypto.ts) |
| **No window flag exists** | `openMetadata` (runtime.ts:445-453) → `readStored(value, context, true)`; `public.ts:482` → `true`. Only `DU_ENCRYPTION_METADATA_ENABLED` (boot-options.ts:24) gates whether a seam exists at all. |
| ENC-09 framework to reuse | `legacy-payload-migration.ts`: `inventoryPlaintextPayloads`, `backfillLegacyPayloads`, `restoreLegacyPayload`, `MAX_DUAL_READ_WINDOW_MS = 14d` |
| Only a test store exists | `PayloadMigrationStore` implemented solely by `MemoryPayloadStore` in `tests/legacy-payload-migration.test.ts` |
| `result_ref` not an ENC-09 kind | `ENC09_PAYLOAD_KINDS` = artifact, operation_input, task_payload, child_payload, hitl_response, control_metadata, outbox_payload, checkpoint |

## 2. Script design

### 2.1 Reuse the ENC-09 shape, don't reinvent it

Provide a PG-backed store implementing `PayloadMigrationStore` for the two `result_ref` columns and drive it with the existing `backfillLegacyPayloads` / `inventoryPlaintextPayloads` / `restoreLegacyPayload`. This inherits the invariants for free (idempotency, integrity check, verify-readback-before-commit, count-only reporting, `legacyDeletionAllowed:false`).

### 2.2 Context construction (the critical correctness detail)

For each row, build the seal context from the SAME triple the writer uses so the readers can open it:

```
// operations.result_ref
{ tenantId: row.tenant_id,                 slot: 'operations.result_ref', refId: row.id }

// tasks.result_ref  — NO tenant_id column on tasks
{ tenantId: op.tenant_id /* JOIN operations */, slot: 'tasks.result_ref', refId: task.id }
```

Mistaking `refId` (e.g. using the operation id for a task row) or the slot produces an envelope that silently fails to open at R1/R2/R3 — a data-loss-shaped bug, not a startup error. The backfill must therefore verify the round-trip under the **reader's** context before committing (see §5).

### 2.3 Per-row algorithm

For each candidate row (scanned by cursor, `SELECT ... LIMIT batch`):

1. **Classify.**
   - `result_ref IS NULL` → count `null`, skip (many rows never complete).
   - looks like an envelope (`readStoredText` parses + `isSealed`) → **verify-open** under its own context → count `verified` (idempotent re-run), or count `failed` with a readback issue if it does not open.
   - otherwise plaintext (non-JSON, or JSON-but-not-envelope) → candidate to seal.
2. **Integrity gate.** For a plaintext row, the value is opaque; integrity = "the string we read is the string we seal." Record its sha256 as the before-digest (never the value).
3. **Seal** via `metadataCrypto.seal(ref, ctx)` → envelope JSON **string**. Wrap in a per-row transaction.
4. **Verify readback BEFORE commit.** Open the freshly-sealed envelope under the same ctx and assert it equals the original string exactly.
5. **Commit** the single-column UPDATE (idempotent: re-running sees an envelope → `verified`).
6. Any step fails → **roll back that row only**, record an issue code, continue the batch.

This mirrors `backfillLegacyPayloads` (seal → verify readback → commit), which is exactly why we reuse it.

### 2.4 Count-only safety

- Logs and reports carry **counts and markers only**: `{scanned, null, alreadySealed, migrated, verified, failed, unresolved}` + per-issue codes + envelope-version counts.
- **Never** the ref value, never the plaintext, never the before/after digest that could correlate a secret. (Matches the existing sentinel discipline: detect by marker, never echo payload.)
- **No DELETE / no null-out** of anything in the window. `legacyDeletionAllowed:false` by contract; the plaintext stays the rollback source.

## 3. Window timeline + fail-closed flip condition

The flip cannot be a config change today (see §1: `allowPlaintext` hardcoded true). So either (a) introduce a flag that the readers honour, or (b) treat closing the window as a code deploy. **The design below assumes (a) is built first** (it is the safer of the two because it makes the flip auditable and reversible without a code rollout).

| Phase | State | Gate to advance |
|---|---|---|
| **T0** window OPEN | readers `allowPlaintext=true`; writer seals new rows | start only after the metadata seam is enabled and a PG backup exists |
| **T1** inventory | `inventoryPlaintextPayloads` over both columns → counts (no values) | have a clean baseline count |
| **T2** backfill | per-row seal+verify; `after` counts | run to `state` from the framework |
| **T3** FLIP | close the window → readers `allowPlaintext=false` | **`unresolvedReferences == 0` AND `plaintextPayloads == 0` across both columns** (i.e. every non-null ref is a valid envelope that opens under its binding). Any non-zero ⇒ do NOT close |
| **T4** window CLOSED | plaintext row ⇒ `NOT_SEALED`; bad envelope ⇒ `AUTHENTICATION_FAILED`/`CONTEXT_MISMATCH` | hold ≥ the ENC-09 window buffer, but **the open window must not exceed `MAX_DUAL_READ_WINDOW_MS` (14 days)** — a stuck T2 must not silently keep the window open past the cap |

**Fail-closed flip condition (restated, because it is the crux):** close the window **only** when a fresh inventory shows, across BOTH `tasks.result_ref` and `operations.result_ref`: 0 plaintext, 0 unresolvable-context, 0 failed-open. That is "zero unresolved refs". Do not infer it from `migrated==scanned` alone — `null` and `unresolved` rows must also be accounted for.

## 4. Rollback

Reuse `restoreLegacyPayload`: for each sealed row, open the envelope under its own binding, write the ORIGINAL string back, count-only. Safe because §2.3 step 4 proved the round-trip is exact before commit, so restoring is deterministic.

- Rollback returns the rows to plaintext; it does NOT delete envelopes or drop rows.
- After rollback the window is back OPEN (readers tolerate plaintext again).
- Rollback rehearsal belongs in the live checklist **before** T3, not after.

## 5. Test plan — offline (fake pg)

Seed the fake pg with one row per class, then drive the real store/codec:

| # | Test | Assert |
|---|---|---|
| 1 | plaintext rows | become envelopes `{version:1,algorithm:'aes-256-gcm'}` under correct slot+refId; counts `migrated` |
| 2 | null rows | left NULL; counted as `null`, not failed |
| 3 | already-sealed rows | NOT re-sealed; verified-open; count `verified` (idempotency) |
| 4 | idempotent re-run | run twice → second run `migrated==0`, `verified==n` |
| 5 | **wrong-refId guard** | a backfill that seals a `tasks` row under the operation id produces an envelope that FAILS the reader-context open (`CONTEXT_MISMATCH`) — the test must catch the bug, proving round-trip-under-reader-context is load-bearing |
| 6 | round-trip equals original | open each migrated envelope under the runtime's ctx → byte-identical to the original string |
| 7 | fail-closed on residual plaintext | with window CLOSED, a residual plaintext row ⇒ `NOT_SEALED`; a migrated row still opens |
| 8 | rollback | `restoreLegacyPayload` returns rows to plaintext exactly; window back open; counts-only |
| 9 | count-only | report/log contains no ref value (sentinel scan over the emitted report) |

**Mutation note (applies to whoever implements):** the "verify readback under the reader context" assertion (tests 5/6) is the one that must go RED if the refId/slot wiring is wrong. A test that only checks "the column changed to an envelope" would pass with the WRONG binding and is not sufficient.

## 6. Live checklist (for the window run)

Mirrors LIV-EM-01 and ENC-09 window discipline:

1. Preconditions: PG real with legacy plaintext rows on both columns; metadata seam enabled; **backup taken and signed off** (ENC-09 retains legacy pending backup sign-off).
2. Inventory (counts only, no values) → baseline `{plaintext, encrypted, unresolved}` for both columns.
3. Backfill → after-inventory; assert `unresolvedReferences==0` and `plaintext==0` across both columns. **Do not advance if non-zero.**
4. Sampled round-trip: open via **R1** (`GET /operations/:id/result`), **R2** (`getChildren`), **R3** (parent join) → same opaque string as before the backfill.
5. Join-summary nesting check: a parent join over sealed child refs must merge **opened** plaintext refs, not nested envelopes (the hazard cc_1's R3 already guards).
6. **Rollback rehearsal BEFORE the flip**: restore a row, confirm it reads back verbatim under an OPEN window.
7. Flip the window CLOSED; confirm any residual plaintext ⇒ `NOT_SEALED` (fail-closed), and sealed rows still open.
8. Post-window: no window may remain open past `MAX_DUAL_READ_WINDOW_MS` (14d).

## 7. Open decisions for the coordinator

- **Window mechanism:** add a flag the readers honour (recommended) vs. treat closing as a code deploy. Today neither exists for metadata.
- **ENC-09 kind:** add a `result_ref` kind to `ENC09_PAYLOAD_KINDS`, or declare these two scans under `control_metadata`. A dedicated kind is more truthful and keeps `coveredKinds`/`uncoveredKinds` honest.
- **PG store:** this packet assumes a new PG-backed `PayloadMigrationStore`; confirm the lease/file for it before implementation (none exists today).

## 8. Limitations

- Design only; nothing implemented or executed against a DB in this packet.
- Verified against the current tree (`runtime.ts`, `metadata-crypto.ts`, `public.ts`, `0001` schema, `legacy-payload-migration.ts`). The cc_1 result-ref seal is presumed landed (its receipt says so and the detector is green); this packet did not re-verify the writer line-by-line.
- The 14-day cap is read from `MAX_DUAL_READ_WINDOW_MS`; whether it is enforced anywhere for metadata is unverified.

READ-ONLY compliance: 0 source/test edits; no commit/push/tick.