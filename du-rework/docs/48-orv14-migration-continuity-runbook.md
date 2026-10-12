# ORV14 legacy continuity rehearsal

## Status

The source-to-target mapper is implemented and its focused unit suite passes. No frozen database source was read, no database was changed, no import was applied, and no backup, restore, source-off probe, or cutover rehearsal was run in this checkpoint. Production cutover remains `NOT_PERFORMED`. Do not treat the unit receipt as migration or runtime evidence.

The mapper consumes a root-owned, SHA-256-pinned synthetic manifest and the legacy adapter's repeatable-read source snapshot. It requires exact source version/hash/count/timezone/settings pins and checks the unchanged source again after reconciliation. Apply is idempotent for the same source and plan; it rejects changed source, stale baseline, and any target-core change beyond the approved staged password-reset transition.

## Mapping contract

All seventeen original settings are covered: sixteen functional settings map to tenant AI defaults, five tenant prompt defaults, a typed Connector revision, a storage generation, or a retention revision; `api_secret_key` is evidenced by source hash and retired without decrypting or importing it. Two additional archived DOCX mode settings have explicit retirement dispositions. The mapper verifies exact Connector recipe/revision/state and credential import receipts, all Profile source rows and persisted binding/content fields, Profile prompt overrides, API key hashes/status/limits/timestamps, identity source assignments, active-key-only routable grants, imported user/reset state, and immutable target snapshot hashes. It preserves imported source assignments to revoked keys as history while withholding their Admin grants.

Credential values remain in the trusted runner process only and are passed to the built Catalog and Connector import services. Evidence and output include only opaque IDs/version refs, counts, hashes, and status. No source password or credential is written to a report. Local users requiring activation remain disabled until the supported Admin password reset path succeeds; locked, disabled-by-source, and OIDC identities remain fail-closed.

## Synthetic execution procedure

Use only a new isolated synthetic source/target namespace. The root-owned manifest must pin the namespace, source version/hash/counts/timezone proof, archived-settings hash, settings source/default hashes, target tenant, connector recipes and exact source-row mappings, Profile projection, approved origins, and baseline target inventory hash. The source and target connection strings must be distinct. Provide secret values and service credentials through the approved runtime secret channel, never shell arguments or saved output.

From `/workspace/dugate/du-rework/orchestrator/services/orchestrator`, first run:

```sh
/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node scripts/ldba-continuity-runner.cjs --continuity-preflight
```

The runtime environment must include the pinned manifest path/digest and namespace (`LDBA_CONTINUITY_MANIFEST_FILE`, `LDBA_CONTINUITY_MANIFEST_SHA256`, `LDBA_CONTINUITY_NAMESPACE`), distinct legacy source and target database URLs, a separate Connector target URL, and the approved internal Admin origin/bearer. Review the sanitized output and all holds. Only a synthetic namespace with a reviewed manifest may be applied. Then set `LDBA_CONTINUITY_APPLY=1` in the approved environment and run:

```sh
/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node scripts/ldba-continuity-runner.cjs --continuity-apply
```

The apply must use the normal built Orchestrator secret catalog writer and connector secret-import journal, plus the typed Connector, settings, retention, storage, and identity APIs. Do not substitute a mock secret writer, optional callback, direct SQL settings write, or source-only fake consumer. If any typed retirement/import or built composition API is missing, the runner must stop with a safe blocked code.

After mapping passes, use the Host-owned trusted maintenance preview/job flow to create a fenced dual-plane backup and restore into new isolated Orchestrator and Connector databases and a new storage generation. The required actual isolated runtime probe must prove source-off login/reset, Profile/history read, artifact decrypt/download for every pinned key version, disabled dispatch/provider/usage/background loops, exact runtime identities, zero active work, and exact object/key/count reconciliation. Then run the existing trusted two-slot rollout service against a separate root-owned synthetic manifest and fixed synthetic ingress to prove candidate cutover, serving identity, source drain, and rollback. These are isolated synthetic operations only. Production remains `NOT_PERFORMED`; customer cutover evidence and authorization are separate gates.

## Source-ready test receipt

At `2026-10-11 23:03 UTC`, in namespace `unit-only / synthetic-v1` (no database namespace), Node `v24.21.0` ran the continuity suite from `/workspace/dugate/du-rework/orchestrator/services/orchestrator`:

```sh
/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node --check scripts/ldba-inventory.cjs
/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node --check scripts/ldba-continuity-runner.cjs
/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node --test --test-reporter=spec tests/ldba-continuity.test.cjs
```

Result: 6 passed, 0 failed, 0 skipped. Raw reporter output: [`unit-test-node24.21.0.txt`](../coordination/reports/raw/orv14-continuity/unit-test-node24.21.0.txt), SHA-256 `3fea1dd9cfb616a59e8b256ac9cc4f4fa3a100def0acd1155271917c275d5bcb`.

The source hashes and execution handoff are in [`orv14-continuity.md`](../coordination/reports/orv14-continuity.md). This receipt covers only source-level helpers and unit tests; it is not an independent verification or full continuity rehearsal receipt.
