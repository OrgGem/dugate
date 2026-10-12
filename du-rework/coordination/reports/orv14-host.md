# ORV14 Host maintenance and HA source receipt

Status: **IMPLEMENTING / owner smoke only**. The Host source set is available to the independent tester, but the Host lane is not independently verified or accepted. No production deployment, cleanup, database restore, Docker command, or customer-data operation was run.

## Delivered source

Host source adds durable queue controls and recovery, maintenance preview/job flows, bounded retention/cache/orphan/multipart cleanup, immutable storage generations with retained-generation history, exact generation-bound artifact reads/writes, trusted manifest rollout, durable runner primitives, dual-plane encrypted backup/isolated restore adapters, runtime safety evidence, and the Connector restore-rehearsal isolation mode. The storage history route is internal `GET /api/internal/maintenance/storage-generations`; storage generation actions remain previewed/versioned and preserve opaque managed-secret references only. The Connector restore process requires an exact runtime identity and a pre-seeded DRAINING control row before listen, skips migration/registration and usage delivery, cancels Vault token renewal after the one initial login, and exposes a fresh control acknowledgment separately from unresolved work counts.

The owner source hash list is [source-sha256.txt](raw/orv14-host/source-sha256.txt). It includes the maintenance/storage/rollout/backup source leaves, migration 0052, Host runtime/worker SDK leaves, the narrow Connector isolation source, owner tests, and this runbook. Shared contracts `dist` and application build output were not written by Host.

## Owner verification

Environment at the time of these checks: Node `v24.19.0`, pnpm `11.25.0`; the repository declares Node `>=24.21.0 <25`, so this is an environment-version caveat. Checks used package-local binaries and did not install dependencies or change lockfiles.

| Check | Working directory | Result |
| --- | --- | --- |
| `./node_modules/.bin/tsc --noEmit -p tsconfig.json --pretty false` | `orchestrator/packages/contracts` | Exit 0, no diagnostics |
| `./node_modules/.bin/tsc --noEmit -p tsconfig.json --pretty false` | `orchestrator/services/connector` | Exit 0, no diagnostics |
| `./node_modules/.bin/tsc --noEmit -p tsconfig.json --pretty false` | `orchestrator/services/orchestrator` | Exit 0, no diagnostics |
| `./node_modules/.bin/jest --runInBand --config jest.unit.config.cjs tests/orv14-host-isolated-connector.test.ts tests/orv14-connector-runtime-control.test.ts tests/composition.test.ts` | `orchestrator/services/connector` | 3 suites passed, 11 tests passed |
| `./node_modules/.bin/jest --runInBand --config jest.unit.config.cjs tests/orv14-host-storage-generation-history.test.ts tests/orv14-host-replica-safety.test.ts tests/orv14-host-backup-adapter.test.ts` | `orchestrator/services/orchestrator` | 3 suites passed, 5 tests passed, 3 skipped |

Raw Jest output is retained in [connector-owner-jest.log](raw/orv14-host/connector-owner-jest.log) and [orchestrator-owner-jest.log](raw/orv14-host/orchestrator-owner-jest.log); the latter's three skipped checks require root-only filesystem/runtime setup. Successful no-emit typechecks produced empty diagnostic logs. This is source-owner smoke, not source-independent verification.

## Remaining integration and evidence

The trusted backup and rollout constructors require real composition ports: trusted manifest path plus digest, replica runtime-safety source, durable maintenance runner identity, cross-plane `backupFence`, exact recovery-key resolver, and actual isolated restore runtime probe. At this source checkpoint, the shared `create-app` wiring does not yet instantiate the trusted rollout/backup adapters, runtime-safety composition, or maintenance runner. The six-effect backup fence must prove fresh zero in-flight admission, dispatch, provider issuance, Connector polling, artifact mutation, and Connector usage delivery. The source-off restore probe must launch real isolated processes and dependencies, exercise login/history/download and each required decrypt family, and preserve unknown historical work. A synthetic cutover must use a new isolated two-slot manifest and the same trusted rollout path; production cutover remains `NOT_PERFORMED`.

The independent Host tester owns real process/PG/SDK/HA/backup exercises and its own receipt. No Docker/Compose/PG/S3/Vault rehearsal was run by this owner. The following checks are therefore still open: actual composed maintenance/backup/rollout adapters, the complete dual-plane fence, isolated restore/decrypt proof, synthetic two-slot cutover/restart/rollback, root-only checks, and independent API/UI/browser verification.

## Runbook

Operator procedures and explicit safety gates are documented in [45-maintenance-storage-ha-runbook.md](../../orchestrator/docs/45-maintenance-storage-ha-runbook.md).

## Follow-up owner checkpoint — 2026-10-12

This is a later, still-interim source checkpoint; the report above's original Node `v24.19.0` smoke and hash file are historical and do not describe this source snapshot. With Node `v24.21.0`, Orchestrator and Connector no-emit typechecks pass. Focused owner suites pass: six Host maintenance/restore suites (18 passed, four privileged checks skipped), and Connector process-boot control 3/3. Additional storage-generation/history, public encrypted artifact read, restore sidecar, heartbeat, runner, isolated runtime, and bootstrap suites pass; a fixture that omitted the nullable backup-fence observation columns was corrected to explicit SQL `NULL` and now passes 2/2 (one root-only manifest check skipped). No product source behavior was changed for that fixture correction.

