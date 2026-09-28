# Completion wave 09 — close remaining plan by dependency

This packet follows `STRUCTURE-CODE-REVIEW-2026-09-21.md` and the verified FIX-08 snapshot.
It is an execution plan, not evidence that a phase is complete. Agents must preserve the shared
dirty tree, keep tests truthful, and report blocked dependencies rather than add test-only shims.

## Claude Code: platform, SDK, Admin and operations

Own `services/orchestrator/**`, `packages/worker-sdk/**`, contracts when required,
`tests/integration/**`, `infra/**`, root workspace config, central tasks/gates/status and the
Claude report.

### W09-C1 — complete the R08 platform blockers

Finish R08-01/02/03/06 from FIX-08 against actual source, not just reports:

- fail-closed API keys and distinct runtime/admin scopes;
- stable, profile-bound grant identity and one canonical SDK/Connector hash;
- artifact size/hash/MIME/expiry/authorization/TTL lifecycle;
- executable service bootstrap and separate migration command.

Remove the E2E hash bridge after publishing the wire behavior Antigravity must use. Add tests for
all security/replay cases and run the provider-backed E2E as a consumer.

### W09-C2 — P1/P2/P4 durable continuation

Implement the public typed child-result and human-wait continuation surface requested in
`requests/antigravity.md`, plus persisted routes/DB state for children, join, wait, resume,
cancel/restart, stale and duplicate resume. Prove concurrency=1 makes progress. This closes the
real gaps in P1-06, P2-06 and P4-04; do not use untyped TaskContext extensions.

### W09-C3 — finish platform API and Admin prerequisites

Complete P1-03 OpenAPI validation/examples and P2-02 profile/registry/RBAC, P2-08 poll/result/
webhook/audit and P2-09 reconciliation/health/shutdown. Resolve R08-07 with an ADR and implement
the chosen server/UI/database boundary. Once those contracts are real, implement P6 Admin views
and browser/accessibility evidence. Do not call a raw node:http test endpoint an Admin UI.

### W09-C4 — release infrastructure only after integration gates

Build immutable Orchestrator and document-core images, compose all services, use an explicit
migration job, then add P8 fault/security/backup/health/runbook evidence. Notify Antigravity at
each typed-contract or image gate; it owns no platform source.

## Antigravity: business specs, document-core and extension proof

Own `businesses/document-core/**`, `businesses/example-review/**`, `packages/document-kit/**`,
and Antigravity report/requests only.

### W09-A1 — make the Connector E2E contract-real

Keep the real Connector composition/provider HTTP mock. Once C1 publishes canonical hashing,
remove `pendingHashes`, custom `GrantVerifier` hash replacement and any equivalent shim. Assert
signed grant claims validate unchanged at Connector. Add no-duplicate provider execution after a
real worker retry/restart, then extend the same composition to six actions and the 28-variant
matrix as applicable. P5-10 stays partial until these pass.

### W09-A2 — finish P0 evidence and document-kit acceptance

Close P0-01/03/05/06: BR-01..12 traceability, legacy characterization, synthetic corpus policy,
workload/SLO metadata. Extend document-kit evidence for actual format limits, archive safety and
bounded parser behavior required by ART/DOC tests. Do not claim object-storage policy owned by
platform.

### W09-A3 — complete P7 only through published SDK/API

After C2, consume the typed child-results/wait interface to aggregate every child, run fresh-context
join, failing-second-document, duplicate delivery, cancel/restart and approval-resume tests. After
C3/P6, prove dynamic registration, profile assignment and v1/v2 drain/rollback. Build the final
image and developer guide. Keep P7-03..07 open until each live proof has its own evidence.

### W09-A4 — business readiness contribution

When C4 composition exists, run document-core/example-review image-based E2E and contribute P8
security/fault/format cases. Keep tests separated by unit, integration and image E2E scope.

## Exit policy

P0–P5/P7 checkboxes change only after commands and gate evidence match the row acceptance. P6 and
P8 remain separate gates. P9 is out of the initial release and must not be started by this packet.

