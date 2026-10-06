# COMMIT-PRE-FLIGHT-813 — tracked-change attribution and commit blockers

**Scope:** DOC-only, independent read of the current tracked diff and prior receipts. No source files were edited, no files were staged or deleted, and no commit or test was run.

## Snapshot and reconciliation

The earlier `COMMIT-BOUNDARY-811` receipt recorded **155 tracked modified files** and 2,062 untracked entries. The current read no longer matches that snapshot: HEAD is `b088eec`, `git diff --name-only` and `git diff --numstat` each report **157 tracked content-diff paths**, the index has **0 staged paths**, and `git ls-files --others --exclude-standard` reports **2,140 untracked paths**. These counts were captured before writing this receipt, which adds one untracked documentation path. During this review the tracked path count itself changed from 156 to 157; the workspace is still being edited by other lanes. The old receipt did not preserve its 155-path manifest, so I cannot safely name which two paths account for the difference against today’s 157.

For a reproducible, disjoint working classification, I compared the current 157 paths’ file mtimes to the cutoff used by the earlier plan: **2026-10-05 00:00 +07:00**. This yields **94 older-mtime paths**, **63 newer-mtime paths**, and no missing paths. Of the newer-mtime set, exact packet receipts confirm a touch to 31 paths; the remaining 32 have no packet receipt proving this wave owns the current diff. Mtime is only a clue: it cannot establish authorship, and a file touched in this wave can contain older or other-lane changes. “Receipt-confirmed” below means the receipt proves a packet touched the file or hunk; it does **not** prove the entire current file diff belongs to that packet.

Evidence consulted includes `du-rework/coordination/reports/commit-boundary-811-2026-10-05.md`, `wave-commit-plan-809-2026-10-05.md`, and the packet receipts named in the confirmation table. Earlier 809 untracked count was corrected by 811; both counts are now stale relative to this read. Do not stage by using `git add -A` or another broad path sweep.

## A. Receipt-confirmed packet touches — 31 files

The following files have a directly identifiable recent packet touch. They are candidate wave files only at the hunk level; inspect each complete diff before making a commit boundary.

| Files | Receipt/evidence | Limitation |
|---|---|---|
| `du-rework/.env.example` | `ENV-EXAMPLE-FIX` | Receipt says its intended edit was comments, but also records an unrelated AWEB-08 hunk in the same current diff. Requires human review before any commit. |
| `du-rework/docs/04-data-state.md`, `du-rework/docs/12b-deployment-guide.md`, `du-rework/docs/21-openapi.json` | `DOCS-CONNECTOR-WIRE` | Documentation/OpenAPI output; keep separate from source commits and confirm the generated spec source. |
| `du-rework/docs/19-traceability-audit-matrix.md`, `du-rework/docs/28-test-inventory.md`, `du-rework/docs/35-acceptance-baseline.md` | `TRACE-RECONCILE-803` | Appended evidence/reconciliation sections; separate documentation commit. |
| `du-rework/packages/contracts/src/connector.ts` | `P745-CONNECTOR-PASSTHROUGH` / VERIFY-T5 | Allowlist/contract change; receipt confirms the connector file touch. |
| `du-rework/packages/contracts/src/index.ts`, `du-rework/services/orchestrator/src/modules/admin-actions/dispatcher.ts`, `du-rework/services/orchestrator/src/server.ts` | `CONNECTOR-WIRE-A` / `CW-A` | Exact receipt covers the export, admin actions and composition field; `server.ts` also has a very large unrelated/older-looking diff and cannot be committed wholesale on this evidence. |
| `du-rework/packages/worker-sdk/src/fan-out.ts`, `du-rework/packages/worker-sdk/tests/fan-out.test.ts` | `FU-ENCMETA-R4` | Camel-case `resultRef` parsing and fixture/contract coverage. |
| `du-rework/services/orchestrator/src/app/admin/p6-01-shell-fixtures.ts`, `du-rework/services/orchestrator/src/app/admin/shell-server.ts`, `du-rework/services/orchestrator/src/app/admin/view-models.ts`, `du-rework/services/orchestrator/tests/admin-p6-01-shell-fixtures.test.ts`, `du-rework/services/orchestrator/tests/admin-shell-platform-mount.test.ts`, `du-rework/services/orchestrator/tests/admin-shell-render.test.ts`, `du-rework/services/orchestrator/tests/admin-shell-router.test.ts`, `du-rework/services/orchestrator/tests/admin-shell-server.test.ts`, `du-rework/services/orchestrator/tests/admin-shell-session-lifecycle.test.ts`, `du-rework/services/orchestrator/tests/admin-view-model.test.ts` | `SHELL-RED-FIX`, `SHELL-RED-FIX-2`, `NAV-DEDUPE` | Receipts prove role/navigation/session-test touches; `shell-server.ts` and `view-models.ts` contain accumulated work and need hunk-level selection. |
| `du-rework/services/orchestrator/src/db/migrations.ts`, `du-rework/services/orchestrator/tests/migrations-ledger-guard.test.ts` | `MIGRATION-VERIFY-TRAP-FIX` | Receipt identifies migration verification checks and matching fake-query test. |
| `du-rework/services/orchestrator/src/main.ts` | `V1-BOOT-TYPED-DENIAL` | Receipt proves boot warning/entry-point touch; current file also composes other functionality. |
| `du-rework/services/orchestrator/src/modules/auth/admin-local/repository.ts` | `IDENTITY-ROLE-POLICY` | Role-gated local-user creation. |
| `du-rework/services/orchestrator/src/modules/encryption/legacy-payload-migration.ts`, `du-rework/services/orchestrator/tests/legacy-payload-migration.test.ts` | `ENC09-KIND` | Result-ref migration store/codec and associated tests. |
| `du-rework/services/orchestrator/tests/admin-local-user-repository.test.ts` | `LEGACY-AUDIT-TEST-FIX` | Receipt identifies three stale audit assertions updated for the actor fields. |
| `du-rework/services/orchestrator/tests/br12-isolation-offline.test.ts` | `BR12` fixture receipt | Receipt describes fixture `inputSchema` and fake-SQL updates. |

