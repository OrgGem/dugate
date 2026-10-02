# FENCE-RED re-verify — current-source result

Date: 2026-10-02  
Scope: read-only rerun and route characterization. No repository source, test, or fixture edits; no gate changes, commits, live infrastructure, or access to `nocobase-10`.

## 1. Required suite runs

### Cached/package run

Working directory: `D:\Git\dugate\du-rework`  
Command: `pnpm --filter @du/orchestrator test -- tests/admin-operations-sql.test.ts`  
Exit code: **1**

Raw result:

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

Test Suites: 1 failed, 1 total
Tests:       1 failed, 40 passed, 41 total
```

### Uncached run

Working directory: `D:\Git\dugate\du-rework\services\orchestrator`  
Command: `npx jest --no-cache --runInBand --runTestsByPath tests/admin-operations-sql.test.ts`  
Exit code: **1**

Raw result (same failure, this time after a clean transform and test execution):

```text
FAIL tests/admin-operations-sql.test.ts (7.255 s)
  ● W-ADMUX02-SRV-1: filters are server-side, bound, and tenant-fenced › the x-api-key path is fenced by the key, not by the tenant param

    expect(received).rejects.toMatchObject()

    Received promise resolved instead of rejected
    Resolved to value: {"body": {"next_page_token": null, "operations": []}, "headers": {}, "status": 200}

      481 |       db: { page: [], total: 0, apiKey: { id: 'key-1', tenantId: TENANT_A } },
      482 |     });
    > 483 |     await expect(route(foreign.ctx)).rejects.toMatchObject({ status: 403 });
          |           ^
      484 |   });

Test Suites: 1 failed, 1 total
Tests:       1 failed, 40 passed, 41 total
Snapshots: 0 total
```

**The 200 is not a Jest-cache artifact.** Cached and uncached runs agree, and the uncached run executes all 41 tests.

## 2. Why this request returns 200

The failing test at `services/orchestrator/tests/admin-operations-sql.test.ts:469-483` sends the same fake API key for tenant A with `tenant=TENANT_B`, then expects 403. Its fixture sets the key tenant to A (`:473`, `:481`). The mock DB returns the configured `page` without evaluating SQL and this case configures an empty page (`services/orchestrator/tests/helpers/operations-page-fixture.ts:97-109`); thus the suite's empty 200 by itself does not demonstrate whether a populated foreign row could be returned.

The actual route order explains the legacy envelope and status:

1. `server.ts:1745-1768` calls `handleLegacyRoute` **before** the canonical routes and immediately returns any non-null legacy result. For this request, `resolvePrincipal` calls `resolveApiKey` and supplies `{tenantId, apiKeyId}` from the resolved key (`server.ts:1751-1767`). `resolveApiKey` hashes the presented x-api-key, looks up an ACTIVE row, and returns its DB tenant (`server.ts:4223-4234`).
2. `legacy-http-mount.ts:502-533` claims `GET /api/v1/operations`. It reads the legacy `filter`, `page_size`, and `page_token` query parameters, and passes `principal.tenantId` into `listLegacyOperations` (`:507-527`). This handler does not read a top-level `tenant` query parameter. The legacy filter parser only recognizes `state` and `processor`; its comment explicitly documents ignoring other filter keys (`legacy-http-mount.ts:305-335`).
3. The host adapter constructs the SQL tenant predicate from that principal: `tenant_id = $1` with `input.tenantId` as parameter 1, plus `deleted_at IS NULL` (`legacy-host-adapter.ts:116-141`). The serializer intentionally returns the legacy `{ operations, next_page_token }` envelope (`legacy-http-mount.ts:528-533`; `legacy-envelope.ts:210-217`). This matches the observed 200 envelope and is the current compatibility path, not the canonical page response.
4. By contrast, the canonical `server.ts:1817-1844` x-api-key branch parses `tenant` and throws 403 for a non-matching tenant (`:1832-1839`), but that branch is not reached after the legacy facade returns. Admin bearer requests are excluded from the facade (`legacy-http-mount.ts:118-121,460-464`) and can reach the canonical route.

### Populated cross-tenant probe

To distinguish “ignored filter but key-scoped list” from cross-tenant disclosure, I ran a one-off Jest probe under `C:\Users\Gem\AppData\Local\Temp\fence-red-probe.test.ts` (outside the repository; deleted after the probe). It supplied rows for both tenant A and tenant B and a fake DB adapter that honored the emitted SQL tenant predicate. With `tenant=TENANT_B` and a key resolving to tenant A, the parsed query value was B, the actual operation SQL was `SELECT * FROM operations WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT $2`, parameter 1 was tenant A, and the returned legacy operation name was only `operations/tenant-a-operation`; the tenant-B row was not returned. Probe: **1 suite / 1 test passed, exit 0**.

This is an in-process route plus predicate-emulating fake DB probe, not a live database or deployment test. The security conclusion is supported by the route's server-derived tenant argument and bound SQL predicate; the probe checks that the data returned under that predicate contains no tenant-B row.

## 3. Final classification and direction

**Classification: (a) test expectation stale for the active x-api-key compatibility route.** The failing case's expectation of a 403 assumes the canonical route's tenant-filter behavior. The current compatibility route treats `tenant` as an unsupported query parameter, returns 200 in the legacy envelope, and applies the key-resolved tenant A in SQL. The populated probe found no tenant-B disclosure. The observed 200 is real on current source, not a cache artifact, but it is not a cross-tenant fence gap.

Suggested direction: if the test intends to assert compatibility-path behavior, align its assertion with the legacy route's ignored-filter/tenant-A-scoped result; if it intends to assert canonical 403 behavior, exercise the canonical tenant-operator Admin-bearer path (not x-api-key, which the compatibility facade claims first). This is a classification and direction only; no code or test change was made.

## 4. Change boundary

Only this receipt was added in the repository. The temporary probe outside the repository was removed. Existing worktree changes were left untouched; no gate was ticked and no commit was made.
