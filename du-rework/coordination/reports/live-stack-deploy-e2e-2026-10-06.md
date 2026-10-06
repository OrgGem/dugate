# LIVE-STACK-DEPLOY-E2E — 2026-10-06

## Verdict

**Deployment/startup: PASS with a serialized-build retry. End-to-end document processing: FAIL. PM-M02 acceptance remains open.** The isolated Postgres/Valkey/Orchestrator/Connector/worker stack migrated and stayed healthy, and the PM-M02 verifier passed its Compose/listener/worker-auth fences; however, the host-port probe failed because an unrelated nginx-ui container already owns host port 8080. Both public ingest and extract requests received 202 ACCEPTED, then their BullMQ tasks failed with HANDLER_ERROR before the first checkpoint, so neither returned a completed result.

No product source or test file was edited, no commit was created, and no checklist was ticked. Results are from the existing shared worktree, not a clean checkout: HEAD was b088eececcb5f3df0b4edbe073a29401dafda624 and git status already contained extensive unrelated/pre-existing changes. A 1,286-file source/test/Compose inventory was identical before and after this run (zero changed/added/removed rows).

## Environment

- Repository: D:\Git\dugate\du-rework; commit HEAD: b088eececcb5f3df0b4edbe073a29401dafda624.
- Docker Engine 28.5.1, Compose 2.40.3-desktop.1, Node v22.16.0, pnpm 10.18.3.
- Isolated project: pm-m02-verify-20261006-887.
- A fresh local .env.docker was generated with scripts/docker/init-env.cjs. Its host mappings were set to 3300/3301 because existing Node processes occupy 3000/3001. Secret values were not printed or written to evidence.
- Compose image set includes PostgreSQL 16, Valkey 8, Orchestrator, Connector, and three business workers. This Compose stack does not include MinIO, Vault, or an external model provider; the disposable env selected PostgreSQL artifact storage.
- No separate network client was available for the checklist’s external firewall probe.

## Preflight and deployment results

| Check | Result | Literal exit / counts |
|---|---|---|
| PM-M02 route suite: pnpm --filter @du/orchestrator run test --runTestsByPath tests/pm-m02-ingress-fence.test.ts tests/pm-m02-ingress-verification.test.ts | 1 suite passed, 1 skipped; 5 tests passed, 0 failed, 14 skipped / 19 total | exit 0 |
| Orchestrator typecheck: pnpm --filter @du/orchestrator run typecheck | No diagnostics | exit 0 |
| Orchestrator build: pnpm --filter @du/orchestrator run build | Passed; Admin Web Vite emitted a >500 kB chunk-size warning | exit 0 |
| Config-only PM-M02 verifier | Default Compose contract, 0.0.0.0 widened-bind fence, and config-only checks passed | exit 0 |
| First requested up --build | BuildKit concurrent export race: migrate and orchestrator target the same du-orchestrator:local image; one export reported image already exists | exit 1 |
| Serialized retry: docker compose --parallel 1 ... up -d --build | Images built; migration completed; isolated stack started | exit 0 |
| Migration | Container state Exited (0) | exit 0 |

The retry constrained Compose build parallelism only; it made no source or Compose edits. The first failure and successful retry are both preserved in raw evidence.

After startup, all eight Compose services were present. PostgreSQL, Valkey, Connector, and Orchestrator had healthy Docker healthchecks; all three workers were running and passed their authenticated internal Runtime heartbeat/public-fence probes. Workers have no Docker healthcheck, so “healthy” is not claimed for their container health status. After both E2E failures, the four healthchecked services remained healthy, all workers remained running, and every running container had restart count 0. The public host health endpoint returned HTTP 200 with DB=true and Redis=true.

## Full PM-M02 verifier

The full verifier emitted 7 PASS checks for effective Compose config, widened binds, both Orchestrator listeners, no project host bindings on 3002/8080, and authenticated Runtime/public-route probes from document-core, lc-checker, and example-review. It then returned **exit 1** at the host TCP reachability check: host 127.0.0.1:8080 accepted a connection. Docker inspection showed this belongs to the pre-existing nginx-ui container mapping 0.0.0.0:8080→80; the test project itself has no 8080 host binding. The host 3000/3001 collisions were avoided with the isolated 3300/3301 mappings. This is an environment collision, not evidence that the test project published Connector port 8080; the full verifier remains failed and cannot be accepted as PASS.

## Live Input/Output E2E

Test setup used the disposable database only: the document-core 1.0.0 manifest was registered and activated through the internal runtime/admin APIs, and a tenant plus one-time API key were created for synthetic traffic. The credential was held in process memory and never printed or saved. Public requests were sent through host-mapped Orchestrator port 3300.

| Flow | Submit | Worker/task result | Checkpoints / result |
|---|---|---|---|
| ingest, inline parse fixture | HTTP 202 ACCEPTED, operation 44059d94-d371-4eda-9dce-55ad1e0427e7 | FAILED, error_code HANDLER_ERROR; worker log shows task d6c4ff18-d273-4d5d-8dee-9d254fec06cb | 1 task, 0 step checkpoints; no completed result, download, or idempotency replay |
| extract, invoice fixture | HTTP 202 ACCEPTED, operation ed836f95-0b79-46b4-b6d9-15096a9ff77f | FAILED, error_code HANDLER_ERROR; worker log shows task dfe92d9a-1117-42fa-92ef-cdb820820259 | 1 task, 0 step checkpoints; no completed result |

