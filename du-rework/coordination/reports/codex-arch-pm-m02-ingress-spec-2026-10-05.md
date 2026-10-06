# PM-M02 — Orchestrator / Connector ingress fence

Date: 2026-10-05. Author: codex_arch. Status: **SPECIFIED**; implementation, independent verification and acceptance remain open.

Authority: user's latest instruction appoints Antigravity as fleet coordinator. This report resolves the architectural decision requested after `ingress-audit-907-2026-10-05.md`. Antigravity owns task creation, dispatch and lease binding; this report does not dispatch a second writer or change existing task states.

## Decision

Use **two HTTP listeners in the same Orchestrator process**, with an early guard bound to the accepting listener. Retain the existing separate Admin Portal/BFF listener. Do not split Runtime into a new service or instantiate the application twice.

| Listener | Container port | Allowed surface | Default host publication |
|---|---:|---|---|
| Orchestrator public JSON | 3000 | Existing public `/api/v1/*` routes, excluding `/api/v1/admin` and its descendants; existing health routes | Loopback, existing configurable public binding |
| Orchestrator internal JSON | 3002 | Existing public, admin and runtime handlers, each with its existing authentication/authorization | None |
| Admin Portal/BFF | 3001 | Existing shell, session/OIDC and explicit BFF operations | Loopback, existing configurable Portal binding |
| Connector | 8080 | Existing root-path invocation/capability/management contract and service health | None |

Internal JSON deliberately retains public handlers: the BFF calls `/api/v1/operations`, `/api/v1/operations/:id` and `/api/v1/usage` as well as admin JSON (`services/orchestrator/src/app/admin/bff/operations.ts:153,165,188,198`). A runtime-only internal listener would break those flows. Availability on an internal listener never grants authority: API-key, admin, business-scoped worker, usage-sink and Connector identity checks remain mandatory as applicable.

A caller-supplied audience header on the current shared listener cannot establish ingress identity. Separate listeners make the identity authoritative inside the process and allow Compose to publish only the public socket. Use the listener guard as well: changing port publication without route fencing leaves runtime reachable through public port 3000. A new ingress proxy is unnecessary for this implementation.

## Evidence and current mismatch

The audit is a working-tree static review, not a live deployment result. Source locations below refer to the inspected snapshot and may shift during migration.

- `services/orchestrator/src/server.ts:268-327`: a single dispatcher tries runtime, public and admin routes; health includes DB/Redis/lease information.
- `services/orchestrator/src/app/bootstrap/create-app.ts:695-740`: shared request entry parses the URL and reads JSON/binary bodies, including runtime blob PUT and public streaming uploads. `:838-840` creates one server; `:875-876` listens on the configured public port.
- `services/orchestrator/src/http/route-context.ts:40-98`: context currently has no listener-derived ingress audience. `services/orchestrator/src/main.ts:312` configures one JSON port.
- Bootstrap remounts the Admin shell against that JSON socket after listen; this must instead use the actual bound **internal** address. Existing shell lifecycle is in bootstrap, not a reason to expose admin JSON publicly.
- `compose/orchestrator.yml:70-71` publishes 3000 and 3001; `compose/connector.yml:22-23` publishes 8080 on loopback by default. Overriding `BIND_ADDRESS` can widen those mappings today.
- `compose/document-core.yml:9`, `compose/lc-checker.yml:9`, `compose/example-review.yml:9`: Runtime defaults still target `http://orchestrator:3000/api/runtime/v1`.

PM-M03 tenant probe authorization and PM-M01 signed management identity are separate controls. Their presence does not close this ingress mismatch.

## Source contract for the route owner

