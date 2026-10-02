# Billing and Spending-Limit Wire: Legacy vs Rework (2026-10-01)

## Scope and finding

Read-only source characterization. This report covers the public legacy balance/usage handlers, the legacy submit-time spending-limit path and `totalUsed` writes, and rework HTTP routes/services that expose usage or budget decisions. No source was changed, no tests were run, and no accounting reconciliation was attempted.

Legacy `/api/v1/billing/balance` returns a stored API-key spending cap, stored all-time `totalUsed`, and a derived USD remainder. Legacy `/api/v1/billing/usage` is a separate date-window aggregate over completed operation rows. Rework exposes tenant-scoped usage summaries and event exports, but no HTTP route returns the legacy spend cap or remaining balance, and no rework operation-submit route checks a spending limit. The rework budget-reservation service can compute a `BLOCKED` admission decision internally, but the current server routes and `submission.submit()` do not call it.

## Legacy billing wire

### `GET /api/v1/billing/balance`

On success, the exact JSON shape is:

```json
{
  "object": "billing_balance",
  "api_key_id": "<ApiKey.id>",
  "api_key_name": "<ApiKey.name>",
  "currency": "USD",
  "details": {
    "spending_limit": "<number or null>",
    "total_used": "<number>",
    "balance": "<number or null>"
  },
  "updated_at": "<current ISO timestamp>"
}
```

The handler selects `id`, `name`, `spendingLimit`, `totalUsed`, and `status` from the `ApiKey` row (`app/api/v1/billing/balance/route.ts:23-29`). `api_key_id`, `api_key_name`, `spending_limit`, and `total_used` project those row values; `status` is selected but omitted from the response. `role` exists in the model but is neither selected nor returned. `currency` is the literal `USD`, not a database value. `balance` is computed in the handler as `spendingLimit - totalUsed` when the limit is positive, otherwise `null`; the code does not clamp a negative result. `updated_at` is `new Date().toISOString()` at response construction, not the row's `updatedAt` (`:35-51`).

The numeric limit/used fields are dollar-denominated values: the model stores both `spendingLimit` and `totalUsed` as `doublePrecision` with default `0.0` (`lib/db/schema.ts:54-62`), and the route labels the currency USD. The route returns `null` for `spending_limit` and `balance` when the stored limit is zero or less. Error bodies are bare JSON: missing `x-api-key-id` gives HTTP 401 `{"error":"Unauthorized"}` (`:18-21`); no matching row gives HTTP 404 `{"error":"API key not found"}` (`:31-33`).

### `GET /api/v1/billing/usage`

On success, the response fields are:

```json
{
  "object": "billing_usage",
  "start_date": "<YYYY-MM-DD>",
  "end_date": "<YYYY-MM-DD>",
  "total_cost_usd": 0,
  "total_input_tokens": 0,
  "total_output_tokens": 0,
  "total_operations": 0,
  "usage": [
    {
      "model": "<model or unknown>",
      "prompt_tokens": 0,
      "completion_tokens": 0,
      "pages_processed": 0,
      "cost_usd": 0
    }
  ]
}
```

`start_date`/`end_date` come from optional `start_date`/`end_date` query parameters; defaults are the preceding 30 days through the current time (`app/api/v1/billing/usage/route.ts:30-35`). The handler queries `operations` rows for this API key where `state='SUCCEEDED'`, `done=true`, and `createdAt` is within the inclusive date bounds. It selects model, endpoint slug, token counts, page count, and `totalCostUsd` (`:43-56`). It groups rows by `modelUsed` (null becomes `unknown`) and sums numeric values into the response (`:59-82`); `total_operations` is `opsList.length`, and `endpointSlug` is selected but not emitted. Costs are dollar values under the `*_usd` names. Errors are also bare: missing `x-api-key-id` is HTTP 401 `{"error":"Unauthorized"}`, and invalid dates are HTTP 400 `{"error":"Invalid date format. Use YYYY-MM-DD."}` (`:25-39`).

### `ApiKey` model fields relevant to billing

`ApiKey` declares `id`, `name`, `keyHash`, `prefix`, `role`, `note`, `spendingLimit`, `totalUsed`, `status`, `createdAt`, and `updatedAt` (`lib/db/schema.ts:54-62`). `role` defaults to `STANDARD`, `spendingLimit`/`totalUsed` are `doublePrecision` values defaulting to zero, and `status` defaults to `active`. The balance handler queries `status` but does not include it in its response; the usage handler does not query `ApiKey` at all, only the injected key ID and matching operation rows.

