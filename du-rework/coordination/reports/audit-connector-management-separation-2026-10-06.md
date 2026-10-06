# AUDIT-CONNECTOR-MANAGEMENT-SEPARATION — independent audit receipt

- Task: `task_8f1161e6d213` (ctx `ctx_720f414bff0f`)
- Date: 2026-10-06
- Auditor: OpenCode (read-only static audit lane)
- Standard under audit: PLAT-MIG-03 (`task_9ee833042ba7`); prior independent verification VERIFY-PLAT-MIG-03-905 (`task_56f661bd2aef`, 2026-10-05)
- Constraints honored: static code reading only; **no source/doc/test/spec edits; no commits; no test runs; no runtime/network calls**. The only file written is this receipt.
- Status: **AUDIT COMPLETE — separation verdict: HOLDS (no route mixes invoke and management authority).** Findings: 0 HIGH, 0 MEDIUM; 5 LOW/informational observations in §6. No `VERIFIED`/`ACCEPTED` disposition is claimed here.

## 1. Scope and actual repository layout

The dispatch named `services/connector/src/routes` and handlers. On 2026-10-06 that directory does not exist: the connector service router is `services/connector/src/http/server.ts`. The URLs in scope (`/api/v1/connectors/:id/...`, `/api/v1/admin/connectors/...`) are served by the **orchestrator**, which proxies the connector service root routes (`/connectors`, `/invocations`). The audit therefore covers the whole chain, not a single directory:

| Layer | Files read |
|---|---|
| Ingress fence (listeners) | `services/orchestrator/src/http/ingress-guard.ts`; `src/app/bootstrap/create-app.ts`; `src/server.ts` |
| Platform **invoke** family | `services/orchestrator/src/http/routes/public.ts`; `routes/api-key-auth.ts`; `modules/connectors/connectors.ts`; `modules/connectors/probe-authorization.ts` |
| Platform **management** family | `services/orchestrator/src/http/routes/admin.ts`; `modules/admin-actions/rbac.ts`; `modules/admin-actions/dispatcher.ts`; `modules/connectors/connector-management-store.ts`; `modules/connectors/management-service-identity.ts`; `src/main.ts`; `app/admin/mutation-dispatch.ts`; `app/admin/bff/*` (auth gates) |
| Connector service router + handlers | `services/connector/src/http/server.ts`; `identity.ts`; `contract-grants.ts`; `grants.ts`; `services.ts`; `entrypoint.ts`; `types.ts` |
| Invoke client + token contracts | `packages/connector-client/src/transport.ts`; `packages/contracts/src/connector.ts`; `packages/worker-sdk/src/worker.ts`; `businesses/document-core/src/config.ts` |

Honest note on wire reality: provider invocation is **internal** (worker → connector service `POST /invocations`). The public `/api/v1/connectors/:id/...` family has exactly one live route, `GET /api/v1/connectors/:id/test` (a tenant-gated readiness probe). Management is `/api/v1/admin/connectors...` plus mutations through `POST /api/v1/admin/actions`.

## 2. Route inventory and separation matrix

### 2.1 Ingress (orchestrator listeners)

| Rule | Source | Behavior |
|---|---|---|
| Public listener denies the admin family | `ingress-guard.ts:21-32,39-47`; enforced first in `create-app.ts:719-725` | `GET/POST/... /api/v1/admin/**` → generic 404 for every method, even with a valid admin credential, body not read |
| Internal listener keeps all families | `create-app.ts:861-867` | each handler still enforces its own auth; internal binds `127.0.0.1:3002` by default (`main.ts:253-254`), Compose does not publish it |
| Worker credentials fenced | `server.ts:281-287` | worker bearer may only reach `/api/runtime/v1/**`; 403 PERMISSION_DENIED elsewhere (both connector surfaces included) |
| Dispatch order | `server.ts:331-336` | runtime → public → admin; families are disjoint prefixes |

### 2.2 Platform invoke family (public)

| Method + path | Auth | Handler | File:line |
|---|---|---|---|
| `GET /api/v1/connectors/:id/test` | `x-api-key` only (`resolveApiKey`: SHA-256 hash lookup, ACTIVE only) **then** tenant binding fence `authorizeConnectorProbe` (enabled, published profile binding for this key+tenant; no global/legacy fallback) | sanitized readiness probe via `ConnectorProxy.testConnector` → connector `GET /health/ready`; upstream text never echoed | `public.ts:203-216`; `api-key-auth.ts:10-22`; `probe-authorization.ts:11-44`; `connectors.ts:42-84` |

