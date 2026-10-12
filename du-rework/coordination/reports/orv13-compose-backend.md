# UI13 Compose backend and client receipt

Initial source freeze: 2026-10-11 17:48 UTC. Reviewer-driven service-only cursor, empty-claim query, and transaction query receiver corrections were refrozen at 2026-10-11 18:37 UTC; independent actual-PostgreSQL/API verification remains pending. Compose host execution remains separately owned by the host-runner lane; server capability stays disabled when its three configuration values are absent.

## Frozen API contract

`src/modules/compose-operations/contracts.ts` is the source of truth for the safe browser and runner DTOs. Admin BFF methods exported through `apps/admin-web/src/lib/api` are `getComposeCatalog()`, `createComposePreview(body)`, `submitComposeJob(body, idempotencyKey)`, `listComposeJobs(query?)`, and `getComposeJob(jobId)`. Mutations use the BFF CSRF token; submit also requires an idempotency key. The cookie client forwards only the validated active `du_session` or `du_admin` proof and its trusted CSRF value to internal Compose.

Admin routes are `GET /admin/api/compose/catalog`, `POST /admin/api/compose/previews`, `GET|POST /admin/api/compose/jobs`, and `GET /admin/api/compose/jobs/:jobId`. They map to the corresponding `/api/internal/compose/...` paths. Internal Admin access requires the trusted platform bearer; browser-session proof is independently resolved. Cookie role must be Admin, including local Admin sessions whose stored tenant UUID is present. Cookie-only requests cannot become platform requests. Opaque session issuer/subject are retained for audit; legacy `du_admin` is labeled `legacy:admin` with no fabricated person identity.

Runner-only routes use a distinct constant-time checked bearer and configured host scope: `POST /api/internal/compose/runner/snapshot|claim|start|complete|reconcile` and `GET /api/internal/compose/runner/jobs/:jobId`. The status response is a `ComposeJob`; it runs expiration sweeping first and returns no job from another host. No runner endpoint is exposed through the BFF. Fresh snapshot observations produce the server-side observed digest. Start ACK requires that digest to match the job’s immutable expected observation under the target lock; mismatch commits a known FAILED state and authorizes no command. Completion and reconciliation accept exact request replays from their stored digest/ACK; divergent replays conflict. UNKNOWN remains fenced until accepted reconciliation. Success checks each target replica against the trusted pinned image digest and does not require ambiguous per-service release attribution.

The server all-or-none configuration is `COMPOSE_OPERATIONS_HOST_ID` (safe identifier), `COMPOSE_OPERATIONS_RUNNER_TOKEN` (32–512 characters), and `COMPOSE_OPERATIONS_MANIFEST_DIGEST` (64 lowercase hex SHA-256). All absent means capability disabled; partial values fail boot validation. The runner token must differ from platform, runtime, usage, tenant-admin, and worker credentials. Service schema defaults are max sample age 60s, preview TTL 120s, and claim TTL 60s; they are not environment overrides.

The additive `BASIC_ADMIN_USAGE_V1` API uses `GET /admin/api/usage/events` and `/api/internal/usage/events`. It returns persisted runtime event facts with nullable absent cost/provenance and `skippedInvalidEvents`; it does not assert rich COST attribution or add budget editing. The existing public `/api/v1/usage/events` rich exporter remains unchanged. Both OpenAPI artifacts now include the basic projection and Compose Admin/runner routes, with the runner bearer distinct and the public legacy operation surface still GET-only.

## Verification

Commands run in `/workspace/dugate/du-rework` at 2026-10-11 17:48 UTC:

- `./node_modules/.bin/tsc --noEmit -p tsconfig.json` in `orchestrator/services/orchestrator`: passed.
- `./node_modules/.bin/tsc --noEmit -p tsconfig.json` in `orchestrator/apps/admin-web`: passed.
- `./node_modules/.bin/jest --runInBand tests/orv13-compose-backend-owner.test.ts` in `orchestrator/services/orchestrator`: 4/4 passed. Covers tenant-bearing local Admin actor identity, cookie-only/non-Admin/CSRF denial, legacy identity-safe attribution, and distinct runner bearer.
- `node --test tests/orv13-compose-backend-client.test.mjs` in `orchestrator/apps/admin-web`: passed. Covers transport failure not latching, cross-client 401 latch, one event per expiry cycle, explicit same-scope recovery, Compose routes/query/CSRF/idempotency, no mutation crossing an in-flight expiry, late-response fencing, and changed-scope 409/reload requirement.
- `python tools/openapi/gen_openapi.py`: passed; 86 paths, 79 schemas, no dropped prior paths/operations.
- `python tools/openapi/validate_openapi.py`: passed; reference and operation-ID checks, schema assertions, examples, runner auth separation, BFF auth, public rich usage, and GET-only public legacy guards.

