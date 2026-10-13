# Frontend navigation and operations receipt

Baseline: `d2f0c88ddc65de0f59794afbc390b875462ce501` (`du-rework/orchestrator/apps/admin-web`).

## Delivered source changes

- Reduced the left navigation to one prefix-active System operations entry. The route now provides Cockpit, Services, Workers & Queues, Incidents, Deployments, and Maintenance links while retaining all existing paths. The Incidents route link uses the existing `canReadIncidentLedger` permission check; direct incident routes retain the console's existing grant check.
- Grouped Security, Identity, API Keys, and Secrets under an Access & security sidebar parent, with contextual route links on all four existing pages. The API Keys link remains limited to platform admins. Grouped API Reference and Documentation as contextual route links while keeping Bootstrap as its own Resources entry.
- Indented sidebar links under their group labels and made the shell header, sidebar toggle, main spacing, and contextual links adapt across desktop, tablet, and mobile widths.
- Removed duplicate navigation from the System operations cockpit and workspaces. Kept service, replica, queue, incident, deployment, maintenance job, and operation detail URLs and query handling in their existing screens.
- Made Operations advanced filters collapsible and URL-aware; kept server-side filter, limit, and cursor behavior. Bounded the operations and incident tables with compact rows and sticky headers, retaining their server cursor controls. Added 25-row presentation pages to the worker inventory sample, with sample/cap disclosure; bounded maintenance preview and outcome tables.
- Added `tests/orv15-frontend-navigation-owner.test.mjs` with four focused source-contract checks for route availability, visibility gates, URL-backed cursor paging, and bounded tables.

## Validation

- `node --test tests/orv15-frontend-navigation-owner.test.mjs` — passed, 4/4.
- `git diff --check` — passed. Git emitted a line-ending warning for the shared UI worker's `src/components/ui/README.md`; that file is outside this lease.
- `pnpm exec tsc --noEmit -p tsconfig.json` — currently blocked by concurrent edits outside this lease. The raw log lists unused/incomplete imports in `src/features/businesses/businesses-screen.tsx` and `src/features/profiles/profiles-screen.tsx`, plus an unfinished `screenTab` state and call signature in the Profiles screen. No TypeScript errors were reported in the navigation/operations files in this run.
- Production build and browser rendering checks were left to the independent final verifier after the shared UI and configuration edits are frozen. This receipt does not claim visual or deployment verification.

Raw evidence: [focused test output](rawfrontend-nav-focused-test.txt) and [interim typecheck output](rawfrontend-nav-typecheck.txt).

## Frozen leased files and SHA-256

| File | SHA-256 |
|---|---|
| `orchestrator/apps/admin-web/src/app-shell/app-shell.tsx` | `716C92A97D7E230ABDAC8F724E172A1B7DB074E209DE42EFCFBC76A679760466` |
| `orchestrator/apps/admin-web/src/routes/system-operations.tsx` | `D1099AC0E10637FA12A56A3A7FEF7588DF908DBCFE604FF850D94BFA020F7F2B` |
| `orchestrator/apps/admin-web/src/features/system-operations/system-operations-screen.tsx` | `8B5A8DE2289E817A136A750978B2DEE173DE83D877EA795576A4912CC4D730B6` |
| `orchestrator/apps/admin-web/src/features/system-operations/operations-workspace.tsx` | `8C438647D12C9CED1CB7F4BD0D81CE11A3C38C57A046CBE646E891AC4904BCB8` |
| `orchestrator/apps/admin-web/src/features/system-operations/incidents-console.tsx` | `9205D4814C5124FBFEEFFEE0DB80891A5B86C1174EBE01335EC9EF4B0E2F5496` |
| `orchestrator/apps/admin-web/src/features/operations/operations-screen.tsx` | `92754B03BF6179B4EAC9F0F3180A0CFB075B1A8F0B080FD7189D4F3C6BDF68A7` |
| `orchestrator/apps/admin-web/tests/orv15-frontend-navigation-owner.test.mjs` | `6442D624449874798A8DA66C1D74BA31B7585522DAFAA977725E3B10EB13F86E` |
