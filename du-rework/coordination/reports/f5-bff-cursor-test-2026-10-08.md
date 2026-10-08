# F-5 tenant cursor BFF coverage — 2026-10-08

Scope: `du-rework`. This adds offline coverage only. No product source was changed or left modified.

## Coverage added

Added `orchestrator/services/orchestrator/tests/f5-bff-tenant-cursor-offline.test.ts`:

- Line 247, `fences a foreign tenant cursor and its count at the BFF boundary`: a tenant operator for B requests `/admin/api/tenants` with tenant C's cursor. The request goes through the Admin shell BFF and then the real `route()` handler for `GET /api/v1/admin/tenants`; the SQL-aware fake DB supplies four roster rows. It asserts an empty page, no C ID/name in the response, `total === 1` rather than the four-row system count, and the expected tenant bearer reaches the handler.
- Line 267, `uses valid tenant B cursors for both next and previous pages`: follows the generated cursor for B in both directions through the same BFF and route. This uses a platform roster session because an operator scoped to B can see only B's single row and therefore has no adjacent row to paginate to.

The fake DB models the page predicate, cursor boundary subquery, and count predicate. No PostgreSQL or Redis service is used.

## Fail-first and mutation evidence

The checked-in source already contained the F1 scope fix. To get the required pre-fix red without leaving product changes, after writing the test I temporarily changed `boundaryScope` to the old empty-string form, ran the new test, and restored the source bytes. The test failed at the expected page assertion:

```text
expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 7

- Array []
+ Array [
+   Object {
+     "id": "33333333-3333-4333-8333-333333333333",
+     "name": "Gamma scoped tenant",
+     "state": "ACTIVE",
+   },
+ ]

Tests: 1 failed, 1 passed, 2 total
JEST_EXIT_CODE=1
```

The mandatory mutation probe repeated that change by removing `AND id = scopeBind` from the boundary subquery. It produced the same assertion failure (1 failed, 1 passed), confirming the test detects the unscoped boundary.

SHA-256 of `src/modules/admin-read/tenant-list.ts` before mutation: `F3E6DC9487D84E1C654D93CEBBD844A949CCE30D4F4201BBCCA26756FEF7F813`.

SHA-256 after restoring the original bytes: `F3E6DC9487D84E1C654D93CEBBD844A949CCE30D4F4201BBCCA26756FEF7F813` — identical. The final file hash was checked again after verification and still matches.

## Green verification

From `du-rework/orchestrator/services/orchestrator`:

```text
node node_modules/jest/bin/jest.js --runInBand tests/f5-bff-tenant-cursor-offline.test.ts tests/tenant-list-cursor-codec-offline.test.ts tests/tenant-list-bff-offline.test.ts
Exit code: 0
Test Suites: 3 passed, 3 total
Tests: 11 passed, 11 total

node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
Exit code: 0
```

Coverage remains offline: this does not exercise PostgreSQL's actual SQL execution or a live service deployment. No verification or acceptance checklist row was changed.
