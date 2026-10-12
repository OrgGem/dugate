# ORV14 independent UI preliminary review

Reviewer: `/root/orv14_ui_review`. Packet: `REVIEW-ORV14-UI-PREFINAL`. Date: 2026-10-12 UTC. **Verdict: CHANGES_REQUIRED; final UI acceptance remains open.**

This review reads the shared dirty tree at HEAD `7e36a1e4460d88661a2a74b4ad39296c9d5f68f3`, canonical CFGADM/AOPS/COST requirements, the ORV14 architecture review, original Workbench/Parity receipts and guide, and independent private UI receipts a44–a49. Product source, tests, build outputs and resources were read-only. No test, build, provider request, dependency installation, service or database operation was performed. Only this report was written. Current source hashes below identify preliminary observations; they are not a final full-tree freeze or final served-bundle acceptance.

## Finite prioritized source findings

Paths are relative to `du-rework`. Original owners identify the source handoff; **current fix owner is solely `/root/orv13_backend` under the coordinator's central/UI lease**. Independent checks belong to `/root/orv14_verification`, not the reviewer or fix owner. The first four findings were sent promptly to root.

### UI14-P01 — HIGH — Docs Test Endpoint and Wizard lose uncertain submission identity

**Expected:** A lost HTTP acknowledgement after admission retains the exact request and idempotency identity. Rechecking must discover/replay that operation rather than submit another paid request. This follows the architecture's no-repeat rule for uncertain provider effects and the Workbench's admitted operation contract.

**Actual:** `orchestrator/apps/admin-web/src/features/docs/docs-screen.tsx:836` retains a fingerprint/key, but line **840** clears it for every non-OK result; Wizard does the same at **883–887**. The shared client explicitly resolves failed fetches as `{ok:false,status:0}` at `orchestrator/apps/admin-web/src/lib/api/client.ts:567`. Thus the normal transport-loss branch clears the key; the next unchanged submission creates a different UUID. The UI's exception handler wording to check Operations does not protect this ordinary non-throwing client branch. A server that already accepted the first request can accept the second under its new key.

**Producer/consumer:** Docs request/key → client non-throwing transport envelope → `modules/admin-workbench/service.ts:150,205` → `modules/operations/submission.ts:706–732` tenant/key/route idempotency. Original owner: **ORV14 Workbench/Journeys**. Docs hash: `c3d934163290cc998ecb5bb998a060a0f86c86cf9503a4f84a89c6ba0afd570f`; client hash: `5517e43518e1cca4756956ae06e82efbac6c0aa77b6122cdb5c7e4fdbbfc9a06`.

**Narrow independent check:** For Test Endpoint and Wizard separately, let the real server accept the POST, then discard its response. Recheck unchanged request with the retained key. Assert one operation, one provider invocation/reservation identity, unchanged uploaded artifact IDs and replay of the original operation ID. Include a returned uncertain 5xx as well as status-0 transport loss. Proven final rejection may permit a new attempt; uncertain outcomes must preserve the attempt.

### UI14-P02 — HIGH — Connector test has no recovery identity when its response is lost

**Expected:** The exact request/key must be retained before dispatch, so an uncertain provider test always uses the server's existing-run/evidence recovery path.

**Actual:** `orchestrator/apps/admin-web/src/features/connectors/parity-connector-editor.tsx:483` allocates a fresh key inside each Run click. At **487–491**, it stores `reconcileRequest` only after an OK response that explicitly reports UNKNOWN. A non-OK status-0/lost response returns at **488** with no retained request, leaving Run enabled; another click uploads files again and allocates a new provider-test identity. The original external effect can already have completed.

**Producer/consumer:** Parity test request → client transport envelope → `modules/connectors/provider-test.ts:583–587` exact-key existing-run lookup → provider invocation at **721**. The server's safe recovery at **514–562** only works if the UI reuses the original key/body. Original owner: **ORV14 Parity**. Editor hash: `3ba483e5506bc924997c6690ee155a824ac7744a361dd2f395723c14a1608f07`; provider service hash: `e36911e29c3d27027156c54c6ed6f8d40a145ea71a9df0ff2a1209cfe5691818`.

