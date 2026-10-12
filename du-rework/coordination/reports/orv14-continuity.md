# ORV14 continuity mapper checkpoint

Recorded `2026-10-11 23:03 UTC`. Scope: source-to-target mapper implementation and focused unit verification. Execution namespace: `unit-only / synthetic-v1`; no source or target databases were contacted.

## Verification

Working directory: `/workspace/dugate/du-rework/orchestrator/services/orchestrator`.

Commands:

```sh
/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node --check scripts/ldba-inventory.cjs
/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node --check scripts/ldba-continuity-runner.cjs
/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node --test --test-reporter=spec tests/ldba-continuity.test.cjs
```

Raw output is [unit-test-node24.21.0.txt](raw/orv14-continuity/unit-test-node24.21.0.txt), SHA-256 `3fea1dd9cfb616a59e8b256ac9cc4f4fa3a100def0acd1155271917c275d5bcb`. Outcome: 6 passed, 0 failed, 0 skipped. No migration, import, backup, restore, runtime probe, isolated rollout, or production cutover was executed.

## Source freeze

| File | SHA-256 |
|---|---|
| `orchestrator/services/orchestrator/scripts/ldba-continuity-runner.cjs` | `2d0124265ea2771e295d6d124ad000af6b86962c048661a900434c7cd975bf38` |
| `orchestrator/services/orchestrator/scripts/ldba-inventory.cjs` | `ce7ea6cbc6b2ec491c18395891d8d2490a12aa58157ba2a1db3ac8edc569cd7c` |
| `orchestrator/services/orchestrator/scripts/ldba-continuity-mappings.cjs` | `e7bcec2d3ff9d565672e4b04ff5e2a77a8610ffe92a7c8e4ea43413a0fa3b306` |
| `orchestrator/services/orchestrator/scripts/ldba-continuity-source.cjs` | `2f7830ee3bf7258604b1c6f6a3b4f49375daa77e2301bb0d0da31ca1f9b348f8` |
| `orchestrator/services/orchestrator/scripts/ldba-continuity-runtime.cjs` | `81055e6e2ad1b5cce3b5c1cb4c39ec084082e35a4202a3d844819a16263831de` |
| `orchestrator/services/orchestrator/scripts/ldba-continuity-evidence.cjs` | `4c71f0c532891f13a774a7da78ea411429481721354277a47d6dc4400421acc0` |
| `orchestrator/services/orchestrator/scripts/ldba-continuity-plan.cjs` | `469f96228377e2db95ed772f25044de31e04559bb3c549cf604a1631cd92b47e` |
| `orchestrator/services/orchestrator/tests/ldba-continuity.test.cjs` | `7586788f3136b50e4063f61f64c155baa168f738f244e0751693c13e29fd5e11` |
| `orchestrator/services/orchestrator/migrations/0057_legacy_continuity_evidence.sql` | `7a57b386925e5421a8c9324907a6d76d48d31f942491aa3ec6695a487baddf36` |

## Remaining full-rehearsal dependencies

1. Freeze and expose the typed tenant-scoped `DISABLED → RETIRED` Connector consumer with expected-current-revision CAS; the runner fails closed until that API is present.
2. Backend owns the shared build lease. The continuity runtime already names the normal built secret catalog writer and Connector import-journal service, but must be exercised only after the owner freezes a normal build and composition receipt. No shared `dist` output was rebuilt here.
3. Host must wire the frozen trusted dual-plane backup adapter, actual isolated runtime probe, and existing trusted two-slot rollout service with a new synthetic root-owned manifest and fixed ingress. No boolean-only or mocked runtime receipt is accepted.
4. A real synthetic fixture must provide exact legacy source rows and approved secret/key references for every setting, Connector, Profile, user, API key, artifact, and history row; this checkpoint has no such fixture.
5. Independent verifier must then review the complete run receipt and raw pass/fail/skip output. Until all gates pass, readiness remains pending and production cutover remains `NOT_PERFORMED`.

The code and tests are source-ready for an independent mapper review. This checkpoint is not a release approval or completion claim.
