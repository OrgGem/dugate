# UI13-COMPOSE-HOST implementation receipt

Product source and owner checks were refrozen on 2026-10-11 after the independent disposable fixture exposed an inventory failure in the host executor. The product-source change is limited to the inspect template/parser in `host-executor.ts` and a regression in the uniquely named owner test; manifest, runner, CLI, UI, and backend DTOs remain unchanged. No production or pre-existing stack was used by the owner, no build or `dist` artifact was produced by the owner, and no commit, push, or deployment was performed.

Implementation details and host setup are in [the Compose operations host runner runbook](../../docs/41-compose-operations-host-runbook.md). The manifest schema uses `schemaVersion`, `hostId`, `projectId`, `displayName`, `dockerBinary`, `dockerContext`, `workingDirectory`, `homeDirectory`, `dockerConfigDirectory`, pinned `inventoryComposeFiles`, optional pinned `envFile`, `applicationServices`, and `releases`. `projectId` is restricted to lowercase Docker Compose project-name syntax. Releases bind pinned Compose files and the exact service/image-digest vector, carry `migrationCompatibility: "acknowledged"`, and enumerate `rollbackAllowedFrom` IDs. The strict schema rejects additional properties. The clean Docker environment sets `COMPOSE_DISABLE_ENV_FILE=1` so implicit working-directory `.env` loading is disabled; an explicit root-pinned `--env-file` remains in the fixed arguments.

The server process and host runner must share `COMPOSE_OPERATIONS_HOST_ID`, `COMPOSE_OPERATIONS_RUNNER_TOKEN`, and `COMPOSE_OPERATIONS_MANIFEST_DIGEST`; the three are all-or-none on the server. Server validation requires a host ID matching `[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}`, a 32–512-character token, and a 64-character lowercase hex digest. The runner uses a stricter base64url token subset. Server service defaults are 60 seconds maximum sample age, 120 seconds preview lifetime, and 60 seconds claim lifetime. The runner additionally uses `COMPOSE_OPERATIONS_RUNNER_BASE_URL`, `COMPOSE_OPERATIONS_MANIFEST_PATH`, `COMPOSE_OPERATIONS_JOURNAL_PATH`, and `COMPOSE_OPERATIONS_LOCK_PATH`; optional `COMPOSE_OPERATIONS_RUNNER_POLL_MS` is bounded to 1000–60000 ms. Remote API URLs require HTTPS; only loopback accepts HTTP. The service-user journal/lock directory is separate from root-owned configuration. The CLI accepts no arguments for its supervised loop, `--once` for one bounded cycle (which can claim and execute one queued job), and `--reconcile <job-uuid> --state-version <version> --confirm-quiescent` for operator-confirmed reconciliation.

The runner derives fixed Docker argv from trusted manifest data and launches with `shell: false`, a bounded clean environment, bounded output, and command/readiness timeouts. It inventories app containers using selected `docker container inspect` fields and separately asks `docker image inspect` for actual `RepoDigests`. Apply/rollback are app-only `up -d --no-build --pull never --no-deps`; restart is limited to one allowlisted app service. It journals process start/exit and durable request/ack state, retries reports without replaying the Docker command, and requires a fresh host sample before starting a claimed job. Lost or uncertain start acknowledgements do not start the command. Completion and reconciliation retries use the retained exact request; an old completion is superseded only after reconciliation acknowledgement.

## Actual fixture finding and targeted correction

The independent disposable fixture on Docker Engine 28.4.0 / Compose 2.40.3 successfully applied the pinned release and created four running app replicas, but the runner then reported `UNKNOWN` with `INVENTORY_UNAVAILABLE`. The previous inspect template accessed `.State.Health` directly; the fixture's no-healthcheck containers omit that map key and Docker exited 1 with `map has no entry for key "Health"`. The exact failure and sanitized fixed-format probes are retained in [the fixture diagnostic](../../reports/raw/orv13-vfy-compose-host/compose-apply-a-lost-ack-diagnostic.json).

