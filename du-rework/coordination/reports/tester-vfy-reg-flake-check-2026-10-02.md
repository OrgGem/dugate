# VFY-REG-FLAKE-CHECK — `parser-budgets.test.ts` re-run in isolation

**Task:** VFY-REG-FLAKE-CHECK · **Date:** 2026-10-02 · **Status:** verification only. Read-only: no test, code or guard modified; no gate ticked; no commit.

## 1. Isolated runs (objective 1 and 2) — literal

Command, run from `D:\Git\dugate\du-rework` with **no other suite of mine running**:

```
pnpm --filter @du/document-core test -- tests/parser-budgets.test.ts --runInBand
```

| run | result | tests | time |
|---|---|---|---|
| **run 1** | `PASS tests/parser-budgets.test.ts` | `53 passed, 53 total` | 7.143 s |
| **run 2** | `PASS tests/parser-budgets.test.ts` | `53 passed, 53 total` | 8.293 s |

Both runs: `Test Suites: 1 passed, 1 total`, `Snapshots: 0 total`. **0 failed, twice.**

## 2. The two tests that timed out in VFY-REG-refresh — both green

VFY-REG-refresh recorded exactly two failures, both *exceeded Jest 5,000 ms test timeout* in this file. Measured here, in isolation:

| previously timing out | run 1 | run 2 |
|---|---|---|
| `1. ParserBudgetHelper Unit & Bounds Enforcement > enforces exact byte boundary: rejects (limit + 1) and accepts exact limit` | **456 ms** | **908 ms** |
| `4. Multi-Artifact Cumulative Wait & Compare Both Sides > Extract action: cumulative wait bounds multiple artifacts under task deadline` | **886 ms** | **864 ms** |

Neither reproduces. To trip a 5,000 ms timeout they would each have needed roughly **11x** and **5.6x** slowdown respectively.

## 3. Full-suite run — the comparison VFY-REG-refresh could not reach

```
pnpm --filter @du/document-core test
```

```
PASS tests/parser-budgets.test.ts (5.073 s)
Test Suites: 58 passed, 58 total
Tests:       1 skipped, 924 passed, 925 total
exit code 0
```

| | VFY-REG-refresh | this run |
|---|---|---|
| Tests passed | 922 | **924** |
| Tests failed | **2** | **0** |
| Tests skipped | 1 | 1 |
| Tests total | 925 | 925 |
| Test Suites | — | 58 passed |
| exit code | **1** | **0** |

This is the `924 passed + 1 skipped / 925` benchmark that VFY-REG-refresh explicitly said it could not reach. Note that `parser-budgets` **also passed inside the full 925-test run**, so the timeout is not caused by the full suite itself.

The single skip is the live-projection test, gated on `DU_LIVE_INFRA` being unset — unchanged from the refresh receipt, not a new gap.

## 4. Timing vs logic (objective 3, bounded)

No bounded code read was required for correctness, because nothing failed. I did read the tighter-margin test (`tests/parser-budgets.test.ts:256-271`) to characterise the margin, and it is informative:

```
const limit = 100;
const exactBuf = Buffer.alloc(limit, 'a');
const overBuf = Buffer.alloc(limit + 1, 'a');
```

The test operates on **100- and 101-byte buffers**. Its 456-908 ms cannot be CPU work proportional to input size — the cost is dominated by **first-call initialisation** (module load, parser selection, JIT warm-up) rather than by the test's own logic. That has two consequences:

1. It explains the observed variance: the same test swung **456 ms to 908 ms — a 2x spread — between two consecutive runs with no added load.** A logic defect does not do that.
2. It explains the fragility: an init-dominated test has an 11x margin to the timeout in isolation, and init cost is exactly what degrades first under memory/CPU contention from concurrent suites. That is consistent with the `codex-conv06-impl` history (timeouts under load, not reproducible alone).

**I am not claiming a regression, and I am not claiming the flake is closed.** Three consecutive green runs — two isolated, one full-suite — on this machine at this moment are evidence of non-reproduction *now*. They do not prove the original two timeouts were environmental rather than a latent timing-sensitivity in the test. Distinguishing those would need the original run's load conditions.

**What the evidence does support:** the red is not deterministic, the code path under test passes, and the suite reaches the expected `924 + 1 skip` benchmark with exit 0.

## 5. Recommendation (not applied — read-only)

If VFY-REG needs the red to stay closed through future runs, the durable fix is not a code change but a **timeout/scheduling** one, for the specific test with the thin margin:

- the 5,000 ms per-test timeout is what turns load into a red; the test itself needs ~0.9 s and does trivial work;
- raising the per-test timeout for this file, or warming the parser before the timed section, would remove the coupling to machine load without touching assertions.

I did not make this change — it is outside the read-only boundary and is a Tester/coordinator call.

**No gate is ticked by this receipt.**