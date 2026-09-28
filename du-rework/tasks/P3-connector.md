# P3 — Connector service và typed client

Owner: connector agent. Depends: G1. Write: `services/connector/`, `packages/connector-client/`. Read: docs 04, 07–09, 12–13. Runtime/grant/usage stubs từ P1; không sửa platform DB.

| ID | Task/deliverable | Dependencies | Acceptance |
|---|---|---|---|
| P3-01 | [x] Adapter/service/repository interfaces và connector migrations | G1 | Config/secret/invocation/usage owned schema |
| P3-02 | [x] Management APIs, revisions, secret write-only/rotation | P3-01 | Redacted read/test response, RBAC service scopes |
| P3-03 | [x] Grant validation, input hash, ledger claim/replay/reconcile | P3-01 | CON-01/03/04 incl concurrent and ambiguous calls |
| P3-04 | [x] Generic multipart/json adapters + controllable mock provider | P3-02/03 | Mapping validated, normalized outputs/errors, no native parser |
| P3-05 | [x] Global quota/deadline/cancel/async poll | P3-04 | CON-02/05 aggregate cap and bounded retry |
| P3-06 | [x] Usage ledger/outbox delivery + artifact/session refs | P3-04 | USE-01/02; late usage accepted, no secret queue payload |
| P3-07 | [x] connector-client typed API/error/pending/replay behavior | P3-03..06 | Consumer tests against service, grant refresh keeps invocation ID |
| P3-08 | [x] Security/fault/integration suite và standalone image | P3-07; real P2 runtime | G3 connector part, health/drain/logging |

Status audit 2026-09-21 (wave-05 Copilot-lane takeover): P3-05 is proven by the durable suite
(`durable-integration`, `black-box-durable`, async/cancel paths in `reliability-security`) plus the
new real-service client test that cancels a genuinely PENDING invocation and rejects cancel of a
terminal one. P3-06 is proven by `tests/integration/connector-usage.integration.test.ts`
(Connector composition + `HttpUsageSink` → live Orchestrator, triple dispatch projects exactly
once). P3-07 is proven by `packages/connector-client/tests/real-service.test.ts`
(`CONNECTOR_INTEGRATION=1`): invoke/poll/wait complete and cancel behaves end-to-end over real
HTTP against the live composition. P3-08 is proven by `du-connector:wave05`
(digest `sha256:996db5ead0ee985c6ddee4f8200c151168717517a0eb75057437fac5090d4580`),
which starts against isolated PG :5433 / Redis :6380 with `/health/live` + `/health/ready` → 200.
P2-08 webhook adoption: `services/connector/src/webhook.ts` verifies HMAC-SHA256 over
`{timestamp}.{body}` with the frozen `@du/contracts` surface (`tests/webhook.test.ts`, 6 pass);
no Connector-side delivery endpoint yet, per scope.

## Function inventory

validateGrant, resolveConnectorRevision, claimInvocation, invokeAdapter, normalizeProviderResult, classifyProviderError, acquireQuotaLease, reconcileInvocation, appendUsageEvent, deliverUsageBatch, rotateCredential. Mỗi function có timeout/error/idempotency contract trước implementation.

## Test-first requirements

Provider call counter để assert duplicates; UNKNOWN state sau network cut; same ID different hash; quota giữa hai replicas; arbitrary endpoint/header override reject; secret masking; revoke giữa attempts; oversized responses; malformed JSON; artifact scoped access. Adapter tests không gọi real provider.

## Done evidence

Management và invocation OpenAPI conformance, at least two replica quota test, kill-after-provider-dispatch report, credential rotation audit, integration usage projection với P2. Provider protocol chưa hỗ trợ được ghi rõ, không claim universal provider support.
