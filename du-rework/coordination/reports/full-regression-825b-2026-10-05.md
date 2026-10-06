# FULL-REGRESSION-825B — 2026-10-05

Independent read-only verification. No product source or test was edited by this run; no commit or checklist tick was made.

## Snapshot used

HEAD remained b088eececcb5f3df0b4edbe073a29401dafda624, but it does not represent the tested tree: the working tree already contained many modified and untracked files. The final orchestrator run used the SHA-256 inventory in raw/full-regression-825b-2026-10-05/source-test-hashes-checkpoint5-before-full.txt; the matching after-run inventory is source-test-hashes-checkpoint6-after-full.txt, with no source/test hash drift during the run. Contracts and worker-sdk source/test hashes also match their full-suite run checkpoint.

Jest discovered 223 orchestrator, 27 contracts, and 30 worker-sdk test files. **81 discovered test files are untracked** (72 orchestrator, 4 contracts, 5 worker-sdk); therefore the results describe the working-tree snapshot, not HEAD. The file list is [here](raw/full-regression-825b-2026-10-05/untracked-tests-discovered-final.txt). Twenty-six orchestrator suites / 230 test cases were skipped and are not counted as passing.

## Full package runs

| Package and command | Suites | Tests | Exit |
|---|---:|---:|---:|
| pnpm --filter @du/orchestrator test | 192 passed, 26 skipped, 5 failed / 223 | 4,775 passed, 230 skipped, 10 failed / 5,015 | **1** |
| pnpm --filter @du/contracts test | 26 passed, 1 failed / 27 | 525 passed, 2 failed / 527 | **1** |
| pnpm --filter @du/worker-sdk test | 30 passed / 30 | 692 passed, 1 todo / 693 | **0** |
| **Combined** | 248 passed, 26 skipped, 6 failed / 280 | 5,992 passed, 230 skipped, 12 failed, 1 todo / 6,235 | — |

Authoritative raw output and literal exits: [orchestrator](raw/full-regression-825b-2026-10-05/orchestrator-full-suite-final.log) ([exit](raw/full-regression-825b-2026-10-05/orchestrator-full-suite-final.exit.txt)), [contracts](raw/full-regression-825b-2026-10-05/contracts-full-suite-final.log) ([exit](raw/full-regression-825b-2026-10-05/contracts-full-suite-final.exit.txt)), [worker-sdk](raw/full-regression-825b-2026-10-05/worker-sdk-full-suite-final.log) ([exit](raw/full-regression-825b-2026-10-05/worker-sdk-full-suite-final.exit.txt)).

## Failure attribution

**New relative to FULL-REGRESSION-815, attributable to the current control-plane expansion:** legacy-payload-migration.test.ts:148 expects unresolvedReferences: 4, but receives 10. The current ENC09_PAYLOAD_KINDS adds six control-plane slots at legacy-payload-migration.ts:19-24; inventory now counts those additional slots. The suite passed in receipt 815 before this expansion, and the same assertion fails in both the final full run and the focused run. This is a real behavior change from the current wave; the owner needs to decide whether inventory semantics or the old assertion is wrong. I did not change the test.

**Known pre-existing failing suites, recorded before this task in business-contract-fix-820-2026-10-05.md:**

- admin-shell-session-lifecycle.test.ts: one audit assertion at line 821 expected the auth.login_failed event; record.event was undefined.
- artifact-read-authorization.test.ts: six assertions fail across staging-state precedence, expired/fenced leases, and producer-scoped upload authorization.
- migration-0032-rollback.test.ts: expected only migration 0032 to apply, but migration 0033 was also returned.
- migration-verify-trap-fix.test.ts: expected an error reporting 33 rows; current error reports 34 ledger rows and 33 distinct sequences.

Receipt 820 establishes these as already-red suites before this run; its summary does not preserve the exact assertion-level baseline, so I do not claim an A/B proof for each current assertion. They are not attributable to the current control-plane/policy/business-contract changes on the available evidence.

The contracts failures are the two existing toThrowError is not a function assertions in vault-policies.test.ts:104,179. They match the P745 A/B hash proof: the pre-edit contracts source hash 4cc34f0f… was restored byte-exactly and the same two failures reproduced. See [P745 receipt](p745-carrier-impl-a-2026-10-04.md) and [815 comparison](full-regression-815-2026-10-05.md). Worker-sdk has no failing tests.

## Focused verification

- Control-plane/policy regression: 9 suites; 8 passed, 1 failed; 97 passed / 1 failed test; exit **1**. The failure is the same legacy inventory count above. metadata-read-policy, metadata-window, wiring, counter, wrapper, result-ref, and new backfill cases passed in this focused run. See [raw output](raw/full-regression-825b-2026-10-05/focused-control-plane-policy-checkpoint4.log) and [exit](raw/full-regression-825b-2026-10-05/focused-control-plane-policy-checkpoint4.exit.txt).
- New backfill-cli-825.test.ts, run alone: 1 suite, **16/16 passed**, exit **0**. It covers gate refusal for blockers/incomplete slot coverage, approval decisions, eight-slot parity, fake-DB query generation/inventory, and expired-window refusal. It does not execute the CLI main path against PostgreSQL or Vault. See [raw output](raw/full-regression-825b-2026-10-05/focused-backfill-cli-825-checkpoint4.log) and [exit](raw/full-regression-825b-2026-10-05/focused-backfill-cli-825-checkpoint4.exit.txt).
- Business contract/list focused set: 3 suites passed, 1 suite skipped; 37 passed / 7 skipped tests; exit **0**. The skipped suite is the live-gated admin-base-routes.test.ts (requires DATABASE_URL); its real business and version-list routes were not exercised against PostgreSQL. See [raw output](raw/full-regression-825b-2026-10-05/focused-business-contract-checkpoint4.log) and [exit](raw/full-regression-825b-2026-10-05/focused-business-contract-checkpoint4.exit.txt).

## TypeScript

All requested tsc --noEmit -p tsconfig.json checks pass on the final snapshot:

| Package | Script used | Exit |
|---|---|---:|
| contracts | test:typecheck | **0** |
| orchestrator | typecheck | **0** |
| worker-sdk | lint | **0** |
| admin-web | typecheck | **0** |

Raw logs and literal exits are in raw/full-regression-825b-2026-10-05/*-tsc-final.*.

## Coverage and gaps

- metadata-read-policy.ts: 24 direct unit cases in metadata-read-policy.test.ts; all 24 passed in the focused run.
- backfill-metadata-cli.ts: 16 offline cases in backfill-cli-825.test.ts; fake DB only. No test invokes exported main() through an actual PostgreSQL/Vault path, and no package script points to this CLI.
- business-list.ts: business-contract-fix-820.test.ts has 3 offline cases; one directly exercises the empty business page and asserts the business_versions query/alias, while the other two cover connector errors. The two real HTTP/database list cases in admin-base-routes.test.ts were skipped by the live gate. No live database or Vault was used.

The initial exploratory runs crossed a changing working-tree snapshot: hashes show that the migration source changed and the backfill CLI/test appeared between checkpoints. Those runs are retained in raw evidence but superseded; the authoritative full results above were rerun after the final hash anchor, with no source/test changes during that run.

Raw artifacts, discovery lists, source/test hash inventories, and literal exit files are covered by [SHA256SUMS.txt](raw/full-regression-825b-2026-10-05/SHA256SUMS.txt).
