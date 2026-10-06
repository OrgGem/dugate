# CB-03 — Outbound authentication & OAuth2 dispatcher helper — 2026-10-06

- Task: `CB-03` (`tasks/PROFILE-CALLBACK-2026-10-06.md`)
- Owner: OpenCode (oc_2); role: Auth, Secret & Egress Integration Developer
- Status: **IMPLEMENTED + offline-verified; integration into the dispatcher (CB-02/integrator) and live receiver verification (VFY-CB-01) remain OPEN. No acceptance claim.**
- Constraints honored: no commit, no push; strict write lease — only the two new leased source files plus one new test file were created. HMAC delivery signing is untouched and remains independent.

## 1. Requirement → implementation map

| Spec requirement (CB-03 row + Authentication configuration) | Implementation |
|---|---|
| `configured_headers`: attach configured auth headers, safely resolving secret references | `createOutboundAuthSession({mode:'configured_headers'})` validates names against the allowlist (`authorization`, `x-api-key`), rejects reserved/duplicate/unsafe names, and resolves each `secretRef` **per attempt** (rotation applies). Optional validated prefix (e.g. `Bearer `). |
| `oauth2_client_credentials`: form POST with client_id/client_secret (basic or post), validate `access_token`/`expires_in`/Bearer `token_type` | `OAuth2TokenClient` implements RFC 6749 §4.4: `application/x-www-form-urlencoded` POST, `client_secret_basic` (RFC 6749 §2.3.1 form-urlencoded then Base64) or `client_secret_post` (never both), scope/audience/resource + bounded allowlisted extension params (reserved OAuth fields rejected), validates status 200, JSON content type, bounded body, non-empty `access_token`, case-insensitive `Bearer` `token_type`, positive `expires_in`. |
| No indefinite caching when lifetime omitted | Default `missingExpiresIn: {mode:'no-cache'}` (token for the delivery only); explicit `{mode:'assume-seconds', seconds}` is the documented provider-lifetime policy. Cached lifetime also capped (`maxLifetimeSeconds`, default 24 h). |
| Memory cache scoped tenant/profile/revision/endpoint/client/scope/audience/resource/generation | `oauth2CacheKey` hashes all scope + config fields (never the secret); one `OAuth2TokenClient` per scope; `credentialGeneration` is the rotation fence. |
| Renew before expiry with bounded clock skew; single-flight; bounded retries | `renewSkewSeconds` (default 30, clamped to half the lifetime); in-flight promise shared by concurrent callers; transport/5xx retried up to `maxAttempts` (default 2, hard cap 5), 4xx fail closed. |
| 401 invalid token: invalidate exact entry, reacquire and retry at most once, unchanged deliveryId | `dispatchWithAuth(session, send)` invalidates + resends once for OAuth2 sessions only; the caller's `send` closure keeps deliveryId/body/signature unchanged. A second 401 and any 403 are returned as-is. `configured_headers` never reacquires. |
| No redirects; no token/secret in URL/payload/log/error | Token fetch uses `redirect:'error'`; credentials travel in body/Basic header only; token URL rejects userinfo/query/fragment; errors carry a fixed code + HTTP status only; tokens/secret values never appear in error strings. |
| TLS for external credential-bearing endpoints; internal DU HTTP exception explicit | Token URL must be https unless `allowInsecureHttp: true` is explicitly set (internal exception), never a default. |
| Header injection / duplicates / reserved names / CRLF / bounds | Shared validators in `outbound-auth.ts`: RFC 7230 token names ≤64, reserved list (content-*, host, hop-by-hop, `x-du-signature`/`x-du-timestamp`/`x-du-delivery-id`, proxy-*), duplicate detection, printable-only values ≤8192 without control characters, secret refs ≤512. |
| No unauthenticated fallback | Any token/secret failure throws `OutboundAuthError`/`OAuth2Error`; the session never returns empty auth on failure. |

## 2. Changed paths (write lease respected)

