# ORV14-COST-UI-ALERTS owner receipt

Status at 2026-10-11 23:35 UTC: **implementation and owner checks complete; independent verification and acceptance remain open.** This receipt covers the Cost UI/alert source lease only. It does not mark COST-01..04, `G-ADMIN-OPS`, or the ORV14 parent accepted.

## Implemented source path

- Usage & Cost UI now shows ledger provenance, BASIC legacy rows, explicit pending/unpriced states, server-bounded cursor pages and one-page CSV export. Computed cost is identified as derived from measured units and the frozen price snapshot. Provider-reported amounts remain a separately labeled, unverified diagnostic, and do not affect trusted totals, admission, settlement, or alerts.
- Budget and price editors use immutable revision draft/diff/review/publish/retire/rollback flows with guided server-searched and cursor-paged tenant catalogs. Budget owner and channel binding remain separate from `BudgetConfig`; the channel is the first-party owner inbox.
- Transactional alert production is frozen as `enqueueCostBudgetAlerts(client: PoolClient, facts: CostBudgetAlertEnqueueFacts)`. It checks the exact published budget revision and current recipient, derives scope from that snapshot, verifies the canonical quota-scope key, and writes deduplicated alert and frozen delivery rows inside the caller transaction. Usage calls the port from reservation preflight and final settlement transactions.
- The real bounded delivery service claims rows with a lease, rechecks the frozen recipient, and atomically inserts the owner inbox receipt with `DELIVERED`. Retry attempts are bounded. A stale/disabled/revoked OIDC recipient is durably `HELD`, with no recipient retargeting, inbox insertion, or false delivered status.
- External owners are eligible verified platform OIDC Admins represented by server-generated opaque recipient IDs. Verified issuer/subject values remain server-side. Current session principal and authorization-version pins gate recipient operations and inbox reads. Self registration takes an empty body and the trusted Admin cookie; the UI offers it without requiring a budget. Audited lifecycle CAS can disable, explicitly re-enable a disabled recipient, or terminally revoke its alert-inbox capability. These lifecycle actions do not disable normal OIDC application access.
- Added the single additive `0061_cost_alert_oidc_recipients.sql` migration, preserving the existing local-user foreign keys/history and the `0059` delivery schema. The guide at `docs/49-cost-policy-alert-operations.md` documents computed/reported cost semantics, OIDC recipient lifecycle, held deliveries, and migration order.

The Backend-owned browser client and central BFF dispatcher expose the recipient list/self/lifecycle methods and inbox read tenant parameter. The internal route is mounted through the Backend-owned server route dispatcher, and the Backend-owned configured runner uses the bounded batch contract. Backend owns these integration files and the contracts `dist` build; they are not included in the owner source manifest.

## Owner verification

All commands ran from `/workspace/dugate/du-rework` with Node `v24.21.0` at `/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node`. No Docker/Compose, live PostgreSQL/Redis, external IdP, production service, or real notification provider was used in these owner checks. No tests were skipped.

| Check | Result | Raw output |
|---|---:|---|
| Contracts `tsc -p orchestrator/packages/contracts/tsconfig.json --noEmit` | exit 0 | [contracts tsc](raw/orv14-cost-ui-alerts/final-20261011-contracts-tsc.txt) |
| Admin web `tsc -p orchestrator/apps/admin-web/tsconfig.json --noEmit` | exit 0 | [Admin web tsc](raw/orv14-cost-ui-alerts/final-20261011-admin-web-tsc.txt) |
| Orchestrator `tsc -p orchestrator/services/orchestrator/tsconfig.json --noEmit` | exit 0 | [Orchestrator tsc](raw/orv14-cost-ui-alerts/final-20261011-orchestrator-tsc.txt) |
| Contracts `cost-alerts.test.ts` | 1 suite / 6 tests passed, exit 0 | [contracts test](raw/orv14-cost-ui-alerts/final-20261011-contracts-jest.txt) |
| Admin BFF client transport test | 1 suite / 1 test passed, exit 0 | [client test](raw/orv14-cost-ui-alerts/final-20261011-admin-client-test.txt) |
| Orchestrator BFF, enqueue, delivery, OIDC-recipient, and scope-catalog owner tests | 5 suites / 21 tests passed, exit 0 | [Orchestrator tests](raw/orv14-cost-ui-alerts/final-20261011-orchestrator-owner-tests.txt) |

The owner tests use fake database/client adapters for transactional call shape and recipient lifecycle predicates. They are source-owner smoke, not independent PostgreSQL, IdP, multi-replica, delivery, browser, or Compose verification.

## Affected requirements and evidence boundary

Affected canonical rows are `COST-01` through `COST-04` in `docs/admin-ops-monitoring-cost.md`, plus the ORV14-COST lane in `coordination/ORV14-FULL-ADMIN-EXECUTION-2026-10-11.md`. The unique owner suites are `cost-alerts.test.ts`, `orv14-cost-alerts-client-owner.test.mjs`, and the five `orv14-cost-alerts-*-owner.test.ts` suites named above.

Still required before `VERIFIED`/`ACCEPTED`: independent current-source migration and PostgreSQL transaction/race tests; verified synthetic IdP callback and two-replica session pin/current-directory tests; real delivery-to-own-inbox/read proof; a current Admin browser review/build and full application integration/Compose checks. These are separate verification gates and are not represented by the owner receipts above. Preserve any newer independent red or partial result over this receipt.

## Frozen owner manifest

The exact SHA-256 manifest for the owned source, unique tests, and guide is [source-sha256.txt](raw/orv14-cost-ui-alerts/source-sha256.txt), SHA-256 `7a5c9a14971a2d68b5085d24478114d545f33cbaa134088a80ac300bc912eb07`. It includes the owned Usage UI leaves, alert contract/service/routes/migrations, owner tests, and `docs/49-cost-policy-alert-operations.md`. Backend shared client/dispatcher and generated contracts output remain separately owned integration inputs.
