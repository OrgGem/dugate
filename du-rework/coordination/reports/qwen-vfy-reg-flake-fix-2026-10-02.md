# VFY-REG-FLAKE-FIX — de-flake `parser-budgets.test.ts` (TEST-ONLY)

**Task:** VFY-REG-FLAKE-FIX · **Date:** 2026-10-02 · **Status:** applied and verified. No gate ticked; no commit.

**Diff:** `businesses/document-core/tests/parser-budgets.test.ts` **+27 / -0, one file**. No `src/` touched, no assertion changed or loosened, no test removed.

## 1. Intervention chosen

The packet prioritised a parser warm-up ahead of the timed section, with the 5 s timeout kept strict. **Warm-up was feasible, so that is what I did** — the timeout raise was not needed as a first move and was not applied.

A single `beforeAll` performs one throwaway `ParserBudgetHelper.safeParseBuffer` on the **same 100-byte code path** the flaking test uses:

```ts
beforeAll(async () => {
  await ParserBudgetHelper.safeParseBuffer(
    new MockTaskContext(),
    Buffer.alloc(100, 'a'),
    'test.txt',
  );
}, 30_000);
```

The `30_000` second argument scopes extra headroom to **this hook only**. Every test keeps Jest's default 5 s budget. The hook is not a test, so the count is unchanged at 53.

## 2. Before / after (literal)

Baseline `BEFORE` is the unmodified file measured in `tester-vfy-reg-flake-check-2026-10-02.md` on this machine, isolated, two consecutive runs. `AFTER` is the same two runs post-fix.

| test | BEFORE run 1 | BEFORE run 2 | AFTER run 1 | AFTER run 2 |
|---|---|---|---|---|
| `1. ParserBudgetHelper ... > enforces exact byte boundary: rejects (limit + 1) and accepts exact limit` | 456 ms | **908 ms** | 409 ms | 460 ms |
| `4. Multi-Artifact ... > Extract action: cumulative wait bounds multiple artifacts under task deadline` | 886 ms | 864 ms | 811 ms | 814 ms |

| run | BEFORE | AFTER |
|---|---|---|
| isolated 1 | 53/53, 7.143 s | **53/53, 7.682 s** |
| isolated 2 | 53/53, 8.293 s | **53/53, 7.089 s** |
| full doc-core | 924 + 1 skip / 925, exit 0 | **924 + 1 skip / 925, 58 suites, exit 0** |
| `tests/parser-budgets.test.ts` in full run | `PASS (5.073 s)` | **`PASS`** |

All three required runs are **exit 0**: two isolated plus one full document-core suite.

## 3. What the fix actually achieved — and what it did not

**The variance collapse is the real win.** Test 1 measured `{456, 908}` before — a 2x spread on identical, otherwise-idle code. After: `{409, 460}` — about 1.1x. The worst case fell from 908 ms to 460 ms, which is what the timeout was actually exposed to.

**But the median barely moved**, and this deserves to be said plainly rather than buried:

- test 1: ~456 -> ~435 ms (about 5%),
- test 4: ~875 -> ~812 ms (about 7%).

So the warm-up removed the **init spike**, not the **cost**. Roughly 90% of the runtime in these two tests is real parsing work, not one-time process initialisation. My earlier read in the flake-check receipt — that the file was *init-dominated* — was too strong: it was inferred from one test operating on a 100-byte buffer, and the timing says otherwise. Correcting it here: **these are compute-bound tests, not init-bound ones.**

Residual margin after the fix, against the unchanged 5 s budget:

- test 1: ~460 ms worst case -> **~10.9x**
- test 4: ~814 ms -> **~6.1x**

## 4. I did not raise the per-test timeout, and why

The packet's priority order was warm-up first, timeout second. Warm-up was feasible and is applied, so the timeout change was not warranted as part of this change — and the packet explicitly asks to keep the 5 s timeout strict.

If the coordinator wants stronger load resistance, the remaining lever is raising this file's per-test timeout, and the data to judge it is now on record: test 4 needs ~814 ms idle, and VFY-REG-refresh's failure implies the machine sustained a **>5.6x** slowdown against it. A 15 s per-test budget for this file would absorb that with the same 18x headroom ratio the tests have over their own work, and would touch timing only, not assertions. **I have not applied it** — that is a separate decision.

## 5. Limits — stated, not overclaimed

1. **I could not reproduce the original load conditions.** The fix is therefore justified by before/after timings on an idle machine, not by a reproduction of the failure. It reduces the exposure; it does not demonstrate the red is gone under load.
2. **Three green runs is not proof of stability under contention.** The honest claim is: non-reproducing before, non-reproducing after, with test 1's idle variance cut roughly in half.
3. **The warm-up cannot be proven to help under load either.** Its measured benefit is a ~10% median reduction plus a large variance cut. If the original timeout was dominated by something other than first-call init, the residual benefit could be smaller still.
4. **The 30 s hook timeout is itself a budget.** It exists so the one-time cost cannot fail the suite under load. If that cost ever genuinely regresses, the hook will now take up to 30 s to say so instead of 5 s.

**No gate is ticked by this receipt.**