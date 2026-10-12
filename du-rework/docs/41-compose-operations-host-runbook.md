# Compose operations host runner runbook

This runbook configures the dedicated host process that publishes Docker Compose observations and executes approved application-service jobs for one configured host and project. The Orchestrator web process does not receive Docker access. The runner authenticates with the internal host API using its dedicated host token; remote API URLs must use HTTPS. Plain HTTP is accepted only for loopback development.

The runner reads a root-owned manifest and root-owned pinned Compose/env files, starts only commands assembled from that manifest, and keeps its journal and lock in a separate service-user-owned directory. Run one runner instance per project. Give its service account only the Docker access required for the approved host. Do not expose the Docker socket to the web application.

## Supported operations and limits

The runner supports inventory, applying an approved release, rolling back to an approved release, and restarting an allowlisted application service. Apply and rollback use the fixed Compose command `up -d --no-build --pull never --no-deps <approved services>`. Restart uses a fixed service identifier and timeout. The caller cannot provide a shell command, image, path, Docker option, environment value, database/storage service, or arbitrary Compose project.

The runner does not run database migrations, change persistent data, or stop/remove/prune containers. Release compatibility is an operator attestation in the trusted manifest; it is not a migration executor or a database rollback guarantee. A Docker timeout or lost acknowledgement can leave a partially changed host. The runner records that state as uncertain and requires explicit reconciliation after the executor is quiescent. A `RECONCILED` result confirms that an operator reconciled the observed state; it does not claim that the requested command succeeded.

Operational bounds are deliberately finite: 64 containers per inventory; 256 KiB captured output per Docker process; 20 seconds per inventory/inspect process; 120 seconds for apply/rollback; 60 seconds for restart; 60 seconds of apply readiness observation and 30 seconds for restart readiness. The process receives a clean fixed environment, not the service manager's inherited Docker or Compose context. It sets `COMPOSE_DISABLE_ENV_FILE=1` to block implicit loading of a working-directory `.env`; a manifest-pinned `envFile` is still passed explicitly with `--env-file`. Verify both behaviors with the actual Compose V2 version in the isolated fixture before deployment. The API body limit is 256 KiB. The fsynced JSONL journal is capped at 10 MiB with 128 KiB records; on a full or invalid journal the runner fails closed. Preserve the journal for investigation; do not truncate it to make the runner resume.

Inventory obtains container fields through `docker container inspect` and repository digests through a separate `docker image inspect` of the selected image IDs. The runner does not read container environment, mounts, or logs. An observed release ID is reported only when the complete application-service image vector uniquely identifies one catalog release. Releases that differ only in configuration can remain unattributed, and may not be eligible as a rollback source.

## Prepare the trusted host files

Use Linux with Docker Engine and the Compose V2 CLI plugin installed and available to the runner account. Preload every image referenced by each release; apply disables image pulls and builds. Validate the exact Engine and Compose plugin versions on the target host and record them with the deployment. The runner relies on the Docker CLI JSON output forms for the installed Compose V2 version and `COMPOSE_DISABLE_ENV_FILE` support. The disposable independent verification fixture should record the actual versions used and verify that implicit `.env` is ignored while an explicit pinned `--env-file` is honored; no production stack should be used for that test.

Create root-controlled directories for the manifest, the pinned Compose files, the optional interpolation env file, the Docker binary/configuration, the Docker context, and the Compose project working directory. These paths must be canonical absolute paths without symlinks. The manifest, every pinned file, and each file's immediate parent directory must be owned by root and not group- or world-writable. The Docker binary and its immediate parent, plus the working, HOME, and Docker configuration directories, must also be root-owned and not group- or world-writable. The runner account must be able to read pinned files and execute the Docker binary.

The manifest pins every inventory/release Compose file and optional `envFile` by SHA-256. Pin the full image repository digest in each release, for example `registry.example/team/web@sha256:<64 lowercase hex characters>`, and make the Compose release file use that same digest. `envFile` is optional. If used, it is a trusted root-owned file and can contain Compose interpolation values; do not put its contents in the manifest, command-line arguments, receipts, or logs. The runner verifies the manifest's deployment digest and rechecks file ownership and hashes before execution.

The following is a schema example. Replace every `REPLACE_...` marker, including all hashes and image digests, with real values before installation. Hash the final file bytes only after all edits. `projectId` must match Docker Compose project-name syntax: start with a lowercase letter or digit, followed by lowercase letters, digits, `_`, or `-` (up to 64 characters). The `rollbackAllowedFrom` list on a release names the source release IDs from which that release may be applied as a rollback.

