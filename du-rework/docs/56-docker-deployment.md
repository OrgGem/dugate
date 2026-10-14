# Docker deployment with external PostgreSQL and Redis

This is the current Compose deployment guide for `du-rework`. The deploy
aggregate starts Orchestrator, Connector and the selected business workers;
PostgreSQL and Redis/Valkey remain external services that operators already
run. It does not create, attach, migrate, stop, or reconfigure those services.
`docker compose config` and `scripts/docker/check-env.cjs` are preflight only;
neither proves image availability, schema readiness, application health, or a
successful request flow.

The existing local-development aggregate and the external-service deployment
aggregate intentionally have different infrastructure ownership:

| Entry point | Infrastructure | Use |
| --- | --- | --- |
| `docker-compose.yml` | Local PostgreSQL and Valkey in this Compose project | Isolated local development; generated `.env.docker` credentials |
| `docker-compose.deploy.yml` | External PostgreSQL and Redis/Valkey; two externally managed Docker networks | Release deployments using an operator-protected `.env.docker.deploy` |
| `businesses/<business>/docker-compose.yml` | External worker network only | Start one worker against an already-running platform |

Do not add `compose/infra.yml` to the deployment aggregate. The standalone
worker entry points do not start the platform or infrastructure. The two-slot
package in [55-compose-two-slot-deployment.md](55-compose-two-slot-deployment.md)
is a separate HA package with its own intentionally invalid release overlays;
this basic deployment aggregate is not a substitute for that cutover package.

## Images and build contexts

Each image owns its build context. The Orchestrator and Connector images use
`orchestrator/` as context with their service-specific Dockerfiles. Each worker
uses its own `businesses/<business>/` context; those contexts contain the
worker's copied SDK/workspace dependencies. The root `Dockerfile` remains a
legacy compatibility dispatcher and must not be used to build worker releases.

Build and publish release images in the normal release pipeline, then record
the registry's exact `repository@sha256:<64 lowercase hex>` RepoDigest for each
image. Fill the matching runtime digest fields in the deployment environment:

| Image | Digest variable |
| --- | --- |
| Orchestrator | `DU_ORCHESTRATOR_RUNTIME_IMAGE_DIGEST` |
| Connector | `CONNECTOR_RUNTIME_IMAGE_DIGEST` |
| Document Core | `DOCUMENT_CORE_IMAGE_DIGEST` |
| LC Checker | `LC_IMAGE_DIGEST` |
| Example Review | `EXAMPLE_REVIEW_IMAGE_DIGEST` |

With those fields populated, the Compose `image` reference uses the digest
itself. Keep `DU_IMAGE_PREFIX` and `DU_IMAGE_TAG` for local development when
the digest fields are empty. For a release deployment, use `--no-build`; do
not rebuild a digest-pinned image in place. Pulling or otherwise staging images
is a separate release-pipeline step. The preflight rejects mutable tags, but
only the operator's image registry/provenance checks establish that the
recorded digest is the image that was reviewed.

## External dependencies and network contract

The deploy fragments refer to two external networks. Create them once if they
do not already exist, using names that are dedicated to this deployment and
not old project-prefixed networks:

```powershell
docker network inspect du-platform-net
docker network inspect du-worker-net
# Only when the dedicated network does not exist:
docker network create du-platform-net
docker network create du-worker-net
```

Set `DU_PLATFORM_NETWORK` and `DU_WORKER_NETWORK` in the protected deployment
environment if using different dedicated names. The orchestrator and connector
join both networks; workers join only the worker network. The names `orchestrator`
and `connector` resolve on the worker network. Runtime API port `3002` and
Connector port `8080` remain internal and are never published to the host.
Orchestrator publishes `3000` and Admin Shell `3001` on loopback by default;
set `BIND_ADDRESS` only after reviewing the intended reverse-proxy boundary.

Set `DATABASE_URL`, `CONNECTOR_DATABASE_URL`, and `REDIS_URL` to the existing
services, using addresses and credentials reachable from these containers.
Orchestrator and Connector use separate PostgreSQL database URLs. Workers use
the same Redis-compatible service. Set `DOCUMENT_CORE_DOCKER_REDIS_URL` to the
same value as `REDIS_URL`; this explicit override prevents Document Core from
falling back to its local `valkey` hostname in the external deployment. The
deployment files do not attach an existing container to a new network: if the
existing database or Redis runs in
another Compose project, use a deliberately reviewed routable address/network
arrangement rather than reusing a similarly named project network by guess.
On Docker Desktop, `host.docker.internal` can reach host services; Linux hosts
may require a routed host address or a reviewed `host-gateway` overlay. Do not
assume that `host.docker.internal` resolves on every Docker Engine.

## Deployment environment and preflight

Copy `.env.docker.deploy.example` to an ignored, access-controlled
`.env.docker.deploy` and populate it from the release/secret source. The example
has blank deployment credentials; it is not a runnable config. Keep the
existing `.env.docker`, `.env.live`, and service-local profiles unchanged.
`ENCRYPTION_KEY` is a stable, retained application key and must survive
releases. Keep shared worker authentication keys and per-business tokens
consistent with the Orchestrator's `WORKER_IDENTITY_TOKENS_BY_BUSINESS` map.
The runtime-control tuple and cost-control/Connector identity values are
separate credentials; do not reuse admin, invocation, worker, or database
secrets for those roles.

