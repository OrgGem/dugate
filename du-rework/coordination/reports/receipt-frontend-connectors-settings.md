# Frontend connectors and settings receipt

The connectors/settings lease is frozen for review. Catalog selection now uses a synchronous busy ref shared with connector mutation owners: row clicks and the revision-inspector helper reject selection while a mutation or test is pending, and the connector-name button is disabled in that state. This prevents selecting another catalog revision while an earlier action's captured refresh is in progress. Existing UNKNOWN, immutable request, ledger, reconciliation, and retry-guard flows remain unchanged.

The legacy settings catalog now describes entries as “Retirement planned” and “Port mapping,” matching their metadata rather than implying that retirement or migration has completed.

The earlier workspace changes remain: kept tabs for dense connector and settings workspaces; locally paginated, bounded tables; row-level alignment; and bounded JSON, prompt, and cURL content. State and mutation owners remain mounted across tabs.

## Validation

- Focused test: node --test tests/orv15-connectors-settings-workspaces.test.mjs — 5 passed, 0 failed.
- Scoped TypeScript compiler check over the eight leased TSX entry points and their transitive imports — passed.
- git diff --check for the two repaired source files and focused test — passed.
- Final package build and browser verification are pending the coordinator's all-owner freeze. No live API simulation was run. The independent browser worker has been asked to verify pending-action catalog selection alongside the responsive viewports; do not treat that request as completed browser evidence.
- A prior package-wide typecheck, before the all-owner freeze, reported TS1381 in concurrently owned src/features/profiles/profiles-screen.tsx:523:19. The coordinator owns the final package-wide check.

## Frozen files and SHA-256

- orchestrator/apps/admin-web/src/features/connectors/connectors-screen.tsx — 2DBEC139155632FD597519F9245111A7755D9648E0F4422BB18BFCFC4666C85E
- orchestrator/apps/admin-web/src/features/connectors/parity-connector-editor.tsx — AD8B9F200F156FAC950E198736E9B2EC8E1E212EB4B9C33E1ACCB6FA3A1A04D5
- orchestrator/apps/admin-web/src/features/connectors/curl-import-preview.tsx — 577133F9D070F402885A2B7B3AB0A2B69289C25FDE8183425D210B2657D58CC9
- orchestrator/apps/admin-web/src/features/settings/settings-screen.tsx — C852399DA4EB3EF72ACE71B8137B975AAD7424B124D37E4755FD5450BD85C5C2
- orchestrator/apps/admin-web/src/features/settings/global-tenant-settings.tsx — 804E7B5902708413BBBC80AAE826FF778BDEA3BBD632085E7B55128AB558ECB6
- orchestrator/apps/admin-web/src/features/settings/storage-generation-panel.tsx — F6DA7366FB46590D3AB6F955D07C1ABBA364703F08D2FBA24D1BF08FD5368D91
- orchestrator/apps/admin-web/src/features/settings/configuration-revisions.tsx — D59089DC0E9C62671D81051D0F84871C6098AC50990C23C4BC12A2EB39E8F401
- orchestrator/apps/admin-web/src/features/settings/migration-readiness.tsx — 84516866B6DF20B34B42E70DFE37619620A92660586446F164C8A5FA5507F55D
- orchestrator/apps/admin-web/tests/orv15-connectors-settings-workspaces.test.mjs — BE5857EBEDFAF70454F7BEDCC40C64CD49CAA57C8CC42BFE5F28953EAFAFEA9F
