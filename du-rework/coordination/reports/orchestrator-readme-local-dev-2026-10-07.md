# Orchestrator README and local development verification

Date: 2026-10-07. Scope: du-rework. User requested step-by-step Orchestrator README and working local tests/dev. No commit/push.

## Delivered

- `orchestrator/README.md`: eight steps covering toolchain/install, private environment, isolated infra, build/offline smoke, migration, startup, health/Portal login, shutdown and troubleshooting.
- `scripts/init-orchestrator-local.cjs`: idempotent private profile generation, randomized secrets, dedicated local URLs, explicit synthetic-data-only acknowledgement. Existing file retained, no secret values printed.
- `infra/docker-compose.orchestrator-local.yml`: dedicated PostgreSQL/Redis project, loopback 15433/16380, healthchecks, persistent DB volume. Does not reuse existing live/test containers.
- `scripts/test-orchestrator-local.cjs`: explicit offline smoke suites and Portal typecheck, fail on nonzero child exit. Does not disguise broad-suite findings as green.

## Executed evidence

Toolchain: Node v24.21.0, pnpm 10.18.3, Windows. Cwd for commands: `D:/Git/dugate/du-rework`. Windows global pnpm shim uses older Node; production build used the temporary Node 24 pnpm shim documented in the preceding relocation receipt. No global Node installation changed.

Raw directory: [raw/orchestrator-readme-local-dev-2026-10-07](raw/orchestrator-readme-local-dev-2026-10-07/).

| Command/check | Result | Exit/evidence |
| --- | --- | --- |
| `node scripts/init-orchestrator-local.cjs` | Generated ignored `.env.orchestrator.local`; no secrets emitted | 0, owner tool output |
| `node scripts/dev.cjs --env-file=.env.orchestrator.local --workers=document-core --check` | Correct topology | 0, owner tool output |
| `docker compose --env-file .env.orchestrator.local -f infra/docker-compose.orchestrator-local.yml up -d --wait` | Dedicated Postgres/Redis healthy | 0, owner tool output |
| `node scripts/build-all.cjs` | All 12 components built | 0, `build.log`, `build.exit.txt` |
| `node scripts/migrate-local.cjs --env-file=.env.orchestrator.local` | 36 migrations applied to new `du_orchestrator_dev` on 15433, verification passed | 0, `migrate.log`, `migrate.exit.txt` |
| `node scripts/test-orchestrator-local.cjs` | Contracts: 30 suites/568 pass. Connector: 34 suites/439 pass/1 skip. Orchestrator focused: 10 suites/91 pass/6 skip. Portal tsc passed. Total 1,098 passed/0 failed/7 skipped | 0, `offline-smoke.log`, `offline-smoke.exit.txt` |
| Dev runner with `--env-file=.env.orchestrator.local --workers=document-core --skip-build --skip-migrate` | Backend/Portal/Connector start; worker registers and listens to `du-business-document-core-1.0.0` | 0, `dev-run.log`, `dev-run.exit.txt` |
| HTTP GET public/internal health, Connector readiness, Portal login page | All four 200 | `health.json`, `health.exit.txt` = 0 |
| POST Portal login using private ADMIN_TOKEN, GET Portal with resulting session cookie | Login 302; authenticated Portal 200. Cookie/token not recorded | `portal-login.json` |
| SIGINT runner handler followed by dedicated Compose `stop` | Test session stopped; DB volume/env retained | 0, owner tool output |
| `node --check` for both added helpers; scoped `git diff --check`; `git check-ignore .env.orchestrator.local` | Syntax/whitespace valid; private environment ignored | 0, owner tool output |

Dev runner was loaded with the documented argv in a Node wrapper and a 45-second timer emitted SIGINT to its normal shutdown handler, allowing bounded verification and cleanup. This exercised the real runner/startup/auth stack. It was not a browser interaction audit or provider workload.

The initial new profile omitted `CONNECTOR_SERVICE_TOKEN`, which document-core requires whenever Connector URL is set. Worker startup failed, and runner correctly stopped its children. Fixed helper to include startup fixture token and actual `CONCURRENCY=1` variable; corrected the freshly generated private profile and reran successfully. Final dev log supersedes that first failure. The fixture token is intentionally not a signed service identity: provider calls still require authorized audience/scope/expiry and invocation grants. README states this explicitly; auth validation was not weakened.

## Limits and next use

Only synthetic local fixtures may be used with this profile's encryption exemption. No existing live DB migrations/containers changed. Infrastructure containers are stopped, named DB volume and ignored env retained; rerun README step 3 then step 6.

Startup, registration, health and authenticated Portal page pass. No document workload/provider call, browser feature audit, paid AI call or full-suite acceptance claimed. SDK crypto/memory and example-review logger-test findings from the preceding relocation receipt remain open. Owner verification does not independently accept/release the platform.
