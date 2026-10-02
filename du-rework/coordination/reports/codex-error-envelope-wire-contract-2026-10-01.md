# Error Envelope Wire Contract: Legacy vs Rework (2026-10-01)

## Scope and finding

Read-only characterization of error responses in legacy `app/api/v1/**` and `app/api/internal/**`, plus the rework orchestrator’s HTTP error serialization. No source files or gates were changed, and no tests were run.

The legacy surface is heterogeneous. Some public errors use an RFC7807-shaped object with `type`, `title`, `status`, and `detail`; many API/internal errors instead return `{error}` or `{success:false,error}` (the API-key probe uses `{valid:false,error}`). Rework `HttpError` is serialized as a problem-like object, but the ordinary error path does **not** emit the legacy four-field body: it uses an `urn:du:error:` type, adds `code` and `correlationId`, puts the human message in `title`, and omits `detail`. A permissive JSON consumer can parse the JSON document, but a legacy contract parser requiring all four fields or matching the `https://dugate.vn/errors/...` URI cannot consume it as the same contract.

## Legacy error-body inventory

`lib/endpoints/runner.ts:18-28` defines the shared legacy helper as:

```json
{"type":"https://dugate.vn/errors/<title-slug>","title":"<title>","status":400,"detail":"<detail>"}
```

The response status is also set to the body `status`. Manual problem bodies follow the same base shape, but the operation-detail not-found variant adds `requested_id`; some operation not-found cases omit `detail` entirely (`app/api/v1/operations/[id]/route.ts:23-25,47-50`, download `:23-25`, cancel `:18-20`). Thus even legacy RFC-style bodies have optional/extra members by route.

All legacy type URIs found in the API trees are:

| Wire type URI | Origin / example |
|---|---|
| `https://dugate.vn/errors/unauthorized` | Explicit services guard, `app/api/v1/services/route.ts:13-20` |
| `https://dugate.vn/errors/internal` | Explicit services error and runner catch, `app/api/v1/services/route.ts:79-81`, `lib/endpoints/runner.ts:283` |
| `https://dugate.vn/errors/not-found` | Operation detail/cancel/download, `app/api/v1/operations/[id]/route.ts:23-25`, cancel `:18-20`, download `:23-25` |
| `https://dugate.vn/errors/forbidden` | Foreign operation access, `app/api/v1/operations/[id]/route.ts:29-34` |
| `https://dugate.vn/errors/not-ready` | Download before successful completion, `app/api/v1/operations/[id]/download/route.ts:36-40` |
| `https://dugate.vn/errors/file-not-found` | Missing/inactive/cleaned output file, `app/api/v1/operations/[id]/download/route.ts:72-75,107-110` |
| `https://dugate.vn/errors/no-output` | No output available, `app/api/v1/operations/[id]/download/route.ts:115-117` |
| `https://dugate.vn/errors/already-done` | Cancel of completed operation, `app/api/v1/operations/[id]/cancel/route.ts:32-35` |
| `https://dugate.vn/errors/spending-limit-exceeded` | Submit spending guard, `lib/pipelines/submit.ts:159-169` |
| `https://dugate.vn/errors/service-not-found` | `apiError()` title-derived type, `lib/endpoints/runner.ts:77`; derivation at `:18-28` |
| `https://dugate.vn/errors/invalid-parameter` | Runner discriminator/file URL validation, `lib/endpoints/runner.ts:118,136-152` |
| `https://dugate.vn/errors/endpoint-disabled` | Runner profile guard, `lib/endpoints/runner.ts:180` |
| `https://dugate.vn/errors/missing-parameter` | Workflow/schema form validation, `app/api/v1/docs/workflows/route.ts:23`, schema `:21` |
| `https://dugate.vn/errors/workflow-not-found` | Workflow lookup, `app/api/v1/docs/workflows/route.ts:28` |
| `https://dugate.vn/errors/missing-files` | Workflow requires a document, `app/api/v1/docs/workflows/route.ts:33` |
| `https://dugate.vn/errors/invalid-profile-api-key` | Workflow profile-key validation, `app/api/v1/docs/workflows/route.ts:70`, schema `:72` |
| `https://dugate.vn/errors/internal-workflow-error` | Workflow catch handlers, `app/api/v1/docs/workflows/route.ts:118`, schema `:112` |
| `https://dugate.vn/errors/schema-not-found` | Workflow schema lookup, `app/api/v1/docs/workflows/schema/route.ts:27` |
| `https://dugate.vn/errors/invalid-schema` | Schema validation, `app/api/v1/docs/workflows/schema/route.ts:33` |
| `https://dugate.vn/errors/invalid-input` | Workflow schema input JSON, `app/api/v1/docs/workflows/schema/route.ts:46` |

Other distinct legacy JSON error object shapes found:

