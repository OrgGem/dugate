# Receipt AWEB-14 — Workflow business ownership and profile selection

- **Recorded:** 2026-10-10 14:58 UTC
- **Result:** Implemented; focused offline checks passed. This is owner evidence, not independent acceptance.
- **Scope:** `du-rework/orchestrator` workflow catalog, profile selector routes/UI, additive migration, and focused tests.
- **Workspace:** `D:\Git\dugate`; Node `v24.21.0`, pnpm `10.18.3`.
- **Commit/build digest:** None; changes remain in the working tree.

## Implementation

- Added migration `0040_workflow_business_profile_bindings.sql`: nullable `business_id` and `business_version` columns preserve existing NULL-owned workflows; added lookup index and `profile_workflow_bindings` for exact profile/workflow-revision choices.
- Workflow provisioning accepts the business/version pair, validates that the version is registered, carries ownership into later revisions when omitted, and prevents an already assigned workflow from changing owner. Existing unassigned workflows remain compatible.
- The workflow catalog supports tenant/business/version filtering. Profile workflow reads and writes are constrained to the profile's stored tenant/business/version. Enabling requires an active revision; selected retired revisions remain visible so they can be disabled. Writes use the audited admin route.
- Added profile workflow client methods and a selector to the loaded profile. Workflow provisioning UI can assign the new workflow revision to a registered business/version, or leave it unassigned.
- Updated traceability, test inventory, and acceptance evidence without changing gates or checkboxes.

## Verification

All checks ran offline; no PostgreSQL, Redis, external service, or production migration was used.

1. **Focused tests — PASS, exit 0, 11/11 tests**

   Command: `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --runTestsByPath tests/aweb-14-workflow-business-offline.test.ts tests/wfa-runtime-schema-catalog.test.ts`

   CWD: `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`

   Raw output: [jest.txt](evidence/aweb-14-2026-10-10/jest.txt)

2. **Orchestrator service TypeScript — PASS, exit 0**

   Command: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`

   CWD: `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`

   Raw output: [orchestrator-tsc.txt](evidence/aweb-14-2026-10-10/orchestrator-tsc.txt) (empty; no diagnostics)

3. **Admin Web TypeScript — PASS, exit 0 on serial rerun**

   Command: `pnpm exec tsc --noEmit`

   CWD: `D:\Git\dugate\du-rework\orchestrator\apps\admin-web`

   Raw output: [admin-web-tsc.txt](evidence/aweb-14-2026-10-10/admin-web-tsc.txt) (empty; no diagnostics)

   An earlier parallel invocation overlapped edits to `profiles-screen.tsx` and briefly returned TS1005/TS1381 at line 851. The serial rerun after the file settled passed with exit 0.

4. **Scoped `git diff --check` — PASS, exit 0.** Git printed CRLF-to-LF advisory warnings for the three documentation files; it reported no whitespace errors.

## Remaining evidence

The migration has not been applied to a live database, and no browser/UI run or independent review was performed. Those checks remain separate from this offline implementation evidence. No gate was ticked. No `git add`, commit, or push was performed.
