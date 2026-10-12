# Two-slot Compose deployment package

This package describes a blue/green topology for the Orchestrator, Connector,
and Document Core Worker. It is a source package, not a deployment receipt.
The checked-in images and release overlay contain deliberately invalid
`example.invalid` references and zero digests. Do not run them as supplied.
No image was built, pulled, or started for this change.

The slot topology uses two independent Compose projects with the same stable
service keys: `du-availability-blue` and `du-availability-green`. Each project
contains `orchestrator`, `connector`, and `document-core`. A third, single
`du-availability-ingress` project owns the fixed Nginx ingress. The ordinary
public listeners are ports 80 and 443. Authenticated worker traffic uses the
unpublished port 8080. The internal identity/control listener uses port 8081
and is published to the host only at `127.0.0.1:18081`. Direct per-slot
control ports are also loopback-only. Document Core has no published port and
no HTTP listener.

`compose/availability.yml` defines service keys, profiles, network names,
health checks, and the fixed runtime-config bootstrap. It has no Compose
variable interpolation, `env_file`, `include`, or `build` entry. Its
`slot-release.example.yml` is a one-slot template. An operator must render
literal blue and green overlays, replace every
invalid image/digest/path/identity sentinel, and review the result before
installing it. The `.env.example` is a checklist only; never pass it to Compose
or rename it to `.env`.

## Runtime configuration and protected files

Each runtime receives one root-managed JSON file through the Compose secret
mount at `/run/secrets/runtime-config`. The fixed bootstrap accepts only this
outer shape:

```json
{"schemaVersion":1,"service":"orchestrator","environment":{"KEY":"value"}}
```

Use the matching service name (`orchestrator`, `connector`, or `document-core`)
and keep all credentials, connection strings, encryption keys, bearer tokens,
and provider credentials in this file or in the existing protected credential
source. Do not put secrets in Compose YAML, a shell environment, Docker argv,
or the checklist. Set `DU_RUNTIME_CONFIG_SHA256` to the lowercase SHA-256 of
the exact JSON bytes in the rendered overlay. Install each file root-owned,
readable only by the image runtime account (for example `root:1000` mode
`0440`), and keep its parent directory root-owned and non-writable by the
runtime. The bootstrap checks the digest and service binding before starting a
fixed application entry point; the JSON cannot override service identity,
Node loader settings, or the file path/digest pins.

Keep the six process identities in the literal slot overlays, not in the
secret JSON:

| Service | Required slot values |
| --- | --- |
| Orchestrator | `DU_ORCHESTRATOR_RUNTIME_SLOT`, `DU_ORCHESTRATOR_RUNTIME_IDENTITY`, `DU_ORCHESTRATOR_RUNTIME_REVISION`, `DU_ORCHESTRATOR_RUNTIME_IMAGE_DIGEST` |
| Connector | `CONNECTOR_RUNTIME_SLOT`, `CONNECTOR_RUNTIME_IDENTITY`, `CONNECTOR_REPLICA_ID`, `CONNECTOR_RUNTIME_REVISION`, `CONNECTOR_RUNTIME_IMAGE_DIGEST` |
| Document Core Worker | `WORKER_INSTANCE_ID`, `WORKER_REVISION`, `WORKER_BUSINESS_ID=document-core`, `IMAGE_DIGEST` |

Use a distinct runtime identity for each service in each slot. Connector's
`CONNECTOR_REPLICA_ID` must equal its runtime identity. Each image pin must be
the exact `repository@sha256:<64 lowercase hex>` image used by that process.
The Host manifest's target revision, runtime identity, image digest, project,
and service key must match the rendered overlay and the live process response.

Set the Orchestrator's `ORCHESTRATOR_INTERNAL_BASE_URL` to
`http://du-availability-ingress:8080` in both the base Compose service
environment and its protected runtime JSON. Orchestrator returns absolute
artifact-grant URLs using this value. Worker processes follow those URLs from
the `172.31.0.0/24` worker API network; container-local `127.0.0.1` would point
back to the Worker process itself. Nginx's private 8080 listener routes
`/api/runtime/v1/` to the selected Orchestrator API listener on port 3000 and
allows only the Worker API subnet. Connector invocations receive authenticated
artifact content inline, so Connector and control-network CIDRs do not belong
on the worker-only listener ACL. In its protected runtime JSON, set each
configured Connector management URL to
`http://du-availability-ingress:8081/connector`.
Connector's protected runtime JSON uses
`COST_CONTROL_CONNECTOR_URL=http://du-availability-ingress:8081`; Worker uses
`CONNECTOR_URL=http://du-availability-ingress:8080/connector`. Those names
resolve only on their attached private Docker networks. Keep the service
tokens in the protected runtime files.

