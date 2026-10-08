# WFA-VERIFY-BASELINE receipt — verify baseline + fixture prep (OC lane)

- **Task:** WFA-VERIFY-BASELINE (canonical plan `tasks/WORKFLOW-API-BACKWARD-COMPAT-2026-10-07.md` §6, supports WFA-04; dispatch spec `coordination/dispatch-specs/2026-10-07-WFA-VERIFY-oc.md`).
- **Owner/lease:** OC lane (`term_169a5da5-5a0c-4cbf-b226-7f2d51264b24`). Write scope: `tests/workflow-api/` + this report only.
- **Compliance:** NO commit, NO push; product source read-only (nothing under `services/`, `packages/`, `businesses/` was touched); verifier-owned containers left running.
- **Date:** 2026-10-07 (run window 20:52–21:05 +07). **Node:** v24.21.0 (`%TEMP%\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe`), pnpm 10.18.3, cwd `du-rework`.
- **Baseline verdict:** non-worker baseline **GREEN (exit 0)**; prep fixtures + admission scaffolding landed; **worker rerun NOT executed** (gating: qwen_2 items 1–4 still in progress — see §4).

## 1. Infra (acceptance item 1)

| Check | Result |
|---|---|
| `du-wfa-20261007-55498-pg` @ `127.0.0.1:55498` | Up, healthy port open |
| `du-wfa-20261007-56398-redis` @ `127.0.0.1:56398` | Up, port open |
| Loopback-only harness guard | `isolation.test.ts` 2/2 PASS (non-loopback URLs refused) |
| Containers stopped? | **No** — verifier-owned, left running for the main verifier |

## 2. Baseline non-worker rerun (acceptance item 2)

Command (both runs from `du-rework/`, Node 24.21.0):

```
<node24> tests/workflow-api/run-jest.cjs oc-baseline-nonworker-node24-2026-10-07.log <6 suites>
<node24> tests/workflow-api/run-jest.cjs oc-baseline-nonworker-verbose-node24-2026-10-07.log --verbose <6 suites + isolation.test.ts>
```

| Suite | Tests | Status |
|---|---:|---|
| `baseline-fixtures.test.ts` | 4 | PASS |
| `decoder-contract.test.ts` | 4 | PASS |
| `schema-catalog.postgres.test.ts` | 1 | PASS |
| `http-admission.integration.test.ts` | 5 | PASS |
| `route-projection.test.ts` | 2 | PASS |
| `http-schema-pin.integration.test.ts` | 2 | PASS |
| **Non-worker subtotal** | **18** | **exit 0** |
| `isolation.test.ts` (added for item 1) | 2 | PASS |
| **Verbose run total** | **20** | **exit 0, 7/7 suites** |

Raw logs: `tests/workflow-api/logs/oc-baseline-nonworker-node24-2026-10-07.log`,
`tests/workflow-api/logs/oc-baseline-nonworker-verbose-node24-2026-10-07.log`.

**Honest note for the verifier main:** the spec's "baseline cũ" figures (4/10/11/14/16) do not match the
current on-disk suite sizes (4/4/1/5/2/2). Nothing was removed by this lane; the suites were re-authored
earlier today (mtimes 18:23–18:56). Counts above are the current literal evidence; if the older totals were
a gate, the reduction needs adjudication by the verifier main, not a silent replace.

## 3. Prep status per acceptance item (acceptance items 3–4)

New files (all inside the lease):

| File | Purpose |
|---|---|
| `fixtures/named-processes.json` | WFA-T01..T03 case manifests: process/slug, synthetic files, variables, frozen 202 envelope keys, baseline state |
| `fixtures/leaf-nodes.json` | WFA-T15, T18..T22 manifests: loopback-only mock shapes, safe inputs, output selection, required fences |
| `fixtures/security-vectors.json` | T22/T33..T35 vectors: traversal, SSRF + redirect, prototype keys, explicit bounds (`maxFanout` flagged open), loopback mock policy |
| `wfa-verify-scaffold.test.ts` | 11 offline checks locking the fixtures + case-ID coverage vs `acceptance-cases.json` and the frozen contract |
| `named-processes-admission.integration.test.ts` | Worker-free HTTP admission baseline (real composition + isolated PG/Redis) for T01..T03 |

Evidence:

