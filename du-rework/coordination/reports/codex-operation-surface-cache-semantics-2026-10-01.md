# Operation surface cache and conditional-request semantics — 2026-10-01

Read-only source characterization. The inventory covers handler/application headers; it does not claim any particular CDN or reverse-proxy deployment policy. No cache, validator, or conditional-request behavior was changed.

## Legacy routes

Across these handlers, none explicitly sets `Cache-Control`, `Expires`, `ETag`, `Last-Modified`, `Vary`, or `Pragma`. `NextResponse.json` supplies JSON content type, while the download handler sets content-specific headers noted below. `next.config.mjs` contains no global `headers()` rule (`next.config.mjs:9-20`).

| Method + path | Handler and response-header behavior |
|---|---|
| `GET /api/v1/operations` | `200` JSON list (invalid state filter returns `400` JSON); no cache/validator headers are set. (`app/api/v1/operations/route.ts:29-50,127-130`) |
| `GET /api/v1/operations/{id}` | `200` JSON detail; missing/deleted and key mismatch return `404`/`403` JSON; no cache/validator headers. This same detail body is the legacy result-equivalent—there is no separate `/result` handler. (`app/api/v1/operations/[id]/route.ts:14-37`) |
| `GET /api/v1/operations/{id}/download` | `200` raw content/file; explicitly sets `Content-Type` and `Content-Disposition`, and may set `Content-Length`; errors are JSON `403`/`404`/`409`. None of these branches sets a cache directive or validator. (`app/api/v1/operations/[id]/download/route.ts:15-42,44-57,79-105,107-118`) |
| `POST /api/v1/docs/ingest` | Delegates to `runEndpoint('ingest', req)`; no route-level response headers. (`app/api/v1/docs/ingest/route.ts:5-6`) |
| `POST /api/v1/docs/extract` | Delegates to `runEndpoint('extract', req)`; no route-level response headers. (`app/api/v1/docs/extract/route.ts:5-6`) |
| `POST /api/v1/docs/analyze` | Delegates to `runEndpoint('analyze', req)`; no route-level response headers. (`app/api/v1/docs/analyze/route.ts:5-6`) |
| `POST /api/v1/docs/transform` | Delegates to `runEndpoint('transform', req)`; no route-level response headers. (`app/api/v1/docs/transform/route.ts:5-6`) |
| `POST /api/v1/docs/generate` | Delegates to `runEndpoint('generate', req)`; no route-level response headers. (`app/api/v1/docs/generate/route.ts:5-6`) |
| `POST /api/v1/docs/compare` | Delegates to `runEndpoint('compare', req)`; no route-level response headers. (`app/api/v1/docs/compare/route.ts:5-6`) |

All six docs handlers share the runner: successful new submission is `202` with `Operation-Location`; sync and idempotent responses are `200` without that header. `NextResponse.json` receives no cache headers. The `apiError` helper likewise sets only body and status. (`lib/endpoints/runner.ts:18-28,256-277`)

`middleware.ts` handles `/api/v1/**` by rewriting **request** headers and returning `NextResponse.next({request:{headers:...}})`; it strips caller-supplied `x-api-key-id`, `x-user-id`, and `x-user-role`, and may inject session identity. It does not mutate the response or add CORS, `Vary`, cache, or rate-limit headers. (`middleware.ts:32-53,78-82`) The middleware’s pass-through applies before these route handlers; it does not make an API response uncacheable.

## Rework routes

The rework server response wrapper sets `x-correlation-id` and defaults `Content-Type` to `application/json`, then copies only headers a route explicitly returns. It sets no global `Cache-Control`, `Expires`, `ETag`, `Last-Modified`, `Vary`, or `Pragma`. Thrown HTTP errors switch content type to `application/problem+json`; their body contract is `type,title,status,code` plus optional `detail,correlationId,errors`—the contract defines no cache headers. (`services/orchestrator/src/server.ts:716-720,798-810,821-831`; `packages/contracts/src/errors.ts:82-99`; `services/orchestrator/src/http/errors.ts:19-24`)

