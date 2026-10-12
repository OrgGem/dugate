# Independent VFY-UI13-COMPOSE verification receipt

**Result:** frozen Compose host/API/UI chain passed the full independent run (2 named scenarios, 2 passed, 0 skipped). A focused mobile follow-up passed the first scenario (1 passed; the second was deliberately filtered). No product source, package, docs, build, or shared `dist` files were edited here.

Run from `/workspace/dugate/du-rework` on branch `codex/fix-workflow-builder`, 2026-10-11 UTC. The full command returned **exit code 0**; its test log spans the first fixture timestamp `19:01:56.687Z` through the final logged API event at `19:02:48.216Z` (Jest elapsed 57.468 s). The focused follow-up returned **exit code 0**; its log spans `19:14:02.705Z`–`19:14:52.890Z` (Jest elapsed 54.999 s). Both commands were wrapped to propagate Jest’s exit status. The full command was:

```sh
NODE_PATH=/workspace/dugate/du-rework/node_modules/.pnpm/node_modules \
  /workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node \
  /workspace/dugate/du-rework/node_modules/.pnpm/jest@29.7.0_@types+node@24.19.1/node_modules/jest/bin/jest.js \
  --config tests/workflow-api/jest.config.cjs --runInBand \
  tests/workflow-api/orv13-vfy-compose-host.test.ts
```

The full run output is [jest-final-run.log](../../reports/raw/orv13-vfy-compose-host/jest-final-run.log). After the mobile scroll evidence was added, the focused command used the same config and paths plus `--testNamePattern 'root-trusted manifest and actual Compose CLI'`; its output is [jest-focused-mobile-run.log](../../reports/raw/orv13-vfy-compose-host/jest-focused-mobile-run.log). It passed the first scenario and filtered the second, which had passed in the prior full run.

Tool versions were Node 24.21.0, Jest 29.7.0, Chromium 154.0.8037.57, Docker Engine 28.4.0, and Compose 2.40.3. Each test run used an isolated random PostgreSQL schema, Redis DB 2, ephemeral HTTP listeners, and a unique `orv13-compose-vfy-*` project. The root-trusted fixture was created only under its new temporary subtree through the authorized helper container; the marker and manifest were observed uid 0 and the manifest mode was 0644. Runtime state/journal stayed in a separate service-user-owned private directory. The actual CLI invocation was `node orchestrator/services/orchestrator/dist/compose-operations-runner-cli.js --once` from the repository root with per-run host, manifest, token, journal, lock, and internal URL settings; secret values are omitted.

## Named scenario outcomes

`root-trusted manifest and actual Compose CLI publish a fresh inventory with explicit env-file policy` passed. The actual CLI published a fresh empty inventory, then the mounted Admin UI previewed and submitted pinned Release A. Four real synthetic app containers (two replicas each) ran the fixed `sleep 1800` entrypoint on the cached Redis and Postgres image digests. The job reached `SUCCEEDED`; both per-service outcomes and each replica’s configured image and image ID were checked. A harmless sentinel and invalid image in the working-directory `.env` were ignored; the manifest-pinned explicit env file still applied its sentinel.

The browser journey used the built mounted Admin bundle, verified catalog → preview/reason → confirmation → fresh job detail, and exercised an actual pointer click at 320 CSS px. At 320 and 390 px, the preview screenshots show the operator reason and Confirm control together; Confirm’s x/y bounds fit the 850 px viewport. In the job detail, both web/worker `SUCCEEDED` rows were scrolled into view and their x/y bounds fit the viewport. Document width did not overflow. Focused scrolled dialog captures are [320 preview](../../reports/raw/orv13-vfy-compose-host/compose-preview-confirm-mobile-320.png), [390 preview](../../reports/raw/orv13-vfy-compose-host/compose-preview-confirm-mobile-390.png), [320 result](../../reports/raw/orv13-vfy-compose-host/compose-result-outcomes-mobile-320.png), and [390 result](../../reports/raw/orv13-vfy-compose-host/compose-result-outcomes-mobile-390.png). Full-page captures at 320/390/412 and the restricted viewer at 390 are alongside them in the same raw folder. Viewer access made no Compose API requests.

The same scenario exercised the real action protocol: exact duplicate submit returned the same job with one submit-audit row; divergent idempotency conflicted; a concurrent target preview was busy; a preview made stale by revision advance conflicted; web restart changed only web start times; Release B changed the worker image while preserving web container IDs and recorded observed release attribution; approved rollback returned the worker to Release A; a controlled audit trigger left the job count unchanged and retrying the same preview/key created one job; a missing pinned image produced a real `PARTIAL` result. Five PostgreSQL rows assigned timestamps `.000001` through `.000005` in the same millisecond were fetched with limit 1 in descending order exactly once each. Outcomes are in [actual-host-actions-and-history.json](../../reports/raw/orv13-vfy-compose-host/actual-host-actions-and-history.json).

The final browser Apply A deliberately dropped the HTTP completion acknowledgement after the real Docker action. The journal held one action outcome; an altered completion replay returned 409, then the exact pending report retry returned 200 without another host action. The UI showed the durable succeeded state. [browser-apply-a-and-auth-evidence.json](../../reports/raw/orv13-vfy-compose-host/browser-apply-a-and-auth-evidence.json) records the browser action and final bundle, and [compose-apply-a-success-and-ui-state.json](../../reports/raw/orv13-vfy-compose-host/compose-apply-a-success-and-ui-state.json) records replica IDs, image IDs, outcomes, and replay evidence.

