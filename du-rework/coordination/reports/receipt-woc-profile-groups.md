# WOC-10 Profile Groups Backend Receipt

Date: 2026-10-12 (Asia/Bangkok)

Status: additive Profile Group backend source, phase-3 overlap repairs, and rotation membership-lock coverage repair are complete and frozen for independent review. This receipt is implementation evidence, not a migration/deployment acceptance.

## Behavior delivered

- Added migration `orchestrator/services/orchestrator/migrations/0067_profile_groups.sql` for group roots, immutable full-set revisions/member snapshots, and `profile_names.group_id` child ownership. Existing child profile IDs/revisions, API-key membership records, and public resolver coordinates remain the execution bridge; there is no aggregate API key or new credential format.
- Added `/api/v1/admin/profile-groups` list/create, `/:groupId` read/full-replacement, `/:groupId/rollback`, and `/api/v1/admin/businesses/:businessId/versions/:version/functions`; same-origin BFF paths are `/admin/api/profile-groups...` and `/admin/api/businesses/:businessId/versions/:version/functions`.
- Group save validates tenant and an existing ACTIVE tenant API key, registered exact business version, logical business enabled state, manifest digest and declared executable action, required connector slots and tenant-visible active connector revisions, and overlapping active key/function selectors. It appends child revisions and memberships, disables and revokes removed children, writes the complete immutable group snapshot, and advances `active_revision` inside the caller's existing audited transaction with expected-revision CAS.
- Save/rollback take coarse deterministic selector advisory locks before API-key and child locks, then hold a `FOR SHARE` lock on the selected `business_catalog` row through profile materialization and commit. Legacy writers and key rotation use the same selector-before-key lock order. Overlap is checked using public resolver identity: a generic action conflicts with its specific endpoints, while distinct declared Core endpoints sharing the same action remain independently selectable.
- Legacy revision append snapshots the active selector and all ACTIVE API-key memberships, locks current/requested selector scopes in sorted order, locks the unique membership plus authorizing API-key rows by ID, re-reads pointer and memberships after those locks, then checks the resulting selector against every membership before inserting/pinning. This preserves public resolver semantics when a child is shared across keys.
- API-key rotation snapshots active membership selectors, locks those selector scopes, then takes the old key's `FOR UPDATE` lock and re-reads the full `(profileId, tenantId, selector)` set. If membership or selector coverage changed while waiting, it returns retryable `409 STATE_CONFLICT` before hashing/inserting the replacement, copying memberships, revoking memberships, or revoking the old key. On an exact match, rotation copies only that validated, fully locked selector snapshot.
- Legacy publish and rollback resolve the exact target selector (latest immutable revision for publish, requested historical revision for rollback), lock current and target scopes together, lock membership/authorizing keys in stable order, revalidate the pointer, target, and membership snapshots, and reject target overlaps for every ACTIVE membership before moving the pointer. Internal group child append relies on the aggregate's already-held selector set and selected key row to avoid acquiring additional keys out of order; it still rechecks memberships and validates overlap for every active member.
- Rollback validates the target immutable snapshot and child pins, restores the complete target set, disables removed children, and advances a new group revision in one transaction. Omitted file-URL authentication fields are carried forward by the existing profile revision writer; no secret is returned or changed through this API.
- The selected-version catalog derives Document Core endpoint selectors and schemas from that exact manifest; other businesses expose declared manifest actions as workflow functions. Unsupported or absent Core selector descriptors fail explicitly. Arbitrary dynamic workflow slugs are not exposed as registered functions or claimed as admission policy.
- Legacy profile list/detail and local assigned-profile reads hide group-owned children. Legacy child upsert, publish, rollback, self-service edit, and direct API-key attach are rejected as group-owned mutations. Public profile resolution and child-ID key rotation/membership semantics are preserved.
- Local-user guard paths are explicit: self-service child edits reject a non-null `group_id`; assigned-profile and assigned-key queries require `group_id IS NULL`; group BFF listing filters each group through all child assignments plus the selected key grant/memberships; detail returns 404 when that check fails. Platform Admin can create, replace, and roll back groups. Tenant-scoped reads remain tenant-fenced. A local OIDC operator can read only when every child profile already has an assignment and the selected ACTIVE API key is already granted and has active membership for every child. Local group mutations return `PROFILE_GROUP_ASSIGNMENT_REQUIRED`. Function catalog reads are platform-admin-only.
- GET and rollback derive the effective key on the server from the group's child memberships and caller's existing tenant/assignment permissions; neither request accepts `apiKeyId`. Read DTOs return the effective active key reference as `apiKey`. After key rotation the resolver continues to use existing child memberships; group history and child snapshot IDs are not rewritten. If no unique active key is derivable, operations fail closed. Rotation does not grant new local mutation rights: authorized admins may edit/rollback with the replacement key, while local OIDC users remain read-only.
- Direct `/api/v1/admin/profile-bindings` revision creation now rejects group-owned child IDs transactionally, closing the administrative dispatcher bypass. Internal group writes use a service-only ownership capability and verify the child still belongs to that exact group.