## Networks and ports

Provision the existing infrastructure project separately and preserve its
`du-availability-infra_du-platform-net` network name. The three networks below
are external to the blue and green projects. Use the stated subnets because
the Nginx ACLs use the worker and control ranges:

| Network | Subnet | Members |
| --- | --- | --- |
| `du-availability-ingress-net` | `172.32.0.0/24` | Both slots and fixed ingress; public/Admin/Connector upstreams |
| `du-availability-worker-api-net` | `172.31.0.0/24` | Worker and fixed ingress; private worker API path |
| `du-availability-control-net` | `172.30.0.0/24` | Orchestrator, Connector, and fixed ingress; signed internal control path |

Create the three networks once if the infrastructure operator has not already
created them; do not recreate or change their subnets during a rollout:

```sh
docker network create --driver bridge --subnet 172.32.0.0/24 du-availability-ingress-net
docker network create --driver bridge --subnet 172.31.0.0/24 du-availability-worker-api-net
docker network create --driver bridge --subnet 172.30.0.0/24 du-availability-control-net
```

The fixed ingress is the only public listener. Nginx redirects port 80 to TLS
on 443, routes ordinary API and Admin paths to the selected Orchestrator, and
routes `/connector/` to the selected Connector. It denies public internal
control routes. Its worker listener is not host-published and its identity
listener is loopback-published only. Both private listeners forward
authorization headers to the service, which verifies the signed identity or
control request. The direct control target in the Host manifest is:

Nginx sets `client_max_body_size 64m` as the bounded proxy ceiling. This
preserves the legacy multipart route's 64 MiB total-body limit; the Admin
upload route keeps its existing 16 MiB application limit. Application handlers
continue enforcing their own limits after the proxy accepts the bounded body.

| Service | Blue | Green |
| --- | --- | --- |
| Orchestrator | `http://127.0.0.1:3302/api/internal/service-runtime` | `http://127.0.0.1:3303/api/internal/service-runtime` |
| Connector | `http://127.0.0.1:38080/internal/admin/runtime-control` | `http://127.0.0.1:38081/internal/admin/runtime-control` |

The fixed-ingress identity probe URLs are
`http://127.0.0.1:18081/orchestrator/identity` and
`http://127.0.0.1:18081/connector/identity`. The probe request must carry the
service-specific authorization required by the actual runtime endpoint.
These URLs prove which slot the fixed ingress serves; direct control URLs
prove each slot independently. Do not expose ports 8080, 8081, 3302, 3303,
38080, or 38081 on a non-loopback host interface.

Port 18081 is bound to host loopback, and Nginx's 8081 ACL allows loopback plus
the dedicated `172.30.0.0/24` control subnet. Docker may DNAT a host request to
the ingress container with a bridge-gateway source instead of `127.0.0.1`; the
subnet allow is intended to support that private path while service auth still
protects the endpoint. The Compose definition and ACL do not prove which source
address a particular Docker host presents. Before relying on the host probe,
the deployment verifier must observe the actual Nginx source address and
confirm it is loopback or within the pinned control subnet. A loopback port
binding by itself is not a successful identity-probe receipt.

The ingress configuration and selected-upstream include live under
`/etc/du/availability/ingress`. That directory contains only `nginx.conf` and
`selected-upstream.conf`; the ingress container mounts it read-only. Runtime
JSON, TLS private key, Host manifest, selector files, and executables live in
separate directories and are not visible to Nginx. Mount the TLS certificate
and private key separately, read-only, at the paths used in `nginx.conf`.

## Host manifest pins

The root-owned rollout manifest contains exactly one target for each of
`orchestrator`, `connector`, and `worker`. Each target has blue and green
entries with:

- distinct `projectName` values (`du-availability-blue` and
  `du-availability-green`), the stable service key, unique runtime identity,
  revision, and exact image digest;
- a release entry whose blue and green `composeFiles` each pin the common
  `compose/availability.yml` and that slot's rendered literal overlay by
  absolute path and lowercase SHA-256;
- for Orchestrator and Connector only, the direct loopback control URL,
  selector path, fixed-ingress identity URL, and the reload executable path and
  digest. Set `reloadExecutable` to the installed root-owned
  `/usr/local/sbin/reload-selector`, and use `reloadArgs` of
  `['--context','production','orchestrator']` or
  `['--context','production','connector']`;
- for Worker only, `workerBusinessId: 'document-core'`. The Worker target has
  no selector, HTTP probe, direct HTTP control URL, or reload executable.