| ID | Baseline state (this lane) |
|---|---|
| WFA-T01 disbursement | Admission **202 PASS** (OC harness). Full worker path still fail-first per qwen log (`FAILED / DISBURSEMENT_ARTIFACT_UNAVAILABLE`) → **BASELINE-FAIL expected** |
| WFA-T02 lc-checker | Admission **BASELINE-FAIL (expected): HTTP 422 `input failed action schema`** — independently reproduced in the OC harness, matching qwen's finding exactly |
| WFA-T03 doc-compare | Admission **202 PASS** with two synthetic files (new independent evidence; full worker path not yet attempted) |
| WFA-T15, T18..T22 | Fixture + fence/vector scaffolding done; safe loopback mock shapes declared. Executable leaf runs remain with the worker lane (item 5 gating) |
| T33..T35 vectors | Encoded fail-closed; `maxFanout` bound still undefined by the WFA-03 contract (open item) |

Raw logs:
`tests/workflow-api/logs/oc-scaffold-node24-2026-10-07.log` (fail-first, kept),
`oc-scaffold-rerun-node24-2026-10-07.log` (11/11 exit 0),
`oc-named-admission-baseline-node24-2026-10-07.log` (T01 pass / T02 baseline-fail / T03 pass).

## 4. Worker rerun (acceptance item 5) — NOT RUN, gating condition not met

Per the dispatch directive, `http-worker.integration.test.ts` is only rerun after qwen_2 reports items 1–4
done. At execution time:

- `coordination/reports/wfa-qwen-handover-2026-10-07.md` shows qwen_2's priority item 1 (T01/T02 named
  success E2E) still in progress;
- qwen's latest raw run (`logs/named-success-first-node24-2026-10-07.log`, 20:50) is **2 failed / 8 skipped**
  for the `runs named` filter, and `http-worker.integration.test.ts` was modified at 20:53;
- no jest process was running during this lane's non-worker/admission runs, so no PG/Redis interference
  occurred; the worker suite itself was deliberately not started.

**Action for the verifier main / next OC turn:** when qwen_2 confirms items 1–4 complete, run the full
suite without `-t` filter (`run-jest.cjs oc-worker-full-node24-<date>.log tests/workflow-api/http-worker.integration.test.ts`)
and replace the stale 6+2 receipt numbers only with that literal result.

## 5. Open items handed to the verifier main

1. **T02 admission gap (HIGH for the process lane):** legacy lc-checker submit fails at input schema
   validation (HTTP 422) before any operation is created. Repro: `oc-named-admission-baseline-node24-2026-10-07.log`
   (or qwen's `named-success-first`). Owner: API lane (legacy LC input adapter).
2. **T01 worker gap:** admission is 202 but the worker ends `DISBURSEMENT_ARTIFACT_UNAVAILABLE`
   (qwen log). Owner: runtime/API lane per that receipt.
3. **Leaf-node executable evidence (T15, T18..T22):** fixtures/fences are ready and validated offline;
   the worker-driven cases still need to consume `leaf-nodes.json` in the full suite.
4. **`maxFanout` bound:** no frozen legacy number; WFA-03 contract must declare the explicit T35 bound.
5. **`docs/28-test-inventory.md` sync:** the dispatch handoff asks for it, but the strict write scope for
   this lane is `tests/workflow-api/` + report, and WFA-06 owns docs. Proposed additive section for the
   docs owner:

   ```markdown
   ## WFA-VERIFY-BASELINE — 2026-10-07 (OC lane fixtures/admission)

   `tests/workflow-api/wfa-verify-scaffold.test.ts`: 11 offline fixture-contract checks (named T01..T03,
   leaf T15/T18..T22, traversal/SSRF/prototype/bounds vectors, case-ID coverage). 11 passed, exit 0.
   `tests/workflow-api/named-processes-admission.integration.test.ts`: worker-free admission baseline —
   T01 202 PASS, T03 202 PASS, T02 BASELINE-FAIL HTTP 422. Raw logs under tests/workflow-api/logs/.
   Receipt: coordination/reports/wfa-verify-baseline-2026-10-07.md.
   ```

## 6. Evidence summary

- Commands/cwd/Node/exit/counts recorded above; every run's raw log is under `tests/workflow-api/logs/`
  (fail-first logs kept, none deleted, none skipped).
- No secrets printed: fixtures use synthetic `pdf` markers only; no API keys appear in logs added by this lane.
- Containers not stopped; no production/legacy DB touched (isolated schema per run via `isolation.ts`).
- **NO commit, NO push** — all files remain uncommitted in the shared working tree.