- No admin-bearer alternate path on this route (unlike usage/operations routes), and no other `/api/v1/connectors/:id/*` handler exists (all others 404 by dispatch fall-through).
- Probe carries no caller headers and no credential material (`connectors.ts:55-62`).

### 2.3 Platform management family (admin)

| Method + path | Auth | Handler | File:line |
|---|---|---|---|
| `GET /api/v1/admin/connectors/capabilities` | `assertAdminAuth` (platform admin bearer; fail-closed 401 when unset) | composition booleans only | `admin.ts:44-55,532-542` |
| `GET /api/v1/admin/connectors` | `assertAdminAuth` | management store list (503 without store) | `admin.ts:543-557` |
| `GET /api/v1/admin/connectors/:id/revisions/:rev` (`latest`/`current` sentinels) | `assertAdminAuth` | real revision read; honest placeholder when store absent | `admin.ts:559-619` |
| `GET/POST /api/v1/admin/connectors/:id/credentials` | `assertAdminAuth` | write-only rotate + masked describe; 503 without workflow | `admin.ts:242-277` |
| `POST /api/v1/admin/actions` (`connector.upsert/bootstrap/activate/disable/retire/test`, `connectors.rotate/revoke/test_credential`) | dispatcher RBAC: bearer `platform` or cookie `admin` (+CSRF); operator/viewer denied; 405 non-POST; 404 unknown action | `dispatcher.ts:120-157,213-215,1183`; route `admin.ts:317-360` |
| Admin shell BFF `/admin/api/connectors...` | browser session gate 401/403 + CSRF for mutations | calls the internal listener with the admin bearer | `app/admin/bff/handle.ts:224-258`; `bff/identity.ts:92-134`; `mutation-dispatch.ts:31-77` |

No management handler exists under `/api/v1/connectors`, and no invoke handler under `/api/v1/admin` (greps over `services/orchestrator/src` in §8).

### 2.4 Connector service root router (downstream enforcement point)

Scope is selected per request in one place: `requireServiceIdentity(..., path.startsWith('/connectors') ? 'connector:manage' : 'connector:invoke')` (`server.ts:131-140`); `/health/live` and `/health/ready` are the only exempt paths (`server.ts:131,158-162`).

| Route | Required scope | File:line |
|---|---|---|
| `GET /connectors`, `POST /connectors` | `connector:manage` | `server.ts:164-198` |
| `POST /connectors/:id/revisions`, `/revisions/bootstrap`, `/revisions/:rev/activate`, `/revisions/:rev/retire`, `GET .../revisions/current`, `GET .../revisions/:rev` | `connector:manage` | `server.ts:199-298` |
| `POST /connectors/:id/credentials/rotate`, `POST /connectors/:id/disable`, `POST /connectors/:id/test` | `connector:manage` | `server.ts:335-352` |
| `GET /capabilities` | `connector:invoke` | `server.ts:163` |
| `POST /invocations`, `GET /invocations/:id`, `POST /invocations/:id/cancel` | `connector:invoke` (+ separate invocation grant for get/cancel) | `server.ts:299-334` |
| `GET /health/live`, `GET /health/ready` | none (no store/runtime call) | `server.ts:158-162` |

Issuance side: orchestrator mints a **fresh manage-only JWT per outbound request** for `/connectors*` (`management-service-identity.ts:5-8,16-44`: `sub=orchestrator-management`, `aud=connector`, `scopes=[connector:manage]`, `iat`, `exp=iat+60`, `jti`); worker invoke tokens come from deployment env `CONNECTOR_SERVICE_TOKEN` (`businesses/document-core/src/config.ts:30-36,75`; `worker-sdk/src/worker.ts:162-166`) and ride the connector-client transport (`transport.ts:54-61,164-202`).

## 3. Token validation (aud / scope / expiration)

### 3.1 Connector service identity (Authorization: Bearer JWT)

| Check | Expected | Actual | File:line | Failure wire |
|---|---|---|---|---|
| Signature | HMAC-SHA256, timing-safe, `alg=HS256` pinned | yes | `contract-grants.ts:21-35` | 401 `GRANT_INVALID` |
| `exp` | present, integer, `> now` (seconds) | required; `exp <= now` rejected | `identity.ts:22-25` | 401 |
| `aud` | exactly `connector` (accepts `aud` or `audience`, single string) | required string; compared to `connector` | `identity.ts:27-29,54` | 403 `BINDING_DENIED` |
| `sub` | non-empty subject | required string | `identity.ts:26-29,54` | 403 |
| `scopes` | array of strings including the route's required scope | optional, defaults `[]`; malformed rejected | `identity.ts:31-33,54` | 403 |
| Scope per family | `/connectors*` → `connector:manage`; everything else → `connector:invoke`; health exempt | exact single-scope selector; **no route requires both, none accepts either** | `server.ts:131-140` | 403 |
| Trust source | scope only from signed claims | `x-service-scope` header is passed to the verifier but **ignored** (`identity.ts:12-14`) | `server.ts:135` | n/a |

