# ORV11-OPS owner receipt — 2026-10-11

Status: IMPLEMENTED; independent reviewer acceptance pending. Base HEAD 7e36a1e. No commits/push; legacy root read-only.

## Contract and implementation

- Public operation surface: API-key authenticated GET `/api/v1/operations/:id` and GET `/api/v1/operations/:id/download` only. Legacy wire/encryption preserved through compat owner. Public list/metrics/result/cancel/resume/retry/delete are rejected before compat fallback. Admin bearer does not regain retired routes.
- Internal canonical surface `/api/internal/operations`: GET list/metrics/detail/result/download, POST cancel/resume/retry, DELETE terminal operation. Requires internal ingress plus admin bearer or validated server session. Tenant selection uses principal; tenant operators cannot widen scope. Cookie mutations require CSRF; viewers cannot mutate; retry platform-admin-only. Controls delegate actual transactional audited dispatcher with URL-selected operation ID; no route/path auth spoofing.
- DELETE is terminal-only soft-delete, tenant fence and audit within one DB transaction. Retained internal metadata permits audit history. Public compatibility hides deleted rows.
- BFF and server-side section fetchers use internal URLs; BFF adds resume, DELETE, attachment download streaming. Existing `/admin/api/operations` browser URLs retained. Duplicate worker-inventory early relay removed because it shadowed platform-admin authorization; regression found by existing BFF suite now passes.
- Internal detail carries tenant-fenced `humanWaits` and `operation.stateVersion`, supporting HITL CAS. Admin links use internal canonical URLs; public submission `links.result` points at retained legacy result-by-ID.
- Retry preserves endpoint slug, pipeline/schema marker and output format while creating new execution (old results/progress not copied).
- Public artifact download now requires the same API key as a live, non-deleted successful owner/reference operation; both output and input-reference query branches fenced. Independent real-HTTP regression requested from verification owner.
- OpenAPI generated from updated generator, both JSON copies written by generator. Internal operations admin/session security and internal origin; public ID/download legacy security. Four obsolete paths explicitly retired; all other undocumented drops still fail. Existing generator drift repaired: from/to list params, incorrect TypeScript resolution path in secrets-route probe.

## Owner smoke

CWD `/workspace/dugate/du-rework/orchestrator`; Node v24.21.0, pnpm10.18.3 via `/workspace/scratch/orv11-toolchain`. Final run 2026-10-11 UTC. Source mutable shared workspace, base commit as above.

1. `pnpm --filter @du/orchestrator exec jest --runInBand tests/orv11-operation-detail.test.ts tests/orv11-operations-routes.test.ts tests/aweb06-bff-operations.test.ts tests/aweb-16b-overview-metrics-offline.test.ts tests/admin-operations-sort-http-offline.test.ts tests/pm-m02-ingress-fence.test.ts tests/or10-04-retry-workflow-schema.test.ts tests/cb02c-retry-callback-pin.test.ts` — exit0; 8 suites PASS, 86 tests passed, 0 failed, 6 skipped (PM-M02 live tests require explicit infra flag). Raw: `raw/orv11-ops-owner/tests.log`.
2. `pnpm --filter @du/orchestrator typecheck` — exit0. Raw: `raw/orv11-ops-owner/typecheck.log`.
3. `python3 ../tools/openapi/gen_openapi.py` — exit0; 66 paths, 8 list params, no unauthorized drops; deterministic repeated generation. Raw: `raw/orv11-ops-owner/openapi.log`.
4. `git diff --check` scoped source/tests/tools — exit0.

Earlier typecheck used unqualified pnpm before supported toolchain arrived: pnpm11 auto-install failed ignored builds and generated workspace allowBuilds placeholders. Root notified to remove incidental workspace metadata; no functional claim based on that failed attempt.

Independent verification has separately reported initial real PostgreSQL16+HTTP5/5 operation matrix green, including own/cross-key/cross-tenant reads, admin/session access, CSRF, viewer/tenant soft-delete and persisted audit. Latest artifact regression and final source-digest recheck remain with verification owner; this receipt is owner smoke only.

Additional affected encryption regression: `pnpm --filter @du/orchestrator exec jest --runInBand tests/artifact-read-download-route.test.ts` — exit0, 8/8 passed, zero skips. Real HTTP over mocked storage/key services verifies public/worker plaintext-after-decrypt, wrong-key fail-closed503, unsealed compatibility, and single-use grants. Raw: `raw/orv11-ops-owner/artifacts.log`. This does not replace real PostgreSQL key-ownership regression delegated to independent verifier.

## ORV11-OPS-UPLOAD follow-on — operator file picker

