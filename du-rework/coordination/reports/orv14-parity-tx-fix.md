# ORV14 Connector parity transaction-visibility fix

`PostgresConnectorParityRepository.toIntentResult` now receives the active `SqlClient`. Reads of a completed revision use that client, so `finalizeIntent` and completed `beginIntent` replays read through the open transaction instead of the global pool. The nontransactional `getIntent` path explicitly supplies the repository client. The existing authorization, revision AAD decryption, immutable credential pin, CAS and idempotency checks are unchanged.

## Owner checks

Run from `/workspace/dugate/du-rework` at approximately `2026-10-12 00:01 UTC`, with Node `v24.21.0`, in the shared local workspace execution environment. No database, Vault or provider service was contacted.

| Check | Command | Result |
| --- | --- | --- |
| Focused owner regression | `/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node orchestrator/services/connector/node_modules/jest/bin/jest.js --config orchestrator/services/connector/jest.config.cjs --runInBand orchestrator/services/connector/tests/orv14-parity-tx-visibility-owner.test.ts` | Exit 0; 1 suite, 1 test passed, 0 failed, 0 skipped. The fake SQL client rejects any global-pool read while a transaction is open; the test covers first finalization, completed `finalizeIntent` replay and completed `beginIntent` replay, with one revision insert total. |
| Targeted strict TypeScript check | `/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node orchestrator/services/connector/node_modules/typescript/bin/tsc -p coordination/reports/raw/orv14-parity-tx-fix/targeted-tsconfig.json` | Exit 0 for the changed repository, its imports and the owner test. |
| Connector package TypeScript check | `/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node orchestrator/services/connector/node_modules/typescript/bin/tsc --noEmit -p orchestrator/services/connector/tsconfig.json` | Exit 2 because the currently resolved shared contract declarations lack six `ConnectorBackupEffectFence*` exports imported by `src/db/backup-effect-fences.ts`. No diagnostics point to the changed parity repository or owner test. This check is retained as a workspace integration blocker, not reported as green. |
| Whitespace check | `awk '/[[:blank:]]+$/ { print FILENAME ":" FNR; bad=1 } END { exit bad }' orchestrator/services/connector/src/db/parity-repository.ts orchestrator/services/connector/tests/orv14-parity-tx-visibility-owner.test.ts` | Exit 0. |

The targeted test is an owner regression, not independent PostgreSQL/Vault evidence. The primary verifier must rerun the real HTTP/PostgreSQL/Vault lost-ack scenario against the hashes below. The frozen Vault writer was not modified; its SHA-256 remains `84bde0344cdaca87307619dbe8b27ab24abcb56760aa6a6e708f9fad8a870f29`.

## Source hashes

| File | SHA-256 |
| --- | --- |
| `orchestrator/services/connector/src/db/parity-repository.ts` | `525aca9ff32c2c25d31e01e83aebd60e5c1e6a24cb44e9f6929583f62ebff1fc` |
| `orchestrator/services/connector/tests/orv14-parity-tx-visibility-owner.test.ts` | `5757afc5c5c2cf2cd5b1e45cbcec01b4dd8554f67487955404a7dac14725eac7` |

Raw command outputs and the targeted TypeScript config are in `coordination/reports/raw/orv14-parity-tx-fix/`. Independent actual PostgreSQL/Vault verification remains outstanding.
