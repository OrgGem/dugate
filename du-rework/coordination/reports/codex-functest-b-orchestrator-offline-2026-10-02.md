# FUNCTEST-B Orchestrator Offline Receipt — 2026-10-02

## Scope and execution

Ran eligible suites one at a time from `du-rework/services/orchestrator`, using the literal command shown in the table for each suite. No source or test files were edited, no package was installed, no DB/Redis/S3/Docker infrastructure was started or used, no DB window was claimed, and no document-core suite was run. The repository already contained unrelated dirty and untracked files; this receipt is the only file intentionally added for this task.

Final suite result: **102/104 suites green**. Two suites failed in log-capture assertions (details below). `legacy-payload-migration.test.ts` had one batch invocation exit 1 without captured Jest summary; its isolated rerun passed 9/9, exit 0, and is counted green below. Thus 105 Jest invocations were made for 104 distinct eligible suites.

## Executed suites

`P/F/S` means Jest tests passed / failed / skipped within that suite. Each command cell is the literal per-suite command run from the orchestrator package.

| Suite | P/F/S | Exit | Literal command / result |
|---|---:|---:|---|
| operations-list-contract-conformance.test.ts | 19/0/0 | 0 | `npx jest --runInBand tests/operations-list-contract-conformance.test.ts` |
| operations-list-cursor-sort-binding.test.ts | 54/0/0 | 0 | `npx jest --runInBand tests/operations-list-cursor-sort-binding.test.ts` |
| admin-operations-list-pagination.test.ts | 103/0/0 | 0 | `npx jest --runInBand tests/admin-operations-list-pagination.test.ts` |
| legacy-payload-migration.test.ts | 9/0/0 | 0 on isolated rerun | `npx jest --runInBand tests/legacy-payload-migration.test.ts`; initial batch invocation exited 1 with no captured Jest summary, isolated invocation passed 9/9. |
| credential-legacy-transition-offline.test.ts | 13/0/0 | 0 | `npx jest --runInBand tests/credential-legacy-transition-offline.test.ts` |
| url-ingestion-backend-failclosed-offline.test.ts | 4/0/0 | 0 | `npx jest --runInBand tests/url-ingestion-backend-failclosed-offline.test.ts` |
| url-ingestion-consumer-offline.functional.test.ts | 35/0/0 | 0 | `npx jest --runInBand tests/url-ingestion-consumer-offline.functional.test.ts` |
| url-ingestion-offline.functional.test.ts | 3/0/0 | 0 | `npx jest --runInBand tests/url-ingestion-offline.functional.test.ts` |
| connector-credentials-offline.functional.test.ts | 19/0/0 | 0 | `npx jest --runInBand tests/connector-credentials-offline.functional.test.ts` |
| connector-revision-http-offline.functional.test.ts | 8/0/0 | 0 | `npx jest --runInBand tests/connector-revision-http-offline.functional.test.ts` |
| adm-base-03-safe-error-offline.functional.test.ts | 18/1/0 | 1 | `npx jest --runInBand tests/adm-base-03-safe-error-offline.functional.test.ts` |
| multipart-routes-offline.test.ts | 33/0/0 | 0 | `npx jest --runInBand tests/multipart-routes-offline.test.ts` |
| multipart-service-offline.test.ts | 52/0/0 | 0 | `npx jest --runInBand tests/multipart-service-offline.test.ts` |
| admin-shell-render.test.ts | 140/0/0 | 0 | `npx jest --runInBand tests/admin-shell-render.test.ts` |
| usage-aggregation.test.ts | 2/0/0 | 0 | `npx jest --runInBand tests/usage-aggregation.test.ts` |
| usage-contracts-integration-offline.test.ts | 19/0/0 | 0 | `npx jest --runInBand tests/usage-contracts-integration-offline.test.ts` |
| usage-drilldown.test.ts | 10/0/0 | 0 | `npx jest --runInBand tests/usage-drilldown.test.ts` |
| log-collector.test.ts | 3/0/0 | 0 | `npx jest --runInBand tests/log-collector.test.ts` |
| __probe-c63.test.ts | 3/0/0 | 0 | `npx jest --runInBand tests/__probe-c63.test.ts` |
| admin-action-dispatcher.test.ts | 55/0/0 | 0 | `npx jest --runInBand tests/admin-action-dispatcher.test.ts` |
| admin-actions-vault04-offline.functional.test.ts | 24/0/0 | 0 | `npx jest --runInBand tests/admin-actions-vault04-offline.functional.test.ts` |
| admin-api-keys.test.ts | 29/0/0 | 0 | `npx jest --runInBand tests/admin-api-keys.test.ts` |
| admin-api-key-view-model.test.ts | 84/0/0 | 0 | `npx jest --runInBand tests/admin-api-key-view-model.test.ts` |
| admin-audit-list-page.test.ts | 30/0/0 | 0 | `npx jest --runInBand tests/admin-audit-list-page.test.ts` |
| admin-audit-query.test.ts | 26/0/0 | 0 | `npx jest --runInBand tests/admin-audit-query.test.ts` |
| admin-audit-route.test.ts | 30/0/0 | 0 | `npx jest --runInBand tests/admin-audit-route.test.ts` |
| admin-audit-scope.test.ts | 21/0/0 | 0 | `npx jest --runInBand tests/admin-audit-scope.test.ts` |
| admin-audit-toolbar.test.ts | 67/0/0 | 0 | `npx jest --runInBand tests/admin-audit-toolbar.test.ts` |
| admin-business-view-model.test.ts | 95/0/0 | 0 | `npx jest --runInBand tests/admin-business-view-model.test.ts` |
| admin-config-cockpit.test.ts | 8/0/0 | 0 | `npx jest --runInBand tests/admin-config-cockpit.test.ts` |
| admin-connector-view-model.test.ts | 91/0/0 | 0 | `npx jest --runInBand tests/admin-connector-view-model.test.ts` |
| admin-crypto-config.test.ts | 83/0/0 | 0 | `npx jest --runInBand tests/admin-crypto-config.test.ts` |
| admin-crypto-config-oidc.test.ts | 6/0/0 | 0 | `npx jest --runInBand tests/admin-crypto-config-oidc.test.ts` |
| admin-error-boundary-offline.test.ts | 37/0/0 | 0 | `npx jest --runInBand tests/admin-error-boundary-offline.test.ts` |
| admin-idempotency.test.ts | 45/0/0 | 0 | `npx jest --runInBand tests/admin-idempotency.test.ts` |
| admin-list-contract-conformance.test.ts | 23/0/0 | 0 | `npx jest --runInBand tests/admin-list-contract-conformance.test.ts` |
| admin-local-user-repository.test.ts | 10/0/0 | 0 | `npx jest --runInBand tests/admin-local-user-repository.test.ts` |
| admin-local-users-cli.test.ts | 10/0/0 | 0 | `npx jest --runInBand tests/admin-local-users-cli.test.ts` |
| admin-oidc04-claims-tenant-offline.test.ts | 11/0/0 | 0 | `npx jest --runInBand tests/admin-oidc04-claims-tenant-offline.test.ts` |
| admin-oidc-flow.test.ts | 7/0/0 | 0 | `npx jest --runInBand tests/admin-oidc-flow.test.ts` |
| admin-operation-cockpit.test.ts | 4/0/0 | 0 | `npx jest --runInBand tests/admin-operation-cockpit.test.ts` |
| admin-operations-sort-http-offline.test.ts | 32/0/0 | 0 | `npx jest --runInBand tests/admin-operations-sort-http-offline.test.ts` |
| admin-operations-sort-wiring.test.ts | 47/0/0 | 0 | `npx jest --runInBand tests/admin-operations-sort-wiring.test.ts` |
| admin-operation-view-model.test.ts | 277/0/0 | 0 | `npx jest --runInBand tests/admin-operation-view-model.test.ts` |
| admin-overview-triage.test.ts | 158/0/0 | 0 | `npx jest --runInBand tests/admin-overview-triage.test.ts` |
| admin-overview-view-model.test.ts | 193/0/0 | 0 | `npx jest --runInBand tests/admin-overview-view-model.test.ts` |
| admin-p6-01-shell-fixtures.test.ts | 38/0/0 | 0 | `npx jest --runInBand tests/admin-p6-01-shell-fixtures.test.ts` |
| admin-profile-view-model.test.ts | 79/0/0 | 0 | `npx jest --runInBand tests/admin-profile-view-model.test.ts` |
| admin-shell-auth.test.ts | 29/0/0 | 0 | `npx jest --runInBand tests/admin-shell-auth.test.ts` |
| admin-shell-oidc-flow-integration.test.ts | 7/0/0 | 0 | `npx jest --runInBand tests/admin-shell-oidc-flow-integration.test.ts` |
| admin-shell-oidc-mount.test.ts | 6/0/0 | 0 | `npx jest --runInBand tests/admin-shell-oidc-mount.test.ts` |
| admin-shell-router.test.ts | 25/0/0 | 0 | `npx jest --runInBand tests/admin-shell-router.test.ts` |
| admin-shell-server.test.ts | 56/0/0 | 0 | `npx jest --runInBand tests/admin-shell-server.test.ts` |
| admin-shell-session-lifecycle.test.ts | 50/1/0 | 1 | `npx jest --runInBand tests/admin-shell-session-lifecycle.test.ts` |
| admin-sort-allowlist.test.ts | 7/0/0 | 0 | `npx jest --runInBand tests/admin-sort-allowlist.test.ts` |
| admin-view-model.test.ts | 196/0/0 | 0 | `npx jest --runInBand tests/admin-view-model.test.ts` |
| artifact-integrity-scanner.test.ts | 7/0/0 | 0 | `npx jest --runInBand tests/artifact-integrity-scanner.test.ts` |
| artifact-read-authorization.test.ts | 90/0/0 | 0 | `npx jest --runInBand tests/artifact-read-authorization.test.ts` |
| artifact-read-decrypt-offline.test.ts | 28/0/0 | 0 | `npx jest --runInBand tests/artifact-read-decrypt-offline.test.ts` |
| artifact-read-download-route.test.ts | 6/0/0 | 0 | `npx jest --runInBand tests/artifact-read-download-route.test.ts` |
| artifacts-fencing.test.ts | 6/0/0 | 0 | `npx jest --runInBand tests/artifacts-fencing.test.ts` |
| artifact-storage-service.test.ts | 13/0/0 | 0 | `npx jest --runInBand tests/artifact-storage-service.test.ts` |
| artifact-submit-guards.test.ts | 24/0/0 | 0 | `npx jest --runInBand tests/artifact-submit-guards.test.ts` |
| br08-cancel-resume-race-offline.test.ts | 5/0/0 | 0 | `npx jest --runInBand tests/br08-cancel-resume-race-offline.test.ts` |
| br12-isolation-offline.test.ts | 18/0/0 | 0 | `npx jest --runInBand tests/br12-isolation-offline.test.ts` |
| budget-evaluation-validator.test.ts | 4/0/0 | 0 | `npx jest --runInBand tests/budget-evaluation-validator.test.ts` |
| budget-reservations.test.ts | 10/0/0 | 0 | `npx jest --runInBand tests/budget-reservations.test.ts` |
| compat-decoders.test.ts | 46/0/0 | 0 | `npx jest --runInBand tests/compat-decoders.test.ts` |
| crypto-config-store.test.ts | 59/0/0 | 0 | `npx jest --runInBand tests/crypto-config-store.test.ts` |
| crypto-storage-facade.test.ts | 101/0/0 | 0 | `npx jest --runInBand tests/crypto-storage-facade.test.ts` |
| delivery-encryption.test.ts | 50/0/0 | 0 | `npx jest --runInBand tests/delivery-encryption.test.ts` |
| enc08-wire-enc07.test.ts | 9/0/0 | 0 | `npx jest --runInBand tests/enc08-wire-enc07.test.ts` |
| grant-artifact-pins.test.ts | 25/0/0 | 0 | `npx jest --runInBand tests/grant-artifact-pins.test.ts` |
| gsec-sentinel-rbac.boundary.test.ts | 10/0/0 | 0 | `npx jest --runInBand tests/gsec-sentinel-rbac.boundary.test.ts` |
| legacy-action-router.test.ts | 34/0/0 | 0 | `npx jest --runInBand tests/legacy-action-router.test.ts` |
| legacy-headers.test.ts | 66/0/0 | 0 | `npx jest --runInBand tests/legacy-headers.test.ts` |
| legacy-operations.test.ts | 27/0/0 | 0 | `npx jest --runInBand tests/legacy-operations.test.ts` |
| legacy-wire-decoders.test.ts | 10/0/0 | 0 | `npx jest --runInBand tests/legacy-wire-decoders.test.ts` |
| local-primitives.test.ts | 6/0/0 | 0 | `npx jest --runInBand tests/local-primitives.test.ts` |
| migrations-ledger-guard.test.ts | 17/0/0 | 0 | `npx jest --runInBand tests/migrations-ledger-guard.test.ts` |
| mm05-queue-integrity-offline.functional.test.ts | 4/0/0 | 0 | `npx jest --runInBand tests/mm05-queue-integrity-offline.functional.test.ts` |
| mm05-queue-integrity-sweep.test.ts | 11/0/0 | 0 | `npx jest --runInBand tests/mm05-queue-integrity-sweep.test.ts` |
| mm10-claim-cancel-flag-offline.test.ts | 10/0/0 | 0 | `npx jest --runInBand tests/mm10-claim-cancel-flag-offline.test.ts` |
| mm10-heartbeat-cancel-offline.test.ts | 9/0/0 | 0 | `npx jest --runInBand tests/mm10-heartbeat-cancel-offline.test.ts` |
| mock-oidc-idp.test.ts | 10/0/0 | 0 | `npx jest --runInBand tests/mock-oidc-idp.test.ts` |
| mock-vault-harness-offline.functional.test.ts | 16/0/0 | 0 | `npx jest --runInBand tests/mock-vault-harness-offline.functional.test.ts` |
| oidc03-role-action-tenant-offline.test.ts | 17/0/0 | 0 | `npx jest --runInBand tests/oidc03-role-action-tenant-offline.test.ts` |
| oidc-claim-shape-contract-offline.test.ts | 8/0/0 | 0 | `npx jest --runInBand tests/oidc-claim-shape-contract-offline.test.ts` |
| oidc-client.test.ts | 23/0/0 | 0 | `npx jest --runInBand tests/oidc-client.test.ts` |
| oidc-cookie-secure-proxy-offline.test.ts | 13/0/0 | 0 | `npx jest --runInBand tests/oidc-cookie-secure-proxy-offline.test.ts` |
| p8-01-audit-entity-offline.test.ts | 2/0/0 | 0 | `npx jest --runInBand tests/p8-01-audit-entity-offline.test.ts` |
| public-upload-encryption-gateway.test.ts | 9/0/0 | 0 | `npx jest --runInBand tests/public-upload-encryption-gateway.test.ts` |
| r24-01-poll-fence-offline.functional.test.ts | 5/0/0 | 0 | `npx jest --runInBand tests/r24-01-poll-fence-offline.functional.test.ts` |
| recipient-key-registry.test.ts | 49/0/0 | 0 | `npx jest --runInBand tests/recipient-key-registry.test.ts` |
| runtime-encryption-metadata.test.ts | 105/0/0 | 0 | `npx jest --runInBand tests/runtime-encryption-metadata.test.ts` |
| runtime-lease-fencing-offline.test.ts | 33/0/0 | 0 | `npx jest --runInBand tests/runtime-lease-fencing-offline.test.ts` |
| s3-multipart-storage-offline.test.ts | 16/0/0 | 0 | `npx jest --runInBand tests/s3-multipart-storage-offline.test.ts` |
| s3-multipart-upload.test.ts | 6/0/0 | 0 | `npx jest --runInBand tests/s3-multipart-upload.test.ts` |
| s3-storage-facade.test.ts | 10/0/0 | 0 | `npx jest --runInBand tests/s3-storage-facade.test.ts` |
| session-store.test.ts | 17/0/0 | 0 | `npx jest --runInBand tests/session-store.test.ts` |
| storage-migration.test.ts | 7/0/0 | 0 | `npx jest --runInBand tests/storage-migration.test.ts` |
| submission-metadata-crypto-e2e.test.ts | 42/0/0 | 0 | `npx jest --runInBand tests/submission-metadata-crypto-e2e.test.ts` |
| vault-transit-provider.test.ts | 9/0/0 | 0 | `npx jest --runInBand tests/vault-transit-provider.test.ts` |
| webhook-delivery-encryption.test.ts | 5/0/0 | 0 | `npx jest --runInBand tests/webhook-delivery-encryption.test.ts` |

