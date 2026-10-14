# Local Document Core development

Document Core has a nested pnpm workspace containing the worker and the exact
Orchestrator SDK packages it consumes. Run commands from this directory so
pnpm selects this workspace rather than the repository workspace:

```sh
pnpm install --frozen-lockfile
```

Copy `.env.example` to `.env.local`. Set `RUNTIME_TOKEN` to the existing
Document Core business token and `CONNECTOR_SERVICE_TOKEN` to an active
Connector invoke token. The local launcher also accepts the existing 32-byte
`SERVICE_IDENTITY_SECRET` in `.env.local` as a development-only alternative;
it derives a fresh Connector invoke token for each start and removes the
signing key before starting the worker. Keep these values private and do not
rotate them for this setup. You can pass an explicit profile with
`pnpm run dev -- --env-file=PATH`, or let a parent development launcher provide
the Runtime and Redis environment directly.

Use `pnpm run dev:check` to validate configuration without starting anything,
and `pnpm run dev` to build the vendored packages and worker before starting
the watcher. The watcher rebuilds when files under `src/` or `vendor/` change.
`pnpm run dev -- --no-watch` starts once, and `pnpm run dev -- --skip-build`
reuses existing output.

`pnpm run build` and `pnpm run test` operate on this package and its local
vendored sources. Tests that import Orchestrator/Connector source remain
available through `pnpm run test:monorepo` and
`pnpm run test:monorepo:typecheck`; those explicit commands build and use the
parent monorepo. The worker does not provision an active business version,
profile, or provider key.

For Docker deployment, copy `.env.example` to `.env.docker.local`, set
`DOCUMENT_CORE_RUNTIME_TOKEN` to the existing business identity and set
`CONNECTOR_SERVICE_TOKEN` to an issued `connector:invoke` token. The Compose
entrypoint starts only this worker and connects it to the externally managed
`du-worker-net`; the platform services must already be attached under the DNS
names `orchestrator`, `valkey`, and `connector`.

```sh
cp .env.example .env.docker.local
docker compose --env-file .env.docker.local config
docker compose --env-file .env.docker.local up -d --build
```

The worker publishes no port and Compose does not start or recreate platform
services. Runtime uses the internal `orchestrator:3002` listener. Its direct
Node process receives `SIGTERM` and drains for the configured shutdown grace.
