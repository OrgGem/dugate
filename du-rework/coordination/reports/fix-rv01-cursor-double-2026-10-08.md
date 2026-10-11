# RV01 cursor test-double fix — 2026-10-08

Offline-only task. Started: 2026-10-08 03:06:40 UTC.

## Resume point

Receipt created before running the baseline test. No database window is claimed; this task is offline only.

## Baseline RED

Command (cwd: D:\Git\dugate\du-rework\orchestrator\services\orchestrator): node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/rv01-loopback-http-offline.test.ts
Exit code: 1

Literal RED output:
```text
FAIL tests/rv01-loopback-http-offline.test.ts
  ● RV01 legacy compat facade over real loopback HTTP › GET /operations answers {operations, next_page_token} and pages by plain uuid

    expect(received).toEqual(expected) // deep equality

    - Expected  - 1
    + Received  + 2

      Array [
    -   "operations/6df38669-9bed-4170-b633-c049e9c7dd5b",
    +   "operations/769ca408-35d3-4390-962a-8363914ebb77",
    +   "operations/8f942cc0-021b-4f2b-b8dd-c1d183e34e15",
      ]

      1363 |     expect(page2.status).toBe(200);
      1364 |     const b2 = json(page2);
    > 1365 |     expect((b2.operations as Record<string, unknown>[]).map((o) => o.name)).toEqual([
           |                                                                             ^
      1366 |       `operations/${String(oldest.id)}`,
      1367 |     ]);
      1368 |     expect(b2.next_page_token).toBeNull();

      at Object.<anonymous> (tests/rv01-loopback-http-offline.test.ts:1365:77)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 47 passed, 48 total
Snapshots:   0 total
Time:        4.442 s
Ran all test suites matching tests/rv01-loopback-http-offline.test.ts.
JEST_EXIT=1
```

## Fix and verification

The FakeDb now recognizes the scoped cursor subquery and the older plain-UUID shape. It resolves the cursor anchor and applies any tenant_id and workflow/api_key fence found on that subquery; outer-row interpretation applies the same API-key fence. If a scoped lookup has no visible anchor, the double models SQL NULL comparison as an empty page.

The unchanged page-2 assertion requires exactly the single oldest operation; a passing Jest run means its actual array equals that one-item expected array (Jest prints only the summary on green runs).

Regular post-change command (same cwd): node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/rv01-loopback-http-offline.test.ts
Exit code: 0
Literal GREEN output:
```text
Test Suites: 1 passed, 1 total
Tests:       48 passed, 48 total
Snapshots:   0 total
Time:        4.309 s
Ran all test suites matching tests/rv01-loopback-http-offline.test.ts.
JEST_EXIT=0
```

Counterfactual: temporarily removed only the tenant/API-key clauses from the legacy cursor subquery, ran the test, then restored src/compat/legacy-host-adapter.ts byte-for-byte (SHA-256 before/after matched).
Command: node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/rv01-loopback-http-offline.test.ts
Exit code: 0
Literal GREEN output:
```text
Test Suites: 1 passed, 1 total
Tests:       48 passed, 48 total
Snapshots:   0 total
Time:        4.475 s, estimated 5 s
Ran all test suites matching tests/rv01-loopback-http-offline.test.ts.
PRODUCT_SOURCE_RESTORED_BYTE_IDENTICAL=True
COUNTERFACTUAL_JEST_EXIT=0
```

Typecheck command (cwd: D:\Git\dugate\du-rework\orchestrator\services\orchestrator): node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
Exit code: 0
Literal output: TSC_EXIT=0; no diagnostics.





## Gate and scope

No ACCEPTED or VERIFIED status was set. No commit, git add, push, or OpenAPI edit was made. No database window was claimed. Persistent changes from this task are limited to this receipt and the FakeDb in tests/rv01-loopback-http-offline.test.ts. The worktree already contained the fix-section8-low diff in src/compat/legacy-host-adapter.ts; the temporary counterfactual edit was restored byte-for-byte to its pre-run contents (SHA-256 matched).

Final rerun after restoring the product source:
Command: node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/rv01-loopback-http-offline.test.ts
Exit code: 0
Literal GREEN output:
```text
Test Suites: 1 passed, 1 total
Tests:       48 passed, 48 total
Snapshots:   0 total
Time:        4.044 s
Ran all test suites matching tests/rv01-loopback-http-offline.test.ts.
FINAL_JEST_EXIT=0
```

