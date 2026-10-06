# FENCE-ALIGN-VERIFY — `admin-operations-sql` after FENCE-TEST-ALIGN

**Task:** FENCE-ALIGN-VERIFY · **Date:** 2026-10-02 · **Status:** verification only. Read-only: no source, test or guard modified; no gate ticked; no commit.

## 1. Result — the retained red is gone

```
cd du-rework/services/orchestrator
npx jest --runInBand --runTestsByPath tests/admin-operations-sql.test.ts
```

```
PASS tests/admin-operations-sql.test.ts (21.406 s)
Test Suites: 1 passed, 1 total
Tests:       42 passed, 42 total
Snapshots:   0 total
```

**0 failed.** The previously retained red was `admin-operations-sql.test.ts:483`, *the x-api-key path is fenced by the key, not by the tenant param* — it expected `rejects.toMatchObject({ status: 403 })` and received a resolved 200 legacy envelope. I observed that same failure directly in this session's full-suite runs (`.cache/conv12-full.txt`, `.cache/conv12-full-presplit.txt`), so this is the same defect, now aligned.

## 2. Focused cluster — no new reds

```
npx jest --runInBand --testPathPatterns "admin-operations"
```

```
PASS tests/admin-operations-sort-http-offline.test.ts (9.356 s)
PASS tests/admin-operations-sort-wiring.test.ts
PASS tests/admin-operations-sql.test.ts
PASS tests/admin-operations-sort.test.ts
PASS tests/admin-operations-view.test.ts
PASS tests/admin-operations-query.test.ts
Test Suites: 6 passed, 6 total
Tests:       183 passed, 183 total
```

**6 suites, 183/183, no failures.**

## 3. Whole-suite effect

```
npx jest --runInBand
```

| | before FENCE-TEST-ALIGN | after |
|---|---|---|
| Test Suites failed | 8 | **7** |
| Tests failed | 28 | **27** |
| Tests passed | 4088 | **4090** |
| Tests total | 4341 | **4342** |

Exactly one suite and one test moved, and `admin-operations-sql` is gone from the FAIL list. The remaining 7 are the known admin/P6-01 set: `admin-shell-server`, `admin-shell-platform-mount`, `admin-shell-session-lifecycle`, `admin-p6-01-shell-fixtures`, `admin-shell-render`, `adm-base-03-safe-error-offline.functional`, `admin-shell-router`. **No new red anywhere.**

The `+1` total test is case B being new; the `+2` passing is case B plus the repaired case A.

## 4. Case A — is it correct, and is it a weakening?

`admin-operations-sql.test.ts:487` — *the x-api-key path is fenced by the KEY: a foreign tenant param is ignored, not honoured*.

| | old | new |
|---|---|---|
| foreign `?tenant=` on the x-api-key path | expected **403** | expects **200** |
| branch evidence | none | asserts key set `{next_page_token, operations}` = the legacy envelope |
| fence evidence | none | asserts `params[0] === TENANT_A`, `params` does **not** contain `TENANT_B`, SQL contains `tenant_id = $1` |

**Semantically correct.** The 403 the old test asserted came from the canonical route's guard (`server.ts:1838-1841`). That route is no longer reached for an `x-api-key` caller: the legacy compat facade claims `/api/v1/operations` for API-key callers and declines only admin-bearer callers (`hasAdminBearer`, `legacy-http-mount.ts`). The fence is real but now expressed as *the caller's tenant param is ignored and the key's tenant is bound into the query* — which the test asserts directly at the SQL-parameter level.

**Not a weakening — arguably the opposite.** The old 403 proved the request was *refused*; it never inspected the query, so it would still have passed if the route had 403'd for an unrelated reason. The new case proves the tenant predicate is **server-side and bound to the key's tenant**, which is the property that actually prevents cross-tenant reads. The legacy branch's own unconditional fence is `legacy-host-adapter.ts` (`tenant_id = $2` on every query).

**The honest limit, which the test states itself:** the fixture's `db.query` returns `db.page` regardless of the WHERE clause, so this proves the **predicate**, not that a real PostgreSQL withholds tenant-B rows. The test says so at `:521-526` and notes that asserting row absence would be asserting the mock. That is a real coverage limit and it is disclosed rather than hidden — but it means **row-level isolation on this path is now covered only at the predicate level; a live-DB leg is still absent.**

One cosmetic note, not a defect: the final `expect(operations).toHaveLength(1)` asserts the mock's own behaviour, not the system's. It passes for a reason unrelated to the fence. The comment is honest about it.

## 5. Case B — is it correct?

`admin-operations-sql.test.ts:534` — *an admin bearer reaches the CANONICAL branch, not the compat facade*.

It sends `authorization: Bearer ${OPERATOR_TOKEN}` and asserts 200 plus the **canonical** key set `{items, limit, nextCursor, prevCursor, total}` and `total === 3`.

**Correct, and the key set is a sound discriminator** — had the facade claimed the call, the body would be `{operations, next_page_token}` instead. That directly guards the `hasAdminBearer` decline, which is the regression that would silently hand the Admin shell a legacy envelope.

**Naming is loose, and worth flagging.** The fixture defines `ADMIN_TOKEN = 'platform-admin-token'` and `OPERATOR_TOKEN = 'tenant-operator-token'`, with `tenantAdminTokens: { [OPERATOR_TOKEN]: TENANT_A }` (`tests/helpers/operations-page-fixture.ts:55-61,120-121`). The case therefore exercises a **tenant operator** bearer, not a platform admin, despite the name saying *admin bearer*.

That is a naming imprecision rather than a correctness problem, and testing with the **lower-privilege** token is arguably the stronger choice: `hasAdminBearer` keys on *any* `bearer ` prefix, so proving the facade declines the tenant operator proves it declines the platform admin too. The `?tenant=TENANT_A` filter also matches the operator's pinned tenant, so no spurious 403 is involved. I did not change it — read-only scope.

## 6. Verdict

- The retained red is **cleared**; the suite is green at **42/42**.
- The focused cluster is **183/183**; the whole suite improved from 28 to **27** failures with **no new red**.
- **Case A is correct and is not a weakening** — it trades a refusal-status assertion for a direct predicate assertion, which is the stronger of the two. It does, however, now encode the compat facade's ownership of this path, and row-level isolation remains unproven without a live DB leg.
- **Case B is correct new coverage**; only its name is loose about which bearer it uses.

**No gate is ticked by this receipt.**