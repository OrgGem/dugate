# ORV14 trusted isolated restore probe owner report

Implemented the trusted runtime probe and concrete host-only runtime ports in the two released Orchestrator leaves:

- `services/orchestrator/src/modules/maintenance/trusted-isolated-restore-probe.ts`
- `services/orchestrator/src/modules/maintenance/trusted-isolated-restore-runtime-ports.ts`

The concrete factory consumes the existing digest-pinned maintenance manifest loader and provides actual bounded launch/stop, health/control, target-network source-denial, libpq count/control, application login/history/download, and independent recovery-reader implementations. It requires a root-owned Linux host execution context and refuses to accept callbacks that provide caller-authored evidence. Launches use network-none, UID:GID 1000, protected mounted runtime files, the exact target-network policy in the target namespace, and a gate released only after policy inspection and network attachment. Cleanup is bound to the full Docker ID recorded in the per-run CID file and fails closed when ownership or stopped state cannot be proven.

The probe checks actual runtime identity/boot/control acknowledgement, DRAINING + LIVE/dependency status, disabled external effects, process-active work, actual source denial from both isolated runtimes, database and object-generation count reconciliation, authenticated artifact Transit decryption and application download, Catalog, Connector invocation and legacy credential, metadata Transit, and exact-version Vault recovery. It preserves unresolved historical holds. Metadata AAD fixtures cover all encrypted metadata slots, including canonical tuple/reference cases and wrong-AAD rejection. Stream cancellation, timeout, slow recovery, and owned-stop cleanup regressions are covered by the owner tests.

Owner verification on Node 24.21.0:

- `orv14-trusted-isolated-restore-probe-owner.test.ts` and `orv14-isolated-restore-runtime-ports-owner.test.ts`: 13 tests passed.
- Orchestrator TypeScript no-emit check passed.
- The embedded fixed HTTP child script parsed with Node's VM preflight.

This is an owner-scoped source/test receipt. No Docker containers or services were started, and no deployment credentials or customer data were used. It is not independent host verification or acceptance; Host verification still needs to exercise real pinned host tooling and prove source denial and recovery against the deployed isolated targets.
