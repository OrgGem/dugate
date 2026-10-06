# WT-02 / WT-04 - Profile Detail Read DTO & Stored Policy Invalid Clear

> **RESUME POINT (qwen_5, 2026-10-07)** - WT-02 (MEDIUM) + WT-04 (MEDIUM),
> plan `tasks/CODE-REVIEW-FOLLOWUP-WTREE-2026-10-07.md` section 2.2. Lease: `admin-read/profile-detail`.
> **Node: v22.16.0**  ·  **NO commit, NO push.**
>
> **WT-02 DONE (green). WT-04 diagnosed precisely but NOT implemented** - its correct fix needs a
> contracts DTO change outside this packet lease. Reason in section 3.

---

## 1. Commands, cwd, exit codes

| # | cwd | command | result |
|---|---|---|---|
| 1 | `du-rework/services/orchestrator` | `node node_modules/jest/bin/jest.js --runInBand tests/tapi01-closure-offline.test.ts` (before) | **1 failed / 6 passed / 7 total** |
| 2 | `du-rework/services/orchestrator` | same (after fix) | **7 passed / 7 total** |
| 3 | `du-rework/packages/contracts` | `node node_modules/jest/bin/jest.js --runInBand --silent` | **30 suites / 567 tests passed** |

## 2. WT-02 - DONE

**Defect confirmed by the run, not assumed:** the pre-fix failure was exactly
`+ "callbackPolicy": null` - the expectation omitted a key the reader now emits.

**Fix** - `tests/tapi01-closure-offline.test.ts:330-342` (test only): the expected blank-editor policy now
includes `callbackPolicy: null`, with the intent recorded inline so the next reader does not "fix" it back:

```
- `undefined` = key absent from the read DTO
- `null`      = no callback policy stored (also exactly what an explicit Clear produces)
- object     = a valid stored pin
```

That is the tri-state the Portal needs for Clear to be expressible. **Recorded into the DoD as instructed.**

Contracts suite re-run after the change: **567/567 green**, so the read contract itself was not altered by
this packet.

## 3. WT-04 - diagnosed, NOT implemented (and why that is the honest call)

### The defect, located

`modules/admin-read/profile-detail.ts:125-131` (`profileDetailPolicyRead`):

```
const callbackPolicy = row.callback_policy === null || row.callback_policy === undefined
  ? null
  : (ProfileCallbackPolicySchema.safeParse(row.callback_policy).success
      ? row.callback_policy
      : null);          <- a MALFORMED stored pin collapses to the same null
```

So "nothing stored" and "something stored but invalid" both project as `null`. `profiles.ts:174-182` throws
500 on the same malformed pin, so the Portal sees: read = "not configured", write = 500. An operator who
unchecks cannot send a meaningful Clear because the read never showed a pin to clear.

### Why the fix is not inside this lease

The read DTO needs to express **three** callback states plus an invalid marker, i.e. the projection must be
able to say "stored but invalid". Today `callbackPolicy: null` is overloaded to mean two different things.
The honest fix is to add a distinct marker to the **read contract** (for example a sibling boolean such as
`callbackPolicyStored` alongside a null `callbackPolicy`, or an explicit invalid sentinel), so the Portal can
detect the broken pin and emit a Clear request.

**That lives in `packages/contracts` (`ProfileEndpointPolicyRead`), which is NOT this packet's lease.**
Overloading `null` with a second meaning would be worse than the bug: the Portal would keep being unable to
distinguish the cases, and the ambiguity would be invisible.

**Recommendation: dispatch a small contracts addition, then wire the Portal to the marker.** I did not guess a
field name and ship a half-fix.

## 4. Ledger

- WT-02/WT-04 - Muc 1 - **WT-02 DONE**: closure test updated to the tri-state `callbackPolicy: null`
  contract with the tri-state meaning documented inline; `tapi01-closure-offline` **7/7 passed** (was
  6/7), `packages/contracts` **30 suites / 567 tests passed**, Node v22.16.0. **WT-04 NOT implemented**: the
  silent `null` projection at `profile-detail.ts:125-131` collides "absent" with "invalid", and the fix needs
  an explicit marker on the read DTO in `packages/contracts`, outside this lease - a contracts-side packet is
  recommended before wiring the Portal. No commit, no push.