**Narrow independent check:** Real exact-revision test with a file; drop the first response after the mock provider records invocation. UI must retain/show the uncertain attempt and reconcile the same body/key/artifact IDs. Assert exactly one provider call, synthetic run, usage event and reservation group. Also switch tenant while uncertain: never reconcile the old request under the new tenant view (P04).

### UI14-P03 — HIGH — Workflow file retry changes the payload behind its retained key

**Expected:** Retrying an uncertain workflow execution preserves both the submitted artifact references and its idempotency key.

**Actual:** `orchestrator/apps/admin-web/src/features/workflows/workflows-screen.tsx:823–828` uploads every selected local file on every Run click. The action fingerprint/key at **830–835** uses local file name/size/lastModified, not uploaded artifact IDs. After a non-OK or lost result, that key remains cached. The next click uploads new artifact IDs and posts those new IDs with the same old key at **836–843**. The submission hash includes `submission.input` and `submission.artifacts` at `modules/operations/submission.ts:706–714`; the existing record rejects the changed request at **725–730**. The unchanged user retry therefore cannot replay its original accepted execution; repeated clicks also create additional uploads. This differs from P01/P02: the retained key is correct, but the retained payload is not.

**Producer/consumer:** Workflow local files → upload IDs → `modules/workflow-test/workflow-test.ts:83–85` → strict submission hash/replay. Original owner: **ORV14 Workbench/Journeys**. Workflow screen hash: `8ef3ee1f00817f61844bb3255cec1a64b2b6d8a1b0f391ae7fc97d1f28212fac`; workflow-test hash: `777b93d7e01eb9115da1d67dc717f36695e2c5e3a93b1859bb106b917a9ae1e6`; submission hash: `f8093a5fb53f2349ae4c61a3e4fabb06cf5ddd0fbe22e6385f5b50d3d35ecebf`.

**Narrow independent check:** File-bearing schema-workflow; accept first POST and lose its response. Second unchanged Run must reuse first uploads and key, replay the same operation and produce no IDEMPOTENCY_CONFLICT or new upload. A genuine edited request must use a new attempt. Verify partial upload failure also preserves already completed uploads safely.

### UI14-P04 — HIGH — Connector editor carries tenant A state into tenant B

**Expected:** Tenant changes clear sensitive/action state and fence every asynchronous result. Tenant A's recipe, replacement credential, test result, assignments and uncertain request must never be shown or submitted under tenant B.

**Actual:** `features/connectors/connectors-screen.tsx:305` mounts `<ParityConnectorEditor />` without a tenant key. In `parity-connector-editor.tsx:223–231`, the tenant dependency reloads Profile choices but never resets `loadedRevision`, recipe, replacement credential, expected-head base, result, selected files or `reconcileRequest`. `loadProfileChoices` at **192–211** has no generation/cancellation guard; a late A response can overwrite B's choices. `loadRevision` at **352–363** compares the returned tenant to the closure's captured A tenant, so it still accepts late A data after the selector changes to B. `saveDraft` at **386–399** then uses the current B tenant with the retained A recipe/credential/base. A matching Connector chain/CAS revision in B can make this an unintended cross-tenant configuration/credential write by an otherwise authorized platform Admin. This is UI scope contamination, not a claimed server authorization bypass.

Original owner: **ORV14 Parity**. Editor hash: `3ba483e5506bc924997c6690ee155a824ac7744a361dd2f395723c14a1608f07`; parent screen hash: `f28d31798041370d1969cdc66629e936577d1a22b41483e4e64275d6e72028a3`. Client auth-epoch fencing protects session changes, but tenant selection does not advance that auth epoch.

**Narrow independent check:** Two tenants containing the same Connector ID/head revision. Load A and enter a replacement credential; change to B, then attempt Save. No A data/credential may reach B. Separately delay A's Profile/revision/test responses until after B's responses and assert all late A setters are ignored. B load failure must display unavailable state without retaining A data. No secret values need be logged in the receipt.

