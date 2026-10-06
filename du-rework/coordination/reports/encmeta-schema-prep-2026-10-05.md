# ENCMETA-SCHEMA-PREP — scoping `human_waits.ui_schema` / `context_ref` (detector test 3) — 2026-10-05

**Packet:** `coordination/dispatch-specs/2026-10-05-0135-ENCMETA-SCHEMA-PREP.md` (lane qwen_1).
**Mode:** READ-ONLY — 0 source/test edits, no tick/commit. The detector was RUN, not changed.
**Detector test 3 today:** GREEN FINDING pin. Full detector = 4/4 pass, 0 RED (RESULTREF-IMPL flipped the result_ref detector to GREEN).

## 0. TL;DR

- **Writer:** exactly one — `runtime.ts:1230-1239` (INSERT INTO human_waits): `uiSchema` via `JSON.stringify(req.uiSchema)` (:1238), `contextRef` via `req.contextRef ?? null` (:1239), both stored verbatim.
- **Readers:** `context_ref` has ZERO readers anywhere in the repo. `ui_schema` is read only by two admin view-model helpers (`operation-section-data.ts:951`, `operation-view-models.ts:303`) that consume a `wait` projection **no route ever produces** — so it has effectively no live consumer.
- **Different from `result_ref`:** `ui_schema`/`context_ref` have NO RED detector AND NO live reader. Test 3 is a green FINDING pin, not a failure. There is nothing to "fix" — only a classification decision.
- **Recommendation: C (keep + explicit exemption).** Sealing (A) would encrypt data nobody reads on a transient table. Digest (B) is not viable: `ui_schema` must stay renderable as a form schema.

## 1. Current state — the detector is GREEN

```
enc-meta-sentinel-runtime-refs.test.ts   4 tests, 4 passed, Exit Code: 0
  √ FIX pin (flipped): completeTask SEALS result_ref under BOTH row slots
  √ RED GAP DETECTOR: result_ref ... (GREEN since ENCMETA-RESULTREF-IMPL)
  √ FINDING pin: waitInput stores ui_schema and context_ref verbatim (no slot exists)
  √ GREEN: resumeOperation seals response_ref + resume payload
```

`METADATA_SLOTS` now reads (verified live):

`operations.input_ref`, `tasks.payload_ref`, `human_waits.response_ref`, `step_checkpoints.output_ref`, `operations.prompt_overrides_ref`, `tasks.result_ref`, `operations.result_ref`.

**`human_waits.ui_schema` and `human_waits.context_ref` are deliberately absent**, so the seal seam never touches them — which is exactly what test 3 pins.

## 2. Writer path (question 1, writer side)

`POST /tasks/{id}/wait-input` → `RuntimeService.waitInput` — `runtime.ts:1176-1255`:

- `runtime.ts:1180`: `body` is typed `{ leaseEpoch, waitKey, inputSchema, uiSchema?, contextRef?, expiresAt? }`.
- `runtime.ts:1207`: dedupe check reads back `wait_id, input_schema, expires_at, status` (the new row is NOT re-opened).
- `runtime.ts:1230-1246`: the INSERT:

```sql
INSERT INTO human_waits (operation_id, task_id, wait_key, wait_id, input_schema, ui_schema, context_ref, status, expires_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
```

- `:1238` — `req.uiSchema === undefined ? null : JSON.stringify(req.uiSchema)` — verbatim JSON.
- `:1239` — `req.contextRef ?? null` — verbatim string.

Columns (`migrations/0005_continuation.sql:15-17`): `input_schema jsonb NOT NULL`, `ui_schema jsonb NULL`, `context_ref text NULL`.

**Single writer.** No other INSERT names these columns. They are not copied into the outbox or any audit/ledger row.

## 3. Read paths (question 1, reader side)

### 3.1 `ui_schema` — read only by admin view-models that nothing populates

| # | Reader | Location | What it does |
|---|---|---|---|
| R1 | `operation-section-data.ts:943-951` | `raw['wait'].uiSchema` | copies the schema into the `OperationDetail['wait']` wire projection the UI renders from |
| R2 | `operation-view-models.ts:293,303-308` | `waitRow.uiSchema` | merges an allowlist of display fields (widget/title/description/placeholder) into the form model; explicitly does NOT surface data verbatim (`:286` comment) |

**Critical:** `raw['wait']` is fed by `toOperationView(...)`, and `toOperationView` (`src/modules/operations/facade.ts:32-53`) returns only `{id, name, businessId, businessVersion, action, state, stateVersion, createdAt, updatedAt, deadlineAt, progress, links}` — **no `wait` field**. `HumanWaitViewSchema` declares `uiSchema` as an optional member, and `OperationDetailSchema` has `wait: HumanWaitViewSchema.nullable().optional()`, but **no route builds the object**, so R1/R2 are written for a projection that the wire never carries. In the live wiring, `ui_schema` is never surfaced.

### 3.2 `context_ref` — zero readers

Grep across `du-rework` for `context_ref|contextRef`: the only hits are the SDK types (`worker-sdk/src/types.ts:208`), the SDK writer (`task-context.ts:493`), business authors (`example-review/src/review.ts:762,991`), docs, the detector, and the producer (`example-review/tests`). **No code reads the column back**, and `contextRef` is not even a member of `HumanWaitViewSchema`. It is a write-only column.

### 3.3 `input_schema` — the live one (for contrast)

