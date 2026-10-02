# FENCE-TEST-ALIGN — x-api-key fence assertion was stale, not the fence

- **Date:** 2026-10-02. **Mode:** TEST-ONLY. **No gate ticked. No commit.**
- **Scope:** `services/orchestrator/tests/admin-operations-sql.test.ts` only. The fixture (`tests/helpers/operations-page-fixture.ts`) was read, not modified. **No production file touched.**

## 1. Baseline, measured before any edit

```
npx jest tests/admin-operations-sql.test.ts
Tests:       1 failed, 40 passed, 41 total

● the x-api-key path is fenced by the key, not by the tenant param
  expect(received).rejects.toMatchObject()
  Received promise resolved instead of rejected
  Resolved to value: {"body": {"next_page_token": null, "operations": []}, "headers": {}, "status": 200}
```

The rejected-promise expectation was wrong about the route. The classification in `tester-fence-red-reverify-2026-10-02.md` was correct, and I re-derived the mechanism from source rather than taking it on trust.

## 2. Why the old 403 could never happen — the chain, with citations

| Step | Where | What |
|---|---|---|
| 1 | `server.ts:1744-1767` | The legacy compat facade is mounted **before** the canonical routes. If `handleLegacyRoute` returns non-null, `route()` returns immediately. |
| 2 | `legacy-http-mount.ts:464` | `if (hasAdminBearer(request)) return null;` — the facade serves this path **only to an `x-api-key` caller**. |
| 3 | `legacy-http-mount.ts:501-533` | The list branch reads **only** `filter`, `page_size`, `page_token`. `?tenant=` is never consulted. |
| 4 | `legacy-http-mount.ts:411-412` | `principal = await request.resolvePrincipal()` → `server.ts:1756-1758` → `resolveApiKey(ctx)`. Scope is the **key**. |
| 5 | `legacy-host-adapter.ts:117-118` | `params = [input.tenantId, input.pageSize + 1]`, `where = ['tenant_id = $1', 'deleted_at IS NULL']`. |
| 6 | `server.ts:1816` | The canonical block with its own x-api-key 403 — **never reached** for this caller, because step 1 already returned. |

**Conclusion: the fence is real and it is intact.** It is expressed as *"a foreign tenant param is ignored and the KEY's tenant is bound into the query"*, not as a status code. The old test asserted a shape the design deliberately does not have.

**Side observation, not fixed (production, out of scope):** because of step 1 + 2, the canonical route's x-api-key 403 at `server.ts:1832-1840` is **shadowed** for anything entering through `route()`. It is dead code on this path. That is arguably fine — the facade enforces the same fence — but it should be a decision, not an accident.

## 3. What changed (2 cases in one file)

### Case A — rewritten, and STRONGER than before

`the x-api-key path is fenced by the KEY: a foreign tenant param is ignored, not honoured`

The old case made one claim (403) and proved nothing about the fence. The new one asserts, for a populated fixture:

- `200` and the **legacy** envelope `{next_page_token, operations}` — which branch ran;
- `pageQuery(calls).params[0] === TENANT_A` — the **key's** tenant got bound;
- `params` does **not** contain `TENANT_B` — the caller's foreign tenant never reached the query;
- `sql` contains `tenant_id = $1` — bound, not concatenated.

**Explicit limit, written into the test:** the fixture's `db.query` returns `db.page` regardless of the `WHERE` clause, so this proves the **predicate** is server-side and bound to the key's tenant. It cannot prove a real PostgreSQL withholds tenant-B rows — that needs a live DB leg. Asserting row absence here would be asserting the mock, not the product.

### Case B — new

`an admin bearer reaches the CANONICAL branch, not the compat facade`

The neighbouring test already covered *"an operator bearer 403s a foreign filter"*, so I did not duplicate it. What was missing was the **positive** proof that the facade declines a bearer and the canonical route actually serves the call. That is now asserted via the envelope key set: `{items, limit, nextCursor, prevCursor, total}`.

## 4. Why these assertions are not vacuous

- **Both envelopes were observed, not assumed.** The legacy key set `{operations, next_page_token}` is the literal resolved value from the pre-fix run in §1; the canonical key set is asserted from a route that returns it. The two sets are empirically distinct.
- **`params` demonstrably carries tenant values in this same file.** The adjacent green test asserts `pageQuery(own.calls).params[0]).toBe(TENANT_A)` on the operator-bearer leg, so `params[0] === TENANT_A` on the x-api-key leg and `params` not containing `TENANT_B` are both sensitive checks, not tautologies.
- **No production edit was made for a control.** A revert-and-restore of the compat host would have been the direct control, but this is a shared checkout and the packet forbids production edits; the argument above stands on observed behaviour instead.

## 5. Verification (literal)

| Check | Before | After |
|---|---|---|
| `admin-operations-sql` | 1 failed / 40 passed / **41 total** | **0 red / 42 passed / 42 total**, exit 0 |
| focused related (5 suites: this file + `admin-operations-view` + `admin-operations-query` + `admin-operations-sort` + `rv01-loopback-http-offline`) | — | **5 suites / 149 tests, 149 passed, exit 0** |
| `tsc --noEmit` orchestrator | — | **exit 0** |

Test count went **41 → 42**: one case rewritten, one added. No case was deleted and no assertion was weakened.

`admin-operations-list-pagination.test.ts` is **deleted in the shared tree** by CONV-10 (visible as `D`, −2031 lines) and could not be run; that is another lane's work and I did not touch it.

## 6. Scope note

`tests/admin-operations-sql.test.ts` is **untracked** (`??`) — it is a CONV-10 artefact, so `git diff` cannot show my edit and `git diff --stat -- tests/` lists only other lanes' changes. My contribution is exactly two `it()` blocks inside that one file. `tests/helpers/` is likewise untracked and **unmodified** by me — I read `operations-page-fixture.ts` and changed nothing in it, so no CONV-10 helper boundary was crossed.

## RESUME POINT

- **FENCE-TEST-ALIGN closed 2026-10-02 (test-only).** The red was a stale assertion, not a fence gap — confirmed from source, not from the prior receipt.
- Open for a lane that owns production code: the shadowed canonical x-api-key 403 (`server.ts:1832-1840`) and the missing live-DB leg that would prove row-level non-leak.
- **Reproduce:** `cd du-rework/services/orchestrator && npx jest tests/admin-operations-sql.test.ts` → 42/42, exit 0.
