# Receipt BIZ-07 — Profile workflow read route

- **Recorded:** 2026-10-11
- **Result:** The requested GET route is present in the current source tree and passes focused offline ownership checks. Added dedicated BIZ-07 regression coverage; no duplicate route was introduced.
- **Endpoint:** `GET /api/v1/admin/profiles/:b/:v/:n/workflows`

## Verified behavior

- Resolves the profile owner using tenant, business, version, and profile name before loading workflow schemas.
- Reads workflow schema rows with the matching `profile_workflow_bindings` state, joining by the resolved profile ID plus workflow slug and revision.
- Applies tenant, business, and version predicates in SQL. Missing profiles return not found before any workflow schema lookup.
- Requires explicit tenant context for platform reads. Tenant operators can read their own tenant and receive 403 for a foreign tenant before database access.
- Returns a bounded projection of workflow slug, revision, status, enabled state, and creation time.

## Verification

- **PASS, 12/12 tests, exit 0** across the dedicated BIZ-07 read-route suite and the existing AWEB-14 workflow ownership suite.
- Command: `node node_modules/jest/bin/jest.js --runInBand --config jest.unit.config.cjs --runTestsByPath tests/biz-07-profile-workflows-read.test.ts tests/aweb-14-workflow-business-offline.test.ts`
- Working directory: `du-rework/orchestrator/services/orchestrator`
- Tests use a recording fake database; no database or external service was used.

## Scope note

- BIZ-04 describes the route as absent, but the current tree already contains the backend route, query module, and BFF forwarding from the earlier AWEB-14 workflow selection work. This task adds direct backend regression coverage for the read and ownership boundary.
- No product source was changed. No gate was ticked. No git add, commit, or push was run.