## B. Possible pre-existing / not attributable by current evidence — 94 paths

These paths have mtimes before the cutoff. That makes pre-existence plausible but does not prove it. The prior commit-boundary audit itself warns that its timestamp split is a heuristic. No receipt-to-hunk proof in this review assigns these paths to this wave.

```text
.commandcode/taste/--writes-prompts-in-vietnamese,-expects-technical-work-in-english/taste.md
.gitignore
app/doc-compare/page.tsx
app/doc-pipeline/components/Icons.tsx
du-rework/AGENTS.md
du-rework/README.md
du-rework/architecture/10-current-system.md
du-rework/architecture/11-subprojects.md
du-rework/architecture/12-flows-and-data.md
du-rework/architecture/16-interface-catalog.md
du-rework/businesses/document-core/docs/compatibility-matrix.md
du-rework/businesses/document-core/docs/field-dictionary.md
du-rework/businesses/document-core/docs/synthetic-corpus-policy.md
du-rework/businesses/document-core/docs/test-fixture-specification.md
du-rework/businesses/document-core/docs/traceability-matrix.md
du-rework/businesses/document-core/docs/workload-assumptions.md
du-rework/businesses/document-core/src/config.ts
du-rework/businesses/document-core/tests/parser-budgets.test.ts
du-rework/coordination/README.md
du-rework/coordination/coordinator-cycle-prompt.md
du-rework/coordination/probe-agents.py
du-rework/coordination/reports/qwen1.md
du-rework/coordination/reports/qwen4.md
du-rework/docs/00-business-analysis.md
du-rework/docs/01-product-scope.md
du-rework/docs/03-project-structure.md
du-rework/docs/14-reference-compatibility.md
du-rework/packages/worker-sdk/src/crypto-storage.ts
du-rework/packages/worker-sdk/src/task-context.ts
du-rework/packages/worker-sdk/src/types.ts
du-rework/packages/worker-sdk/src/worker.ts
du-rework/pnpm-lock.yaml
du-rework/pnpm-workspace.yaml
du-rework/scripts/dev.cjs
du-rework/scripts/migrate-local.cjs
du-rework/scripts/stop-all.cjs
du-rework/services/orchestrator/CODE-ARCHITECTURE.md
du-rework/services/orchestrator/src/app/admin/api-key-section-data.ts
du-rework/services/orchestrator/src/app/admin/api-key-section-renderer.ts
du-rework/services/orchestrator/src/app/admin/crypto-config-api.ts
du-rework/services/orchestrator/src/modules/admin-actions/rbac.ts
du-rework/services/orchestrator/src/modules/artifacts/artifacts.ts
du-rework/services/orchestrator/src/modules/artifacts/integrity-scanner.ts
du-rework/services/orchestrator/src/modules/artifacts/multipart-service.ts
du-rework/services/orchestrator/src/modules/artifacts/storage-migration.ts
du-rework/services/orchestrator/src/modules/audit/audit.ts
du-rework/services/orchestrator/src/modules/auth/session-store.ts
du-rework/services/orchestrator/src/modules/encryption/artifact-read-decrypt.ts
du-rework/services/orchestrator/src/modules/encryption/crypto-storage-facade.ts
du-rework/services/orchestrator/src/modules/profiles/profiles.ts
du-rework/services/orchestrator/src/modules/public-api/delivery-encryption.ts
du-rework/services/orchestrator/src/modules/public-api/upload-encryption-gateway.ts
du-rework/services/orchestrator/src/modules/queue/dispatcher.ts
du-rework/services/orchestrator/tests/adm-base-03-safe-error-offline.functional.test.ts
du-rework/services/orchestrator/tests/admin-action-dispatcher.test.ts
du-rework/services/orchestrator/tests/admin-audit-list-page.test.ts
du-rework/services/orchestrator/tests/admin-error-boundary-offline.test.ts
du-rework/services/orchestrator/tests/admin-oidc04-claims-tenant-offline.test.ts
du-rework/services/orchestrator/tests/artifact-integrity-scanner.test.ts
du-rework/services/orchestrator/tests/artifact-read-decrypt-offline.test.ts
du-rework/services/orchestrator/tests/artifact-read-download-route.test.ts
du-rework/services/orchestrator/tests/artifact-storage-service.test.ts
du-rework/services/orchestrator/tests/artifact-submit-guards.test.ts
du-rework/services/orchestrator/tests/connector-credentials-offline.functional.test.ts
du-rework/services/orchestrator/tests/delivery-encryption.test.ts
du-rework/services/orchestrator/tests/enc08-wire-enc07.test.ts
du-rework/services/orchestrator/tests/fixtures/multipart-offline-harness.ts
du-rework/services/orchestrator/tests/multipart-routes-offline.test.ts
du-rework/services/orchestrator/tests/multipart-service-offline.test.ts
du-rework/services/orchestrator/tests/public-upload-encryption-gateway.test.ts
du-rework/services/orchestrator/tests/runtime.test.ts
du-rework/services/orchestrator/tests/s3-storage-facade.test.ts
du-rework/services/orchestrator/tests/session-store.test.ts
du-rework/services/orchestrator/tests/storage-migration.test.ts
du-rework/services/orchestrator/tests/submission-metadata-crypto-e2e.test.ts
du-rework/services/orchestrator/tests/url-ingestion-backend-failclosed-offline.test.ts
du-rework/services/orchestrator/tests/url-ingestion-consumer-offline.functional.test.ts
du-rework/services/orchestrator/tests/url-ingestion-offline.functional.test.ts
du-rework/services/orchestrator/tests/webhook-delivery-encryption.test.ts
du-rework/tasks/ADMIN-LOCAL-AUTH-2026-09-30.md
du-rework/tasks/ADMIN-OPS-UX-2026-09-24.md
du-rework/tasks/API-COMPAT-DUGATE-2026-09-28.md
du-rework/tasks/APP-ENCRYPTION-2026-09-27.md
du-rework/tasks/CODE-CONVENTION-LARGE-FILES-DUPLICATION-2026-10-02.md
du-rework/tasks/DETAILED-BUSINESS-VERIFICATION-2026-10-01.md
du-rework/tasks/IMPLEMENTATION-FIRST-COORDINATION-2026-10-01.md
du-rework/tasks/ORCH-PAR-00-INVENTORY-SURVEY-2026-10-01.md
du-rework/tasks/ORCHESTRATOR-FEATURE-PARITY-BOUNDARIES-2026-10-01.md
du-rework/tasks/ORCHESTRATOR-LEGACY-FEATURE-PARITY-2026-10-01.md
du-rework/tasks/P6-admin.md
du-rework/tasks/P9-business-backlog.md
package-lock.json
package.json
tsconfig.json
```

