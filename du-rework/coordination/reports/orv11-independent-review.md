# VFY-ORV11-REVIEW — independent review

Reviewer: `/root/independent_review`. Base: `7e36a1e`. Scope: source/test read-only; report only. Canonical scope is ORV11 execution ledger and compatibility plan. Review began during implementation; final scoped decisions below incorporate owner handoffs and independent exact-build verification. Earlier checkpoints are retained as chronology.

Latest scoped verdicts: **API APPROVED; OPS APPROVED; DATA APPROVED for delivered mechanisms only; UI_APPROVED for the delivered operator journeys**. Full canonical plan / production cutover is NOT ACCEPTED. Prior red runs and intermediate findings below are retained as history; resolved findings do not override these current scoped decisions.

## Early source findings delivered to owners

| ID | Scope | Evidence at inspection | Required resolution |
|---|---|---|---|
| IR-01 | API replay | `legacy-host-adapter.ts` legacy identity records role/hash only; `hashing.ts` sorts same-role artifacts. | Preserve filename/MIME/order when they affect policy/worker semantics; changed multipart intent must not replay prior output. |
| IR-02 | Profile revision | `profiles.ts` lookup now filters `endpoint_slug`; `createRevision` INSERT does not preserve it. | Editing migrated exact-subcase profile must not turn it into generic action policy. Add revision regression. |
| IR-03 | Legacy states | importer WIP recognizes `WAITING_FOR_USER`; root `workflow-engine.ts:257` persists `WAITING_USER_INPUT`. | Recognize actual source name and return explicit drain requirement unless executable checkpoint migration exists. |
| IR-04 | Prompt carrier | `submission.ts` reads prompt override bucket by `canonicalAction`, while imported and Settings rows use exact legacy endpoint slug. | Resolve trusted legacy endpoint bucket so successful settings writes/migrated prompts affect new submissions. |
| IR-05 | URL resource bounds | URL downloader bounds one file at 64 MiB/30 seconds; decoder has no count cap and host retains all buffers. | Bound aggregate count, bytes and deadline; validate all names/extensions before downloads. |
| IR-06 | Historical downloads | Newly shared `collectOutputBytes` caps every historical output at workflow projection limit 8 MiB; loadLegacyOutput catches this as missing output. | Preserve supported historical download sizes; do not report oversized valid file as 404. |
| IR-07 | Artifact read ownership | Public artifact download owner/ref EXISTS predicates scope tenant only; submission permits known linked artifact IDs from any key in tenant. | Fence both direct downloads and linked-artifact resubmission by operation key; test foreign same-tenant key and deleted rows. |
| IR-08 | Effective Settings targets | Arbitrary UUID/endpoint/step settings writes can never match business `connectionIdForSlot` / pinned prompt lookup but UI claims application. | Derive/validate target from winning active profile pins and supported consumer step; preserve disabled exact-profile precedence. |
| IR-09 | Settings stale scope | Key/endpoint selector changes initially retained prior rows and did not invalidate in-flight reads. | Clear editor/read model and invalidate delayed reads/saves on scope changes. Owner reports fixed; browser validation pending. |

Owners notified directly. These are intermediate findings, not a final assessment of unfinished patches.

IR-01 follow-up: adding filename/ordinal metadata alone does not fix order collisions when both multipart filenames/MIME are equal; each ordered identity entry must bind its bytes hash. Positive source observation: document result lookup fences artifact ID/tenant/operation; artifact reader performs integrity verification and configured decryption. Shared pinned fetch enforces DNS/IP policy and certificate validation; final transport wrapper still needs negative tests and resource limits.

## Evidence gates

- Public/internal route auth matrix: real API key vs admin vs session, same/cross tenant and key; retired paths inaccessible for both credential classes.
- Actual HTTP → admission → worker → result/download/callback with supported runtime and 31 variants; stub-only unit green does not prove end-to-end compatibility.
- Rehearsal requires actual migrated membership/policy and readable blob links; empty connector bindings, disabled identities without reset journey, omitted settings or historical idempotency remain explicit cutover gaps.
- Timezone proof must bind frozen snapshot with independently reviewed reference observations; no bypass as production success.
- UI review requires exact build and real backend browser evidence; source review alone cannot yield UI_APPROVED.

No product code or test edits, production actions, or commits made by reviewer. Coordinator subsequently authorized independent execution of existing owner tests; receipts follow.

## Independent evidence inspected so far

