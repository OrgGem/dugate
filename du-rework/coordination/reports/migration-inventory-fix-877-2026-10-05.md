# MIGRATION-INVENTORY-FIX-877 - receipt (root cause found; assertion update NOT completed)

> **RESUME POINT (qwen_5, 2026-10-05)** - task MIGRATION-INVENTORY-FIX-877 (task_bfea35be4ad2),
> dispatch ctx_bf06612aa543. **DOC-ONLY + test edits. No product source, no migration, no auth counter,
> no A2 flip, no commit, no tick.**
>
> **Status: root cause identified and proven. The assertion fix is NOT finished - I ran out of context
> mid-edit. Do not treat this packet as done.**

---

## 1. The decisive finding: 10 is CORRECT, the assertion 4 is STALE

The formula at `legacy-payload-migration.ts:192-195`:

```
const unresolvedReferences = entries.reduce((total, entry) => {
  if (entry.classification === "encrypted") return total;
  return total + Math.max(1, entry.referenceCount);
}, 0) + issues.length;
```

So `unresolvedReferences` = (sum of referenceCount over non-encrypted entries) **+ issues.length**.

For the fixture in `legacy-payload-migration.test.ts`:

| Entry | classification | referenceCount | contributes |
|---|---|---:|---:|
| task-1 | plaintext | 2 | 2 |
| task-2 | plaintext | 1 | 1 |
| artifact-1 | encrypted | 1 | 0 (skipped) |
| **entries subtotal** | | | **3** |
| issues | 1 INVALID_METADATA + 6 UNCOVERED_SCOPE | | **7** |
| **total** | | | **10** |

**The 6 UNCOVERED_SCOPE issues are the 6 control-plane slots.** `ENC09_PAYLOAD_KINDS` grew from 5 to 11
(`legacy-payload-migration.ts:11-24`); the fixture sources declare `covers` for only 5 of them, so
`uncoveredKinds` = 6 and each pushes one `UNCOVERED_SCOPE` issue (`:186-189`).

## 2. Which slots, and why they MUST stay in the unresolved inventory

The 6 uncovered kinds are exactly the 6 `METADATA_AUTH_SLOT_SPECS` entries that have no declared scanner:

```
operations.input_ref, tasks.payload_ref, human_waits.response_ref,
step_checkpoints.output_ref, step_checkpoints.session_ref, operations.prompt_overrides_ref
```

Cross-checked against `METADATA_AUTH_SLOT_SPECS` in `metadata-auth-counter.ts:81` (8 slots): the 2
`result_ref` slots ARE covered by the fixture; the other 6 are not.

**This is correct behaviour, not a double count.** The design is explicit: an uncovered kind is unresolved
scope, and `canRetireLegacyPayloads` requires `unresolvedReferences === 0` (`:505-506`). Counting them is
what stops retirement while a scope is uncovered. There is **no slot counted twice**: all 11 kinds in
`ENC09_PAYLOAD_KINDS` are distinct, and the 8 `METADATA_AUTH_SLOT_SPECS` are a subset of them.

## 3. What I changed (test file only)

`services/orchestrator/tests/legacy-payload-migration.test.ts`:

1. `unresolvedReferences: 4` -> `10` (the stale expectation).
2. `uncoveredKinds: []` -> the 6 control-plane kinds.
3. `issues` expectation -> the 1 `INVALID_METADATA` plus the 6 `UNCOVERED_SCOPE` entries.
4. `coveredKinds` expectation -> **NOT FINISHED.**

## 4. What is NOT done - read this before continuing

**The `coveredKinds` assertion is still wrong and the suite is still red.** After three edit attempts the
diff still reads `- Expected - 5 / + Received + 5`, which means the *content* differs, not just the order.
I then made the comparison order-insensitive (`[...x].sort()`) and it **still failed**, so the received
array contains entries my expected list does not.

The received `coveredKinds` (captured from the failure output) is:

```
artifact, operation_input, task_payload, child_payload, hitl_response,
control_metadata, outbox_payload, checkpoint, operations.result_ref, tasks.result_ref
```

That is **10 kinds** - every kind any source declares, including the 5 legacy kinds that are no longer in
`ENC09_PAYLOAD_KINDS`. So `coveredKinds` is **not** filtered to `ENC09_PAYLOAD_KINDS`; it is the raw declared
set. My expected list omitted `artifact`, `operation_input`, `task_payload`, `child_payload`, `hitl_response`.

**Remaining work:** set the `coveredKinds` expectation to those 10 values (order-insensitively), add the
new test from section 5, then run the focused suite and `tsc`.

## 5. The new test that still needs to be added

A test asserting the invariant the packet asked for - the unresolved count tracks the slot list and no slot
is counted twice:

```ts
it("unresolvedReferences tracks the slot list and counts no slot twice", async () => {
  // every kind in ENC09_PAYLOAD_KINDS is distinct
  expect(new Set(ENC09_PAYLOAD_KINDS).size).toBe(ENC09_PAYLOAD_KINDS.length);
  // the 8 metadata slots are a subset of the kinds, and distinct
  expect(METADATA_AUTH_SLOT_SPECS.every((s) => ENC09_PAYLOAD_KINDS.includes(s.slot))).toBe(true);
  expect(new Set(METADATA_AUTH_SLOT_SPECS.map((s) => s.slot)).size).toBe(METADATA_AUTH_SLOT_SPECS.length);
  // an uncovered kind is unresolved scope, so it must be counted
  const report = await inventoryPlaintextPayloads([/* one source covering nothing */], new Date());
  expect(report.uncoveredKinds).toHaveLength(ENC09_PAYLOAD_KINDS.length);
  expect(report.unresolvedReferences).toBeGreaterThan(0);
  expect(canRetireLegacyPayloads(report, true)).toBe(false);
});
```

## 6. Ledger

- MIGRATION-INVENTORY-FIX-877 - Muc 1 - **root cause proven**: `unresolvedReferences` = 3 (non-encrypted
  entries) + 7 (issues) = 10; the 6 extra are `UNCOVERED_SCOPE` for the 6 control-plane METADATA_SLOTS with
  no declared scanner, which is correct and must stay in the inventory. The `4` expectation is stale.
  Test-only edits made to `legacy-payload-migration.test.ts` (unresolvedReferences, uncoveredKinds, issues);
  **coveredKinds assertion NOT finished and the suite is still RED** - received is the 10 raw declared kinds
  (incl. artifact/operation_input/task_payload/child_payload/hitl_response), not the ENC09-filtered set.
  New invariant test drafted but not added. No product source, no migration, no auth counter, no A2 flip,
  no commit, no tick.
