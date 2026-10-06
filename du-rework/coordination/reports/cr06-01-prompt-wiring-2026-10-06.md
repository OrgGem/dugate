# CR06-01 — promptStepId wiring for disbursement + doc-compare — receipt

Task: CR06-01 (Priority HIGH), parents T-PROM-02 / P763-PROMPT-WIRING. Owner lane: document-core.
Date: 2026-10-06. Source of finding: `tasks/CODE-REVIEW-FOLLOWUP-2026-10-06.md` §CR06-01 (re-read code on the
working tree before editing). Status: **offline implementation + focused tests complete; independent verify and
Claude Code `APPROVED` still required; parent T-PROM-02 + live leg stay open. No commit, no tick.**

## 1. What was wrong

`businesses/document-core/src/worker.ts` disbursement runtime called `internal.connector.invoke` without
`promptStepId` at classify/extract/crosscheck (`:931-949` in the review) and report (`:1060-1064`), and
`pipelines/workflows/doc-compare/runner.ts` `runChunk` (`:368-376`) merged only caller `invocationOptions` +
`responseFormat`. The adapter chokepoint (`worker.ts:418-425`) only substitutes the pinned prompt when
`options.promptStepId` is non-empty, so both workflows bypassed the whole prompt-override wiring.

## 2. Change

Workflow-owned step keys are now stamped at every invoke; the 6 core actions were already wired and are untouched.

| File | Change | Anchors (current) |
|---|---|---|
| `src/worker.ts` | import `STEP_KEYS`; `invokeJson(..., promptStepId)` passes `{ responseFormat:'json', jsonSchema, promptStepId }`; classify → `STEP_KEYS.DISBURSEMENT.CLASSIFY`; extract → `...EXTRACT`; crosscheck → `...CROSSCHECK`; report options gain `promptStepId: STEP_KEYS.DISBURSEMENT.REPORT` | `:1002`, `:1038`, `:964`, `:1071`, `:1085` |
| `src/pipelines/workflows/doc-compare/runner.ts` | import `STEP_KEYS`; `runChunk` stamps the stage key **after** the caller spread so it cannot be dropped/replaced: `compare-structure → COMPARE_STRUCTURE`, otherwise `COMPARE_REFERENCES` | `:382-384` |

Semantics preserved: `invokeJson`'s checkpoint hash is still `stableJsonHash({slot, task, payload})` — the new
options field does not alter inputHash/replay identity; the adapter still strips `promptStepId`/`sessionRef` before
the strict provider options (no wire/contract change, no log of prompt content). A caller-supplied
`invocationOptions.promptStepId` can no longer override the workflow stage key (deliberate: that was the bypass).

## 3. Tests — failing before, passing after

New/added tests (all in document-core Jest):

| Test | Proves |
|---|---|
| `tests/p9-03-doc-compare-runner.test.ts` › CR06-01 › `stamps the stage promptStepId on every chunk invoke` | both chunk stages carry `doc-compare/compare-structure` / `doc-compare/compare-references` |
| same file › `keeps the workflow stage key even when invocationOptions supplies another promptStepId` | a caller cannot replace/drop the stage key |
| `tests/disbursement-handler.test.ts` › `CR06-01: pinned prompt overrides reach every disbursement connector invoke` | observed connector request per stage: exact row (classify, report), `_default` row (crosscheck), cleared exact row via whitespace → connector default (extract); all four through the real handler + adapter |
| same file › `CR06-01: null profilePolicy keeps connector defaults (no guessed binding)` | `profilePolicy: null` (admitted-without-policy) never applies pinned rows even though the stepId now travels |

RED evidence (before source fix), raw log `raw/cr06-01/red-before-fix.log`, exit 1:

```
Tests: 3 failed, 23 passed, 26 total
doc-compare: Expected "doc-compare/compare-structure" · Received: undefined
doc-compare caller override: Expected "doc-compare/compare-structure" · Received: "caller-supplied-key"
disbursement: Expected "PINNED CLASSIFY" · Received: "Classify the supplied source file…" (the default)
```

GREEN evidence (after fix):