Raw command output is in [raw/orv13-compose-backend](/workspace/dugate/du-rework/coordination/reports/raw/orv13-compose-backend). No frontend build, production migration, host command, or deployment was run in this packet. Migration `0048` is authored but should be exercised by the authorized isolated VFY/database lane.

## Frozen source hashes

SHA-256 at source freeze:

| File | SHA-256 |
|---|---|
| `orchestrator/services/orchestrator/src/modules/compose-operations/contracts.ts` | `2532dd2690e62e9f004888466978178ae945b53997116d92b1237ea3aad666ca` |
| `orchestrator/services/orchestrator/src/modules/compose-operations/service.ts` | `fc2a4e060770852808534adf996e4b63ca12d6f4f6a05d449864cf81dcc6d34f` |
| `orchestrator/services/orchestrator/migrations/0048_compose_operations.sql` | `877668787df96943264175f0fbf2fafaa3a0620052e48b8f1862c51afbcb40e1` |
| `orchestrator/services/orchestrator/src/http/routes/internal-compose.ts` | `4194f376e98d887616d39654c6e2e649e14cc9ce5a25c912921ee00cb7c2f6b4` |
| `orchestrator/services/orchestrator/src/http/route-context.ts` | `f9238a99bafb2b6fe354748c8a561014cf7188d9f3ee3fcf833b5e07acd9c484` |
| `orchestrator/services/orchestrator/src/server.ts` | `e53b116c6f1f22b4ed9753034e4b245721e15042979bcec8fc35e4d3896add08` |
| `orchestrator/services/orchestrator/src/main.ts` | `bbb7b83674aac2ab5ce6a224a36a5008423925ea101fa7b52661f2ae90bdb4b7` |
| `orchestrator/services/orchestrator/src/app/bootstrap/create-app.ts` | `58298aee03e358d4a565e9b36055dbd01795c39b9a181c002e22f01263a27a81` |
| `orchestrator/services/orchestrator/src/app/admin/bff/compose.ts` | `29160f61db367302811ec8ce5b28f94e5e971d3a8e3207ff65a2a0b09567a539` |
| `orchestrator/services/orchestrator/src/app/admin/bff/handle.ts` | `91e9d6fb39c90711d652b1bd03436679cb1aea2da3363f13c05b399a422a5374` |
| `orchestrator/services/orchestrator/src/app/admin/bff/upstream.ts` | `0c8479376807191ef7f9b69ff0ea509d13d091ab0baa79773fcc78695d98ff31` |
| `orchestrator/apps/admin-web/src/lib/api/client.ts` | `37478f465ea6a575156a718cad6b3d4fc2907e99578c6ea4ee6dafee987b55c3` |
| `orchestrator/apps/admin-web/src/lib/api/types.ts` | `0605c5783561640a9407bbf8528163076cff938b4e066043e9e6aceb8de84253` |
| `orchestrator/apps/admin-web/src/lib/api/index.ts` | `76ccc1414f42a94bdf9471fe6f059b06f88690588d5343b9ae8fcf5fae19e3d3` |
| `tools/openapi/gen_openapi.py` | `2d0995175442d2eef288a36062a2c2bb439d6e16617392a6bc57b1d452f7002f` |
| `tools/openapi/validate_openapi.py` | `09a18517bfc98f0b8a266f11271c5d89ccd19c05e8a3a3bf01813c28e24fab33` |
| `docs/21-openapi.json` and `orchestrator/docs/21-openapi.json` | `c148e693220bf613e7233714fa4fc0df066ee2963ece9d92e87a89718c97a24d` |

Owner tests are [orv13-compose-backend-owner.test.ts](/workspace/dugate/du-rework/orchestrator/services/orchestrator/tests/orv13-compose-backend-owner.test.ts) and [orv13-compose-backend-client.test.mjs](/workspace/dugate/du-rework/orchestrator/apps/admin-web/tests/orv13-compose-backend-client.test.mjs). The earlier UI13-BACKEND receipt remains at [orv13-backend.md](/workspace/dugate/du-rework/coordination/reports/orv13-backend.md).

## Reviewer-driven job cursor correction

Independent review found that `listJobs` normalized PostgreSQL `created_at` through a JavaScript `Date` when producing and decoding its descending keyset cursor. This loses fractional precision below milliseconds and can repeat or skip jobs created in the same millisecond. The DTO and public query contract did not change.

The list query now selects an exact six-fraction UTC cursor timestamp using PostgreSQL `to_char(created_at AT TIME ZONE 'UTC', ...)`. The cursor carries that exact string, and its decoder validates the fixed PostgreSQL representation then preserves it verbatim for the `(created_at, job_id) < (...)` predicate. Job display timestamps continue using the existing wire conversion. Scope/filter query hashing is unchanged.

Owner recheck:

- `./node_modules/.bin/jest --runInBand --runTestsByPath tests/orv13-compose-backend-owner.test.ts tests/orv13-compose-job-cursor-owner.test.ts` in `orchestrator/services/orchestrator` — PASS, 5/5; raw output: [compose-job-cursor-jest.log](raw/orv13-compose-backend/compose-job-cursor-jest.log). The new limit-1 unit case carries `.000456Z` to the next page before `.000123Z`, checks the exact timestamp SQL bind, rejects a millisecond-truncated cursor, and preserves host-scope binding.
- Orchestrator TypeScript check — PASS; raw output: [compose-job-cursor-typecheck.log](raw/orv13-compose-backend/compose-job-cursor-typecheck.log).

Independent VFY owns the actual-PostgreSQL two-job/sub-millisecond exhaustion case. No local actual-PG result is claimed in this receipt.

Refrozen hashes for changed source/test:

- `orchestrator/services/orchestrator/src/modules/compose-operations/service.ts`: `a4a514fed90d0366ad5129d48992cc634368d113a4a08972ecfe4692a94ac01b`
- `orchestrator/services/orchestrator/tests/orv13-compose-job-cursor-owner.test.ts`: `ab6005b8d3ab9e04009c703f5b3585d0696d1c26da1ef8507ce1f21a1f4adc3c`

## Actual PostgreSQL empty-claim correction

Independent actual-host verification found that a fresh runner snapshot returned 200 but a valid empty-queue claim returned 500. PostgreSQL reported SQLSTATE 42702 (`column reference "host_id" is ambiguous`) in the `claimNextJob` query, which joined `compose_jobs j` to `compose_target_state t` while selecting the bare shared `JOB_COLUMNS`. The original failure is retained at [initial-runner-result.json](../../reports/raw/orv13-vfy-compose-host/initial-runner-result.json).

The claim query now selects `JOB_COLUMNS_J`, qualifying every projected field with `j.`. Inspection of the other Compose joins found that project/catalog joins already use explicit `p.`, `t.`, and `j.` qualifiers; no further query changed. The focused owner case proves a valid empty queue returns `{claim:null}` and that every projected claim column is qualified.

Owner recheck:

- Focused Compose backend Jest — PASS, 6/6 across the existing route/auth, cursor, and new empty-claim suites; raw output: [compose-claim-qualified-columns-jest.log](raw/orv13-compose-backend/compose-claim-qualified-columns-jest.log).
- Orchestrator TypeScript check — PASS; raw output: [compose-claim-qualified-columns-typecheck.log](raw/orv13-compose-backend/compose-claim-qualified-columns-typecheck.log).

Independent verification owns the real API empty-claim rerun and subsequent queued-job claim/start path. No passing claim has yet been observed after this fix.

Latest refrozen hashes:

- `orchestrator/services/orchestrator/src/modules/compose-operations/service.ts`: `05875a12856dadbc4a3d1f86787727a8544f9c8cb87f21e618a90fec63afb9df`
- `orchestrator/services/orchestrator/tests/orv13-compose-claim-owner.test.ts`: `2a192aad77b8e6e05997e3ff539fe0953c64a06c54fa6faac0b42665e6a566c0`

## Preview transaction query receiver correction

Independent Compose verification then found preview creation returning 502 after inventory succeeded. The verifier is checking the direct-service TypeError. Inspection found `getProjectRow` extracted `executor.query` and called it unbound; a real `PoolClient.query` depends on its receiver, although the lightweight `Db.query` wrapper can hide this defect. This was the only extracted query method in the Compose service; all other `.query` calls invoke the method directly. The failing preview probe is retained at [preview-probe-failure.json](../../reports/raw/orv13-vfy-compose-host/preview-probe-failure.json).

`getProjectRow` now binds the extracted method back to `executor` before invoking it. A receiver-sensitive `createPreview` test exercises `PoolClient`-style behavior and ensures the project read proceeds through the preview insert.

Owner recheck:

- Focused Compose backend Jest — PASS, 7/7 across the existing route/auth, cursor, empty-claim, and preview-receiver suites; raw output: [compose-preview-query-receiver-jest.log](raw/orv13-compose-backend/compose-preview-query-receiver-jest.log).
- Orchestrator TypeScript check — PASS; raw output: [compose-preview-query-receiver-typecheck.log](raw/orv13-compose-backend/compose-preview-query-receiver-typecheck.log).
- Scoped whitespace check — PASS.

Independent verification owns the rebuilt real preview/submit/start/completion flow. No passing real preview is claimed after the fix.

Latest refrozen hashes:

- `orchestrator/services/orchestrator/src/modules/compose-operations/service.ts`: `6956072ce71e732eb4f9823242cd0914017e4127de483d61df8defba6ad6b55d`
- `orchestrator/services/orchestrator/tests/orv13-compose-preview-query-receiver-owner.test.ts`: `ab31ee970f91eb2d6a2ee11c38e59c04a2303852c95e27a1b7f426712f565890`