### 3.2 Invocation grant (second factor, distinct from service identity)

| Check | Actual | File:line |
|---|---|---|
| Shape | `audience` literal `'connector'`, int `iat`/`exp`, binding slots, strict object | `packages/contracts/src/connector.ts:142-178` |
| Verify | HMAC signature via same `HmacSignedGrantSource`; schema parse | `contract-grants.ts:9-16,18-36` |
| Binding on invoke | tenant/operation/task/step/invocationId/inputHash equality + `expiresAt > now` + revision `id:rev` exists, ACTIVE, tenant-bound | `grants.ts:10-38`; `services.ts:68-104` |
| Binding on get/cancel | `x-invocation-grant` required; missing → 403 `BINDING_DENIED`; validated against the stored record | `server.ts:299-334`; `services.ts:165-193` |

### 3.3 Platform-plane credentials (perimeter)

| Credential | Validation | File:line |
|---|---|---|
| Admin bearer | literal compare with configured token, constant-time, fail-closed 401 when unset | `admin.ts:44-55`; `rbac.ts:30-58` |
| Admin cookie | HMAC-signed, `exp` enforced, `iat` skew check; cookie mutations require CSRF proof | `shell-auth.ts:105-138`; `rbac.ts:140-157,256-263,445-449` |
| OIDC session | server-side store decides; dead/revoked session never downgrades to legacy cookie | `rbac.ts:401-428` |
| API key | SHA-256 hash lookup, ACTIVE rows only, no fallback | `api-key-auth.ts:10-22` |

Platform tokens are opaque static credentials (no `aud`/`scope` claims by design); JWT `aud`/`scope`/`exp` semantics live on the orchestrator→connector service-identity plane (§3.1) and on the invocation grant (§3.2). Boot refuses a half-set management surface: `SERVICE_IDENTITY_SECRET` is required with `DU_CONNECTOR_BASE_URLS` (`main.ts:162-189`); secrets must decode to exactly 32 bytes (`management-service-identity.ts:21-24`; `entrypoint.ts:78-83`).

## 4. Separation checks — expected vs actual

| # | Check | Result |
|---|---|---|
| S1 | Public ingress cannot reach any admin route (generic 404, no credential oracle) | PASS |
| S2 | Internal admin listener is loopback-only by default and unpublished | PASS |
| S3 | `/api/v1/connectors/:id/test` requires a tenant API key + published binding; never an admin token | PASS |
| S4 | All `/api/v1/admin/connectors...` reads enforce admin auth before store access | PASS |
| S5 | All connector mutations are admin-only in the action matrix (platform bearer / admin cookie+CSRF) | PASS |
| S6 | No invoke path exists under `/api/v1/admin`; no management path exists under `/api/v1/connectors` | PASS |
| S7 | Connector `/connectors*` requires `connector:manage`; `/invocations` + `/capabilities` require `connector:invoke` | PASS |
| S8 | An invoke-only identity cannot manage; a manage-only identity cannot invoke; neither can read the other's routes | PASS (single-scope selector; tests pin 403s on both directions — `plat-mig-03-root-contract.test.ts:82,140-143`) |
| S9 | `/capabilities` is invoke-level; a manage-only token gets 403 | PASS (`server.ts:138,163`; test `:89-94`) |
| S10 | Health endpoints are unauthenticated but side-effect-free and expose no connector data | PASS (deliberate; `server.ts:158-162`; test `:101-106`) |
| S11 | Route scope is never taken from a caller header | PASS (`x-service-scope` inert) |
| S12 | Worker credentials cannot reach either connector surface | PASS (`server.ts:281-287`) |
| S13 | Invocation get/cancel require the invocation grant, tenant-bound and expiry-checked | PASS |
| S14 | Management proxy and invocation client use disjoint root paths and disjoint scopes | PASS (`connector-management-store.ts:120-211` manage; `transport.ts:164-202` invoke) |

## 5. Cross-check with the PLAT-MIG-03 pinned inputs

