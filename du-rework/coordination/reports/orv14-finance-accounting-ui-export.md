# ORV14 Finance Accounting UI and Export — owner handoff

Observed 2026-10-12 01:14 UTC in `/workspace/dugate/du-rework`. This is the implementation-owner receipt for the Usage UI/export follow-up. It is not independent verification or product acceptance. Source hashes and exact check commands are in [the raw receipt](raw/orv14-finance-accounting-ui-export/owner-checks.txt) and [source manifest](raw/orv14-finance-accounting-ui-export/source-sha256.txt).

## Affected task rows

- **COST-01** — [`docs/admin-ops-monitoring-cost.md:44`](../../docs/admin-ops-monitoring-cost.md#L44): Usage event rows keep the immutable initial computed charge separate from the server-returned direct-root gross, refund and net amounts. The adjustment panel compares the event snapshot with the current history response, shows original effective time separately from recorded time, and marks incomplete historical evidence proof without upgrading it. History export contains only the current bounded server page and includes action kind/amount, root/revision, UTC times, authority, opaque actor ID and evidence-proof status.
- **COST-03** — [`docs/admin-ops-monitoring-cost.md:46`](../../docs/admin-ops-monitoring-cost.md#L46): the summary copy identifies current cost as the server-projected net value. Event CSV remains limited to the displayed query page and now includes the exact server-provided initial/gross/refunded/net amounts, root, revision and semantics. It does not calculate net in the browser or reprice with current prices.

Guide 49's narrow accounting paragraph now describes the server envelope, page-only event CSV, current-page history export, missing-value behavior and scoped read/current Admin write boundary.

## Implemented and owner-verified

The Usage parser accepts the exact financial accounting envelope, verifies its original root and immutable initial amount against the event row, and preserves current amounts exactly as returned. An older response without the envelope remains readable with accounting fields unavailable. Event rows display the original computed charge separately from current gross/refunded/net; the summary copy describes its server-projected current net. The adjustment panel flags when its fresh history response differs from the event page snapshot, labels historical object proof completeness row by row, and keeps server-blocked history read-only.

The event CSV exports only the visible server page and appends the original/root accounting values without changing existing event columns. The adjustment history CSV uses only the latest fetched history page, includes direct-root target/refund and effective/recorded UTC fields, opaque actor and authority, current server summary, evidence pins and explicit proof completeness. CSV cells use the existing formula-neutralizing escaping for reasons and other string fields. The export omits cursors and does not imply full-history export.

The existing write rule remains a current platform Admin session; the history read continues to use the server's tenant/role scope. No alert-recipient or inbox state is consulted for finance authority. No money is calculated or repriced in the browser.

Write responses are classified by server problem code: `BACKUP_EFFECT_FENCE_ACTIVE` reports the maintenance hold and keeps the reviewed command and its entered details; `COST_ADJUSTMENT_CAS_CONFLICT` reloads history and requires review against the current head; `IDEMPOTENCY_CONFLICT` has separate feedback and requires a fresh review. An unclassified 409 does not claim the head changed. A 503 or unavailable response remains UNKNOWN and retains the exact pending command and idempotency key.

Owner checks passed: Admin TypeScript no-emit (exit 0), focused tests `orv14-finance-accounting-ui-export-owner` and `orv13-usage-owner` (2 suites, 10 tests, exit 0), scoped whitespace scan (no matches), and the tracked-file diff check (exit 0). These checks cover source/type/helper behavior, not a mounted browser or database-backed path.

## Verification limits and handoff

This lane did not build a shared Admin bundle, run the mounted browser or accessibility checks, execute a PostgreSQL migration/service test, or run Docker Compose. Primary independent verification should exercise the maintenance 409, CAS 409, and unknown 503 states in a mounted browser. The Usage and Backend server/client DTO work is owned by those lanes. Correct-model review remains required before any acceptance. Historical incomplete proof remains visibly read-only; owner checks do not verify recovery or artifact repair.

Changed owner paths are frozen at the hashes in the source manifest: the Usage state/screen, adjustment panel, cost-state copy, unique regression test and guide 49. All unrelated dirty work is preserved. No commit, push, deployment, production/customer action or acceptance was performed.