| File | SHA-256 | Notes |
|---|---|---|
| `services/orchestrator/src/modules/webhooks/oauth2-client.ts` (new) | `EBF7F1EB26F211565CFA1DC43EA2560FBCF82301B080F00AECF875CB5CC6BBD0` | Token fetch/validate/cache; typed secret-free errors |
| `services/orchestrator/src/modules/webhooks/outbound-auth.ts` (new) | `44435E1E89F5B685D84B7319BF1C66C36BFF783DF3E38AB2B53D718B3701397A` | Policy validation, session, `dispatchWithAuth` single-401-retry |
| `services/orchestrator/tests/cb-03-outbound-auth.test.ts` (new) | `FB957D13DFC505BDB729090CD3126A9C58A990E9B48CCB36627D911C9134A294` | 20 focused tests with a mocked token server |

No other file was edited; `webhooks.ts` (CB-02 dispatcher) and shared egress were not touched.

## 3. Dispatcher integration contract (for CB-02 / integrator)

1. Resolve the admitted endpoint policy → build `OutboundAuthPolicy` (`none` preserves notification-only behavior).
2. `const session = createOutboundAuthSession(policy, { resolveSecret, cacheScope: {tenantId, profileId, profileRevision, endpointKey, credentialGeneration}, oauth2Options })` where `resolveSecret` is the Vault/managed-secret resolver (rotation semantics: resolver should throw on revoked refs; the helper then fails closed).
3. Wrap the existing pinned egress POST:
   `await dispatchWithAuth(session, (authHeaders) => fetchFn(destination, { method:'POST', headers: {...existingHeaders, ...authHeaders}, body, redirect:'error' }))`.
   - HMAC headers (`x-du-signature`, `x-du-timestamp`, `x-du-delivery-id`) stay reserved and unchanged; auth adds only its own headers.
   - The retry closure reuses the same deliveryId/body; the dispatcher's attempt bookkeeping owns whether the 2nd wire call fits the retry budget.
4. 401 handling: `dispatchWithAuth` performs at most one reacquisition+resend for OAuth2. Generic 403 does not retry (delivery failure follows the normal retry policy).

## 4. Verification (offline; literal exits)

cwd `D:/Git/dugate/du-rework/services/orchestrator`, Jest/ts-jest, mocked token server via injected fetch; no real network.

| Command | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | exit **0** (0 diagnostics) |
| `npx jest tests/cb-03-outbound-auth.test.ts --silent` | **1 suite / 20 tests passed**, exit **0** |
| `npx jest tests/cb-03-outbound-auth.test.ts tests/webhook-error-boundaries.boundary.test.ts tests/webhook-delivery-encryption.test.ts tests/runtime-webhook.test.ts --silent` | **3 passed + 1 skipped suite, 57 passed / 9 skipped tests**, exit **0** |

Covered by the new suite: Basic vs post credentials; form body and granted cache; `redirect:'error'`; HTTPS enforcement + explicit internal HTTP exception; renew-before-expiry with fake clock; no-cache default and assumed-lifetime policy; single-flight; 5xx bounded retry vs 4xx fail-closed; response validation (token_type/access_token/expires_in/malformed/oversize); secret provider rotation + `invalidate()`; cache-key scoping (tenant/profile/revision/endpoint/generation) without secrets; header allowlist/reserved/duplicate/CRLF failures; secret-free error mapping; `dispatchWithAuth` 401→reacquire once→200, second 401 returned, 403 no retry, configured_headers no retry.

## 5. Limitations / open items

- **CB-01 freeze**: policy field names/shape in `outbound-auth.ts` are the CB-03 working contract; CB-01 may rename/freeze them. The allowed secret-header names are pinned to `authorization` + `x-api-key` until that freeze (single constant to adjust).
- **CB-02/integrator**: dispatcher wiring and the `resolveSecret` implementation (Vault/managed secret + rotation/revocation) are outside this lease; the helper exposes the seams but is not yet called by `webhooks.ts`.
- **VFY-CB-01**: actual HTTPS token/receiver flows, concurrency/restart/rotation against live deps, and the no-secret-in-logs/URLs inspection on a real process remain independent verification.
- Token response body is bounded by `content-length` when present and by byte count after read otherwise (streaming cap is a follow-up hardening if providers omit length).
- No commit/push/cutover; no task/gate tick.
