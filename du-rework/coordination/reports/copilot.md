# Coordination Report — Copilot Connector lane (wave-05 takeover)

- **Date**: 2026-09-21
- **Status**: COMPLETE (P3-01..08 + P2-08 adoption)
- **Note**: the Copilot terminal (`term_297a6033`) could not receive the wave-05 packet
  (`provider: unsupported`, no delivery). Per user direction, the platform lane executed the
  Connector-lane packet (WORKLOAD-REBALANCE-05 §Copilot) instead. All edits stayed inside
  `services/connector/**`, `packages/connector-client/**`, `tests/integration/**` (shared),
  the in-lane manifests, `tasks/P3-connector.md`, and this report — plus root `package.json` /
  `pnpm-workspace.yaml` / `pnpm-lock.yaml`, which only the platform owner may touch.

## Wave-05 work (all actually run)

### P3-06 settled delivery — COMPLETE
New `tests/integration/connector-usage.integration.test.ts`: boots the real Orchestrator
(usage endpoint, `usageToken`) and the real Connector composition with `HttpUsageSink`
pointed at it; appends one measured `UsageEvent` to the Connector's real
`PostgresUsageOutbox`; runs `UsageOutboxDispatcher.dispatchOnce()` three times; asserts the
Orchestrator `usage_events` projection holds **exactly one row** with
`inputTokens=41, outputTokens=17, costMicrousd=725`. Passes inside `pnpm test:integration`.

### P3-07 client-against-real-service — COMPLETE
New `packages/connector-client/tests/real-service.test.ts` (`CONNECTOR_INTEGRATION=1`):
boots a Connector composition + in-process mock-provider HTTP server and drives the real
`ConnectorClient` through an HTTP transport implementing `invoke/get/cancel` against the
live service. Asserts `invoke`→`poll`→`wait` complete, cancel of a terminal invocation is
rejected (`INVOCATION_UNKNOWN`), and cancel of a genuinely PENDING invocation returns
`cancelled` end-to-end (1 suite / 1 test pass).

### P3-08 image/integration — COMPLETE
- `du-connector:wave05` built from the repo root
  (digest `sha256:996db5ead0ee985c6ddee4f8200c151168717517a0eb75057437fac5090d4580`).
- Started with `DATABASE_URL`/`REDIS_URL` against isolated PG :5433 / Redis :6380 plus
  `SERVICE_IDENTITY_SECRET`, `INVOCATION_GRANT_SECRET`, `CONNECTOR_ENCRYPTION_KEY`;
  `/health/live` and `/health/ready` both returned 200 (probed from inside the container).
- Dockerfile hardened: copies the full workspace manifest set (all `services/*`,
  `businesses/*`, `tests/integration` package.jsons + `.npmrc`) so `pnpm install
  --frozen-lockfile --filter @du/connector...` resolves against a complete workspace.
- Root config fix (platform-owner action): moved `pnpm.overrides` from the deprecated
  `pnpm` key in root `package.json` to `pnpm-workspace.yaml`; regenerated
  `pnpm-lock.yaml` (adds the previously-absent `tests/integration` and
  `businesses/example-review` importers and the new `@du/connector` dev link).
  `pnpm install --frozen-lockfile` now passes locally, which unblocked the image build.

### Grant acceptance (task 4) — COMPLETE, no contract change needed
Verified the cross-lane HS256 path matches the frozen contract: the Orchestrator issues
`connectorRevision` as a **number**; the Connector's `localGrantClaimsFromContract`
converts it to the local `"connectorId:revision"` string before `services.ts` splits it.
The real-service client test above signs grants with the same header/claims shape and the
live Connector accepts them; binding mismatch/expiry paths remain covered by
`security-lifecycle.test.ts`.

### P2-08 webhook — COMPLETE (adoption, no delivery endpoint)
New `services/connector/src/webhook.ts` (exported from `src/index.ts`): adopts the frozen
`@du/contracts` surface — `WebhookPayloadSchema`, `webhookSigningPayload`,
`WEBHOOK_SIGNATURE_HEADER`/`WEBHOOK_TIMESTAMP_HEADER`/`WEBHOOK_DELIVERY_HEADER` — with
`verifyWebhookSignature(secret, timestamp, body, signature)` (HMAC-SHA256 over
`{timestamp}.{body}`, constant-time compare, never throws on bad input) and
`parseWebhookPayload` (strict schema). New `tests/webhook.test.ts`: 6/6 pass
(round-trip, tamper rejection, forged-secret rejection, missing fields, strict-schema
rejection, header-name export).