| Command (cwd `du-rework`) | Exit | Result | Log |
|---|---|---|---|
| `pnpm --filter @du/document-core exec jest --runTestsByPath tests/disbursement-handler.test.ts tests/p9-03-doc-compare-runner.test.ts --verbose` | 0 | **27 passed / 27** (2 suites) | `raw/cr06-01/green-final-focused.log` |
| `pnpm --filter @du/document-core exec jest --runTestsByPath tests/p9-01-disbursement.test.ts tests/disbursement-handler.test.ts tests/p9-03-doc-compare.test.ts tests/p9-03-doc-compare-handler.test.ts tests/p9-03-doc-compare-runner.test.ts tests/p9-03-doc-compare-registration.test.ts tests/p745-carrier-impl-b2.test.ts tests/p745-session-capture-inject.test.ts` | 0 | **153 passed / 153** (8 suites) | `raw/cr06-01/regression-final.log` |
| `pnpm --filter @du/document-core lint` (`tsc --noEmit -p tsconfig.json`) | 0 | clean | `raw/cr06-01/lint-final.log` |

Pre-existing, not caused by this packet: `pnpm --filter @du/document-core test:typecheck` exits 2 with
`profilePolicy`-missing errors in `tests/bullmq-smoke.test.ts:144`, `tests/provider-backed-variant.test.ts:413`,
`tests/sdk-consumer.test.ts:203/471/615/711` — none of these files were touched; src lint is clean
(`raw/cr06-01/typecheck-tests.log`).

## 4. Acceptance mapping (honest, not full closure)

| Acceptance item | Status here |
|---|---|
| Every connector invoke carries `promptStepId` | Done for scoped sites; static re-check: only remaining `connector.invoke` calls are the adapter passthrough (`worker.ts:393/460`), the wired dispatcher (`:964/1085`) and the doc-compare port forwarder (`runner.ts`/`worker.ts:1548`) |
| Observed provider request key-4/exact/`_default`/cleared/null semantics | Offline-proven through the real handler + adapter for disbursement (4 semantics) and the port for doc-compare |
| A pin giữ qua publish B/child/retry/HITL | Child + approval-wait/HITL resume paths are exercised; publish-B/retry and live pin retention are **live scope**, not claimed here |
| no-log/no-duplicate | No logging added; checkpoint hash unchanged (replay identity stable) — `no-duplicate` replay itself is covered by the existing checkpoint tests, not re-run live |
| Independent verify + Claude Code `APPROVED` | **Pending** — packet not accepted |

## 5. Evidence index and file hashes

| File | SHA-256 |
|---|---|
| `src/worker.ts` | `BED6EFBC71B235365DAEA87E3353D6036E6723F48799EDDA527A7B4FF8A81F8D` |
| `src/pipelines/workflows/doc-compare/runner.ts` | `793CCBCAF6D7513BDDF47A747550672C13E5FD9ED0C009CC604385E0E53F5A95` |
| `tests/disbursement-handler.test.ts` | `57C6818FB79D724D663A6D34AC5A82ACE568FCE0D303DDD0DC0598F953160C40` |
| `tests/p9-03-doc-compare-runner.test.ts` | `64F39B79CBD62FD6D138AEFE483350BB7897D51D944BE24F1CD3D2446E590311` |
| `src/recipes/step-keys.ts` (read-only input) | `F0A0097C65D4BFBCE8F77D0C311E6151EDCEAFA877F45A398F48CB820A2F23F1` |

Raw logs under `coordination/reports/raw/cr06-01/`:
`red-before-fix.log` `E3E168EADE9D7D9FEBDDCF8BCACD0F636026E5DC03060B2501425DB3DCA423E2`,
`green-final-focused.log` `0287BA4400ADD3977194AFFF933370A5A2D6A7C123B2A4822AFC59492814907A`,
`regression-final.log` `0F01AF7EDD8107E554BD6035CD9DE85C493CBBEAB0F56F7B645E55630101673B`,
`lint-final.log` `3F67289D3231E7EB80554B6DAEF9A3B79C10C3B97B6475682E1430F6E0467181`,
`typecheck-tests.log` `6EBCAFE90C02F80BC83B46141EFAE20BCACB529EF7212B65D52FA546E9CE49D7`.

## 6. Handoff / next

1. Independent Codex Tester: re-read the two source files, run the RED→GREEN commands above (or equivalents), and
   verify the negative cases (caller override can never win; null policy unsubstituted).
2. Claude Code review `APPROVED` for CR06-01 before the coordinator closes the finding; parent T-PROM-02 and the
   live/provider-observed leg remain open and are not moved by this receipt.
3. No commit/tick/push performed; only the four files above were edited by this packet.
