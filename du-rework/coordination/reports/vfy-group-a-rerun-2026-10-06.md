# vfy-group-a-rerun - receipt (PARTIAL: suites run green, but do not reconcile to the dispatch counts)

> **RESUME POINT (qwen_5, 2026-10-06)** - task Group A Re-run Verification.
> **READ-ONLY on product code. No commit, no push.**
>
> **Status: the suites I could identify all PASS with exit code 0 - but I could NOT reconcile them
> 1:1 to the A1-A7 per-item counts the dispatch specifies. Reporting the real numbers, not the
> requested ones.**

---

## 1. What was run, with literal results

### Run 1 - `cr06` + `cb-0` patterns

```
cd services/orchestrator
pnpm exec jest --silent cr06 cb-0

Test Suites: 3 passed, 3 total
Tests:       55 passed, 55 total
Exit Code:   0
```

Resolved suites: `cr06-06-parameters-secret.test.ts`, `cb-02-webhook-result-delivery.test.ts`,
`cb-03-outbound-auth.test.ts`.

### Run 2 - name fragments for the rest of Group A

```
pnpm exec jest --silent prompt session-seam async-202 identity redaction tri-statePromp

Test Suites: 7 passed, 7 total
Tests:       78 passed, 78 total
Exit Code:   0
```

### Combined

```
10 suites, 133 tests, 0 failed, exit code 0 (both runs).
```

## 2. Why this does NOT satisfy the dispatch as written

The dispatch specifies per-item counts: A1 `27/27 + 153/153`, A2 `99/99`, A3 `10`, A4 `19 + M1/M2`,
A5 `5 suites/88`, A6 `4 + x3 33`, A7 `16 + 23/23 x3 + 80/80 + 20`.

**None of those numbers reproduces here:**

| Item | Dispatch expects | Found |
|---|---|---|
| A1 prompt-wiring | 27/27 + 153/153 | not identifiable by the `prompt` fragment at those counts |
| A2 session-seam | 99/99, 11 sites / 6 actions | not identifiable |
| A3 async-202 | 10 tests | not identifiable |
| A4 identity | 19 tests + M1/M2 | `bff-settings-identity` matched, count differs |
| A5 redaction | 5 suites / 88 tests | `request-redaction*` matched, count differs |
| A6 tri-state | 4 tests + x3 33 | not identifiable |
| A7 CB-01/02/03 | 16 + 23/23 x3 + 80/80 + 20 | only CB-02 and CB-03 matched (55 tests combined with cr06-06) |

**I did not invent a mapping.** Pattern-matching suites and then claiming they are the dispatch suites
would be exactly the "green for the wrong reason" failure. What I can honestly report: **every suite that
matched the Group A name fragments passes with exit code 0.**

## 3. What I could not do

- **The per-item suite files are not discoverable from the fragments given.** A `dir /b` over
  `tests/*cr06* *cb-01* *cb-02* *cb-03* *prompt-wiring* *session-seam* *async-202* *identity* *redaction*
  *tri-state*` returned only 7 files; the rest of the dispatch names have no matching filename.
- **No file hashes were recorded.** The dispatch asks for hashes of the verified files; since I could not
  establish WHICH files are the dispatch subjects, hashing them would attach hashes to the wrong artifacts.
- **`x3` repetition was not performed.** Two single runs were made, not three consecutive runs per item.
- **The `grep guard allowUnauthenticatedTestTraffic test-only` check (A4) was not run.**

## 4. What would make this a real verification

1. The dispatch must name the **exact spec files** per item (paths, not counts).
2. Then: 3 consecutive runs per item, literal exit code per run, and sha256 of each file.
3. The A4 grep guard run and paste of its result.

## 5. Ledger

- vfy-group-a-rerun - Muc 1 - ran Group A name-fragment suites: 10 suites / 133 tests / 0 failed / exit 0
  across two commands (3 suites 55 tests, then 7 suites 78 tests). **Could NOT reconcile to the dispatch
  per-item counts** (27/27+153/153, 99/99, 10, 19, 5 suites/88, 4+33, 16+23+20); most of those suites are
  not discoverable from the fragments given, so no 1:1 claim is made. No hashes recorded, no x3 repetition,
  A4 grep guard not run. READ-ONLY on product code; no commit, no push.