Added authenticated `POST /api/internal/operations/uploads` and BFF `POST /admin/api/operations/uploads`. Wire: raw File request body; exact query fields `tenantId` UUID, `apiKeyId` UUID, `fileName` (1–255 characters, no path separators/control characters); `Content-Type` MIME; session CSRF header required. Return201 `{artifactId,state:'READY',fileName,mimeType,sizeBytes}`. Both declared-length and chunked sources bounded to minimum16MiB/configured cap; zero/mismatched size rejected. Tenant/key must be active and match principal scope, viewers denied, encryption mandatory. S3 reuses streaming encrypted gateway; PostgreSQL fallback buffers only within16MiB before encrypted artifact writer. Failure after artifact allocation invokes cleanup; audit preserves session issuer/sub/role.

Migration0045 adds `artifacts.upload_api_key_id` FK. Backfills from operation ownership or unambiguous historical submit references; unidentified orphan rows remain unowned/failclosed. Compat owner passes trusted API key into expanded writer and fences new submission. Public upload init binds authenticated key, namespaces replay tokens by key before creation (prevents orphan-owner claim races), and PUT/complete/abort verify ownership. No raw key travels in browser upload contract.

Owner follow-on check (same supported runtime/cwd as above): `pnpm --filter @du/orchestrator exec jest --runInBand tests/aweb06-bff-operations.test.ts tests/orv11-admin-upload.test.ts` — exit0;27 passed,0 failed,0 skipped (13 upload +14 BFF). Upload suite covers CSRF/roles/tenant/key, encryption unavailable, name/length boundary, declared/chunked size cap, mocked S3 streaming/abort cleanup, public token namespace and key fence. BFF probe uses actual loopback HTTP to forward raw bytes without JSON buffering. Raw `raw/orv11-ops-owner/upload-tests.log`. Typecheck exit0: `raw/orv11-ops-owner/upload-typecheck.log`. OpenAPI generator exit0 now67paths, writes both copies; upload row included.

Real PostgreSQL encrypted-upload→workflow.test/browser verification and real S3 gateway coverage are independent verifier scope. Mocked S3 owner probe does not establish live S3 success. Source/tests frozen for final independent review after test-only cast correction (no product change).

## Final integration fix: in-flight provider cancellation

Independent fullWFA fixture exposed an actual regression: internal dispatcher reached lifecycle's immediate task CANCELLED, so heartbeat lease validation failed before SDK received `cancelRequested=true`, leaving provider request running. Central lifecycle now locks task rows NOWAIT within a savepoint (avoids task→operation lock inversion and preserves dispatcher-owned audited transaction). A live running lease receives durable CANCEL_REQUESTED only; task lease stays valid for heartbeat abort acknowledgement. Paused/unleased tasks still terminalize and close waits immediately; repeated signal doesn't increment state version.

A bounded `sweepCancellations` reconciler runs on the existing recovery timer, before generic expired-lease recovery. It retries contended requests and settles paused/expired-worker cancellations as CANCELLED, preventing indefinite CANCEL_REQUESTED and generic LEASE_EXPIRED/FAILED after cancellation. It reuses the exact cancellation service, closes waits and schedules terminal webhook once. No extra scheduler.

Owner command `pnpm --filter @du/orchestrator exec jest --runInBand tests/orv11-cancel-lifecycle.test.ts tests/mm10-heartbeat-cancel-offline.test.ts tests/wfa-t27-cancel-ack.test.ts` — exit0,3 suites19passed0failed0skipped (7 lifecycle +12 heartbeat/ack regressions). Covers active worker lease preservation, repeat version idempotency, paused retained lease, task-lock savepoint, tenant denial and recovery of paused/expired RUNNING once lock clears. Typecheck exit0, scoped diff check exit0. Raw `raw/orv11-ops-owner/cancel-tests.log` and `cancel-typecheck.log`. Same supported runtime/cwd/base commit as above. Final source frozen for independent fullWFA15 plus real PostgreSQL contention/recovery fixtures; owner mock tests do not prove physical lock behavior.

Reviewer follow-up closed recovery race: runtime expired-lease candidate query excludes either cancellation state or flag, then rechecks operation state/flag `FOR UPDATE` after task candidate acquisition to catch concurrent signal commit after the original snapshot. Thus generic retry/LEASE_EXPIRED never wins against an observed cancellation; dedicated finalizer owns those rows. Root allocated minimal runtime query/recheck lease, API owner confirmed no concurrent runtime writer. Latest owner rerun supersedes cancellation count above: **20 passed,0failed0skipped** (8 lifecycle/runtime +12 heartbeat/ack), typecheck0, generator0 with cancel response description updated. Same raw filenames overwritten by this newer green run. Independent real-PostgreSQL concurrency checks/fullWFA still required before ACCEPTED.