Set the Host manifest's Docker binary to the same pinned `/usr/bin/docker`
used by `reload-selector`, and pin its digest and Docker context. The Host
manifest and overlays must be root-owned, non-writable by group/other, and
SHA-pinned by the service configuration. Initialize
`/etc/du/availability/selectors/orchestrator` and
`/etc/du/availability/selectors/connector` to the currently serving slot,
one exact line (`blue` or `green`). Initialize the selected-upstream include
to the same values. The manifest selector paths point to those selector
files; the Nginx include is generated from both selectors by the helper.

The Host rollout executor calls the helper with no shell and only the trusted
manifest arguments. The helper acquires one root-owned global lock before
reading either selector, so every rendered include uses one serialized
two-service snapshot. A concurrent helper exits with a retryable busy result;
the Host must retry only after resolving the current job state. The helper
validates both selector files, writes a complete replacement include to a
same-directory temporary file, atomically renames it, and tests Nginx's
configuration. A failed configuration test restores the old include. Signal
cancellation exits with the conventional signal status and runs cleanup once.
If the reload command loses its acknowledgement, the new include remains
selected and the job outcome is uncertain; a caller must observe the serving
identity and resolve the job rather than replaying the switch blindly. The helper's
`--render-only <root>` mode is read-only and used for offline validation; it
does not test Nginx or change selectors.

## Render, install, and start

1. Build and publish reviewed Orchestrator, Connector, Document Core, and
   Nginx images in the normal release pipeline. Record each image digest. Pin
   the same reviewed Nginx image digest in both slot overlays. This package
   does not build or publish images.
2. Provision the existing infrastructure and the three external networks.
   Install the protected per-slot runtime JSON files, TLS files, rendered
   overlays, ingress-only directory, selector files, executable, and Host
   manifest with the ownership and mode described above.
3. Review every rendered overlay as literal YAML. There must be no `${...}`
   Compose interpolation, `env_file`, `include`, or `build`; no `.env` file is
   read. Keep `COMPOSE_DISABLE_ENV_FILE=1` in the Host command environment.
4. Start the fixed ingress as a single edge project with the base file and one
   reviewed slot overlay (the ingress image and config are the same in both
   overlays), and the `edge` profile. Start each slot as its own project using
   the same base file, its own release overlay, and the `slot` profile. Use
   explicit project names and absolute compose file paths; do not use mutable
   project aliases or tags. The slot services are inactive in the edge project
   because only the `edge` profile is enabled. After installing complete
   literal files at the example paths below, the operator's commands have this
   shape:

   ```sh
   COMPOSE_DISABLE_ENV_FILE=1 docker compose --project-name du-availability-ingress --file /etc/du/availability/releases/availability.yml --file /etc/du/availability/releases/blue.yml --profile edge up --detach ingress
   COMPOSE_DISABLE_ENV_FILE=1 docker compose --project-name du-availability-blue --file /etc/du/availability/releases/availability.yml --file /etc/du/availability/releases/blue.yml --profile slot up --detach orchestrator connector document-core
   COMPOSE_DISABLE_ENV_FILE=1 docker compose --project-name du-availability-green --file /etc/du/availability/releases/availability.yml --file /etc/du/availability/releases/green.yml --profile slot up --detach orchestrator connector document-core
   ```

   The paths refer to the installed, root-owned files whose hashes appear in
   the Host manifest. The example overlay in this repository is intentionally
   invalid and must not be substituted for either installed release file.
5. Before accepting the service, obtain fresh signed runtime-control and
   fixed-ingress observations for both slots of Orchestrator and Connector,
   and real Worker lease/dispatch observations for both Worker identities.
   Confirm that all six observed image digests, revisions, identities, and
   slots match the manifest. The selector and health check alone are not proof
   that traffic is reaching the expected process.

The exact start commands belong to the deployment operator's reviewed
release procedure because the checked-in overlays are intentionally invalid.
Do not copy a placeholder command and treat it as a successful deployment.
Keep the base Compose project and public ingress alive while a candidate is
prepared. The normal Host maintenance job owns preview, cutover, serving
verification, drain, and finalization; Compose commands are for controlled
initial installation and recovery, not an alternate rollout API.

## Offline validation and limits

The owner test parses six actual targets with the repository's trusted rollout
schema, exercises the shipped selector renderer against temporary selector
files, rejects invalid selector values, and checks the package's private/public
topology and invalid example sentinels. Run it from
`orchestrator/services/orchestrator`:

```sh
node_modules/.bin/jest --config jest.unit.config.cjs --runInBand tests/orv15-ha-compose-package.test.ts
```

This test starts no service and invokes no Docker command. It does not prove
image availability, Nginx behavior, network ACLs, Compose merge semantics,
live identity, active-work counts, or an actual blue/green cutover. Those
remain separate deployment and independent Host verification requirements.
