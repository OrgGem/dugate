# Codex architecture decision: unblock local migration

Authority: direct user request for urgent Codex Arch decisions relayed by Antigravity, 2026-10-05. This supplies technical decisions and lane authorization to the existing coordinator, not a second dispatcher. User authorization for local libs migration remains in tasks/USER-AUTHORIZED-LIBS-MIGRATION-2026-10-05.md.

## A. Readiness authorization and revocation

DECIDED: request authorization uses the current database snapshot when authorizeConnectorProbe executes. No authorization cache or grace period across subsequent requests. After a revoke/publish transaction commits, a later authorization query must observe the new binding/key state and deny where appropriate. A request authorized before that change may finish its one already-authorized readiness probe, under the existing 5-second outbound timeout. Do not label this atomic revocation.

This decision applies ONLY to public Connector service readiness: bare GET /health/ready, no credentials, provider inference, mutations or invocation grants. Preserve deny-before-network for requests that fail authorization. Do not extend these semantics to management writes, billing or worker grants.

Do not add row locks held across network I/O. A second read alone does not remove the check/use race. Strong cancellation after revocation would require a separate coordinated admission/cancellation protocol and is not required for this bounded read-only readiness operation.

Acceptance: own binding succeeds; foreign/unbound/disabled/revoked keys are denied with zero outbound requests. Test deterministic revocation before authorization (denied) and after authorization (already admitted probe may finish); subsequent request is denied. Retain the independent real-PostgreSQL predicate mutation proof. Claude reviews conformance to this decision and any other security findings; this decision is not ACCEPTED/release approval.

## B. Signed management identity

DECIDED: reuse services/connector/src/identity.ts HmacServiceIdentityVerifier and requireServiceIdentity. Connector already verifies HS256 signature, integer exp, audience and required scope. Do not create a second Connector verifier.

Orchestrator management calls must send `Authorization: Bearer <HS256 JWT>` whose signing key bytes match the configured Connector SERVICE_IDENTITY_SECRET. Configure a server-only base64 key of at least 32 decoded bytes. Never send that key/token to Portal/browser or attach it to the public readiness probe. Management authorization and tenant/account fencing on both services remain necessary.

Claims for Orchestrator-issued management tokens: sub=orchestrator-management, aud=connector, scopes=[connector:manage], iat=current epoch seconds, exp=iat+60 seconds. Service identity is a signed token, not a signed arbitrary header or a per-request body signature. The current verifier checks exp from the token; a separate DU_CONNECTOR_IDENTITY_EXPIRES_AT value cannot substitute for it.

Preferred implementation: an injected server-side header/token provider invoked for every management request, producing a fresh short-lived token. Configure the signing key at boot, generate tokens at request time, and rotate the boot key with coordinated service restart; do not cache a 60-second token for the process lifetime. Serialize changes to main.ts/composition/management-store under one identity implementation owner. Existing externally provisioned header mode, if retained for compatibility, must be explicit, mutually exclusive with issuer mode, and fail closed on missing/expired identity; document its refresh ownership separately.

Acceptance: real management HTTP endpoint using existing Connector router and verifier plus actual Orchestrator composition. Valid management token succeeds; wrong key, expired token, wrong audience, missing manage scope and missing identity fail. Invocation-only token cannot manage. Show a second management call after the initial token TTL with a fake clock or controlled provider refresh. Mock echo of a literal header is not proof. Keep provider calls offline and secret values out of receipts/logs.

## C. Lane allocation and write boundaries

Read-only runtime observations at decision time:

- Run run_069ecd6957cd task-list reports four dispatched tasks: MIGRATION-INVENTORY-FIX-877 (qwen_5), SHIPPING-DU-REWORK-887 (tester_live), RERUN-PLAT-MIG-02-888 (tester_offline), RPK-INVENTORY-FREEZE-889 (qwen_1).
- codex_worker_1 term_37c6cebe-5c6f-4eae-9690-db6d1b3c8740 has no dispatched task in that Run; terminal shows its inventory refresh completed at 18:29 and an idle prompt. Assign it ORCH-CANONICAL-LIBS-891 task_8edd16dbe85d NOW.
- WORKER-TEMPLATE-PILOT-890 task_d4e65e83fe2e is ready with no assignee/dispatch. The prior state entry saying wave1 dispatched is inaccurate for this task. qwen_5 still holds 877, so bind 890 only after 877 settles, or to another proven available implementation lane.
- WORKER-MIGRATE-892 task_4b78a68aea32 is ready/unbound; actual dependency is pilot890 plus classified inventory. It cannot yet materialize the final worker clients from a nonexistent completed pilot. Bind as the next implementation follow-up after pilot890, with Example Review/LC Checker only, never template/lockfile ownership from other lanes.
- tester_live term_3adb7228-0087-45c5-8a18-77a4150a5043 has an idle TUI but an authoritative assigned887 dispatch ctx_dc4b4371e091. Its screen still shows the old ROOT checklist878. Do not reinterpret idle as task settlement or reassign it to product implementation. Existing coordinator should deliver/wake the exact887 packet and verify the DU-REWORK target. Preserve tester independence.

Lease for891: NEW isolated output migration-candidates/orchestrator/** and own receipt orch-canonical-libs-891-2026-10-05.md. Read packages/services/apps/infra/root manifests and the frozen allowlist. First scaffold candidate-local manifests/build scripts and classify consumers; copy classified source only from the pinned inventory889 when available and verify hashes. Canonical contracts/shared references live inside this candidate, Connector remains its own service/image. Build with worker siblings absent. Original packages/services/businesses/root lockfile/Compose/shared docs are READ-ONLY for this initial slice. Candidate-local package/lockfile/Docker/Compose files belong only to891. This narrower scope avoids overlapping active source/identity/inventory/worker leases.

Pilot890 and migration892 use worker candidate outputs under migration-candidates/workers/<business>/**, with candidate-local pinned helpers/provenance; no writing into891 or sibling original source. The template owner alone writes the new template path recorded in its lease. In-place canonical source changes, if later needed, require a distinct serialized lease, not an implicit broadening of these candidate scopes.

Do not block891 merely because889 is not complete: candidate-local scaffolding and dependency analysis are ready; exact export is the dependent substep. Bind real dependencies/scope in task specs, rather than recording tasks as dispatched while they remain ready. Collect actual Task/Dispatch IDs and send the implementation prompt; creating a context without delivering a prompt does not start work.

## D. Coordinator operation

Keep DeepSeek as the single dispatcher; Codex supplies this decision and does not open another Run/timer. Shell/Orca CLI read-only calls succeeded in this Codex terminal, so the old pwsh schema message is not proof of workspace-wide tool failure. The reported retry duration is historical and was not reproduced by the latest terminal observation. Coordinator should use the tool arguments actually supported by its own harness and report an exact current error if it fails.

Immediate order: record decisions A/B/C; bind/deliver891 to cw1; wake assigned887 on the correct target; settle877 then dispatch890; advance892 after pilot output; assign identity integration and ingress to proven free implementation lanes. Refresh the plans/ledger under existing documentation ownership. No duplicate writers, no production cutover or release claim.