- `reports/raw/orv11/operations-http.log` and `tests/workflow-api/orv11-vfy-operations.test.ts`: five independent passing tests using live HTTP application and isolated PostgreSQL/Redis. Cover public route retirement with key/admin, inline historical output/read ownership, internal listener separation, scoped session reads, viewer/CSRF delete denial, successful audited delete. They do not prove artifact-backed large historical download or successful cancel/resume/retry dispatch.
- Source IR-02 now preserves endpoint_slug on ordinary profile revision; IR-03 recognizes actual WAITING_USER_INPUT; IR-04 now selects exact legacy prompt bucket. Regression receipts still needed.
- DATA source review: frozen repeatable-read snapshot digest, SHA-bound human-reviewed UTC observations, authenticated comparison of reused secret/schema envelopes, conditional audited activation of imported local identity are implemented. Local identity login, complete settings/connector mapping, file reconciliation and real DB replay still require independent evidence; archive is not effective configuration.

## Reviewer-executed tests (2026-10-11 15:38–15:41 UTC)

Node24.21.0, pnpm10.18.3, base HEAD7e36a1e + working tree. Toolchain PATH prefix `/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin:/workspace/scratch/orv11-toolchain/node_modules/.bin`. API source SHA checks before/after match in `raw/orv11-review/api-source.sha256`; OPS snapshot in `ops-source.sha256`.

| Cwd / command | Result | Raw |
|---|---|---|
| `du-rework/orchestrator`: `pnpm --filter @du/orchestrator exec jest --runInBand tests/orv11-api-boundaries.test.ts tests/orv11-api-url.test.ts tests/legacy-http-mount.test.ts tests/legacy-wire-decoders.test.ts tests/artifact-submit-guards.test.ts tests/submission-metadata-crypto-e2e.test.ts tests/profile-api-keys-membership-offline.test.ts tests/cb02b-profile-publish-callback.test.ts tests/p730-profile-snapshot.test.ts` | 9 suites,158pass/0fail/0skip,exit0 | `raw/orv11-review/api-focused.log` |
| `du-rework/businesses/document-core`: `pnpm exec jest --runInBand tests/all-variants-e2e.test.ts` | Initial31fail/1pass,exit1; versioned envelope differed from corpus. Owner added explicit version assertion and compares unchanged business envelope. Rerun32pass/0fail/0skip,exit0. | `raw/orv11-review/document-variants.log`, `document-variants-final.log` |
| `du-rework/orchestrator`: `pnpm --filter @du/orchestrator exec jest --runInBand tests/orv11-admin-upload.test.ts` | 13pass/0fail/0skip,exit0 | `raw/orv11-review/admin-upload.log` |

These are independent executions of owner-authored focused tests. URL tests mock the shared pinned fetch; upload S3 gateway is mocked. They do not establish live S3, DNS transfer or external-provider compatibility. Document tests execute real handlers with deterministic mocked connector/artifact context.

## Browser evidence checkpoint

Verifier confirms `index-BRKI860K.js`: real backend/PG Settings save/reload and static desktop/mobile screens. Reviewer viewed settings-saved-reloaded.png and workflows-mobile.png; no clipping found. Unconditional templates “Ready To Test”/“test it right away” still misrepresents missing connector/profile configuration; copy correction requested. Workflow browser upload201 and test202 reached worker but ended LEGACY_WORKFLOW_INPUT_INVALID per verifier; UI_APPROVED withheld until fixed and rerun. Screenshot appearance cannot substitute successful workflow/HITL execution.

## Follow-up source corrections and evidence

- IR-01..09 corrected in source: ordered byte hashes; immutable subcase on revision; actual legacy waiting state/drain; exact prompt bucket; aggregate source bounds; separate historical download collection; operation/key artifact fences and upload ownership; active-profile default-prompt targets; scope invalidation. UI readiness copy corrected. Workflow test now loads artifact filenames from tenant/key-scoped metadata in submitted order and validates shared worker input before admission.
- Subsequent review found cancellation can strand a contended paused/no-worker task; owner added bounded cancellation recovery on existing timer. A second race existed between cancellation and generic expired-lease recovery; runtime now excludes signalled operations and rechecks under operation lock before retry/failure. Reviewed final source; no remaining finding in this delivered cancellation flow.
- Reviewer reran API nine suites after timestamp/usage/MIME corrections:158pass,exit0 (`api-focused-final.log`); document corpus32pass,exit0 (`document-variants-final2.log`). Discovery addition boundary+URL13pass within combined18pass log (`api-discovery-cancel-final.log`; its five cancellation tests were superseded by next run).
- Reviewer executed final cancellation tests8pass/0fail/0skip,exit0 (`cancel-recovery-final2.log`) and final DATA CJS tests54pass/0fail/0skip,exit0 (`data-offline-final.log`). Do not add repeated runs to unique coverage totals.
- Verifier real PostgreSQL operations/cancellation7pass (`reports/raw/orv11/operations-cancellation-final.log`) covers contention and expired exhausted lease; full HTTP named/schema workflow15pass (`workflow15-serialized.log`) includes inflight provider cancellation and paused wait closing. Jest reported delayed async drain, then verifier confirmed natural exit0; not claimed as clean shutdown timing.
- Verifier HTTP31 strengthened extracted_data equality against frozen corpus after UUID/time and multipart CRLF normalization (`core31-corpus.log`:31pass,3deselected). Deselected cases are separately tested, not counted as pass in that run. Deterministic loopback provider is used; no external provider quality claim.
- Verifier migration (`migration-operations-current.log`) uses five populated synthetic source rows across key/profile/operation/file tables with other source tables empty; preserved ID/old key/disabled exact policy and9MiB historical download SHA verified; replay zero new writes; invalid UTC observation denied. This establishes a bounded rehearsal slice, not a full populated customer dataset.
- Latest workflow screenshot shows file picker upload and SUCCEEDED operation with corrected readiness copy. HITL before-resume screenshot reviewed; final resume receipt awaited. UI bundle reported `index-BEftFSiZ.js`, SHA256 `2d2850ef963ca0b06cee14a97e660487d9f0a3b1fb5d4d607727fac6dc675984`.

