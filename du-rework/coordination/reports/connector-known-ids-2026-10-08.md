# Connector known IDs for degraded lookup — implementation receipt

**Date:** 2026-10-08 (Asia/Bangkok)  
**Status:** Implemented; no commit or push.

## Behavior

- Connector capabilities now includes `knownConnectorIds`, built from `Object.keys(ctx.config.connectorBaseUrls ?? {})`. Only connector ID keys leave the backend; endpoint URLs, headers, credential references, and secrets remain private.
- The `.strict()` contract and the admin-web parser recognize and validate the ID list.
- When `management:false`, the revision lookup datalist now uses the advertised ID keys. When `management:true`, suggestions still come from the existing management list. The Revision lookup card remains visible in both modes.
- The degraded screen shows a short setup banner naming `DU_CONNECTOR_BASE_URLS` and `SERVICE_IDENTITY_SECRET`. Existing action capability gates remain unchanged; no fake Save/Test/Activate behavior was added.
- The BFF connector read already sends the upstream body through `relayUpstream` without a schema filter. No BFF implementation change was needed; its offline test now proves the new field survives the relay.

## Files changed

- `orchestrator/packages/contracts/src/connector-management.ts:49-55` — added the strict `knownConnectorIds` array field.
- `orchestrator/services/orchestrator/src/http/routes/admin.ts:567-585` — capabilities response now includes only the configured connector ID keys.
- `orchestrator/apps/admin-web/src/lib/api/types.ts:136-141` — added the frontend capability field.
- `orchestrator/apps/admin-web/src/features/connectors/state.ts:98,153-177` — validates the new strict shape and selects suggestions from the management list or ID-only capabilities according to `management`.
- `orchestrator/apps/admin-web/src/features/connectors/connectors-screen.tsx:146-147,283,341-345,475-494` — retains the existing list load only for composed management, shows the environment setup banner, keeps Revision lookup available, and binds its datalist to the selected suggestion source.
- `orchestrator/services/orchestrator/tests/p745-connector-management-proxy.test.ts:175-215` — backend offline assertions cover `management:false`, exact configured keys, and absence of URL/credential text.
- `orchestrator/services/orchestrator/tests/bff-connectors-actions.test.ts:156,359-371` — verifies BFF relay preserves `knownConnectorIds` verbatim.
- `tests/browser/admin-web/connectors-wire.spec.ts:100-113,117-172` — offline admin-web assertions cover degraded suggestions and updated capability fixtures.
- `tests/browser/admin-web/harness.ts:605-613` and `tests/browser/admin-web/navigation-completion.spec.ts:70` — updated capability fixtures for the expanded contract.

The BFF relay implementation is at `orchestrator/services/orchestrator/src/app/admin/bff/handle.ts:483-515`; it was inspected and left unchanged because it relays the body directly. The admin-web offline suite is Playwright based in this repository, so that runner was used for the UI reader/wiring test.

## Fail-first and verification

Red runs were made after adding both assertions and before changing implementation code:

1. From `orchestrator/services/orchestrator`:  
   `pnpm exec jest --runInBand --runTestsByPath tests/p745-connector-management-proxy.test.ts --testNamePattern="advertises only configured connector IDs"` — **exit 1**. The route returned the three booleans and omitted the expected two configured IDs.
2. From `tests/browser`:  
   `pnpm exec playwright test --config admin-web/playwright.config.ts --grep "management:false still feeds configured connector IDs"` — **exit 1**. The capability parser did not yet expose `knownConnectorIds`.

After implementation:

3. From `orchestrator/services/orchestrator`:  
   `pnpm exec jest --runInBand --runTestsByPath tests/p745-connector-management-proxy.test.ts tests/bff-connectors-actions.test.ts` — **exit 0**, 2 suites and 29 tests passed.
4. From `tests/browser`:  
   `pnpm exec playwright test --config admin-web/playwright.config.ts admin-web/connectors-wire.spec.ts` — **exit 0**, 17 tests passed.
5. From `du-rework`:  
   `pnpm --filter @du/contracts build` — **exit 0**.
6. From `orchestrator/apps/admin-web`:  
   `pnpm exec tsc --noEmit -p tsconfig.json` — **exit 0**.
7. From `orchestrator/services/orchestrator`:  
   `pnpm exec tsc --noEmit -p tsconfig.json` — **exit 1** at the pre-existing tenant BFF code `src/app/admin/bff/handle.ts:403` (`BffPrincipal` includes `unscoped`, but the local variable is passed where `ScopedPrincipal` is required). That file and route are outside this connector change. The workspace declares Node `>=24.21.0`; commands here ran on Node `v22.16.0` and emitted engine warnings.

## Scope notes

- No change to `TenantSelect`, `features/usage/usage-screen.tsx`, or `docs/21-openapi.json` was made for this task.
- TODO: `features/usage/usage-screen.tsx` will adopt `TenantSelect` after its owning agent completes that work.
- No commit or push was made.
