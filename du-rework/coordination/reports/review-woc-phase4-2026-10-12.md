# Final profile review checkpoint

Read-only reviewer: `/root/requirements_alignment`, gpt-6.1-sol high. Core, template and corrected connector-navigation source approvals remain unchanged.

The prior publish/rollback target-selector and append retained-membership findings are closed at frozen hashes `D81F7FFEE026DD9886ACD787FF4C184F2247D215BE1CF717A3D30B8204188D79` (profiles.ts), `D1D2250D1DB17FC1BCA536EC9A4CC7C1FA3050E578CC2EBA29D540CCC9DDD0C4` (profile-actions.ts), and `6EF4A6D47FB8E548492B4C8EAA1F65B9238F516EFC38B1B07F78497B7756FF0C` (focused test). Independent PostgreSQL evidence passes seven selected profile cases; this does not cover the new interleaving below.

## P1: key rotation expands membership without selector lock coverage

`admin-actions/dispatcher.ts` snapshots key membership selectors before locking the old key, then re-reads and copies memberships without ensuring the expanded set is covered by its already-held selector locks.

Concrete interleaving: rotation snapshots K1/S0; a group G2 on S1/K1 commits while rotation waits for K1; rotation reads S1 while holding only S0; G2 switches K1 to K2 under S1/K2 and revokes K1 membership; rotation inserts replacement membership from its stale copy. Both K2 and replacement then qualify for G2, causing current-key read/rollback to reject with multiple-key 409.

Required repair: after locking the old key, revalidate membership selector coverage and reject/retry a changed set before any rotation write. Copy only a set protected by the acquired selector scopes. Preserve ordinary group key switching and legacy multi-key memberships; no credential design or grant-transfer changes. Add a real PostgreSQL barrier regression proving no resurrected membership and readable successful group save.

Status at checkpoint: CHANGES NEEDED. Repair owner `/root/profile_groups_backend` (Luna max); independent PostgreSQL verifier `/root/verify_worker_orchestrator` (Luna max). Reviewer executed no tests. Deployment, process/network faults and actual Connector-to-provider E2E remain unverified.

## Final source re-review

APPROVED (bounded source review): dispatcher `CEC786D147913B598A347F8159FCEBC352DF9FE13C0C525CB6B84749FE687327` and focused test `A8AD929C1FA035B32D9B6209E51E4DF0E0DFB073E54F8782F31E4206A186329C` match the frozen repair. After old-key locking, rotation re-reads and compares the complete sorted signature (profile, tenant, business, version, action, endpoint). Drift returns `409 STATE_CONFLICT` before any credential/membership write; copy uses the validated set. The test checks ordering, unchanged keys/memberships and no rotation/audit side effects. Ordinary group key replacement, legacy multi-key memberships and current authorization/credential formats remain supported.

Owner reports 22/22 focused tests, typecheck/build and diff check passing. Reviewer executed no tests. Independent real-PG barrier/key-switch/retry case is pending at this source-approval checkpoint. Prior core/template/UI approvals remain unchanged.

## Publish preparation

Independent verifier final bounded run: one suite, 8/8 PASS. Real PostgreSQL shows rotation blocked on G2's backend, initial S0 snapshot and post-lock S0+S1 snapshot, then 409 before replacement insertion. G2 switches to existing K2; retry rotates K1 and inherits only G1/S0. G2 GET/rollback remain on K2 with no replacement membership. Raw: `raw/vfy-woc-20261012-1505/profile-pg-rotation-membership-race-final-rerun-20261012.log`. This closes the new race in the tested interleaving; it is not deployment/network/provider proof.

User authorized committing and pushing all task updates. `/root/git_publish` (Luna max) is preparing the manifest and secret/generated-file checks, with commit/push held until final source freeze. Fetch found remote branch one commit ahead at `c3c66b7548924dd1c9b0e6c7c6e4aa64f5c5f840`; normal integration and affected validation are required before push. No force push, reset or production operations are authorized.
