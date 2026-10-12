# ORV14-INCIDENTS-UI and Operations owner receipt

**Owner state: IMPLEMENTED for the Ops-owned source slice; lease released to independent verification.** This receipt does not mark ORV14, AOPS journeys, or the Admin release ACCEPTED. It covers incident lifecycle/source projection, server-side Operations triage and scoped local-user reads, the Operations/incident UI surfaces, shell links, and the scoped Usage BFF relay added under the explicit Ops lease.

The receipt was frozen on 2026-10-11. Source paths and SHA256 values are in [`source-manifest.sha256`](raw/orv14-ops/source-manifest.sha256), SHA256 `8b9b992bfedbd5a98668c7abab5321a8c573127985ce8abd324e12606b21a571`. The manifest includes the Ops UI/server/contracts/migration/owner-test sources and `docs/46-incident-operations-guide.md`; it excludes this receipt and raw command logs. No shared package build, Admin Web build, browser run, migration apply, production mutation, commit, or push was performed by this owner.

## Implemented contract and flows

The persistent incident ledger uses the new `@du/contracts` incident DTOs, migration `0051_incident_lifecycle.sql`, and the incident service/internal route. Source signals deduplicate by scope/source/source reference/signal code and retain first/last-seen time, sample, threshold revision, affected resources, counters, owner, version, status, and an ordered event history. Mutations write an audit event and use a row lock plus expected state version. Assignment validates the selected ID against the current authorized Identity owner lookup. Acknowledgement records a responder but never changes source recovery. Resolution requires the current matching source-recovery/reconciliation event and rejects active sources and stale versions. Maintenance suppression has an exact resource or tenant/platform scope, reason, audit row, and a maximum 24-hour expiry; it annotates incidents without deleting history.

Current projections use actual owner data. Queue incidents use the latest queue-integrity sweep and only an explicit current `OK` sweep can recover the same incident. Runtime readiness incidents use the real host worker-heartbeat inventory; a fresh `READY` reading for the same replica is required for recovery, while a missing/stale/empty inventory has no recovery effect. Connector incidents use the sanitized, tenant-fenced invocation ledger and usage-outbox snapshot. UNKNOWN invocation recovery requires that same invocation's terminal state; pending-outbox recovery requires the same event's recorded delivery evidence. An aggregate pending count of zero does not recover an event. Connector configuration does not infer provider health.

The incident UI has server-backed search, status/severity/source filters, cursor paging, URL detail/deep links, browser history, assignment, acknowledgement, evidence-backed resolution, suppression creation, and explicit loading/denied/stale/unavailable/conflict states. Local `du-local` assigned users do not receive tenant-wide incident reads or mutation rights; viewer sessions are read-only, and explicit tenant operators retain the established tenant RBAC path.

The System Operations UI consumes typed Host service/queue/maintenance/rollout methods. It renders returned per-replica desired/observed/readiness/control observations and dependencies, queue age/admission/compatibility data, preview-first queue controls with durable job polling, maintenance preview/job item outcomes, deployment rollout/rollback preview and per-replica job results, and storage generation reads/actions. It does not synthesize missing replicas or telemetry. Platform mutations are gated to platform Admin. Services and deployment links preserve a selected service/replica; queue and incident links preserve the affected target. The app shell mounts System Operations, Incidents, Deployments, Maintenance, and the parity-owned API Keys screen route/navigation. Existing global tenant selector and tenant-context files were not edited.

The Operations Admin route retains the public/legacy list contract and adds a separate strict internal query allowlist for bounded search over business/action/key/profile/correlation/provider/model, existing six-field sort, exact `has-recorded-usage`/`no-recorded-usage`, actual reservation `UNKNOWN`, and `WAITING_INPUT`. SQL applies filters before keyset paging; the cursor is bound to principal population, tenant, all query fields, sort, and limit. “No recorded usage” does not mean no provider call. The `UNKNOWN` filter is explicitly a reservation state and does not claim all provider invocation outcomes.

For a trusted local `du-local` user, internal Operations list/detail/lifecycle/result/download/upload/metrics use current server-held identity and role version plus the live exact active non-Global API-key assignment; when an operation has a profile, that profile must also be assigned. A profile grant alone or an alternate key under the same profile is insufficient. Legacy null-profile operations remain visible only through the exact key grant. Invalid, expired, or revoked `du_session` proofs fail closed before bearer fallback. OIDC tenant operators continue their explicit service RBAC route.

