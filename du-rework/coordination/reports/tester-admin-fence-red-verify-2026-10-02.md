# Admin operations-list fence red — independent verification

Date: 2026-10-02  
Scope: read-only verification of `tests/admin-operations-sql.test.ts`; no source/test edits, gate changes, commits, or live database access.

## 1. Suite rerun

Working directory: `D:\Git\dugate\du-rework`  
Command: `pnpm --filter @du/orchestrator test -- tests/admin-operations-sql.test.ts`  
Exit code: **1**

Raw relevant output:

```text
> @du/orchestrator@0.1.0 test D:\Git\dugate\du-rework\services\orchestrator
> jest --runInBand "tests/admin-operations-sql.test.ts"

FAIL tests/admin-operations-sql.test.ts
  ● W-ADMUX02-SRV-1: filters are server-side, bound, and tenant-fenced › the x-api-key path is fenced by the key, not by the tenant param

    expect(received).rejects.toMatchObject()

    Received promise resolved instead of rejected
    Resolved to value: {"body": {"next_page_token": null, "operations": []}, "headers": {}, "status": 200}

      481 |       db: { page: [], total: 0, apiKey: { id: 'key-1', tenantId: TENANT_A } },
      482 |     });
    > 483 |     await expect(route(foreign.ctx)).rejects.toMatchObject({ status: 403 });
          |           ^
      484 |   });
      485 |
      486 |   it('an invalid filter is a 422 on the route, not a silently unfiltered list', async () => {

Test Suites: 1 failed, 1 total
Tests:       1 failed, 40 passed, 41 total
Snapshots:   0 total
```

This result reproduced with `npx jest --runInBand --runTestsByPath tests/admin-operations-sql.test.ts` from `du-rework/services/orchestrator` as well: **exit 1, 1 failed / 40 passed / 41 total**, same test and same resolved 200 empty page.

## 2. Test, fixture, and route trace

- The test case at `services/orchestrator/tests/admin-operations-sql.test.ts:469-483` first checks a key for `TENANT_A` with `tenant=TENANT_A`, then uses the same key identity with `tenant=TENANT_B` and expects a rejected route call with status 403. The fixture supplies key id `key-1`, tenant `TENANT_A` in both cases (`:473`, `:481`).
- `services/orchestrator/tests/helpers/operations-page-fixture.ts:97-109` records SQL and returns the configured API-key row; for operation-page and count queries it returns only the fixture's `page` and `total`. The foreign case configures `page: []` and `total: 0`, so the observed 200 response contains no operation rows. This fake database does not model/read actual tenant-B records and therefore the 200 alone is not evidence that tenant-B data was disclosed.
- `services/orchestrator/src/server.ts:1817-1830` has `GET /api/v1/operations`'s admin-bearer branch. It resolves the bearer principal and delegates tenant authorization to `authorizeAuditTenantRead`; `modules/admin-actions/rbac.ts:34-57,71-83` shows missing/non-Bearer auth resolves to `null`, platform bearer is a platform principal, and a tenant operator is restricted to its own tenant with a 403 for a foreign tenant.
- The x-api-key branch is `server.ts:1832-1844`: it resolves the key, parses `tenant`, and throws `HttpError(403, 'PERMISSION_DENIED', ...)` if the requested tenant differs from the persisted key tenant (`:1838-1839`). `resolveApiKey` at `server.ts:4223-4238` hashes the presented key, queries only an ACTIVE key, and returns its database `tenant_id`; it does not take tenant identity from the query parameter. The accepted page request passes `apiKey.tenantId` to `listOperationsPage` (`:1841-1843`), and `buildOperationsListPredicates` adds `tenant_id = $n` for a non-null scope (`:3214-3224`).
- The HTTP listener passes URL search parameters and request headers into that route (`server.ts:723-724,775-787`). Thus, on the current source path, a tenant-A API key with `tenant=TENANT_B` is rejected before the operations page query; without a tenant filter, the query remains scoped to the key's tenant.
- The public endpoint is also the endpoint used by the Admin bearer alternate path, not a separate `/api/v1/admin/operations` list route (`server.ts:1807-1817`). Its two authorization branches intentionally differ: platform Admin bearer can request any tenant through the principal scope (`server.ts:1823-1830`; RBAC `:78`), tenant-operator bearer is own-tenant-only (`rbac.ts:79-82`), and x-api-key callers are scoped by the key (`server.ts:1832-1844`).

## 3. Cache-disabled check and classification

Command: `npx jest --no-cache --runInBand --runTestsByPath tests/admin-operations-sql.test.ts`  
Working directory: `du-rework/services/orchestrator`  
Exit code: **1**; **0 tests executed**. The uncached transform stopped on existing TypeScript diagnostics in the Admin shell refactor: `src/app/admin/shell-router.ts:146,433` reports TS2459 (`resolveOpaqueSession` is declared locally but not exported by `auth-dispatch.ts:271`), and `shell-router.ts:434,438` reports TS2300 (duplicate `ShellRuntimeConfig`). No files were changed to work around these diagnostics.

The normal cached Jest execution's returned envelope (`next_page_token` / `operations`) also does not match the current source's `operationsListPage` return path (`server.ts:3464-3472`) or the current source comments describing `{ items, nextCursor, prevCursor, total, limit }` (`:1810-1816`). This discrepancy is observed; its cause is not established here. In particular, I cannot establish that the standard run executed the current route source, and the uncached run did not reach test execution.

**Classification: (c) Cannot determine offline.** The test expectation agrees with the current source's explicit 403 guard, so the available source does not support calling the expectation stale. Conversely, the reproducible standard-run 200 is inconsistent with that source, and the fake empty DB fixture cannot prove or disprove disclosure of a real tenant-B operation. A current-source runtime verification is missing because the uncached test run is blocked before execution; no real database or live endpoint was used.

**Suggested direction (not a decision): escalate for a clean current-source test execution and a populated cross-tenant fixture/HTTP verification before choosing between source and test changes.** No code or test change is made or recommended as part of this receipt.

## 4. Change boundary

Only this receipt was created by this verification task. Existing unrelated worktree changes were left untouched; no gate was ticked and no commit was made.
