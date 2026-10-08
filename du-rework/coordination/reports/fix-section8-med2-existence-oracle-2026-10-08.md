# WFA section 8 MED-2 — existence oracle fix

**Status:** Implemented and verified. No commit, staging, or push.

## Decision

Chose option **(b)**: normalize not-found failures from the operation lookup in the two leased public read routes to the same generic `404 NOT_FOUND` response as the existing tenant/profile ownership checks. This preserves fail-closed authorization while preventing operation-ID-specific error text from distinguishing a missing UUID from an existing but inaccessible workflow. The runtime has a tenant-only `getTenantOperation` SQL fence (`runtime.ts:1807-1810`), but the API-key result path also has a same-tenant profile/API-key ownership check; tenant fencing alone would leave that missing-vs-foreign-profile response split. Adding a tenant-plus-profile SQL lookup would exceed the lease because `runtime.ts` and `modules/runtime/**` are explicitly excluded. The route's actual global lookup error is `404 NOT_FOUND` with `operation ${id} not found`; the ownership fences already use fixed generic text. I left `errors.ts` unchanged because `HttpError.toProblem()` correctly serializes the route's fixed message.

## Scope

Only these leased files may change:

- `orchestrator/services/orchestrator/src/http/routes/public.ts`
- `orchestrator/services/orchestrator/src/http/errors.ts` (only if required)
- `orchestrator/services/orchestrator/tests/<new-test-file>.test.ts`

No WFA plan or OpenAPI file edits. No gate status changes. No live database or DB-window claims.
The shared worktree shows `orchestrator/services/orchestrator/src/modules/runtime/runtime.ts` dirty from concurrent work; this lane did not edit it. `errors.ts` also remains unchanged.

## Changes

- `orchestrator/services/orchestrator/src/http/routes/public.ts:8,61-83,489-500,526` — added a narrow helper that rewrites only `404 NOT_FOUND` errors from a fenced operation read to that route's fixed generic 404. Tenant-operator detail also normalizes a 404 from the second `buildAdminOperationDetail` read, so a deletion between its initial ownership check and detail read cannot reintroduce the ID-specific message. Other error statuses/codes continue unchanged; platform-admin detail and the already tenant-fenced `GET /operations/:id` path are unchanged.
- `orchestrator/services/orchestrator/tests/wfa-section8-med2-existence-oracle.test.ts:1-118` — new isolated route-boundary tests compare the serialized problem for a missing ID against a foreign-tenant ID on tenant-operator detail, and against foreign-tenant plus foreign-profile workflow IDs on API-key result reads. The offline runtime seam throws the exact `HttpError` shape/message from `runtime.ts:1792-1795`; API-key resolution is scripted only to establish the caller identity. These tests exercise `handlePublicRoutes` and `HttpError.toProblem`; they do not claim persistence or SQL-fence coverage.

## Verification

All commands below ran from `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`.

### Fail-first RED

The new test was run before editing `public.ts`:

```text
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/wfa-section8-med2-existence-oracle.test.ts
Exit code: 1
Test Suites: 1 failed, 1 total
Tests:       2 failed, 2 total
```

Both failures were the intended mismatch: missing IDs serialized with title `operation workflow-id-does-not-exist not found`, while ownership failures serialized with the fixed generic title (`not found` for tenant-operator detail; `operation not found` for API-key result).

### GREEN and typecheck

```text
node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs tests/wfa-section8-med2-existence-oracle.test.ts
Exit code: 0
Test Suites: 1 passed, 1 total
Tests:       2 passed, 2 total
```

```text
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
Exit code: 0
```

The TypeScript command has no Jest `Tests:` output line. No live DB was run or claimed. No ACCEPTED/VERIFIED gate was ticked.