```json
{
  "schemaVersion": 1,
  "hostId": "host-a",
  "projectId": "app-stack",
  "displayName": "Application stack",
  "dockerBinary": "/usr/bin/docker",
  "dockerContext": "default",
  "workingDirectory": "/srv/app-stack",
  "homeDirectory": "/etc/compose-runner/home",
  "dockerConfigDirectory": "/etc/compose-runner/docker-config",
  "inventoryComposeFiles": [
    { "path": "/srv/app-stack/compose-inventory.yaml", "sha256": "REPLACE_WITH_64_LOWERCASE_HEX_CHARACTERS" }
  ],
  "envFile": { "path": "/etc/compose-runner/app.env", "sha256": "REPLACE_WITH_64_LOWERCASE_HEX_CHARACTERS" },
  "applicationServices": [
    { "serviceId": "api", "label": "API" },
    { "serviceId": "web", "label": "Web" }
  ],
  "releases": [
    {
      "releaseId": "release-2026-10-11",
      "label": "Release 2026-10-11",
      "composeFiles": [
        { "path": "/srv/app-stack/releases/2026-10-11/compose.yaml", "sha256": "REPLACE_WITH_64_LOWERCASE_HEX_CHARACTERS" }
      ],
      "serviceIds": ["api", "web"],
      "imageDigests": {
        "api": "registry.example.invalid/acme/api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "web": "registry.example.invalid/acme/web@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      },
      "migrationCompatibility": "acknowledged",
      "rollbackAllowedFrom": []
    },
    {
      "releaseId": "release-2026-10-04",
      "label": "Release 2026-10-04",
      "composeFiles": [
        { "path": "/srv/app-stack/releases/2026-10-04/compose.yaml", "sha256": "REPLACE_WITH_64_LOWERCASE_HEX_CHARACTERS" }
      ],
      "serviceIds": ["api", "web"],
      "imageDigests": {
        "api": "registry.example.invalid/acme/api@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        "web": "registry.example.invalid/acme/web@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
      },
      "migrationCompatibility": "acknowledged",
      "rollbackAllowedFrom": ["release-2026-10-11"]
    }
  ]
}
```

`inventoryComposeFiles` is the trusted Compose project definition used to enumerate running services and restart a single service. Release-specific files are used only for the selected release. The app service allowlist must exclude databases, storage, and other persistent infrastructure. Each release has one pinned image digest for each service it targets. Keep `applicationServices`, Compose service names, release IDs, and backend catalog configuration aligned.

## Configure and start the runner

Install the existing Orchestrator build artifact on the host with Node.js 24 or the version specified by the deployment. The runner entry point is `orchestrator/services/orchestrator/dist/compose-operations-runner-cli.js`. Build it through the repository's normal build pipeline; do not build on a host with access to a live stack merely to test the runner.

### Orchestrator server configuration

Configure these three variables on the Orchestrator server process. All three may be absent, which disables Compose operations; a partial configuration fails boot validation. The runner process must use the same host ID, token, and manifest digest as the server:

```text
COMPOSE_OPERATIONS_HOST_ID=host-a
COMPOSE_OPERATIONS_RUNNER_TOKEN=<dedicated host runner token>
COMPOSE_OPERATIONS_MANIFEST_DIGEST=<lowercase SHA-256 of the host manifest>
```

The server accepts a host ID matching `[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}`, a token of 32–512 characters, and a 64-character lowercase hexadecimal SHA-256 digest. The runner accepts the token only if it uses base64url characters (`A-Z`, `a-z`, `0-9`, `_`, `-`) and is 32–512 characters, so use a token meeting both validators. The token must be distinct from `ADMIN_TOKEN`, `RUNTIME_TOKEN`, `USAGE_TOKEN`, tenant-admin tokens, and worker identity tokens. The service schema's non-environment defaults are a 60-second maximum sample age, a 120-second preview lifetime, and a 60-second claim lifetime; these values are not server environment overrides. After a job receives its durable running acknowledgement, the server uses a fixed five-minute execution lease.

### Host runner service configuration