These requests demonstrate public listener admission and worker consumption through the job queue, but they do **not** demonstrate successful input-to-output processing. The failure is reproducible across both action types, before any recorded step checkpoint; the current worker logs expose only HANDLER_ERROR, so the underlying exception is unresolved. Connector revision/profile-binding counts were both zero before extract. Since the extract task failed before its first checkpoint, available evidence does not establish that it reached inference or that missing provider configuration caused the error.

## Offline-provable vs live-only

Offline-provable checks passed: the focused ingress Jest assertions (5 pass; 14 live-gated skips remain skips), Orchestrator typecheck/build, Compose config contract, and unchanged source/test inventory.

Live-local evidence includes the isolated Postgres/Valkey migration and health, running Orchestrator/Connector/workers, real host-mapped public submissions, worker consumption, and observed HANDLER_ERROR outcomes. The live stack did not yield a successful result, checkpoint, artifact download, or replay.

Still live-only/open: a genuinely separate-client firewall probe; PM-M02 acceptance after resolving the host port 8080 collision; a successful ingest/extract result flow; extraction with a configured provider; MinIO/Vault integration (not present in this Compose project). The failed worker handler is the main functional blocker and requires owner investigation before shipping.

## Cleanup and evidence

Per checklist cleanup, docker compose --env-file .env.docker --project-name pm-m02-verify-20261006-887 -f docker-compose.yml down completed with exit 0. A post-cleanup compose ps --all returned exit 0 and no project containers; exactly two project volumes (pgdata and valkeydata) remain. The unrelated nginx-ui container remains running on port 8080. No volumes were deleted, and no global prune or unrelated project stop was performed.

Raw command output, literal exit files, E2E summaries, operation diagnostics, worker errors, versions, key-file hashes, and source/test manifests are in [raw evidence](raw/live-stack-deploy-e2e-2026-10-06/). The bundle inventory is [SHA256SUMS.txt](raw/live-stack-deploy-e2e-2026-10-06/SHA256SUMS.txt); source/test inventory comparison is [source-inventory-diff.txt](raw/live-stack-deploy-e2e-2026-10-06/source-inventory-diff.txt).
## Follow-up live Extract window - arch-phase-b-20261006

This follow-up is scoped to the isolated project `arch-phase-b-20261006`; it does not rewrite the historical `pm-m02-verify-20261006-887` results above. The Coordinator previously reported Ingest PASS on this arch-phase-b namespace; this harness independently completed the blocked Extract path.

- Live command: `node coordination/reports/raw/phase-b-extract-resume-prep-2026-10-06/prepare-and-run-extract.cjs --run-live` with `ARCH_PROJECT_NAME=arch-phase-b-20261006`; literal process exit code: **0**.
- The harness created a disposable `json-http` Connector revision and bound the document-core Extract action at the `reasoning` slot. Public Extract submission returned HTTP 202 and operation `3191692e-ff4b-479d-9b7b-686e530ba45b` reached `SUCCEEDED`.
- Database evidence from the harness used a read-only transaction: 1 task, 3 checkpoints, terminal state `SUCCEEDED`, no error code. The isolated mock provider recorded exactly 1 call.
- Public `/result` returned HTTP 200, schema version 1, an opaque artifact reference, and a matching output artifact descriptor. Fetching its download URL returned HTTP 200; the downloaded output contained fixture invoice number `INV-ARCH-PHASE-B-MOCK-001` and total `4250`.
- Cleanup completed: temporary API key revoked, temporary Connector revision disabled, mock sidecar stopped and removed, and Connector recreated from base Compose config. The project stack remains up: Connector, Orchestrator, PostgreSQL, and Valkey report healthy; document-core, lc-checker, and example-review are running; migration exited 0. Final `docker compose ps --all --format json` exit code: 0.
- The project database and volumes were preserved. The fixture credential is synthetic and encrypted; its Connector revision is disabled, and the temporary API key is revoked.

An earlier harness trial also completed the worker operation successfully (operation `85905084-47bb-4306-863f-461443e9b579`, 1 task, 3 checkpoints, 1 provider call), but returned a harness FAIL because it incorrectly expected fixture values in `/result` instead of following the opaque artifact reference to the download endpoint. The harness assertion was corrected to validate the reference and download; the later run above is the final passing evidence. An intermediate parser syntax failure occurred before creating another operation.

Offline-provable: harness/provider JavaScript syntax checks and Compose overlay validation had passed before the live window. Live-only: service-to-service routing, Connector credential/probe path, admin profile binding, BullMQ worker execution, database checkpoints, public result delivery, and artifact download described above. This follow-up does not rerun the separate PM-M02 host-port verifier; its prior 8080 collision finding remains scoped to that other project.

No product source or test files were edited in this follow-up. The harness correction and sanitized live summary are under `coordination/reports/raw/phase-b-extract-resume-prep-2026-10-06/`; no raw key or credential value was recorded.

SHA-256 evidence:
- harness: `ed11d9ad58d4d722de02e3627736dca2f8f6c2ae25f4b95d8a88cf2df95c13b3` (`prepare-and-run-extract.cjs`)
- mock provider: `b224ade234e3e70b805d72907827524d42536a80c570f4fabbc2b25d0df55a8a` (`mock-provider.cjs`)
- Compose overlay: `06c7616c288ade752f3aabcea548ab946417b70906b32b22ce8250d877415eea` (`extract-mock-provider.compose.yml`)
- final sanitized run summary: `842654cb8a95dbcd7c9bbe979ee18d7491b12ee5f378dc97c57ee892b7484eff` (`run-summary.json`)