## C. Unknown attribution — 32 paths, with current diff gist

Every path below has a newer mtime but no packet receipt here proves the entire current diff belongs to this wave. These are concise working-tree diff summaries, not ownership findings.

| File | Current diff gist |
|---|---|
| `.commandcode/taste/taste.md` | Large local agent taste/instruction update (about 134 insertions and 4 removals); no product packet evidence. Exclude from product commit. |
| `du-rework/businesses/document-core/src/actions/analyze/index.ts` | Passes pinned prompt-step identity to connector calls for analyze fact-check/extract/verify stages. |
| `du-rework/businesses/document-core/src/actions/compare/index.ts` | Passes semantic/version comparison prompt-step identity to connector calls. |
| `du-rework/businesses/document-core/src/actions/extract/index.ts` | Adds pinned inference prompt-step identity to connector invocation. |
| `du-rework/businesses/document-core/src/actions/generate/index.ts` | Adds pinned inference prompt-step identity to connector invocation. |
| `du-rework/businesses/document-core/src/actions/ingest/index.ts` | Adds OCR/digitization prompt-step identities to connector invocation. |
| `du-rework/businesses/document-core/src/actions/transform/index.ts` | Adds translation/rewrite prompt-step identities to connector invocation. |
| `du-rework/businesses/document-core/src/types/context.ts` | Adds session reference and profile/prompt revision, policy, override and connector-binding fields to task context. |
| `du-rework/businesses/document-core/src/types/results.ts` | Removes old `ProfileSnapshot.promptOverrides` map; prompt material appears to move into the pinned carrier. |
| `du-rework/businesses/document-core/src/worker.ts` | Forwards pinned profile/prompt data into worker/stream handling and uses pinned-step prompt application. |
| `du-rework/businesses/document-core/tests/execution-pin.functional.test.ts` | Updates pinned-admission fixtures and removes old `promptOverrides` mock shape. |
| `du-rework/coordination/agent-watch-state.json` | Dynamic agent-watch snapshot/state; not a product artifact. |
| `du-rework/coordination/coordinator-state.json` | Dynamic coordinator task/run state; not a product artifact. |
| `du-rework/coordination/reports/claude.md` | Appends review/report output; lane log. |
| `du-rework/coordination/reports/tester.md` | Appends test/readiness report output; lane log. |
| `du-rework/docs/11-admin-ux.md` | Adds admin-operations acceptance and admin-web rollout/parity notes. |
| `du-rework/packages/contracts/src/runtime.ts` | Adds pinned profile policy/prompt carrier fields to execution snapshot contract. |
| `du-rework/services/orchestrator/src/compat/legacy-http-mount.ts` | Adds raw/binary response-body passthrough for the legacy HTTP mount. |
| `du-rework/services/orchestrator/src/modules/operations/ingestion-consumer.ts` | Adds pinned fetch/profile resolution, egress fencing and typed source-auth denial handling. |
| `du-rework/services/orchestrator/src/modules/operations/submission.ts` | Adds profile/prompt revision pinning, snapshot hashing/admission and metadata sealing; large mixed diff. |
| `du-rework/services/orchestrator/src/modules/runtime/metadata-crypto.ts` | Expands metadata crypto slots/read APIs for session refs, prompt overrides and result refs; accumulated changes. |
| `du-rework/services/orchestrator/src/modules/runtime/runtime.ts` | Large accumulated execution/runtime change including result-ref writes/reads, checkpoint refs and pinned profile/prompt state. |
| `du-rework/services/orchestrator/tests/admin-crypto-config.test.ts` | Adds assertions for server-derived audit actor role/entity; rejects fabricated subject/issuer data. |
| `du-rework/services/orchestrator/tests/legacy-http-mount.test.ts` | Adds binary artifact-download passthrough assertions and response headers. |
| `du-rework/services/orchestrator/tests/oidc02-multi-replica-offline.test.ts` | Updates expected issuer/principal claims in multi-replica share/rotation coverage. |
| `du-rework/services/orchestrator/tests/p8-01-audit-entity-offline.test.ts` | Adjusts argument positions for inserted actor fields. |
| `du-rework/services/orchestrator/tests/runtime-encryption-metadata.test.ts` | Updates expected metadata slot list and removes obsolete assertion that result-ref is not encrypted. |
| `du-rework/services/orchestrator/tests/rv01-loopback-http-offline.test.ts` | Converts the raw-download case from expected failure to pass and updates defect commentary. |
| `du-rework/tasks/ADMIN-CONTROL-PLANE-UI-2026-10-02.md` | Adds current admin control-plane/UI acceptance links and status text. |
| `du-rework/tasks/P8-release-readiness.md` | Adds scale/HA and admin acceptance references. |
| `du-rework/tasks/README.md` | Adds planning/checkpoint/shared-package/scale/admin roadmap entries. |
| `du-rework/packages/contracts/src/operations.ts` | 403 lines removed and re-added with line endings changed; no semantic diff was visible in the content review. Treat as normalization noise and do not commit as-is. |

