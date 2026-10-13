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

For a production image, copy `.env.docker.example` to `.env.docker.local`, replace the placeholder with the existing example-review runtime token, then run `docker compose up -d --build`. The Docker context is this directory and the image contains only production package files and dependencies. The standalone Compose example reaches host services through `host.docker.internal`.
