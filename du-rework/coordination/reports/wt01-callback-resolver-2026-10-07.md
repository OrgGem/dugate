# WT-01 — Callback Secret Resolver Composition Seam — receipt
qwen_1 (term_7cb640ae-5ffe-4675-9f7b-0c99c1070268) · 2026-10-07 · task from coordinator dispatch, canonical plan `tasks/CODE-REVIEW-FOLLOWUP-WTREE-2026-10-07.md` §2.2 · repo scope: `du-rework` ONLY (legacy root untouched)

## Outcome
**Option (b) implemented** — the degraded state is published as a distinct terminal failure, not a transient one. No commit, no push, no tick, code freeze respected.

Option (a) was rejected on evidence: `src/modules/secrets/vault-resolver.ts` exposes `createRuntimeSecretResolver(RuntimeSecretResolverOptions)`, which requires `decryptManagedValue.decrypt` plus `readVaultReference`, and its reference shape is `RuntimeSecretReference`, not the `OutboundSecretResolver = (secretRef: string) => Promise<string>` the sweep needs. No adapter exists, so a real Vault-backed resolver is not an offline-ready contract. Wiring a resolver I cannot exercise offline would have been untested security code.

## Defect confirmed on disk before editing
```
rg -n "resolveCallbackSecret|callbackOAuth2Options" du-rework --glob "!**/node_modules/**"
  -> server.ts:302,304 (ServerConfig declares both)
  -> create-app.ts:1047,1048 (both forwarded into the sweep options)
  -> webhooks.ts:306,653,659,661
  -> run-dispatcher-inside.cjs:109, vfy-cb01:71, cb-02:519,609,656 (the only actual assignments: test/tooling)
rg -n "resolveCallbackSecret" du-rework/services/orchestrator/src/main.ts
  -> EMPTY (exit 1, no output)
```
So no composition path assigns it: the sweep always received `undefined`.

## What changed
**Source — `services/orchestrator/src/modules/webhooks/webhooks.ts` (+50 / -3):**
1. New exported code `WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED`, documented as terminal and explicitly distinct from `WEBHOOK_AUTH_UNAVAILABLE` (transient).
2. The outcomes tuple gains a `terminal?: boolean` flag.
3. The `!opts.resolveCallbackSecret` branch now pushes the new code with `terminal: true` instead of the transient code.
4. The release transaction gains a `terminal` branch: `SET status='FAILED', attempts=$3, last_error=$4` with `attempts` passed **unchanged** — no increment, no backoff, no second sweep. Deliberately the same parameter shape as the exhausted-budget FAILED branch, so every fake and real driver sees one statement shape for a terminal row.

## Tests
**New — `tests/cb03-composition-resolver.test.ts` (7 tests, all passing):**
- seam declared on `ServerConfig` (both fields);
- create-app forwards both into the sweep options (exact source strings pinned);
- composition does NOT invent a resolver (`main.ts` has no `resolveCallbackSecret:`) — wiring stays an operator choice, which is what makes this option (b) honest;
- missing resolver + credential policy => `status FAILED`, `last_error === WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED`, `attempts === 0`, **zero fetch calls**;
- a later sweep does not re-open the row (attempts stay 0 across sweeps);
- the new code is distinct from `WEBHOOK_AUTH_UNAVAILABLE` and matches `^[A-Z_]+$` (runbook-safe);
- with a resolver supplied, delivery succeeds (`DELIVERED`, attempts 1, resolved header, signature present) — proves the seam is live, not merely declared.

### Failing-first evidence (captured, not asserted)
I reverted only the `!opts.resolveCallbackSecret` branch to the pre-fix body and re-ran the new file:
```
Tests: 2 failed, 5 passed, 7 total
  expect(after.status).toBe('FAILED')  Expected FAILED / Received PENDING
  expect(scripted.row().attempts).toBe(0)  Expected 0 / Received 2
```
Restored the fix afterwards. So the test genuinely fails before and passes after — the two red assertions are exactly the WT-01 contract (terminal + no budget burn).

## Verification — real numbers
Node **v22.16.0**. Commands run from `du-rework/services/orchestrator`.