`input_schema` **is** read by the runtime itself — `runtime.ts:1207,1245,1307` all SELECT it. That is a structural JSON schema, not tenant business data; the detector pins it as the control (`leaksSentinel(...,4) === false` because the fixture contains no sentinel). **It would not be meaningful to seal it** — it is the schema that lets the runtime render/validate the human input.

## 4. The three options (question 2)

### Option A — seal both (2 new `METADATA_SLOTS` entries)

Add `human_waits.ui_schema` and `human_waits.context_ref` to `METADATA_SLOTS`; seal in `waitInput`; open in admin view-models.

- **Blast radius: MEDIUM-HIGH.** Writer: 1. Live readers: 0 today, but any route that surfaces `wait` would need a `readStored` per row — that includes a future decrypt on the admin detail path. A **backfill window** is required for existing rows (like result_ref). The two columns are a transient `human_waits` table (OPEN → ANSWERED/EXPIRED/CANCELLED).
- **Pro:** consistent with the rest of the seal map; satisfies a strict ADR-18 reading.
- **Con:** seals data **nobody reads** — you encrypt at write and decrypt later a value that is never served to any tenant, on a table whose rows are short-lived. Adds friction for no tenant-facing benefit.

### Option B — digest

**Not viable.** `ui_schema` must remain renderable as a form schema — a digest destroys its only purpose. `context_ref` is a pointer — a digest leaves no usable reference, and you would still need the original somewhere to resolve it. Unlike `result_ref` (a pointer whose digest was an acceptable loss), sealing is the only cryptographic option that keeps the value, and digesting is acceptable only if the value is never needed again — it is.

### Option C — keep plaintext + explicit exemption

Leave both columns sealed-unsealed, and make the *decision* explicit rather than an accident.

- **`context_ref`**: zero readers. The honest move is to decide **keep vs drop** — if a future route needs it, exempt it then (and revisit); if nothing needs it, a `NULL`-out / drop migration is cheaper than encrypting a write-only column forever.
- **`ui_schema`**: business display metadata never served on the wire today. Exempt with the documented reason that it is a *display schema*, not tenant business data, and is never projected.
- **Blast radius: ZERO.** No code change; requires a scope note in ADR-18 / the detector comment, and flipping test 3 from "FINDING pin — we accept the leak temporarily" to "DOCUMENTED ACCEPTANCE — this class is outside the sealed control-plane on purpose".

### Recommendation

**C.** The deciding facts are structural: `result_ref` had a live reader (the `/result` route serves it to the tenant), so the at-rest exposure was real and sealing was correct. `ui_schema`/`context_ref` have **no live reader and no RED detector** — the sentinel they admit sits in a transient table and is returned to no one. Sealing there would be encryption with no consumer. The correct remediation is to (a) record the exemption explicitly, and (b) guard the property that actually protects tenants — that neither value ever crosses onto a public wire.

If the threat model later surfaces tenant content inside `ui_schema` (e.g. a rendered review title), that is the trigger to revisit — not a reason to seal now.

## 5. Test plan (question 4) — for option C

1. **Flip detector test 3 to documented acceptance (not a RED).** Keep the two `leaksSentinel(...) === true` assertions for `uiSchema`/`contextRef`, but rename the test to assert the *accepted exemption* — e.g. `STORE PLAINTEXT by documented exemption: ui_schema/context_ref are display metadata never projected on the wire`. The green result becomes a decision, not an oversight.
2. **Wire-boundary guard (the real protection).** New assertion that the public `OperationView`/`ResultEnvelope` wire shape carries **no** `uiSchema` and **no** `contextRef`: `toOperationView()` output contains neither key, and `HumanWaitViewSchema`-derived JSON projected to the client never includes `contextRef`. A sentinel in `ui_schema` must NOT appear in any public wire body.
3. **Pin that `context_ref` is contract-opaque.** Assert `HumanWaitViewSchema.safeParse({..., uiSchema})` still succeeds **without** `contextRef`, and that adding `contextRef` to a `HumanWaitView` is accepted only as unknown (i.e. the consumer schema does not surface it). This documents that `context_ref` has no contract consumer.
4. **Conditional-acceptance trigger (documented, not automated).** A comment (and the receipt) stated as: if any future PR projects `wait`/`uiSchema`/`contextRef` onto a public wire, that PR must either seal the column or re-justify the exemption — recorded here so it is not forgotten.
5. **Regression guards retain.** Do not touch `input_schema` (struct, read by the runtime) or `response_ref`/`payload_ref` (already sealed) — a probe against each should show they stay outside the scope.

For option A, the equivalent plan is: seal-on-write in `waitInput`; a backfill window for old rows; admin view-models must `readStored` both with `allowPlaintext` while empty; and **test 3 must be flipped to RED** before the fix lands so the work is provably load-bearing.

## 6. Files touched this packet

- Written: this receipt only.
- **Not edited:** `runtime.ts`, `metadata-crypto.ts`, `HumanWaitViewSchema`, the detector, any test.

## 7. Limitations

- Measured through the scripted-`pg` harness, not live PostgreSQL.
- **No live proof that `ui_schema` is surfaced, and no live proof it is not** — the only route that could surface it (`GET /api/v1/operations/:id`) currently omits `wait`, so this is a schema-wire mismatch, not a security boundary today. If a route change later populates `wait`, this classification must be revisited.
- The `input_schema` vs `ui_schema` distinction (struct vs business display) is asserted from the detector's own fixture shape; a stricter check would inspect a production `waitInput` call's actual payload, which needs a live window.

READ-ONLY compliance: the detector was executed; no `src/`, contract, or test file was edited; no tick/commit.