# ORV14 financial accounting owner checkpoint

**State:** implemented at source and owner-focused checked. This is not independent verification or acceptance. The primary verifier still needs the actual PostgreSQL, HTTP/evidence, backup-fence, export, and mounted-UI journey against this source.

## Delivered source

The new adjustment service in `orchestrator/services/orchestrator/src/modules/cost-control/adjustments.ts` exposes `getHistory(query, actor)`, `listEvidence(query, actor)`, and `adjust(command, actor, idempotencyKey)`. Its production dependencies include the DB, audit service, exact evidence resolver, backup write gate, and live Admin-session revalidator. The evidence resolver returns the logical artifact digest/size separately from the exact encrypted object digest/size, generation and object version, and exact sidecar digest/size/version.

Adjustment writes preserve the original usage event and use an append-only direct-root history. Corrections set gross charge; refunds add a positive amount bounded by current net. The service checks current head revision, immutable settlement/provenance and all pinned budget windows, uses integer arithmetic, and commits the adjustment, derived head, exact idempotency result, and audit record atomically. The backup gate is the first write transaction lock and remains held through commit. Exact committed retries revalidate the current platform Admin before reading the stored result; they may bypass a held write gate because they perform no write. New adjustments revalidate again after evidence streaming and gate acquisition. The live Admin check is independent of notification-channel state.

`modules/usage/effective-charges.ts` provides the shared `loadEffectiveCharges(client, roots, {recordedAsOf?})` projection. `usage.ts`, `reservation-groups.ts`, `budget-reservations.ts`, and `spend-admission.ts` use it for net monetary accounting while retaining original units once. Pending and unpriced rows have null effective money instead of treating a raw numeric zero as priced cost. `operations-metrics.ts` was inspected and left unchanged: it has counts and durations, no monetary reader.

The Admin Usage event envelope keeps the immutable initial charge and provides server-computed gross, refunds, net, adjustment revision/head, and accounting semantics separately. The runbook is [docs/52-financial-accounting-runbook.md](../../docs/52-financial-accounting-runbook.md); it links to the existing broader [Usage and cost guide](../../docs/admin-ops-monitoring-cost.md) without changing that guide.

## Owner checks

At 2026-10-12 01:14 UTC, from `/workspace/dugate/du-rework/orchestrator`, the owner checks ran on Node v24.19.0, Jest 29.7.0, and TypeScript 5.9.3. Node v24.19.0 is below the required Node >=24.21 toolchain, so these results are useful owner diagnostics but do not satisfy the pinned-toolchain check; the primary independent Node 24.21 run must supersede them.

- The focused command recorded in `coordination/reports/raw/orv14-financial-accounting-service/owner-check-metadata.txt` passed **6 suites / 43 tests**, with zero failures or skips. It covers the new effective-charge arithmetic and exact-replay authorization tests plus the narrow reservation, settlement, spend-admission, and offline Usage contract regressions.
- `services/orchestrator/node_modules/.bin/tsc --noEmit -p services/orchestrator/tsconfig.json` exited 0 with no diagnostics.
- Logs and source hashes are in [raw/orv14-financial-accounting-service](raw/orv14-financial-accounting-service/).

The prior owner fixture changes were limited to `budget-reservations.test.ts`, `orv12-usage-settlement.test.ts`, `usage-contracts-integration-offline.test.ts`, and `orv12-spend-admission.test.ts`. The Backend owner retains `orv13-backend-usage-events.test.ts`. Existing red receipts remain in place; this focused green does not replace the real PostgreSQL receipt or establish the end-to-end adjustment chain.

## Verification still required

The primary verifier must exercise the migration-backed command on PostgreSQL: correction 100→80, refund 30, net 50, unchanged units, stale-revision conflict, exact replay under current Admin authority, revoked/disabled/role-changed replay denial, audit rollback, foreign/incomplete evidence rejection, and evidence object/sidecar pin verification. It must also prove the backup gate races the write, every monetary reader agrees on net, old UTC-window credits do not change current-window admission, and export/history retain the immutable initial versus gross/refund/net values.

The current mounted UI journey and restore/recovery coverage are separate required gates. A passing owner suite does not verify the central authorization/composition, PostgreSQL DDL behavior, backup snapshot consistency, or browser output. No production data or credentials were changed; no provider was called; no build artifact was produced.
