# example-review local worker

Run the worker from this directory. It reads `businesses/example-review/.env.local`, uses the internal Runtime API on port 3002, and watches this package's `src/` and `vendor/` trees for edits.

Copy `.env.local.example` to `.env.local` and set the existing `example-review` business runtime token. The runner passes only the worker's allowlisted settings to its child process.

```powershell
Copy-Item .env.local.example .env.local
pnpm install
pnpm run dev
```

```bash
cp .env.local.example .env.local
pnpm install
pnpm run dev
```

The worker has no HTTP listener. The local runner defaults `RUNTIME_URL` to `http://127.0.0.1:3002/api/runtime/v1` and `REDIS_URL` to `redis://127.0.0.1:16380`. Start PostgreSQL, Redis, and Orchestrator separately; start Connector when the selected workflow uses connector slots. The runner does not contact services during startup.

`pnpm run dev -- --skip-build` starts from existing `dist/` artifacts. `pnpm run build`, `pnpm run test:unit`, and `pnpm run test:typecheck` work from this directory without the parent workspace. The live continuation and admin integration tests are explicit monorepo-only checks and are excluded from the default offline suite.

For Docker deployment, copy `.env.docker.example` to `.env.docker.local` and
set `EXAMPLE_REVIEW_RUNTIME_TOKEN` to the existing business identity. The
Compose entrypoint starts only Example Review and connects it to the externally
managed `du-worker-net`; the platform services must already be attached under
the DNS names `orchestrator` and `valkey`.

```sh
docker compose --env-file .env.docker.local config
docker compose --env-file .env.docker.local up -d --build
```

The worker publishes no port and Compose does not start or recreate platform
services. Runtime uses the internal `orchestrator:3002` listener. The Node
process receives `SIGTERM` directly and drains for 15 seconds before Compose's
30-second stop deadline.