## Changed paths in this scope

- `orchestrator/packages/contracts/src/profile-groups.ts` and `src/index.ts` (the contracts barrel was coordinated with the WOC backend owner).
- `orchestrator/services/orchestrator/migrations/0067_profile_groups.sql`.
- `orchestrator/services/orchestrator/src/modules/admin-read/business-functions.ts`, `profile-list.ts`, `profile-detail.ts`, `tenant-profile-detail.ts`.
- `orchestrator/services/orchestrator/src/modules/profiles/profile-groups.ts`, `profiles.ts`, `self-service.ts`.
- `orchestrator/services/orchestrator/src/modules/admin-actions/profile-actions.ts`, `dispatcher.ts`.
- `orchestrator/services/orchestrator/src/http/routes/admin-profile-groups.ts`, shared `http/routes/admin.ts` dispatch.
- `orchestrator/services/orchestrator/src/app/admin/bff/profile-groups.ts`, shared `app/admin/bff/handle.ts` dispatch.
- `orchestrator/services/orchestrator/tests/woc-profile-groups-backend.test.ts`.
- `orchestrator/services/orchestrator/tests/orv12-settings.test.ts` (fixture-only adjustment for the intentional selector-overlap rule and test-database safety guard; no product source change).

Shared route dispatch files contain co-located sibling work and are not represented as exclusively changed by this worker. No profile UI files are part of this backend scope.

## Verification

From `D:\Git\dugate\du-rework\orchestrator\services\orchestrator`:

```text
pnpm test -- --runInBand tests/woc-profile-groups-backend.test.ts
exit 0
Test Suites: 1 passed, 1 total
Tests: 22 passed, 22 total
raw: coordination/reports/raw/woc-profile-rotation-snapshot-focused-2026-10-12.txt

pnpm typecheck
exit 0
raw: coordination/reports/raw/woc-profile-rotation-snapshot-typecheck-2026-10-12.txt

pnpm build
exit 0
raw: coordination/reports/raw/woc-profile-rotation-snapshot-build-2026-10-12.txt

pnpm test -- --runInBand tests/orv12-settings.test.ts
exit 0
Test Suites: 1 passed, 1 total
Tests: 12 passed, 12 total
raw: coordination/reports/raw/woc-profile-groups-orv12-settings-fixture-retest-2026-10-12.txt
```

The focused tests cover exact-version function catalogs; save validation; a two-business save and reload; removed-child disable and membership revocation; full-set rollback; transaction-harness rollback after an injected failure on the second child; child legacy/direct-mutation conflicts; local assignment/key visibility fences; a Core multi-endpoint save/resolver check; lock ordering; rotation selector-snapshot expansion after key lock (ordered snapshot → selector lock → key update lock → reread, with no replacement/member/audit writes on mismatch); stable rotation followed by group read/admin edit/rollback and public resolver checks; local mutation denial; cross-key revision overlap checks; membership snapshot drift rejection; and historical rollback/latest publish target checks before pointer mutation. These focused cases use stateful mocks and are not PostgreSQL concurrency proof.

The first `orv12-settings.test.ts` run exposed an invalid setup in its native profile-upsert case: the common `beforeEach` fixture had already inserted an ACTIVE `document-core@test/extract:invoice` profile under `scope.apiKeyId`, and the case then tried to create another profile with that same key and selector. The test now creates a separate test-only API key in the same tenant and uses it for that upsert; it keeps its endpoint pin, connector pin, policy-save, and selector-retarget conflict assertions unchanged. This adapts the test fixture to the intentional no-overlap contract; the initial failing run is retained at `coordination/reports/raw/woc-profile-groups-phase3-legacy-pg-focused-2026-10-12.txt` as historical diagnostic evidence, not as a baseline claim. The focused group-save overlap test continues to assert rejection of an existing same-key selector, while the focused cross-key revision test covers retained ACTIVE memberships. The integration test uses the dedicated `du_workflow_api_test` database and verifies `current_database()` before creating anything; each run creates a fresh `set_owner_<UUID>` schema and drops only that schema during teardown.

