# Independent Verification Receipt — WT-01 (Callback Secret Resolver & Terminal Code)

- **Date:** 2026-10-07
- **Verifier:** DeepSeek (dsh) — independent tester/verifier role (per `coordination/COORDINATOR-CONTRACT.md`; disjoint scope, never a second dispatcher)
- **Repo scope:** `du-rework` ONLY (legacy root untouched)
- **Mode:** Independent re-execution + source-level integrity inspection; the worker receipt (`coordination/reports/wt01-callback-resolver-2026-10-07.md`, qwen_1) was **not** used as evidence for the verdict — only referenced as the claim under test.
- **Code freeze:** NO commit, NO push, NO stage performed. This report file is the only write.

## Environment

| Item | Value |
|---|---|
| OS / Shell | Windows / PowerShell (pwsh) |
| Node | v22.23.3 |
| Git HEAD | `4308cc5` (branch `codex/fix-workflow-builder`) |
| Working tree at run | dirty, 312 entries — pre-existing shared state (workers active) |
| Working tree delta by this run | +1 file: this report only |

## 1. Test runs — command / cwd / exit code / verdict

### 1a. WT-01 jest suites

- **cwd:** `du-rework/services/orchestrator`
- **command:**
  ```
  node node_modules/jest/bin/jest.js --runInBand tests/cb-02-webhook-result-delivery.test.ts tests/cb-03-outbound-auth.test.ts tests/cb03-composition-resolver.test.ts tests/vfy-cb01-dispatch-matrix.test.ts
  ```
- **exit code:** `0`
- **result:** Test Suites: **4 passed, 4 total** · Tests: **58 passed, 58 total**, 0 failed, 0 skipped
- Per-suite output read: `PASS tests/cb-02-webhook-result-delivery.test.ts`, `PASS tests/vfy-cb01-dispatch-matrix.test.ts`, `PASS tests/cb-03-outbound-auth.test.ts`, `PASS tests/cb03-composition-resolver.test.ts`

### 1b. WT-01 orchestrator typecheck

- **cwd:** `du-rework/services/orchestrator`
- **command:** `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`
- **exit code:** `0`
- **result:** clean — zero diagnostics emitted (0 errors)

**Totals for this receipt:** 4 jest suites / **58 tests passed** / **0 failed** / **0 skipped** + 1 clean typecheck · non-zero exit codes: **0**.

## 2. Terminal-code & no-retry integrity (source inspection, `src/modules/webhooks/webhooks.ts`)

### 2a. `WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED` is exported and distinct from `WEBHOOK_AUTH_UNAVAILABLE` ✅

- **Exported:** `webhooks.ts:402` — `export const WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED = 'WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED';` (used at delivery site `:682`).
- **Distinct:** `webhooks.ts:388` — `export const WEBHOOK_AUTH_UNAVAILABLE = 'WEBHOOK_AUTH_UNAVAILABLE';` (used at `:701`, `:746`).
- **Documented distinction** (`:382-401`): `UNAVAILABLE` = credential-bearing callback that could not be authenticated due to a **transient** fault — "consumes a retry attempt", row stays PENDING for retry. `RESOLVER_NOT_CONFIGURED` = **configuration** error (resolver never wired into the composition) — "Terminal => status FAILED, attempts left untouched, last_error = this code", retry would "burn max_attempts and then report a failure that looks like an upstream incident".
- **Programmatic distinction asserted in tests:** `cb03-composition-resolver.test.ts:170-171` — `expect(WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED).not.toBe(WEBHOOK_AUTH_UNAVAILABLE)` + format `/^[A-Z_]+$/`.

### 2b. No resolver configured → `attempts` stays 0, no outbound fetch ✅

