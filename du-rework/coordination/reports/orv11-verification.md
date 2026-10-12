# ORV11 independent verification

Executor: `/root/verification`. Scope: independent tests and isolated infrastructure, no product-source edits. Base HEAD `7e36a1e`; uncommitted owner implementation tested. Status: **independent functional verification PASS for the implemented slice**; no production cutover acceptance.

## Reproduction and environment

All commands below use cwd `/workspace/dugate/du-rework`, Node **24.21.0**, pnpm **10.18.3**. Official Node archive checksum verified. Proxy and CA/TLS policy preserved; managed environment/Docker instructions read. No customer credentials or paid provider calls used.

```sh
export PATH=/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin:/workspace/scratch/orv11-toolchain/node_modules/.bin:$PATH
export NODE_PATH=/workspace/dugate/du-rework/node_modules/.pnpm/node_modules
node node_modules/.pnpm/node_modules/jest/bin/jest.js --config tests/workflow-api/jest.config.cjs --runInBand <files>
```

Dedicated PostgreSQL16 container `orv11-vfy-postgres`, loopback55498; Redis7 `orv11-vfy-redis`, loopback56398; per-suite unique PG schemas and scratch artifacts. Final suites serialized because existing test infrastructure hashes Redis DB into a finite range. Interrupted overlapping diagnostic attempts are preserved and are not final verdicts. Chromium `/usr/bin/chromium`, Playwright1.63. No mocked browser backend.

Install `pnpm install --frozen-lockfile`: exit0,654 packages; shared six packages and Connector builds exit0. Raw `reports/raw/orv11/{install,shared-build,connector-build}.log`. Final `pnpm --filter @du/contracts build` completed without diagnostics (`reports/raw/orv11/contracts-final-build.log`); `pnpm --filter @du/orchestrator build` independently exit0 (`reports/raw/orv11/orchestrator-final-build.log`). No intentional lockfile/engine/manifest changes; final scoped git status empty for both workspaces’ lockfiles/manifests. Removed only pnpm11-generated allowBuilds placeholders with coordinator authorization.

## Independent results

| Receipt | Result | Evidence |
|---|---|---|
| Final four independent suites | **44 passed, 0 failed, 0 skipped**, exit0,20.89s | `reports/raw/orv11/independent-final44.log`; exact command below. |
| HTTP workflow lifecycle `http-worker.integration.test.ts` | **15 passed**, exit0 | `reports/raw/orv11/workflow15-serialized.log`; real worker/Connector/PG/Redis, named/schema workflows, restart, cancel provider abort, human resume. Jest printed >1s handle warning then naturally exited0; no forceExit. |
| Operation routes and cancellation `orv11-vfy-operations.test.ts` | **7 passed**, exit0 | `reports/raw/orv11/operations-cancellation-final.log`; retired public management404 with keys/admin; own result/download200 vs same-tenant/cross-tenant404; internal listener/admin/session/RBAC/CSRF/tenant; real locked-task cancel then recovery; expired exhausted lease cancellation; closed waits and one webhook. |
| Initial importer CJS independent run | **51 passed**, exit0 | `reports/raw/orv11/ldba-03-offline.log`; owner later added coverage, do not conflate with independently rerun count. |
| HTTP admission baseline | **5 passed**, exit0 | `reports/raw/orv11/baseline-http-admission.log`; pre-handoff diagnostic baseline only. |

Final command uses the reproduction prefix above followed by these four files, in one serialized Jest invocation:

```sh
node node_modules/.pnpm/node_modules/jest/bin/jest.js --config tests/workflow-api/jest.config.cjs --runInBand tests/workflow-api/orv11-vfy-core-worker.test.ts tests/workflow-api/orv11-vfy-browser.test.ts tests/workflow-api/orv11-vfy-migration.test.ts tests/workflow-api/orv11-vfy-operations.test.ts
```

Final browser bundle **index-D6Ow5y8y.js**, SHA256 **720734c2f44234474d0cef5fbcfcf94c6677ee3fa80aea1bd6700f3a134492dd**. Actual loaded path recorded in `reports/raw/orv11/browser/journey.json`; screenshots and workflow/HITL JSON in same folder. Full source/test/bundle hashes captured in `reports/raw/orv11/final-source-hashes.json`. UI owner built actual bundle; independent browser tests served it through the real admin shell. Backend tests execute current TypeScript sources through ts-jest, not a stale application image.

Final independent files: `tests/workflow-api/orv11-vfy-{core-worker,browser,migration,operations}.test.ts`, corpus fixture `orv11-vfy-variant-fixtures.ts`.

Core31 drives multipart HTTP admission → PostgreSQL outbox → Redis → real document-core worker → real Connector with deterministic loopback provider → public legacy result. Assertions compare projected extracted_data to expected corpus; UUID/time normalization and standard multipart CRLF normalization only. Version-mode compare expects original provider result per legacy semantics. MockTaskContext is used only to construct fixture bytes, never as execution runtime. Additional cases verify exact parse/download bytes, sync completion, replay without extra blobs, and artifact key ownership. This is synthetic provider compatibility evidence, not live commercial model quality/cost validation.

Migration rehearsal creates all nine source tables, with nonempty ApiKey, Operation, FileCache and two ProfileEndpoints. Native PG timestamp-without-time-zone source; missing proof blocks with zero key writes; valid snapshot-bound UTC evidence applies; fresh adapter replay produces zero writes; altered UTC observation rejects. Applies actual migrations including0044/0045. Legacy key reads imported history and exact9MiB output SHA256; disabled endpoint rejects403. Raw JSON `reports/raw/orv11/migration/`.

Browser exercises built SPA against real BFF/backend/PG/Redis: settings/workflows/operations1440px and390px, no horizontal overflow or page errors; prompt save/reload/audit, then public submission and decryption assertion proving sealed prompt override carrier; filepicker upload201 → workflow.test202 → worker/pollSUCCEEDED; OPEN human wait JSON answer → internal resume200 → workerSUCCEEDED, retained detail and exact operation ID after list refresh, then Refresh detail and final state screenshot. Signed synthetic admin session bypasses interactive login. JSON HITL remains a technical operator interaction, not a domain-specific form.

## Scope limits

- No customer snapshot, storage inventory, real source timezone proof, production-scale duration, or production cutover. Synthetic rehearsal is not migration acceptance for customer data.
- Independent real PG fixture does not include encrypted connector/schema replay, imported local-user activation/login, external provider identities, or all nine populated source tables; owner unit coverage is separate evidence.
- Artifact path tested uses local encrypted PostgreSQL fallback, not live S3 or object gateway.
- No paid/live external AI provider calls; URL DNS/egress policies and delivery to external callback receivers are not end-to-end network proof here.
- Measured usage/cost pipeline is not validated when usage remains pending; null pending values are not evidence of zero costs.
- Browser session is synthetic admin; session scope/RBAC/CSRF negatives tested separately over HTTP. No claim of production SSO/login or usability study.

Earlier red receipts remain for traceability: named-profile403 (missing membership), settings action422, workflow missing filenames, provider cancel timeout, strengthened corpus fixture discrepancies, and disappearing detail after resume. Latest final44 confirms the owner fix retains detail. Fixes are by source owners; final receipts supersede only the affected assertions actually rerun. Deselected tests are not passes or acceptance.
