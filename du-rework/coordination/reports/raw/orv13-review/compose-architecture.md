# UI13-COMPOSE architecture review — 2026-10-11

Reviewer /root/orv13_ui_review; read-only architecture assignment. Read proposal, actual route context/server/bootstrap/main, PG/audit/migration patterns. No product/test changes, builds, Docker execution, host mutations or production actions.

**APPROVED design direction for an additive allowlisted Compose adapter under the conditions below.** This approves the architecture for implementation, not delivered code, actual host setup, two-replica availability, global settings parity or release acceptance. Dedicated host runner owns Docker privilege; web/Orchestrator remain socket-free.

## Exact implementation paths and current seams

Paths relative to du-rework:

- New orchestrator/services/orchestrator/src/modules/compose-operations/contracts.ts: runtime Zod DTOs and status/action definitions, safe projection schemas, manifest schema separately; keep rich product contracts independent.
- New module siblings service.ts (PG intents/previews/CAS/jobs/audit), manifest.ts (trusted local manifest/file digest validation), host-executor.ts (fixed argv/no shell/bounded execution/selected observation fields), runner.ts (host process/poll/journal/state loop).
- New orchestrator/services/orchestrator/src/compose-operations-runner-cli.ts builds to dist/compose-operations-runner-cli.js using existing tsc build. Start host-local Node24 CLI by a deployment-owned systemd/unit/process. No application package/container receives Docker socket.
- New orchestrator/services/orchestrator/migrations/0048_compose_operations.sql. Current max observed0047_legacy_migration_runs.sql; coordinator recheck exclusive migration lease before writes. db/migrations.ts discovers SQL and production boot verifies; do not silently auto-migrate production.
- New http/routes/internal-compose.ts; ServerConfig in src/server.ts exposes optional typed composeRunner config and new handler import/call after internal usage handler before public handler. Ingress is a server-owned internal literal (http/route-context.ts; ingress-guard.ts). New routes independently check internal audience; public listener remains generic404.
- Bootstrap create-app.ts: instantiate createComposeOperationsService(db,audit,config.composeRunner) next to usage:510 and add optional ctx.composeOperations to route context and closure population near:963-966. No timer/job executor inside web process; host runner polls durable PG through HTTP.
- main.ts additive all-or-none config COMPOSE_OPERATIONS_HOST_ID, COMPOSE_OPERATIONS_RUNNER_TOKEN, COMPOSE_OPERATIONS_MANIFEST_DIGEST and bounded max sample age/preview expiry if needed. Reject runner token reuse with admin/runtime/usage/business tokens at boot. Token values never returned or logged. Absent config reports unavailable read capability and denies mutations; not fake configured host data.
- New app/admin/bff/compose.ts matcher/handler; one hook in bff/handle.ts before /actions. Reuse resolveBffContext, same-origin CSRF and callUpstream with platform credential; JSON URLs come only from server runtime config. Do not bypass role/CSRF or widen generic actions.
- Client integration after firstslice handoff: lib/api/types.ts and client.ts typed getComposeCatalog/createComposePreview/submitComposeJob/listComposeJobs/getComposeJob; new UI consumes frozen DTO in cockpit owner's lease. BFF/client/shared bootstrap hooks sequential exclusive owners.

Actual PG reusable seam: Db.tx(fn) passes PoolClient (db/db.ts). audit.record(input,executor) explicitly binds audit insert to same transaction (modules/audit/audit.ts:130-161); platform events use tenantId:null, actor identity from trusted auth/BFF, not request body. Existing admin_audit_events does not contain rich detail metadata; job rows must retain sanitized reason/outcomes/history and audit resource references job ID.

## Trust and host manifest

Single configured host identity for minimum slice, expandable only with explicit keyed host credentials. Separate runner token grants only its own host/manifest snapshot and job claim/report; it never authorizes Admin catalog/mutations or unrelated endpoints. Internal listener restricted network/TLS deployment policy remains necessary; host CLI base URL configured locally, no browser/provider-provided URL.

Deployment-owned root-readable, non-world-writable manifest defines schemaVersion, hostId, projectId/display name, absolute docker binary, working directory, fixed Compose files, optional fixed env-file path, allowlisted application services and approved immutable releases. Each release identifies fixed Compose file hashes/image digests, target services, migrationCompatibility acknowledgment and approved prior release IDs. Server pins expected manifest SHA256; runner publishes only catalog identifiers/labels/digests/capabilities, never paths, env contents/values, tokens or raw resolved Compose config.