## Commit blockers and files not to sweep into a product commit

1. **Do not commit dynamic state, reports, or lane logs as product source:** `du-rework/coordination/agent-watch-state.json`, `coordinator-state.json`, `coordination/reports/{claude,qwen1,qwen4,tester}.md`. Keep these out unless a separate documentation/history commit is explicitly chosen.
2. **Do not commit `.commandcode/taste/**` as application code.** It is local agent configuration.
3. **Do not commit `du-rework/packages/contracts/src/operations.ts` in its present 403/403 line-ending-only form.** Normalize it separately only if the owning lane confirms a semantic change exists.
4. **Do not commit `.gitignore` as-is.** Git treats its diff as binary/mixed-encoding; text inspection showed mixed/NUL-interspersed content along with ignore additions. Review and normalize before inclusion. This is especially important because the prior boundary audit flags an untracked, unignored `du-rework/.env.live`; do not stage it.
5. **Do not commit `.env.example` until a human reviews the full diff for values and separates the unrelated AWEB-08 hunk.** This audit did not inspect secret values.
6. **Review high-risk oversized diffs before any inclusion:** `du-rework/services/orchestrator/src/server.ts` has roughly 4,008 removed lines (the CW-A receipt proves only its composition-field hunk); `du-rework/services/orchestrator/tests/runtime.test.ts` has roughly 2,121 removed lines. Do not accept these as ordinary wave files without confirming that the removals are intentional and the replacement tests/source exist.
7. **Treat generated artifacts as separate candidates:** `du-rework/docs/21-openapi.json` and `du-rework/docs/28-test-inventory.md` look generated/derived; regenerate or verify them from their canonical inputs before committing. `pnpm-lock.yaml` and root `package-lock.json` are not disposable, but include only with the matching manifest and intended workspace boundary.
8. **Keep documentation/task edits separate from product code:** `du-rework/docs/**`, `du-rework/tasks/**`, architecture notes, and traceability/test inventory have their own reviewable doc commit.
9. **Root app scope requires a user decision:** `app/doc-compare/page.tsx`, `app/doc-pipeline/components/Icons.tsx`, root `package.json`, `package-lock.json`, and `tsconfig.json` are outside `du-rework/`; do not mix them into a DUGate `du-rework` product commit without confirming they belong to the intended repository deliverable.
10. The current 2,140 untracked paths are outside this tracked-file classification. Prior boundary evidence includes raw dumps, test-result output, scratch scripts, and `.env.live`; keep all untracked data out of any proposed product commit until independently classified. Never use a broad add operation.