## Failures (recorded, not changed)

1. `tests/adm-base-03-safe-error-offline.functional.test.ts`: **18 passed, 1 failed; exit 1**. Literal assertion output: `Expected substring: "deferred section render error"`; `Received string: ""`. Location: `tests/adm-base-03-safe-error-offline.functional.test.ts:210`.
2. `tests/admin-shell-session-lifecycle.test.ts`: **50 passed, 1 failed; exit 1**. Literal assertion output: `Expected length: 1`; `Received length: 0`; `Received array: []`. Location: `tests/admin-shell-session-lifecycle.test.ts:790`.

## Skipped suites

All 30 required deny-list suites below were skipped; no command was run for them. Each had `0/0/0` tests executed and is classified `SKIPPED-live`.

| Suite | Status | Command |
|---|---|---|
| admin-action-rbac-live.test.ts | SKIPPED-live (deny-list) | not run |
| admin-audit.test.ts | SKIPPED-live (deny-list) | not run |
| admin-audit-mount.test.ts | SKIPPED-live (deny-list) | not run |
| admin-base-routes.test.ts | SKIPPED-live (deny-list) | not run |
| admin-crypto-config-shell.test.ts | SKIPPED-live (deny-list) | not run |
| admin-crypto-config-wiring.test.ts | SKIPPED-live (deny-list) | not run |
| admin-error-boundary.test.ts | SKIPPED-live (deny-list) | not run |
| admin-keyset-explain.test.ts | SKIPPED-live (deny-list) | not run |
| admin-local-users-migration.test.ts | SKIPPED-live (deny-list) | not run |
| admin-mutation-atomicity.test.ts | SKIPPED-live (deny-list) | not run |
| admin-shell-live-pane.test.ts | SKIPPED-live (deny-list) | not run |
| admin-shell-platform-mount.test.ts | SKIPPED-live (deny-list) | not run |
| artifact-grant-fencing.test.ts | SKIPPED-live (deny-list) | not run |
| artifacts-fencing-pg.test.ts | SKIPPED-live (deny-list) | not run |
| blob-wire-binary.test.ts | SKIPPED-live (deny-list) | not run |
| data-02-04-live-s3.test.ts | SKIPPED-live (deny-list) | not run |
| encryption-boot-options.test.ts | SKIPPED-live (deny-list) | not run |
| graceful-shutdown.boundary.test.ts | SKIPPED-live (deny-list) | not run |
| ingress-bounded.test.ts | SKIPPED-live (deny-list) | not run |
| migrations.test.ts | SKIPPED-live (deny-list) | not run |
| oidc02-multi-replica-offline.test.ts | SKIPPED-live (deny-list) | not run |
| oidc02-process-replicas-offline.test.ts | SKIPPED-live (deny-list) | not run |
| oidc-boot.test.ts | SKIPPED-live (deny-list) | not run |
| operation-tenant-fence.test.ts | SKIPPED-live (deny-list) | not run |
| redis-session-repository.test.ts | SKIPPED-live (deny-list) | not run |
| runtime.test.ts | SKIPPED-live (deny-list) | not run |
| usage-summary.test.ts | SKIPPED-live (deny-list) | not run |
| webhook-error-boundaries.boundary.test.ts | SKIPPED-live (deny-list) | not run |
| webhook-reclaim-fence.live.test.ts | SKIPPED-live (deny-list) | not run |
| workspace-reference.test.ts | SKIPPED-live (deny-list) | not run |

Additional live suite found outside the specified 30: `rv0104-live-encryption.test.ts` — `SKIPPED-live`, no command run. It exercises live S3/Vault/network dependencies. No other `*.live.test.ts` suite outside the required list was identified. All other eligible suites used in-memory/fake services or local-only test harnesses; no external service or infrastructure was used.

## Totals

- Distinct eligible suites run: 104.
- Green suites: 102/104 (one green suite confirmed by isolated rerun after the initial batch command anomaly).
- Red suites: 2/104, detailed above.
- Skipped suites: 31 (30 required deny-list + `rv0104-live-encryption.test.ts`).
- Infrastructure used: **zero**; no DB window claimed.
- Source/test edits: **none**. No gates changed.
