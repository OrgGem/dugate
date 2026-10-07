# MM-11 producer vs schema tenantId decision (contracts + docs)

Decision: tenantId is owned by the SCHEMA (platform authority), never by the
producer. Producers (worker, connector, client) MUST NOT assert tenantId;
the platform resolves it from authenticated identity and stamps it on rows.

Evidence:
- Usage projection scopes by JOINED operation tenant: `WHERE o.tenant_id = $1`
  (orchestrator/services/orchestrator/src/modules/usage/usage.ts:134). The UsageEvent
  contract carries NO tenantId field (contracts runtime.ts UsageEventSchema:
  eventId/invocationId/operationId/taskId/units/cost/measurement/occurredAt
  only); provider/model attribution reads payload.provider/payload.model with
  an (unattributed) bucket, never a producer tenant claim.
- OperationView carries tenantId as a platform-stamped field (contracts
  operations.ts:125); submission resolves tenant from x-api-key identity
  (server.ts resolveApiKey) and cross-tenant reads fail closed 404.
- Isolation harness mints per-run tenant UUIDs as test authority, not
  producer claims (tests/isolation/namespace.ts:24,70; artifact-jail.ts:13).

Consequence: any future producer-supplied tenantId MUST be rejected or
ignored; schema tenant wins. Real responses validated: usage/project +
getUsageSummary shape checked via contracts UsageSchema; spec examples
validated by tools/openapi/validate_openapi.py (23/23 PASS incl.
OperationDetail + HumanWait). Portable command (fresh checkout, zero DB):
`python du-rework/tools/openapi/gen_openapi.py && python
du-rework/tools/openapi/validate_openapi.py` (exit 0). NO DB USED.
