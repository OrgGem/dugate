# ORV15 independent Standards review

Verdict: **APPROVED_OFFLINE — Standards axis only**.

Fixed point: `b276ede4d3032d197a2ba96ba79c18b0f6e3c139`. Initial review covered the tracked working-tree diff plus named untracked HA package, deployment document, and ORV15 tests, inspected directly without staging. Final bounded reread covered only the corrected helper, Nginx, and owner test; unchanged UI was not re-reviewed.

Final SHA-256 pins matched:

- Selector: `68502564455cde35c2098fbd500c869a6d54a7829a2664b2de17d47da2f684eb`
- Nginx: `ce4b77352943f4b12bc64c7f7b9b81c74437eef056b4969b7884534b32f0ed99`
- Owner HA test: `8aeafb98ec1be572f57320d38502685440e82a99bb341ea8cb09641e8b7f703c`

Standards sources: root `AGENTS.md` (Coding Style, Security, coordinator/model boundaries), `CONTRIBUTING.md` (Code Style), `du-rework/AGENTS.md` (ownership and evidence levels), and `du-rework/coordination/COORDINATOR-CONTRACT.md` (exclusive leases and acceptance gates).

**Hard documented-standard breaches: 0.** The delta adds no HTTP business handlers or secret-bearing source/configuration. Runtime configuration examples use invalid sentinels; bootstrap failure reporting avoids echoing configuration values (`compose/availability.yml:13–32`). Admin retry/cache policy is centralized in the existing feature helper and reused by its callers (`orchestrator/apps/admin-web/src/features/submissions/immutable-attempt.ts:22–82`). Source tests use synthetic credentials and injected external boundaries. Tooling-enforced formatting/type diagnostics are excluded from this review.

**Baseline smell findings: 0 actionable findings.** The two shared helpers encode actual tenant/attempt and upload-identity rules, rather than delegation-only abstractions. Independent HA test fixtures deliberately remain independently authored; their overlap alone does not justify extraction.

**Historical separate MEDIUM behavioral handoff:** selector `718c1f89…` read both slots before taking its global lock, allowing a stale sibling snapshot to overwrite a completed switch. Root was notified; the final source correction now acquires that lock at `compose/ingress/reload-selector:54–55` before reads at `:84–85`. Signal handlers explicitly terminate with 129/130/143 and clean up once (`:59–79`); Nginx explicitly bounds bodies to 64 MiB (`compose/ingress/nginx.conf:10–12`). Closure awaits final Spec/VFY confirmation, rather than an unchanged-source hold.

The new concurrency/signal tests copy the actual helper into a temporary private tree and redirect only external paths/UID/commands (`orv15-ha-compose-package.test.ts:102–171`). Production source contains no test-environment bypass or real secret. Final delta adds no Standards breach or actionable smell. Owner 13/13 is an owner claim, not independent verification by this reviewer.

Read-only review only: no tests, builds, images, services, Git mutations, or product edits. This verdict provides neither `UI_APPROVED` nor live/native gate closure; parent acceptance remains open under the coordination contract.
