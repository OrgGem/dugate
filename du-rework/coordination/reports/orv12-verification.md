# ORV12 independent verification

Executor `/root/verification`; no product source edits. Final verdict: **independent functional PASS for the implemented consumer slice**. No production cutover acceptance.

## Reproduction

Cwd `/workspace/dugate/du-rework`; official Node24.21.0, pnpm10.18.3. Environment/network/Docker skill instructions inspected, no proxy/TLS bypass or customer credentials. Synthetic PG16 localhost55498, Redis7 localhost56398, unique schemas; worker suites serialized. Actual Chromium `/usr/bin/chromium` with Playwright; real backend, workers and local deterministic HTTP provider. S3 is Moto5.1.12 HTTP emulator localhost59098, versioned buckets; not cloud IAM or MinIO. Registry/binary MinIO access failures preserved in raw logs.

```sh
export PATH=/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin:/workspace/scratch/orv11-toolchain/node_modules/.bin:$PATH
export NODE_PATH=/workspace/dugate/du-rework/node_modules/.pnpm/node_modules
node node_modules/.pnpm/node_modules/jest/bin/jest.js --config tests/workflow-api/jest.config.cjs --runInBand <files> [--testNamePattern='<pattern>']
```

## Results

| Independent check | Result and evidence |
|---|---|
| `orv12-vfy-usage.test.ts` | **6 passed** in `reports/raw/orv12/consumers-final.log` (combined invocation has migration failure). Real provider priced725µUSD, zero and unpriced → atomic Connector completion/outbox → authenticated HTTP sink → PG ledger → public result/billing. Duplicate event stable; historical baseline, spending402/no new job, replay after limit, key isolation and limit0 covered. |
| Settings HTTP + browser (included in6 above) | Native exact endpoint profile with connector pins; draft validation/CAS/tenant rejection, apply/new encrypted admission carrier, prior admission unchanged, rollback creates new revision and restores pins. Browser native profile creation uses actual catalog; settings apply/rollback actual backend. |
| Guided HITL browser (included in6) | Generic legacy schema explicitly shows advanced JSON fallback; separately persisted synthetic typed business schema validates required/negative number, preserves boolean/number in advanced editor, actual BFF resume reaches worker SUCCEEDED. This does not claim existing generic legacy human nodes emit typed domain schemas. |
| `orv12-vfy-s3.test.ts` | **1 passed**, `reports/raw/orv12/data-storage-final3.log`; internal upload encrypted98KB, pinned object/manifest generations, own exact plaintext readback, foreign key404, newer unpinned generation ignored. Hash tamper503, nonexistent manifest generation500 sanitized, nonexistent object generation404; none falls back or emits plaintext/SDK stack. Earlier expected503 for all was an overly specific fixture expectation, not a data-integrity failure. |
| `orv12-vfy-migration.test.ts` | **1 passed, exit0**, `reports/raw/orv12/mapping-login-operator-fixed.log`; previous administrator-only gate failure preserved in `mapping-login-final.log`, narrow owner fix independently verified. Correct-CSRF migrated operator cancel200, missing-CSRF403. Prior assertions complete all9 populated source entities, encrypted connector/schema fresh-adapter replay, snapshot-bound timezone negative, imported membership/disabled policy,9MiB output bytes, local activation/login and reset marker/audit, two-app shared session own200/foreign403, disable/re-enable revocation, password rate lock. Native reconciliation prompt mapping apply/replay/fresh-process CLI replay plus subsequent encrypted admission carrier pass. |
| Core31 actual HTTP regression | **31 passed,3 deselected**, exit0, `reports/raw/orv12/core31-regression.log`; `orv11-vfy-core-worker.test.ts --testNamePattern='DOC-'`. Exact projected legacy content/fields through actual admission/worker/poll. |
| Workflow changed-path regression | **4 passed**, exit0, `reports/raw/orv12/legacy-regression.log`; `http-worker.integration.test.ts --testNamePattern='executes the pinned input|named doc-compare|named disbursement|named lc-checker'`. Initial command also named core test with unmatched BRD pattern, hence45 total deselections; not skipped requirements/pass counts. |
| Callback | Separate independent tester `/root/migration`, **11 passed** real HTTP/BFF/PG/pinned egress; see `orv12-callback-verification.md`. Not counted in our checks above. |

Actual loaded UI `/admin/assets/index-DYRIRIfm.js`, SHA256 `0ab292f776d094a6efddb15cb243744c8ab3926aa4d7c4cc50447d43646b0eac`. Browser evidence `reports/raw/orv12/browser/settings-browser.json`, `guided-hitl.json`, screenshots native-profile-created/settings-applied/settings-restored/hitl-legacy-fallback/hitl-guided-ready/hitl-guided-complete. Source-based backend execution uses ts-jest; built UI served by actual shell. Source hash baseline `reports/raw/orv12/source-before.json`; final snapshot `reports/raw/orv12/source-after.json`; differences listed in `source-changes.json` (narrow BFF operator fix, test assertions and any final UI copy rebuild).

## Limits

No customer snapshot, timezone evidence, provider credentials or deployment IAM supplied. Synthetic importer evidence cannot authorize production migration. Archived model setting deliberately classified manual with rationale; not silently considered active configuration. Imported encrypted workflow schema is authenticated during replay, but this fixture does not execute that imported schema through a worker. Same-process fixture replica shares actual Redis/DB and uses different internal admin tokens with stable shared local service secret derivation; no real load balancer deployment is claimed. Historical terminal operation fixture supports artifact readback, not S3 worker execution. UI callback panel currently inspected with empty deliveries; callback retry backend verified separately. Settings validation verifies configuration without paid provider calls.

Final unique main checks: **8 passed** (6 usage/settings/browser +1 S3 +1 migration), with31 core and4 workflow regression cases reported separately; no repeated attempts added to totals. Earlier logs named `browser-final.log` and `data-storage-final*.log` preserve diagnostic failures and are superseded only as specified above. No `--forceExit` used.