## Scope of approvals and remaining plan gates

- **API APPROVED (delivered compatibility slice):** request discriminators/artifacts/output, exact profile selectors and preserved revisions, result projection, legacy callback body/discovery, bounded sync, stable multipart replay and source transfer protections. Last independent count/protocol suites43pass/0fail/0skip (`api-count-protocol-final.log`); business bounded input/corpus79pass/0fail/0skip (`document-count-final.log`), both exit0. Cwd/commands: orchestrator `pnpm --filter @du/orchestrator exec jest --runInBand tests/orv11-api-boundaries.test.ts tests/orv11-api-url.test.ts tests/artifact-submit-guards.test.ts`; document-core `pnpm exec jest --runInBand tests/bounded-input.test.ts tests/all-variants-e2e.test.ts`. Final source hashes cover API/OPS/runtime/normalizer in `raw/orv11-review/final-source.sha256`. HTTP and HTTPS public source URLs supported with DNS/IP guard; credentials require HTTPS and permitted origin. Twenty URLs plus multipart inputs retain compatibility through trusted server metadata; public/profile marker spoof is rejected before writes. URL/S3 external deployment behavior is not established by mocked transport tests.
- **OPS APPROVED:** public legacy read/download by ID, internal management and tenant/session/CSRF boundaries, artifact ownership, bounded encrypted admin upload, cancel/recovery changes. S3 upload behavior has a mocked gateway test; live external S3 remains deployment verification.
- **DATA APPROVED (mechanisms only):** snapshot/proof/import/replay/membership/history/blob-link and guarded activation implementation. Actual connector/global settings mappings, old-user reset/login journey, external provider identity, legacy retry-window fence, production-scale memory/locks/time, customer timezone and full data reconciliation remain required before cutover.
- No broad settings diff/test/apply/rollback approval: delivered UI supports effective deployment reads and validated core connection `_default` prompts only. Workflow/step/global settings and deployment changes still need their explicit authoring/mapping work.
- Operator HITL remains schema + JSON response; a guided field-level review form and complete shift-operation journeys are further usability work. This limitation must remain visible in plan status rather than marking P06/P07 fully accepted.

## Final exact-build UI and integration acceptance

- Independently inspected verifier final raw `reports/raw/orv11/independent-final44.log`: four suites, **44/44 PASS**, exit0 reported by verifier. This combines strengthened HTTP core corpus, browser, synthetic migration and operations/cancellation; it overlaps earlier runs and must not be summed as unique additional coverage. Separate full workflow suite remains15/15PASS.
- Actual loaded script in `reports/raw/orv11/browser/journey.json` is `index-D6Ow5y8y.js`; reviewer independently hashed local built artifact: **720734c2f44234474d0cef5fbcfcf94c6677ee3fa80aea1bd6700f3a134492dd**. Desktop/mobile route captures report no overflow or browser errors.
- Reviewer inspected fresh `workflow-upload-executed.png` and `operation-hitl-resumed.png`: selected active key and file picker upload201→submit202→SUCCEEDED; real human-wait resume200→workerSUCCEEDED, preserved detail and result download control. Matching JSON execution receipts identify the same operations. Reviewed final resume code: scope checked after action/list refresh before reopening detail.
- Settings save/reload has real backend audit and a subsequent public submission; browser test opens the encrypted `operations.prompt_overrides_ref` carrier and asserts the saved prompt is present only after decryption. This demonstrates effective propagation beyond display-only persistence.
- **UI_APPROVED for these delivered journeys**: scoped default prompt editing, effective deployment reads, actual workflow upload/test/poll, human-wait JSON response/resume and result detail. This does not approve whole P06/P07 or general operator usability: advanced JSON input remains, list/detail refresh can show different snapshots, and workflow/global configuration diff/test/apply/rollback plus guided domain review forms remain explicit follow-up work.
- No unresolved blocking defect found in the reviewed delivered slice. **Full-plan completion and production/customer migration remain NOT ACCEPTED** until the remaining plan and deployment/data gates above are satisfied.
