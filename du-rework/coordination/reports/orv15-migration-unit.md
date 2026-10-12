# ORV15 migration offline verification

Status: the scoped offline migration tests pass. This is unit and injected-port evidence only; the Native19 source-off rehearsal and the historical A2 database-plane failure remain open.

## What was checked

- Added `orv15-migration-a2-adapter.test.cjs`, which exercises public `runBackfill()` with separate injected Connector and Orchestrator target pools. It checks that a connector revision and sealed secret land in the Connector plane, the Orchestrator receives only its provenance row, and an exact same-source replay is idempotent.
- Added `orv15-migration-integrity.test.cjs`, which checks that source artifact byte-count and MD5 mismatches stop before target writes. Its inventory cases verify real stored-byte SHA256 and size, bounded aggregate size, counters, and that inventory output contains no blob bytes.
- Updated the authorized `legacy-workflow-schema-backfill-adapter.test.ts` fake database to model the public writer's `business_id` / `business_version` projection and insert parameters, while retaining support for the production reader's six-column projection. Its existing metadata sealing/decryption, digest, tenant isolation, origin, idempotency, and compare-and-swap checks remain intact.
- Updated the authorized local identity assertion in `ldba-03-backfill-offline.test.cjs`: the imported local user remains disabled and reset-required, while `is_locked` is false. The source context has no legacy local lock column, and reset activation requires a disabled, reset-required, unlocked account; assignments remain asserted.

No migration product source was changed. The adapter, inventory, context, identity, readiness, and workflow schema code inspected for this lane already contain the tested behavior. The fake query mismatch was a test fixture gap, not a workflow schema source defect.

## Verification

All commands ran in `/workspace/dugate/du-rework/orchestrator/services/orchestrator` on Node 24.21.0 from `/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node`, with no external service or network use.

| Check | Result | Raw output |
| --- | --- | --- |
| `DU_VAULT_MOCK=false node node_modules/jest/bin/jest.js --config jest.unit.config.cjs --runInBand tests/legacy-workflow-schema-backfill-adapter.test.ts` | 1 suite, 7/7 passed at 2026-10-12 05:37:26 UTC | [attempt-03 workflow-schema Jest log](raw/orv15-migration-unit/attempt-03/workflow-schema-jest-postfix.stdout.log) |
| `node --test tests/ldba-03-production-adapter.test.cjs tests/ldba-03-backfill-offline.test.cjs tests/ldba-continuity.test.cjs tests/orv15-migration-a2-adapter.test.cjs tests/orv15-migration-integrity.test.cjs` | 56/56 passed at 2026-10-12 05:37:39 UTC | [attempt-03 related CJS log](raw/orv15-migration-unit/attempt-03/related-cjs-final.stdout.log) |
| `DU_VAULT_MOCK=false node node_modules/jest/bin/jest.js --config jest.unit.config.cjs --runInBand tests/admin-local-identity-cas.test.ts tests/orv12-migration-readiness.test.ts` | 2 suites, 12/12 passed at 2026-10-12 05:37:39 UTC | [attempt-03 identity/readiness Jest log](raw/orv15-migration-unit/attempt-03/identity-readiness-jest-final.stdout.log) |
| Orchestrator `tsc --noEmit -p services/orchestrator/tsconfig.json --pretty false` | Exit 0 on the earlier offline pass; the later edits were test fixtures only | [attempt-01 compiler log](raw/orv15-migration-unit/attempt-01/orchestrator-noemit.stdout.log) |

The CJS batch includes the two new files and the corrected disabled-user assertion. The focused workflow suite exercises the existing encrypted schema writer and reader through its injected fake database and local in-memory Transit implementation.

## Preserved red history and limits

- The first related CJS batch was 55/56 because the stale identity test expected `is_locked=true`; the authorized assertion now follows the documented reset-required activation policy. Its original output is preserved at [attempt-01 related CJS red](raw/orv15-migration-unit/attempt-01/related-cjs-red.stdout.log).
- The workflow schema Jest suite first failed because its fake did not recognize the expanded writer projection. The next attempt also exposed the reader's still-valid six-column projection. Both intermediate reds are retained in [attempt-01](raw/orv15-migration-unit/attempt-01/workflow-schema-jest.stdout.log) and [attempt-02](raw/orv15-migration-unit/attempt-02/workflow-schema-jest-postfix.stdout.log); attempt-03 is green.
- The historical Native19/A2 run remains a strict red: 29 rows read and 19 settings observed, with two ExternalApiConnection transformations blocked by `relation "secret_versions" does not exist`. It did not import or replay those rows. This mock-pool test does not address that deployment-plane/schema problem.
- No Native19 source-off rehearsal, real PostgreSQL migration, Redis, S3, Vault, service, or provider interaction was run. Those remain required for full migration acceptance.

## Post-run input hashes

These are observed hashes for the scoped source and test leaves after the final run. Production sources were inspected but not edited in this lane.

| File | SHA-256 |
| --- | --- |
| `orchestrator/services/orchestrator/scripts/ldba-03-production-adapter.cjs` | `dbba7dadb8c1872d9770db677f0f1ffc2d2d69a9f8ef4542399c6266b60255a9` |
| `orchestrator/services/orchestrator/scripts/ldba-03-backfill.cjs` | `11fd332907b1e3111b1ff285ef1f96076f9300a0424bb3024b59f5d3dbfd045c` |
| `orchestrator/services/orchestrator/scripts/ldba-inventory.cjs` | `ce7ea6cbc6b2ec491c18395891d8d2490a12aa58157ba2a1db3ac8edc569cd7c` |
| `orchestrator/services/orchestrator/scripts/ldba-context-provider.cjs` | `c0208013748da82a14cf8548859413f51057f87f75d67889fd0d70dbd3a0b34e` |
| `orchestrator/services/orchestrator/src/modules/workflow-schemas/workflow-schemas.ts` | `ccdc69e4f8106217361cbcb163616464a0be042d3d43142b7c510ef0f433b21c` |
| `orchestrator/services/orchestrator/src/modules/workflow-schemas/legacy-workflow-schema-backfill-adapter.ts` | `8f4a484846bed1172f7c7f23685276770aab68e209d7ca691d31a91771ef6eff` |
| `orchestrator/services/orchestrator/tests/ldba-03-backfill-offline.test.cjs` | `d6c2a3799166190c2880b5ae0c59fe30b8ab5851d10c78645c9efee734d162d0` |
| `orchestrator/services/orchestrator/tests/legacy-workflow-schema-backfill-adapter.test.ts` | `85a5b88879a9ed79a50eb78693b72442572f74f087c95a19fb2e204704325ca4` |
| `orchestrator/services/orchestrator/tests/orv15-migration-a2-adapter.test.cjs` | `c3c33eab5ea591aeec4645add437a1a30add402b01859b2ecccc199e8c371f48` |
| `orchestrator/services/orchestrator/tests/orv15-migration-integrity.test.cjs` | `c8f7a6f5cd832a3647c6d3abf806d65fd2f04266a55555340453d0674b2eba29` |
