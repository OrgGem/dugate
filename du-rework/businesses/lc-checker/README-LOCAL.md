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

For a production image, copy `.env.docker.example` to `.env.docker.local`, replace the placeholders with the existing LC Checker runtime token and an issued Connector invoke token, then run `docker compose up -d --build`. The Docker context is this directory and the image contains only production package files and dependencies. The standalone Compose example reaches host services through `host.docker.internal`; container loopback points back to the worker itself.
