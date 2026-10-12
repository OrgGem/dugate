# Financial adjustment runbook

This runbook covers the append-only correction and refund path for Admin Usage. It complements the broader [Usage and cost guide](admin-ops-monitoring-cost.md), which describes pricing, budgets, alerts, and event drill-down.

## Before adjusting an event

Open the original Usage event and confirm its tenant, operation, invocation, provider/model, measured or estimated status, and current financial history. The event's `initialChargeMicrousd` is immutable. The accounting view separately reports the current gross charge, cumulative refunds, net charge, adjustment revision, and head event ID. A provider-reported amount is diagnostic and unverified; it never sets a charge or budget amount.

Only an original event with trusted price and attribution provenance and a completed settlement is eligible. Pending, unpriced, BASIC legacy, unsettled, and `UNKNOWN` events remain unchanged. The eligibility response gives safe blocker codes; do not infer missing provenance or replace it with a current connector or price configuration.

Use an existing, tenant-authorized, READY input artifact as evidence. The server verifies its immutable content and the exact encrypted object and sidecar versions before allowing a write. A filename, browser-provided hash, provider response, or free-text reason alone is not evidence. The evidence reference and a bounded reason are retained with the adjustment; storage locators and credentials are not exposed.

## Choose the adjustment

- A **correction** sets the replacement gross charge in integer micro-USD. It does not change the original Usage event, consumed units, price snapshot, or original effective time. A correction cannot set gross below refunds already accepted. Submitting the existing gross amount records an audited no-op rather than another ledger row.
- A **refund** adds a positive credit in integer micro-USD. It cannot exceed the current net charge. Refunds do not restore tokens, pages, or other consumed quota.

Both actions require the current history revision. If another adjustment commits first, the command returns a conflict; reload the event and review the new gross, refund, and net amounts before preparing another command. Reuse the same idempotency key only when retrying the identical command after an uncertain response.

## Authorization and write behavior

Financial writes require a current platform Admin cookie session, CSRF proof, and a server-resolved principal. The service rechecks the live session and current Admin role before reading an idempotent result, then rechecks authority after evidence verification and the backup write fence. Notification channel membership does not grant or revoke financial authority. Tenant operators, viewers, and local USER accounts can read only their authorized usage scope and cannot create adjustments.

The backup snapshot write fence is acquired in the same database transaction as the adjustment and remains held through commit. If the fence is held or unavailable, the write fails closed; retry after the backup operation finishes. A committed identical retry can return its prior result only after current Admin authority is revalidated. It performs no ledger mutation.

The ledger is append-only. Each accepted adjustment links directly to the original event and prior adjustment head, and records both its original effective time and its server-recorded time. The service applies the head revision with compare-and-set, updates the derived head, stores the exact idempotent result, and writes its audit record atomically. A failed audit or database write leaves no partial adjustment.

## Reading totals and exports

Usage summaries, operation totals, budget committed spend, and legacy spend projections use the same net-charge projection. Original units are counted once. A late correction or refund is attributed to the original UTC quota window; an old-period credit does not carry into a new period. Adjustment history separately shows each correction/refund, target or delta, effective time, recorded time, actor category, evidence proof completeness, and revision. `costMicrousd` on the original event remains the initial amount.

If older history lacks a verifiable raw-object proof, it stays visible with an incomplete-proof marker, but cannot be extended with a new adjustment. Do not backfill a missing hash or version by guessing. Pending, unpriced, and other unavailable amounts remain explicitly unknown rather than being reported as a measured zero.

## Operational limits

This path does not re-run a provider, re-settle a reservation group, release an `UNKNOWN` hold, or reinterpret provider-reported cost. It records an authorized financial accounting change only. An independent PostgreSQL, HTTP, export, backup-fence, and mounted-UI verification is required before treating the complete financial adjustment journey as accepted.