The audited enforcement points are **byte-identical** to the PLAT-MIG-03 / VERIFY-905 pinned artifacts (SHA-256, §8): connector `server.ts` `5695E392…`, `identity.ts` `7A24DEE9…`, orchestrator `admin.ts` `BF77179F…`. Consequence: the VERIFY-905 test evidence (40 connector tests incl. 26 root-contract tests, 22 client tests, 19 proxy tests, all green on 2026-10-05) applies to the exact code audited here. This audit did **not** re-run tests (read-only constraint).

## 6. Findings

| ID | Severity | Finding |
|---|---|---|
| F-01 | LOW (hardening) | Scope classification is a single prefix test `path.startsWith('/connectors')` (`server.ts:138`), not derived from the matched route table. No current route is misclassified (every real handler starts with `/connectors` or is an invocation/capability/health route), but a future invoke-family route named `/connectors-*` would silently demand `connector:manage`. Fix belongs to a future change lane: derive the required scope from the route table, or tighten to exact `/connectors`/`/connectors/` prefix. |
| F-02 | LOW (naming/semantics) | Two probe semantics coexist on the management plane: `connectors.test_credential` (admin action + admin shell button) and the public `/test` route both call the **readiness** probe `GET /health/ready` (`connectors.ts:49-62`; `dispatcher.ts:947-962`), while `connector.test` calls the connector **provider test** `POST /connectors/:id/test` (`dispatcher.ts:1160-1180`; `server.ts:349-352`). No privilege mixing — both are admin/tenant-gated on their planes — but "test credential" reporting readiness can mislead operators. PLAT-MIG-03 documents "provider test differs from readiness"; the action naming is worth clarifying. |
| F-03 | INFORMATIONAL | Dual admin auth on one resource family: `GET/POST /api/v1/admin/connectors/:id/credentials` uses platform `assertAdminAuth` only (`admin.ts:242-277`), while every other connector management surface also accepts cookie-admin + CSRF via the dispatcher (`dispatcher.ts:144-146`). Stricter, not weaker; listed for consistency. |
| F-04 | INFORMATIONAL | `x-service-scope` is read and passed to the identity verifier (`server.ts:135`) but never consulted (`identity.ts:12-14`). Inert legacy parameter; no security impact. |
| F-05 | INFORMATIONAL | `du-rework/migration-candidates/orchestrator/...` holds older mirrored copies of these routes (same selector at `migration-candidates/orchestrator/services/connector/src/http/server.ts:138`). The directory is outside `pnpm-workspace.yaml` (`packages/*, services/*, businesses/*, tests/*, apps/*`), so it is not built or routed; ensure tooling never targets it. |
| F-06 | INHERITED (out of scope) | VERIFY-905 F1 (docs/08 error-taxonomy drift) and F2 (`/credentials` absent from docs/21) remain open in the documentation lane. Not re-adjudicated here; recorded for traceability only. |

## 7. Limitations / not performed

- Static review only: no test execution, no live/durable PostgreSQL, Redis, Vault, browser, or provider calls in this audit.
- Worker-side invoke-token **issuance** (`CONNECTOR_SERVICE_TOKEN` env) is deployment-provided; the repo contains no production issuer for it. Validation behavior was audited; issuance was spot-checked as config plumbing.
- Route inventory covers the connector family only; unrelated API families are out of scope.
- The `migration-candidates` mirror was not audited line-by-line (excluded from the workspace).
- No acceptance tick, no source change, no commit, no push.

## 8. Evidence index

Commands used (read-only): code/file reads; `Get-FileHash -Algorithm SHA256 <files>`; `git status --short`, `git log --oneline` (read-only). Repo state on audit date: HEAD `b088eec`; pre-existing untracked files throughout `du-rework/`; this audit added only this receipt.

### 8.1 Audited file hashes (SHA-256)

