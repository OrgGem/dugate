# Node 24 upload stream test repair

Only `orchestrator/services/orchestrator/tests/public-upload-encryption-gateway.test.ts` was edited for this fix. No product source, other test, config, or docs file was changed by this run. The test file already had uncommitted changes before the run; its existing DB fake additions (`linkedOperationId` / `linkedTaskId` and the `UPDATE artifacts SET operation_id=$2` handler, now around lines 353 and 490) remain intact.

## Fail-first evidence

Working directory for the Jest command: `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`.

Node path: `$env:TEMP\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe`, resolved as `C:\Users\Gem\AppData\Local\Temp\du-node24-security-c025dd92\node-v24.21.0-win-x64\node.exe`. `& $node24 -v` returned `v24.21.0` (exit 0).

Command: `& $node24 node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/public-upload-encryption-gateway.test.ts`  
`REAL_EXIT=1`

Literal output:

```text
Expected: < 171966464
Received:   218013696
Test Suites: 1 failed, 1 total
Tests:       1 failed, 11 passed, 12 total
```

The failure was `streams chunked encryption with downstream backpressure and keeps the object size exact`, at the old RSS assertion (`process.memoryUsage().rss()` around old lines 691–693 and threshold at old line 709). The complete raw output is in [10-red-before.log](raw/fix-node24-rss-2026-10-09/10-red-before.log).

## Test change

The failing fixture retained its full ciphertext and a second `Buffer.from()` copy in `MemoryS3`, so its RSS measurement counted the test double's storage policy. The replacement sink in [public-upload-encryption-gateway.test.ts](../../orchestrator/services/orchestrator/tests/public-upload-encryption-gateway.test.ts#L99) consumes the real gateway stream, hashes and counts each read buffer, and writes ciphertext to a temporary file rather than retaining large buffers in `objects` or `objectWrites`. `GetObject` streams that file back so the real `createPublicUploadGateway` verification path still checks the stored ciphertext hash. The test removes the temporary file and directory in `finally`.

The real `createPublicUploadGateway` and `CryptoStorageFacade` remain in use. A pause/resume gate holds the sink after its first ciphertext read; the test asserts that the producer had not finished at that read. It also verifies the first downstream read preceded the final source pull, total streamed bytes equal the declared size, streamed SHA-256 matches the gateway acknowledgment and manifest, and the manifest records multiple chunks whose sizes are each at most `CRYPTO_STORAGE_CHUNK_SIZE_BYTES` and sum to the declared size. The facade emits AES-GCM ciphertext with the same byte length as each plaintext chunk and records the authentication tag separately in the manifest, so each manifest `sizeBytes` is the exact ciphertext payload chunk length. The stored in-memory object and retained write contain zero ciphertext bytes.

The sink's raw stream read boundaries are not assumed to map one-to-one to encryption manifest chunks: Node's readable stream may coalesce yielded buffers. A temporary assertion that required that mapping produced `Expected: 7 / Received: 4`; it was removed and replaced with checks on the authoritative per-encryption-chunk manifest descriptors. That intermediate output is preserved in [21-green-1.log](raw/fix-node24-rss-2026-10-09/21-green-1.log).

The complete test-file diff is in [52-test-diff-after.txt](raw/fix-node24-rss-2026-10-09/52-test-diff-after.txt). It includes the pre-existing DB fake changes noted above as well as this sink/test change.

## Verification

All commands below ran from `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`, using Node `v24.21.0` at the path above. `REAL_EXIT` was captured immediately from `$LASTEXITCODE` after each Node command.

| Run | Command | Literal result | REAL_EXIT |
|---|---|---|---:|
| Fail-first, before editing | `& $node24 node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/public-upload-encryption-gateway.test.ts` | `Test Suites: 1 failed, 1 total`; `Tests: 1 failed, 11 passed, 12 total`; `Expected: < 171966464`; `Received: 218013696` | 1 |
| Green run 1 | `& $node24 node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/public-upload-encryption-gateway.test.ts` | `Test Suites: 1 passed, 1 total`; `Tests: 12 passed, 12 total` | 0 |
| Green run 2 | `& $node24 node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/public-upload-encryption-gateway.test.ts` | `Test Suites: 1 passed, 1 total`; `Tests: 12 passed, 12 total` | 0 |
| Backend typecheck | `& $node24 node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | 0 TypeScript error lines; output 0 bytes | 0 |
| Regression | `& $node24 node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/tenant-list-bff-offline.test.ts tests/tenant-list-cursor-codec-offline.test.ts tests/f5-bff-tenant-cursor-offline.test.ts tests/usage-contracts-integration-offline.test.ts tests/usage-aggregation.test.ts tests/bff-connectors-actions.test.ts tests/admin-connector-view-model.test.ts tests/admin-connector-render.test.ts` | `Test Suites: 8 passed, 8 total`; `Tests: 156 passed, 156 total` | 0 |

The two green runs were separate Jest processes and both passed. Raw outputs are [22-green-1.log](raw/fix-node24-rss-2026-10-09/22-green-1.log), [23-green-2.log](raw/fix-node24-rss-2026-10-09/23-green-2.log), [30-tsc.log](raw/fix-node24-rss-2026-10-09/30-tsc.log), and [40-regression.log](raw/fix-node24-rss-2026-10-09/40-regression.log). An initial post-edit attempt also stopped before collection because `createReadStream` was first imported from `node:stream`; the raw TypeScript diagnostic is in [20-green-1.log](raw/fix-node24-rss-2026-10-09/20-green-1.log). The import was corrected in the test file, and later runs are the two green runs listed above.

## Workspace and limits

Before and after the test/typecheck runs, `git status --porcelain` had 137 lines and compared equal; the modified test path was already present before this task. `git log -1 --format=%H` was unchanged at `72e225ae5465e5a648c34bf31fbabbd182763233`. Checkpoints are in [00-status-before.txt](raw/fix-node24-rss-2026-10-09/00-status-before.txt), [01-head-before.txt](raw/fix-node24-rss-2026-10-09/01-head-before.txt), [50-status-after-tests.txt](raw/fix-node24-rss-2026-10-09/50-status-after-tests.txt), and [51-head-after-tests.txt](raw/fix-node24-rss-2026-10-09/51-head-after-tests.txt). The after-test checkpoint precedes this receipt's creation.

`tests/migrations.test.ts` and `tests/usage-summary.test.ts` were not run; `jest.unit.config.cjs` excludes them at lines 18 and 21. `tests/f3-tenant-list-live-db.test.ts` and `tests/f3-tenants-route-live.test.ts` were not run because they require a database. No PostgreSQL or Redis was started, and no DB window is claimed.

No gate was ticked. No source file was edited. No `git add`, commit, push, or checkout was performed.

After creating this receipt, status has 138 lines; the only difference from the pre-run snapshot is this expected untracked receipt. HEAD remains unchanged. See [60-status-after-receipt.txt](raw/fix-node24-rss-2026-10-09/60-status-after-receipt.txt) and [61-head-after-receipt.txt](raw/fix-node24-rss-2026-10-09/61-head-after-receipt.txt).
