# ENCMETA-RESULTREF-PREP — scoping the RED detector `enc-meta-sentinel-runtime-refs` (result_ref) — 2026-10-05

**Packet:** `coordination/dispatch-specs/2026-10-05-0105-ENCMETA-RESULTREF-PREP.md` (lane qwen_1).
**Mode:** READ-ONLY — 0 source edits, 0 test edits, no tick/commit. The detector was RUN, not changed.
**Scope:** the G2 RED gap detector for `tasks.result_ref` / `operations.result_ref`.

## 0. TL;DR

- **Writer:** exactly TWO statements, both in `RuntimeService.completeTask` — `runtime.ts:777` (tasks) and `runtime.ts:800` (operations). Both store the worker-supplied `body.resultRef` **verbatim**. No other production writer exists (grep-verified).
- **Why red:** `result_ref` is **not a `METADATA_SLOTS` entry**, so the seal seam never touches it. The detector injects a sentinel into `resultRef` and asserts it must not rest plaintext; it does.
- **Measured red:** 4 tests, 1 failed — `RED GAP DETECTOR` at line 294, `Expected: false, Received: true`. The sibling FINDING pin (line ~270) is green and pins the leak as *known*.
- **Sharpest blast-radius fact:** the fan-out join summary (`runtime.ts:1700`) merges child `result_ref` values **into the parent payload, which IS a sealed slot** — sealing `result_ref` naively nests envelope-in-envelope, the exact hazard the code comment at `runtime.ts:1704` warns about.
- **Recommendation:** Option A (seal, 2 new slots) with a backfill window — plus Option C (tighten the contract to a URI) as a complement, not a substitute.

## 1. Writer path of `result_ref` (question 1)

**Single writer: `RuntimeService.completeTask`** — `services/orchestrator/src/modules/runtime/runtime.ts:726-805`.

| Step | Location | Detail |
|---|---|---|
| Entry | `runtime.ts:727` | `completeTask(taskId, { leaseEpoch, resultRef, resultHash, outputArtifactIds? }, workerBusinessId?)` |
| Guard | `runtime.ts:731-732` | `contentHash(body.resultRef) !== body.resultHash` → 422 `INVALID_SCHEMA`. The worker must send the digest of the ref. |
| Write 1 (tasks) | `runtime.ts:777-783` | `UPDATE tasks t SET state='SUCCEEDED', result_ref=$2, ...` — params `[taskId, body.resultRef, body.leaseEpoch, workerBusinessId ?? null]` |
| Write 2 (operations) | `runtime.ts:800-801` | `UPDATE operations SET state='SUCCEEDED', state_version = state_version + 1, result_ref=$2, ...` — params `[t.operation_id, body.resultRef]` |

Both run inside one `db.tx`, both write the **same string verbatim**. Confirmed by grep for write shapes (`SET result_ref`, `result_ref=$`, `result_ref = `): the only production hits are those two lines — every other hit is a test fixture or a doc transcript.

**Column:** `result_ref text` — `migrations/0001_platform_v1.sql:48` (tasks, comment "artifact URI on success") and `:85` (operations).

**Contract shape:** `packages/contracts/src/runtime.ts:229` `CompleteTaskRequestSchema.resultRef = z.string().min(1)`; `packages/contracts/src/sdk.ts:23` (completed disposition) `resultRef: z.string().min(1)`.

> The contract admits **any non-empty string** — no URI constraint, no length cap, no content class. That is the hole: the column is *documented* as a URI but *typed* as free text, so a worker can park a document body (as the detector does) in it.

**Not a writer:** `completeTask` does not put `result_ref` into the outbox. The terminal webhook is scheduled by reference (`maybeScheduleWebhook`). The outbox payload refs are separate columns.

## 2. Why the detector is red (question 2)

`METADATA_SLOTS` (`src/modules/runtime/metadata-crypto.ts:44-55`) declares exactly five sealed control-plane slots:

`operations.input_ref`, `tasks.payload_ref`, `human_waits.response_ref`, `step_checkpoints.output_ref`, `operations.prompt_overrides_ref`.

**`tasks.result_ref` and `operations.result_ref` are not among them.** So:

