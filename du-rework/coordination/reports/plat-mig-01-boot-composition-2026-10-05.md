# PLAT-MIG-01 — boot composition for connector URL + management identity

Task task_a2f09cb6213d. Phase A. Design reused, not rewritten:
coordination/reports/deployment-adapter-design-803-2026-10-05.md (Muc 1: the
three read sites and the missing adapter) + docs/12b-deployment-guide.md:121-124.

## Confirmed on disk BEFORE editing (item 1)

- src/main.ts:161 createApp({...}) passed NO connectorBaseUrls and NO
  connectorManagementHeaders; grep in main.ts returned only positiveInteger
  and optional helpers. Exactly as reported.
- src/server.ts:82-92 declares both fields; src/app/bootstrap/create-app.ts:408
  did `config.connectorBaseUrls ?? {}` -> empty map -> management store
  undefined -> management:false on EVERY deployment.
- No env/compose key existed for either field.

## Landed

1. src/main.ts — three exported env parsers + one exported boot rule:
   connectorBaseUrlsFromEnv (JSON map, non-empty, non-empty id + URL),
   connectorManagementHeadersFromEnv (JSON map, header-name charset, no CR/LF),
   connectorIdentityExpiresAtMs (ISO-8601 or epoch ms), and
   assertConnectorComposition(env) which main() now calls.
   main() passes both fields into createApp instead of the empty fallback.
2. Fail-closed (item 3): empty map refused; headers without base URLs refused;
   headers without an expiry refused; expired/unparseable expiry refused. No
   path degrades to an empty map.
3. src/app/bootstrap/create-app.ts — connectorBaseUrlResolver exported:
   known id -> its URL; unknown id -> 404 NOT_FOUND; no configured URL at all
   -> 503. Never a silent empty list (item 5).
4. .env.example — placeholder block for the three variables under Connector,
   with the "never write a real secret here" note. No secret value committed.
5. tests/plat-mig-01-boot.test.ts (new) — 12 tests, all offline.

## Verification (real numbers, item 10)

- npx tsc --noEmit -p tsconfig.json => clean, no errors.
- npx jest tests/plat-mig-01-boot.test.ts => 12 passed, 12 total, Exit Code 0.
- npx jest --silent (full) => Test Suites: 5 failed, 26 skipped, 193 passed,
  198 of 224; Tests: 10 failed, 230 skipped, 4787 passed, 5027 total.
  Before this packet: 4775 passed / same 5 red suites / same 10 red tests.
  => ZERO regression; +12 from the new suite.

## Test coverage vs the four required cases (item 9)

1. partial config fails: headers without base URLs; empty map; non-JSON; array;
   empty URL value; empty connector id; CR/LF header value; missing expiry.
2. valid standalone composition with REAL management: a real node:http mock
   Connector (loopback port below the ephemeral range, EADDRINUSE retry)
   returns a real revision; the composed store lists it (connectorId, adapter,
   credentialRef) and the signed identity header provably reached the
   connector. Not a placeholder projection.
3. unknown ID rejected: resolver throws HttpError NOT_FOUND and the store
   rejects the lookup; with no base URLs the resolver throws 503.
4. identity expiry: expired refuses boot, missing refuses boot, unparseable
   refuses boot, epoch ms accepted, future ISO composes.

## Identity lifetime, refresh, ownership, user gating (item 6)

- Lifetime: bounded by DU_CONNECTOR_IDENTITY_EXPIRES_AT; boot refuses when it
  is absent or already past. An identity can no longer outlive its own
  declared expiry unnoticed.
- Refresh: there is NO hot-reload channel (DESIGN-803 keeps the boot snapshot),
  so refresh = redeploy with a fresh identity + new expiry. Documented in the
  main.ts doc comment and in .env.example.
- Owner: the platform admin who provisions the connector service identity.
- User-gated: the PROVISIONING/REFRESH action is the user-gated part. The read
  side of the management surface is not additionally gated beyond the existing
  admin session + tenant fence. Nothing here is a secret-handling change.

## Honest gaps

- The full createApp STANDALONE BOOT assertion (management capabilities flag on
  a booted app) needs a database window; this lane opens none. Covered instead
  by exercising the REAL management store against the mock Connector plus the
  resolver contract that create-app consumes. RESUME: with a disposable PG,
  boot createApp with connectorBaseUrls set and assert
  ctx.connectorManagement is defined and GET /api/v1/admin/connectors returns
  the mock list.
- admin.ts:574 still reads ctx.config.connectorBaseUrls (the boot snapshot).
  That is DESIGN-803 rollout step 4 and belongs to Packet 2 (the DB source),
  which this packet did not touch.
- Not done by design: no Runtime service split, no Connector folded into the
  API process, no Portal rename, no invocation moved to the API.

No commit, no tick, no A2 flip. No secret logged or written to the template.