Delivery path (`deliverWebhooks`):
- **Gate:** `webhooks.ts:674-686` — `if (!opts.resolveCallbackSecret)` → push outcome `{ row, ok: false, errMsg: WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED, terminal: true }` then `continue`. This executes **before** `createOutboundAuthSession` (`:688`), `buildWebhookBody` (`:711`), signing (`:717`), and the send closure / `fetchFn` — so **no outbound fetch occurs** on this path.
- **Outcome processing:** `webhooks.ts:798-813` — `if (terminal)` → `UPDATE webhook_deliveries SET status='FAILED', attempts=$3, last_error=$4 ...` with **`$3 = row.attempts` (unchanged, no `+1`)** and **no `next_at` backoff** → the row closes FAILED and never re-enters the PENDING retry loop.
- **Contrast (non-terminal failure):** `webhooks.ts:821-837` — `nextAttempts = row.attempts + 1`, exponential backoff, `status='PENDING'`. The terminal branch deliberately bypasses this (comment `:799-807`: "WITHOUT incrementing attempts and WITHOUT scheduling a backoff").

### 2c. Behavior confirmed by the independently re-run tests

From `tests/cb03-composition-resolver.test.ts` (`describe('WT-01 terminal failure when the resolver is not wired')`, all PASS in this run):
- `:147` `expect(calls).toBe(0)` — fetchFn counter never increments (**zero fetch calls**);
- `:148` `expect(after.status).toBe('FAILED')`;
- `:149` `expect(after.last_error).toBe(WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED)`;
- `:150` `expect(after.attempts).toBe(0)` (**attempts preserved**);
- `:153-167` second sweep does NOT re-open the row (fetchFn throws `'must not be called'` if invoked; attempts still 0, status still FAILED — no budget drained across sweeps);
- `:174-189` seam is live: with a resolver supplied, delivery proceeds → `DELIVERED`, `attempts === 1` (proves the fix is scoped to the missing-resolver case, not a blanket disable).

Additional corroborating assertions passing in this run:
- `tests/vfy-cb01-dispatch-matrix.test.ts:107-109` — `lastError === 'WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED'`, `attempts === 0`;
- `tests/cb-02-webhook-result-delivery.test.ts:566` — `last_error === WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED`.

## 3. Integrity assertions

1. **Independence:** All commands ran in this session at HEAD `4308cc5`; verdicts were derived from live output and source inspection, not copied from the qwen_1 receipt. Owner smoke ≠ this receipt; this is the independent `VFY` step for WT-01.
2. **Functional verdict, not just exit code:** The jest summary (58 passed / 0 failed / 0 skipped) and the per-case list were read; the OpenAPI-style discipline from prior receipts was applied — assertions named in §2c exist in the test source and executed green.
3. **Scope:** Commands ran only under `du-rework/services/orchestrator`. Legacy root untouched.
4. **No code mutation:** No product code, tests, migrations, configs or manifests written. Only this report file was created.
5. **Code freeze:** No `git add` / `commit` / `push` / `stash` / `reset`. The 312 pre-existing dirty entries preserved untouched for their owners.
6. **Environment note (cosmetic):** PowerShell printed `NativeCommandError` wrappers because jest writes progress to stderr; captured summaries + `EXITCODE=0` confirm success. Broken `GIT_CONFIG_*` shell env (`COUNT=2`, missing keys) was neutralized read-only via `GIT_CONFIG_COUNT=0` for status inspection; no config file changed.

## 4. Status & limits

- **WT-01 (Callback Secret Resolver & Terminal Code):** **`VERIFIED`** — suites PASS (58/58), typecheck clean, and the Option (b) contract is confirmed in source: missing `resolveCallbackSecret` ⇒ terminal outcome `WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED` ⇒ `status='FAILED'`, `attempts` unchanged (0), zero fetch calls, no backoff/retry scheduling; code is exported and documented as distinct from transient `WEBHOOK_AUTH_UNAVAILABLE`.
- **Not claimed:** `ACCEPTED` — still requires the standing reviewer verdict per `du-rework/AGENTS.md`.
- **Not covered:** live DB/Redis/delivery against a real network sink was not part of this dispatch (the suites use scripted DB + injected fetch seams). Doc publication of the new code (`docs/08-connector-api.md` / OpenAPI Δ4, per the worker's own open-items list) was not in this acceptance scope and remains an open follow-up for its owner.
