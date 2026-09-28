# FIX-08 — resolve structure/code review findings

Source review: `STRUCTURE-CODE-REVIEW-2026-09-21.md`. User requested fixes for all listed issues.
Work is split by ownership. Preserve the shared dirty worktree, do not reset/clean/stash/rebase,
and do not change frozen contracts without the platform owner recording the change and updating
consumers.

## Claude Code — platform / SDK / deployment foundation

Write: `services/orchestrator/**`, `packages/worker-sdk/**`, `packages/contracts/**` when an
interface change is unavoidable, `infra/**`, `tests/integration/**`, root workspace configuration,
central coordination/tasks/gates and `coordination/reports/claude.md`.

1. **R08-01 auth separation.** Remove normal-runtime default API-key acceptance. Keep any fixture
   identity behind an explicit test-only config, never production `createApp`. Separate admin and
   worker/runtime credentials/scopes; reject unknown, revoked, cross-tenant and worker-to-admin
   requests. Implement profile/API-key resolution instead of global fallback.
2. **R08-02 invocation grant correctness.** Make grant issuance stable per logical
   task/step/slot/input hash under transaction. Repeated request/transport retry returns the same
   invocation ID; differing hash conflicts. Require active lease/state, resolve allowed binding slot
   and connector revision from the pinned profile/version, and bind authorized artifact refs.
   Update SDK behavior so `INVOCATION_UNKNOWN` cannot reach a blind retry path. Add restart/replay
   and provider-call-once tests.
3. **R08-03 artifact lifecycle.** Complete C07 artifact hardening: enforced byte hash/size/MIME,
   one-purpose grant with expiration, no finalized overwrite, tenant/task/lease authorization,
   bounded request bodies/transfers and orphan TTL cleanup preserving active references. Test every
   rejected case against PG/Redis.
4. **R08-06 executable service.** Add a validated Orchestrator entrypoint that starts/listens and
   shuts down cleanly. Move migrations to an explicit one-shot command, stop running them inside
   normal app boot, and prove fresh database migrate + service health. Preserve test setup through a
   test helper rather than production bootstrap shortcuts.
5. **P2-06/P4 continuation contract.** Implement persisted children/join and human wait/resume
   endpoints with concurrency=1, stale/duplicate resume, cancel and restart tests. Publish one
   public, typed SDK method for authoritative child outputs and wait context; do not expose ad-hoc
   fields. Notify Antigravity through its request file once executable.
6. **R08-07/R08-08 platform alignment.** Write an ADR that resolves the Next App Router/Drizzle/S3
   target versus current node:http/raw-pg/bytea slice, and implement the chosen phase-appropriate
   bootstrap/config boundary. Add automated architecture dependency checks and remove explicit
   `any` in platform/SDK production paths.

Do not mark P2/P4 full DONE until all row acceptance is proved. Report every R08 item separately
with commands, tests, contract changes and remaining P6/P8 work.

## Antigravity — document-core / example-review / business boundary

Write: `businesses/document-core/**`, `businesses/example-review/**`,
`packages/document-kit/**`, `coordination/reports/antigravity.md` and
`coordination/requests/antigravity.md`.

1. **R08-04 actual P5 integration.** Replace the E2E `runtime.invoke` fixed-result stub with the
   actual Connector composition and a controllable provider HTTP mock. The only fake must be the
   provider boundary. Drive registration/enable through the published API, exercise connector
   ledger/quota/usage outbox, stable replay and real artifact/result path. Keep the test accurately
   named; do not claim container proof from in-process services.
2. **R08-05 P7 join correctness.** Remove the invented `joinedChildren` cast and do not evaluate
   only index zero. Until Claude publishes the typed continuation interface, add a failing/blocked
   contract test and request the exact interface. Then implement aggregation of every expected child
   output, fresh-context join, duplicate delivery, approval-after-join and failing-second-document
   cases through the public SDK only.
3. **R08-08 business type/boundary cleanup.** Remove production `any` from document-core and
   example-review adapters; preserve strict source dependency boundaries. Add meaningful tests or
   lint assertions for business packages importing only shared public packages.
4. **P7 proof completion after platform gate.** Use published admin/profile/registration and
   continuation endpoints for actual registration, profile assignment, cancel/restart, duplicate
   resume and version/drain proof. Keep P7-03..07 open until each is exercised.

Run focused package and E2E checks. Report external blockers precisely and do not revise central
task/gate state; the platform owner reconciles those after integration.

## Integration rule

Antigravity should begin independent R08-04 test refactoring and R08-08 now. It must adopt the
continuation API only after Claude publishes a typed boundary and has passing platform tests.
Claude must treat Antigravity's provider-backed test as the acceptance consumer for grants,
artifacts and continuation instead of adding another local-only substitute.
