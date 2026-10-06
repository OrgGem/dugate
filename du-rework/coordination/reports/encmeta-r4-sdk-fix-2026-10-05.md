# FU-ENCMETA-R4 — Worker SDK child result reference parsing

**Task:** `task_b26e9232f603` / `ctx_53190290a0e2`  
**Owner:** codex_worker_1  
**Result:** implemented and offline-verified; runtime/server files were not edited.

## Change

The runtime’s `GET /api/runtime/v1/tasks/:id/children` returns camelCase fields: `taskId`, `taskKey`, `kind`, `state`, `resultRef`, and `errorCode`. `RuntimeService.getChildren` declares that DTO at `services/orchestrator/src/modules/runtime/runtime.ts:1169-1170`, and the HTTP route returns it unchanged at `services/orchestrator/src/http/routes/runtime.ts:457-463`.

`parseChildren` now reads the actual `taskId`, `resultRef`, and `errorCode` fields before trying the existing `id`/`task_id`, `result_ref`, and `error_code` aliases. Reading `taskId` was also necessary for the exact server response: without it, a server row was dropped before the result reference could be parsed. Canonical camelCase wins if both forms are present.

Added a wire-contract test at `packages/worker-sdk/tests/fan-out.test.ts:236` with the exact server DTO key shape and asserted the resulting `ChildState.resultRef`. The existing snake_case fixture path now also explicitly asserts its result refs continue to parse.

### Snake_case decision

Retain `result_ref` as a compatibility fallback, alongside the parser’s prior `task_key`, `id`/`task_id`, and `error_code` fallbacks. The server DTO is camelCase; these aliases are consumer-side tolerance for older SDK payloads/fixtures, not an alternate canonical server contract. No versioned schema requires rejecting them, and retaining them does not change the server response contract.

## Verification

Environment: cwd `D:\Git\dugate\du-rework`, Node `v22.16.0`, pnpm `10.18.3`; the test uses the injected fetcher and no live services.

| Command | Result |
|---|---|
| `pnpm --filter @du/worker-sdk test -- tests/fan-out.test.ts` ×3 | Each run: 1 suite / 21 tests passed; exit 0 |
| `pnpm --filter @du/worker-sdk exec tsc --noEmit` | No diagnostics; exit 0 |
| `git diff --check -- packages/worker-sdk/src/fan-out.ts packages/worker-sdk/tests/fan-out.test.ts` | exit 0 |

Raw command output: `C:\Users\Gem\AppData\Local\Temp\encmeta-r4-sdk-fanout-2026-10-05.log`  
SHA-256: `AD807FB75BBBBB2EADBF61A152ADF5FCB2FECAA160139777039CFBA2981BC2E5`  
Run time: `2026-10-05 04:01:00`–`04:01:13 +07:00`.

`services/orchestrator/src/modules/runtime/runtime.ts` and `services/orchestrator/src/http/routes/runtime.ts` already had dirty worktree status before this lane’s edits; they were inspected read-only and were not changed here. No commit or task tick was made.
