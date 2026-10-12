# VFY-UI13 independent verification

Status: the independent Admin API and mounted-browser suite passes on the final rebuilt admin bundle. After the reviewer reopened the >100 tenant-roster acceptance item, a separate focused mounted-browser run also passed the new roster-pagination case; it is reported separately from the original 14-case run. Compose host/API/UI evidence is owned by the separate VFY-UI13-COMPOSE lane and is not included here. Overall ORV13 acceptance remains open pending that receipt and the reopened reviewer verdict. The Compose verifier exposed an actual preview-path `502` and then an inventory-parser `UNKNOWN`; backend/host owners refroze the relevant corrections, and the main verifier rebuilt the orchestrator after the latest refreeze. The Compose tester owns actual post-fix proof in that lane.

## Environment and provenance

The final independent run started at 2026-10-11 18:31:27 UTC and completed in 25.1 seconds. It used Node `v24.21.0`, Chromium `154.0.8037.57`, the repository Jest workflow API config, a fresh per-run PostgreSQL schema on the dedicated test-only loopback service (`127.0.0.1:55498`), a test-only Redis database on loopback (`127.0.0.1:56398`), and actual loopback HTTP listeners for the public API, internal API, Admin shell/BFF, and synthetic callback receiver. The harness enforces loopback URLs and a random isolated schema/Redis database; it used no customer database, production credentials, paid provider, or pre-existing container stack. The run-specific random schema identifier and Redis DB number were not emitted by the final test log, so they cannot be reproduced from this receipt. Isolation allocates a per-run schema, Redis DB 1–14, prefixed Redis/queue namespaces, and scratch directory per [`namespace.ts`](../../tests/isolation/namespace.ts); the raw final run log and request/artifact locators are linked below. Test teardown in the verifier source closes the app/receiver, drops only `isolation.context.dbSchema`, closes the base DB handle, and removes only `isolation.context.artifactDir`; it does not issue global `TRUNCATE`, Redis `FLUSHDB`, or Docker cleanup. This is the teardown recorded in the verifier source, not a claim that a global Redis database was flushed.

The admin-web build ran with Node `v24.21.0`; `tsc --noEmit -p tsconfig.json` and Vite production build both exited 0. The only build output warning was Vite's existing 500 kB chunk-size advisory. The source change relevant to the final mobile evidence is `operations-screen.tsx` SHA256 `0720c59fb00283cb8066d3b0941495fe9a5d17eb7964411d51b107f11751b5eb`.

| Served artifact | SHA256 |
| --- | --- |
| `orchestrator/apps/admin-web/dist/index.html` | `c8deadba1b4b81476d7e295053ca4c300a31196fc99fa638418b14587a1d9184` |
| `orchestrator/apps/admin-web/dist/assets/index-BO7-bJEd.js` | `8e55dd6148ae91b2c18e38c4a4176742e574894bbadb36a407ce0f9ddc7c3e6a` |
| `orchestrator/apps/admin-web/dist/assets/index-B-iqGBQY.css` | `25ea028bbccf360d53be25daa6a8fc471e85fcda123620d9d9437ada77339d4f` |

Chromium's actual `200 text/javascript` response at `/admin/assets/index-BO7-bJEd.js` hashed to `8e55dd6148ae91b2c18e38c4a4176742e574894bbadb36a407ce0f9ddc7c3e6a`; an authenticated direct HTTP fetch and the local dist file produced the same digest. The result is recorded in [callback-browser.json](../../reports/raw/orv13-vfy/admin-ui/callback-browser.json). An earlier harness-only, unauthenticated Node fetch followed the Admin login redirect and hashed its final response; that misleading hash was not used as served-bundle evidence and is preserved in the earlier callback run log.

The independent test source is [orv13-vfy-admin-ui.test.ts](../../tests/workflow-api/orv13-vfy-admin-ui.test.ts), SHA256 `96d67b5815d4673db7325b06efb7cc1e380ec04995532c8a2c6e1171e5930250`. The BASIC projection source exercised by its API cases is `usage.ts`, SHA256 `68277ad4a9dc4a872d47cbb5eeb95d9ba44ac2311edfd898872d4ebaaaa22349`.

## Final independent run

Command:

