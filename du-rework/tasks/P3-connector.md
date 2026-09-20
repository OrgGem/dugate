# P3 — Connector service và typed client

Owner: connector agent. Depends: G1. Write: `services/connector/`, `packages/connector-client/`. Read: docs 04, 07–09, 12–13. Runtime/grant/usage stubs từ P1; không sửa platform DB.

| ID | Task/deliverable | Dependencies | Acceptance |
|---|---|---|---|
| P3-01 | [ ] Adapter/service/repository interfaces và connector migrations | G1 | Config/secret/invocation/usage owned schema |
| P3-02 | [ ] Management APIs, revisions, secret write-only/rotation | P3-01 | Redacted read/test response, RBAC service scopes |
| P3-03 | [ ] Grant validation, input hash, ledger claim/replay/reconcile | P3-01 | CON-01/03/04 incl concurrent and ambiguous calls |
| P3-04 | [ ] Generic multipart/json adapters + controllable mock provider | P3-02/03 | Mapping validated, normalized outputs/errors, no native parser |
| P3-05 | [ ] Global quota/deadline/cancel/async poll | P3-04 | CON-02/05 aggregate cap and bounded retry |
| P3-06 | [ ] Usage ledger/outbox delivery + artifact/session refs | P3-04 | USE-01/02; late usage accepted, no secret queue payload |
| P3-07 | [ ] connector-client typed API/error/pending/replay behavior | P3-03..06 | Consumer tests against service, grant refresh keeps invocation ID |
| P3-08 | [ ] Security/fault/integration suite và standalone image | P3-07; real P2 runtime | G3 connector part, health/drain/logging |

## Function inventory

validateGrant, resolveConnectorRevision, claimInvocation, invokeAdapter, normalizeProviderResult, classifyProviderError, acquireQuotaLease, reconcileInvocation, appendUsageEvent, deliverUsageBatch, rotateCredential. Mỗi function có timeout/error/idempotency contract trước implementation.

## Test-first requirements

Provider call counter để assert duplicates; UNKNOWN state sau network cut; same ID different hash; quota giữa hai replicas; arbitrary endpoint/header override reject; secret masking; revoke giữa attempts; oversized responses; malformed JSON; artifact scoped access. Adapter tests không gọi real provider.

## Done evidence

Management và invocation OpenAPI conformance, at least two replica quota test, kill-after-provider-dispatch report, credential rotation audit, integration usage projection với P2. Provider protocol chưa hỗ trợ được ghi rõ, không claim universal provider support.
