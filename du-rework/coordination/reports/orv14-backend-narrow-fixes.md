# ORV14 backend narrow fixes — owner receipt

Date: 2026-10-11 UTC. These are source owner checks, not independent VFY acceptance.

The incident upsert now qualifies `ON CONFLICT DO UPDATE` references with the INSERT alias `i`. VFY independently observed the same source hash and can continue the real PostgreSQL incident lifecycle run. The admin operation mapper now includes `correlationId` from the selected `correlation_id` for the authenticated admin list/detail wire. `toOperationView` and the public operation contract remain unchanged.

The Connector Catalog import path now performs a signed, tenant-scoped Connector ownership/head claim before reading the Catalog secret. It seals the resolved payload before the draft call, retries with the exact same immutable Catalog revision and Connector idempotency key, and verifies the Connector's masked credential reference before accepting it. Exact replay rechecks ownership through the Connector claim; no Catalog re-resolution occurs.

Focused owner check, run under Node 24.21 from `orchestrator/services/orchestrator`:

```text
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs \
  tests/orv14-incident-upsert-alias-owner.test.ts \
  tests/orv14-operations-correlation-owner.test.ts \
  tests/orv14-connector-secret-imports-owner.test.ts
```

Result: 3 suites passed, 9 tests passed. Full output is in `coordination/reports/raw/orv14-backend/narrow-owner-tests.txt`; incident-only output is in `coordination/reports/raw/orv14-backend/incident-upsert-owner-test.txt`.

Source hashes at this receipt:

```text
6c259cb19dda2af013c1fd6d7423c9eb525d9512679e915cdb8487fe87749556  orchestrator/services/orchestrator/src/modules/incidents/service.ts
2cd8882e9d589cea9d8a15f7469f25adedf146e808c903312db789bd77c8fede  orchestrator/services/orchestrator/src/modules/operations/mappers.ts
887a82c3eb093873806def1acaf0e90576a44a6e4b2e3c556ab872264f4d848b  orchestrator/services/orchestrator/src/modules/connectors/connector-secret-imports.ts
d76fec74a30d08ff8f099e84c593ee93ed7e67d19c7395af223b6a755404e53c  orchestrator/services/orchestrator/src/modules/connectors/connector-management-store.ts
19e5f594504efc423e2d68b3ba8719af4bc82dbca22db187e019c9f3806945c9  orchestrator/services/orchestrator/src/http/routes/internal-parity.ts
f0a6763532c4ff6d8d75d9c91191b8fa57ccbf0108ac00860deba7dfa3f61b0b  orchestrator/services/orchestrator/src/app/bootstrap/create-app.ts
025bb381a0e5f9a0965d9b326dbac5125bd49b49fbe7720559f7a723760d17c5  orchestrator/services/orchestrator/tests/orv14-incident-upsert-alias-owner.test.ts
95e0679bac5b6bc00c47d6a2ab769aa4393051d94039b0e2c93d0307d0c99a88  orchestrator/services/orchestrator/tests/orv14-operations-correlation-owner.test.ts
40ca5c0ee683ae9e892ba311ee50f47c6cb81f5400bf0e8e9080b094b04e42ea  orchestrator/services/orchestrator/tests/orv14-connector-secret-imports-owner.test.ts
```

The package typecheck and final shared build are not claimed by this receipt; they remain separate full-integration and verifier checks.

The later interim contracts refresh receipt and its in-rework source/output manifests are recorded at [contracts-refresh-receipt.md](raw/orv14-backend/contracts-refresh-receipt.md). The original manifests outside the rework tree remain preserved and hash-equal to these scoped copies.

## Isolated restore runtime

`DU_ISOLATED_RUNTIME_MODE=restore-rehearsal` is parsed only at process startup into `ServerConfig.isolatedRuntimeMode`; unknown values fail boot. The mode requires the exact per-replica service-runtime identity and an already-migrated isolated DB. Bootstrap keeps the live service-runtime heartbeat but starts it in durable DRAINING state, and the HTTP request tracker counts allowed reads while rejecting mutations before body parsing/route dispatch. The only POST exceptions are Admin login/logout and the staged Identity password activation route in the Admin BFF/internal parity paths. Dispatcher, ingestion consumer, lease/cancellation recovery, queue/multipart/artifact cleanup, and webhook loops are forced off even if timers were explicitly set in config.

The isolated-mode owner test covers method/path allowlisting, durable DRAINING initialization, tracked Admin GET, and 503 rejection before dispatch. The same focused command above now passes 4 suites / 11 tests. Full package no-emit typecheck exits 2 only on current Cost Control owner errors: `app/admin/bff/cost-control.ts:109` and `:165` discriminant narrowing, plus `modules/cost-control/reservation-groups.ts:734` trust-reason union narrowing. It reports no diagnostics in the isolated-runtime changes.

Updated source hashes:

```text
a8f0c70e44bc32f5d309e1f8f5cf61dfbcb233e9f7b178d7aa7eb29eff189d7d  orchestrator/services/orchestrator/src/modules/service-runtime/service-runtime.ts
7e1ad6259d5b2b2845ad0e37ad82e05a2fa811a5599c5c132c2140752f719d69  orchestrator/services/orchestrator/src/app/bootstrap/create-app.ts
3ef6e41502117196600d76bb6c85e43b68b72532ada09a78260ffa3010b68b09  orchestrator/services/orchestrator/src/main.ts
9d731e7682aa77e7d31b5168c569b87792b94cacd4eb5bdad0a0968b1c288206  orchestrator/services/orchestrator/src/server.ts
ed92ca6d745fe063641c066b4a78ff443a9ec278965120d09dd96ba404dde7b3  orchestrator/services/orchestrator/tests/orv14-isolated-runtime-owner.test.ts
```
