# COMP-02 INPUT — legacy connector invocation wire vs rework connector wire

- **Recorded:** 2026-10-01. **Mode:** READ-ONLY characterization.
- **Scope note:** this is evidence gathering for a COMP-02 contract-freeze decision that **has not been made**. Nothing here decides anything. Where a question must be answered before a contract can be frozen, it appears in section 3 as a question.
- **Limits held:** no test run, no gate or task row changed, no commit. `packages/contracts`, `server.ts`, `main.ts` and `docs/21-openapi.json` were **read only** — none was written. This file is my only write.
- **Sourcing rule applied:** every row cites `file:line`. Anything I could not source is written **NOT ESTABLISHED** rather than guessed.

## 0. The single most important structural difference

Legacy calls the **provider** directly: the orchestrator process holds the provider credential and opens the outbound connection to a third-party AI endpoint. Rework calls the **Connector service**, which then calls the provider: the worker holds a short-lived service-identity bearer, and the provider credential never reaches the worker.

Consequence for COMP-02: the two wires are **not** two dialects of one contract. Legacy's multipart-to-provider and rework's JSON-to-connector are different hops with different trust boundaries. Every row below should be read against that.

## 1. Behaviour table

| # | Behaviour | Legacy behaviour | Rework behaviour | Same / different | Evidence |
|---|---|---|---|---|---|
| 1 | **Connector call — method** | `connection.httpMethod`, admin-configured per connector row (not fixed) | `POST` for create/cancel, `GET` for poll | **DIFFERENT** | legacy `external-api.ts:145`; rework `transport.ts:175,180,194` |
| 2 | **Connector call — path** | provider endpoint URL, arbitrary (admin-configured) | `{baseUrl}/invocations`, `/{id}`, `/{id}/cancel` | **DIFFERENT** | legacy `external-api.ts:139`; rework `transport.ts:175,180,194` |
| 3 | **Content type** | `multipart/form-data` (FormData; boundary set by runtime, never explicit) | `application/json` | **DIFFERENT** | legacy `external-api.ts:69`; rework `transport.ts:58` |
| 4 | **Prompt field** | multipart field named by `connection.promptFieldName` (admin-configured name) | `input.prompt` in a `.strict()` JSON body | **DIFFERENT** | legacy `external-api.ts:70`; rework `contracts/connector.ts:44` |
| 5 | **Static form fields** | admin JSON array appended after the prompt (`staticFormFields`) | `input` + `options` only; no arbitrary admin key-value injection | **DIFFERENT** | legacy `external-api.ts:72-79`; rework `contracts/connector.ts:42-51,64-71` |
| 6 | **File bytes field** | multipart `connection.fileFieldName`, appended **once per file**, in loop order | `input.artifacts[]`, each requiring `contentBase64`; max 4 artifacts, 10 MiB each, 15 MiB body | **DIFFERENT** | legacy `external-api.ts:85-95`; rework `contracts/connector.ts:8-9,23,48` |
| 7 | **Field append order** | prompt → staticFormFields → files → (else) `input_content` → remote URLs → session | single JSON document; no ordering semantics | **DIFFERENT** | legacy `external-api.ts:70,74,91,99,105,115` |
| 8 | **Text-only input** | `input_content` field, used only when zero files attached | `input.text` | **DIFFERENT** | legacy `external-api.ts:99`; rework `contracts/connector.ts:45` |
| 9 | **Raw remote URL field** | `connection.fileUrlFieldName` — URL string forwarded to the provider **without** SSRF validation | no URL field exists in the contract; `.strict()` body | **DIFFERENT** — see §2(a) | legacy `external-api.ts:103-107`; rework `contracts/connector.ts:42-51` |
| 10 | **Session id — out** | field `ctx.injectSession ?? connection.sessionIdFieldName`, value `pipelineState.session_id` | `sessionRef` in the signed request + input hash | **DIFFERENT** | legacy `external-api.ts:111-116`; rework `contracts/connector.ts:84`, `task-context.ts:786,813` |
| 11 | **Session id — in** | read from `connection.sessionIdResponsePath` via dot-path | `result.sessionRef` in the typed response | **DIFFERENT** | legacy `external-api.ts:176`; rework `contracts/connector.ts:103` |
| 12 | **Auth header** | yes: `API_KEY_HEADER` → arbitrary `connection.authKeyHeader`, or `BEARER` → `Authorization: Bearer <authSecret>` | `authorization: Bearer <serviceToken>` (worker identity, never the provider credential) | **DIFFERENT in kind** | legacy `external-api.ts:122-124`; rework `transport.ts:57`, `connector-invoker.ts:91-93` |
| 13 | **Grant transport** | no grant concept — the process *is* the credential holder | grant in the **body** (`grant`, signed) **and** as `x-invocation-grant` header | **REWORK-ONLY** | rework `contracts/connector.ts:77`, `transport.ts:59` |
| 14 | **Caller's auth header can be overridden?** | **YES.** Merge order is `accept` (:120) → auth (:122-124) → `Object.assign(headers, JSON.parse(connection.extraHeaders))` (:128). `extraHeaders` is assigned **last** and overwrites any prior key, including the auth header and `accept`. | **NO.** Header set is built in one function with no caller-supplied merge; only `token`, `json` flag and `invocationGrant` inputs (`transport.ts:55-61`) | **DIFFERENT** | legacy `external-api.ts:120-131`; rework `transport.ts:55-61` |
| 15 | **Content read — primary** | `extractContent(responseJson, connection.responseContentPath ?? 'content')` | `InvocationResponseSchema.safeParse` over the whole response | **DIFFERENT** | legacy `external-api.ts:165`; rework `transport.ts:144` |
| 16 | **Content read — missing field** | **Does NOT fail.** Logs a warning and returns `JSON.stringify(responseJson)` — the entire raw response becomes the step content | **Fails closed.** `INVALID_PROVIDER_RESPONSE`, `retryable: false`, message carries pointer+issue-code only | **DIFFERENT — opposite failure posture** | legacy `response-parser.ts:35-36`, `external-api.ts:166-168`; rework `transport.ts:145-156` |
| 17 | **Session read — missing** | warns, leaves `session_id` unset, continues | `result.sessionRef` nullable; absence is schema-valid | **DIFFERENT** | legacy `external-api.ts:177-179`; rework `contracts/connector.ts:103` |
| 18 | **Usage read** | Gemini `usageMetadata.promptTokenCount` **else** OpenAI `usage.prompt_tokens`; both tested by **truthiness**, so a legitimate `0` falls through to the next branch; absent → 0 | `InvocationUsageSchema` with `measurement: 'measured' \| 'estimated'` | **DIFFERENT** | legacy `external-api.ts:191-200`; rework `contracts/connector.ts:90-97` |
| 19 | **Retry on the connector call** | **none** — `fetchWithTimeout` has no retry loop | **none** on invoke; `wait()` polls a pending invocation until `deadlineAt` | **DIFFERENT in kind** (legacy: fail; rework: poll-until-terminal) | legacy `http-client.ts:133-178`; rework `client.ts:37-56` |
| 20 | **Retry on webhook** | 3 attempts, linear backoff (`attempt * 1000`), 10 s timeout each | **NOT ESTABLISHED** — no webhook caller found in the connector path I read | **UNKNOWN** | legacy `engine.ts:73,79,86-88` |
| 21 | **Non-JSON provider response** | **throws** — content-type must contain `application/json` | n/a — JSON contract; non-JSON becomes `INVOCATION_UNKNOWN` on unreadable body | **DIFFERENT** | legacy `http-client.ts:158-166`; rework `connector-invoker.ts:152-166` |
| 22 | **Provider error body** | echoed into the thrown error, first 500 chars (`http-client.ts:157`), then re-wrapped with the connector slug (`external-api.ts:151-153`) | classified by **error class name only**, never `String(err)` (ADM-BASE-03) | **DIFFERENT** | legacy `http-client.ts:157`, `external-api.ts:151-153`; rework `transport.ts:116-124` |
| 23 | **Transport failure** | wrapped as `Connection Error to <slug>: <msg>` — raw message preserved | `INVOCATION_UNKNOWN`, `status: 0`, `retryable: true`, message = class name only | **DIFFERENT** | legacy `external-api.ts:148-153`; rework `transport.ts:125-131`, `connector-invoker.ts:104-111` |
| 24 | **Callback node (workflow schema)** | POST/GET, `Content-Type: application/json` + `buildAuthHeaders`; **`response.ok` never checked, body never read**; always returns `content: 'callback sent'` | **NOT ESTABLISHED** — no counterpart located | **UNKNOWN** | legacy `real-exec.ts:136-148` |
| 25 | **Webhook (workflow engine)** | POST `application/json`, **single attempt, no timeout at all** | **NOT ESTABLISHED** | **UNKNOWN** | legacy `workflow-engine.ts:306-311` |