| command | result | exit |
|---|---|---|
| `node node_modules/jest/bin/jest.js --runInBand tests/cb-02-webhook-result-delivery.test.ts tests/cb-03-outbound-auth.test.ts tests/cb03-composition-resolver.test.ts` (mandated) | **3 passed, 50 passed / 50 total** | 0 |
| same + `tests/vfy-cb01-dispatch-matrix.test.ts` | **4 passed, 58 passed / 58 total** | 0 |
| `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | no output | **0** |
| full suite | 6 failed / 27 skipped / **211 passed** of 244; 60 failed / 245 skipped / **4963 passed** of 5268 | 0 |

`webhook-reclaim-fence.live.test.ts` is live-gated (skipped, not passed) and `runtime-webhook.test.ts` skips the same way — neither ran.

## Attribution of the 6 red suites (measured, not assumed)
The full run shows 6 red suites: `artifact-read-authorization`, `admin-operations-sort`, `admin-operations-sql`, `admin-operations-sort-http-offline`, `rv01-loopback-http-offline`, `admin-shell-session-lifecycle`.

Proof they are **not** WT-01:
1. `rg -l "deliverWebhooks|resolveCallbackSecret|from '../src/modules/webhooks'"` over all six files -> **`NONE`**. None imports the module I edited.
2. Attribution run: I copied `HEAD:.../webhooks.ts` over my version (WT-01 removed) and ran exactly those six suites -> **6 failed, 60 failed / 271 total — identical counts**. Restored my version (diff stat back to 50+/3-, `rg -c "WT-01"` = 4, `rg -c "WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED"` = 2).
3. The first red assertion is `unexpected SQL: ...` in `admin-operations-sort.test.ts:225`, i.e. the admin read path; `src/modules/admin-read/profile-detail.ts` and `src/modules/operations/submission.ts` are **` M` in the shared working tree** from other concurrent lanes. `artifact-read-authorization` and `admin-shell-session-lifecycle` were already red earlier in this session.

## Files touched
```
 M du-rework/services/orchestrator/src/modules/webhooks/webhooks.ts       (source, +50/-3)
 M du-rework/services/orchestrator/tests/cb-02-webhook-result-delivery.test.ts  (+9/-1)
?? du-rework/services/orchestrator/tests/cb03-composition-resolver.test.ts      (new)
?? du-rework/services/orchestrator/tests/vfy-cb01-dispatch-matrix.test.ts       (existing, see Δ1)
```
`main.ts`, `server.ts`, `create-app.ts` are ` M` in the working tree but **not from WT-01**: `git diff ... | findstr "WT-01 RESOLVER_NOT_CONFIGURED terminal"` -> no matches, and `main.ts` still has zero `resolveCallbackSecret` references.

## Δ — deviations and risks
- **Δ1 — `vfy-cb01-dispatch-matrix.test.ts` is UNTRACKED (`??`)**, i.e. another lane wrote it in this tree. I edited it because its assertion at `:103` hard-coded `WEBHOOK_AUTH_UNAVAILABLE` for exactly the WT-01 case and would otherwise be red. I added the new code assertion plus `expect(f.row.attempts).toBe(0)`. **Risk:** if that lane is still writing the file, my edit can be overwritten or conflict. Coordinator should confirm ownership before relying on it.
- **Δ2 — `cb-02-webhook-result-delivery.test.ts:566`** assertion changed from `WEBHOOK_AUTH_UNAVAILABLE` to `WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED`, with the rationale written inline at the site (same row still reaches FAILED because `max_attempts: 1`; the code is the behavioural delta). Not a test edited to go green — the contract genuinely changed.
- **Δ3 — two transient paths left alone deliberately**: the `createOutboundAuthSession` catch and the `OutboundAuthError` mapping still collapse to `WEBHOOK_AUTH_UNAVAILABLE`. Those can legitimately retry (token server down, secret lookup flaky), so they keep the transient code. The packet asked only for the missing-resolver state.
- **Δ4 — docs not updated.** §2.2 for option (b) also asks for `docs/08-connector-api.md` + OpenAPI. The dispatch packet did not list them under scope and docs/08/doc 21 are contract-owned leases, so I did not touch them. **OPEN for the doc owner:** publish the new code so the runbook lists it.

## Raw evidence

Dispatch spec §W1 yêu cầu raw output tại `coordination/reports/raw/wt-2026-10-07/`. Đã tạo:

| file | bytes | nội dung |
|---|---|---|
| `raw/wt-2026-10-07/wt01-full-suite.txt` | 178858 | full suite run, đầy đủ failure detail + summary `6 failed / 27 skipped / 211 passed`, `60 failed / 245 skipped / 4963 passed`, Time 29.72s |

Lưu ý: lần persist đầu (`bg_0e44d86d`) **fail vì thư mục `raw/wt-2026-10-07/` chưa tồn tại** (`The system cannot find the path specified`) — đã tạo thư mục rồi chạy lại, file trên là kết quả của lần chạy lại và **số liệu khớp chính xác** với bảng verification ở trên.

## Status
**Implemented + locally verified.** Not ACCEPTED: independent Tester + Claude Code `APPROVED` are still required, and 0 tickets ticked.

## Open items for the coordinator
1. Doc owner: publish `WEBHOOK_AUTH_RESOLVER_NOT_CONFIGURED` in `docs/08-connector-api.md` + OpenAPI (Δ4).
2. SC-01: a real Vault-backed `resolveCallbackSecret` adapter is still absent — until it exists, credential-bearing callbacks fail terminal by design (option b), never silently unauthenticated.
3. Δ1 file ownership.
4. The 6 red suites are other-lane drift (measured above); whoever owns `admin-read/profile-detail.ts` and the admin sort suites should triage.
