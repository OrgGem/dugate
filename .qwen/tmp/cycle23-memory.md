
## Cycle 23 (2026-09-28) — W-DATA-03-ORCH-VERIFY, task_d3329e56f028 / ctx_a197b906cb36

- **Muc 23 receipt written** (receipt file line 2184; ledger row 23 at line 121).
- Packet said "verify and wire" 2 test files. BOTH ALREADY EXISTED and were green:
  `url-ingestion-consumer-offline.functional.test.ts` = 33 test,
  `url-ingestion-backend-failclosed-offline.test.ts` = 4 test → 37, NOT 38. I mis-stated
  38 in a first draft and corrected it after measuring. Lesson: measure per-file counts,
  never reuse a remembered number.
- **Real gap found by reading code, not by running tests**: `claimTask` in
  `src/modules/runtime/runtime.ts` had NO `PENDING_INGESTION` guard. The dispatcher already
  excludes `payload->>'gate'='ingestion'` (dispatcher.ts:36-41) but that is ROUTING, not a
  BOUNDARY — a redelivery, a row written before the gate existed, or any re-stamp path could
  hand a worker a real lease on a task whose input has no bytes. Same bug class as Muc 11
  (post-lease ownership fence).
- **Fix**: 1 guard / 5 lines, after the terminal check and BEFORE any lease is taken:
  `if ((t.op_state as string) === 'PENDING_INGESTION') throw conflict('STATE_CONFLICT', ...)`.
  Keys on `op_state` (operation state), which the claim query already projects — no extra
  bind param, no extra round-trip. runtime.ts sha `902185d2`, 77510 B (byte-exact after M1).
- **Tests**: +2 in the consumer file (33 -> 35). `TaskRow` had NO lease columns, so "refused
  claim takes no lease" would have been a vacuous assertion — added `lease_epoch`,
  `lease_expires_at`, `leased_by`, `last_delivery_id`, `attempt`. Added 4 router branches:
  claim SELECT (only project `op_state` when SQL text has `o.state AS op_state`), op-state
  SELECT, lease UPDATE honouring real CAS (`row.lease_epoch + 1 === expectedEpoch`, rowCount 0
  otherwise), operations RUNNING transition. Without the last two, a "claim succeeds" test
  would hit `unrouted sql` and prove nothing.
- **M1 mutation**: guard disabled -> `1 failed, 34 passed`, the correct test. It bites.
- **Verify**: url-ingestion glob 42/42 x3 plus a 4th run, Exit 0/0/0/0. Consumer 35/35.
  tsc --noEmit Exit 0, empty log.
- **Full orchestrator suite: 5 failed suites, ALL foreign, 0 url-ingestion failures** —
  admin-operations-list-pagination (known since cycle 1), admin-shell-session-lifecycle,
  adm-base-03-safe-error-offline, admin-crypto-config-oidc (NEW, W-ENC-08-CSRF-OIDC,
  `CRYPTO_CONFIG_TENANT_REQUIRED`; its test mtime 22:29:19Z is AFTER my runtime.ts 22:13:48Z,
  so another lane wrote it mid-run), admin-error-boundary-offline (the known ETIMEDOUT
  ephemeral-port flake = Δ35). grep for `claimTask|PENDING_INGESTION` = No matches in all 5.
- **Jest log trap**: each FAIL file is printed TWICE (header + summary table), so 10 FAIL
  lines = 5 suites. Never report the raw line count.
- **Δ54** packet write scope named only 2 test files, but the property is unreachable
  test-only — the src change was necessary. **Δ55** no live-PG evidence for the guard (folds
  into Δ53 / DATA-INT-01). **Δ56** 5 foreign red suites, reported not absorbed.
- `send_message` to the coordinator is UNDELIVERABLE in this session (no active team); the
  receipt file is the submission channel.
