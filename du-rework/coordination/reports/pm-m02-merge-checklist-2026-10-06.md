# PM-M02 merged integration checklist — 2026-10-06

## Purpose and current evidence

This packet prepares a local integration check for the PM-M02-ROUTE + PM-M02-COMPOSE snapshot. It does not change Orchestrator source, start/stop containers, run migrations, or claim deployment acceptance. The current tree contains the PM-M02 listener/config code and `pm-m02-ingress-fence.test.ts` / `pm-m02-ingress-verification.test.ts`; the reports directory inspected during preparation contained the architecture spec and Compose receipt, but no separate PM-M02-ROUTE closeout receipt. Run this checklist only after the route owner confirms the merged snapshot and required source verification are ready.

The read-only verifier is `scripts/docker/verify-pm-m02-merge.cjs`. It refuses to inspect containers without an explicit isolated project name prefixed `pm-m02-verify-`. It renders only the default root Compose file (which includes the service fragments), never the local debug overlay. It does not call `up`, `down`, `build`, or `migrate`, and it does not print container environment values. Its optional `--config-only` mode checks effective Compose configuration and the widened-bind case before a stack is started.

## 1. Preflight gates

- Confirm both route and Compose changes are present in the same reviewed snapshot. Record its commit/hash and the two owner receipts. Do not test an intermediate state: the new worker URL requires the internal listener, and the route fence must be live before switching workers.
- From the Orchestrator package, run the route tests and build checks:

  ```sh
  pnpm --filter @du/orchestrator run test --runTestsByPath tests/pm-m02-ingress-fence.test.ts tests/pm-m02-ingress-verification.test.ts
  pnpm --filter @du/orchestrator run typecheck
  pnpm --filter @du/orchestrator run build
  ```

- Provision a disposable local `.env.docker`; do not reuse a production `DATABASE_URL`, `REDIS_URL`, API tokens, service identity secret, Vault credentials, or provider credentials. Keep `DATABASE_URL` pointed to the Compose `postgres` service and `REDIS_URL` to `valkey`. The verifier checks these effective Compose hosts before inspecting the stack.
- Choose a unique project name, for example `pm-m02-verify-20261006-a`. Compose starts the `migrate` service during `up`, so use its isolated project volume and local database only.
- Keep the debug overlay out of the run. Do not pass `-f compose/local-debug.yml`, `COMPOSE_FILE` entries for it, or any equivalent port override.
- If Connector usage delivery is enabled, use `USAGE_SINK_URL=http://orchestrator:3002/api/runtime/v1/usage-events` and the existing usage token. Leave both empty to keep it disabled.

## 2. Start the isolated default stack

From `du-rework/`, using the unique project name selected above:

```sh
docker compose --env-file .env.docker --project-name pm-m02-verify-20261006-a -f docker-compose.yml up -d --build
docker compose --env-file .env.docker --project-name pm-m02-verify-20261006-a -f docker-compose.yml ps --all
```

Wait for Orchestrator, Connector, Postgres, Valkey, and all three workers to be running/healthy; `migrate` must finish successfully. A failed migration, unhealthy dependency, or restart loop is an abort. Do not repair the disposable database in place for this packet; preserve the logs and investigate the cause.

## 3. Run the integration verifier

```sh
node scripts/docker/verify-pm-m02-merge.cjs --env-file .env.docker --project-name pm-m02-verify-20261006-a
```

Expected checks and evidence:

1. **Both Orchestrator listeners:** effective Compose and the running container have `PORT=3000`, `ORCHESTRATOR_PORT=3000`, `ORCHESTRATOR_INTERNAL_PORT=3002`, and the specified `0.0.0.0` container bind hosts. In-container `GET /health` must return 200 on both `127.0.0.1:3000` and `:3002`.
2. **Workers use the internal Runtime:** effective config for `document-core`, `lc-checker`, and `example-review` must resolve `RUNTIME_URL` exactly to `http://orchestrator:3002/api/runtime/v1`. From each running worker container, the script sends the existing authenticated, read/write-free compatibility heartbeat to that internal Runtime URL and expects 200. With the same credential it probes the public listener's Runtime path and expects the route fence's 404.
3. **No default host publication:** effective config and `docker inspect` must show no host binding for Orchestrator target 3002 or Connector target 8080; Connector must have no `ports` entry. The verifier also renders config with `BIND_ADDRESS=0.0.0.0` to ensure that widening the public/Portal mappings cannot publish either internal target.
4. **Host-side reachability:** from the Docker host running this verifier, TCP connections to `127.0.0.1:3002` and `127.0.0.1:8080` must fail. A local port occupied by another process makes the check fail and must be identified before acceptance.
5. **Optional sink contract:** if either Connector usage sink variable is set, both must be set and its URL must be the internal `:3002/.../usage-events` endpoint.

The heartbeat is the current RFX-12 compatibility stub and deliberately writes no worker state; this checks DNS, the internal listener, the worker's supplied runtime identity, and ingress fencing, not task claim/processing. The script is read-only with respect to Compose lifecycle but makes these small authenticated HTTP probes. It emits only check statuses, never bearer values.

## 4. Separate external-client check

No host-local check proves a separate network's routing/firewall behavior. From a client outside the Docker host, target that host's reachable address and verify both ports are unreachable:

```powershell
Test-NetConnection -ComputerName <docker-host-address> -Port 3002 -InformationLevel Quiet
Test-NetConnection -ComputerName <docker-host-address> -Port 8080 -InformationLevel Quiet
```

Both results must be `False`. Run this from a genuinely separate client/network vantage; testing the Docker host against itself is not this check. Record client location, target address (no credentials), time, and results. Port-mapping inspection remains required even if a firewall blocks the external probe.

## 5. Abort conditions and evidence to retain

Abort and do not accept the merged packet if any check finds: missing or unhealthy listener/container; wrong listener environment or health result; worker Runtime URL still on port 3000; a worker probe other than 200; public Runtime reachable instead of returning 404; any Docker host binding for 3002/8080; a successful host TCP connection; an enabled usage sink aimed at any other URL; or a database/Redis endpoint outside the isolated Compose project.

Retain the merged snapshot hash, Docker/Compose/Node versions, sanitized `docker compose config`/`ps` evidence, migration exit status, verifier stdout/exit status, and the separate-client probe results. Never attach `.env.docker`, `docker inspect` environment output, tokens, or secrets. Record checks as PASS/FAIL/SKIPPED; a skipped external-client check remains open and cannot be represented as verified.

## 6. Cleanup

After evidence review, stop only the uniquely named test project:

```sh
docker compose --env-file .env.docker --project-name pm-m02-verify-20261006-a -f docker-compose.yml down
```

This leaves its named data volumes available for investigation. If volume deletion is separately approved, verify the exact project name first and remove only that project's volumes; do not use global prune commands.

## Preparation validation

`node --check scripts/docker/verify-pm-m02-merge.cjs`, `node scripts/docker/verify-pm-m02-merge.cjs --help`, and the following sanitized config-only invocation exited 0:

```sh
node scripts/docker/verify-pm-m02-merge.cjs --env-file .env.docker.example --project-name pm-m02-verify-20261006-preflight --config-only
```

The config-only result passed the default endpoint/publication assertions and the `BIND_ADDRESS=0.0.0.0` widening assertion. The full integration verifier was not run because this task prepares the post-merge packet; no Compose services were started and no migration was executed. The packet does not replace PM-M02's independent listener, security, and deployment acceptance checks.