1. `completeTask` never calls `seal(...)` for the ref — it passes `body.resultRef` straight to the UPDATE param.
2. No reader calls `readStored(..., allowPlaintext: false)` for the ref, so a plaintext row is never even detected as unsealed.

The detector drives the REAL `createApp` runtime over a scripted `pg` + the real metadata seam, injects `RESULT_REF = JSON.stringify({ note: SENTINEL })`, and asserts the persisted param must not contain the sentinel:

```
enc-meta-sentinel-runtime-refs.test.ts   4 tests, 1 failed   (Exit Code: 1)
  √ FINDING pin: completeTask stores result_ref verbatim on BOTH tasks and operations
  × RED GAP DETECTOR: result_ref must not rest as plaintext on either row
      expect(leaksSentinel(taskWrite!.params[1])).toBe(false)
      Expected: false   Received: true        (line 294)
  √ FINDING pin: waitInput stores ui_schema and context_ref verbatim (no slot exists)
  √ GREEN: resumeOperation seals response_ref + resume payload; the dispatch row carries references only
```

**So yes: the sentinel leaks verbatim into `tasks.result_ref` and `operations.result_ref`.** The class is *recorded*, not *unknown* — the sibling FINDING pin asserts `leaksSentinel(...) === true` on both writes and is green, so the leak is a pinned, acknowledged state.

### 2.1 The gap is at-rest only

The value IS protected in transit for tenants with delivery encryption: `public.ts:476` builds `data: { resultRef: op.result_ref }`, then `encryptedDeliveryBody(...)` (ENC-07) encrypts the whole body, and a failed encryption is a 503 rather than a plaintext downgrade. The RED detector is strictly about the PostgreSQL at-rest copy.

## 3. Readers — blast radius (question 3 input)

| # | Reader | Location | What it does with the value |
|---|---|---|---|
| R1 | Public result route `GET /api/v1/operations/:id/result` | `src/http/routes/public.ts:476` | `data: op.result_ref ? { resultRef: op.result_ref } : {}` — verbatim, tenant-scoped, then ENC-07 |
| R2 | Fan-out child listing `getChildren` | `runtime.ts:1113-1126` | `SELECT c.result_ref` → `resultRef` on each child |
| R3 | Parent join summary (inside `reconcileParentJoin`) | `runtime.ts:1675-1702` | `joinSummary[s.task_key] = s.result_ref`, then **merged INTO the sealed parent payload** |
| R4 | Worker SDK fan-out | `packages/worker-sdk/src/fan-out.ts:605` | `resultRef: pickString(row.result_ref)` |

**R3 is the sharp edge.** The comment at `runtime.ts:1704-1707` says the parent payload must be *opened* before the join summary is merged back, "merging into the raw envelope would nest one sealed blob inside another and the parent could never read it." If `result_ref` were sealed, the summary would carry sealed child envelopes into that merge — the same nesting bug, one level down. Sealing therefore requires opening every child ref in the join path (an N-decrypt on a completion hot path).

## 4. Fix options (question 3)

### Option A — seal `result_ref` (two new `METADATA_SLOTS` entries)

Add `tasks.result_ref` + `operations.result_ref` to `METADATA_SLOTS`; seal in `completeTask`; open in R1-R4.

- **Blast radius: HIGH.** 2 new slots; 1 writer; 4 readers each needing `readStored(..., allowPlaintext)`; R3 must open before merging (or the nesting bug lands); existing rows are plaintext so a **backfill window** with `allowPlaintext` is required, exactly like the other five slots.
- **Pro:** consistent with the other 5 slots; the value stays readable; satisfies the detector's strict ADR-18 property.
- **Con:** `result_ref` is pointer-shaped and is already re-encrypted at delivery for encrypted tenants, so at-rest sealing duplicates work; and it adds a decrypt per child to the fan-out join.

### Option B — digest only (store the hash, not the ref)

Store `contentHash(resultRef)` (already computed and validated at `runtime.ts:731`) instead of the raw string.

