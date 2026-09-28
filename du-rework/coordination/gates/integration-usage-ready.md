# Gate: integration-usage-ready — READY (scoped)

- Date: 2026-09-21
- Scope: real Orchestrator operation/task plus Connector `HttpUsageSink`
- Infrastructure: PostgreSQL 16 on `localhost:5433`; Redis 7 on `localhost:6380`
- Full-system/document-core status: **BLOCKED by missing runtime boundaries**

## Executable command and result

```bash
cd du-rework
docker compose -f infra/docker-compose.yml up -d
pnpm test:integration
```

Actual result on 2026-09-21:

```text
PASS tests/integration/usage-projection.integration.test.ts
Test Suites: 1 passed, 1 total
Tests:       1 passed, 1 total
```

The command first builds `@du/contracts`, `@du/observability`, `@du/connector`,
and `@du/orchestrator`, then runs the integration suite against the real
PostgreSQL/Redis services.

## Assertions proved

1. Runtime manifest registration returns 200/201, after which the exported
   test-only enable hook makes the synthetic version available.
2. Public HTTP submission returns a contract-valid 202 `SubmitAck`; the
   documented BullMQ queue contains a contract-valid `BusinessJobV1` with a
   real operation ID, task ID, and delivery ID.
3. Runtime HTTP claim and completion succeed with a contract-valid lease and
   terminal `SUCCEEDED` acknowledgement.
4. Connector `HttpUsageSink` sends one measured event twice. Public result
   projection is exactly 41 input tokens, 17 output tokens, and 725 micro-USD,
   proving the replay did not double-count.
5. Orchestrator is closed and recreated against the same PostgreSQL database;
   the same event is sent a third time through a new `HttpUsageSink`, and the
   result reference and exact usage totals remain unchanged.

## Boundary and gate decision

This gate is READY only for the cross-service usage path above. It is not a
full-system E2E gate: service startup uses the public package entrypoints, test
bootstrap uses `enableVersionForTest` because no admin/RBAC enable endpoint is
available, and task discovery consumes the documented BullMQ job contract.
The exercised business/runtime calls themselves cross HTTP boundaries and all
wire payloads are parsed with `@du/contracts`.

Document-core was not added because its handlers always persist result
artifacts through `TaskContext.artifacts`, while Orchestrator does not route
`POST /tasks/{taskId}/artifacts`, `POST /artifacts/{artifactId}/finalize`, or
`POST /artifacts/{artifactId}/access`. Connector-using variants additionally
require `POST /tasks/{taskId}/invocation-grants`, which is also absent. Adding
mocks would hide those missing production boundaries, so the next task must
implement artifact storage/grants, invocation-grant issuance/profile binding,
and a real admin enable path before claiming document-core or full-system E2E.
