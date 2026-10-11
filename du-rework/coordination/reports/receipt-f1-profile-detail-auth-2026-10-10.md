# F1 receipt: tenant-scoped profile detail reads

Date: 2026-10-10

The BFF already selects and forwards the tenant operator's configured bearer. The 401 came from the downstream profile detail route using the platform-only `assertAdminAuth` guard. The existing platform detail lookup is global, so merely accepting tenant credentials there would have risked returning a profile with the same business/version/name from another tenant.

The route now resolves the bearer principal and derives its tenant scope. Platform reads keep the existing lookup; tenant reads use a dedicated tenant-scoped detail query with `tenant_id` predicates on both the active revision lookup and the orphan check. A missing or foreign-tenant named profile returns 404 instead of the platform blank-editor response. The adjacent profile API-key read uses the same scoped resolution so it cannot select another tenant's profile identity.

The read-only survey targets `app/admin/bff/profiles.ts` and `modules/admin-read/profile-detail.ts` were not modified by this packet. The tenant query lives in the new `modules/admin-read/tenant-profile-detail.ts` helper.

Offline verification:

- Orchestrator `npm run typecheck` — passed.
- `npm run test:unit -- --runTestsByPath tests/tapi01-closure-offline.test.ts tests/aweb04-bff-profiles.test.ts tests/admin-api-keys.test.ts` — 3 suites, 67 tests passed.
- Coverage confirms own-tenant detail reads succeed, SQL carries the credential-derived tenant predicate, foreign-tenant profile detail returns 404, and the BFF continues forwarding tenant credentials.

No files were staged; no commit or push was made; no gate was ticked.