Runner validates canonical absolute paths, trusted ownership/permissions, file hashes/immutability, release→service scope and manifests before each action. No browser parameter becomes filename, CLI option, environment, project path, scale, image string or shell fragment. Root-owned immutable deployment files and local exclusive execution lock prevent file-edit TOCTOU; rehash immediately before spawn and refuse mismatch. Registry credentials/env are host-owned; preprovision approved images so no unattended builds or network pulls are needed. Do not run compose config and expose it: interpolation can reveal secrets.

Allow only apply_release, rollback_release and restart_service. Reject PG/Redis/S3/Vault/storage/database service controls by default; only explicitly listed app services are restartable. No down, rm, prune, exec, run, arbitrary scale, cleanup or migrations. No automatic application/DB rollback after failed command.

## API and frozen UI DTO

Platform Admin endpoints, internal only:

- GET /api/internal/compose/catalog: sanitized approved catalog plus genuine latest observations/freshness.
- POST /api/internal/compose/previews: {hostId,projectId,action,releaseId? or serviceId?,reason}. Reason length bounded, human text; cannot alter targets. Returns stored previewId, expiresAt, manifestDigest, observedDigest, expectedTargetRevision, approved immutable targets/impact, capability/disabled reason, warnings.
- POST /api/internal/compose/jobs: {previewId,expectedTargetRevision,reason?} with Idempotency-Key. Server ignores/rejects arbitrary override fields. Returns durable202 jobId/state; same scoped idempotency key+canonical body returns same job, different body409.
- GET /api/internal/compose/jobs?limit&cursor and /jobs/:jobId: bounded keyset, safe states/outcomes; no raw command output.
- BFF same suffixes under /admin/api/compose. Platform principal+admin required for reads and writes; viewer/tenant operator denied. All POST BFF require CSRF; tokens minted/read from trusted config only. Authenticated upstream platform endpoints authorize platform token (not tenant token or role string).

Suggested types ComposeCatalog, ComposeHostObservation, ComposePreview, ComposeJob, ComposeJobPage. Observation fields: hostId/projectId/manifestDigest/catalogRevision, sampledAt, receivedAt, availability FRESH|STALE|UNAVAILABLE, lastErrorCode, services[{serviceId,containerId,imageId/imageDigest?,state,health?,startedAt?,finishedAt?,observedReleaseId?}], desiredReleaseId|null, targetRevision, activeJob|null; absent/not provable fields null. Container instances originate actual Docker observations, never fabricated replicas. Stable observedDigest excludes collection timestamp and includes target-relevant container/image/state/desired revision facts. Explain freshness and desired versus observed separately.

Job fields: jobId/previewId/hostId/projectId/action/approved target IDs/release digest/reason/createdAt/actor label/state/stateVersion/startedAt/completedAt/claimExpiresAt/observedBefore/observedAfter/perServiceOutcomes[{serviceId,status,errorCode?}]/uncertainReason?; no commands/paths/env/full stderr. List/history page needs safe cursor semantics and explicit failure/no-job state.

Runner endpoints exclusively separately authenticated:

- POST /api/internal/compose/runner/snapshot publishes validated sanitized catalog/observation; requires configured host+manifest digest. Do not authorize by hostId body alone.
- POST /runner/claim: transactionally claim one queued job for configured target, returns immutable job/preview/manifests identities and opaque execution token.
- POST /runner/start commits RUNNING before spawn after runner checks fresh local digest, then HTTP success required before host execution.
- POST /runner/complete: execution-token+stateVersion CAS report sanitized known command result and fresh after observation; late/stale report cannot overwrite terminal/reconciled state.
- POST /runner/reconcile: explicit reconciliation from deployment-owned runner mode, not automatically from loop. Carries expected job stateVersion/current observed digest and sanitized evidence/category; append audit atomically. No browser claim of success or direct resolve control.

Do not relay the runner endpoints through browser BFF.

## Durable state and exclusivity

PG stores compose_host_snapshots/catalog (safe content+digest+timestamps), compose_previews (immutable action/release/impact/before digest/target revision/expiry/actor) and compose_jobs (immutable parameters/idempotency body hash/state/revision/token hash/timestamps/per-item outcomes). Keep target desired revision/active job coordination row or equivalent per-project advisory transaction lock plus active-row unique predicate. One mutating job per host+project, not just per service: overlapping Compose release/restart effects share project state.

Submit transaction locks target, checks host/sample availability, trusted manifest catalog, unexpired preview, unchanged observed digest and target revision, no unresolved active/UNKNOWN job, supported release/service/action; inserts job+audit intent+increments target revision/consumes preview atomically. Same identity replay returns existing job before stale-preview checks. Claim uses SELECT ... FOR UPDATE SKIP LOCKED and transactionally commits claim/token/state; local runner exclusive project lock prevents second host process.

