# UI13-COMPOSE — host adapter proposal

User confirmed Docker Compose on a server, 2026-10-11. This is an implementation proposal awaiting independent architecture review, not dispatch or completion evidence. Parent requirements AOPS-03/07/08/J02/J04/J05; preserve all legacy public APIs.

## Required product behavior

- Portal must read genuine host-reported Compose service/container state, images and timestamps. Missing or stale host observations remain unknown. Do not infer replicas from one health endpoint.
- Platform admin can preview an allowlisted target/release/service action, then submit a durable idempotent audited job. Tenant operators/viewers cannot mutate host deployment. No browser-provided commands, file paths, environment values or Docker socket access in the web app.
- Host-side runner reads a deployment-owned manifest with fixed project, absolute files, service allowlist and release IDs. CLI uses argv with shell disabled, bounded timeout/output, sanitized errors. Existing application containers do not need Docker socket access.
- Persist requested/observed revision, preview expiry and snapshot digest, job states/per-service outcomes. Job claim is exclusive. A crash or timeout with uncertain side effects becomes UNKNOWN and cannot blindly replay a host command; explicit state reconciliation is required.
- Minimum actions: apply an approved existing release, roll back to an approved previous release, restart a configured application service. Storage/database deletion, automatic database migration/rollback, arbitrary scale/shell commands and modifying unspecified production files are outside this safe adapter.
- Global runtime/storage configuration is not falsely editable until the host configuration/release mapping exists. UI must distinguish application revision restore from Compose deployment rollback and retain old operation pins/artifacts.

## Suggested boundaries

- Dedicated compose-operations module + new internal route + BFF; additive config/bootstrap wiring only after previous shared-file owner hands off.
- New migration 0048 (confirm next available index), durable jobs/snapshots/catalog; host runner CLI and deployment-owned manifest schema. Register/test runner against isolated disposable Compose project only; do not touch a preexisting running stack.
- UI uses a typed client contract: host availability; catalog target/release; observed service/image/health + desired release; action capability/reason; preview target/impact/expected digest/expiry; idempotent submit with reason; sanitized job list/detail/history.
- Independent tests must cover real PostgreSQL persistence/claim/idempotency, RBAC/CSRF, stale preview, fixed argv allowlist, bounded failures/UNKNOWN recovery and a disposable actual Docker Compose fixture if the environment supports it. Fake executor success is not real host verification.

Reviewer may narrow/alter architecture to fit actual code and dependencies. No deployment performed by this proposal.