| File | SHA-256 |
|---|---|
| `services/connector/src/http/server.ts` | `5695E3928F6816196B2E035CE45926EAA4EC3EE0EA9B154796358CB68A317425` |
| `services/connector/src/identity.ts` | `7A24DEE99A225EB34B9F66CB72E8F30982ABCFA2A8A683CE3E96073E17D74A01` |
| `services/connector/src/contract-grants.ts` | `5771B232CDBBB3120FD37988E017C3EBEC4722C3F89A661ACE5B26759BBF65D9` |
| `services/connector/src/grants.ts` | `117CA0F19A33D1D2D88A27E99CF520968C5B64583A1C10590A22943D01BDB285` |
| `services/connector/src/services.ts` | `B73FF4764D01FA4824857EA5B6B83CB666F2000C387416743B28DB2380EE943B` |
| `services/orchestrator/src/http/routes/public.ts` | `EF1F74714AA2F4B972AD6DB0BB4AAB62F6E0401FE9CFF2C943043989A7EEA97F` |
| `services/orchestrator/src/http/routes/admin.ts` | `BF77179F29CB35925E4EC263EA503605A132A25C73CEDA66B88AB0E5617783AC` |
| `services/orchestrator/src/http/ingress-guard.ts` | `814F46633FC0C3B7C0A435DA487BA24199ED9B0AB97CE78C06A715459394F446` |
| `services/orchestrator/src/modules/connectors/management-service-identity.ts` | `DD8A85183F94CF64EE8E50D8D4B967856DA5919CFEFB111BC4802A902BF83F88` |
| `services/orchestrator/src/modules/connectors/connector-management-store.ts` | `233F45BEFA505DEA65BC2164DE17C678DBDCD6E2FBEBCCC52F55FA00AA3D1DB1` |
| `services/orchestrator/src/modules/connectors/connectors.ts` | `7B74B41B55063DB52428B3B924CDB88C16BB701067644AA9104AE508D8F396AC` |
| `services/orchestrator/src/modules/connectors/probe-authorization.ts` | `CDE6C9F1AB43CEA5EFDF266BDDC719BC8C06A61E3D7270DB2604B9FBAE7FC332` |
| `services/orchestrator/src/modules/admin-actions/rbac.ts` | `55FE5EE47A97955BC99733BF9433B376D9727EE860B13A0D53E4C3129ECDA045` |
| `services/orchestrator/src/modules/admin-actions/dispatcher.ts` | `9808D0DBCE80607C6511071CA37B5C2BCBD7F098096FE37E6CDD8331CF336B65` |
| `packages/connector-client/src/transport.ts` | `932E8DE7B2B71A79D61635B8F1B9953E3FA1F1C8FC045F4868D5DD9D02E71AED` |
| `packages/contracts/src/connector.ts` | `859979838C36763104497CFDC0FB402826DAAA096C1E27EE6899482FC11359D2` |

### 8.2 Cross-referenced artifacts (not modified)

- `coordination/reports/plat-mig-03-connector-contract-2026-10-05.md` (PLAT-MIG-03 owner receipt)
- `coordination/reports/verify-plat-mig-03-905-2026-10-05.md` (independent verification; F1/F2)
- `services/connector/tests/plat-mig-03-root-contract.test.ts`, `tests/service-auth.test.ts`, `tests/invocation-access.test.ts`
- `services/orchestrator/tests/pm-m02-ingress-fence.test.ts`, `pm-m02-ingress-verification.test.ts`, `plat-mig-02-probe-authorization.test.ts`
- `packages/connector-client/tests/real-service.test.ts`, `tests/integration/p4-08-sdk-consumer.integration.test.ts`

## 9. Kết luận (Vietnamese)

- Đã rà soát tĩnh toàn bộ chuỗi route connector từ ingress → orchestrator (public invoke `/api/v1/connectors/:id/test`, admin management `/api/v1/admin/connectors...` + `/api/v1/admin/actions`) → connector service (root `/connectors`, `/invocations`).
- **Phân tách quyền đúng PLAT-MIG-03:** service identity yêu cầu chữ ký HS256, `exp` bắt buộc còn hạn, `aud = connector`, và scope theo đúng họ route (`connector:manage` cho `/connectors*`, `connector:invoke` cho `/invocations` + `/capabilities`); health là ngoại lệ có chủ đích và không có side effect. Không route nào chấp nhận cả hai scope; không route invoke nào nằm dưới `/api/v1/admin` hay ngược lại; token worker bị chặn khỏi cả hai mặt.
- Grant gọi connector (`x-invocation-grant`/body `grant`) là lớp token thứ hai, bind tenant/operation/task/step/invocationId/inputHash + hạn dùng + revision ACTIVE.
- **Không phát hiện lỗi HIGH/MEDIUM.** 5 quan sát LOW/informational: selector scope dạng prefix (F-01), hai ngữ nghĩa "test" (F-02), hai cơ chế admin auth cho `/credentials` (F-03), header `x-service-scope` không dùng (F-04), bản sao `migration-candidates` ngoài workspace (F-05/F-06 kế thừa từ VERIFY-905).
- Các hash của `server.ts`, `identity.ts`, `admin.ts` trùng khít artifact PLAT-MIG-03 đã verify ngày 2026-10-05, nên bằng chứng test cũ áp dụng cho đúng bản code này; audit không chạy lại test.
- Tuân thủ ràng buộc: chỉ đọc code, không sửa source/spec, không commit; ngoại lệ duy nhất là receipt này.
