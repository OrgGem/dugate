# Legacy rate limiting and operations list query surface

**Scope:** read-only source characterization of legacy `/api/v1/**` rate limiting and `GET /api/v1/operations`, with the rework route as counterpart. This is based on source inspection, not live observations. No source was changed and no tests were run.

## 1. Rate-limit reality

`lib/rate-limit.ts:34-38` exports `checkRateLimit(key, limit, windowSec = 60)`, which resolves to `Promise<RateLimitResult>`. Its success result is `{ allowed, remaining, retryAfter }` (`lib/rate-limit.ts:21-25, 53-58`): it adds a timestamp to a Redis sorted-set window, permits counts `<= limit`, reports zero retry time when allowed, and otherwise reports the configured window (`lib/rate-limit.ts:45-58`). Redis errors fail open as `{ allowed: true, remaining: 1, retryAfter: 0 }` (`lib/rate-limit.ts:59-62`). The exported defaults are 100 per API-key bucket and 30 per IP bucket per minute; the caller uses the helper's 60-second default (`lib/rate-limit.ts:37, 65-67`).

| Call-site surface | Source evidence | Finding |
|---|---|---|
| Legacy source call sites under `app/**`, `lib/**`, and root `middleware.ts` | The only import and invocation are `app/api/internal/auth-key/route.ts:7, 18`. | There is **no caller on the `/api/v1/**` public surface and no call in `middleware.ts`**. The only actual caller is `GET /api/internal/auth-key` (`app/api/internal/auth-key/route.ts:11, 18`). The helper's comment describing `/api/v1/` at `lib/rate-limit.ts:2` does not match the call graph. |
| Internal 429 branch | `app/api/internal/auth-key/route.ts:20-27` | When that internal caller receives `allowed: false`, it returns HTTP 429 with JSON body `{ "valid": false, "error": "Too Many Requests" }`. It sets `Retry-After` and `X-RateLimit-Remaining: 0`; there is no `X-RateLimit-Limit` or `X-RateLimit-Reset` in this response branch. |
| Helper response vs HTTP response | `lib/rate-limit.ts:21-25, 58-62` | The helper returns the result object only; it does not construct an HTTP response or set response headers. The internal route creates the 429 and its two headers. |
| Internal bucket inputs | `app/api/internal/auth-key/route.ts:12-18` | The internal route chooses a bucket from the raw `x-api-key`'s first 16 characters, or from `x-forwarded-for` when no key is present. This caller-supplied bucket choice and the fail-open behavior above are **MUST-NOT-REPLICATE as an authentication fence**. |

## 2. Middleware and Next.js configuration

Per the already verified middleware behavior, `/api/v1/` strips `x-api-key-id`, `x-user-id`, and `x-user-role`, then forwards the request with the updated request headers (`middleware.ts:32-52`). The middleware imports no rate-limit helper (`middleware.ts:4-6`), and its `/api/v1/` branch does not call one. The sole legacy call site remains the internal route above.

The root `middleware.ts` is the only legacy middleware file found; its matcher is declared at `middleware.ts:78-82`. `next.config.mjs:9-20` has no `headers()` function or header rules. No CORS/`Access-Control-*` or rate-limit response rule appears in that config, middleware, or the legacy `app/api/v1/**` route tree. Thus there is no additional middleware or Next config rule applying rate limiting or CORS to `/api/v1/**` in these sources.

The repository claim at `CLAUDE.md:173` — “Rate Limiting: Middleware-level per-API-key rate limiting” — is **not accurate for `/api/v1/**` today**. The only actual `checkRateLimit` caller is under `app/api/internal/**`; `middleware.ts` does not invoke it. `CLAUDE.md:118` also describes rate limiting as part of the middleware, which the current call graph does not support.

## 3. Legacy `GET /api/v1/operations`

The route reads exactly `page_size`, `page_token`, and `filter` via `URLSearchParams.get` (`app/api/v1/operations/route.ts:29-33`). It does not read standalone `page`, `state`, `action`, `from`, or `to` parameters. Unrecognized query names have no effect in this handler.