The independent Host verifier reports a real-PostgreSQL maintenance/rollout claim interleaving pass. It proves HELD blocks both claim types, only the exact owning backup item is subtracted from the global work count, PREPARE hands off through the durable candidate row, a fresh host-controller instance completes CUTOVER, and a pre-effect database constraint failure leaves a terminal FAILED job with its owner lease cleared. The fixture used synthetic runtime/Connector/ingress adapters, so this is scoped database evidence rather than full rollout or backup acceptance. Raw receipt: [claim interleaving](raw/orv14-host-verification/orv14-vfy-host-claim-mv4qkvvl-206d46df/receipt.json).

Current selected maintenance source hashes: `backup-effect-fence.ts` `67b054b5903c7af58210beb490c96c1991e42640c4488b8747b311e8580332d9`; `backup-fence.ts` `b32e01ad7b885dbec1aec57748fc822061079fb4952588362a310db5e1d4d516`; `trusted-backup-adapter.ts` `57bdf72810f83e2fc6ad84c0ea7621bde73f04fe83fd105d0166b893b666b256`; `trusted-isolated-restore-probe.ts` `e62017717065b3d7f6d212e6354eed876a8a6b90c7438bcde8eba55c6cf6ea4c`; `trusted-isolated-restore-runtime-ports.ts` `c7f3d7b01487706172c0868440905ac29a12c7b31ddeedf71d1cb1d609b6f1f4`; `rollouts.ts` `af556ed3830f03b75b864ccb33a79b607fadb75f74234218a191e8d5ff3fe594`. These selected leaves typecheck and their focused suites pass; they are not a complete frozen source manifest.

The full integration remains open. The production `createMaintenanceHostExecutionContext` factory was not present in the current source read, and the independent actual dual-plane backup plus source-off isolated restore/decrypt/download rehearsal has not been performed. The Host lane remains **IMPLEMENTING / not independently accepted**.

## Follow-up owner checkpoint — bounded child shutdown

The dedicated host runner now signals only active child-process groups registered by the trusted backup and rollout adapters when `stop()` begins. Each adapter sends TERM, escalates to KILL after its bounded grace period, waits for process close, and reports the interrupted result as ambiguous; the existing durable maintenance path records backup interruption as UNKNOWN, and rollout commands return the existing UNKNOWN outcome. This does not make an ambiguous item claimable. Host shutdown waits at most 30 seconds by default. If the active durable claim has not settled by then, the production CLI exits without closing pools underneath the active claim; the owner lease and effect journal remain for later UNKNOWN reconciliation, not replay.

The focused host runner, backup adapter, and rollout controller suites pass 11 tests, with four root-only checks skipped. The latest Node 24.21.0 Orchestrator no-emit check passes after Backend's boot-policy leaf landed. Current source hashes: `active-command-shutdown.ts` `488d340e9bc6cff8c9c0a75b394007aabcb8d600a1f2b241858e8236b8ee8dda`; `host-maintenance-runner.ts` `d330a0272ee8f1cd4df4b17cbed4f5be3783cba36ea18f44a74eaab0c2aca49b`; `trusted-backup-adapter.ts` `dbc28b517b31578dfe2c87e72f3fbe4d27eacc49a2862e6a3d05e0a595e07467`; `trusted-manifest-rollout-adapter.ts` `4b6e9d3c5c4662c12462bc4efbb8cedcd22d3facd1f8597663f2574b2f786b52`; `maintenance-host-runner.ts` `711b40fe89c3b57be490de6b95b457e38ebc689d750b0423e75491f4fb54e9a6`; owner tests `orv14-host-command-shutdown-owner.test.ts` `94942dd67c01fdec5b800a23f68754cffe446009420d176e2e3585c996e28e5c` and `orv14-host-runner-owner.test.ts` `bcc3b216dea53a194e01e92eb585da5da8544d6ea34bc1569ed3def1c7b45c28`.

Worker E2E attempt 29 completed with a preserved RED result: the grants had valid HMAC and workflow override digests, but the fixture observed no Connector invocation, cost group, provider call, or response state. This is not counted as a passed provider execution. Host CLI composition is still awaiting the central `createMaintenanceHostExecutionContext` factory, and the real dual-plane/source-off restore rehearsal remains outstanding.

## Follow-up owner checkpoint — Connector production boot identity

The Connector entrypoint now rejects production startup without the complete runtime-control identity tuple before composition/database startup. Local/test environments remain optional; restore-rehearsal mode still requires an exact tuple through its explicit fail-closed check. Node 24.21.0 Connector no-emit passes, and the focused identity/cost-control environment suites pass 6/6. Hashes: `entrypoint.ts` `75ce40e4c1bd21520c8546b355eed41ddccade8f5d5e276ff292c37bf438b7ee`; `runtime-control-environment.ts` `8cba31e94429323f59499ca007a01e97b07d3ffa2367c97fca0c3a37fec5af8e`; `orv14-production-runtime-identity-owner.test.ts` `984dceebb4a7f893dcdc7844d237f22cafa20dfd492195b548e603e47f927062`. The normal WFA15 execution suite is pending a source-pinned verifier run.