```sh
cd /workspace/dugate/du-rework
env PATH=/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin:$PATH \
  NODE_PATH=/workspace/dugate/du-rework/node_modules/.pnpm/node_modules \
  /workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node \
  node_modules/.pnpm/node_modules/jest/bin/jest.js \
  --config tests/workflow-api/jest.config.cjs --runInBand \
  tests/workflow-api/orv13-vfy-admin-ui.test.ts
```

Result: **1 suite passed, 14 tests passed, 0 failed, 0 skipped**. Raw output: [admin-ui-final-bundle-full-rerun.log](../../reports/raw/orv13-vfy/admin-ui/admin-ui-final-bundle-full-rerun.log). This independent total excludes every owner-suite result.

| Evidence | Independent scenario and result |
| --- | --- |
| VFY-UI13-API-01 | Actual persisted producer events through BASIC_ADMIN_USAGE_V1: keyset paging, operation attribution, tenant/window cursor binding, admin/viewer authorization; passed. |
| VFY-UI13-API-02 | Three malformed persisted usage rows are skipped and counted rather than failing the page; passed. |
| VFY-UI13-API-03 | Actual PostgreSQL limit-1 cursor paging across malformed data and `.000001/.000002/.000003` received-time boundaries; rows appear once and the cursor exhausts; passed. |
| VFY-UI13-API-04 | Real BFF settings write role gate prevents unauthorized revision creation; passed. |
| VFY-UI13-API-05 | Real BFF terminal operation deletion checks CSRF, state, and tenant fence, then records one audit row; passed. |
| VFY-UI13-UI-06 | Mounted Usage tenant/window race: actual BFF response for tenant B renders, a held actual tenant-A response arrives late without replacing it, invalid window draft is rejected, and viewer gets real 403. Keyboard skip link/main focus and scrollable ledger region were exercised at 320 px. Passed. Request bounds and persisted received-at values are in [usage-browser.json](../../reports/raw/orv13-vfy/admin-ui/usage-browser.json); race diagnostics are in [usage-ui-race-diagnostics.json](../../reports/raw/orv13-vfy/admin-ui/usage-ui-race-diagnostics.json). |
| VFY-UI13-UI-07 | Mounted Settings exposes exactly the 31 core endpoint choices and preserves validated draft after an actual BFF apply conflict; passed. |
| VFY-UI13-UI-08 | Mounted Settings fences a late tenant-scoped read and leaves operator/viewer controls read-only; passed. |
| VFY-UI13-UI-09 | Mounted cockpit scopes incident rows by tenant, reports missing worker/source information honestly, and preserves last-good content after a presentation-only injected 503; passed. Baseline health, workers, operations, and metrics responses were actual BFF responses; only the later stale-display fault was route-injected, so this is not separate outage/API proof. |
| VFY-UI13-UI-10 | Mounted Operations deep-link, Back/Forward restoration, keyboard-confirmed terminal DELETE, soft delete and audit; passed. On the final bundle the “Download result” link measured 100.39 × 20 px, stayed on one line, and fit at 390 and 320 px. |
| VFY-UI13-UI-11 | Mounted workflow tenant operator sees read-only catalog controls; a viewer's catalog request is denied; actual viewer write returns 403. Concurrent revision publish makes stale admin CAS return 409 while preserving the draft and revision rows; passed. |
| VFY-UI13-UI-12 | Mounted callback retry inspects the accessible confirmation, submits with Enter, retries the same delivery ID/payload, and uses the actual dispatcher plus local synthetic HTTP receiver. Delivery reaches `DELIVERED` at attempt 5; operation/task/usage rows remain unchanged; passed. |
| VFY-UI13-UI-13 | Mounted shell receives an actual cookie/session 401, pauses protected reads and mutations, preserves the nonsecret draft, recovers after explicit verification of the same fingerprint, and remains locked after verification of a changed scope until reload; passed. |
| VFY-UI13-TRANSPORT-14 | Shared client confirmed-401 latch blocks other client instances and stops CSRF-protected mutation after CSRF acquisition returns 401; passed. This is Node client/transport coverage, not mounted-browser authentication evidence. |

## Incremental tenant-roster acceptance evidence

