# Orchestrator candidate (MIG-04)

This repository boundary contains Orchestrator Backend, Orchestrator Portal
(`apps/admin-web`, pending the planned naming migration), Connector, and the
canonical platform packages. Business workers live in separate repositories.

Use Node 24.21.0 and pnpm 10.18.3. From this directory:

```sh
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm build:candidate
pnpm verify:isolation
docker build --target orchestrator -t du-orchestrator-candidate .
docker build --target connector -t du-connector-candidate .
```

The Docker context needs no parent repository, worker source, host dependencies,
or credentials. `patches/` and `vendor/` preserve the canonical security fixes.
Generated lockfile importers may include historical canonical workspace entries;
only packages/services/apps in this candidate are installed as workspaces.

Runtime artifact grants require a trusted worker-reachable origin. Configure
`ORCHESTRATOR_INTERNAL_BASE_URL=http://orchestrator:3002` for the Compose topology;
use the actual internal HTTP(S) origin for other deployments. This is deployment
configuration, never the request Host header or the public port 3000. PostgreSQL
storage grants target authenticated internal Runtime routes; presigned S3 URLs
remain unchanged. Internal 3002 and Connector 8080 need no default host mapping.

Refresh the candidate from the canonical source with
`node scripts/export-orchestrator-candidate.cjs` from the parent rework workspace.
The exporter uses an explicit allowlist and writes `source-inventory-phase-b.json`.
The ingress test helper is copied explicitly into this repository's test tree,
so the test no longer imports a worker sibling. This candidate has no cutover,
remote publication, or independent acceptance implied by its successful build.