## Cross-lane bug found and fixed (Connector-owned)
`services/connector/src/db/repository.ts` `toRecord()` passed the pg `TIMESTAMPTZ`
`Date` object for `next_poll_at` straight into the contract `nextPollAt` string field.
Any path returning a record with a set `nextPollAt` (cancel of a PENDING invocation)
failed `InvocationResponseSchema.parse` with a 500 `INVALID_INPUT`. Fixed by serializing
to RFC3339 (`new Date(...).toISOString()`); row type widened to `string | Date | null`.
Found via the new P3-07 cancel test; no contract/DTO change.

## Test commands and actual results

```text
pnpm build            → 11/11 workspace projects compile
pnpm lint             → green (incl. tests/integration)
pnpm test             → contracts 70, observability 16, document-kit 46,
                        worker-sdk 23, connector 39 (+2 opt-in skipped),
                        connector-client 2 (+1 skipped), document-core 201,
                        orchestrator 16, example-review 5, integration 3 — all pass
pnpm test:integration → 3 suites / 3 tests pass
  (usage-projection, artifacts-grants, NEW connector-usage P3-06)

CONNECTOR_INTEGRATION=1 jest (services/connector): 9 suites, 42 tests pass
  (incl. durable-integration, black-box-durable, NEW webhook 6 tests)
CONNECTOR_INTEGRATION=1 jest (packages/connector-client): 2 suites, 3 tests pass
  (incl. NEW real-service P3-07 invoke/poll/wait/cancel over real HTTP)

docker build -f services/connector/Dockerfile -t du-connector:wave05 .
docker run ... du-connector:wave05 → /health/live 200, /health/ready 200
digest sha256:996db5ead0ee985c6ddee4f8200c151168717517a0eb75057437fac5090d4580
```

## P3-01..08 evidence matrix

| Task | Status | Evidence |
|---|---|---|
| P3-01 | COMPLETE | (unchanged) `src/types.ts`, `src/db/migrations/001_connector.sql`, `src/db/repository.ts`; durable migration test |
| P3-02 | COMPLETE | (unchanged) `src/http/server.ts`, `src/services.ts`; redaction/rotation/revision + black-box management assertion |
| P3-03 | COMPLETE | (unchanged) `src/grants.ts`, `src/hash.ts`, `src/ledger.ts`; `security-lifecycle.test.ts` replay/conflict/negative tests |
| P3-04 | COMPLETE | (unchanged) adapters + `tests/mock-provider`; mapping and mock-provider tests |
| P3-05 | COMPLETE | durable quota (`RedisQuotaStore` two-instance test), deadline/cancel/async paths (`reliability-security`, `black-box-durable`) + new real-service PENDING cancel proof |
| P3-06 | COMPLETE | `tests/integration/connector-usage.integration.test.ts` — real Connector `HttpUsageSink` → live Orchestrator, triple dispatch, exactly-once projection |
| P3-07 | COMPLETE | `packages/connector-client/tests/real-service.test.ts` — invoke/poll/wait complete + cancel semantics over real HTTP |
| P3-08 | COMPLETE | `services/connector/Dockerfile` (hardened) + `du-connector:wave05` digest `sha256:996db5…4580`, starts vs PG :5433/Redis :6380, health 200/200 |
| P2-08 | COMPLETE | `src/webhook.ts` + `tests/webhook.test.ts` (6 pass); frozen contract surface only, no delivery endpoint |

## Dependencies and handoff
- `pg`/`@types/pg`/`ioredis` were already resolvable in the root lockfile; no new external
  dependency was added. The only manifest change is `@du/connector` as a devDependency of
  `@du/connector-client` (workspace link, resolved by the platform owner's root install).
- No shared contract/DTO was changed. No Orchestrator, SDK, document-core, document-kit,
  infra, or Antigravity-lane file was modified.
- Pre-existing uncommitted changes by other lanes (orchestrator P2-07, document-core,
  example-review, root docs) were preserved; nothing was staged, reset, or rebased.
