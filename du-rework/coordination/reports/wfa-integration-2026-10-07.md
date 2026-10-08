# Workflow API integration — 2026-10-07

Status: OPEN. This receipt records integration checks, not full runtime acceptance. Scope: `du-rework` only. No commit, push or cutover.

## Active implementation

Three actual subagents (`gpt-6-luna`, reasoning `max`) are assigned API compatibility/admission, schema/runtime/named adapters, and independent isolated end-to-end verification. Ownership and acceptance gates are in [the WFA plan](../../tasks/WORKFLOW-API-BACKWARD-COMPAT-2026-10-07.md).

The user reiterated that implementation must continue with these subagents. The parent retained integration, lease decisions, API documentation and generated OpenAPI ownership.

## Parent verification

| Command | cwd | Runtime | Exit | Result |
| --- | --- | --- | --- | --- |
| `node node_modules/jest/bin/jest.js --runInBand tests/legacy-http-mount.test.ts tests/rv01-loopback-http-offline.test.ts` | `du-rework/orchestrator/services/orchestrator` | Node v24.21.0 | 0 | 2 suites, 77 passed, 0 failed, 0 skipped |
| `node node_modules/jest/bin/jest.js --runInBand tests/wfa-api-preflight.test.ts tests/wfa-api-lifecycle.test.ts tests/wfa-api-artifact-encryption.test.ts tests/legacy-http-mount.test.ts tests/rv01-loopback-http-offline.test.ts` | `du-rework/orchestrator/services/orchestrator` | Node v24.21.0 | 1 | Later integration checkpoint: 93 passed, 4 RV01 fixture failures (cancel/resume/bad resume/named admission returned 500); API owner retains this fixture lease and is correcting it without skipping assertions |
| `node node_modules/jest/bin/jest.js --runInBand tests/wfa-runtime-schema-catalog.test.ts tests/persistence-encryption-freeze.test.ts` | `du-rework/orchestrator/services/orchestrator` | Node v24.21.0 | 0 | 2 suites, 9 passed, 0 failed, 0 skipped |
| `node node_modules/jest/bin/jest.js --runInBand tests/wfa-runtime-progress.test.ts tests/mm10-heartbeat-cancel-offline.test.ts` | `du-rework/orchestrator/services/orchestrator` | Node v24.21.0 | 0 | 2 suites, 22 passed, 0 failed, 0 skipped |
| `node node_modules/jest/bin/jest.js --runInBand tests/br12-isolation-offline.test.ts tests/runtime-admin-auth.test.ts` | `du-rework/orchestrator/services/orchestrator` | Node v24.21.0 | 0 | 18 passed, 7 existing integration skips; skipped cases are not acceptance evidence |
| `node node_modules/jest/bin/jest.js --runInBand tests/wfa-runtime-progress.test.ts tests/runtime-hitl.test.ts tests/runtime-encryption-metadata.test.ts` | `du-rework/orchestrator/services/orchestrator` | Node v24.21.0 | 1 | First run: 117 passed, 1 stale slot-inventory failure, 7 existing integration skips. Failure retained here; new catalog slot was missing from expected inventory |
| `node node_modules/jest/bin/jest.js --runInBand tests/wfa-runtime-progress.test.ts tests/runtime-encryption-metadata.test.ts` | `du-rework/orchestrator/services/orchestrator` | Node v24.21.0 | 0 | After explicit catalog-slot inventory update: 118 passed, 0 failed, 0 skipped |
| `node node_modules/jest/bin/jest.js --runInBand tests/wfa-runtime-progress.test.ts tests/runtime-encryption-metadata.test.ts tests/runtime-lease-fencing-offline.test.ts` | `du-rework/orchestrator/services/orchestrator` | Node v24.21.0 | 0 | After workflow terminal progress correction: 151 passed, 0 failed, 0 skipped; backend typecheck also exit 0 |
| `node node_modules/jest/bin/jest.js --runInBand --silent` | `du-rework/orchestrator/packages/contracts` | Node v24.21.0 | 0 | 30 suites, 568 passed, 0 failed, 0 skipped |
| `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | `du-rework/orchestrator/services/orchestrator` | Node v24.21.0 | 0 | Backend typecheck passed at this checkpoint |
| `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | `du-rework/orchestrator/apps/admin-web` | Node v24.21.0 | 0 | Portal typecheck passed at this checkpoint |
| `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | `du-rework/businesses/document-core` | Node v24.21.0 | 1 | In-progress executor: missing egress dependency link and unfinished leaf/usage helper symbols. Runtime owner notified; not build acceptance |
| `node C:/nvm4w/nodejs/node_modules/corepack/dist/pnpm.js install --filter @du/document-core --offline --ignore-scripts --no-frozen-lockfile` | `du-rework` | Node v24.21.0 / pnpm 10.18.3 | 0 | Linked existing workspace egress package; lockfile diff is only three lines for that dependency, no registry version changes |
| `node businesses/document-core/node_modules/typescript/bin/tsc --noEmit -p businesses/document-core/tsconfig.json` | `du-rework` | Node v24.21.0 | 0 | Executor helper/dependency checkpoint compiles; runtime acceptance still independent |
| `node scripts/build-all.cjs` | `du-rework` | Node v24.21.0 / pnpm 10.18.3 | 0 | All 12 canonical packages/services built in 37.3 seconds; scoped Node24 pnpm shim used. Later owner changes still require final verification |
| `node node_modules/jest/bin/jest.js --runInBand tests/wfa-server-sealing.test.ts tests/enc-read-roundtrip-proof.test.ts` | `du-rework/orchestrator/packages/worker-sdk` | Node v24.21.0 | 0 | After correcting the test logger type: 6 passed. First run failed to compile the new test logger; production SDK typecheck was clean |
| `node node_modules/jest/bin/jest.js --runInBand tests/wfa-server-sealing.test.ts tests/crypto-seam.test.ts tests/artifact-read-metadata.test.ts tests/artifact-stat.test.ts tests/artifact-stream-bounds.test.ts tests/artifact-direct-band.test.ts` | `du-rework/orchestrator/packages/worker-sdk` | Node v24.21.0 | 1 | 147 passed, 2 failed: existing crypto port byte-fidelity assertion and direct-band residual external memory limit (11.69 MiB > 8 MiB). Both categories were already recorded in the preceding restructure verification; not skipped or presented as PASS |
| `node C:/nvm4w/nodejs/node_modules/corepack/dist/pnpm.js --filter @du/worker-sdk build` followed by `--filter @du/orchestrator build` | `du-rework` | Node v24.21.0 / pnpm 10.18.3 | 0 each | Both packages rebuilt after contracts/server-sealing negotiation change |
| `python du-rework/tools/openapi/gen_openapi.py` | repository root | Python; child Node on shell PATH | 0 | 60 paths; 0 paths/operations dropped; two workflow facade contracts added from guarded compat/decoder sources |
| `python du-rework/tools/openapi/validate_openapi.py` | repository root | Python; child Node on shell PATH | 0 | Workflow routes/auth/selectors/upload fields/202 poll header validated; canonical schemas/references and existing examples passed |

`docs/21-openapi.json` was regenerated; it was not hand-edited. The public API and parity documents explicitly distinguish implemented admission from pending runtime/end-to-end acceptance.

Generator and validator were rerun with Node v24.21.0 explicitly on PATH after the new facade spec was versioned as OpenAPI 1.5.0; both exited 0. A preceding repeated generation produced identical SHA-256 bytes with no path/operation loss. Client multipart examples use an environment variable for the API key and synthetic inputs only.

## Review decisions and outstanding gates

- Preserve legacy route parameters and map internally through shared submission, without redirects or loopback HTTP.
- Connector mapping uses an explicit immutable name-to-finite-slot map, not implicit sorted numbering or new wildcard grant semantics. Existing names retain assignments across schema revisions.
- URL node execution must use existing pinned egress with policy enforcement. Raw fetch fallback is prohibited.
- Partial upload failures require durable cleanup and ownership fences even before an artifact ID is returned.
- Workflow admission must require MetadataCrypto before uploads, including named processes; the historical generic submission plaintext fallback is not acceptable for this sensitive-data workflow path.
- Runtime owner is addressing raw schema bounds before recursive validation, aggregate node limits and connector-map integrity checks.
- Full named/schema execution, immutable pin, HITL/resume/restart/cancel, result projection, ten node adapters, source build and independent end-to-end evidence remain open until owner handoff and verification.
- Independent verifier has passed 20 admission/catalog/crypto tests against the production 1.1.0 manifest, including encrypted file ciphertext/sidecar readback and cleanup after a real admission race. A first encrypted cleanup run exposed a leaked sidecar; API owner corrected it and verifier retained the failing receipt before the passing rerun. This is not queue-to-worker completion evidence.
- Legacy resume body requires a server-resolved current wait adapter; API owner retains that host lease and is implementing it alongside the LC adapter.

Unrelated architecture-diagram edits in the shared worktree are outside this lease and remain untouched.

## Progress projection implementation

Runtime owner explicitly transferred the progress lease without pending edits. Parent replaced the no-op with a transactionally fenced root operation projection and passed the authenticated worker business ID from the runtime route. Valid reports update percent and a fixed non-secret stage label. Stale epochs, foreign businesses, expired leases and terminal tasks/operations refuse writes; child/cancelled work cannot overwrite root progress. Progress never changes execution completion timestamps or stores caller-supplied content messages. The focused tests cover these boundaries; real worker/poll evidence is still delegated to the independent verifier.

Legacy `completeWorkflow` clears the progress message and sets 100 at actual success. Parent added that workflow-only terminal projection to `completeTask`; running reports keep the static redacted stage label. Completion continues through the existing terminal transaction and timestamps rather than declaring success from a progress report.

## HITL resume correction

Independent live worker testing found that `resumeOperation` replaced the admitted task payload with only `{resumeInput,waitId}`, dropping the schema pin. Parent extended its runtime lease narrowly to preserve the original `schema-workflow` payload, opened with task/tenant AAD, then resealed with the answer and wait ID. Missing/corrupt original payload refuses the transaction; canonical non-schema resume behavior is unchanged. Backend typecheck passed; independent live rerun is required before marking this verified. Parent also took the narrow existing encryption metadata slot-inventory assertion so the new catalog slot is explicitly recognized.

## Artifact server-sealing negotiation

Independent worker stack evidence showed checkpoint replay parsing ciphertext. The configured SDK sealed bytes before an already-encrypting server upload proxy sealed them again; SDK reads did not reconstruct the discarded inner envelope. Parent added an explicit optional runtime upload-grant mode, `storageEncryption:'server'`, and SDK single-PUT negotiation. API owner mints it only with server encryption configured and server-mediated transport. Internal plaintext transit is permitted by the user's instruction; storage still requires ciphertext plus the server manifest. Missing negotiation keeps existing encryption checks; an unconfigured worker without positive server negotiation refuses writes. Tests verify server mode with and without a worker key, unchanged legacy client sealing, refusal without either mechanism, and rejection of unknown modes. This does not claim the older direct client-sealing read gap is universally fixed; the encrypted workflow deployment uses the negotiated server path.

Independent full HTTP/PG/outbox/Redis/production-worker control suite now passes 8/8 on Node24 after owner fixes, with raw receipt `tests/workflow-api/logs/schema-worker-full-after-owner-patches-node24-2026-10-07.log` (**historical receipt — superseded the same day; see the 2026-10-08 update below**). It covers input-only immutable pin/result/download, sequential HITL and parallel joins with encrypted artifacts, one-file doc-compare asynchronous failure, key fences, safe paused cancellation and encryption refusal. Actual named successful provider chains and all leaf-node cases remain separate acceptance work.

**[Evidence-pointer update, 2026-10-08 — F1 follow-up]** The 8/8 above was superseded the same day by fuller full-file runs: 10/10 → 11/11 ×2 → **13/13 ×3** (`full-after-muc3-run1/2/3-node24-2026-10-07.log`, 22:30–22:31); after the T26/T27 fail-first (22:58) the full file is RED on exactly those two tests. The `.log` files under `tests/workflow-api/logs/` exist locally but are outside Git (untracked tree; `du-rework/.gitignore:15` ignores `*.log`), so `.log` paths are not durable pointers — cite the run table in [wfa-qwen-handover-2026-10-07.md](wfa-qwen-handover-2026-10-07.md) §2–§3 and the audit [wfa-evidence-pointer-2026-10-08.md](wfa-evidence-pointer-2026-10-08.md).

## Named workflow resume integration checkpoint

Parent review found that named disbursement also needs its admitted files, variables and legacy marker after human review. Resume preservation now additionally applies only when the locked operation has a `workflows:` endpoint and its task action is `disbursement` or `doc-compare`. The decrypted original marker must match `legacy-workflow-named-input-v1` and the task action; missing or inconsistent markers refuse resume. The original payload is merged with the answer and resealed using the same task/tenant AAD. Canonical named actions retain their existing resume behavior. Independent successful disbursement pause/resume remains required.

After this change, from `du-rework/orchestrator/services/orchestrator` under Node v24.21.0, `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` exited 0 and `node node_modules/jest/bin/jest.js --runInBand tests/wfa-runtime-progress.test.ts tests/runtime-encryption-metadata.test.ts tests/runtime-lease-fencing-offline.test.ts` exited 0 with 3 suites and 151 tests passing, no failures/skips. These regressions do not substitute for the independent named workflow execution test.

API owner reports its corrected RV01 fixture plus four API suites passing 67/67 on Node24, exit 0. The preceding four failing results remain recorded above; the owner receipt supplies the exact rerun evidence. Parent requested an additional archive-compression guard: check aggregate bytes and entry count before retaining every authorized artifact, including nested source-ref branches, rather than waiting until all reads finish.