| Shape | Where it appears |
|---|---|
| `{"error":"<message>"}` (no `type`, `title`, `status`, or `detail` in the JSON body) | Public invalid-state filter and resume errors (`app/api/v1/operations/route.ts:48`; `app/api/v1/operations/[id]/resume/route.ts:28,32,101`), billing errors (`app/api/v1/billing/balance/route.ts:20,32`; usage `:27,38`), and internal schema/profile routes (`app/api/internal/workflow-schemas/route.ts:22,41,46,53`; `app/api/internal/profile-endpoints/route.ts:24,106,116,131,171`). |
| `{"success":false,"error":"<message>"}` | Internal configuration/action handlers, e.g. `app/api/internal/ext-connections/route.ts:67-90,124`, `app/api/internal/ext-overrides/route.ts:29,54,80,93,96`, `app/api/internal/apikeys/route.ts:33,46,65,77,99,111,114,116,123`, and `app/api/internal/prompt-wizard/route.ts:39,50-56,167-177`. |
| `{"valid":false,"error":"<message>"}` | Internal API-key validation endpoint, including 429, 401, 403, and 500 outcomes (`app/api/internal/auth-key/route.ts:20-25,31-50`). |

The Next middleware also emits a bare `{error:"Unauthorized"}` 401 for API routes that require a NextAuth session (`middleware.ts:58-65`); `/api/v1/**` is separately passed through by the earlier branch (`middleware.ts:28-53`). The legacy raw `x-api-key` resolver in `lib/endpoints/runner.ts:86-107` logs an unknown key and leaves `apiKeyId` unset rather than returning one uniform 401 there, so the services-route missing injected-ID error should not be read as proof that every invalid raw public key gets that same response.

## Situation matrix

For each row, the body column describes the JSON **body**, not merely the HTTP status. The routes differ; where there is no exact legacy counterpart, the table calls that out.

| Situation | Legacy status and body | Rework status and body |
|---|---|---|
| Missing/bad API key | `GET /api/v1/services` with no injected key ID returns **401** problem body `{type:"https://dugate.vn/errors/unauthorized", title:"Unauthorized", status:401, detail:<message>}` (`app/api/v1/services/route.ts:10-20`). The legacy internal key probe returns **401** `{valid:false,error:"Unauthorized: Invalid x-api-key header."}` for a bad raw key (`app/api/internal/auth-key/route.ts:36-41`). The v1 runner’s invalid raw-key lookup is not a uniform rejection (`lib/endpoints/runner.ts:86-107`). | Public routes calling `resolveApiKey` return **401** for missing or invalid `x-api-key`, respectively code `UNAUTHENTICATED`, with a serialized problem body (`du-rework/services/orchestrator/src/server.ts:4182-4193`, serializer `:750-754,822-826`). For missing key, example: `{"type":"urn:du:error:unauthenticated","title":"missing x-api-key","status":401,"code":"UNAUTHENTICATED","correlationId":"<id>"}`. |
| Missing operation | GET operation detail: **404** `{type:"https://dugate.vn/errors/not-found",title:"Operation Not Found",status:404,detail:"Operation '<id>' not found.",requested_id:"<id>"}` (`app/api/v1/operations/[id]/route.ts:21-25`). Cancel/download use 404 `not-found` with title/status only (`cancel/route.ts:18-20`; `download/route.ts:23-25`). | **404**, code `NOT_FOUND`; body uses the shared rework serializer. Public operation detail scopes lookup through `getTenantOperation` (`server.ts:1814-1835`; `modules/runtime/runtime.ts:1336-1340`). `{"type":"urn:du:error:not_found","title":"operation <id> not found","status":404,"code":"NOT_FOUND","correlationId":"<id>"}`. |
| Wrong tenant / foreign operation | Existing operation owned by another API key returns **403** `{type:"https://dugate.vn/errors/forbidden",title:"Forbidden",status:403,detail:"Access denied."}` (`app/api/v1/operations/[id]/route.ts:29-34`; same guard in cancel/download routes). | Public detail uses a tenant-filtered query; a foreign ID is indistinguishable from a missing ID and returns **404** `NOT_FOUND` (`server.ts:1814-1835`; runtime SQL and throw at `modules/runtime/runtime.ts:1336-1340`). The rework 404 body is the same `urn:du:error:not_found` shape shown above. |
| Operation/result not ready | Download returns **409** `{type:"https://dugate.vn/errors/not-ready",title:"Not Ready",status:409,detail:"Operation has not completed successfully."}` (`app/api/v1/operations/[id]/download/route.ts:36-40`). | `GET /api/v1/operations/:id/result` returns **409** `STATE_CONFLICT`, with the state-specific message as `title`; e.g. `{"type":"urn:du:error:state_conflict","title":"operation is <state>, not SUCCEEDED","status":409,"code":"STATE_CONFLICT","correlationId":"<id>"}` (`server.ts:1926-1938`). A terminally expired result is a separate **410 GONE** path at `:1934-1935`. |
| Spending limit reached | Submit short-circuits at **402** with `{type:"https://dugate.vn/errors/spending-limit-exceeded",title:"Payment Required",status:402,detail:"API key spending limit of $<limit> USD has been reached."}` (`lib/pipelines/submit.ts:149-169`). | There is **no matching 402 response** and no spending-limit check in the rework submit path. The route resolves the API key and calls `submission.submit()` (`server.ts:1728-1737`); submission validates schema, artifacts, profile binding, and idempotency but contains no spending-limit/`totalUsed`/budget check (`modules/operations/submission.ts:133-210`). No `402` construction exists under `services/orchestrator/src`. Therefore an over-limit condition does not map to a rework error body at submit; this characterization does not infer any separate post-submit billing behavior. |
| Invalid schema | Schema-driven workflow validation returns **400** RFC-shaped body via `apiError`: `type:"https://dugate.vn/errors/invalid-schema"`, title `Invalid Schema`, status 400, detail with validation issues (`app/api/v1/docs/workflows/schema/route.ts:31-35`; helper `lib/endpoints/runner.ts:18-28`). Other runner parameter failures are 400 `invalid-parameter` (`lib/endpoints/runner.ts:118,136-152`). | Invalid submission/action input returns **422** `INVALID_SCHEMA` with `errors` pointers when available (`modules/operations/submission.ts:140-150,186-202`). Example body begins `{"type":"urn:du:error:invalid_schema","title":"input failed action schema","status":422,"code":"INVALID_SCHEMA","correlationId":"<id>","errors":[...]}`. |
| Unsupported query parameter | Legacy operations listing reads `page_size`, `page_token`, and `filter`; an unrecognized `filter` key is ignored, and unrelated query keys are not rejected (`app/api/v1/operations/route.ts:25-48`). The response remains the ordinary list success body (`:127+`); there is no error envelope for the unknown key. An invalid state value is a different case: **400** bare `{error:"Invalid state filter..."}` at `:43-49`. | On rework `GET /api/v1/usage/events`, an unsupported or repeated key is **422** `INVALID_SCHEMA`, serialized as the rework problem-like body (`server.ts:1270-1285`). This is not the same route as the legacy operations list. The rework operations-list parser separately reads its allowlisted names via `params.get()` and does not iterate unknown top-level query keys (`server.ts:3052-3060`); the explicit 422 at `:1281` must not be generalized to every route. |