Independent real-PostgreSQL targeted evidence at the prior phase-3 dispatcher snapshot (`C89AF45A592846E61162D756B6323BD68C798AA7FA0EFA9A9B735122010777B5`) passed 7 selected cases: concurrent selector-overlap winner/loser, actual disable commit ordering behind the catalog `FOR SHARE` lock, direct child-mutation rejection, rollback-target protection, publish-target protection, cross-key append protection, and stable key-rotation behavior. Raw output: `coordination/reports/raw/vfy-woc-20261012-1505/profile-pg-phase3-final-targeted-20261012.log`. The 20-second lock diagnostic with separate backend PIDs and transaction/lock details is `coordination/reports/raw/vfy-woc-20261012-1505/profile-pg-lock-diagnostics-20261012-1750.log`. The added concurrent rotation/membership-snapshot regression is now frozen for independent real-PostgreSQL verification; the 7-case result predates this repair and is not evidence for that new race. Mocked tests remain mock evidence only.

## Limits and handoff

Most group lifecycle tests use a mocked SQL client and an in-memory transaction harness. They do not establish actual rollback on every production database driver. The `orv12-settings.test.ts` integration setup runs the repository migrations, including 0067, within its isolated test schema; no production migration was run. No live API, Redis/BullMQ, provider, deployment, container-provenance, or production verification was performed. Independent targeted real-PostgreSQL checks are listed above; the new rotation membership-snapshot race awaits verifier execution against this frozen source hash. No broad unrelated test suite was run.

No production database, provider, or external service was mutated. No credentials were provisioned or changed. Source is frozen for handoff; no commit, push, deployment, or release was performed.

## Shared-tree snapshot SHA-256

These hashes identify the current uncommitted shared-tree snapshots; shared files may include sibling-owned edits.

```text
orchestrator/packages/contracts/src/profile-groups.ts D3BB59DC6FF6D9A740D3E54A5237FADC799BD3DE39A5CD3E0EC81969E2535114
orchestrator/packages/contracts/src/index.ts 1DB649377F879B9D0F3C9C2BD4D5B2069719299A9A0A147BB2669C719B500CDA
orchestrator/services/orchestrator/migrations/0067_profile_groups.sql 5CF3DE92D83D11CD379DEEBD0D7882A99CC792FB372F648230CCEB4B72CAAAE2
orchestrator/services/orchestrator/src/modules/admin-read/business-functions.ts F5A0D43E2C638FD219EBD7DAC1E99B418833A712CBF807B0785838C79A85C398
orchestrator/services/orchestrator/src/modules/admin-read/profile-list.ts C6A7B8F28CBFB0F17974D996180AB4588715265C486D72AB2869C98B06328890
orchestrator/services/orchestrator/src/modules/admin-read/profile-detail.ts F96325FBB4571599103C1AD3ECE116FAB18E7C37FA2853E3667F6BF09F57E162
orchestrator/services/orchestrator/src/modules/admin-read/tenant-profile-detail.ts 29E6D6BE3500379E003DD304AF2DDCFFF5658768A993A0205757F116FC212318
orchestrator/services/orchestrator/src/modules/profiles/profile-groups.ts A0C1E2462567AB7D13D01A968B722955F19F07BE5F0A51F752EBE185BDA810A5
orchestrator/services/orchestrator/src/modules/profiles/profiles.ts D81F7FFEE026DD9886ACD787FF4C184F2247D215BE1CF717A3D30B8204188D79
orchestrator/services/orchestrator/src/modules/profiles/self-service.ts 7A5A896015CCF5E6C517EA6979A8DDD721A2D1A6606C0F7DDAFA04938AEDD52C
orchestrator/services/orchestrator/src/modules/admin-actions/profile-actions.ts D1D2250D1DB17FC1BCA536EC9A4CC7C1FA3050E578CC2EBA29D540CCC9DDD0C4
orchestrator/services/orchestrator/src/modules/admin-actions/dispatcher.ts CEC786D147913B598A347F8159FCEBC352DF9FE13C0C525CB6B84749FE687327
orchestrator/services/orchestrator/src/http/routes/admin-profile-groups.ts D5D646EDA351D386B94C8623AE57AFEFDB3B597434103344CBD81CD48E516852
orchestrator/services/orchestrator/src/http/routes/admin.ts 01913FE6BB96AB652F246C5B0FA9892539C28AC64519F663BC8594C1F44A6953
orchestrator/services/orchestrator/src/app/admin/bff/profile-groups.ts D9BAE7072BFD848E3768A1DAFE9DCC6D6FC6BD445D5065033401A45C7F53917B
orchestrator/services/orchestrator/src/app/admin/bff/handle.ts 1CD920C7FAB183212ECF4B79C1CD783F3C5BA985BCC283FE4DE367E0BB1A3AD7
orchestrator/services/orchestrator/tests/woc-profile-groups-backend.test.ts A8AD929C1FA035B32D9B6209E51E4DF0E0DFB073E54F8782F31E4206A186329C
orchestrator/services/orchestrator/tests/orv12-settings.test.ts 56DD4BD0FB8E2C2C785A3B5195567918D46D50361538A84C25B4B4D9810977FC
```