Set the runner variables in the host service manager's protected configuration. The runner token is secret material; do not place it in a command argument, source file, manifest, report, or shell history. `COMPOSE_OPERATIONS_HOST_ID` and `hostId` in the manifest must exactly match the server. `COMPOSE_OPERATIONS_MANIFEST_DIGEST` is the lowercase SHA-256 of the final manifest file and must match the server configuration. The local journal and lock paths must be absolute paths under a dedicated parent directory owned by the runner service account, mode `0700`; the journal is created with mode `0600` and the lock files/directories remain private. This writable state directory must be separate from all root-owned configuration paths.

Required variables:

```text
COMPOSE_OPERATIONS_RUNNER_BASE_URL=https://orchestrator.example.invalid
COMPOSE_OPERATIONS_HOST_ID=host-a
COMPOSE_OPERATIONS_RUNNER_TOKEN=<dedicated host runner token>
COMPOSE_OPERATIONS_MANIFEST_PATH=/etc/compose-runner/manifest.json
COMPOSE_OPERATIONS_MANIFEST_DIGEST=<sha256 of final manifest, 64 lowercase hex characters>
COMPOSE_OPERATIONS_JOURNAL_PATH=/var/lib/compose-runner/journal.jsonl
COMPOSE_OPERATIONS_LOCK_PATH=/var/lib/compose-runner/project.lock
COMPOSE_OPERATIONS_RUNNER_POLL_MS=5000
```

`COMPOSE_OPERATIONS_RUNNER_POLL_MS` is optional and must be an integer from 1000 through 60000; the default is 5000 ms. `COMPOSE_OPERATIONS_HOST_ID`, `COMPOSE_OPERATIONS_RUNNER_TOKEN`, and `COMPOSE_OPERATIONS_MANIFEST_DIGEST` are shared identity/authentication values and must match exactly on both processes. The runner accepts a plain HTTP API URL only for `localhost`, `127.0.0.1`, or `::1`; use HTTPS for every remote host. Redirects are rejected. The host token authenticates only the internal runner API.

Before enabling a service, verify the installed CLI and Compose plugin versions, the selected Docker context, file hashes, manifest digest, token scope, and service allowlist. Then run the standalone CLI as the service account. A first normal cycle publishes the catalog and an actual snapshot before attempting to claim work. Confirm that the server reports the host/project online with the expected release catalog before accepting operator jobs.

## CLI modes

Run one bounded cycle:

```sh
node orchestrator/services/orchestrator/dist/compose-operations-runner-cli.js --once
```

`--once` still publishes a fresh snapshot and may claim and execute one queued job. Use it only when that outcome is intended. It exits after that cycle and is useful for a controlled initial check with no queued jobs.

Run the supervised polling loop with no arguments:

```sh
node orchestrator/services/orchestrator/dist/compose-operations-runner-cli.js
```

Use a service manager to restart the process after an ordinary process exit, while retaining the journal and lock directory. The runner records and refuses to replay a command whose start or outcome is uncertain. Keep only one active runner for a host/project. Safe error output contains a fixed code; Docker output, file contents, tokens, and environment values are not emitted.

## Recover an uncertain operation

An operation can become `UNKNOWN` after a timeout, process interruption, lost start acknowledgement, invalid/oversized Docker output, or unavailable observation. Do not rerun the requested operation to recover it. First allow any journaled Docker process to exit, inspect the host using normal host administration, and confirm no executor process from that job can still change the stack. Preserve the journal and collect the current state through the configured Docker context.

The runner's reconciliation path requires the server to report the exact job as `UNKNOWN` at the supplied current state version. It takes two real observations at least three seconds apart and requires the observations to be stable. The operator must then explicitly attest quiescence with the CLI flag. Example:

```sh
node orchestrator/services/orchestrator/dist/compose-operations-runner-cli.js \
  --reconcile <job-uuid> --state-version <current-server-state-version> --confirm-quiescent
```

Obtain the state version from the authorized operations view or host-scoped runner status. Reconciliation posts observed state and marks the job `RECONCILED`; it never executes the saved host command. If the acknowledgement is lost, rerun the same reconciliation invocation so the runner can replay the exact saved report and retrieve the acknowledgement. Do not delete, edit, or truncate the pending journal records. A rejected or uncertain report remains fenced for investigation.

Keep the host runner and its configuration under normal change control. Any manifest, file hash, image digest, host ID, or backend digest change requires a coordinated server configuration update and a new manifest digest before the runner can publish or execute. No production mutation is part of this runbook; test the complete flow only against an isolated disposable Compose fixture and record its actual Docker Engine and Compose V2 versions.