The Usage BFF now binds all three Admin reads to the server-authorized tenant and preserves the original opaque cookie plus CSRF proof:

| Admin BFF | Internal Usage route | DTO |
| --- | --- | --- |
| `GET /admin/api/usage` | `GET /api/internal/usage/summary` | `UsageSummary` |
| `GET /admin/api/usage/events` | `GET /api/internal/usage/events` | bounded BASIC event page |
| `GET /admin/api/usage/export` | `GET /api/internal/usage/export` | rich bounded `UsageEventExportPage` |

The export BFF validates the strict drill-down schema, forwards only its allowlisted query fields, and sets `tenantId` from authorization. Public billing routes were not changed. The Usage owner owns the underlying local-user key-and-profile SQL scope and rich export implementation.

## Owner verification

All commands used Node `v24.21.0` from `/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node`; dependencies were already present. Raw logs are under [`raw/orv14-ops/`](raw/orv14-ops/).

| Check | Command and working directory | Result |
| --- | --- | --- |
| Incident, runtime/Connector evidence, Operations query/scope, and BFF cookie proof | `node ./node_modules/jest/bin/jest.js --runInBand tests/orv14-ops-incidents-owner.test.ts tests/orv14-ops-query-owner.test.ts` from `/workspace/dugate/du-rework/orchestrator/services/orchestrator` | **2 suites, 20 tests passed; 0 failed/skipped.** [`server-focused.log`](raw/orv14-ops/server-focused.log) |
| Operations UI query, cursor, and role affordances | `node --test tests/orv14-ops-ui-owner.test.mjs` from `/workspace/dugate/du-rework/orchestrator/apps/admin-web` | **1 suite, 3 tests passed; 0 failed/skipped.** [`admin-ui-owner.log`](raw/orv14-ops/admin-ui-owner.log) |
| Admin Web project typecheck | `node ./node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` from `/workspace/dugate/du-rework/orchestrator/apps/admin-web` | **Exit 0.** [`admin-web-tsc.log`](raw/orv14-ops/admin-web-tsc.log) is empty as expected for a clean check. |
| Orchestrator project typecheck | `node ./node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` from `/workspace/dugate/du-rework/orchestrator/services/orchestrator` | **Exit 2, 47 diagnostics**, all outside the Ops-owned paths. Current diagnostics are in other in-flight Cost Control, service-runtime/contract injection, Host rollout adapter, and Profile self-service schema files. The raw log contains no error in an Ops-owned incident/query/BFF/metrics module. [`orchestrator-tsc.log`](raw/orv14-ops/orchestrator-tsc.log) |
| Scoped whitespace check | `git diff --check -- <tracked Ops-owned paths>` and a trailing-whitespace scan across the manifest source paths from `/workspace/dugate/du-rework` | **No whitespace errors or trailing-space matches.** The scan output is empty in [`whitespace-scan.log`](raw/orv14-ops/whitespace-scan.log). |

No independent VFY result or UI reviewer verdict is claimed. The Admin Web source typecheck is not mounted-browser, mobile, keyboard, axe, or operational-action verification.

## Open required dependencies

Host queue, cleanup/recovery, storage-generation, durable-job, and replica rollout DTO/route shapes are integrated in the UI. Host reports that its queue/cleanup/storage/job implementation is present. The rollout adapter still requires trusted manifest configuration and backend injection of real Worker, Connector, and Orchestrator safety observations before an operator can treat rollouts as ready.

The required backup/restore adapter is not implemented/configured in the current host handoff. No checksummed immutable approved bundle or isolated restore adapter is available to verify. The UI reports host errors/status and does not fabricate successful results; backup/restore acceptance remains open. AOPS-J01..J07, real two-replica and crash/restart/rollback rehearsals, database migration application, full responsive/accessibility browser evidence, independent source review, and production readiness remain separate required verification. No unavailable host function is claimed complete.

## Release state

The Ops source set is frozen and its implementation lease is released for independent verification. The release is **IMPLEMENTED only** within this slice. The continuity rehearsal, Host adapter completion, other ORV14 owner integrations, independent verification, and required UI/backend reviews remain with their respective owners.
