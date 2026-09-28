# Structure/code review — 2026-09-21, after FIX-07

## Verdict and scope

Top-level workspace decomposition follows the plan: two services, independently packaged businesses,
five shared packages, infra, contracts and integration tests. Current implementation does not yet
satisfy the planned runtime, security, deployment or full business integration acceptance.

Reviewed the current dirty working tree against docs/03, architecture/02, P1/P2/P4/P5/P7 and actual
code, rather than treating lane reports as acceptance. Claude is still working on FIX-07; findings
describe the reviewed snapshot and must be rechecked after its handoff. No business/runtime source
was modified in this review. This report supersedes older completion interpretations where noted.

## Verified commands

- `pnpm build`: PASS for packages declaring build.
- `pnpm lint`: PASS; these scripts are TypeScript checks, not enforcement of the no-any rule.
- `pnpm test`: 52 passed suites, 455 passed tests, 3 skipped suites/tests.
- Counts: contracts 70, observability 16, document-kit 46, worker-sdk 23, Connector 39,
  connector-client 2, document-core 202, example-review 38, Orchestrator 16, integration 3.
- `pnpm --filter @du/orchestrator start`: exits 0 immediately; no listener starts.
- Isolated grant-service probe with fake DB: repeated identical task/step/slot/hash requests
  returned different invocation IDs; an undeclared slot was signed without profile lookup.
  This is a function-level diagnostic, not a full authorization integration test.

## Findings and acceptance to restore

### R08-01 — High: invalid API keys accepted; worker/admin identities conflated

`services/orchestrator/src/server.ts:495` resolves an unknown/revoked key through a fallback default
tenant, which createApp always seeds. The fallback is not conditional on an explicit test-only
configuration or on absence of other keys. `assertAdminAuth` accepts the same token as runtime.
An unknown key can therefore enter the default tenant, and a worker credential can call admin
enable. This violates P2-02 and the public/admin separation in docs/06 and docs/07.

Required: reject unknown/revoked keys; isolate fixture seeding from normal startup; separate scoped
runtime/admin identities and authorize tenant/business/task access. Tests must cover invalid,
revoked, cross-tenant and worker-to-admin attempts. Owner: platform.

### R08-02 — High: grant replay can duplicate provider calls; routing not profile-bound

`services/orchestrator/src/modules/grants/grants.ts:62` generates a random invocationId on each
request. The INSERT conflict key includes that fresh ID, so retries never reuse the logical
invocation. The service signs a requested bindingSlot using a global connectorId/revision without
checking a pinned profile; fencing checks the epoch only, not active lease expiry/state.
The frozen contract in `packages/contracts/src/runtime.ts:236` explicitly promises stable identity.
SDK `worker.ts:399` also classifies transport status 0 as retryable, including UNKNOWN errors.

Required: transactional stable logical identity, refresh/replay with unchanged ID, input-hash
conflict rejection, profile-bound slots/revisions/artifact refs, active lease checks and UNKNOWN
reconciliation. Prove timeout/restart cannot cause duplicate provider execution. P2-07/P4-07;
owner: platform/SDK. This does not by itself disprove Connector-local dedup tests.

### R08-03 — High: artifact lifecycle remains a permissive slice

`services/orchestrator/src/modules/artifacts/artifacts.ts:89` records supplied size/hash without
checking blob bytes. Advertised expiration is not enforced by blob authorization; read and write
reuse a token, and putBlob can overwrite existing bytes. `server.ts:164` buffers the entire request
without a configured limit. ART integrity, grant scope/expiry, active lease/tenant checks and TTL
cleanup are not proved. These are already assigned in C07-01/02; keep P2-03/P4-05 partial.

### R08-04 — High: P5 full Connector integration was overclaimed