- **Blast radius: HIGH, different shape.** R1's `data.resultRef` becomes a digest (contract/UI change); R2/R3/R4 likewise. Any consumer treating `resultRef` as a usable pointer breaks; the result route's documented "copies result_ref verbatim, never guesses an inner envelope" (`tools/openapi/gen_openapi.py:251`) changes meaning.
- **Pro:** no crypto, no key path, no backfill, smallest storage; removes the at-rest class outright.
- **Con:** **destroys information.** The ref is the row's only pointer to the worker's output; discarding it makes that output unreachable from the row. Needs a product decision that nothing reads the value.

### Option C — bound the value, keep it plaintext (accept the risk explicitly)

Enforce that `resultRef` is a URI/pointer (scheme allowlist + max length), matching what `0001` already claims; a document body then cannot be smuggled in.

- **Blast radius: MEDIUM.** Contract change on `CompleteTaskRequestSchema` + `sdk.ts` + SDK callers; no crypto, no migration, no backfill.
- **Pro:** cheapest; matches the documented intent; kills the *arbitrary-content* class.
- **Con:** does **not** turn the detector green — a URI can still carry a secret (`https://x/?token=...`), so the RED test stays red. It narrows the hole, it does not close the class.

### Recommendation

**Option A, with A and C together.** ADR-18 governs the control plane and `result_ref` is tenant-supplied worker output resting in PostgreSQL; "it is just a URI" is an *intent*, not an enforced property, so it cannot carry the exemption. But A must ship complete: (a) both slots, (b) an open before the R3 merge, (c) a backfill/`allowPlaintext` window. **C is a complement, not a substitute** — tightening the contract shrinks what can be stored during the plaintext window, which is precisely when A's backfill is running.

**Independent of the choice:** the detector's FINDING pin (`enc-meta-sentinel-runtime-refs.test.ts` test 1) currently asserts the leak is PRESENT. Whoever implements the fix must flip it consciously — it is written that way on purpose.

## 5. Test plan pin (question 4)

1. **Sentinel scan (the existing detector, turned green).** Keep both `result_ref` cases: the FINDING pin inverted to assert the sealed envelope shape (envelope fields present, sentinel absent), and the RED detector's `leaksSentinel(...) === false` on both `tasks` and `operations` writes.
2. **Seal/open round trip.** Seal on write → `readStored(envelope, { tenantId, slot: 'tasks.result_ref', refId: taskId }, false)` returns the original ref; same for `operations.result_ref`.
3. **Cross-slot / cross-tenant replay refusal (AAD).** A `tasks.result_ref` envelope must NOT open under `slot: 'operations.result_ref'` or `tasks.payload_ref` → `CONTEXT_MISMATCH`; same across tenants.
4. **Fail-closed plaintext.** With `allowPlaintext: false`, a legacy plaintext `result_ref` must raise `NOT_SEALED`, never silently return the plaintext — the forgotten-encryption direction.
5. **Join-summary nesting regression (the R3 hazard).** With a sealed child `result_ref`, the parent payload after the join must contain the **opened** child refs and must not contain a nested envelope: open the parent payload and assert its joinSummary values are plaintext refs.
6. **Reader coverage.** R1 returns the ref (not the envelope) for a sealed row; R2 `getChildren` returns the opened ref; R4's `pickString` path yields the ref.
7. **Negative control.** An absent/null `result_ref` is never sealed and the nullable path still works.
8. **If Option B is chosen instead:** assert the column holds `contentHash(resultRef)` and that NO reader returns a raw ref (the inverse of 6).

## 6. Limitations / follow-ups

- Measured through the scripted-`pg` harness, not a live PostgreSQL; the red is a harness-verified at-rest property, not a live-row dump.
- **Not measured:** whether any live consumer treats `resultRef` as a fetchable pointer. That single fact decides A vs B, so it should be settled before implementation. Suggested follow-up: grep the BFF/UI consumers of the `/result` `data.resultRef` field.
- `human_waits.ui_schema` / `context_ref` (detector test 3) are the same class but a separate decision (schema fields, not refs); out of this packet's scope, noted so they are not conflated.
- No fix applied: every option changes either the contract or a migration, and the packet is scoping-only.

READ-ONLY compliance: the detector was executed but not modified; no `src/` file was touched; no tick/commit.