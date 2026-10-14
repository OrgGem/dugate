# LC Checker local worker

Run the worker from this directory. It reads `businesses/lc-checker/.env.local`, uses the internal Runtime API on port 3002, and watches this package's `src/` and `vendor/` trees for edits.

Create the worker-local config once, then use the already-provisioned `lc-checker` runtime token and an issued Connector invoke token:

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

The worker has no HTTP listener. The local runner defaults `RUNTIME_URL` to `http://127.0.0.1:3002/api/runtime/v1`, `REDIS_URL` to `redis://127.0.0.1:16380`, and `CONNECTOR_URL` to `http://127.0.0.1:8088`. Start PostgreSQL, Redis, Orchestrator, and Connector separately before expecting the worker to register or process tasks.

The local config uses `CONNECTOR_SERVICE_TOKEN`. For development, you may replace that line with `SERVICE_IDENTITY_SECRET` to mint a fresh short-lived Connector JWT using the shared HS256 identity contract; set one value, not both. The signing key stays out of the worker process. This does not rotate or rewrite the existing business runtime token.

`pnpm run dev -- --skip-build` starts from existing `dist/` artifacts. `pnpm run build`, `pnpm run test:unit`, and `pnpm run test:typecheck` work from this directory without the parent workspace. Integration tests requiring Orchestrator services live outside this package's default offline suite.

For Docker deployment, copy `.env.docker.example` to `.env.docker.local`, set
`LC_RUNTIME_TOKEN` to the existing business identity and set
`CONNECTOR_SERVICE_TOKEN` to an issued `connector:invoke` token. The Compose
entrypoint starts only LC Checker and connects it to the externally managed
`du-worker-net`; the platform services must already be attached under the DNS
names `orchestrator`, `valkey`, and `connector`.

```sh
docker compose --env-file .env.docker.local config
docker compose --env-file .env.docker.local up -d --build
```

The worker publishes no port and Compose does not start or recreate platform
services. Runtime uses the internal `orchestrator:3002` listener. The Node
process receives `SIGTERM` directly and drains for the SDK's 15-second default.