`businesses/document-core/tests/multi-container-e2e.integration.test.ts:136` supplies its own
`runtime.invoke`, returns a fixed invoice and sends usage directly. It exercises real HTTP framing,
signature verification, SDK, PG/Redis, artifacts and usage ingestion, but bypasses the actual
Connector invocation service, durable ledger/quota, provider adapter and usage outbox.
It also enables the business through `enableVersionForTest`.

Progress after FIX-08: the E2E now uses real Connector composition, provider HTTP mock, durable
ledger/outbox and admin bootstrap. It still intercepts the grant verifier to replace the platform
claim's `inputHash` with Connector-local `hashInvocationInput`; this is a test-only hash shim and
proves the contracts remain incompatible. Required: one canonical hash without the shim, then
replay/restart coverage and the planned six-action matrix. P5-10 remains open; G4 is not achieved.
Owner: platform/SDK plus business integration.

### R08-05 — High: example-review join ignores actual child outputs

`businesses/example-review/src/review.ts:439` casts TaskContext to an invented joinedChildren field
absent from the public SDK. If that field exists, execution falls through to artifacts[0] at line
480 and constructs exactly one evaluated item. A resumed multi-document review can therefore
ignore failed later documents; without the field it spawns again.

Required: documented authoritative continuation/result interface from platform, validation of all
child outputs and aggregation of every expected item. Test two documents with the second failing,
fresh-context join, duplicate delivery and approval after join. Keep P7-02 and P7-05 partial.
The earlier single-document approval context/reference bugs are repaired in source and local tests;
38 passing tests do not close this separate multi-document gap. Owner: business after SDK contract.

### R08-06 — High: standalone Orchestrator startup and migrations differ from plan

`services/orchestrator/package.json` starts `node dist/server.js`, but server.ts only exports
createApp; it has no executable bootstrap, config loading or listen invocation. The command
successfully exits without serving requests. createApp executes all migrations on every start,
contrary to the one-shot migration acceptance in P2-01 and docs/03.

Required: explicit entrypoint with validated config, listen/shutdown lifecycle, separate versioned
migration command and clean deployment smoke test. Reopen P2-01 for migration acceptance; record
bootstrap under P2-09/P8-06. Owner: platform/infra.

### R08-07 — Medium: framework/storage choices need an explicit decision

Orchestrator uses node:http + raw pg, no Next App Router/Admin and no Drizzle dependency. Artifact
bytes are in PostgreSQL rather than S3. The bytea store was explicitly allowed for wave-05 scope,
so it is a temporary accepted slice, not completion of the S3 target. Compose runs PG/Redis only.
Connector uses flat domain modules instead of the illustrative src/modules layout; this naming
variation is harmless where ownership remains separated.

Required: P1/P2 owner records an ADR choosing the final HTTP/UI and DB approach, or implements the
original target. Do not silently redefine the spec around current code. Track S3/production storage,
Admin, immutable images and multi-service compose under their existing open packets.

### R08-08 — Medium: type safety and package-boundary checks are incomplete

18 source lines in businesses/packages contain `any` (excluding tests/dist/node_modules); e.g.
document-core/src/worker.ts adapters erase TaskContext and provider result types. No runtime business
imports of service packages were found in the searched source; service imports in integration tests
are fixture dependencies and should be separated from production dependency enforcement.

Required: remove explicit any from adapters, add meaningful boundary/type-safety checks and ensure
clean image builds build dependencies from source. `tsc --noEmit` alone does not enforce no-any.

## Updated sequence

1. Platform: R08-01/02 security and identity, C07 artifact acceptance/R08-03, R08-06 bootstrap.
2. Platform/SDK: durable children/wait/resume and authoritative child output contract.
3. Business: R08-05 join completion and actual Connector integration R08-04; retain local tests.
4. P6 Admin APIs/UI and P7 full proof in dependency order (P7 profile UI depends on P6).
5. P8 image-based full-system recovery/security/load/storage/operations gates.

Resolve R08-07 explicitly while planning the platform work. These priorities supplement FIX-07;
they do not automatically dispatch new agent messages or authorize production deployment.