Before deploying, check the environment and Compose structure without printing
the resolved config:

```powershell
node scripts/docker/check-env.cjs --workflow --deploy .env.docker.deploy
docker compose --env-file .env.docker.deploy -f docker-compose.deploy.yml config --quiet
```

The deployment preflight requires `NODE_ENV=production`, both database URLs,
Redis, the complete Orchestrator and Connector runtime-control tuples, a
non-empty connector URL map, and actual immutable digests for all five images.
It validates PostgreSQL-backed encrypted storage without requiring Vault.
Never run `docker compose config` without `--quiet` into a shared terminal,
log, ticket, or CI artifact when using a credential-bearing env file: rendered
Compose configuration contains resolved environment values.

## Database migration and application start

The external deployment does not create databases or apply schema changes on
ordinary `up`. Review the two database URLs and backup/maintenance window first;
the migration commands below write schema state to those existing databases.
Then run the separately packaged migrations explicitly:

```powershell
docker compose --env-file .env.docker.deploy -f docker-compose.deploy.yml --profile migration run --pull always --rm orchestrator-migrate migrate
docker compose --env-file .env.docker.deploy -f docker-compose.deploy.yml --profile migration run --pull always --rm connector-migrate migrate
```

After both migrations succeed, start only the workers required for the release.
For example, this starts the platform and Document Core only:

```powershell
docker compose --env-file .env.docker.deploy -f docker-compose.deploy.yml up --pull always --no-build -d orchestrator connector document-core
```

Add `lc-checker` or `example-review` only when their business identities and
image digests are included in the deployment. The normal startup has no
migration dependency. Orchestrator verifies its migration state and refuses to
serve a stale or drifted schema; Connector auto-migration is disabled.

The `up` command does not provision business versions, profiles, API keys,
provider bindings, Vault policies, or production approvals. Verify service
health and use the application-specific operational checks after startup. A
Compose health status or rendered model is not an end-to-end deployment receipt.

## PostgreSQL encryption and optional Vault preparation

For PostgreSQL-backed metadata/public-upload encryption, keep the existing
`ENCRYPTION_KEY` stable (at least 32 UTF-8 bytes) or provide the explicit
versioned `DU_LOCAL_ENCRYPTION_*` keyring. Vault Transit is optional for this
mode. S3-backed encrypted artifacts still require complete Transit settings
and identities. Partial Vault Transit configuration fails closed.

The host's pre-existing `du-live-vault` on port 8200 is left untouched. The
optional `infra/docker-compose.vault-persistent.yml` creates a separate local
instance named `du-vault-persistent`, using the already cached immutable Vault
image, a dedicated Raft volume, and loopback port 18200. It is not part of
`docker-compose.deploy.yml`. This preparation config deliberately uses plain
HTTP on loopback for this Windows-host bootstrap; it must not be used as a
production Vault listener. Production Vault requires TLS, a managed identity,
policies, audit/configuration review, and an operational recovery procedure.

After confirming `du-platform-net` exists and that the exact container and
`du-vault-persistent-data` volume do not already exist, the operator can start
the isolated profile and bootstrap it:

```powershell
docker compose --project-name du-vault-persistent -f infra/docker-compose.vault-persistent.yml --profile persistent-vault up --pull never --no-build -d vault
pwsh -NoProfile -File infra/vault/bootstrap-persistent.ps1
```

The script refuses any target except the exact pinned image/name/labels,
configured network, Raft volume, and `127.0.0.1:18200` binding. It checks
CurrentUser DPAPI and protected-file ACL/writeability before initialization,
initializes with five shares and a three-share threshold, encrypts the full
init response to the current Windows user, and persists it before unsealing.
Unseal shares and the root token are never printed or placed in process
arguments. It enables only Transit and KV v2 mounts; it does not create
application keys, AppRoles, policies, or copy any data from the live Vault.

The protected recovery file is
`infra/vault/local/du-vault-persistent-init.dpapi.txt`; it is gitignored and
bound to the current Windows user/profile. Keep the file and the Raft volume
together. A restarted Vault seals again; rerun the same bootstrap script to
unseal from the DPAPI file. If the file is missing or unreadable, the script
refuses to initialize again. Restore the approved recovery material or stop
and investigate; never delete the Raft volume to get past that guard. This new
Vault cannot decrypt ciphertext made by the separate live development Vault,
and its ready Transit/KV mounts do not yet constitute DUGate application
integration.

**Local restart receipt (2026-10-14):** the separate Vault was initialized on
the pinned image with Raft storage, Transit and KV v2 mounts. After a restart,
it correctly reported initialized/sealed/Raft; rerunning the guarded bootstrap
unsealed it from the protected DPAPI file. The bootstrap now waits for active
Vault health (HTTP 200) before authenticated mount checks; the final
restart/rebootstrap exited successfully and confirmed Transit/KV v2. The new
instance reported initialized, unsealed, active Raft, version 2.1.1; the
existing `du-live-vault` on port 8200 remained healthy and unchanged. This is
local restart/persistence evidence, not production acceptance or
application-secret provisioning.

## Evidence boundary

Focused Compose rendering and static deployment tests check the checked-in
source and synthetic environment only. They do not build/push images, mutate
external database schemas, initialize the user's Vault, verify container image
provenance, or prove end-to-end API/worker processing. Record those as separate
operator evidence when performed.