| Method + path | Handler and response-header behavior |
|---|---|
| `GET /api/v1/operations` | `200` list envelope; route returns no explicit response headers. No cache/validator headers. (`services/orchestrator/src/server.ts:1766-1803`) |
| `GET /api/v1/operations/{id}` | `200` operation view (including after optional wait); no explicit response headers or cache/validator headers. (`services/orchestrator/src/server.ts:1806-1841`) |
| `GET /api/v1/operations/{id}/result` | `200` result JSON (or encryption envelope), `409` for non-success, `410` for timeout, `404` for missing/foreign; route adds no cache/validator headers. (`services/orchestrator/src/server.ts:1917-2000`) |
| `GET /api/v1/artifacts/{id}/download` | `200` raw artifact stream sets only the artifact `Content-Type`; encrypted response sets `Content-Type: application/json`. `404`/`409` errors use the common problem response. No cache/validator headers. (`services/orchestrator/src/server.ts:2003-2084,821-831`) |
| `POST /api/v1/businesses/{id}/actions/{action}` (generic submit) | New submission is `202`, replay is `200`; JSON body fields are `operationId,state,stateVersion,replayed,correlationId,links`. Route returns no explicit headers; wrapper still adds correlation ID/default JSON content type, not cache headers. (`services/orchestrator/src/server.ts:1730-1762,716-720`) |

The rework route table is served by the `createServer` response wrapper, not a separate HTTP cache/CORS middleware in these route paths. For the listed routes it does not add CORS or `Vary` headers. The error contract in `packages/contracts/src/errors.ts` describes problem-body fields only; the `application/problem+json` header is applied by the server wrapper (`server.ts:821-831`), with no cache directive.

## Conditional requests

No legacy handler under `app/api` or shared `lib` reads `If-None-Match` or `If-Modified-Since`, emits `ETag`/`Last-Modified`, or returns `304`. The Next App Router response adapter copies the handler response status and headers and streams its body; it does not synthesize a validator or evaluate these conditionals (`node_modules/next/dist/server/send-response.js:13-47`). The operation and docs handlers therefore do not provide an application-level `304` path. A proxy may have its own cache/validator behavior, which is not defined by this repository.

The rework operation routes likewise do not inspect either conditional request header or return `304`; searches of the public server and HTTP helpers found no conditional/validator handling. Its wrapper serializes the route’s status/body and copies only route-provided headers (`services/orchestrator/src/server.ts:798-810,821-831`). Thus `304` is not reachable from the rework application routes as implemented.

## Shared-cache implications

**MUST-NOT-REPLICATE — potentially stale poll responses, legacy:** both the list and detail GETs return the operation’s current stored state but set no cache restriction or validator (`app/api/v1/operations/route.ts:101-130`; `app/api/v1/operations/[id]/route.ts:20-37`). A shared cache configured to use heuristic/default freshness can retain a `200` and serve an older list/detail state on a later poll. The repo does not establish that a particular deployed CDN does so, but these responses are not made uncacheable by the application.

**MUST-NOT-REPLICATE — potentially stale poll responses, rework:** the public list and detail GETs return `state` and likewise set no cache restriction or validator (`services/orchestrator/src/server.ts:1776-1803,1832-1841`; `services/orchestrator/src/modules/operations/facade.ts:32-50`). A shared cache with default/heuristic freshness can therefore serve a stale operation view. Neither side emits `Vary` for its custom key header, and no application-level `private`/`no-store` marker is present; whether a particular intermediary keys by credentials or caches is deployment-specific.

The docs submission and generic rework submit are POSTs with no explicit cache headers; the source does not show them being served from a shared cache. GET result/download surfaces also lack explicit cache restrictions: a proxy policy that caches their `404` (including a not-yet-ready artifact) or configured `409` can preserve an obsolete error response; a cached successful download can continue returning bytes after the origin changes or removes the backing file. The legacy operation download uses `409` before successful completion (`app/api/v1/operations/[id]/download/route.ts:37-42`); rework result uses `409`/`410` and artifact download uses `404`/`409` (`services/orchestrator/src/server.ts:1931-1937,2033-2039`). These are intermediary possibilities, not evidence that a deployed CDN currently caches them.

Plain answer: **yes**, on both sides a shared cache can potentially serve stale `200` list/detail state because those poll responses have neither freshness validators nor a cache prohibition. **No**, an application-level poll response cannot become `304` from these handlers today. This records existing behavior only and makes no policy recommendation or gate/COMP-row change.