## 2. The three reviewer-flagged failure modes

### (a) Raw remote file URL forwarded past the egress guard

- **Legacy: EXPOSED.** `external-api.ts:103-107` appends each `ctx.remoteFileUrls` entry to the multipart as a bare string. Those strings are **never** passed to `assertSafeUrl` — the only URL validated on this path is the connector's own `connection.endpointUrl` (`:139`). Legacy *does* guard its separate download path (`file-url-downloader.ts:137`), so the gap is specific to the **forward** mode: a client-supplied `file_urls` value reaches the provider as a URL for the provider to fetch, with no host/IP check on this side.
- **Rework: not expressible, and guarded on the other path.** `InvocationInputSchema` is `.strict()` (`contracts/connector.ts:42-51`) and every artifact requires `contentBase64` (`:23`) — there is **no URL field**, so this cannot be expressed on the invocation wire. URL materialization happens earlier, in `source-acquisition.ts`, behind a pinned egress and a `validateTarget` policy check.
- **Status: legacy has the exposure; rework has neither the surface nor the gap.**

### (b) Validate-then-fetch DNS recheck gap across redirects

- **Legacy: EXPOSED, twice over.**
  1. *DNS TOCTOU.* `assertSafeUrl` resolves DNS itself (`http-client.ts:119`) and returns a **string**; `fetchWithTimeout` then performs a **separate** `fetch` (`:143-149`) that resolves DNS again. Validation and connection are two resolutions.
  2. *Redirects.* The guard's own docstring states "Does NOT follow redirects — caller must handle manually" (`http-client.ts:80`), but the connector call passes no `redirect` option (`:143-149`), so the runtime default applies and redirects **are** followed — with the redirect target **never re-validated**. A provider that redirects to link-local metadata bypasses the guard entirely. Note the legacy download path gets this right for comparison: `file-url-downloader.ts:113` uses `redirect: 'manual'` and re-validates each hop (`:122`).
