# Independent verification: RV01 cursor double + public upload encryption gateway

Status: VERIFIED with worktree-scope caveat
Date: 2026-10-08
Scope: `du-rework` only. Offline only; no database window claimed.
No source/test edits, commit, add, push, gate tick, or OpenAPI hand edit was performed by this verifier.

## 1. RV01 Jest run

Command (cwd `orchestrator/services/orchestrator`):

```text
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/rv01-loopback-http-offline.test.ts
```

Exit code: 0. Literal output:

```text
Test Suites: 1 passed, 1 total
Tests:       48 passed, 48 total
Snapshots:   0 total
Time:        3.376 s
Ran all test suites matching tests/rv01-loopback-http-offline.test.ts.
```

FAILs: none.

## 2. Public-upload Jest run

Command (same cwd):

```text
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/public-upload-encryption-gateway.test.ts
```

Exit code: 0. Literal output:

```text
Test Suites: 1 passed, 1 total
Tests:       12 passed, 12 total
Snapshots:   0 total
Time:        3.507 s
Ran all test suites matching tests/public-upload-encryption-gateway.test.ts.
```

FAILs: none.

## 3. TypeScript check

Command:

```text
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

Exit code: 0. Combined output: 0 bytes.

## 4. Scope diff and hashes

Command `git diff --stat` (cwd `orchestrator/services/orchestrator`) exited 0. Literal output:

```text
warning: in the working copy of 'du-rework/docs/admin-ui-development-contract.md', CRLF will be replaced by LF the next time Git touches it
 .../fix-section8-low-legacy-cursor-2026-10-08.md   | 214 +++++++++++++++------
 du-rework/docs/admin-ui-development-contract.md    |   6 +-
 .../packages/observability/src/log-metadata.ts     |  30 ++-
 .../orchestrator/src/compat/legacy-host-adapter.ts |  21 +-
 .../services/orchestrator/src/db/migrations.ts     |  91 +++++++++
 .../orchestrator/src/modules/runtime/runtime.ts    |   7 +-
 .../tests/artifact-read-authorization.test.ts      |   5 +
 .../tests/enc-meta-sentinel-runtime-refs.test.ts   |  30 ++-
 .../tests/public-upload-encryption-gateway.test.ts |  17 ++
 .../tests/rv01-loopback-http-offline.test.ts       |  46 ++++-
 du-rework/tasks/ADMIN-PORTAL-OPS-UX-2026-10-08.md  |   7 +-
 du-rework/tasks/ADMIN-WEB-DELIVERY-2026-10-04.md   |   7 +-
 du-rework/tasks/README.md                          |   2 +-
 13 files changed, 408 insertions(+), 75 deletions(-)
```

Therefore the worktree-wide diff does **not** confirm “only two test files changed / no `src/**`”: it contains four source paths and additional unrelated test/docs/task paths. The initial `git status --short`, recorded before running either suite, already listed these source and unrelated changes. This verifier introduced no source/test edits; the scope finding cannot be attributed to the two test-double fixes from the available diff alone.

Command `git diff --name-only -- orchestrator/packages/observability/src orchestrator/services/orchestrator/src` exited 0. Literal output:

```text
du-rework/orchestrator/packages/observability/src/log-metadata.ts
du-rework/orchestrator/services/orchestrator/src/compat/legacy-host-adapter.ts
du-rework/orchestrator/services/orchestrator/src/db/migrations.ts
du-rework/orchestrator/services/orchestrator/src/modules/runtime/runtime.ts
```

Command `Get-FileHash -Algorithm SHA256 -LiteralPath 'tests/rv01-loopback-http-offline.test.ts','tests/public-upload-encryption-gateway.test.ts'` exited 0. Literal hashes:

```text
D:\Git\dugate\du-rework\orchestrator\services\orchestrator\tests\rv01-loopback-http-offline.test.ts
9DE6511B24794EA321E742D43E4A51CE60C54C90D5681D00492FBC8594AF331F

D:\Git\dugate\du-rework\orchestrator\services\orchestrator\tests\public-upload-encryption-gateway.test.ts
019EBB3433DA6F5FEED0EF44FFE759ADCF46658254270FE3F35EEF1704226A2E
```

## 5. Receipt and assertion review

Read both requested receipts (`Get-Content` for each; exit code 0). Their recorded claims match the current test-only hunks: RV01 extends the `FakeDb`, and public-upload adds a `createDb` SQL fake branch. `git diff --unified=8 -- tests/rv01-loopback-http-offline.test.ts tests/public-upload-encryption-gateway.test.ts` exited 0; its hunks change only fake implementation code. A scan of the zero-context diff for added or removed `expect(...)` lines produced no output (exit code 0).

(a) Test-double locations:

- RV01: `tests/rv01-loopback-http-offline.test.ts:329-405` adds the top-level API-key predicate handling, `matchesApiKeyFence`, and the scoped legacy cursor anchor handling inside `FakeDb`.
- Public upload: `tests/public-upload-encryption-gateway.test.ts:251-252,388-402` tracks the operation link and handles `UPDATE artifacts SET operation_id=$2` in `createDb`, checking artifact existence/ID, tenant, READY state, and unlinked operation/task before returning one row.

(b) Assertions were not loosened, deleted, or reduced. The RV01 page-2 assertion remains at `tests/rv01-loopback-http-offline.test.ts:1403-1406`:

```text
expect((b2.operations as Record<string, unknown>[]).map((o) => o.name)).toEqual([
  `operations/${String(oldest.id)}`,
]);
expect(b2.next_page_token).toBeNull();
```

The public-upload submit journey still asserts `202`, `{ state: 'ACCEPTED', replayed: false }`, `operationId`, `links.self`, READY state, and no `STATE_CONFLICT` at lines 572-578. The fake UPDATE branch is present at lines 388-402. No explicit Jest assertion reads the fake's internal `linkedOperationId`; the unchanged submit response assertions remain the externally observable check.

(c) Product-source status: no source change was made by this verifier, and the test-fix hunks themselves are test-only. The full worktree does contain the four source diffs listed above; they were already present in the initial status. Thus “product source pristine relative to HEAD” is false for the current worktree, and source cleanliness cannot be claimed globally. The RV01 fix receipt also records that the tenant/API-key cursor clauses were temporarily removed in a counterfactual and the suite remained green; that means this pagination case alone does not independently prove those product clauses are enforced, although the page-2 assertion itself remains intact.

(d) Verdicts:

- RV01 cursor double: PASS for the requested test-double repair and preservation of the exact one-row page-2 assertion; 48/48 pass. Coverage caveat above remains open.
- Public-upload encryption gateway: PASS for the requested test-double handler repair and preservation of existing submit expectations; 12/12 pass.

No ACCEPTED or VERIFIED project gate was ticked. No DB-window claim is made.
