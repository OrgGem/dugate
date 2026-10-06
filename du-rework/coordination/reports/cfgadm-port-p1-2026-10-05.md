# CFGADM-UI-PORT-P1 - receipt (Settings surface: CFGADM-01/02/03/04)

> **RESUME POINT (qwen_5, 2026-10-05 03:4x)** - task CFGADM-UI-PORT-P1 (task_34af06b387a2),
> WAVE-801 section 5, run run_069ecd6957cd. Status: **implemented, offline-verified x3.**
> 0 router/client edits (A5 honoured), 0 commits, nothing ticked. Antigravity review requested by the
> coordinator after build.

---

## 1. Decisive finding: there is NO settings wire

`grep -n Settings packages/contracts/src/*.ts` returns **zero matches**, and there is no settings wire
report in coordination/reports. So CFGADM-01/02/03/04 have neither a read DTO nor a writer action.
The packet said "wire against the frozen settings wire only" - with no wire, the honest port is a
**catalog of the legacy key -> logical replacement -> owner**, with every write control disabled and a
specific reason. No fake save, no invented endpoint, no value read into the browser.

## 2. What was built

| File | Role |
|---|---|
| `features/settings/catalog.ts` (NEW) | the 17 legacy keys from `tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md` section 3: legacyKey, business label, logical replacement, scope, secret flag, owner, group, disposition |
| `features/settings/state.ts` (NEW) | pure helpers (grouping, row counts, secret rows) so grouping and the honest reason are testable without React |
| `features/settings/settings-screen.tsx` (MODIFIED) | renders the three CFGADM group cards (01 AI defaults, 02 prompt defaults, 03/04 storage+retention) **above** the pre-existing deployment catalog, which is preserved verbatim |
| `tests/browser/admin-web/cfgadm-settings-port-p1.spec.ts` (NEW) | 6 browser cases covering every state |

**Groups and rows:** AI = 5 port + 1 retire (6), prompt = 5, storage = 6 -> **17 rows, 16 ported**.
Secrets: `ai_api_key`, `openai_api_key`, `s3_access_key`, `s3_secret_key` (4) + the retire key (5).
Button labels: Apply x12, Replace secret x4, Retire x1.

## 3. The test caught a real defect in my own code

Attempt 1: test 2 expected `Replace secret` = 4, got **5**, and test 4 found no Retire button at all.
Cause: `api_secret_key` is both `secret: true` and `disposition: retire`, and my label expression put
`secret` first, so the retire branch was unreachable and the row rendered "Replace secret".

**Fixed** in `settings-screen.tsx:71` (mine, in lease):
```
- {row.secret ? 'Replace secret' : row.disposition === 'retire' ? 'Retire' : 'Apply'}
+ {row.disposition === 'retire' ? 'Retire' : row.secret ? 'Replace secret' : 'Apply'}
```
No production source outside my lease was touched to make this pass.

## 4. Literal runs

`pnpm --filter @du/admin-web typecheck` - 3 consecutive runs, all `Exit Code: 0`.
`pnpm --filter @du/admin-web build` - 3 consecutive runs, all `Exit Code: 0`:
```
2668 modules transformed
dist/assets/index-BffJF1YL.css   41.30 kB
dist/assets/index-VXqFDc-c.js   494.50 kB
```

Browser (harness seam, isolated `--output`, 6/6 each):
```
attempt 3   6 passed (8.1s)   exit 0
attempt 4   6 passed (7.5s)   exit 0
attempt 5   6 passed (7.4s)   exit 0
```
Cases: (1) three groups + all 17 keys, (2) 17 write controls all disabled with a title reason >30 chars
and never containing "saved", (3) 4 secret rows labelled `secret` + **zero `<input>` on the page** so no
value can be read in or echoed, (4) retire row is a decision not a write target, (5) 320px no horizontal
overflow, (6) keyboard Tab reaches a control with a visible focus ring.

## 5. Blockers hit, and how they were attributed

1. **Build was red for ~2 minutes and it was NOT my code.** `features/identity/identity-screen.tsx` had
   been deleted while `src/routes/identity.tsx` still imported it (errors at `identity-api.ts:63,64` and
   `routes/identity.tsx:1`). That directory belongs to P2 (codex_worker_1) and is their lease, so I did
   **not** fix it. Proof it was not mine: an isolated typecheck of `features/settings/**` alone was
   `Exit Code: 0`, and after P2 landed their change the full typecheck went green by itself.
   (Attribution by content, not mtime: the identity dir contained only `identity-api.ts` at that moment.)
2. **Attempt 2 lost one case to `ENOENT` on a Playwright trace file**, not an assertion. Root cause was
   **another lane running Playwright concurrently** in the shared `tests/browser/test-results/` (their
   `api-keys-connectors-*` folders were sitting in it). Re-running with a private
   `--output=<evidence>/pw-output` made it green and stayed green. I did not delete their artifacts.

## 6. GAP - explicit

- **No settings wire, no writer action, no deployment adapter.** Every control here is disabled because
  there is nothing to call. Nothing is faked as saved.
- **No secret value is rendered, read or logged anywhere** - there is no read wire that could return one,
  and the page contains no input control at all.
- **Not run against a live stack.** The harness seam only; no live DB/Vault/S3 leg exists for this packet.
- **CFGADM-01/02/03/04 stay OPEN.** This packet ships the surface; the writer actions (Policy, Vault
  secret-ref adapter, Artifact storage generation) are separate backend work owned per the parity mapping.

## 7. Evidence

Six screenshots under `coordination/evidence/cfgadm-port-p1/cfgadm-port-p1/` (230-239 kB each),
plus `pw-output/` from the isolated runs and `harness.json`.

## 8. Ledger

- CFGADM-UI-PORT-P1 - Muc 1 - Settings port for CFGADM-01/02/03/04: 4 files (2 new leaf modules,
  1 screen extended, 1 spec), 17 rows catalogued with honest disabled controls, secrets never rendered;
  typecheck x3 + build x3 Exit Code: 0, browser 6/6 x3 exit 0, 6 PNGs; one self-found label-order defect
  fixed in-lease; build blockage correctly attributed to P2 and left alone; no router/client edit, no commit.
