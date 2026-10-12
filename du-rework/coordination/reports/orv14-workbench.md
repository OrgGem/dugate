# ORV14 Workbench owner receipt

## Outcome

Implemented the workflow import/editor and Admin Workbench source changes in the Journeys lease. The workflow preview supports the bounded JSON contract and a bounded recursive-descent parser for the supported legacy XML dialect, with strict rejection of unsupported XML, declarations/entities, invalid bindings, and oversized sources. Revision editing keeps the expected-revision CAS and local draft during conflicts. The endpoint workbench now uses schema-driven common controls with visible locked fields, explicit JSON fallback for object/array inputs, validation feedback, real admitted endpoint testing, and scoped assigned Profile/key discovery. The prompt proposal requires placeholder review and an explicit local-draft accept step; it is handed to the Profile editor with an expected revision and is not auto-saved or published.

## Frozen Journeys source path list

- `businesses/document-core/src/pipelines/workflows/schema/legacy-schema-runtime.ts`
- `docs/44-workflow-import-workbench.md`
- `orchestrator/apps/admin-web/src/features/docs/docs-screen.tsx`
- `orchestrator/apps/admin-web/src/features/profiles/profiles-screen.tsx`
- `orchestrator/apps/admin-web/src/features/profiles/state.ts`
- `orchestrator/apps/admin-web/src/features/workflows/revision-editor.ts`
- `orchestrator/apps/admin-web/src/features/workflows/workflows-screen.tsx`
- `orchestrator/apps/admin-web/tests/orv14-workbench-ui-owner.test.mjs`
- `orchestrator/packages/contracts/src/admin-workbench.ts`
- `orchestrator/packages/contracts/src/legacy-workflow.ts`
- `orchestrator/packages/contracts/src/profile-self-service.ts`
- `orchestrator/packages/contracts/src/workflow-import.ts`
- `orchestrator/services/orchestrator/src/app/admin/bff/admin-workbench.ts`
- `orchestrator/services/orchestrator/src/app/admin/bff/profiles.ts`
- `orchestrator/services/orchestrator/src/app/admin/bff/workflow-import.ts`
- `orchestrator/services/orchestrator/src/compat/legacy-workflow-decoders.ts`
- `orchestrator/services/orchestrator/src/http/routes/internal-admin-workbench.ts`
- `orchestrator/services/orchestrator/src/http/routes/internal-workflow-import.ts`
- `orchestrator/services/orchestrator/src/modules/admin-actions/dispatcher.ts`
- `orchestrator/services/orchestrator/src/modules/admin-workbench/service.ts`
- `orchestrator/services/orchestrator/src/modules/profiles/self-service.ts`
- `orchestrator/services/orchestrator/src/modules/workflow-import/preview.ts`
- `orchestrator/services/orchestrator/src/modules/workflow-test/workflow-test.ts`
- `orchestrator/services/orchestrator/tests/orv14-workbench-owner.test.ts`

Central contracts exports, API client, BFF dispatch, and server/bootstrap registration remain owned by the integration owner. Connector recipe compiler/contracts and invocation transport remain owned by the parity/usage/host owners. This receipt does not claim those shared integration files.

## Owner smoke

Commands and raw terminal results are stored under `coordination/reports/raw/orv14-workbench/`.
The source SHA-256 snapshot for the frozen Journeys paths is `coordination/reports/raw/orv14-workbench/source-sha256.txt`.

- Admin Web package TypeScript check: `./node_modules/.bin/tsc --noEmit -p tsconfig.json` — passed.
- Admin Web owner source check: `node --test tests/orv14-workbench-ui-owner.test.mjs` — 3 passed, 0 failed.
- Orchestrator focused owner suite: `./node_modules/.bin/jest --runInBand tests/orv14-workbench-owner.test.ts` — 9 passed, 0 failed.

No workspace build, generated bundle, or live provider action was run by this owner. The independent verifier is responsible for final-browser checks against the exact final bundle, including JSON/XML import, worker/HITL, six action forms, and the proposal handoff. Shared workspace changes from other owners were preserved.