- **Rework: guarded on acquisition, but the connector hop itself is unguarded.** `source-acquisition.ts:211` uses `redirect: 'manual'` and re-adjudicates **every** hop through `validateTarget` (`:235-238`, with the comment stating the chain never inherits the previous hop's answer). `artifact-streams.ts:418` defaults to `redirect: 'error'`. **However** the connector call itself (`transport.ts:91-96`, `connector-invoker.ts:97-102`) passes no redirect policy either — it relies on `baseUrl` being an internal service address.
- **Status: legacy exposed on both counts; rework hardened on source acquisition, and the connector hop relies on the base URL being internal rather than on a redirect policy.**

### (c) Secret in a URL query string, logged verbatim

- **Legacy: EXPOSED, in five places.** `logCurlCommand` redacts headers (`:22`) and form values (`:28-36`) but interpolates the URL **raw** into the command string (`:20`) and emits it (`:37`). The same URL is logged again at `external-api.ts:147`. Webhook URLs are logged verbatim at `engine.ts:82,84` and `workflow-engine.ts:315`; the callback URL at `real-exec.ts:146`. Separately, `file-url-downloader.ts:137` calls `assertSafeUrl(applyQueryAuth(...))` — the query-string secret is injected **before** validation, and `assertSafeUrl` echoes the entire raw URL when parsing fails (`http-client.ts:87`). Since `webhook_url` is client-supplied, a client can place their own secret in a URL and have it logged.
- **Rework: no URL logging found, and errors carry class name only.** A search for `logger.*(url|href|sourceUrl)` across `worker-sdk/src` returned **0 matches**. Transport failures are classified by `err.name` alone (`transport.ts:116-124`), explicitly per ADM-BASE-03.
- **Status: legacy exposed; rework has neither the logging nor the error echo.**

## 3. Questions COMP-02 must answer (questions, not answers)

1. **Which hop does COMP-02 freeze?** Legacy's contract is orchestrator→provider (multipart, provider credential). Rework's is worker→connector (JSON, service-identity bearer + grant). Are these two separate frozen contracts, or is one a compat projection of the other? Everything else depends on this.
2. **Is multipart-to-provider in scope at all for rework?** If the Connector service is the only sanctioned provider path, then legacy multipart field **names** (`promptFieldName`, `fileFieldName`, `fileUrlFieldName`, `sessionIdFieldName`) are admin configuration that has no rework counterpart — they cannot be "frozen" into a JSON contract. Is that a compat gap, or an intentional retirement?
3. **`extraHeaders` last-write-wins (row 14):** rework has no equivalent and arguably should not. Does COMP-02 declare the override behaviour a **defect not to port** (my read, but it is a decision), and if so does that break any connector whose provider requires a header set only expressible that way?
4. **Missing-content posture (row 16) is a direct behavioural conflict.** Legacy degrades to the full JSON body; rework fails closed. A legacy client that today receives a full response object as `content` would receive an error after cutover. Is that an intentional break to be documented, or must rework adopt a compat projection for the legacy path?
5. **Session continuity (rows 10-11):** legacy carries a provider session across steps via a named form field in and out. Rework carries `sessionRef` in a signed, hash-bound field. Can a legacy `session_id` survive migration at all, or does every in-flight multi-step schema workflow restart?
6. **Usage semantics (row 18):** legacy infers usage from two vendor shapes by truthiness, so a genuine `0` is indistinguishable from absent and the two branches can disagree. Rework requires an explicit `measurement` enum. Does COMP-02 require the legacy inference, or is `measurement` the frozen field with legacy values projected in?
7. **Redirect policy on the connector hop (2b):** rework hardens source acquisition but leaves the connector call on runtime defaults. Should the frozen transport contract **mandate** `redirect: 'manual'` with per-hop re-validation, so the guarantee does not depend on `baseUrl` being internal?
8. **Retry/polling (row 19):** legacy fails the step on the first transport error; rework reconciles a possibly-executed invocation via `INVOCATION_UNKNOWN` and polls. Which contract does COMP-02 freeze for the legacy path — fail-fast or reconcile-and-poll?
9. **Callback and webhook rows (24, 25) are NOT ESTABLISHED on the rework side.** Do these have rework counterparts at all, or are they out of scope for the connector contract? Row 25 also has **no timeout** in legacy — worth confirming that is not reproduced.
10. **Artifact bounds (row 6):** rework caps at 4 artifacts / 10 MiB each / 15 MiB body. Legacy has no such cap on the forward path. What happens to a legacy request that exceeds these — a `4xx` at admission, or a different upload path? This is a compatibility limit, not just a contract detail.

## 4. What I did not establish

- Rework counterparts for the workflow-schema `callback` node and for webhook delivery (**NOT ESTABLISHED** — I did not locate them in the paths read).
- The merge order of `overrideConnector.extraHeaders` versus auth in the schema-workflow executor: the field exists in the legacy type (`types.ts` `ConnectorNode.overrideConnector.extraHeaders`) but I did not verify where it is applied relative to auth (**NOT ESTABLISHED**). Row 14 covers the connector path only, where I read the merge directly.
- Whether any legacy caller supplies `extraHeaders` in practice — it is admin/DB configuration (`externalApiConnections.extraHeaders`), so the exposure is admin-to-admin unless a profile override path also feeds it (**NOT ESTABLISHED**).
- Live behaviour of any of this. No request was issued; every row is a code-read inference.