## Exact rework serialization

The HTTP boundary sets `content-type: application/problem+json`, calls `err.toProblem(correlationId)`, then JSON-stringifies that value for both ingress errors and routed errors (`du-rework/services/orchestrator/src/server.ts:750-754,822-826`). `HttpError.toProblem()` calls `problem(this.status, this.code, this.message, undefined, { correlationId, ...this.extra })` (`du-rework/services/orchestrator/src/http/errors.ts:8-22`). The contracts helper returns `type: "urn:du:error:<lowercase-code>", title, status, code, detail, correlationId, errors` (`du-rework/packages/contracts/src/errors.ts:102-118`). For ordinary `HttpError`, `detail` is passed as `undefined`; `JSON.stringify` omits that property. `errors` is also absent unless the error supplied it.

For the documented missing-from/to error (`server.ts:1258-1263`), the expected wire JSON is:

```json
{"type":"urn:du:error:invalid_schema","title":"usage summary requires from and to query parameters","status":422,"code":"INVALID_SCHEMA","correlationId":"<request correlation id>"}
```

Unexpected non-`HttpError` throws take a separate, sanitized 500 path. `safeInternalErrorProblem()` returns `type`, `title`, `status`, `code`, `detail`, and `correlationId` (`http/errors.ts:98-106`); the wire uses `urn:du:error:temporary_unavailable`, title `internal error`, status 500, code `TEMPORARY_UNAVAILABLE`, and a generic correlation-ID detail. That path is also `application/problem+json` (`server.ts:755-761,827-833`).

**Legacy parser compatibility:** a client that only JSON-decodes will, of course, receive an object. A client whose contract requires `{type,title,status,detail}` cannot treat an ordinary rework `HttpError` as that body: `detail` is absent, the type URI has changed from `https://dugate.vn/errors/...` to `urn:du:error:...`, and `code` is an added required rework field in the contracts schema. A client that tolerates an absent `detail` may read the first three values, but any client branching on legacy type URIs will not recognize the rework error. The sanitized 500 includes `detail`, but still uses the URN type and added `code`/`correlationId`.

## URI/code names visible to clients

Legacy clients could have hard-coded any of the 20 `https://dugate.vn/errors/...` URIs listed above. URI spelling is title-derived for the `apiError()` call sites and manually authored for the operation, service, and spending-limit errors; there is no stable machine `code` member in the legacy problem helper.

For the matrix cases, rework exposes these machine codes: `UNAUTHENTICATED` (legacy `unauthorized`), `NOT_FOUND` (conceptually overlaps legacy `not-found`, but is now a `code` plus URN type), `STATE_CONFLICT` (used for legacy `not-ready`), and `INVALID_SCHEMA` (legacy has `invalid-schema` URI but no code member). `PERMISSION_DENIED` is present for rework authorization failures on routes that return 403; the public operation-detail foreign-tenant case instead deliberately maps to `NOT_FOUND`. These code strings are not legacy type URIs, and no rework code/response corresponds to `spending-limit-exceeded` because submit does not enforce that limit.

The contracts package’s declared public error-code catalog is separately visible at `du-rework/packages/contracts/src/errors.ts:22-42`; the actual HttpError examples above should be read from their construction sites, not inferred from a status or from catalog membership.
