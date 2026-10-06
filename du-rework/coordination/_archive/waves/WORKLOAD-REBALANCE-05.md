# Workload rebalance 05 — close the cross-service boundary (P2-07) and prove P7

> Historical assignment. Reconciled on 2026-09-21 by
> [`WORKLOAD-REALIGNMENT-06.md`](WORKLOAD-REALIGNMENT-06.md). Do not use the pre-wave counts or
> remaining-gap list below as current status.

Date: 2026-09-21. Continuation of `CHECKPOINT-2026-09-21.md` / `WORKLOAD-REBALANCE-04.md`.

Five gates are READY (`contracts-v1`, `workspace-ready`, `sdk-ready`, `runtime-ready`,
`integration-usage-ready`). Live verification at handoff: `pnpm build` 11/11, `pnpm lint` green,
`pnpm test` 391 pass, isolated PG/Redis healthy. The remaining integration gap is the
**artifact + invocation-grant** half of P2-07 — Orchestrator exposes usage ingestion but no
artifact or grant routes, so document-core cannot be honestly added to cross-service E2E and
Connector-backed variants cannot run.

Ownership boundaries unchanged (see `coordination/README.md`): Claude/platform owns
root config+lock, `@du/contracts`, `@du/observability`, `@du/worker-sdk`, `services/orchestrator`,
`infra`, shared `tests`, central `tasks`, gates and the Claude report. Copilot owns
`services/connector` + `packages/connector-client`. Antigravity owns `businesses/document-core` +
`packages/document-kit`. `businesses/example-review` is platform-owned (P7 proof).

## Context for every lane (do not re-derive from stale reports)

- `@du/contracts` runtime schemas for the missing routes ALREADY EXIST (frozen v1):
  - Artifacts: `ArtifactUploadGrantRequestSchema`/`ArtifactUploadGrantSchema`,
    `ArtifactFinalizeRequestSchema`, `ArtifactAccessRequestSchema`/`ArtifactAccessGrantSchema`
    (in `packages/contracts/src/runtime.ts`).
  - Grants: `InvocationGrantRequestSchema`, `InvocationGrantSchema`,
    `InvocationGrantClaimsSchema` (in `packages/contracts/src/runtime.ts` and `connector.ts`).
  - Object storage is NOT in scope this wave — store artifacts in PostgreSQL (bytea/bytes) or the
    existing local `OUTPUT_DIR` behind an Orchestrator-owned ref. Do not invent a new storage DTO.
- Connector verifies grants via HS256 HMAC over base64url(`${header}.${payload}`) using
  `INVOCATION_GRANT_SECRET` (`services/connector/src/contract-grants.ts`). The Orchestrator that
  issues grants must sign with the SAME secret and the same `alg:'HS256'` header. Grant claims
  must satisfy `InvocationGrantClaimsSchema`: `audience:'connector'`, `tenantId`, UUID
  `operationId`/`taskId`, `stepKey`, `invocationId`, `inputHash`, `connectorId`,
  `connectorRevision` (int), `bindingSlot`, optional `artifactIds`, `exp`/`iat` (unix seconds).
  Connector rejects binding mismatch (`BINDING_DENIED`) and expired grants.
- Enable path: only `enableVersionForTest(db, businessId, version)` exists. Build a real admin
  enable endpoint (RBAC-light, `ADMIN` runtime token) this wave — do not leave the test hook as
  the only path for cross-service E2E.

## Claude — platform lane (P2-07 closeout, P2-06, P7, audit)

Write only in: `services/orchestrator/**`, `packages/worker-sdk/**` (only facade/transport glue
that already belongs here), `businesses/example-review/**`, `infra/**`, `tests/**`, central
`tasks`, gates, and `coordination/reports/claude.md`.

1. **P2-07 artifacts**: add transactional routes
   `POST /api/runtime/v1/tasks/:id/artifacts` (returns upload grant + ref),
   `POST /api/runtime/v1/artifacts/:artifactId/finalize`,
   `POST /api/runtime/v1/artifacts/:artifactId/access`. Persist artifact metadata + bytes in
   PostgreSQL. Reuse the existing `ArtifactUploadGrant*Schema`/`ArtifactFinalizeRequestSchema`/
   `ArtifactAccessRequestSchema`/`ArtifactAccessGrantSchema` exports exactly — do not broaden the
   contract. Acceptance: real Orchestrator stores a 2 KB bytea artifact, finalize flips it to
   `READY`, access returns a short-lived read grant; SDK `ctx.artifacts.write/read/accessGrant`
   can round-trip it against the live server in an integration test.
2. **P2-07 invocation grants**: add `POST /api/runtime/v1/tasks/:id/invocation-grants` that, given
   a strict `InvocationGrantRequestSchema` (lease-bound: taskId/stepKey/invocationId/inputHash/
   bindingSlot/connectorId/connectorRevision), returns a Connector-verifiable `InvocationGrantSchema`
   signed with `INVOCATION_GRANT_SECRET` (HS256, same header/claims shape the Connector expects).
   Wire the secret from env (`INVOCATION_GRANT_SECRET`) with a fail-closed default. Acceptance: the
   Connector's `ContractSignedGrantVerifier` accepts the issued grant over HTTP in a
   `tests/integration` suite; binding mismatch / expiry is rejected.
3. **P2-07 real enable**: replace the test-only enable with `PUT /api/v1/admin/businesses/:id/versions/:version/enable`
   (ADMIN runtime token). Keep `enableVersionForTest` exported for existing unit tests but stop
   using it as the only bootstrap for integration tests.