### UI14-P05 — MEDIUM — Required ordinary workflow override controls are incomplete

**Expected:** CFGADM-09 common node override tasks include prompt, static form fields, extra headers, response path and timeout; AOPS01/09 requires common tasks through forms. Canonical `tasks/ADMIN-LEGACY-CONFIG-PARITY-2026-10-04.md:98` explicitly names these override fields. A graph drag-and-drop editor remains an enhancement.

**Actual:** `features/workflows/workflows-screen.tsx:1665–1718` offers prompt, timeout and response path only. Static fields and extra headers require editing the entire Advanced JSON schema (**1724–1730**). Their wire fields already exist at `packages/contracts/src/legacy-workflow.ts:38–39` and their runtime compilation is present in `businesses/document-core/src/pipelines/workflows/schema/legacy-schema-runtime.ts:450,815`; this is a missing UI consumer, not a missing provider capability. `features/workflows/revision-editor.ts` exposes only the currently guided override subset. JSON can preserve/use these fields, so this finding does not claim that execution loses them.

Original owner: **ORV14 Workbench/Journeys**. Screen hash as P03; revision-editor hash: `9f047b12d70168ac2bd03ec36aebb9f0695674430f17f4d27eebbaf913e80842`; contract hash: `5824e39d02a81d731745b1dcf8a124003f9d53ec666745bc1be3849830880660`.

**Narrow independent check:** Import a workflow with existing static fields/headers, change one using bounded labeled controls, review diff and CAS publish, and verify exact actual mock-provider fields/headers. Preserve sibling node overrides and original running revision. Secret/unsafe header rejection must remain server-owned. No graph designer or wholesale DSL builder is requested.

## Evidence inspected and limits

- a44/a45/a49 finance receipts, provenance, hashes and sanitized DOM/axe context were inspected. The a49 320px dark screenshot was viewed directly; it keeps finance controls readable in a single column. The known tablet/mobile `scrollable-region-focusable` failure remains the already routed CostPolicyPanel issue; it is not duplicated as a new finding here. a49 completed all eight width/theme pairs with page-overflow zero; 1440px pairs had zero serious/critical axe violations. Its source manifest hash is `6b7380345f86b8e766fe3cc8eeb8bcc5e016324753ed8b1e835fd30bc20a23e4`, disk JS `index-CFuH9YA8.js` hash `5e4e18179e093adc1e0406acb3f2d1ed6d743e17bb4eb4557c2425f3bae6c762`, CSS hash `92006febb16bbac37d0f3342e6c4338f0eb25be38f1d2cc010b912aaead00eeb`. a49 explicitly lacks independent served-response JS SHA due to failure before its success logger; disk hash/path mounting is not overstated as response-body proof.
- a46–a48 Profile→Docs handoff screenshots were viewed directly, including exact current Profile/revision and assigned USER/key view. Their source pins match the inspected Docs hash above. The six distinct contract states are useful scoped evidence: current handoff, draft protection, foreign tenant, stale revision, direct URL/reload, USER assignment and Viewer denial as reported. API responses were intercepted; these artifacts do not demonstrate the real BFF/PG assignment conjunction or a paid-provider invocation.
- The screenshot showing Prompt Wizard unavailable belongs to an extract-only Profile without its required binding. That presentation is correct and is not treated as missing Wizard implementation. The six-action delegated Workbench source and real assigned/Profile/key server checks exist; the four HIGH findings concern retry/scope edges outside the current UI slices.
- Workbench and Parity owner receipts document source delivery and owner smoke, not independent final acceptance. Five finance functional UI cases passed in the intercepted-API slice; real PG finance evidence is separate. Their counts are not added to rerun totals or used to accept unrelated settings, host maintenance, restore, HA or full workflow execution.

The finite source correction list is P01–P05 plus the already tracked CostPolicyPanel scroll-region correction. Final approval requires the coordinator's final source/import manifest and exact served full bundle, independent affected checks above and complete required final UI journeys. This report issues **no APPROVED/UI_APPROVED verdict**, creates no new blanket testing demand and changes no canonical task status.
