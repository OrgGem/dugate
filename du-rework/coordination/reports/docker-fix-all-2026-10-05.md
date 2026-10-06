# DOCKER-FIX-ALL-20261005

Date: 2026-10-05. Owner: Codex direct user task. CWD: `D:\Git\dugate\du-rework`.

User scope: repair Docker build and Compose for Orchestrator, Connector, Document Core, LC Checker and Example Review, both individually and together. Existing source changes in the shared worktree were retained. No commit, task checkbox or acceptance gate was changed.

| Implemented | Checked by implementation owner | Accepted |
|---|---|---|
| Five-target Docker build, production runtime deploy, shared Compose topology, migration startup dependency, Admin assets/env, worker connectivity | Five images built from source; six Compose models; 20 regression + 10 running-stack assertions; aggregate and five standalone startup runs | No independent reviewer or release verdict claimed |

## Changes

- Canonical root `Dockerfile`: measured Node 22 Alpine digest, pnpm 10.18.3, lockfile fetch/cache, source builds in dependency order, offline portable production dependency deployment, runtime user `node`, explicit `node` commands and SIGTERM. All five compatibility Dockerfile paths are generated from that file and checked for drift.
- Runtime dependency planner excludes development-only workspace edges (the worker SDK's Connector test dependency previously broke LC/Example builds). Runtime packages contain compiled code and production dependencies; Connector SQL migrations and Orchestrator SQL/Admin assets are explicitly packaged.
- pnpm deploy uses the shared frozen lockfile, with `injectWorkspacePackages` adjusted **inside the build container only**. Locked importers/versions are preserved and regression checked. Build/deployment commands after installation run under `RUN --network=none`. The repository lockfile is not edited by this task.
- `compose/infra.yml` is the single infrastructure/network/volume definition. Five service fragments are reused by the aggregate entrypoint and standalone wrappers. This removes conflicting imported Postgres/Valkey definitions, fabricated/stale proof image pins, fixed container names and global network names.
- Explicit migration job must exit successfully before API boot; `AUTO_MIGRATE=false`. Connector retains its own startup migrations. Host port overrides preserve internal API/Admin/Connector ports 3000/3001/8080 and healthchecks. Worker/Connector network intersection is repaired. Workers wait for healthy API/queue/Connector dependencies as applicable.
- Runtime images run as a regular user. Application containers use `init: true` and shutdown grace periods exceeding configured drain budgets. Postgres/Valkey have persistent project-scoped volumes and no published host ports; Valkey uses AOF and `noeviction`. API/Admin/Connector publish to loopback by default.
- `.env.docker.example` and `init-env.cjs` distinguish raw Orchestrator grant bytes from Connector base64 of the same bytes. Connector service identities are signed/expiring tokens, separate from signing keys. Local generator uses distinct per-business runtime tokens and refuses to overwrite existing env files. Generated identity expires after 24 hours; production must use its identity issuer and refresh process.
- Build context and Git ignore exclude secret env files. LF attributes cover container build/config scripts. README/deployment guide and append-only trace/test/acceptance references record current behavior without closing gates.

## Measured results

All final commands exited **0**:

| Command/check | Actual result | Raw output |
|---|---|---|
| `node --test tests/deployment/docker.test.cjs` | 20 passed, 0 failed/skipped; six Compose models validated | [regression](docker-fix-all-2026-10-05-tests-final.log) |
| `docker compose --env-file <synthetic-env> -p du-fix-20261005 build --progress plain` | All five images built; TypeScript compilation of all five services, runtime workspace dependencies and Admin Web completed; Admin Web Vite build passed | [build](docker-fix-all-2026-10-05-build-final.log) |
| Full stack `up -d --no-build --wait --wait-timeout 180` | 7 long-running containers up; migration container exited 0; 32 Orchestrator migrations applied and verified | [startup](docker-fix-all-2026-10-05-up.log), [runtime](docker-fix-all-2026-10-05-runtime-final.log) |
| Same stack with generated scoped business tokens | Successful recreation/startup with separate Document/LC/Example bearer identities | [scoped startup](docker-fix-all-2026-10-05-up-scoped.log) |
| `node --test tests/deployment/smoke.cjs` against scoped stack | 10 passed, 0 failed/skipped: five non-root runtime packages, migration/process state, three worker network paths, Admin Secure-cookie login and bundled JS/CSS | [scoped smoke](docker-fix-all-2026-10-05-smoke-scoped.log) |
| All five standalone wrappers `up --no-build --pull never --wait` | Orchestrator 4 containers; Connector 3; Document Core 6; LC Checker 6; Example Review 5; all expected process/health states, zero restarts | [standalone startup + cleanup](docker-fix-all-2026-10-05-standalone.log) |
| Scoped `git diff --check` | No whitespace errors | command exit 0 |

There are **30 unique regression/smoke assertions**, plus **5 standalone deployment runs**. Repeated global-token/scoped-token smoke runs are not counted twice. Workspace compilation is a build check, not an additional test suite. This is a source build with host `dist`/`node_modules` excluded; shared BuildKit base/store cache was used, so this is not a `--no-cache` run.

## Tested images

Measured local image IDs/sizes/user (not invented registry publication digests):

```text
[du-fix-orchestrator:20261005] sha256:ffcc9b2121a4b83ba629c3ca58f4a2ae4b915ea56f1f2226e524162d2be2f939 66925653 node
[du-fix-connector:20261005] sha256:8116c76f135bf78b6c409a3d872d23d472e17fb8dffb963eb5dabf80d5a186a7 61900405 node
[du-fix-document-core:20261005] sha256:74b92ca79d18292285e27f92e4fa29ea7497d3d2245b55003980e5c5f1c7df26 75118901 node
[du-fix-lc-checker:20261005] sha256:7571979a161f9327c60dc4ce9c9168368afe2617afee6eb5f2262a20cb290688 75019258 node
[du-fix-example-review:20261005] sha256:3b0339b330c2970286134e99e42396d5ff0a45b86bf93bb8f6ca51f02fada8bb 74968040 node
```

## Isolation, cleanup and limits

Synthetic secrets lived outside the repository; ports 23100/23101/23180 and project `du-fix-20261005` were used. Standalone projects used `du-fix-20261005-<service>` with separate fresh volumes. Cleanup verified each volume's Compose project label before removing only these task-owned containers/networks/volumes. Existing unrelated Docker containers and data were not touched. Built images are retained for review.

Admin smoke simulated a trusted TLS proxy on the isolated loopback shell (`DU_ADMIN_TRUST_PROXY_PROTOCOL=true`, request forwarded protocol `https`) and asserted a Secure/HttpOnly cookie. This does not prove a production TLS proxy deployment. React mounting defaults off (`DU_ADMIN_WEB=0`) and is explicitly enabled only in the smoke fixture. Local/OIDC auth mode and its identities remain operator provisioning choices.

The worker heartbeat route currently returns a compatibility `DEGRADED` acknowledgment and persists no worker health telemetry. Smoke asserts actual process/no-restart state and API/Valkey/Connector network access instead of claiming healthy business telemetry. Business manifests, active profiles/API keys/provider bindings, real document jobs, S3/Vault/provider execution and HA are outside this Docker repair verification; existing acceptance gates remain open.

Earlier retained failed attempts: legacy pnpm deploy tried to resolve dependencies over the network and failed; shared deployment initially rejected the build-only injection setting mismatch. Both were corrected before the final successful five-image build. Initial smoke queue probes incorrectly required transitive `ioredis` from the service root; probes now use a real RESP PING over the worker network and all pass. These are diagnostic attempts, not hidden passes. Vite reports its existing large-chunk warning; the build exits 0.

## Operator commands

From `du-rework/`:

```bash
node scripts/docker/init-env.cjs .env.docker
docker compose --env-file .env.docker config --quiet
docker compose --env-file .env.docker up -d --build --wait
```

For production, provision `.env.docker` from `.env.docker.example`, set immutable image tags/reviewed infra digests, configure the existing S3/Vault/identity topology and a trusted TLS reverse proxy according to [deployment guide](../../docs/12b-deployment-guide.md). The local env generator is explicitly local-only.

Primary implementation references: [Compose include](https://docs.docker.com/reference/compose-file/include/), [startup dependencies](https://docs.docker.com/compose/how-tos/startup-order/), [pnpm 10 deploy](https://pnpm.io/10.x/cli/deploy), [pnpm Docker](https://pnpm.io/10.x/docker), [pnpm 10.18.3 deploy implementation](https://github.com/pnpm/pnpm/blob/v10.18.3/releasing/plugin-commands-deploy/src/deploy.ts).
