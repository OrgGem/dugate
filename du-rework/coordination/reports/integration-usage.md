# Integration usage report

## Outcome

The smallest real Orchestrator-to-Connector usage path is executable and
passes against the isolated PostgreSQL/Redis stack. The harness is
`tests/integration/usage-projection.integration.test.ts`; the repository-level
entrypoint is `pnpm test:integration`.

## What ran

- Started Orchestrator on an ephemeral HTTP port with dedicated runtime and
  usage bearer tokens.
- Registered and enabled a unique synthetic business, submitted a public
  operation, observed its real queue delivery, claimed its root task, and
  completed it through runtime HTTP.
- Delivered one measured usage event through Connector `HttpUsageSink` twice,
  verified the public projection, restarted Orchestrator, replayed the event a
  third time, and verified the durable projection again.
- Strict TypeScript check for `@du/integration-tests`: exit 0.
- Integration command: 1 suite passed, 1 test passed, 0 failures.

## Exact observed projection

```json
{
  "inputTokens": 41,
  "outputTokens": 17,
  "costMicrousd": 725,
  "measurement": "measured"
}
```

The value is identical after duplicate delivery and after process restart plus
another duplicate delivery. This demonstrates durable event deduplication and
projection without reading Orchestrator database internals.

## Remaining blockers

Document-core cannot be honestly included without mocks. Its SDK facade needs
artifact create/finalize/access routes for all successful handlers, and its
provider-backed variants also need runtime invocation-grant issuance and
profile/binding resolution. Orchestrator currently exposes none of those HTTP
routes; a production admin/RBAC enable route is also absent, so this harness
uses the explicitly exported test enable hook only for bootstrap.

Gate status: `integration-usage-ready` is **READY (scoped)**; document-core and
full-system E2E remain **BLOCKED**, with no service source changed in this lane.