## Legacy 402 path and `totalUsed` lifecycle

`submitPipelineJob()` first checks an existing idempotency key and returns the existing operation if found (`lib/pipelines/submit.ts:142-147`). For a non-replayed submission with an API key, it reads `spendingLimit` and `totalUsed` and compares `spendingLimit > 0 && totalUsed >= spendingLimit` (`:149-159`). On a reached limit it returns `ok: false` with HTTP 402 and this body:

```json
{
  "type": "https://dugate.vn/errors/spending-limit-exceeded",
  "title": "Payment Required",
  "status": 402,
  "detail": "API key spending limit of $<limit toFixed(2)> USD has been reached."
}
```

The response is returned by the submit helper at `:159-170`; `runEndpoint()` immediately returns `result.errorResponse` on the `!result.ok` branch (`lib/endpoints/runner.ts:250-254`). The 402 check precedes operation ID allocation (`submit.ts:188`), operation insertion (`:300-320`), and queue submission (`:373+`), so that rejected non-idempotent call creates/enqueues no new operation in this path. An idempotent replay is checked earlier and returns the existing row before evaluating the limit.

`totalUsed` is incremented after successful processing, not at submit. The regular pipeline engine first records the operation as `SUCCEEDED` with `totalCostUsd`, then adds `totalCost` to `ApiKey.totalUsed` when an API key exists and cost is positive (`lib/pipelines/engine.ts:405-420`). Workflow completion similarly marks the operation `SUCCEEDED`, then adds `ctx.totalCost` (`lib/pipelines/workflow-engine.ts:224-239`). The source search found these as the `totalUsed` update sites in `lib/` and `app/`. In the regular pipeline failure handler, the operation is marked `FAILED` and there is no `totalUsed` update (`engine.ts:450-473`).

An operation already enqueued when `totalUsed` reaches the limit is not cancelled by the submit check: the check runs in `submitPipelineJob`, while the running worker path continues through the engine. If such a pipeline/workflow completes successfully with positive cost, its completion path increments `totalUsed` as above. The source does not show an engine-side spend-limit recheck for already queued work.

## Rework usage and budget surfaces

A search of the orchestrator route dispatch shows the following HTTP paths that accept or return usage/cost information:

| Route | Wire data returned / embedded | Source |
|---|---|---|
| `POST /api/runtime/v1/usage-events` | HTTP 200 acknowledgement `{accepted: string[], duplicates: string[]}`. The ingested `UsageEvent` includes `eventId`, `invocationId`, `operationId`, `taskId`, `units`, `costMicrousd`, `currency`, `measurement`, and `occurredAt`. | `server.ts:1243-1252`; input/ack contracts `packages/contracts/src/runtime.ts:405-431`; `modules/usage/usage.ts:319-355` |
| `GET /api/v1/usage/summary?from=…&to=…` | Tenant-scoped `UsageSummary`: `tenantId`, `from`, `to`, `rows`, `totals`. Each row has `provider`, `model`, `operations`, `inputTokens`, `outputTokens`, `pages`, `costMicrousd`, `measurement`; totals has `operations`, `inputTokens`, `outputTokens`, `pages`, `costMicrousd`. | `server.ts:1255-1266`; shape `modules/usage/usage.ts:91-116,378-497` |
| `GET /api/v1/usage?tenantId=…&from=…&to=…` | Same `UsageSummary` shape; the caller is resolved as either admin principal or API key, with tenant scope taken/checked accordingly. The route passes no optional budget input. | `server.ts:1321-1351`; shape `modules/usage/usage.ts:91-116,378-497` |
| `GET /api/v1/usage/events?...` | Bounded page `{tenantId, events, limit, hasMore, nextCursor?, skippedInvalidEvents, timeSemantics:{field,order,timezone}}`. `events` are strict ledger records, including attribution IDs, operation/task/invocation, provider/model, units, `costMicrousd`, `currency`, `costStatus`, and event timestamps. | `server.ts:1269-1318`; page contract `packages/contracts/src/usage-reconciliation.ts:175-209`; ledger record `packages/contracts/src/usage-metrics.ts:223-309`; projector `modules/usage/usage.ts:526-650` |
| `GET /api/v1/operations/:id/result` | Successful result contains `usage:{inputTokens,outputTokens,costMicrousd,measurement}` inside the plaintext result `{schemaVersion,data,artifacts,usage,warnings}`. Tenant delivery policy may wrap that result in the encrypted delivery body. | `server.ts:1917-1997`, especially `:1983-1987`; projection `modules/usage/usage.ts:357-376` |
| `GET /api/v1/operations/:id` with admin bearer | Admin operation-detail response `{operation,result,artifacts,serverNow}`; when terminal/succeeded, `result` contains the same `usage` projection. Public API-key operation detail uses `toOperationView()` and does not include usage fields. | `server.ts:1806-1840,4148-4177`; operation view `modules/operations/facade.ts:27-50` |

