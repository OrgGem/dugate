# ORV15 evidence documentation — working snapshot

I appended a narrowly scoped ORV15 section to the traceability audit, test inventory, and acceptance baseline. Historical entries and fleet counts remain unchanged. The additions identify the base commit and current working-tree scope, link the named owner/verifier reports and raw outputs, preserve known earlier reds, and keep offline evidence separate from live acceptance.

Evidence recorded so far:

- Admin owner selection: 3 suites / 15 tests passed; Admin Web no-emit passed. See [Admin owner report](orv15-admin-owner.md) and [receipt](raw/orv15-admin-owner/receipt.json).
- Independent Host unit checks: 4 suites / 12 tests passed with 0 skips. See [Host report](orv15-vfy-host.md) and [raw receipt](raw/orv15-vfy-host/independent-unit-20261012T052833Z.md).
- Public operation route seam: latest focused run 6/6; earlier 4/6 with two failures remains linked. This is not a live route run.
- Migration offline batches: workflow schema 7/7, related CJS 56/56, identity/readiness 12/12. The report preserves the earlier 55/56 red and the separate Native19/A2 failure at `secret_versions`.
- Worker SDK workflow override wire: 1 suite / 2 tests passed.
- Primary's authoritative Orchestrator selection passed 15 suites / 341 tests in a10, with matching source/test SHA-256 manifests before and after. The earlier a8 red (329/341, 12 failures from fake P745 transaction clients missing the API-key row) is retained; the targeted a9 P745 rerun passed 24/24. Primary's report also preserves the older a1 result and earlier SDK/Core failures, which were corrected in affected reruns.
- Additional Primary offline selections passed SDK 67/67, Document Core 9/9, Contracts 7/7, and global AI caller 2/2. The selected batches overlap and their counts are not combined.
- Primary Admin Web no-emit exited 0 and the private a13 Vite build succeeded, transforming 3,041 modules with source/config pre/post manifests matching. The initial a12 build failed to resolve `index.html` from its working directory. The successful private bundle is not a served-bundle or browser result; Vite's `node:crypto` externalization and large-chunk warnings remain documented.
- HA package final R1/R2 combined run passed 2 suites / 18 tests, 0 failed/skipped: 13 owner tests and 5 independent tests in one invocation (not additive). Sampled source hashes match before and after; the only raw manifest difference is the `sampled_utc` header. Read-only Compose `config --quiet` exited 0, and Compose YAML remained unchanged.
- The final independent Spec and Standards reviews are `APPROVED_OFFLINE` for their respective axes. Spec preserves the initial `CHANGES_REQUIRED` R1 HIGH and R2 MEDIUM findings, both resolved in final source. The owner’s four initial regression reds remain preserved. This closes only offline unit/package evidence; native DNAT, six live replicas, live identity/health/drain, real rollback, and cutover remain open.

The Primary report and raw matrix/private-bundle receipts are available at [orv15-verification.md](orv15-verification.md). The HA owner, independent verifier, Spec, and Standards receipts are [HA owner](orv15-ha-owner.md), [HA verifier](orv15-vfy-ha.md), [Spec review](orv15-review-spec.md), and [Standards review](orv15-review-standards.md). Full browser journeys, image builds, Native19 source-off database work, real backup/restore, and rollout remain open. No canonical BR row, parent checkbox, or release acceptance state was changed.

The scope and base are pinned by [the ORV15 execution packet](../ORV15-UNIT-FIRST-EXECUTION-2026-10-12.md): `b276ede4d3032d197a2ba96ba79c18b0f6e3c139`, `codex/fix-workflow-builder`. This is a documentation reconciliation only; no product source, tests, build output, or Git index was written. `git diff --check` and the relative-link check for the appended ORV15 sections passed; no tests, builds, images, services, or deployment commands were run for this doc update.