| Parameter | Default and maximum | Absent value | Invalid/out-of-range handling | Row bound |
|---|---|---|---|---|
| `page_size` | Default `20`; upper cap `100`; **no application-enforced minimum** (`route.ts:31`; Swagger declaration `route.ts:15-18`). | Uses 20, so the page is bounded. | Values above 100 are silently capped. `parseInt` accepts numeric prefixes (for example, `12tail` parses as 12). A non-numeric value becomes `NaN`; the route has no 400 validation or ignore branch and passes `pageSize + 1` to `.limit(...)` (`route.ts:31, 94`). Zero and negative values are also not rejected at parse time. For zero, if any row is returned by the one-row probe, `hasMore` is true while `items` is empty, and line 98 dereferences `items[-1].id` (`route.ts:96-98`). | Yes: SQL/Drizzle query uses `.limit(pageSize + 1)`; at most `page_size` items are returned for ordinary positive parsed values (`route.ts:91-98`). There is no unbounded SQL list query here. |
| `page_token` | No default value beyond `null` when absent; no route-defined length maximum (`route.ts:32`). | No cursor predicate. | The token is treated as an operation ID. If the lookup finds a row, the route filters to `createdAt < cursorItem.createdAt`; a non-matching token produces no cursor predicate and is silently ignored. There is no route-level 400 validation (`route.ts:58-64`). The ID lookup itself has `.limit(1)` (`route.ts:59-60`). | The page query remains bounded by `page_size + 1` (`route.ts:94`). |
| `filter` | No default beyond `null` when absent; no application-defined length or term-count maximum (`route.ts:33, 42-55`). | No filter predicates are added. | It is a comma-separated list of `key=value` entries (`route.ts:42-45`). `state` accepts exactly `RUNNING`, `SUCCEEDED`, `FAILED`, or `PENDING`; any other/missing state value returns HTTP 400 (`route.ts:40, 46-50`). `processor` applies an `ilike` search on `pipelineJson` with no value bound in this route (`route.ts:52-54`). Other filter keys are silently ignored (`route.ts:45-55`). | Filters do not remove the explicit `.limit(pageSize + 1)` (`route.ts:91-94`). |

**MUST-NOT-REPLICATE — conditional API-key scoping:** the route adds `operations.apiKeyId = x-api-key-id` only when that header is present; otherwise its base condition is only `deletedAt IS NULL` (`app/api/v1/operations/route.ts:35-38`). The verified middleware strips a request-supplied `x-api-key-id` and does not resolve an API key into that header (`middleware.ts:32-52`). Therefore a request reaching this route without an internally supplied ID is not scoped to one API key and can page across non-deleted operations. Each response is still page-bounded by the `LIMIT` at `route.ts:94`; this is a missing scope fence, not an unlimited single SQL page.

The legacy cursor is the last returned operation ID (`route.ts:96-98, 127-130`); the next request looks up that row's creation time and uses a strict `createdAt < boundary` predicate (`route.ts:59-63`). The page orders only by `createdAt DESC`, without an ID tie-breaker (`route.ts:91-94`).

## 4. Rework `GET /api/v1/operations`

The handler is `services/orchestrator/src/server.ts:1766-1803`; both the admin-principal and resolved-public-key paths call `parseOperationsListQuery` (`server.ts:1782-1802`). The parser reads an allow-list of exactly six names from `@du/contracts`: `limit`, `cursor`, `state`, `tenant`, `id`, and `sort` (`packages/contracts/src/public-api.ts:54-66`; `server.ts:3049-3053`). Unknown query names are ignored by that allow-listed view.