State machine: QUEUED → CLAIMED → RUNNING → SUCCEEDED|FAILED|PARTIAL|UNKNOWN. CLAIMED must not execute until start durable ACK. A positively identified pre-spawn rejection can become FAILED; network uncertainty of start/claim or lost runner process is UNKNOWN. Never automatically requeue CLAIMED/RUNNING after expiration, because an old runner may still act. Expiration is observed/recorded UNKNOWN and holds target fence. No side effect inside long PG transaction.

Per-service exit/health observed states distinguish known failed/partial from uncertain side effects. Timeout/killed process or lost HTTP report can leave Docker daemon work active, so UNKNOWN even if subprocess was killed. New target action blocked until explicit host-local reconciliation proves previous executor/process quiescence and obtains fresh genuine state; current desired-state match may become RECONCILED (explicitly state-confirmed, command outcome still uncertain), never fabricated SUCCEEDED. If no certainty about prior daemon/process state, remain UNKNOWN and require deployment operator intervention. Reconcile changes job state+audit+target fence with CAS; old runner tokens rejected thereafter.

Restarting Orchestrator can make reporting temporarily unavailable; runner keeps local fsynced receipt/journal and retries only report transport with same execution token, never repeats host command. Startup consults journal and API; any incomplete intent enters reconciliation mode/UNKNOWN. If PG/internal API is down before start ACK, no command.

## Fixed host executor and minimum observation proof

Use child_process.spawn(executable,argv,{shell:false,cwd:manifest.cwd,env:trustedFixedEnv,detached:platformAppropriate}) with executable/path/config chosen only from manifest. Fixed Compose prefix --project-name fixedProject -f approvedFile ... --env-file approvedEnvFile; no caller options or inherited DOCKER_HOST/context override. Runner itself owns an approved Docker context/endpoint. Explicit approved service args only.

Inventory: docker compose ps --all --format json; normalize selected service/container/image/state fields, optionally narrowly formatted docker inspect on IDs from that inventory for startedAt/image digest/health. Do not return inspect Env/Mounts/Cmd, container logs or raw stderr. Parse bounded version-compatible JSON; unsupported/invalid format produces unavailable.

Apply/rollback: approved fixed release Compose files, up -d --no-build --pull never --no-deps <approved application services>, with tested Compose version and bounded readiness checks. Exclude stateful services and never alter databases automatically. Restart: restart --timeout <bounded seconds> <allowlisted app service>; verify actual observed container state/health after. Command acceptance/exit0 alone is not readiness or all-service success; return partial/error per observations. Selected Docker version flags must be verified in isolated actual fixture, not presumed universal.

Bound timeout, total output bytes, parsed container count and request/body/list sizes. Terminate subprocess/process group on timeout/output overflow, preserve sanitized code+UNKNOWN status; Docker daemon may continue. Store only safe outcome enums/error codes, not raw CLI output. Report command outcome and observed state separately.

## Global settings and acceptance limits

An approved immutable release may reference host-owned AI/storage/environment configuration and can safely apply that release without exposing secrets. The UI can identify a nonsecret configuration revision/fingerprint and associated approved release; host verification proves selected containers/images/release observations, not every worker's effective config or provider credentials. Never infer secret values from hash or expose env contents.

Mapping each legacy global setting to runtime consumer, immutable revision/generation, test/apply evidence and old artifact/operation pin survival is still required. This adapter provides approved deployment change mechanics, not complete17globalparity, direct AI/prompt/S3 editing, storage cleanup, database rollback or automatic safe two-replica rollout. Single-server Compose recreates containers and may interrupt service; preview must disclose that risk. No guaranteed zero downtime, preservation of active leases or migration rollback without separate implementation/evidence. Existing native settings revision restore is separate from Compose deployment rollback.

Acceptance before scoped source/build approval: independent real PG idempotent submit+claim race+audit rollback/CAS/expired preview, viewer/tenant/CSRF/public/runner cross-host auth negatives, fixed-argv/path/digest/secret redaction/bounds, crash/start-ACK loss/timeout→UNKNOWN/no repeated host invocation, report replay/stale completion/reconcile tests. Actual disposable Compose project proof for inventory/apply/restart/approved rollback and failed/partial states; no production stack mutation. If Docker unavailable, adapter remains implemented/offline verified with LIVE_HOST gate open; no claim host capability accepted from executor doubles.