1. Preserve `ServerConfig.port` as the public port. Add `host?: string`, `internalPort?: number`, `internalHost?: string`. Defaults: public host `0.0.0.0` (preserves the current unqualified public bind), internal port 3002 and internal host `127.0.0.1` for native execution. Compose explicitly sets internal host `0.0.0.0`. Native CLI ports must be positive; programmatic tests may pass 0 independently for ephemeral listeners.
2. CLI keeps `ORCHESTRATOR_PORT`, falling back to `PORT`, for public JSON. Introduce `ORCHESTRATOR_HOST`, `ORCHESTRATOR_INTERNAL_PORT`, `ORCHESTRATOR_INTERNAL_HOST`, using the defaults above. Do not confuse container internal port with a host debug mapping.
3. Construct both servers over the **same assembled app**: one DB/Redis set, queue/runtime instances, dispatcher, recovery timers and webhook loop. Start background processing once. Retain `app.server` and `app.listen()`'s existing public-server return shape; expose `app.internalServer` for fixtures and lifecycle verification.
4. Pass a literal trusted audience (`public` or `internal`) from each server closure into request handling. If propagated into RouteContext, keep it required and server-owned; no header/query/body override and no default to internal. Never derive it from `Host`, `Forwarded`, `X-Forwarded-*`, `X-Ingress-Audience`, remote address alone or bearer type.
5. Apply the guard immediately after controlled URL parsing, **before body consumption, stream/upload/blob setup, context/dependency work or route dispatch**. Use the same normalized pathname for guard and routing. Malformed targets retain controlled 400 behavior; disallowed families return the standard generic 404 problem response for every method, even with a valid admin/runtime credential. Manage unread request bodies safely without buffering them or leaving sockets stalled.
6. Public allows existing health and `/api/v1` public family only. Deny `/api/v1/admin` (exact and descendants), `/api/runtime` (exact and descendants), `/api/internal` (exact and descendants), and unknown/non-public families. Perform admin exclusion before the broader public-prefix check. An absent internal route must remain absent: do not invent `/api/internal` endpoints. Internal uses the existing dispatcher and existing 404 behavior.
7. Bind both JSON listeners before starting loops or completing shell remount. Reject conflicting fixed listener configurations early; if any bind/shell startup fails, close sockets already opened and clean up acquired resources without masking the initiating error. Graceful `app.close()` closes both JSON servers, the shell and existing resources once, including never-listened/partially-listened cases.
8. Default BFF `jsonBaseUrl` must be generated from the **actual bound internal address**, including port-0 fixtures. Use loopback as the local client destination when the listener binds a wildcard address. Explicit existing programmatic overrides remain supported for separate deployments, but production instructions must target an internal origin; never derive this upstream from browser-controlled input.
9. Existing public upload/artifact grants must continue referencing public URLs. Worker-facing runtime grant URLs must resolve to the internal origin when worker-consumed. Inventory configured base URLs and Host-derived grant behavior: do not accidentally replace all URLs with 3002 or trust forwarding headers to select audience.
10. Preserve Admin shell session/OIDC/CSRF and its finite BFF route allowlist. It must not become a generic proxy to arbitrary internal URLs/runtime routes. Keep current health wire behavior in this packet; changes to health disclosure need a separate contract decision.

No compatibility switch may restore admin/runtime on the public listener by default or in tests. Runtime/admin HTTP fixtures must explicitly use the internal server. In-process handler tests do not alone prove listener fencing.

## Deployment contract for the Compose owner

- Set `ORCHESTRATOR_INTERNAL_HOST: 0.0.0.0`, `ORCHESTRATOR_INTERNAL_PORT: '3002'` and public host/port explicitly in `compose/orchestrator.yml`. Keep public 3000 and Portal 3001 mappings with existing loopback default. **Do not publish internal 3002** in the default stack.
- Remove `ports` from `compose/connector.yml`. Connector continues listening on container 8080 and existing healthchecks continue using local container loopback. Docker `EXPOSE` is metadata, not publication or a security fence.
- Update **all three** worker fragment Runtime defaults to `http://orchestrator:3002/api/runtime/v1`. Connector base URL stays `http://connector:8080`. Explicit operator `RUNTIME_URL` overrides must also be migrated; do not silently fall back to public runtime on 3000.
- Connector usage sink, when enabled, must target `http://orchestrator:3002/api/runtime/v1/usage-events` with the existing dedicated usage identity. Preserve disabled behavior when URL/token are unset. Document this in env examples; changing an empty default to enabled is outside scope.
- Provide optional `compose/local-debug.yml`, excluded from root default includes, if host debugging is needed. Bind debug 3002 and 8080 to literal `127.0.0.1` only, with distinct `ORCHESTRATOR_INTERNAL_DEBUG_PORT` / `CONNECTOR_DEBUG_PORT` variables. Never reuse `BIND_ADDRESS` for these mappings. Verify actual Compose merge semantics and document the exact tested opt-in command; a profile alone must not publish ports on the normally enabled Connector service.
- Keep existing service networks initially. Do not mark shared networks `internal: true` without proving provider/object-store/OIDC/worker outbound connectivity. Workers and Connector require outbound access. Public reverse proxies must forward only to 3000 and the intended Portal 3001 routes, never 3002/8080.
- Document the limit precisely: this is **external/public ingress fencing**, not east-west network isolation. Peers on shared Compose networks can reach container listeners and must still pass auth; a compromised host can also access container networks. Future per-service network segmentation is a separate packet, not a claim satisfied by removing host mappings.

## Disjoint leases and integration boundary

Antigravity may bind these packets to qwen_1 / cw1 after their current leases are released. These are proposed packet names, not dispatched task IDs.

