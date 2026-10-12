# WOC-08 SDK/template conformance receipt

Date: 2026-10-12  
Workspace: `D:\Git\dugate\du-rework`  
Canonical baseline: `b276ede4d3032d197a2ba96ba79c18b0f6e3c139`

Updated the Document Core template vendor snapshot to the canonical worker SDK and contract sources needed for startup registration, typed deferred claims, lease watchdog/single-flight, optional `backupEffectFence` refusal, bounded request-body deadlines, ambiguous write ACKs, and stable `INVOCATION_UNKNOWN` replay. Added five isolated template conformance vectors and corrected related SDK tests to assert the retryable/ambiguous error boundary while preserving their no-dispatch/no-download checks and pinned-policy secret checks.

The vendored dependency closure is limited to the SDK’s worker, runtime client, task context, types, connector invoker, and contracts runtime/errors/connector/global-settings/usage-metrics. The contracts barrel includes only the required `global-settings` export. No profile-groups or unrelated package sources were added. The legacy lock `baseCommit` remains `b088eececcb5f3df0b4edbe073a29401dafda624`; 11 synchronized entries now carry per-file source fingerprints. Ten are exact canonical copies; the barrel entry is marked `selected-exports` and records the canonical barrel hash separately from the minimal vendored barrel hash.

Changed files:

- `businesses/document-core/template/VENDOR-LOCK.json`
- `businesses/document-core/template/package.json`
- `businesses/document-core/template/scripts/gen-vendor-lock.mjs`
- `businesses/document-core/template/scripts/verify-vendor-lock.mjs`
- `businesses/document-core/template/tests/woc08-template-conformance.test.mjs`
- `businesses/document-core/template/vendor/contracts/src/connector.ts`
- `businesses/document-core/template/vendor/contracts/src/errors.ts`
- `businesses/document-core/template/vendor/contracts/src/global-settings.ts` (new)
- `businesses/document-core/template/vendor/contracts/src/index.ts`
- `businesses/document-core/template/vendor/contracts/src/runtime.ts`
- `businesses/document-core/template/vendor/contracts/src/usage-metrics.ts` (new)
- `businesses/document-core/template/vendor/worker-sdk/src/connector-invoker.ts`
- `businesses/document-core/template/vendor/worker-sdk/src/runtime-client.ts`
- `businesses/document-core/template/vendor/worker-sdk/src/task-context.ts`
- `businesses/document-core/template/vendor/worker-sdk/src/types.ts`
- `businesses/document-core/template/vendor/worker-sdk/src/worker.ts`
- `orchestrator/packages/worker-sdk/tests/connector-invoker.test.ts`
- `orchestrator/packages/worker-sdk/tests/artifact-read-metadata.test.ts`
- `orchestrator/packages/worker-sdk/tests/artifact-stat.test.ts`
- `orchestrator/packages/worker-sdk/tests/p730-pinned-policy.test.ts`

Validation:

- `pnpm --filter @du/worker-sdk lint` from `D:\Git\dugate\du-rework\orchestrator`: passed (`tsc --noEmit -p tsconfig.json`). Raw output: `coordination/reports/raw/woc08-sdk-lint-2026-10-12.txt`.
- `pnpm --filter @du/worker-sdk test --runTestsByPath tests/connector-invoker.test.ts tests/artifact-read-metadata.test.ts tests/artifact-stat.test.ts tests/p730-pinned-policy.test.ts` from `D:\Git\dugate\du-rework\orchestrator`: 4 suites passed, 103 passed, 1 existing todo, 0 failed. Raw output: `coordination/reports/raw/woc08-sdk-related-jest-2026-10-12.txt`.
- Template TypeScript build used the existing SDK compiler with `--outDir C:\Users\Gem\AppData\Local\Temp\woc08-template-isolated-final`; it exited 0 without writing template `dist`. The same compiled output passed all 5 conformance vectors (5 passed, 0 failed). The test asserts `@du/contracts` and `@du/worker-sdk` resolve from that isolated output. Third-party modules were resolved from installed contracts/worker-sdk dependency directories because this checkout has no template-local `zod` install. Raw output: `coordination/reports/raw/woc08-template-isolated-build-conformance-2026-10-12.txt`.
- Template `pnpm run verify:vendor` from `D:\Git\dugate\du-rework\businesses\document-core\template`: passed; 61 vendored files match, 11 have file-specific provenance, legacy base commit preserved. Raw output: `coordination/reports/raw/woc08-template-lock-verify-2026-10-12.txt`.
- TypeScript `--traceResolution` confirms `@du/contracts` resolves to `businesses/document-core/template/vendor/contracts/src/index.ts` and `@du/worker-sdk` to `businesses/document-core/template/vendor/worker-sdk/src/index.ts`. Raw output: `coordination/reports/raw/woc08-template-resolution-2026-10-12.txt`.
- Canonical/vendor SHA-256 verification for all 11 source-fingerprinted files is recorded in `coordination/reports/raw/woc08-source-hashes-2026-10-12.txt`.

Unresolved baseline failure:

`tests/crypto-seam.test.ts` remains red at its existing byte-parity assertion, `expect(mine).toBe(theirs)` (line 109): worker `crypto-storage.ts` serializes raw AAD objects while the orchestrator facade parses context/single/chunk AAD through shared schemas. The standalone suite reports 1 failed and 13 passed. The three parity files are unchanged from baseline `b276ede4d3032d197a2ba96ba79c18b0f6e3c139`; their baseline Git blob IDs and `git show` snippets are recorded in `coordination/reports/raw/woc08-crypto-baseline-2026-10-12.txt`. Canonical encryption files were left unchanged per scope direction. Raw failing test output: `coordination/reports/raw/woc08-sdk-crypto-seam-baseline-2026-10-12.txt`.

No canonical product source, backend, auth/config, generated shared `dist`, deployment, or provider state was changed in this packet. No commit or push was made.
