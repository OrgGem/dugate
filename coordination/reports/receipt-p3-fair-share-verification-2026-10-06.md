# P3 — Independent verification & testing receipt

**Task:** P3 (Independent Verification & Testing) — unit tests for `lib/queue/worker-slots.ts` and
ProfileEndpoint limits/config invariants, plus full regression.
**Owner:** OpenCode 2 (`term_169a5da5`). **Write lease:** `tests/pipelines/` only.
**Run date:** 2026-10-07 (packet labelled 2026-10-06). **Repo:** `D:\Git\dugate` (legacy DUgate tree).
**Compliance:** no commit, no push, no task/gate tick, no product code touched (3 new files, all
untracked, all inside the lease). `lib/` modifications shown by `git status` are the implementation
lane's pre-existing dirty state, not this packet.

## 1. Deliverables (all under `tests/pipelines/`)

| File | Tests | SHA-256 |
|---|---:|---|
| `tests/pipelines/worker-slots.test.ts` | 13 | `27F70E80B6F0BCC169EF3EBD0DADC92B4EDC46DF919B585ADFE0B1CCA0867AE9` |
| `tests/pipelines/profile-endpoint-limits.test.ts` | 13 | `CB147687E01107C6EF3C0D95204600EEE44EF5818B7717648D692E5D85CC04EC` |
| `tests/pipelines/worker-slots.live-check.cjs` (bonus live Lua probe, not a jest suite) | 8 checks | `3C9AD73F61190CF0B6D9B34A58C8156FCBEBC53EEEE1A144244FB8CF0746E492` |

Artifacts under test (tree state as delivered to P3):
`lib/queue/worker-slots.ts CF012D6C…`, `lib/config.ts C7F9FF61…`, `lib/endpoints/runner.ts 8C801D09…`
(full list in `raw/…/artifacts-SHA256SUMS.txt`).

## 2. Coverage

### 2.1 `worker-slots.test.ts` (13 tests, Redis boundary mocked)
- `tryAcquireSlot`: returns `true` on script reply `1`; `false` on `0`; strict (reply `2`/`'1'` ⇒ false);
  fails OPEN (`true`) on `Error` and non-Error rejections; recovers after a transient failure;
  independent keys per `(apiKeyId, endpointSlug)`; exact EVAL args (`workerslots:{key}:{slug}`, cap/ttl
  as strings, `numKeys=1`).
- Acquire Lua contract (static pins so a future edit cannot drop them): atomic `INCR` + cap check +
  `EXPIRE` on first use + over-cap `DECR` rollback + `return 0/1`.
- `releaseSlot`: guarded `GET`-then-`DECR` script, no ARGV, resolves when key expired, never throws on
  `Error`/non-Error; strictly a no-negative DECR.
- Lifecycle: exactly one dedicated connection created and reused across acquire/release
  (`jest.isolateModules` fresh module + creation counter).

### 2.2 `profile-endpoint-limits.test.ts` (13 tests)
- Part A — config invariants (`lib/config.ts`): `MAX_CONCURRENT_PER_PROFILE_ENDPOINT` = 2,
  `WORKER_CONCURRENCY` = 5 and **2 < 5** (anti-starvation); `≥ 1`; upper bounds exactly
  **10000 req/min / 20 concurrent**; bounds above defaults; defaults `100`/`30`; substep pool ≥
  pipeline pool; integer/positive checks.
- Part B — normalization through the **real `runEndpoint`** (`lib/endpoints/runner.ts` insert point),
  only `checkRateLimit`, `profile-resolver`, `submit`, `format`, `rbac`, `file-url-downloader` mocked:
  - `rateLimitPerMin` `null` → 100/min, `0` → 100/min (never a hard block), negative → 100/min
    (defensive; admin rejects negatives), positive `250` → passthrough;
  - key `ratelimit:profile:{apiKeyId}:{endpointSlug}` and resolver called with
    `('key-123', 'extract:invoice', 'extract')`;
  - browser session (no apiKeyId): `ratelimit:endpoint:{slug}:{clientIp}` at 30/min, profile value
    ignored; `x-forwarded-for` first hop, `x-user-id` fallback, `anonymous` fallback;
  - denial → HTTP 429 + `Retry-After: 12` + `X-RateLimit-Remaining: 0` + detail carries effective
    limit, and `submitPipelineJob` is NOT called (limiter runs before heavy I/O);
  - allowed check proceeds past the limiter (fail-open path never blocks).