4. **P2-06 cancel/deadline**: add `POST /api/v1/operations/:id/cancel` (public, idempotent,
   lease-fenced) and a deadline sweeper that marks `TIMED_OUT` + cancels leased tasks. Keep
   concurrency=1 in the sweeper test; no fan-out/HITL this wave.
5. **P7 extension proof**: register `businesses/example-review` (already a real `@du/worker-sdk`
   business, 5 tests pass) against the live Orchestrator, submit a `review` action, complete it
   through the runtime, and assert the result. No Orchestrator/Connector source change beyond
   steps 1–4. Document the proof in `coordination/reports/claude.md`.
6. **Commit-safe audit**: decide generated `.js/.d.ts/.map` in `packages/*/src`; remove committed
   build output where it shadows `.ts`; update stale `README`/task checkboxes from real evidence.
   Do not commit `du-rework/node_modules`, `dist`, env, or logs (covered by `.gitignore`).

Acceptance evidence: new `tests/integration` suites for artifact round-trip, grant issuance +
Connector verification, example-review full loop, and cancel/deadline; all run against PG 5433 /
Redis 6380. Publish `coordination/gates/integration-e2e-ready.md` only after a real
Orchestrator+Connector+document-core document-core (one provider-backed variant) loop passes.

Do not edit Connector, connector-client, document-core, or document-kit. Collect their dependency
requests via `coordination/requests/*.md`.

## Copilot — Connector lane (P3-06/08 cross-service closeout, P2-08 adoption)

Write only in `services/connector/**`, `packages/connector-client/**`, `coordination/reports/copilot.md`,
`coordination/requests/copilot.md`.

1. **P3-06 settled delivery**: the Orchestrator usage endpoint (`POST /api/runtime/v1/usage-events`,
   bearer `usageToken`) is now READY (`integration-usage-ready`). Add a real `tests/integration`
   (or durable) suite that boots the Connector with `USAGE_SINK_URL`+`USAGE_SINK_TOKEN` pointed at
   the live Orchestrator, emits an event, and asserts the Orchestrator projection increments exactly
   once after a duplicate. Keep the existing opt-in durable suites green.
2. **P3-07 client-against-real-service**: extend `@du/connector-client` consumer test to invoke the
   Connector over real HTTP (mock provider) and assert `invoke/poll/wait/cancel` behavior end-to-end
   against the live composition, not just types.
3. **P3-08 image/integration**: build the Connector Docker image and confirm it starts against the
   isolated PG/Redis; document the image digest in `coordination/reports/copilot.md`.
4. **Grant acceptance**: when Claude publishes the invocation-grant route (step 2 above), add a
   Connector-side test that receives a grant over HTTP from the Orchestrator and successfully invokes
   a mock provider; assert `BINDING_DENIED`/`GRANT_INVALID`/`expired` are rejected. File any mismatch
   in `requests/copilot.md` — do not patch the contract.
5. **P2-08 webhook**: adopt `@du/contracts` `WebhookPayloadSchema`/`webhookSigningPayload` surface so
   the Orchestrator webhook path (later wave) can be consumed; no Connector-side delivery yet.

Acceptance: existing 33 tests + new cross-service tests green; strict typecheck pass; no shared
contract/DTO change. Report P3-01..08 matrix COMPLETE/PARTIAL/BLOCKED with exact test refs.

Do not edit root manifests/lockfile, contracts, SDK, Orchestrator, document-core, document-kit,
infra, or central docs/tasks.

## Antigravity — document-core lane (provider-backed variant + real E2E prep)

Write only in `businesses/document-core/**`, `packages/document-kit/**`,
`coordination/reports/antigravity.md`, `coordination/requests/antigravity.md`.

1. **Provider-backed variant**: pick ONE provider-backed action (recommend `extract` invoice, or
   `analyze` summarize-eval) and wire its handler to the real SDK `ctx.connector.invoke(slot, input)`
   facade (already in `@du/worker-sdk`) instead of the local mock, honoring `INVOCATION_UNKNOWN`
   (never blind-retry) and lease-loss fencing. Keep all 188 local tests green.
2. **Real E2E prep**: once Claude's P2-07 artifacts+grants land, add a `tests/integration` (or
   durable) suite that boots document-core worker against the live Orchestrator + Connector mock
   provider, submits the chosen action, and asserts checkpoint/artifact/usage. Until then, mark the
   multi-container E2E BLOCKED in the report with the exact missing route.
3. **Dependency cleanup**: remove `@types/mammoth` devDependency from `packages/document-kit/
   package.json` (workspace gate note: it is a deprecated stub; mammoth ships its own types). Re-run
   `pnpm --filter @du/document-kit test` + typecheck.
4. **Non-placeholder digest**: replace `sha256:placeholder-document-core-v1` in config/manifest with
   the real built image digest once the image is produced (coordinate the digest with Claude, who
   owns `infra`/images).

Acceptance: preserve 188 tests + strict typechecks; the chosen variant runs through the SDK facade;
new E2E added when the boundary is ready. Update P5-01..10 evidence matrix. Do not edit the central
P5 task file or peer lanes.

## Conflict controls (same as prior waves)

1. Claude is the only writer for P2, central task status, shared gates, root workspace files,
   contracts, SDK, infra and shared tests.
2. Copilot and Antigravity work concurrently only in their existing disjoint lanes.
3. All agents preserve concurrent edits; no reset/clean/stash/rebase, no broad stage/format.
4. Missing shared behavior is reported through the lane request file; it is not patched across
   ownership boundaries.
5. No new agent terminals — reuse `term_297a6033-…` (Copilot) and `term_d7692e4e-…` (Antigravity).