| Parameter | Default and maximum | Absent/empty value | Invalid/out-of-range handling |
|---|---|---|---|
| `limit` | Default `20`, maximum `100`, minimum `1` (`public-api.ts:51-52, 207-210`). | Defaults to 20. | Runtime parser clamps parsed integers into `[1, 100]`; an unparsable value falls back to 20 rather than producing 422 (`server.ts:3064-3068`). `parseInt` means numeric prefixes are accepted. |
| `cursor` | No default cursor; maximum 128 characters (`public-api.ts:20, 210`; decoder `server.ts:2996-2998`). | Missing or empty means first page (`server.ts:3088-3090`). | Invalid, too-long, malformed, or sort-mismatched cursor returns HTTP 422 (`server.ts:3091-3112`; `HttpError(422)` is emitted as its problem response at `server.ts:749-751`). It is an opaque base64url keyset position carrying a sort-key value, UUID, sort, and optional previous-page marker—not a bare operation ID (`server.ts:2947-2968`). |
| `state` | Default `ALL`; allowed values are `ALL`, `RUNNING`, `COMPLETED`, `FAILED`, `TIMED_OUT` (`public-api.ts:74-82`). | Missing or whitespace-only means `ALL` (`server.ts:3070-3073`). | Trimmed and uppercased before allow-list check. Other values return 422 (`server.ts:3072-3082`). |
| `tenant` | No query default; token maximum 64 characters, starting alphanumeric and then alphanumeric/`_ . : -` (`public-api.ts:102-118, 212`). | Missing or blank means no query tenant filter (`server.ts:3084-3085, 3148-3155`). | Rejected with 422 if the token is outside the runtime filter-token rules, including solid 32+ character hex strings (`public-api.ts:110-118`; `server.ts:3148-3154`). On the public API-key path, the resolved key's tenant remains the SQL scope; a supplied foreign tenant is rejected with 403 (`server.ts:1791-1802`). The admin-principal path derives authorized scope separately (`server.ts:1782-1788`). |
| `id` | No query default; token maximum 64 characters under the same token rules (`public-api.ts:102-118, 213`). | Missing or blank means no ID filter (`server.ts:3084-3085, 3148-3155`). | Invalid token returns 422, including solid 32+ character hex strings (`public-api.ts:110-118`; `server.ts:3148-3154`). A valid value is a case-insensitive substring match on operation ID text, not an exact-ID selector (`server.ts:3187-3192`). |
| `sort` | Default `created_at:desc`; exactly six allowed combinations from `created_at`, `updated_at`, `deadline_at` × `asc`, `desc` (`public-api.ts:136-159, 179-203`). | Missing or whitespace-only uses the default (`server.ts:3130-3136`). | Other values return 422; accepted values are normalized before use (`server.ts:3137-3145`; `public-api.ts:179-193`). |

State, tenant, and ID predicates are built separately from the effective principal scope (`server.ts:3173-3193`). The page SQL appends `LIMIT query.limit + 1`, returns no more than `query.limit` items, and uses the extra row only to determine whether a next page exists (`server.ts:3362-3380`). A separate `count(*)` computes the filtered total (`server.ts:3417-3431`). Thus rework enforces a row limit; it does not return an unbounded page.

## 5. Query-surface parity deltas

| Legacy surface | Rework counterpart | Characterized delta |
|---|---|---|
| `page_size`, default 20/max 100 | `limit`, default 20/min 1/max 100 | Same default and upper page-size cap. Rework clamps below 1; legacy does not validate a minimum. Both issue a `page size + 1` bounded probe (`route.ts:31, 94`; `server.ts:3064-3068, 3362-3380`). Rework therefore does **not** add the only row cap: legacy already has one. |
| `page_token`, no route-defined length max; token is an operation ID | `cursor`, max 128 chars; opaque keyset cursor bound to the sort | Rework adds a cursor length bound and sort-bound keyset semantics. Legacy has no corresponding route-enforced cursor-length cap (`route.ts:32, 58-64`; `server.ts:2947-2968, 2996-3031`). |
| `filter=state=...` supports four legacy state values | `state` is a separate filter with `ALL`, `RUNNING`, `COMPLETED`, `FAILED`, `TIMED_OUT` | Parameter shape and state vocabulary differ (`route.ts:40-50`; `public-api.ts:74-100`). |
| `filter=processor=...` | No processor query parameter | Legacy processor filtering has no rework counterpart in the operations-list allow-list (`route.ts:52-54`; `public-api.ts:58-65`). |
| No standalone `tenant`, `id`, or `sort` parameter | `tenant`, `id`, and `sort` | These rework filters/order parameters have no legacy operations-list counterpart (`public-api.ts:58-65`). Tenant also participates in principal-scoped access as detailed above. |
| No `action`, `from`, or `to` operations-list parameter | No `action`, `from`, or `to` in the six-name allow-list | Neither operations-list route accepts these query parameters (`route.ts:29-55`; `public-api.ts:54-66`). |

**Limits with no legacy counterpart:** rework's minimum `limit=1` and 128-character maximum for `cursor` are explicit bounds absent from legacy. Rework also restricts `tenant`/`id` to tokens of at most 64 characters; legacy's `filter` and `page_token` have no route-defined length cap. The numeric default 20 and maximum 100 are shared. Both routes apply a page `LIMIT`; a statement that rework alone enforces a row limit would be inaccurate.

## 6. Plain conclusion

The `CLAUDE.md:173` claim of middleware-level per-API-key rate limiting is inaccurate for the legacy `/api/v1/**` surface: there is no public-route or middleware caller of `checkRateLimit`; the only actual caller is `app/api/internal/auth-key/route.ts:18`. The legacy operations-list page is SQL-bounded, but its conditional API-key filter is absent when `x-api-key-id` is absent (`app/api/v1/operations/route.ts:35-38, 94`).