Following reviewer finding IR13-09, a separate focused browser invocation passed one new unique case against the same final frontend bundle. It created 125 ACTIVE tenant rows in that invocation's random isolated PostgreSQL schema, yielding 127 rows total with the two base fixtures. A single 503 was injected into the first roster request: the mounted selector showed the explicit error and Retry control, with no empty-roster fallback. Retry then used the actual Admin BFF for both pages (`limit=100`: 100 rows followed by 27 rows and a cursor). The saved tenant at combined index 126, beyond the first page, became the selected option and remained in local storage after changing to another tenant and back. Actual BFF Usage requests returned no fixture event for tenant A and returned the fixture event only under the selected page-two tenant. This roster fault was injected in the browser harness; roster pagination and both tenant-scoped Usage responses were actual loopback BFF/API/PG traffic.

Focused command from `/workspace/dugate/du-rework`:

```sh
env PATH=/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin:$PATH \
  NODE_PATH=/workspace/dugate/du-rework/node_modules/.pnpm/node_modules \
  /workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node \
  node_modules/.pnpm/node_modules/jest/bin/jest.js \
  --config tests/workflow-api/jest.config.cjs --runInBand \
  --testNamePattern='mounted tenant roster retries truthfully' \
  tests/workflow-api/orv13-vfy-admin-ui.test.ts
```

Result: **1 passed, 14 skipped by the explicit test-name filter**. This is one additional unique case, not a rerun or expansion of the original 14-case run. Raw Jest output and structured browser evidence are [tenant-roster-focused-accepted.log](../../reports/raw/orv13-vfy/admin-ui/tenant-roster-focused-accepted.log) and [tenant-roster-pagination-browser.json](../../reports/raw/orv13-vfy/admin-ui/tenant-roster-pagination-browser.json). The injected-error screenshot is [tenant-roster-retryable-error-desktop-1440.png](../../reports/raw/orv13-vfy/admin-ui/tenant-roster-retryable-error-desktop-1440.png); the recovered selected page-two usage view is [tenant-roster-page-two-usage-scope-desktop-1440.png](../../reports/raw/orv13-vfy/admin-ui/tenant-roster-page-two-usage-scope-desktop-1440.png). Their SHA256 digests are `8e5354e0fe8374de7888621cf63f13824d0b19f582057324c7f0d187d781830b` and `535c5f61e053d44514457ffc8f36bcced2e1116f20032a98297ac6f501baa046`, respectively. Chromium's actual `200` script response in this invocation matched the final bundle SHA256 `8e55dd6148ae91b2c18e38c4a4176742e574894bbadb36a407ce0f9ddc7c3e6a`.

Earlier focused roster attempts are retained as raw verifier artifacts and excluded from the accepted result: the first fixture left `received_at` at the current minute, outside the UI's exclusive default minute boundary; after moving only that isolated row back two minutes, later attempts exposed response-listener timing assumptions in the test. The final harness waits for actual response parsing and selects away/back before evaluating usage scope. No product code or bundle changed for this supplemental case.

## Mobile evidence and earlier harness corrections

The final exact-bundle populated operation detail screenshots are [operations-detail-mobile-320.png](../../reports/raw/orv13-vfy/admin-ui/operations-detail-mobile-320.png) and [operations-detail-mobile-390.png](../../reports/raw/orv13-vfy/admin-ui/operations-detail-mobile-390.png). The callback detail screenshots are [callback-delivered-mobile-320.png](../../reports/raw/orv13-vfy/admin-ui/callback-delivered-mobile-320.png) and [callback-delivered-mobile-390.png](../../reports/raw/orv13-vfy/admin-ui/callback-delivered-mobile-390.png). I visually inspected both widths: “Download result” is fully legible as a single horizontal label between neighboring actions. Rectangles are 100.39 × 20 px, `white-space: nowrap`, with no horizontal document overflow. The callback journey also exercised 768 px; cockpit, settings, and usage browser journeys covered 1440/768/390/320 as recorded in their raw JSON/screenshots. This supplies final-bundle evidence for reviewer finding IR13-10; reviewer acceptance is still pending.

The retained final screenshot hashes are:

| Screenshot | SHA256 |
| --- | --- |
| `operations-detail-mobile-320.png` | `34e1e48b34a780efa70afae067ad6a67b93c3ea9ea51ea5afee6629d0aa52aa9` |
| `operations-detail-mobile-390.png` | `b209626cf590f28f5c497a68b23ed15d9e97f797e872ea3f07ed4b8f0d8df9ee` |
| `callback-delivered-mobile-320.png` | `9166c12dd6b509be7bd46be0bb8da5fb11024cefb049293a179ed87e86ee24ec` |
| `callback-delivered-mobile-390.png` | `7841c6da9b941a26f3c4d8877e314c51702169e5f9c38f05ab5f5971909d923b` |

The pre-fix unreadable callback screenshot was not copied before the final run overwrote that same filename; no separate old PNG backup exists in this verifier namespace. The old pixels therefore cannot be re-linked or restored. The original reviewer finding and reference path remain in [orv13-ui-review.md](orv13-ui-review.md#ir13-10-remainder-medium), and the pre-fix served bundle was `index-Db7WOGsG.js` SHA256 `aa214d16968a15f183cc75bee734e0aeadc2f2866f98e20829d0ddb5b4a9ea62`. The corrected source SHA remains in [mobile-source-sha256.txt](raw/orv13-journeys/mobile-source-sha256.txt). The final fixed screenshots are retained at the links above; I did not recreate the prior build or image.

Earlier raw failures are retained and excluded from product-failure totals:

- `admin-ui-final-bundle-full.log` and `usage-ui-final-bundle-diagnostic2.log`: the first Usage fixture inserted `received_at` after the page's exclusive default “To” boundary, so the actual BFF correctly returned 200 with no rows. The verifier now moves only its isolated fixture rows to `now() - interval '2 minutes'`; no product default changed.
- `usage-ui-final-bundle-pass.log` / `usage-ui-final-bundle-pass2.log`: after correcting the window fixture, a selector ambiguity/keyboard-focus setup assumption failed. The final harness uses a fresh mounted tab for first-Tab skip-link behavior and selects the first real “Access denied” heading. Final full rerun passes.
- `workflow-operator-cas-mobile-final.log`: the read-only operator catalog has both immutable revisions with the same slug; the broad slug regex matched two rows. The verifier now selects revision 2 explicitly and the final CAS/viewer test passes.
- `callback-mobile-final.log`: the prior secondary script-hash step followed a login redirect because it lacked a cookie. The final harness hashes Chromium's actual script response and performs an authenticated fetch, both matching the frozen local asset.

The first final-bundle full run had 13 passes and the Usage fixture-boundary failure; it is retained as [admin-ui-final-bundle-full.log](../../reports/raw/orv13-vfy/admin-ui/admin-ui-final-bundle-full.log). Only the verifier fixture/selectors changed before the final green run. No product source changes were made by this verifier.

## Orchestrator artifact handoff

After the latest Compose backend and host-executor refreezes, `tsc -p tsconfig.json` exited 0 with Node `v24.21.0` from `/workspace/dugate/du-rework/orchestrator/services/orchestrator`. The Compose verifier received the current imported service and host-executor artifacts; it must use these source pairs because the CLI entry hash alone did not change. The build command was `env PATH=/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin:$PATH ./node_modules/.bin/tsc -p tsconfig.json`.

| Artifact | SHA256 |
| --- | --- |
| `dist/compose-operations-runner-cli.js` | `87603259d0687f77c8a5388350f62aa1e2d4554c6a9cd306c1103d335ecdbfd6` |
| `dist/modules/compose-operations/service.js` | `ae86f2cb4183b6d6dff0ced9fedab6639d11cb11cd68821dcff76bc9d5043932` |
| Frozen `src/modules/compose-operations/service.ts` | `6956072ce71e732eb4f9823242cd0914017e4127de483d61df8defba6ad6b55d` |
| `dist/modules/compose-operations/host-executor.js` | `fa06b4d9a3d8c26a047aad552920a6663dcd1962be8ae262d15884e36bba8670` |
| Frozen `src/modules/compose-operations/host-executor.ts` | `e086ff4213652ba349105a1d633ad1eda9315940b4af7acc41cb064bee10af52` |

The separate Compose tester owns actual PG/CLI/host/UI results and its own receipt. No Compose project or Docker container was created by this main verifier lane.