`getReconciliationSummary()` is defined on the usage service and returns `{summary,projectedEvents,rejectedRows,pricing?,aggregation?}` (`modules/usage/usage.ts:48-52,502-524`), but no HTTP handler calls it. Similarly, `UsageService` exposes `budgetReservations` (`:34-38`) and constructs the reservation service (`:317-319`), but a repository search found no orchestrator/connector HTTP route or production caller invoking its methods.

The optional `UsageSummaryOptions.budget` could add a `budget` object to a summary when a caller supplies budget inputs (`modules/usage/usage.ts:114-128,457-497`). The actual HTTP summary routes call `getUsageSummary(tenantId, from, to)` without that fourth argument (`server.ts:1266,1344,1351`), so their JSON does not include `budget`.

The reservation engine is a real internal capability, distinct from submit-time spending balance. `reserve()` evaluates a configured budget plus committed usage and held reservations; for an active `block-new-invocations` budget, it can persist a `BLOCKED` reservation and return `{decision:"BLOCKED",hardCapEnabled,evaluation,reservation}` (`modules/usage/budget-reservations.ts:451-540`). The service also has `markRunning`, `markUnknown`, `releaseBeforeCall`, and `reconcile` methods (`usage.ts:34-38`; implementation `budget-reservations.ts:396-650`). Invalid/untrusted reservation state maps to `503 BUDGET_RESERVATION_UNAVAILABLE` (`:125-175`), which is not the decision returned for an evaluated cap. However, no current HTTP route/call site invokes `usage.budgetReservations.reserve()`; `submission.submit()` does not reference `budgetReservations`, `spendingLimit`, or `totalUsed` (`modules/operations/submission.ts:133-210`). Therefore the internal `BLOCKED` capability is not currently an HTTP rejection of operation submission, and no route emits 402 for a spending-limit condition.

## Field-by-field delta: legacy balance vs closest rework surface

The closest rework read surface is `GET /api/v1/usage` (or `/api/v1/usage/summary`), but it is a date-window tenant usage summary, not an API-key balance.

| Legacy `billing_balance` field | Legacy source/meaning | Closest rework summary | Status |
|---|---|---|---|
| `object: "billing_balance"` | Fixed discriminator | No corresponding `object` field | **Absent** |
| `api_key_id` | `ApiKey.id` | Rework scopes summary by tenant; it returns `tenantId`, not an API-key ID | **Absent**; `tenantId` is not the same field/scope |
| `api_key_name` | `ApiKey.name` | No API-key name in summary | **Absent** |
| `currency: "USD"` | Fixed response literal | Summary has `costMicrousd` integer fields; it emits no summary-level currency field. Ingest/event records carry `currency: "USD"`. | **Absent** from summary; present only on event records |
| `details.spending_limit` | `ApiKey.spendingLimit`, USD dollars; `null` when no positive limit | No stored spend-cap or balance value in summary; optional budget evaluation is not passed by the HTTP routes | **Absent** |
| `details.total_used` | `ApiKey.totalUsed`, USD dollars, stored total | `totals.costMicrousd` is the closest cost-total name, but it is scoped to the requested usage window and is expressed in micro-USD | **Differently named and different scope/unit; not an equivalent all-time stored total** |
| `details.balance` | Handler calculation `spendingLimit - totalUsed`, USD dollars, or `null` | No remaining-balance field or limit-minus-consumption calculation | **Absent** |
| `updated_at` | Current response-generation time, ISO timestamp | Summary returns `from` and `to` as the selected usage window, not a balance refresh time | **Absent** |
| HTTP 402 over-limit reject | `spending-limit-exceeded` type URI with `Payment Required` detail | No HTTP 402 construction or submit-side over-limit response found; rework submit uses the operation creation path without a spending-limit check | **Absent** |

This comparison is limited to wire fields and control flow. It does not assess or reconcile stored-total versus query-time-sum accounting.
