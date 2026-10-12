# ORV14 finance and Settings UI follow-up — owner handoff

Observed 2026-10-12 00:25 UTC in `/workspace/dugate/du-rework`. This is an implementation-owner receipt for the actual follow-up packet, not an independent verification or acceptance decision. The shared worktree remains dirty; the hashes below pin the exact files read by the owner checks.

## Affected task rows and resulting behavior

- **COST-01** — [`docs/admin-ops-monitoring-cost.md:44`](../../docs/admin-ops-monitoring-cost.md#L44): Usage event details now open a typed adjustment history/review panel. It presents server-projected initial/gross/refunded/net amounts, eligibility blockers, original immutable attribution and quota-window pins, and paged decisions. Corrections replace gross charge; refunds are positive deltas. Review binds the current adjustment revision, reason, and a selected evidence artifact; the browser does not compute net or accept raw evidence IDs. Provider-reported amounts remain visibly unverified diagnostics.
- **COST-03** — [`docs/admin-ops-monitoring-cost.md:46`](../../docs/admin-ops-monitoring-cost.md#L46): rich Usage rows show the provider-reported diagnostic and difference only alongside a separately computed cost. Adjustment history does not alter original units, cost provenance, price snapshot, or event effective time.
- **CFGADM-03** — [`tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md:112`](../../tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md#L112): Storage Settings now query metadata by tenant, `storage.credential` purpose, `orchestrator` service and `ACTIVE` state; server-side search and cursor continuation replace the first-200-only lookup. The selected value remains an exact managed `secretId@revision`; query/tenant changes clear stale selections and request generations.
- **CFGADM-07** — [`tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md:116`](../../tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md#L116): Tenant AI Settings now query a protected tenant ACTIVE Connector catalog with search and cursor continuation. Platform Admin queries carry the chosen tenant; tenant-operator queries omit tenant widening and are pinned by the BFF. The selector uses safe catalog metadata and exact revision pins; no raw-ID entry or platform-list fallback is used.

The binding audit projection also has a privacy correction: new local and OIDC actor labels are provenance-marked (`local-user:<UUID>` and `oidc-principal:<opaque-directory-UUID>`). Historic `session:<UUID>` labels are masked because UUID shape cannot distinguish an old IdP subject from a server-generated identifier. The audit record retains trusted issuer/subject only on the server side. This was an additive, exact-path review handoff; it does not change alert delivery or authorization policy.

## Implemented, verified, accepted

**Implemented:** source UI and focused owner helpers cover the typed cost-adjustment review/history, computed versus provider-reported display, paged Secret Catalog search, and tenant-pinned paged Connector selection. Owner documentation 49/50 describes those flows. The small actor-label projection fix masks ambiguous historical binding labels and marks new labels with their trusted provenance.

**Verified by the owner:** Admin TypeScript no-emit, six focused Jest cases across the two named owner suites, and `git diff --check` all passed on the hashes in the raw receipt. These checks establish type and helper behavior only; they do not prove a mounted browser flow or a database-backed command.

**Accepted:** none by this receipt. No independent UI review, final Admin bundle, browser/axe run, real PostgreSQL adjustment/evidence/CSRF/idempotency test, Docker Compose runtime test, or end-to-end financial projection test was run here.

## Current integration dependencies and limits

The Backend and Host have now reported the typed Connector client/BFF consumer, Orchestrator proxy, and Host tenant ACTIVE Connector producer implemented. The UI query is `GET /admin/api/parity/tenant-connectors` with bounded `{tenantId?,q,cursor,limit}`. The BFF derives/validates tenant scope and forwards to the signed Orchestrator parity route; Connector serves `/internal/admin/connector-revisions/active` under the `connector:management` capability, with strict query validation and tenant-echo checking. Host reports 2/2 focused owner cases and Connector no-emit exit 0. The current selector path is pinned in the raw source manifest.

The adjustment DTO/migration/client methods exist, but the Backend reported that the Usage-owned adjustment service/projection and its internal/BFF route/bootstrap composition are still pending. The UI therefore cannot yet prove a live history/read, evidence listing, CAS write, or resulting ledger/budget projection. Host/independent VFY still needs to exercise actual server evidence pin validation, platform-only authorization, CSRF/idempotency, stale-head behavior, and supported recovery/backup-fence semantics.

No new shared bundle was built. `docs/19`, `docs/28`, and `docs/35` remain with the reserved final evidence/document owner. The packet's required independent mounted-browser and real-service checks remain open; this source handoff does not close COST-01/03, CFGADM-03/07, `G-ADMIN-OPS`, or any release gate.

## Exact current source and dependency hashes

See [`source-sha256.txt`](raw/orv14-finance-settings-ui/source-sha256.txt) for the source files, owner tests, docs, current contract declaration and central API/BFF dependency hashes.

Owner command receipts: [`owner-checks.txt`](raw/orv14-finance-settings-ui/owner-checks.txt).