## Ordered commit proposal (candidate only; no staging performed)

This is a dependency-oriented review order, not an authorization or a claim that each full file is wave-owned.

1. **Contracts and worker/business prompt pins:** first review `packages/contracts/src/connector.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/runtime.ts`, `packages/worker-sdk/src/fan-out.ts` plus its test, and the document-core action/context/worker/result changes. Resolve the owner of `operations.ts` line-ending normalization before considering it.
2. **Persistence/runtime and migration:** next select exact hunks from `src/db/migrations.ts` and its ledger test, `legacy-payload-migration.ts` and its test, `metadata-crypto.ts`, `runtime.ts`, and `operations/submission.ts`; then include only source/auth/consumer hunks whose contract dependencies are accepted. Preserve tests with their matching source.
3. **Admin and connector wiring:** group connector dispatcher/composition/legacy HTTP changes with their tests; group local-user role policy with its repository test; then review the shell/navigation/session source and tests together. Exclude large unrelated `server.ts` history unless hunk-reviewed.
4. **Document-core consumer tests and end-to-end evidence:** include the matching action and execution-pin tests only after their contracts and worker behavior are accepted.
5. **Documentation and task plans:** separate docs, OpenAPI/test-inventory artifacts, task plans, architecture notes and traceability updates into a documentation-only commit after regeneration/source-of-truth review.
6. **Repository tooling/configuration:** keep scripts, manifests/lockfiles, `.gitignore`, `.env.example`, `.commandcode/taste/**` and outer-root app files out of the product sequence until individually reviewed and scoped.

## Decisions that need the user

- Freeze the current tree and decide whether the boundary is the old 155-file snapshot or today’s 157-path diff. The exact old 155-path manifest was not retained, so reconstructing it from today’s tree would be guesswork.
- Decide whether the root Next.js app/config paths belong in the deliverable or are unrelated repository work.
- Decide whether to commit docs/tasks/coordination history separately; dynamic state and lane logs should remain excluded from product commits.
- Have the owning lanes review the 32 unknown-attribution diffs and mark the exact hunks intended for inclusion.
- Approve/decline the `.env.example` hunk after value review, normalize `.gitignore`, and confirm whether generated OpenAPI/test inventory are canonical tracked outputs.
- Review the `server.ts` and `runtime.test.ts` large removals, and resolve lockfile/manifest ownership before any stage operation.

**Conclusion:** the available evidence supports 31 recent packet touches, 94 possible pre-existing paths by mtime only, and 32 unattributed newer-mtime paths in today’s 157-file content diff. It does not support a safe final stage list for the earlier 155-file snapshot; the blocking step is a frozen path/hunk manifest and user decisions above.