The corrected template uses `{{with index .State "Health"}}{{.Status}}{{end}}`, which the fixture tested against the four replicas with no healthcheck. It exited 0 and emitted the expected six tab-separated fields with an empty final health field. The previous parser's global `.trim()` removed the last row's trailing tab, reducing that row to five fields. The parser now removes only a terminal line separator, preserves the empty field, and continues to require the exact row count and six fields per row. Empty or `none` health maps to `NONE`. The owner regression covers multiple rows and a final empty health field. The full host-chain rerun using the rebuilt runner remains pending; the first apply's `UNKNOWN` result is not represented as success.

## Owner verification

Focused owner test:

```text
PATH=/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin:/workspace/scratch/orv11-toolchain/node_modules/.bin:$PATH pnpm --filter @du/orchestrator exec jest --runInBand --config jest.unit.config.cjs tests/orv13-compose-host-owner.test.ts
PASS tests/orv13-compose-host-owner.test.ts
Tests: 12 passed, 12 total
```

Orchestrator typecheck:

```text
PATH=/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin:/workspace/scratch/orv11-toolchain/node_modules/.bin:$PATH pnpm --filter @du/orchestrator typecheck
tsc --noEmit -p tsconfig.json
exit 0
```

The focused tests cover Compose project-name validation (including rejection of uppercase and dot), implicit `.env` disablement and inherited override exclusion while retaining explicit pinned `--env-file`, fixed argv and caller-input rejection, safe inspect fields and real image digest lookup, multiple no-healthcheck inspect rows including a final empty health field, unique full-vector release inference, action bounds and redaction, output-limit uncertainty, private fsynced journal and single-runner lock, lost start acknowledgement with no command spawn, exact pending-completion retry without action replay, server-UNKNOWN gating, stable/quiescent reconciliation, exact lost-reconcile-ack replay, and completion supersession only after accepted reconciliation. Raw owner outputs are retained at [owner-jest.log](raw/orv13-compose-host/owner-jest.log) and [owner-typecheck.log](raw/orv13-compose-host/owner-typecheck.log).

The owner Jest suite and typecheck do not exercise a real Docker daemon. The independent fixture has validated the new fixed inspect template against four actual no-healthcheck containers on Engine 28.4.0 / Compose 2.40.3, but the full host chain using the rebuilt runner has not yet been rerun. The fixture's first apply correctly remains `UNKNOWN`; no action replay is authorized from this receipt. The `COMPOSE_DISABLE_ENV_FILE=1` behavior while preserving explicit pinned `--env-file` still requires its independent fixture evidence. Reconciliation's stable observations are a bounded sample; `--confirm-quiescent` remains an operator attestation and cannot prove that an external actor will not change the stack later. `RECONCILED` confirms recovery of the observed job state, not command success. A full or corrupt journal fails closed and has no automatic compaction path.

## Frozen source hashes

SHA-256 hashes of the frozen product source and owner test, followed by the final runbook version:

```text
db889d8bce867847f9e3151e8766ab961d5e9c2384821fc9856b1e4afdea4f57  orchestrator/services/orchestrator/src/modules/compose-operations/manifest.ts
e086ff4213652ba349105a1d633ad1eda9315940b4af7acc41cb064bee10af52  orchestrator/services/orchestrator/src/modules/compose-operations/host-executor.ts
9d3761025d659d496d3def6fa9afdfe524cf3b4805c05a63f058c58fa555d7ca  orchestrator/services/orchestrator/src/modules/compose-operations/runner.ts
3f7933288169f5c1dc1e4800e99b603c1d7679fea6b370cad3a735cc6b141d25  orchestrator/services/orchestrator/src/compose-operations-runner-cli.ts
65e1bd92894245d913c9d4d1c0912da4dab13433949d2a9c258fd3d8727d6514  orchestrator/services/orchestrator/tests/orv13-compose-host-owner.test.ts
3808948924f1d8200ec613011183e4c36ddfa975661dd7a36e172b8dc79fed2f  docs/41-compose-operations-host-runbook.md
```