### 2.3 Bonus — live Lua verification (`worker-slots.live-check.cjs`, 8/8 PASS, exit 0)
The exact Lua scripts are **extracted from `lib/queue/worker-slots.ts` at runtime** and executed on a
disposable `redis:7-alpine` container (`du-p3-redis-check`, loopback `:6399`, prefix-scoped keys,
removed after): cap=2 exposes 2 acquisitions and refuses the 3rd **with the counter still at 2**
(rollback proven); TTL=30 set on first INCR; guarded DECR walks 2→1→0 and an extra release stays 0;
release after key expiry returns 0 without recreating the key; cap=1 refuses the 2nd acquire.
Log: `raw/worker-slots-live-check.log` (`pass:true, checks:8`, exit 0).

## 3. Regression results (exact commands, cwd `D:\Git\dugate`)

| # | Command | Result | Exit |
|---|---|---|---|
| 1 | `npm test -- tests/pipelines/worker-slots.test.ts tests/pipelines/profile-endpoint-limits.test.ts` | **2 suites / 26 tests passed** | **0** |
| 2 | `npx jest --roots tests --testPathIgnorePatterns "e2e" "external-api"` (all runnable legacy unit suites) | **16 suites / 177 tests passed** (includes P3's 26) | **0** |
| 3 | `npx jest --roots tests` (legacy incl. e2e) | 24 suites: 16 passed / **8 failed**; 177 passed / **40 failed tests** (the 7 e2e suites, DB/Redis-gated) + `external-api` suite fails to load (F2, 0 tests) | 1 |
| 4 | `npm test` (literal, as packet requested) | 819 of 827 suites: 216 passed / **603 failed** (all but 8 legacy failures are the `du-rework/` pnpm workspace + e2e + external-api) | 1 |

Logs: `raw/…/npm-test-p3-focused.log` (#1), `jest-tests-green-subset.log` (#2, 16/16 + 177/177),
`jest-tests-all.log` (#3), `npm-test-full.log` (#4), `jest-focused-p3.log`, plus
`jest-tests-excluding-e2e.log` (same scope as #2 without ignoring `external-api`: 16 passed + 1
pre-existing failure). Exit codes in the sibling `*-exit*.txt` files.

**Honest statement:** literal `npm test` is **not 100% green in this tree**, and none of the failures
are caused by P3. The 603 suite failures at root are pre-existing: the root `jest.config.js`
(`testMatch: '**/tests/**/*.test.ts'`) sweeps the separate `du-rework/` pnpm workspace, where Jest
dies on Haste duplicates (`@du/contracts` exists in two packages) and workspace-only configs. 100%
of the *runnable* legacy unit regression passes (#2), including both P3 suites.

## 4. Findings (outside P3 lease — reported, not fixed)

- **F1 — root jest must exclude `du-rework/`.** `jest.config.js` has no `testPathIgnorePatterns`/`roots`
  scoping, so `npm test` runs 819 suites instead of the legacy 24; 603 fail with Haste
  `@du/contracts` duplicates (e.g. `du-rework/migration-candidates/…/contracts/package.json` vs
  `du-rework/packages/contracts/package.json`). Suggested owner: repo-config lane. Evidence:
  `raw/…/npm-test-full.log`.
- **F2 — pre-existing `tests/pipelines/external-api.test.ts` suite cannot load.** Standalone run fails
  at import: `TypeError: Cannot read properties of undefined (reading 'bind')`
  (`node_modules/mammoth/lib/docx/files.js:53:47` ← `lib/parsers/word-parser.ts:1` ←
  `lib/pipelines/processors/external-api.ts:8`). 0 tests run; unrelated to worker-slots/limits.
  Needs a dependency/runtime fix lane.
- **F3 — e2e suites are environment-gated.** `tests/e2e/*.test.ts` fail on real DB writes
  (`Failed query: insert into "ApiKey"`) and closed Redis connections under default `npm test`;
  the intended runner is `npm run test:e2e` (`jest.e2e.config.js` + `tests/e2e/setup.ts`, 15 s
  timeout). Not a unit-regression signal.
- **Note — lint:** there is no ESLint config at the repo root (`npm run lint` = `next lint`, which
  would require interactive setup); lint was not part of this packet. TypeScript diagnostics are
  enforced by ts-jest in every suite above.

## 5. Conclusion

- P3 scope: **VERIFIED** — 26/26 focused tests green via `npm test`, plus an independent live-Redis
  probe of the exact Lua scripts (8/8). No product code modified; lease respected.
- Regression: **100% of runnable legacy unit suites (177/177) green**; literal `npm test` remains red
  solely on pre-existing, out-of-lease blockers F1–F3, documented above with raw logs.
- Next owner suggestions: F1 → repo-config lane; F2 → parser/dependency lane; F3 → e2e environment
  owner. Coordinator decision required if a genuinely green literal `npm test` is a release gate.

## 6. Evidence

`coordination/reports/raw/p3-fair-share-verification-2026-10-06/` — `SHA256SUMS.txt` (17 files),
`artifacts-SHA256SUMS.txt`, logs and exit-code files listed in §3, plus the live-check log.
