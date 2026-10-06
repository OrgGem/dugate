# Receipt — Legacy root semaphore: WT-10/WT-12 re-verify + WT-11/F-P1-01 fix — 2026-10-07

- **Packet:** "Legacy Root Fair-share & Semaphore (P1 Re-verify, WT-11, F-P1-01, WT-12)".
- **Owner:** OpenCode (`term_cefb27a0`). **Mode:** WORKER.
- **Repo scope:** legacy root `D:\Git\dugate` ONLY — no `du-rework/` file touched. **Code freeze:** no commit, no push,
  no task-row tick.
- **Status:** WT-10 verified-resolved; WT-12 verified (redundant casts removed); WT-11 + F-P1-01 fixed with
  failing-first evidence; focused suites **30/30 green**, `npx tsc --noEmit` **exit 0**. Literal
  `npm test -- tests/pipelines/` stays exit 1 **solely** on the pre-existing `external-api.test.ts` load failure
  (P3 F2, unrelated mammoth import) — everything else in scope is green.

## 1. Files changed (before → after SHA-256)

| File | Change | Before | After |
|---|---|---|---|
| `lib/queue/worker-slots.ts` | Rolling `EXPIRE` (WT-11) + `SlotAcquireOutcome` contract (F-P1-01) + `Logger` warns | `CF012D6CC954CCADEDF52AADD9A8215935751315270CC5058EF5C70117D59820` (P3 artifact) | `04B1A4FB1BBCFC42B43E68321CA84BECAF5F8D489AD4F0D0B14B1120AC1B223E` |
| `worker.ts` | Consume the outcome: `contended` → delay+`DelayedError`; `fail-open` → run WITHOUT slot, never release | `F09F9AC80AC2626A992BA9897EF4199A277464676C93B7A83B2E979E542391E9` (P1 receipt) | `5596E75C9C0DA5D5F596BF811E7646778C7EB96A45DB4E2E3B713AFBED1BA916` |
| `lib/endpoints/runner.ts` | WT-12: removed 2 redundant casts (`:199`, `:289`) | `8C801D09FA20F5A1391A245702996633946FC90871E16664A8C0DDDF4A614DB3` (P3 artifact) | `412818F92830101BAB9A24EC03356D8B7F9C39C53D68C4330F5E08B79284B401` |
| `tests/pipelines/worker-slots.test.ts` | Updated to the outcome contract + Lua-refresh assertions + warn assertions | `27F70E80B6F0BCC169EF3EBD0DADC92B4EDC46DF919B585ADFE0B1CCA0867AE9` (P3 artifact) | `B0C98841D0B47BDB6549CD0619952E96726623B402A779451F727833CA7EA256` |
| `tests/pipelines/worker-slots-fail-open.test.ts` | **New** failing-first regression (WT-11 + F-P1-01) | — | `202B29F7F66D9CD69B03FFF9FA18FE07CE6FFBB69CB9BDA63644D123C1AC5C4B` |
| `lib/config.ts` | Untouched (verified) | `C7F9FF611906326680CCE30E31B74B2BF9F73B65FE8057E072B4AB138DF97E61` | same |
| `tests/pipelines/profile-endpoint-limits.test.ts` | Untouched (verified) | `CB147687E01107C6EF3C0D95204600EEE44EF5818B7717648D692E5D85CC04EC` | same |

## 2. WT-10 re-verify (semaphore no longer dead code) — CLOSED

- Call-sites are live and stable in `worker.ts`: import `:29`, acquire `:76`, ownership decision `:89`, release
  `:97` (`worker.ts` after-hash above).
- `npm test -- tests/pipelines/` baseline run: **36 tests passed** (3 suites; the 4th, `external-api.test.ts`,
  fails to load pre-existing). Semaphore unit suite included and green.
- Verdict: WT-10 (zero call-site) is resolved; the P1 receipt's fix is in the current tree.

## 3. WT-12 re-verify (redundant casts) — CLOSED

- `loadProfileEndpoint` returns `ProfileEndpoint | null` (`lib/endpoints/profile-resolver.ts:24-28`) and the schema
  declares both columns (`lib/db/schema.ts:134-135`: `rateLimitPerMin`, `maxConcurrent`, nullable integers), so the
  casts `as { rateLimitPerMin?: number | null }` / `as { maxConcurrent?: number | null }` were redundant.
- Removed: `runner.ts:199` → `const raw = profileEndpoint?.rateLimitPerMin;`, `runner.ts:289` →
  `maxConcurrent: profileEndpoint?.maxConcurrent ?? null,`. Behavior identical; `npx tsc --noEmit` exit 0 and the
  producer-side normalization suite (`profile-endpoint-limits.test.ts`, 13 tests) stays green.

## 4. WT-11 fix — rolling TTL on every successful acquire

Before (P3 artifact): `INCR` → `if cur == 1 then EXPIRE` → over-cap rollback → `return 0/1`, i.e. the TTL was set
only when the key was created; a key with active holders could expire mid-flight and re-admit past the cap.

After (`lib/queue/worker-slots.ts:48-58`): `INCR` → over-cap `DECR` rollback + `return 0` → **`EXPIRE` on every
successful acquire** → `return 1`. The over-cap path leaves the existing TTL untouched.

