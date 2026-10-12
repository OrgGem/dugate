# Incident and system operations guide

This guide covers the Admin incident ledger and the source-backed system operations screens added for ORV14. Open **System Operations** from the Admin navigation. The Overview links lead to the same service, queue, deployment, and incident details. List filters and selected targets live in the URL so browser Back and copied links retain the operator's place.

## Read the signals

The landing screen combines the currently available health, worker, queue, operation, metric, service, and incident projections. Every source reports its sample time and freshness. `Unknown`, `Unavailable`, `Stale`, or a partial sample means the source did not establish a current healthy state; an empty list is not a health check. Refresh failures retain the last good sample with its original timestamp.

Services shows only replicas and dependencies returned by the host inventory, with desired and observed revision, state, last seen, active work, control state, and per-replica deployment links. Workers & Queues shows the returned queue counts, oldest age, admission state, compatibility, and worker observations. Search applies to the loaded inventory sample; it is not a server query over an unbounded service registry. A deployment deep link can select a service or replica.

The incident ledger is source-bound and persistent. Each incident records source and source reference, scope, severity, first and last seen, sample time, affected resources, counters, threshold revision, owner, state version, and lifecycle history. Runtime replica readiness incidents use the host's actual worker heartbeat inventory; queue integrity incidents use the real queue-integrity sweep; tenant Connector incidents use the sanitized persisted invocation and usage-outbox signal snapshot. Provider configuration alone does not create a healthy or failed provider signal.

The runtime heartbeat sample must be fresh and current. An empty/stale inventory cannot recover an incident; an incident for a specific replica recovers only when that same replica appears `READY` in a fresh sample. The Connector source window is bounded to 30 days and the producer returns a bounded recent set of source references. The page labels the Connector sample fresh, stale, unavailable, or not selected. A stale, missing, mismatched, or old Connector sample cannot create or recover an incident. A pending count reaching zero is not recovery evidence by itself. The corresponding invocation must be observed in a terminal source state, or the exact usage outbox event must have a recorded delivery timestamp.

## Triage an incident

1. Open the incident from Overview or search/filter the ledger by status, severity, source, and text. Use the next-page link for the server cursor; changing filters starts a new query.
2. Open its detail to review the affected resource references and chronological event history. Follow a resource link only where that resource has a mounted detail route. Opaque invocation and delivery references are displayed as evidence IDs when no corresponding safe detail route is available.
3. Assign an owner from the current server-authorized Identity lookup. The browser submits only the selected identity ID; the internal service validates that the identity remains enabled and belongs to the incident's allowed scope.
4. Acknowledge with an optional reason to record a responder and audit event. Acknowledgement does not resolve the source or clear the incident.
5. Resolve only after the incident has a source-recovered or source-reconciled history event. Select that exact event as evidence and supply a reason. The service rechecks the incident version and evidence event transactionally; a stale form returns a conflict and requires a reload.

Incident writes use expected state versions. The database transaction stores the state change, history entry, and audit event. Repeated source samples update the active incident identified by its source-bound deduplication key. Suppression does not delete or hide incident history.

## Create a maintenance suppression

Platform Admins can create a platform-scoped suppression or a specific tenant, service, queue, Connector, or operation suppression. A tenant operator can suppress only their own tenant scope. Every suppression requires a reason and expires within 24 hours. The UI shows its expiry and active state; the ledger retains the incident and exposes the suppression flag while its scope and time window match.

## Run queue and maintenance actions

Queue pause, drain, resume, and retry are platform-Admin actions. Choose the exact queue; retry also requires one delivery ID. Enter a reason and request a preview. Review the host-reported revision, affected/eligible/skipped/unknown counts, worker acknowledgements, and active leases. Confirming uses the preview ID, expected control revision, and a new idempotency key. The result is a durable job; refresh it to read its current state and per-delivery outcomes. A drain that times out remains draining/partial and requires an explicit resume. Unknown outcomes must be reconciled from the job/source evidence, not retried blindly.

Cleanup and recovery actions follow the same preview → confirm → durable job flow. The host returns target counts, bytes, skipped or unknown items, and per-item outcomes/evidence. Reference checks and exact immutable object-generation locators are required before deletion. Do not interpret preview counts as completed work; inspect the job and each item after confirmation.

Backup and restore actions use the host's approved named targets. Restore requires a new isolated storage generation and a host-validated destination. When a trusted immutable backup manifest or isolated restore adapter is not configured, the request should report unavailable and no job should be treated as successful. The current implementation has no owner-verified configured backup/restore adapter in this workspace; successful restore remains an open host integration and independent rehearsal requirement.

## Review deployments and storage generations

Deployment inventory reports desired and observed state per returned replica. A rollout or rollback requires a host preview, expected revision/version, a reason, and a durable job ID. Inspect acknowledgements and each replica result; `PARTIAL`, `UNKNOWN`, or missing replica evidence is not a completed rollout. The host rollout adapter remains dependent on trusted deployment manifest configuration and injected Worker, Connector, and Orchestrator safety observations. Those integrations must be available before an operator can treat the rollout as ready.

Storage generation actions are host-owned. Stage and bounded test happen before CAS activation; rollback is also revision-checked. Credentials and secret bytes are never displayed. A generation label or successful stage does not prove it is active or that existing artifacts can be read under the new generation.

## Access and limits

Platform Admins can read platform inventories and perform platform-scoped actions. Explicit tenant operators can read their tenant operations and incident ledger and can make tenant incident changes; they cannot perform platform queue, maintenance, or deployment actions. Viewers remain read-only. A local assigned-user session currently has no incident-wide read grant and receives a denial there; its Operations and Usage reads are limited by live current-version Identity grants to the exact active non-Global key and, for profiled operations, the exact assigned profile. An invalid or revoked `du_session` fails closed rather than falling back to a forwarded tenant credential.

The services/queue inventory and recent Connector source references are bounded projections, not a historical audit export. Use the separately scoped Usage event query/export for persisted ledger records. Usage rows with no provider invocation are not called pending provider work; only authoritative invocation, reservation, or durable delivery states support those labels.

Operational previews and status reads are safe for review, but this guide is not evidence of a production backup, restore, rollout, two-replica availability, or customer data cutover. Follow the host runbook and collect the required isolated rehearsal before declaring those capabilities production-ready.