`competing PG claims expire RUNNING to UNKNOWN, fence the target, and replay fresh quiescent reconciliation exactly` passed in the full run. Two concurrent real API claims produced one job claim and one empty result. A controlled fixture update made the claim expiry time stale; the runner GET swept `RUNNING` to `UNKNOWN/RUNNER_LOST`, and the target remained busy. A fresh actual four-container observation was submitted as reconciliation with its response dropped; the exact retry returned 200/`RECONCILED`, while a changed retry returned 409 and the fence cleared. Container IDs/start times remained unchanged. This is controlled database-clock expiry, not an injected process crash. See [unknown-expiry-and-reconcile.json](../../reports/raw/orv13-vfy-compose-host/unknown-expiry-and-reconcile.json).

The auth matrix covered missing session (401), viewer (403), local tenant-bearing Admin (200), missing CSRF (403), internal platform bearer versus cookie-only and invalid session proof, runner credential on Admin route, Admin credential on runner route, public runner route (404), and a foreign-host snapshot (403). The browser viewer made no host-backed Compose reads. The fixture migrated only its random schema; no production/customer schema was opened.

## Frozen artifact provenance

No source was rebuilt or modified by this verification agent. The shared Node 24 orchestrator build hash checks matched:

| Artifact | SHA-256 |
|---|---|
| `orchestrator/services/orchestrator/dist/compose-operations-runner-cli.js` | `87603259d0687f77c8a5388350f62aa1e2d4554c6a9cd306c1103d335ecdbfd6` |
| `orchestrator/services/orchestrator/dist/modules/compose-operations/service.js` | `ae86f2cb4183b6d6dff0ced9fedab6639d11cb11cd68821dcff76bc9d5043932` |
| `orchestrator/services/orchestrator/dist/modules/compose-operations/host-executor.js` | `fa06b4d9a3d8c26a047aad552920a6663dcd1962be8ae262d15884e36bba8670` |
| frozen `src/modules/compose-operations/service.ts` | `6956072ce71e732eb4f9823242cd0914017e4127de483d61df8defba6ad6b55d` |
| frozen `src/modules/compose-operations/host-executor.ts` | `e086ff4213652ba349105a1d633ad1eda9315940b4af7acc41cb064bee10af52` |
| `orchestrator/apps/admin-web/dist/index.html` | `c8deadba1b4b81476d7e295053ca4c300a31196fc99fa638418b14587a1d9184` |
| served JS `assets/index-BO7-bJEd.js` | `8e55dd6148ae91b2c18e38c4a4176742e574894bbadb36a407ce0f9ddc7c3e6a` |
| served CSS `assets/index-B-iqGBQY.css` | `25ea028bbccf360d53be25daa6a8fc471e85fcda123620d9d9437ada77339d4f` |

`servedBundleEvidence()` hashed the local built HTML and referenced files. The main verifier’s [receipt](orv13-verification.md) independently records this same JS as the bundle loaded with HTTP 200; this receipt does not claim to hash Chromium response bytes. Relevant frozen UI source checks were `system-operations-screen.tsx` `b5bff3bd75b50e420097507de50c22f99a67a2331f3266e919612a535a5e3d33`, `compose-operations-panel.tsx` `52a766ed65d7224c06eaf90939cbf0689dd865e23fb8302175dabaf2be7b4dc0`, and `app-shell.tsx` `d19c724e562c9675bc05ce57406e4c2a75d2aab328d9351f16d9ec3a07d3be0c`. Test harness hashes: `tests/workflow-api/orv13-vfy-compose-host.test.ts` `e690fd8f6f3e3e273ddb8e7094eb52d436b74107f7faee379a58c92985fb6358`; `tests/workflow-api/orv13-vfy-compose-host/fixture.ts` `177a3563ff17fec8020df5bb4a55a87929c87fb6fd69ed8462f1e9d76ad23e80`.

## Red findings, limits, and cleanup

Earlier actual failures were preserved and resolved before the final pass: PostgreSQL 42702 on unqualified joined claim columns ([initial runner red](../../reports/raw/orv13-vfy-compose-host/initial-runner-result-pg42702-red.json)); preview’s detached PoolClient `query` receiver ([preview probe](../../reports/raw/orv13-vfy-compose-host/preview-probe-failure.json)); and no-healthcheck inspect failing on absent `.State.Health`, leaving that first real apply `UNKNOWN` despite containers having started ([inspect and UNKNOWN diagnostic](../../reports/raw/orv13-vfy-compose-host/compose-apply-a-lost-ack-diagnostic.json)). The host owner fixed safe health lookup/empty-field parsing. The original uncertain job was never replayed; later passing actions used newly generated disposable projects. The harness’s synchronous-child event-loop failure is separately classified in [initial-runner-result-harness-event-loop-red.json](../../reports/raw/orv13-vfy-compose-host/initial-runner-result-harness-event-loop-red.json). Those prior reds are not included in final pass totals.

The fixtures used synthetic sleep containers only; Redis and Postgres images were never run as stateful databases. The missing-image failure is a controlled pinned fixture. No customer/provider availability, application health, zero downtime, or production cutover claim is made. No external messaging or production mutation occurred.

After the focused run, [cleanup-check.json](../../reports/raw/orv13-vfy-compose-host/cleanup-check.json) records zero containers, networks, or fixture/input/state directories for exact project `orv13-compose-vfy-590ab94bbe`. Fixture cleanup ran without a cleanup warning. The test’s `afterAll` attempted the isolated schema drop, but catches drop errors; no positive PostgreSQL catalog absence query is claimed. The initial full-run project `orv13-compose-vfy-3be6a322b0` was also checked by exact Docker project-label and `/tmp` filters with no residual output. Existing cached images were left untouched.
