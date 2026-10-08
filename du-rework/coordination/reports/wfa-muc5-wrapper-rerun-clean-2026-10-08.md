# WFA MUC 5 — wrapper rerun CLEAN (3× full suite) — 2026-10-08

- **Task**: re-run the exact wrapper recipe (3 consecutive full-suite runs through
  `tests/workflow-api/run-jest.cjs`, Node 24) with `runtime.ts` restored
  byte-for-byte by qwen_2 (`c735d18e…c86`), to confirm acceptance item 5
  (3× stability) without the A/B revert window.
- **Worker**: oc_3 (OpenCode)
- **Mode**: READ-ONLY — no source/test/e2e edits, no commit/push/add, no
  `docs/21-openapi.json` edit, no gate tick.
- **Workspace**: `D:\Git\dugate\du-rework`
- **Node 24**: `%TEMP%\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe` — `v24.21.0`

## Confounder control — runtime.ts (hash checked after EVERY run)

| Checkpoint | SHA256 of `orchestrator/services/orchestrator/src/modules/runtime/runtime.ts` |
|---|---|
| pre-run 1 | `C735D18E7CE73EFF5B27EBD12EFF97764DD41ECDBA3FA7ABBB315851468B3C86` |
| post-run 1 | `C735D18E7CE73EFF5B27EBD12EFF97764DD41ECDBA3FA7ABBB315851468B3C86` |
| post-run 2 | `C735D18E7CE73EFF5B27EBD12EFF97764DD41ECDBA3FA7ABBB315851468B3C86` |
| post-run 3 | `C735D18E7CE73EFF5B27EBD12EFF97764DD41ECDBA3FA7ABBB315851468B3C86` |

- Matches the required `c735d18e…c86` at every checkpoint — no A/B revert
  occurred during this rerun. `git status`: `M` (tracked, modified vs HEAD);
  the restored revision is **not** the HEAD blob (HEAD blob sha256
  `AD03BF2924664072E3354579B1D4F9D4FDE102C875078FEE8727B6D78EE4553A`), i.e. it is
  the uncommitted fix revision, as expected.

Wrapper under test: `tests/workflow-api/run-jest.cjs` — SHA256
`65692ECC1CFCF71689E4F4D7DB1F83F056CB8C2D4C6BDE63877D76139DA02D53`, mtime
`08:33:50` (maxBuffer 64 MiB + `spawnError` fix).

## Command (each run, verbatim)

```
<node24> tests/workflow-api/run-jest.cjs wfa-muc5-wrapper-clean-run<N>-2026-10-08.log tests/workflow-api/http-worker.integration.test.ts
```

cwd: `D:\Git\dugate\du-rework` — inner command from receipt:
`node node_modules/.pnpm/node_modules/jest/bin/jest.js --config tests/workflow-api/jest.config.cjs --runInBand tests/workflow-api/http-worker.integration.test.ts`

## Results — 3/3 GREEN

| Run | Start → End (local) | Exit | Literal result |
|---|---|---|---|
| 1 | 08:47:57 → 08:48:30 | **0** | `PASS … (17.329 s)` / **`Tests: 15 passed, 15 total`** |
| 2 | 08:48:30 → 08:49:01 | **0** | `PASS … (16.211 s)` / **`Tests: 15 passed, 15 total`** |
| 3 | 08:49:01 → 08:49:33 | **0** | `PASS … (16.536 s)` / **`Tests: 15 passed, 15 total`** |

- Per-run markers: **15 pass / 0 fail** in all 3 runs (`Test Suites: 1 passed, 1 total`).
- Previously flaky tests, all green in all 3 runs:
  - `√ recovers an expired lease without repeating the completed provider stage (WFA-T26)` — 6095 / 5909 / 5897 ms
  - `√ cancels an operation while a provider stage is in flight and aborts that stage (WFA-T27)` — 1317 / 1210 / 1234 ms
- Harness: **no `spawnError:` in any run**; receipts complete (967,165 / 967,181 /
  967,181 bytes UTF-8; raw redirects ~1.95 MB UTF-16LE).

## Verdict

**Acceptance item 5 CONFIRMED for this window**: 3/3 consecutive full-suite runs
through the wrapper returned exit 0 with `Tests: 15 passed, 15 total`, with the
runtime.ts hash verified constant at `c735d18e…c86` before/after every run.

## Notes (facts recorded, no interpretation)

1. The previous wrapper rerun (08:34–08:36, separate receipt) was 1 green / 2 red
   (WFA-T27). This clean rerun is 3/3 green. Both results stand as measured; the
   difference between the two windows is left for the owner to explain.
2. Factual observation for the record: the restored runtime.ts mtime is
   `2026-10-08T07:46:59`, which **predates** the previous wrapper rerun
   (08:34–08:36) and the VERIFY-6 runs (07:55–07:58). The hash is verified
   constant during THIS rerun; whether the earlier windows ran different content
   cannot be determined from the current tree state (a timestamp-preserving
   restore would look identical). Recorded so the earlier red results are not
   attributed to the revert window without independent evidence.
3. Exactly 3 runs were performed as prescribed — no retry-to-green.

## Evidence inventory (`coordination/reports/raw/wfa-muc5-wrapper-rerun-clean-2026-10-08/`)

| File | Content |
|---|---|
| `META.txt` | wrapper hash/mtime, runtime.ts hash checkpoints, verbatim commands, timestamps, exit codes |
| `clean-run1.log` / `clean-run2.log` / `clean-run3.log` | raw stdout of each wrapper run — 15/15, exit 0 |
| `repo-wrapper-log-clean-run{1,2,3}.log` | copies of `tests/workflow-api/logs/wfa-muc5-wrapper-clean-run<N>-2026-10-08.log` |

Repo log files are written by the prescribed wrapper and are gitignored
(`du-rework/.gitignore:15 *.log`). No commit/push/add was performed.