| Packet | Exclusive write lease | Required receipt |
|---|---|---|
| `PM-M02-ROUTE` (suggest qwen_1) | `services/orchestrator/src/server.ts`, `src/main.ts`, `src/http/route-context.ts`, `src/app/bootstrap/create-app.ts`, ingress helper under `src/http/`, directly affected Orchestrator tests | Listener/auth/lifecycle tests, typecheck/build, commands and raw output |
| `PM-M02-COMPOSE` (suggest cw1; central deployment/security owner) | Root `docker-compose.yml`, `compose/orchestrator.yml`, `compose/connector.yml`, all three worker fragments, optional debug override, `.env.docker.example`; Dockerfile EXPOSE metadata only if needed | Effective base/debug config, URL inventory and deployment smoke packet |
| `VFY-PM-M02` (independent tester) | Isolated verification harness and its own receipt; product source read-only | Real listener HTTP matrix plus combined local deployment evidence |

Route owner does not edit Compose. Compose owner does not edit Orchestrator source. Neither owns root manifests/lockfiles or shared-lib migration files. No new dependency is required. `src/main.ts` / `server.ts` can overlap signed-identity work: **release/transfer the entire file lease before ingress edits**, or serialize a reviewed integration through the current owner; do not create concurrent writers on distinct presumed hunks. qwen_1's build fixes and cw1's management JWT work must finish/release their intersecting leases first.

Documentation files `docs/02`, `03`, `09`, `12b`, `40` retain MIG-00 ownership unless Antigravity explicitly transfers that lease. Send that owner the topology/env/URL delta; do not let both implementation lanes edit those docs. `docs/08`/generated `docs/21` retain their contract ownership; any required server-origin change goes to that owner, using the generator rather than hand-editing OpenAPI. This report itself is the codex_arch spec lease only.

Integration dependency: route and Compose may be edited in parallel over disjoint leases using the frozen configuration contract above. They are **released together for verification**: new Compose runtime URL fails against old code; new fenced code denies old worker URLs. No intermediate cutover, remote, push or deployment is authorized by this spec request.

## Acceptance packet (required before closing PM-M02)

| ID | Required check |
|---|---|
| IF-01 | Actual HTTP on public listener: valid public API continues working; admin/runtime/internal paths return generic 404 with absent, invalid and valid privileged credentials; GET/POST/PUT/DELETE/OPTIONS and exact/prefix variants tested. |
| IF-02 | Rejected public runtime blob PUT / forbidden body request invokes no body parser/storage, route handler, DB query, queue write or outbound call attributable to that request. Test a held-open body and bounded clean rejection; distinguish unrelated health/background activity. |
| IF-03 | Spoofed Host/Forwarded/audience headers cannot select internal dispatch. Encoded separators, dot segments, repeated/trailing slashes and malformed targets follow the same guard/router normalization, with no bypass. |
| IF-04 | Real internal listener allows valid business worker claim/get/cancel/artifact and usage identities per current contracts; invalid tokens, wrong business/tenant and missing admin identity retain existing denies. Admin bearer does not grant worker/business authority. |
| IF-05 | Portal/BFF operations, usage and admin flows target internal origin and still enforce session/CSRF/RBAC. Public readiness probe retains PM-M03 authorization ordering and zero outbound on unauthorized request. Signed management calls retain audience `connector` / scope `connector:manage` / expiry checks; ingress must not bypass them. |
| IF-06 | Two ephemeral JSON listeners are distinct; dispatcher/background loops run once; second-bind and shell-start failure clean up; graceful close stops both listeners and resources without leaked sockets. |
| IF-07 | Render effective default Compose with sanitized non-secret fixture env: only 3000/3001 host mappings, no 3002/8080 mappings even with `BIND_ADDRESS=0.0.0.0`; all workers and enabled usage sink target 3002. Opt-in debug merge binds only loopback and preserves public route fence. |
| IF-08 | Combined isolated local stack: worker reaches/authenticates internal Runtime, Orchestrator reaches signed Connector management, worker reaches Connector invocation, healthchecks pass and required outbound paths remain usable. From host/public mapping, runtime/admin cannot be reached via 3000; default effective config/socket inspection confirms no internal host publication. Actual external proxy/firewall behavior needs deployment-specific verification. |

Each receipt records snapshot/build digest, cwd, exact commands, environment/isolated namespaces, passed/failed/skipped counts, exit codes and raw-output paths. Independent tester verifies the combined snapshot, not just one lane's unit receipt. Required review/acceptance gates remain unchanged. Skipped/live-unrun cases stay open.

## Result of this task

Architectural choice, producer/consumer port contract, ownership and acceptance are specified. Static source/audit review only; no product/Compose implementation or live ingress test was performed for this decision. **PM-M02 remains open** until the two implementations and independent verification satisfy the packet above.
