# ORV12 settings owner receipt

Status: owner implementation and focused checks complete; independent HTTP/browser review in progress. No deployment, push, or production mutation.

## Implemented consumer path

- SQL0046 records scoped immutable encrypted snapshots, draft validation and active revision head; metadata AAD binds tenant/stream/revision. Live prompt rows are sealed with tenant/key/connection/endpoint/step identity and the actual submission prompt repository decodes them under existing metadata read policy. Existing operation pins are untouched.
- `settings.revision.create`, `.validate`, `.apply`, `.rollback` use standard admin action RBAC/session CSRF and transaction audit/idempotency. Create caches only safe revision marker, rehydrates detail after replay; no decrypted prompt/diff in idempotency rows. Validate checks configuration only, not paid provider execution.
- Changes support exact per-key/endpoint prompts and full immutable connector revision pins. Provider/model configuration lives in actual Connector revisions. Pin changes require a single-key, exact-endpoint profile, preserve slots, validate active tenant-compatible Connector revision, then clone real profile revision and move active pointer. Shared/generic profile changes fail with explanatory validation issues.
- CAS checks active settings head; optional expectedProfileRevision guards reviewed migration preflight; dependency fingerprint catches changes outside settings. Apply revalidates within transaction. Rollback makes a new applied version and checks actual consumer fingerprint; rollback before first apply is rejected. Baseline0 can restore state after a first apply.
- Existing `settings.prompt.update` shorthand retains timestamp CAS and now creates/validates/applies a revision when served by dispatcher. Dispatcher requires metadata encryption for new setting writes.
- GET `/api/v1/admin/settings` and BFF GET `/admin/api/settings` include selected revision/diff/validation, bounded latest20 history, exact profile mapping, and `activeRevisionMatchesEffective` drift indicator.
- Tenant-fenced authenticated GET `/api/v1/admin/legacy-migration/readiness` with BFF equivalent returns sanitized DATA helper output.

## Owner evidence

Supported Node24.21.0/pnpm10.18.3:
- orchestrator typecheck PASS.
- `tests/orv12-settings.test.ts`: real isolated PostgreSQL schema, all migrations, real AES metadata seam, 12/12 PASS; actual prompt repository/apply/rollback, cloned profile pointer, dependency drift, concurrent CAS one winner, optional preflight profile CAS, generic profile rejection, baseline overwrite regression, shorthand, readiness/auth gates.
- `tests/bff-settings-identity.test.ts`: 24/24 PASS. Updated old upstream settings fixture to actual deployed effective settings DTO, retained secret-stripping and tenant/auth checks.
- Combined earlier pass29 included first5 owner cases +24BFF; final owner suite12 separately passes. No skips.

Raw logs: `coordination/reports/raw/orv12-settings/`.

## Integration follow-up

Independent VFY/IR are checking live HTTP/browser, operation admission pin immutability, read drift, migration reconciliation. Native `profile.upsert` now supports validated exact endpointSlug and explicit connectorBindings; supplied nonempty maps require Connector management and ACTIVE global/same-tenant revisions. Omitted maps preserve active pins during policy-only edits. Existing endpoint selectors cannot be retargeted. Owner native and denied-pin regressions pass.

Local-auth bootstrap now composes shared opaque sessions and login service, closes its Redis resources, generates private internal admin token only if absent, and uses shared service/cookie secret (minimum32bytes) for domain-separated tenant HMAC credentials verified by API-owner RBAC across replicas. Explicit service secret supports topology independence from random per-process admin tokens.

Callback mounts include GET internal operation deliveries plus BFF forwarding and exact `operations.callback.retry` admin/operator action; same tenant credential, CSRF, resource pre-fence before idempotency, bounded helper retry and atomic audit. Generic BFF operator action allowance is restricted to cancel, resume and callback retry; other generic actions remain admin-only. Concurrent duplicate settings/callback commands serialize/recheck marker before CAS.

OpenAPI generator publishes70paths53schemas, adds settings/readiness/callback contracts and action DTO descriptions; validator verifies public ID/download GET retention, retired public management absence and all23 canonical example checks. No unauthorized drops.

## Final shared integration handoff

- Final orchestrator build PASS after native profile, local auth/scoped service credential and callback mounts.
- Final BFF regression54/54 PASS across settings/identity, connector-actions and profile BFF; includes operator callback exact allowlist using tenant bearer and CSRF denial.
- Independent DATA callback real HTTP/PG/receiver11/11 PASS reported in `orv12-callback-verification.md`.
- Earlier broadened p730 fixture failures were reported to API owner, who fixed unlimited-key fixture for the new spend query and confirmed suite PASS. No product bypass added.
- Settings owner12/12 and source hashes: `raw/orv12-settings/source-sha256.txt`. Independent final settings/browser/auth evidence remains in VFY/IR receipts.

Final operator-control correction: migrated tenant operators now reach `operations.cancel` and `operations.resume` through the same generic BFF used by UI, alongside callback retry. Trusted tenant bearer and CSRF are preserved; retry/delete/profile/settings are not added to the allowlist. Focused BFF24/24 and typecheck PASS; independent actual mutation verification is owned by VFY. No frontend rebuild required.
