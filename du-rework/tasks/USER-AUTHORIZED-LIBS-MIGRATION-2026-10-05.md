# User authorization: shared libraries and repo migration

## Direct instruction

User, 2026-10-05:

> hãy yêu cầu các agent trong workspace xử lý task tách libs và mỉgation. hãy nhắc và cho phép agent điều phoiis thực hiện

This instruction authorizes the existing coordinator to open and dispatch implementation tasks for library redistribution and local repo migration now. It resolves the prior pending question about proceeding with an isolated migration candidate. Do not continue reporting a missing user authorization or leaving this scope plan-only.

## Sequencing change

For local implementation and isolated candidates, the previous RPK-00 wait in SHARED-PACKAGES-REDISTRIBUTION-2026-10-05.md and PLAT-MIG Phase B is superseded by this direct user instruction. RPK-00 remains a baseline/acceptance tracking task: record its actual open findings, freeze the exact working-tree snapshot used for each candidate, and preserve independent verification and release gates. This authorization does not mark RPK-00 or any implementation ACCEPTED.

Original source must remain available until candidates are verified. Export from an explicit allowlist with current source hashes, including classified product files that are untracked; neither HEAD-only exports nor blanket dirty-tree copies represent the approved source. Unclassified files require an owner decision. Local code changes, isolated build contexts, tests and disposable infrastructure are authorized. Production deployment, remote publication and destructive cutover remain outside this packet.

## Architecture to implement

- Default two repo types: Orchestrator and Worker. A separate Connector repo is optional, never mandatory.
- Orchestrator repo contains Admin Portal, Platform API/Orchestration Runtime, and Connector. Connector runs as a separate service/image. Do not rename the whole backend to App Portal or split Runtime into another service.
- Canonical contracts, shared library/reference source, client/runtime/document/egress/observability helpers, guides and skills belong to the Orchestrator repo. No fourth Shared/SDK repo.
- Each business Worker derives from a self-contained worker template and builds/deploys independently. Prefer Runtime/Connector APIs. Materialize required thin clients and executable helpers as local versioned source with provenance, without requiring a separately built internal SDK or sibling repository.
- Skills assist scaffolding/integration/upgrades; lease, heartbeat, checkpoint, crypto and document parsing still require executable code. Preserve business-specific customizations and existing API/queue/security semantics.

## Required action by the existing coordinator

Use the existing Run `run_069ecd6957cd`; reconcile real Task/Dispatch/terminal state and leases. Create no duplicate coordinator, Run or editor. Reuse the existing RPK and PLAT-MIG packets and any tasks already bound.

1. Record this authorization and replace obsolete pending-user/deferred-local-implementation wording in the active plans/ledger under their existing owner leases. Keep historical receipts intact.
2. Bind RPK-00 and library/import/export inventory work in the existing Run. Assign an inventory owner to freeze source hashes and map exports, direct/transitive production/test/tooling dependencies, canonical ownership and destinations.
3. Dispatch Orchestrator repo/build and worker-template/library migration owners with disjoint write scopes. Serialize manifest/lockfile/Docker/Compose/shared-doc edits. Start ready implementation lanes immediately; dependency ordering may block a specific export until its inventory is frozen, but must not prevent unrelated authorized work.
4. Pilot Document Core, then migrate Example Review and LC Checker using the same versioned local-source strategy. Verify isolated builds with sibling packages/repos absent. Test scaffold and upgrade behavior, pinned provenance and preservation of custom code.
5. Continue outstanding Phase A ingress, root-path documentation and real signed management-auth integration; reuse the existing Connector Bearer/HMAC verifier rather than creating a second authentication scheme.
6. Assign the two existing independent Codex testers and Claude backend reviewer at the appropriate candidate milestones. UI review is needed only for UI changes. Report code/verification/acceptance separately; no checkbox completion from design or mock-only evidence.

Reply with actual task IDs, named terminal owners, write leases, the first dispatched implementation wave, and any concrete remaining dependency. The next consumer is the user requesting migration, not another planning-only packet.

## References

- [Platform migration](DU-PLATFORM-MIGRATION-2026-10-05.md)
- [Shared library redistribution](SHARED-PACKAGES-REDISTRIBUTION-2026-10-05.md)
- [Target architecture](../docs/40-du-platform-architecture.md)
- [Readiness implementation and verification handoff](../coordination/reports/plat-mig-02-user-owned-2026-10-05.md)
