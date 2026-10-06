# REGRESSION-FIX-907 — focused test repairs

**Date:** 2026-10-05 13:50 UTC  
**Scope:** `services/orchestrator/tests/legacy-payload-migration.test.ts` and `packages/contracts/tests/vault-policies.test.ts`, plus this receipt. No production source was changed.

## Case 1 — inventory issue ordering

`inventoryPlaintextPayloads()` scans sources and appends scanner findings as it encounters them (`services/orchestrator/src/modules/encryption/legacy-payload-migration.ts:140-185`). It then derives uncovered kinds and appends `UNCOVERED_SCOPE` entries in `ENC09_PAYLOAD_KINDS` order (`:188-190`). The old test required the opposite cross-category ordering, but no caller or documented contract requires uncovered-scope findings to precede scan findings. The chosen behavior is to preserve scanner/source discovery order first, followed by the canonical coverage summary; the production implementation remains unchanged.

The test expectation now matches that ordering. Added a focused regression test with two source findings to pin their input order and the canonical ordering of uncovered kinds (`tests/legacy-payload-migration.test.ts:118-150`). This makes the ordering decision explicit instead of relying only on the broader fixture assertion.

## Case 2 — Vault policy exception assertions

The contracts workspace pins Jest 29.7.0 in `pnpm-lock.yaml`. The existing runtime did not provide `toThrowError`; the two affected tests failed with `TypeError` before checking the policy. Replaced those calls with Jest's working `toThrow` matcher. The login test has worker and browser assertions at lines 104-105, so both were corrected; the expired-renewal assertion at line 179 was corrected as well. No Vault policy implementation changed.

## Verification

Initial focused runs reproduced the reported failures: migration inventory had 8 passing and 1 failing assertion due only to issue ordering; Vault had 60 passing and 2 failures from `toThrowError is not a function`. Final focused commands ran from `D:\Git\dugate\du-rework`:

| Command | Result |
|---|---|
| `pnpm --filter @du/orchestrator run test --runTestsByPath tests/legacy-payload-migration.test.ts` | Exit 0; 1 suite passed, 10/10 tests passed |
| `pnpm --filter @du/contracts run test --runTestsByPath tests/vault-policies.test.ts` | Exit 0; 1 suite passed, 62/62 tests passed |
| `git diff --check -- services/orchestrator/tests/legacy-payload-migration.test.ts packages/contracts/tests/vault-policies.test.ts` | Exit 0; only Git LF-to-CRLF advisory warnings |

The first baseline invocation used `pnpm --filter <workspace> exec jest ...`; pnpm reported `Command "jest" not found` after emitting the failing suite output. Final verification used each workspace's declared `test` script as shown above.

A broader repository `git diff --check` also surfaced unrelated working-tree whitespace findings in `docs/28-test-inventory.md` and an extra blank line at EOF in `services/orchestrator/src/modules/encryption/legacy-payload-migration.ts`; neither file was modified by this task. No typecheck was requested or run. No commit or task tick was performed.

## Existing working-tree changes

The final diff against the current index includes a 672-line addition in `services/orchestrator/src/modules/encryption/legacy-payload-migration.ts`. This task did not edit that source file; the ordering decision above was checked against its current working-tree implementation. The migration test also already contained the broader ENC-09 coverage/count expectation updates before this task; this task only added the ordering regression test and corrected the issue-order expectation. Do not attribute the existing source/test diffs to REGRESSION-FIX-907 or treat the source file as clean.
