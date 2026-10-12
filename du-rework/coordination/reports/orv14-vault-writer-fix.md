# ORV14 Vault writer plan fix

Implemented the scoped writer correction in `orchestrator/services/connector/src/vault/writer.ts`. The writer now projects only the destination fields into the strict KV v2 reference schema, validates the persisted CAS/version/hash plan before transport, and keeps the request deadline active while it reads a bounded response stream. Oversized bodies are canceled as soon as the limit is crossed; stalled body reads time out and cancel. The exact-plan reconciliation path remains write-once after a lost response.

## Owner checks

Run from `/workspace/dugate/du-rework` at approximately `2026-10-11 23:49 UTC`, with Node `v24.21.0`, in the shared local workspace execution environment. The checks used synthetic fetch/streams and made no network or Vault calls:

| Check | Command | Result |
| --- | --- | --- |
| Focused owner test | `/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node orchestrator/services/connector/node_modules/jest/bin/jest.js --config orchestrator/services/connector/jest.config.cjs --runInBand orchestrator/services/connector/tests/orv14-vault-writer-plan-owner.test.ts` | Exit 0; 1 suite, 13 tests passed, 0 failed, 0 skipped. |
| Connector TypeScript | `/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node orchestrator/services/connector/node_modules/typescript/bin/tsc --noEmit -p orchestrator/services/connector/tsconfig.json` | Exit 0. |
| Diff whitespace check | `git diff --check -- orchestrator/services/connector/src/vault/writer.ts orchestrator/services/connector/tests/orv14-vault-writer-plan-owner.test.ts` | Exit 0. |

The owner regression covers a complete staged write plan, one CAS write, exact replay after a lost response without a second write, malformed/out-of-scope destinations, invalid versions and digest, streamed response cancellation at the byte cap, and timeout/cancellation while reading a stalled response. These tests use a synthetic fetch implementation; they do not call Vault or establish the independent PostgreSQL/Vault flow.

The Host verifier's earlier scratch compile reported TS2454 for a timer used before assignment while this source was in flight. The timer is now explicitly optional and only cleared after assignment. This final Connector no-emit check passes. That transient compile did not execute its test body and is not treated as a product test result.

## Source hashes

| File | SHA-256 |
| --- | --- |
| `orchestrator/services/connector/src/vault/writer.ts` | `84bde0344cdaca87307619dbe8b27ab24abcb56760aa6a6e708f9fad8a870f29` |
| `orchestrator/services/connector/tests/orv14-vault-writer-plan-owner.test.ts` | `8af7e366c9f9235eae28246a43f657bf0fc9921f0071b9047641bc692eea0434` |

Raw owner command output is under `coordination/reports/raw/orv14-vault-writer-fix/` (`owner-jest.log`, `connector-tsc.log`, `diff-check.log`). SHA-256: `owner-jest.log` `e9701ca6bfd3bc50fd3a36c7639eed77bcb1402f89d58b1f9fe174db572bf0a4`; both successful empty-output logs `connector-tsc.log` and `diff-check.log` `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. The prior independent lost-ack/setup diagnostics remain preserved under `coordination/reports/raw/orv14-verification/`; this report does not replace or reinterpret them. Independent actual HTTP/PostgreSQL/Vault verification remains outstanding.