Evidence: new failing-first test `WT-11: refreshes EXPIRE on every successful acquire…` was RED before the fix and is
GREEN after; the updated Lua-contract test pins “no `if cur == 1 then`” and “EXPIRE after the cap check”.

Residual limitation (documented, not fixed): the refresh is triggered by successful acquires; a single holder whose
run exceeds the TTL with no concurrent acquires can still see the key expire. A per-holder lease/heartbeat is the
complete fix. Operators can raise the worker's `WORKER_SLOT_TTL_SECONDS` (default 900) meanwhile.

## 5. F-P1-01 fix — fail-open is distinguishable and never releases

- Contract: `export type SlotAcquireOutcome = 'acquired' | 'contended' | 'fail-open'`
  (`lib/queue/worker-slots.ts:37`). Only `'acquired'` owns a slot.
- Worker consumption (`worker.ts:76-89`): `'contended'` → `moveToDelayed` + `throw new DelayedError()` (unchanged);
  `'fail-open'` → job runs without a slot and `acquired` stays `false`, so the `finally` (`:95-99`) never calls
  `releaseSlot` — a fail-open can no longer DECR another holder's counter.
- Logging via `lib/logger.ts` (`new Logger({ service: 'worker-slots' })`): fail-open acquire `warn`
  (`worker-slots.ts:89-93`), unexpected script reply `warn` + treated as contended (`:80-86`), failed release `warn`
  (`:112-115`). No error is swallowed silently anymore.
- Failing-first evidence: `tests/pipelines/worker-slots-fail-open.test.ts` asserts (a) the distinguishable outcome +
  warn, (b) a worker-style guard issues **zero** release EVALs after a fail-open, (c) positive control releases once.
  It ran **RED first** (3 failed / 1 passed, exit 1) and is GREEN after the fix.

## 6. Commands and evidence (cwd `D:\Git\dugate`)

| # | Command | Exit | Result | Raw (SHA-256) |
|---|---|---|---|---|
| 1 | `npm test -- tests/pipelines/` (baseline) | 1 | 3 suites pass / 1 fail-to-run (`external-api`); **36 tests passed** | `raw/wt11-semaphore-fix/baseline-npm-test-pipelines.log` `4A2C8AAA…` |
| 2 | `npm test -- tests/pipelines/worker-slots-fail-open.test.ts` (first RED, provisional mock) | 1 | 3 failed / 1 passed | `failing-first-RED.log` `4C9D6133…` |
| 3 | Same, final mock form (**official failing-first RED**) | 1 | 3 failed / 1 passed | `failing-first-RED-final.log` `BEE21C31…` |
| 4 | `npm test -- worker-slots + worker-slots-fail-open + profile-endpoint-limits` | **0** | **3 suites / 30 tests passed** | `focused-GREEN.log` `FED5BFBA…` |
| 5 | `npm test -- tests/pipelines/` (final, literal dispatch command) | 1 | 4 suites pass / 1 fail-to-run (`external-api`); **40 tests passed** | `final-npm-test-pipelines.log` `5C9433F3…` |
| 6 | `npx tsc --noEmit` | **0** | zero diagnostics | `typecheck.log` (empty, `E3B0C442…`) |

`git diff --numstat`: `worker.ts 56/9`, `lib/endpoints/runner.ts 45/0` (the runner numstat is vs HEAD and includes the
implementation lane's pre-existing diff; this packet's share is the 2-cast removal, net −2 lines).
Scope check: only `worker.ts`, `lib/endpoints/runner.ts`, `lib/queue/worker-slots.ts` (untracked, lane file) and the
three `tests/pipelines/` files appear for these paths; no `du-rework/` file touched.

## 7. Findings (open — not fixed here)

| ID | Severity | Finding |
|---|---|---|
| F-WT-13 | HIGH (deployment) | The tracked `worker.js` bundle (2,003,547 bytes, mtime 2026-09-21) contains **no** `tryAcquireSlot` → any runtime using the committed bundle (`node worker.js`) executes WITHOUT the fair-share worker and without this fix. Docker is covered only after an image rebuild (Dockerfile:29-42 runs esbuild; `docker-compose.yml:79` runs `node worker.js`); local rebuild command is `npm run worker:build`. **Not rebuilt in this packet**: regenerating a tracked 2 MB bundle would embed every lane's uncommitted changes and is a release action under the code freeze. |
| F-P1-02 | MEDIUM | (`createRedisConnection()` = `maxRetriesPerRequest: null`) during a Redis outage the acquire `eval` may wait rather than reject, delaying fail-open. Now at least observable via the new warn when it surfaces; a bounded acquire timeout remains the real fix. |
| F-P1-03 | LOW | Slot-TTL residual (single long holder > TTL) documented in §4; env override `WORKER_SLOT_TTL_SECONDS`. |
| Pre-existing | INFO | `tests/pipelines/external-api.test.ts` fail-to-run (P3 F2, mammoth import) — unchanged, keeps literal `npm test -- tests/pipelines/` at exit 1. |

## 8. Compliance

- Repo scope respected: legacy root only. Files edited: `lib/queue/worker-slots.ts`, `worker.ts`,
  `lib/endpoints/runner.ts` (2 casts), `tests/pipelines/worker-slots.test.ts`,
  `tests/pipelines/worker-slots-fail-open.test.ts` (new), plus this receipt and raw logs. No `du-rework/` writes.
- **No commit, no push, no task-row tick.** No `npm run worker:build` executed.
