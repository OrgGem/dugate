# ORV15 Host independent unit receipt

- Task: `VFY-ORV15-HOST`
- Base/HEAD: `b276ede4d3032d197a2ba96ba79c18b0f6e3c139`
- Branch: `codex/fix-workflow-builder`
- UTC sample: `2026-10-12T05:28:33.648695245Z`
- CWD: `/workspace/dugate/du-rework/orchestrator/services/orchestrator`
- Runtime: Node `v24.21.0`, executable `/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node`, SHA-256 `7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c`
- Unit config: `jest.unit.config.cjs`, SHA-256 `027032b21948140175b7880769addeaec51ca68623bb277133c9f207b45c92a0`
- `DU_VAULT_MOCK` was not `true`; the configured global setup is a no-op in this environment.
- External service/process/network use: none. Fake DB/control/process/object-store boundaries and a local temporary filesystem only. No Docker, image, DB, Redis, S3, Vault, provider, HTTP, or namespace commands.

Command:

```text
/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node ./node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/orv15-vfy-host-backup-fence.test.ts tests/orv15-vfy-host-effect-journal.test.ts tests/orv15-vfy-host-restore-pins.test.ts tests/orv15-vfy-host-context.test.ts
```

Result: exit `0`; 4 suites passed, 12 tests passed, 0 failed, 0 skipped, 0 snapshots. Exact output:

```text
PASS tests/orv15-vfy-host-restore-pins.test.ts
PASS tests/orv15-vfy-host-backup-fence.test.ts
PASS tests/orv15-vfy-host-context.test.ts
PASS tests/orv15-vfy-host-effect-journal.test.ts

Test Suites: 4 passed, 4 total
Tests:       12 passed, 12 total
Snapshots:   0 total
Time:        2.981 s, estimated 12 s
Ran all test suites matching /tests\/orv15-vfy-host-backup-fence.test.ts|tests\/orv15-vfy-host-effect-journal.test.ts|tests\/orv15-vfy-host-restore-pins.test.ts|tests\/orv15-vfy-host-context.test.ts/i.
exit_code=0
```

Independent test SHA-256:

```text
ce88ef9eadd131c6c0049c70416385bb167e5f58910aa6e615aaee84bb724558  orchestrator/services/orchestrator/tests/orv15-vfy-host-backup-fence.test.ts
b40b37bf80bf7b138056efc001a505bd6781f99ed6cb15e59485f796be479dd7  orchestrator/services/orchestrator/tests/orv15-vfy-host-effect-journal.test.ts
0bfeccd62ca286df734917d548012669837dbc5d0d19347f8bc7b955dc525706  orchestrator/services/orchestrator/tests/orv15-vfy-host-restore-pins.test.ts
20914e2663d0ce003cc1edc6dfae4b1de8c249b1e3ad41046d89eb1229eeb11f  orchestrator/services/orchestrator/tests/orv15-vfy-host-context.test.ts
```

Product dependency SHA-256 sampled immediately after the focused run. This is an input manifest for this unit result, not a whole-source freeze:

```text
b32e01ad7b885dbec1aec57748fc822061079fb4952588362a310db5e1d4d516  orchestrator/services/orchestrator/src/modules/maintenance/backup-fence.ts
67b054b5903c7af58210beb490c96c1991e42640c4488b8747b311e8580332d9  orchestrator/services/orchestrator/src/modules/maintenance/backup-effect-fence.ts
9c07fac310e9e3d24d57ce3680b34f92b8c24b65782dbb14a88eda15ebd6d497  orchestrator/services/orchestrator/src/modules/maintenance/connector-backup-effect-coordinator.ts
c05c59bdba7295ced69a80c85f452af7596a3dc06052f96f6c428a58f7196cb0  orchestrator/services/orchestrator/src/modules/maintenance/connector-backup-effect-control.ts
9bfd5ea8bdd7adc758b3ba78b535021c24b22e99fd018d08dc8aaae21b456d4e  orchestrator/services/orchestrator/src/modules/maintenance/replica-runtime-safety.ts
dbc28b517b31578dfe2c87e72f3fbe4d27eacc49a2862e6a3d05e0a595e07467  orchestrator/services/orchestrator/src/modules/maintenance/trusted-backup-adapter.ts
c7f3d7b01487706172c0868440905ac29a12c7b31ddeedf71d1cb1d609b6f1f4  orchestrator/services/orchestrator/src/modules/maintenance/trusted-isolated-restore-runtime-ports.ts
5bb62bbf7db3960f1bef1ca8be49923fc7aa1d2e5990a62962e815843c7cc221  orchestrator/services/orchestrator/src/modules/maintenance/trusted-manifest-rollout-adapter.ts
6219585c2bd786e5cd11ec23064a89e3f08e81665b7286a52727b0689cf09b82  orchestrator/services/orchestrator/src/modules/artifacts/artifacts.ts
007b32a1c5c57d52971bf10ce67e4449704dd0ceee7713d28b1e4ce7633a1d97  orchestrator/services/orchestrator/src/modules/encryption/crypto-storage-facade.ts
c51f50a78ce5355a4db7bf34ab027a883353e00dafa39eb667dff25d18e1d5c9  orchestrator/services/orchestrator/src/maintenance-host-execution-context.ts
bd6c1fd354201a5033c3f4ce9ecef6e977188c9b715624a0d4e995f88b2bdd7c  orchestrator/services/orchestrator/src/maintenance-host-runner.ts
```

Coverage exercised at public interfaces: six replica observations (current DRAINING state and fresh ACK), stale/future/missing-ACK refusal before Orchestrator hold, exact Connector blue/green fence handoff, current global durable owner counting with only the exact live backup item excluded, UNKNOWN artifact effect replay without a second activation/external write, exact seven-source nft policy validation and mutation rejection, user-owned/symlink manifest rejection, generation-A object plus key-version-1 sidecar recovery while B is current, and standalone Host context shared gate injection/resource close with no HTTP listener plus web-role/argv refusal.

Limitations: root-owned positive manifest acceptance was not faked; current UID cannot create a valid root-owned fixture. The nft policy function was tested as a pure validator, not applied to a kernel namespace. Injected external boundaries do not constitute live PostgreSQL, Docker, S3/Vault, source-off or HA acceptance. No product source was modified by this verifier.
